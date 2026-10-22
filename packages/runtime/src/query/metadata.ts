import type { ExpressionDescription } from "./expressions";
import type { Dialect } from "./state";

/** SQL storage type survives wrappers; JSON extraction is scalar only for known fields. */
export const expressionSqlType = (
  expression: ExpressionDescription,
): string => {
  const node = expression.node;

  switch (node.kind) {
    case "placeholder":
      return node.sqlType;
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
    case "window":
      return expressionSqlType({ ...expression, node: node.expression });
    case "relativeWindow":
      return expressionSqlType({ ...expression, node: node.value });
    case "coalesce":
      return node.values[0]
        ? expressionSqlType({ ...expression, node: node.values[0] })
        : "derived";
    case "binary":
      return expressionSqlType({ ...expression, node: node.left });
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
      return expression.codec?.parameterCast ?? "derived";
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

export const expressionDialect = (
  expression: ExpressionDescription,
): Dialect => {
  const node = expression.node;

  if (node.kind === "column") {
    return node.description.binding.dialect ?? "postgres";
  }

  if (node.kind === "jsonRows" || node.kind === "subquery") {
    return node.query.root.dialect ?? "postgres";
  }

  if (node.kind === "jsonPath" || node.kind === "arrayIndex") {
    return expressionDialect({ ...expression, node: node.value });
  }

  const source = expressionSource(expression);

  return source !== expression ? expressionDialect(source) : "postgres";
};
