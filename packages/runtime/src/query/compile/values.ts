import { bigintCodec, numericCodec, cloneParameter } from "../codecs";
import { expressionSqlType } from "../metadata";
import { sameExpression } from "../equivalence";
import { isJsonExpression } from "../dialect";
import type {
  ExpressionDescription,
  ValueNode,
  WindowBoundary,
} from "../expressions";
import { containsBinding } from "../state";
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
    return value;
  }

  // Preserve the array shape and NULL elements while stringifying each number.
  return compilation.dialect.cast(value, { kind: "text", array: !!array });
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

export const renderValue = (
  compilation: Compilation,
  node: ValueNode,
  bindings: Bindings,
  jsonOutput: boolean,
): string => {
  const { dialect } = compilation;

  switch (node.kind) {
    case "placeholder": {
      if (!compilation.placeholder) {
        throw new Error(
          `symmetria: bind parameter "${node.name}" with prepare()`,
        );
      }

      const bound = parameter(compilation, compilation.placeholder(node));

      return node.codec?.parameterCast
        ? dialect.cast(bound, {
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
      return dialect.jsonPath(
        valueSql(compilation, node.value, bindings),
        node.path,
        { scalarType: node.scalarType, serialized: !!node.serialized },
        renderContext(compilation, bindings),
      );
    case "arrayIndex":
      return dialect.arrayIndex(
        valueSql(compilation, node.value, bindings),
        node.position,
        renderContext(compilation, bindings),
      );
    case "jsonObject":
      return dialect.jsonObject(
        node.selection.map((expression) => ({
          key: expression.outputName,
          value: jsonPrecisionSql(
            compilation,
            expression,
            valueSql(compilation, expression.node, bindings, jsonOutput),
          ),
          json: isJsonExpression(expression),
        })),
        jsonOutput,
      );
    case "parameter": {
      const bound = parameter(compilation, cloneParameter(node.value));

      return node.cast
        ? dialect.cast(bound, { kind: "parameter", type: node.cast })
        : bound;
    }
    case "raw":
      return node.parts
        .map((part) =>
          typeof part === "string"
            ? part
            : valueSql(compilation, part, bindings),
        )
        .join("");
    case "binary":
      return `(${valueSql(compilation, node.left, bindings)} ${node.operator} ${valueSql(compilation, node.right, bindings)})`;
    case "aggregate": {
      const aggregate = `${node.name}(${node.value ? valueSql(compilation, node.value, bindings) : "*"})`;

      return node.numeric
        ? dialect.cast(aggregate, { kind: "numeric" })
        : aggregate;
    }
    case "case":
      return `(CASE ${valueSql(compilation, node.value, bindings)} ${node.branches.map((branch) => `WHEN ${valueSql(compilation, branch.when, bindings)} THEN ${valueSql(compilation, branch.then, bindings)}`).join(" ")} END)`;
    case "coalesce":
      return `COALESCE(${node.values.map((value) => valueSql(compilation, value, bindings)).join(", ")})`;
    case "tuple":
      return `(${node.values.map((value) => valueSql(compilation, value, bindings)).join(", ")})`;
    case "relativeWindow":
      return `${node.name.toUpperCase()}(${[node.value, node.offset, ...(node.fallback ? [node.fallback] : [])].map((value) => valueSql(compilation, value, bindings)).join(", ")})`;
    case "window": {
      const numeric =
        node.expression.kind === "aggregate" && node.expression.numeric;
      const expression = numeric
        ? { ...node.expression, numeric: false }
        : node.expression;
      const expressionSQL = valueSql(compilation, expression, bindings);
      const fragments: string[] = [];

      if (node.partitionBy.length) {
        fragments.push(
          `PARTITION BY ${node.partitionBy.map((value) => valueSql(compilation, value, bindings)).join(", ")}`,
        );
      }

      if (node.orderBy.length) {
        fragments.push(
          `ORDER BY ${node.orderBy.map((ordering) => `${valueSql(compilation, ordering.expression.node, bindings)} ${ordering.direction}${ordering.nulls ? ` NULLS ${ordering.nulls}` : ""}`).join(", ")}`,
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

      const window = `${expressionSQL} OVER (${fragments.join(" ")})`;

      return numeric ? dialect.cast(window, { kind: "numeric" }) : window;
    }
    case "subquery":
      return `(${compilation.selectSql(node.query, bindings)})`;
    case "searchRank": {
      if (!dialect.capabilities.fullTextSearch || !dialect.searchRank) {
        throw new Error(
          `symmetria: searchRank() is not available in dialect "${dialect.name}"`,
        );
      }

      const value = valueSql(compilation, node.value, bindings);

      return dialect.searchRank(
        value,
        valueSql(compilation, node.query, bindings),
        node.language,
      );
    }
    case "arrayLength":
      return dialect.arrayLength(
        valueSql(compilation, node.value, bindings),
        !!node.json,
      );
    case "rowCount":
      return `(SELECT COUNT(*) FROM (${compilation.selectSql(node.query, bindings)}) AS "__symmetria_count")`;
    case "jsonRows":
      return dialect.jsonRows(
        compilation.selectSql(node.query, bindings, true, jsonOutput),
        node.query.selection.map((expression) => ({
          name: expression.outputName,
          json: isJsonExpression(expression),
        })),
        node.many,
        jsonOutput,
        renderContext(compilation, bindings),
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

      return `${jsonValues ? jsonPrecisionSql(compilation, expression, value) : value} AS ${quoteIdentifier(expression.outputName)}`;
    })
    .join(", ");
