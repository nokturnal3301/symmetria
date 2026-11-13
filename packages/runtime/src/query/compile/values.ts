/**
 * Renders value expressions, operands, orderings and projections to SQL with the right codecs and casts.
 */
import { bigintCodec, numericCodec, cloneParameter } from "../codecs";
import { expressionSqlType } from "../plan/metadata";
import { sameExpression } from "../plan/equivalence";
import type {
  ExpressionDescription,
  ValueNode,
  WindowBoundary,
} from "../expressions";
import { containsBinding, type OrderingDescription } from "../plan/types";
import {
  aliasSql,
  parameter,
  quoteIdentifier,
  renderContext,
  type Bindings,
  type Compilation,
} from "./state";

/** bigint and numeric values travel as text inside JSON to keep their precision. */
export const jsonPrecisionSql = (
  compilation: Compilation,
  expression: ExpressionDescription,
  value: string,
): string => {
  const sqlType = expressionSqlType(expression);
  const array =
    sqlType.endsWith("[]") || expression.codec?.parameterCast?.endsWith("[]");
  const codec = array ? expression.codec?.element : expression.codec;
  const scalarType = array ? sqlType.slice(0, -2) : sqlType;

  if (
    codec !== bigintCodec &&
    codec !== numericCodec &&
    scalarType !== "bigint" &&
    !scalarType.startsWith("numeric")
  ) {
    // Polymorphic JSON constructors cannot infer a bare placeholder's type.
    if (
      (expression.node.kind === "placeholder" ||
        expression.node.kind === "parameter") &&
      sqlType !== "derived"
    ) {
      return compilation.renderer.cast(value, {
        kind: "typed",
        type: sqlType === "enum" ? "text" : sqlType,
      });
    }

    return value;
  }

  // Preserve the array shape and NULL elements while stringifying each number.
  return compilation.renderer.cast(value, { kind: "text", array: !!array });
};

export const valueSql = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
  jsonOutput = false,
): string => {
  const aggregate =
    node.kind === "subquery"
      ? compilation.aggregateReferences?.get(bindings)?.get(node)
      : undefined;

  if (aggregate) {
    return aggregate;
  }

  const cache =
    node.kind !== "column" &&
    node.kind !== "parameter" &&
    node.kind !== "placeholder"
      ? compilation.expressionCaches?.get(bindings)
      : undefined;
  const existing = cache?.find(
    (entry) =>
      entry.jsonOutput === jsonOutput && sameExpression(entry.node, node),
  );

  if (existing) {
    return existing.sql;
  }

  const sql = renderValue(compilation, node, bindings, jsonOutput);
  cache?.push({ node, sql, jsonOutput });

  return sql;
};

/** Raw SQL is opaque: parenthesize it wherever an operator could bind into it. */
export const operandSql = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
): string => {
  const sql = valueSql(compilation, node, bindings);

  return node.kind === "raw" ? `(${sql})` : sql;
};

/** One ORDER BY key with its direction and optional NULLS position. */
export const orderingSql = (
  compilation: Compilation,
  ordering: OrderingDescription,
  bindings: Bindings,
): string => {
  const node = ordering.expression.node;
  const sql = valueSql(compilation, node, bindings);
  const nulls = ordering.nulls;

  return `${sql} ${ordering.direction}${nulls ? ` NULLS ${nulls}` : ""}`;
};

/** The document side of a full-text match; multi-part documents are parenthesized before `@@`. */
export const searchVector = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
  language: string,
): string => {
  const rendered = compilation.renderer.searchVector(
    valueSql(compilation, node, bindings),
    language,
    expressionSqlType({ node, outputName: "value" }) === "tsvector",
  );

  return node.kind === "tsvector" && node.parts.length > 1
    ? `(${rendered})`
    : rendered;
};

/**
 * An aggregate call, rendered with its argument now and completed with a
 * window's OVER clause, if any, right after the call. MIN and MAX of a type
 * without them take the first element of the aggregated one-element arrays,
 * which order by the type's comparison, skipping NULL and JSON null.
 */
const aggregateSql = (
  compilation: Compilation,
  node: Extract<ValueNode, { kind: "aggregate" }>,
  bindings: Bindings,
): ((over?: string) => string) => {
  const value = node.value ? valueSql(compilation, node.value, bindings) : "*";

  return (over = "") => {
    if (node.element) {
      const present =
        node.element === "json"
          ? `${value} <> 'null'::jsonb`
          : `${value} IS NOT NULL`;

      return `(${node.name}(ARRAY[${value}]) FILTER (WHERE ${present})${over})[1]`;
    }

    const aggregate = `${node.name}(${value})${over}`;

    return node.numeric
      ? compilation.renderer.cast(aggregate, { kind: "numeric" })
      : aggregate;
  };
};

