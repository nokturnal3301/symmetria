/**
 * Renders value expressions, operands, orderings and projections to SQL with the right codecs and casts.
 */
import { bigintCodec, numericCodec, cloneParameter } from "../codecs";
import { expressionSqlType, valueSqlType } from "../plan/metadata";
import { sameExpression } from "../plan/equivalence";
import { containsNode } from "../plan/traverse";
import { closedRawSql } from "../expressions/raw-text";
import type {
  ExpressionDescription,
  SearchMode,
  ValueNode,
  WindowBoundary,
} from "../expressions";
import type { JsonRowsShape } from "./postgres/types";
import { containsBinding, type OrderingDescription } from "../plan/types";
import {
  aliasSql,
  keyAlias,
  parameter,
  quoteIdentifier,
  renderContext,
  type Bindings,
  type Compilation,
} from "./state";
import {
  searchHeadlineSql,
  headlineOptionsText,
  isJsonType,
  searchRankSql,
  searchTextSql,
  searchValueType,
  searchVectorSql,
  tsquerySql,
  tsvectorSql,
} from "./postgres/search";
import { predicateSql } from "./predicates";

/**
 * bigint and numeric values travel as text inside JSON to keep their precision,
 * by any of their names (`int8`, `DECIMAL(30,10)`) and as a customType's base.
 */
export const jsonPrecisionSql = (
  compilation: Compilation,
  expression: ExpressionDescription,
  value: string,
): string => {
  const sqlType = expressionSqlType(expression);
  // A page cursor's fingerprint keeps the casts chosen by the declared
  // spelling, the form earlier versions sent, so their cursors stay valid.
  const type = compilation.shapeOnly ? sqlType : valueSqlType(expression);
  const array =
    type.endsWith("[]") || expression.codec?.parameterCast?.endsWith("[]");
  const codec = array ? expression.codec?.element : expression.codec;
  const scalarType = compilation.shapeOnly
    ? array
      ? sqlType.slice(0, -2)
      : sqlType
    : type.endsWith("[]")
      ? type.slice(0, -2)
      : type;

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

const BARE_PARAMETER = /^\(*\$\d+\)*$/;

const buildsJson = (node: ValueNode): boolean =>
  node.kind === "jsonObject" || node.kind === "jsonRows";

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
  // Only JSON builders render differently as the statement's own output.
  const existing = cache?.find(
    (entry) =>
      sameExpression(entry.node, node) &&
      (entry.jsonOutput === jsonOutput ||
        (!compilation.shapeOnly && !containsNode(node, buildsJson))),
  );

  if (existing) {
    return existing.sql;
  }

  const sql = renderValue(compilation, node, bindings, jsonOutput);

  // A bare `$1` takes its type from where it stands, so two clauses that
  // shared one could give it two types; each keeps a parameter of its own.
  if (cache && !BARE_PARAMETER.test(sql)) {
    cache.push({ node, sql, jsonOutput });
  }

  return sql;
};

/** Raw SQL is opaque: parenthesize it wherever an operator could bind into it. */
export const operandSql = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
): string => {
  const sql = valueSql(compilation, node, bindings);

  return node.kind === "raw" && !node.delimited ? `(${sql})` : sql;
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

/** A value as the text a full-text function reads; schema DDL reads it the same way. */
const searchTextOf = (node: ValueNode, sql: string): string =>
  searchTextSql(searchValueType(node), sql);

const isJsonValue = (node: ValueNode): boolean =>
  isJsonType(searchValueType(node));

/** The document side of a full-text match; multi-part documents are parenthesized before `@@`. */
export const searchVector = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
  language: string,
): string => {
  const rendered = searchVectorSql(
    searchTextOf(node, valueSql(compilation, node, bindings)),
    language,
    expressionSqlType({ node, outputName: "value" }) === "tsvector",
  );

  return node.kind === "tsvector" && node.parts.length > 1
    ? `(${rendered})`
    : rendered;
};

/**
 * The question of a rank or a headline, which PostgreSQL computes for every
 * row: a bound question is parsed once per statement, `(SELECT to_tsquery(…))`.
 * Under a generic plan, which a prepared statement may switch to from its
 * sixth run, `to_tsquery(cfg, $1)` is no constant and would be parsed again
 * for every row. A match (`@@`) keeps the call, so that a custom plan sees the
 * question when it estimates the rows. A page cursor's fingerprint keeps the
 * bare call, the form earlier versions sent, so their cursors stay valid.
 */
