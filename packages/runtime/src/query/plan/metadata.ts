import type { ExpressionDescription } from "../expressions";

export const expressionSqlType = (
  expression: ExpressionDescription,
): string => {
  const node = expression.node;

  switch (node.kind) {
    case "placeholder":
      return node.sqlType;
    case "parameter":
      return (
        node.sqlType ?? node.cast ?? expression.codec?.sqlType ?? "derived"
      );
    case "raw":
      return (
        node.sqlType ??
        expression.codec?.sqlType ??
        expression.codec?.parameterCast ??
        "derived"
      );
    case "column": {
      const source =
        node.description.binding.projection?.[node.description.column.name];

      return source
        ? expressionSqlType(source)
        : node.description.column.sqlType;
    }
    case "case":
      return node.sqlType;
    case "arrayIndex":
      return node.elementType;
    case "jsonPath":
      return node.scalarType ?? "jsonb";
    case "jsonRows":
    case "jsonObject":
      return "jsonb";
    case "tsvector":
      return "tsvector";
    case "searchHeadline":
      return "text";
    case "arrayLength":
      return "integer";
    case "window":
      return expressionSqlType({ ...expression, node: node.expression });
    case "relativeWindow":
      return expressionSqlType({ ...expression, node: node.value });
    case "coalesce":
      return node.values[0]
        ? expressionSqlType({ ...expression, node: node.values[0] })
        : "derived";
    case "binary":
      return (
        node.sqlType ?? expressionSqlType({ ...expression, node: node.left })
      );
    case "aggregate":
      return node.numeric
        ? "numeric"
        : node.name === "COUNT"
          ? "bigint"
          : node.value
            ? expressionSqlType({ ...expression, node: node.value })
            : "derived";
    case "subquery":
      return node.query.selection[0]
        ? expressionSqlType(node.query.selection[0])
        : "derived";
    default:
      return (
        expression.codec?.parameterCast ??
        expression.codec?.sqlType ??
        "derived"
      );
  }
};

/** Recover a projection's shape without changing the expression used in SQL. */
export const expressionSource = (
  expression: ExpressionDescription,
): ExpressionDescription => {
  const node = expression.node;
  const source =
    node.kind === "column"
      ? node.description.binding.projection?.[node.description.column.name]
      : node.kind === "jsonPath"
        ? node.target
        : node.kind === "subquery"
          ? node.query.selection[0]
          : undefined;

  if (source) {
    return expressionSource(source);
  }

  const value =
    node.kind === "window"
      ? node.expression
      : node.kind === "relativeWindow"
        ? node.value
        : node.kind === "coalesce"
          ? node.values[0]
          : undefined;

  return value ? expressionSource({ ...expression, node: value }) : expression;
};