const renderValue = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
  jsonOutput: boolean,
): string => {
  const { renderer } = compilation;

  switch (node.kind) {
    case "placeholder": {
      if (!compilation.placeholder) {
        throw new Error(
          `symmetria: bind parameter "${node.name}" with prepare()`,
        );
      }

      const bound = parameter(compilation, compilation.placeholder(node));

      return node.codec?.parameterCast
        ? renderer.cast(bound, {
            kind: "parameter",
            type: node.codec.parameterCast,
          })
        : bound;
    }
    case "column": {
      const { binding, column } = node.description;

      if (!containsBinding(bindings, binding)) {
        throw new Error(
          `symmetria: column "${binding.alias}.${column.name}" belongs to another query scope; use a distinct alias for correlated queries`,
        );
      }

      return `${aliasSql(compilation, binding)}.${quoteIdentifier(column.sqlName)}`;
    }
    case "jsonPath":
      return renderer.jsonPath(
        valueSql(compilation, node.value, bindings),
        node.path,
        { scalarType: node.scalarType },
        renderContext(compilation, bindings),
      );
    case "arrayIndex":
      return renderer.arrayIndex(
        valueSql(compilation, node.value, bindings),
        node.position,
        renderContext(compilation, bindings),
      );
    case "jsonObject":
      return renderer.jsonObject(
        node.selection.map((expression) => ({
          key: expression.outputName,
          value: jsonPrecisionSql(
            compilation,
            expression,
            valueSql(compilation, expression.node, bindings, jsonOutput),
          ),
        })),
        jsonOutput,
      );
    case "parameter": {
      const bound = parameter(compilation, cloneParameter(node.value));

      return node.cast
        ? renderer.cast(bound, { kind: "parameter", type: node.cast })
        : bound;
    }
    case "raw":
      return node.parts
        .map((part) =>
          typeof part === "string"
            ? part
            : operandSql(compilation, part, bindings),
        )
        .join("");
    case "binary":
      return `(${operandSql(compilation, node.left, bindings)} ${node.operator} ${operandSql(compilation, node.right, bindings)})`;
    case "aggregate":
      return aggregateSql(compilation, node, bindings)();
    case "case":
      return `(CASE ${valueSql(compilation, node.value, bindings)} ${node.branches.map((branch) => `WHEN ${valueSql(compilation, branch.when, bindings)} THEN ${valueSql(compilation, branch.then, bindings)}`).join(" ")} END)`;
    case "coalesce":
      return `COALESCE(${node.values.map((value) => valueSql(compilation, value, bindings)).join(", ")})`;
    case "tuple":
      return `(${node.values.map((value) => valueSql(compilation, value, bindings)).join(", ")})`;
    case "relativeWindow":
      return `${node.name.toUpperCase()}(${[node.value, node.offset, ...(node.fallback ? [node.fallback] : [])].map((value) => valueSql(compilation, value, bindings)).join(", ")})`;
    case "window": {
      // The expression renders first, so its parameters precede the frame's.
      const aggregate =
        node.expression.kind === "aggregate"
          ? aggregateSql(compilation, node.expression, bindings)
          : undefined;
      const expressionSQL = aggregate
        ? ""
        : valueSql(compilation, node.expression, bindings);
      const fragments: string[] = [];

      if (node.partitionBy.length) {
        fragments.push(
          `PARTITION BY ${node.partitionBy.map((value) => valueSql(compilation, value, bindings)).join(", ")}`,
        );
      }

      if (node.orderBy.length) {
        fragments.push(
          `ORDER BY ${node.orderBy.map((ordering) => orderingSql(compilation, ordering, bindings)).join(", ")}`,
        );
      }

      if (node.rows) {
        const boundary = (value: WindowBoundary) =>
          typeof value === "string"
            ? value.toUpperCase()
            : "preceding" in value
              ? `${parameter(compilation, value.preceding)} PRECEDING`
              : `${parameter(compilation, value.following)} FOLLOWING`;

        fragments.push(
          `ROWS BETWEEN ${boundary(node.rows[0])} AND ${boundary(node.rows[1])}`,
        );
      }

      const suffix = ` OVER (${fragments.join(" ")})`;

      // OVER follows the aggregate call, inside its numeric cast or element access.
      return aggregate ? aggregate(suffix) : `${expressionSQL}${suffix}`;
    }
    case "subquery":
      return `(${compilation.selectSql(node.query, bindings)})`;
    case "searchRank":
      return renderer.searchRank(
        searchVector(compilation, node.value, bindings, node.language),
        renderer.searchQuery(
          valueSql(compilation, node.query, bindings),
          node.language,
          node.mode,
        ),
        {
          ...(node.weights ? { weights: node.weights } : {}),
          ...(node.normalization === undefined
            ? {}
            : { normalization: node.normalization }),
          coverDensity: !!node.coverDensity,
        },
      );
    case "searchHeadline":
      return renderer.searchHeadline(
        node.language,
        valueSql(compilation, node.value, bindings),
        renderer.searchQuery(
          valueSql(compilation, node.query, bindings),
          node.language,
          node.mode,
        ),
        node.options,
      );
    case "tsvector":
      return renderer.searchDocument(
        node.parts.map((part) => ({
          value: valueSql(compilation, part.value, bindings),
          ...(part.weight ? { weight: part.weight } : {}),
          isVector:
            expressionSqlType({ node: part.value, outputName: "value" }) ===
            "tsvector",
        })),
        node.language,
      );
    case "arrayLength":
      return renderer.arrayLength(
        valueSql(compilation, node.value, bindings),
        !!node.json,
      );
    case "rowCount":
      return `(SELECT COUNT(*) FROM (${compilation.selectSql(node.query, bindings)}) AS "__symmetria_count")`;
    case "jsonRows":
      return renderer.jsonRows(
        compilation.selectSql(node.query, bindings, true, jsonOutput),
        node.many,
        jsonOutput,
      );
  }
};

export const projectionSql = (
  compilation: Compilation,
  selection: readonly ExpressionDescription[],
  bindings: Bindings,
  jsonValues = false,
  jsonOutput = false,
): string =>
  selection
    .map((expression) => {
      const value = valueSql(
        compilation,
        expression.node,
        bindings,
        jsonOutput,
      );
      const node = expression.node;
      const projected = jsonValues
        ? jsonPrecisionSql(compilation, expression, value)
        : node.kind === "placeholder" &&
            !node.codec?.parameterCast &&
            node.sqlType !== "derived"
          ? compilation.renderer.cast(value, {
              kind: "typed",
              type: node.sqlType === "enum" ? "text" : node.sqlType,
            })
          : value;

      return `${projected} AS ${quoteIdentifier(expression.outputName)}`;
    })
    .join(", ");
