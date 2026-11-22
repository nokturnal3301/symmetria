import { type SqlExpression, UnsupportedExpression } from "./expression-tree";
import { parseExpression } from "./expression-parser";
import { canonicalLiteral, simplifyExpression } from "./expression-simplify";

export type { SqlExpression } from "./expression-tree";

/**
 * Types that decide what a string literal means: the same text is another
 * instant as `timestamp` than as `timestamptz`, and `json` compares unlike
 * `jsonb`. The casts PostgreSQL adds on its own (`'a'::text`) are not among them.
 */
const VALUE_TYPES = /^(?:timestamp|time|date|interval|jsonb?)\b/;

const quoted = (text: string, quote: string): string =>
  `${quote}${text.replaceAll(quote, quote + quote)}${quote}`;

/** Fully parenthesized text of a simplified tree: equal texts, equal expressions. */
const printKey = (node: SqlExpression): string => {
  switch (node.kind) {
    case "constant":
      // A number and a string are different values where the operator takes
      // either (`doc -> 0` is an array element, `doc -> '0'` an object key),
      // so a number prints without quotes. A real literal compares in single
      // precision, unlike the same digits elsewhere.
      // Spellings of one value PostgreSQL stores in its own form compare
      // the same; the tree pull renders keeps the stored text.
      return `${node.numeric ? node.value : quoted(node.type ? canonicalLiteral(node.value, node.type) : node.value, "'")}${
        node.type === "real"
          ? "::real"
          : !node.numeric && node.type && VALUE_TYPES.test(node.type)
            ? `::${node.type}`
            : ""
      }`;
    case "boolean":
      return node.value ? "TRUE" : "FALSE";
    case "null":
      return "NULL";
    case "column":
      return node.name === "*" ? "*" : quoted(node.name, '"');
    case "cast":
      // `char(2)` in code is `character(2)` when PostgreSQL prints it.
      return `CAST(${printKey(node.value)} AS ${node.type.replace(/^char\(/, "character(")})`;
    case "call":
      return `${node.name}(${node.arguments.map(printKey).join(", ")})`;
    case "binary":
      return `(${printKey(node.left)} ${node.operator} ${printKey(node.right)})`;
    case "unary":
      return `(${node.operator}${printKey(node.value)})`;
    case "not":
      return `(NOT ${printKey(node.value)})`;
    case "logical":
      return `(${node.values.map(printKey).join(` ${node.operator} `)})`;
    case "null-test":
      return `(${printKey(node.value)} IS ${node.negated ? "NOT " : ""}NULL)`;
    case "truth-test":
      return `(${printKey(node.value)} IS ${node.negated ? "NOT " : ""}${node.test})`;
    case "distinct":
      return `(${printKey(node.left)} IS ${node.negated ? "NOT " : ""}DISTINCT FROM ${printKey(node.right)})`;
    case "in":
      return `(${printKey(node.value)} ${node.negated ? "NOT " : ""}IN (${node.values.map(printKey).join(", ")}))`;
    case "quantified":
      return `(${printKey(node.left)} ${node.operator} ${node.quantifier} (${printKey(node.right)}))`;
    case "array":
      return `ARRAY[${node.values.map(printKey).join(", ")}]`;
    case "between":
      return `(${printKey(node.value)} ${node.negated ? "NOT " : ""}BETWEEN${node.symmetric ? " SYMMETRIC" : ""} ${printKey(node.lower)} AND ${printKey(node.upper)})`;
    case "like":
      return `(${printKey(node.value)} ${node.negated ? "NOT " : ""}${node.operator} ${printKey(node.pattern)})`;
    case "collate":
      return `(${printKey(node.value)} COLLATE ${quoted(node.collation, '"')})`;
    case "case":
      return `(CASE${node.subject ? ` ${printKey(node.subject)}` : ""} ${node.branches.map((branch) => `WHEN ${printKey(branch.when)} THEN ${printKey(branch.then)}`).join(" ")}${node.otherwise ? ` ELSE ${printKey(node.otherwise)}` : ""} END)`;
  }
};

/**
 * The comparison key of a CHECK expression, index predicate or key expression:
 * two expressions with equal keys are the same expression. SQL the parser does
 * not model is compared by its text, with whitespace collapsed.
 */
export const expressionKey = (
  sql: string,
  columns?: ReadonlyMap<string, string>,
): string => {
  try {
    return printKey(simplifyExpression(parseExpression(sql), columns));
  } catch (error) {
    if (error instanceof UnsupportedExpression) {
      return sql.replace(/\s+/g, " ").trim();
    }

    throw error;
  }
};

/** Parses and simplifies, or returns undefined for SQL the parser does not model. */
export const readExpression = (
  sql: string,
  columns?: ReadonlyMap<string, string>,
): SqlExpression | undefined => {
  try {
    return simplifyExpression(parseExpression(sql), columns);
  } catch (error) {
    if (error instanceof UnsupportedExpression) {
      return undefined;
    }

    throw error;
  }
};

/**
 * An index key's comparison key: its expression's key, then its ordering
 * without PostgreSQL's defaults (ASC, NULLS LAST after ASC, NULLS FIRST
 * after DESC), so `name ASC NULLS LAST` is `name`.
 */
export const indexKeyKey = (
  key: string,
  columns?: ReadonlyMap<string, string>,
): string => {
  const ordering = /(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(FIRST|LAST))?$/i.exec(
    key,
  )!;
  const descending = ordering[1]?.toUpperCase() === "DESC";
  const nulls = ordering[2]?.toUpperCase();
  const defaultNulls = descending ? "FIRST" : "LAST";

  return `${expressionKey(key.slice(0, ordering.index), columns)}${descending ? " DESC" : ""}${nulls && nulls !== defaultNulls ? ` NULLS ${nulls}` : ""}`;
};
