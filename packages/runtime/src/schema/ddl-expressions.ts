/**
 * Renders expressions used in DDL (defaults, checks, index predicates) without query parameters.
 */
import type { PredicateDescription, ValueNode } from "../query/expressions";
import {
  isJsonType,
  searchTextSql,
  searchValueType,
  tsvectorSql,
  unindexableSearchText,
} from "../query/compile/postgres/search";
import { expressionSqlType } from "../query/plan/metadata";
import { canonicalType } from "../query/codecs/type-names";
import { closedRawSql } from "../query/expressions/raw-text";

/** A sql`` template with values inside its comments or quoted text must still end in plain SQL. */
const closedRaw = (
  node: Extract<ValueNode, { kind: "raw" }>,
  sql: string,
): string => (node.enclosed ? closedRawSql(sql) : sql);

const literalSQL = (value: unknown): string => {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  // A negative number is parenthesized: written after a minus sign, `-5`
  // would start a comment (`--5`), and `-5::text` casts 5, not -5.
  if (typeof value === "bigint") {
    return value < 0n ? `(${value})` : value.toString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 0 ? `(${value})` : String(value);
  }

  if (value instanceof Date) {
    return `${literalSQL(value.toISOString())}::timestamptz`;
  }

  // An escape string, like text: with standard_conforming_strings off,
  // `'\x41'` would read `\x41` as the letter A.
  if (value instanceof Uint8Array) {
    return `E'\\\\x${Buffer.from(value).toString("hex")}'::bytea`;
  }

  if (typeof value === "string" && !value.includes("\0")) {
    return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  }

  throw new Error(
    "symmetria: unsupported schema literal; use an encoded scalar or SQL expression",
  );
};

/** What a schema expression cannot contain, in the words of the API that builds it. */
const UNSUPPORTED: Record<
  Exclude<
    ValueNode["kind"],
    | "column"
    | "jsonPath"
    | "arrayIndex"
    | "parameter"
    | "raw"
    | "binary"
    | "case"
    | "coalesce"
    | "tsvector"
    | "condition"
  >,
  string
> = {
  placeholder: "prepared parameters",
  aggregate: "aggregates",
  tuple: "row values",
  relativeWindow: "lag() or lead()",
  window: "window functions",
  subquery: "subqueries",
  rowCount: "relation counts",
  jsonObject: "nested objects",
  jsonRows: "nested relations",
  searchRank: "searchRank()",
  searchHeadline: "searchHeadline()",
  arrayLength: "length()",
};

/**
 * A part of an indexed `searchDocument()` whose text PostgreSQL cannot index
 * is refused when the schema is declared, as `fullText()` refuses it, rather
 * than when a migration builds the index.
 */
const checkIndexedSearchText = (node: ValueNode, type: string): void => {
  const reason = unindexableSearchText(type);

  if (reason === undefined) {
    return;
  }

  const declared = expressionSqlType({ node, outputName: "value" });
  const what =
    type === "enum"
      ? "an enum"
      : `of type ${declared}${canonicalType(declared) === type ? "" : ` (${type})`}`;

  throw new Error(
    `symmetria: an index on searchDocument() cannot read ${node.kind === "column" ? `"${node.description.column.name}", which is ${what}` : `a value ${what}`}: ${reason}, so PostgreSQL refuses its text in an index; keep that text in a text column, or leave it out of the indexed document (queries can still search it)`,
  );
};

/**
 * Trusted schema expressions, with literal parameters and caller-owned column
 * scope. `index`: the expressions of an index, which PostgreSQL requires to
 * be immutable.
 */
export const ddlExpressions = (
  columnSQL: (node: Extract<ValueNode, { kind: "column" }>) => string,
  options: { readonly index?: boolean } = {},
) => {
  /**
   * Raw SQL is opaque: parenthesize it wherever an operator could bind into
   * it. A node that only wraps its operand for queries renders the operand
   * alone: the JSON null handling of a comparison (`wraps`), so checks and
   * partial indexes keep the SQL earlier versions wrote and need no
   * migration, and a vector read once per statement (`readOnce`), since
   * PostgreSQL refuses `(SELECT …)` in a CHECK or an index predicate and a
   * literal is constant anyway.
   */
  const operandSQL = (node: ValueNode): string =>
    node.kind === "raw"
      ? node.wraps || node.readOnce
        ? operandSQL(node.parts[1] as ValueNode)
        : `(${valueSQL(node)})`
      : valueSQL(node);

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
        if (node.wraps || node.readOnce) {
          return valueSQL(node.parts[1] as ValueNode);
        }

        return closedRaw(
          node,
          node.parts
            .map((part) => (typeof part === "string" ? part : operandSQL(part)))
            .join(""),
        );
      case "condition":
        return `(${predicateSQL(node.predicate)})`;
      case "binary":
        return `(${operandSQL(node.left)} ${node.operator} ${operandSQL(node.right)})`;
      case "case":
        return `(CASE ${valueSQL(node.value)} ${node.branches.map((branch) => `WHEN ${valueSQL(branch.when)} THEN ${valueSQL(branch.then)}`).join(" ")} END)`;
      case "coalesce":
        return `COALESCE(${node.values.map(valueSQL).join(", ")})`;
      // Each part reads as the text a query reads (a jsonb part as JSON,
      // another type as its text), so an index serves the query.
      case "tsvector":
        return tsvectorSql(
          node.parts.map((part) => {
            const type = searchValueType(part.value);

            if (options.index) {
              checkIndexedSearchText(part.value, type);
            }

            return {
              value: searchTextSql(type, valueSQL(part.value)),
              ...(part.weight ? { weight: part.weight } : {}),
              ...(isJsonType(type) ? { isJson: true } : {}),
              isVector:
                expressionSqlType({ node: part.value, outputName: "value" }) ===
                "tsvector",
            };
          }),
          node.language,
        );
      // An allow-list: only what PostgreSQL accepts in DDL without parameters.
      default:
        throw new Error(
          `symmetria: schema expressions cannot contain ${UNSUPPORTED[node.kind]}`,
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
      case "search":
        throw new Error(
          "symmetria: full-text predicates are not supported in schema expressions; index the document with searchDocument() instead",
        );
      // An allow-list, like valueSQL.
      default:
        throw new Error(
          "symmetria: schema expressions cannot contain subqueries",
        );
    }
  };

  return { valueSQL, predicateSQL };
};