const rowQuerySql = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
  language: string,
  mode: SearchMode,
): string => {
  const query = tsquerySql(
    valueSql(compilation, node, bindings),
    language,
    mode,
  );

  return !compilation.shapeOnly &&
    (node.kind === "parameter" || node.kind === "placeholder")
    ? `(SELECT ${query})`
    : query;
};

/**
 * An aggregate call: its argument renders first, and a window's OVER clause,
 * if any, is added right after the call. MIN and MAX of a type
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

/**
 * A sql`` template with values inside a comment or quoted text, where
 * PostgreSQL reads no parameter: such a value must bind none, and must not
 * end the comment or text early, which would leave the fragment open.
 */
const enclosedRawSql = (
  compilation: Compilation,
  node: Extract<ValueNode, { kind: "raw" }>,
  bindings: Bindings,
): string =>
  closedRawSql(
    node.parts
      .map((part, position) => {
        if (typeof part === "string") {
          return part;
        }

        const bound = compilation.parameters.length;
        const sql = operandSql(compilation, part, bindings);

        if (
          node.enclosed!.includes(position) &&
          compilation.parameters.length !== bound
        ) {
          throw new Error(
            "symmetria: a sql`` template interpolates a value inside a comment or quoted text, where PostgreSQL reads no parameter; move it out (a pattern is '%' || ${value} || '%')",
          );
        }

        return sql;
      })
      .join(""),
  );

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
      // A page cursor's fingerprint keeps the value bare, without the
      // read-once subquery or the JSON null wrapper, the form earlier
      // versions sent, so their cursors stay valid.
      if ((node.readOnce || node.wraps) && compilation.shapeOnly) {
        return operandSql(compilation, node.parts[1] as ValueNode, bindings);
      }

      if (node.enclosed) {
        return enclosedRawSql(compilation, node, bindings);
      }

      return node.parts
        .map((part) =>
          typeof part === "string"
            ? part
            : operandSql(compilation, part, bindings),
        )
        .join("");
    case "condition":
      return `(${predicateSql(compilation, node.predicate, bindings)})`;
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
      return searchRankSql(
        searchVector(compilation, node.value, bindings, node.language),
        rowQuerySql(
          compilation,
          node.query,
          bindings,
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
    case "searchHeadline": {
      const value = searchTextOf(
        node.value,
        valueSql(compilation, node.value, bindings),
      );
      const query = rowQuerySql(
        compilation,
        node.query,
        bindings,
        node.language,
        node.mode,
      );
      const options = headlineOptionsText(node.options);

      return searchHeadlineSql(
        node.language,
        value,
        query,
        options === undefined ? undefined : parameter(compilation, options),
      );
    }
    case "tsvector":
      return tsvectorSql(
        node.parts.map((part) => ({
          value: searchTextOf(
            part.value,
            valueSql(compilation, part.value, bindings),
          ),
          ...(part.weight ? { weight: part.weight } : {}),
          ...(isJsonValue(part.value) ? { isJson: true } : {}),
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
        nestedRow(node.query.selection),
      );
  }
};

const ROW_ALIAS = "__symmetria_row";

/**
 * How nested rows become JSON when the plain form would not do: a field named
 * like the rows' alias would stand for the row, so the alias changes, and a
 * key written under a shorter alias (`keyAlias`) is rebuilt under the key.
 */
const nestedRow = (
  selection: readonly ExpressionDescription[],
): JsonRowsShape | undefined => {
  if (
    !selection.some(
      ({ outputName }) => outputName.length > 21 || outputName === ROW_ALIAS,
    )
  ) {
    return undefined;
  }

  const columns = selection.map(({ outputName }) => keyAlias(outputName));
  let alias = ROW_ALIAS;

  while (columns.includes(alias)) {
    alias += "_";
  }

  const row = quoteIdentifier(alias);

  return columns.every(
    (column, position) => column === selection[position]!.outputName,
  )
    ? { alias: row }
    : {
        alias: row,
        fields: selection.map(({ outputName }, position) => ({
          key: outputName,
          value: `${row}.${quoteIdentifier(columns[position]!)}`,
        })),
      };
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

      const alias = keyAlias(expression.outputName);

      // A key could be spelled like another, longer key's alias.
      if (
        alias !== expression.outputName &&
        selection.some((other) => other.outputName === alias)
      ) {
        throw new Error(
          `symmetria: the result key "${alias}" is also the SQL alias of a longer key; rename one of them`,
        );
      }

      return `${projected} AS ${quoteIdentifier(alias)}`;
    })
    .join(", ");
