import type { PredicateDescription, ValueNode } from "../query/expressions";

const literalSQL = (value: unknown): string => {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (value instanceof Date) {
    return `${literalSQL(value.toISOString())}::timestamptz`;
  }

  if (typeof value === "string" && !value.includes("\0")) {
    return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  }

  throw new Error(
    "symmetria: unsupported schema literal; use an encoded scalar or SQL expression",
  );
};

/** Trusted schema expressions, with literal parameters and caller-owned column scope. */
export const ddlExpressions = (
  columnSQL: (node: Extract<ValueNode, { kind: "column" }>) => string,
) => {
  /** Raw SQL is opaque: parenthesize it wherever an operator could bind into it. */
  const operandSQL = (node: ValueNode): string =>
    node.kind === "raw" ? `(${valueSQL(node)})` : valueSQL(node);

  const valueSQL = (node: ValueNode): string => {
    switch (node.kind) {
      case "column":
        return columnSQL(node);
      case "jsonPath":
        return `(${valueSQL(node.value)} ${node.scalarType ? "#>>" : "#>"} ARRAY[${node.path.map((part) => `${literalSQL(String(part))}::text`).join(", ")}])${node.scalarType ? `::${node.scalarType}` : ""}`;
      case "arrayIndex":
        return `(${valueSQL(node.value)})[(CASE WHEN ${node.position}::bigint < cardinality(${valueSQL(node.value)}) THEN array_lower(${valueSQL(node.value)}, 1)::bigint + ${node.position}::bigint END)::integer]`;
      case "parameter":
        return `${literalSQL(node.value)}${node.cast ? `::text::${node.cast}` : ""}`;
      case "raw":
        return node.parts
          .map((part) => (typeof part === "string" ? part : operandSQL(part)))
          .join("");
      case "binary":
        return `(${operandSQL(node.left)} ${node.operator} ${operandSQL(node.right)})`;
      case "case":
        return `(CASE ${valueSQL(node.value)} ${node.branches.map((branch) => `WHEN ${valueSQL(branch.when)} THEN ${valueSQL(branch.then)}`).join(" ")} END)`;
      case "coalesce":
        return `COALESCE(${node.values.map(valueSQL).join(", ")})`;
      default:
        throw new Error(
          "symmetria: schema expressions cannot contain aggregates, subqueries or placeholders",
        );
    }
  };

  const predicateSQL = (condition: PredicateDescription): string => {
    switch (condition.kind) {
      case "comparison":
        return `${operandSQL(condition.left)} ${condition.operator} ${operandSQL(condition.right)}`;
      case "nullCheck":
        return `${operandSQL(condition.value)} IS ${condition.negated ? "NOT " : ""}NULL`;
      case "group":
        if (!condition.predicates.length) {
          return condition.operator === "AND" ? "TRUE" : "FALSE";
        }

        return `(${condition.predicates.map(predicateSQL).join(` ${condition.operator} `)})`;
      case "not":
        return `NOT (${predicateSQL(condition.predicate)})`;
      case "between":
        return `${operandSQL(condition.value)} BETWEEN ${operandSQL(condition.lower)} AND ${operandSQL(condition.upper)}`;
      case "membership": {
        if (!Array.isArray(condition.values)) {
          throw new Error(
            "symmetria: schema expressions cannot contain subqueries",
          );
        }

        if (!condition.values.length) {
          return condition.negated ? "TRUE" : "FALSE";
        }

        return `${operandSQL(condition.value)} ${condition.negated ? "NOT " : ""}IN (${condition.values.map(valueSQL).join(", ")})`;
      }
      default:
        throw new Error(
          "symmetria: schema expressions cannot contain subqueries",
        );
    }
  };

  return { valueSQL, predicateSQL };
};
