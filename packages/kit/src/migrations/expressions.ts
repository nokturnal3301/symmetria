import { type SqlExpression, UnsupportedExpression } from "./expression-tree";
import { parseExpression } from "./expression-parser";
import { normalizeSqlType } from "./drift";
import {
  canonicalLiteral,
  minusCommutes,
  simplifyExpression,
} from "./expression-simplify";

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

/** A piece of SQL text: comments and quoted text stay whole, so nothing inside them is rewritten. */
type Piece = {
  readonly kind:
    | "space"
    | "comment"
    | "escaped"
    | "string"
    | "quoted"
    | "number"
    | "word"
    | "symbol"
    | "operator"
    /** A negative number whose parentheses were taken off. */
    | "negative";
  readonly text: string;
};

const PIECE =
  /(\s+)|(--[^\n\r]*|\/\*[\s\S]*?(?:\*\/|$))|([eE]'(?:[^'\\]|\\[\s\S]|'')*(?:'|$))|('(?:[^']|'')*(?:'|$)|\$(?:[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$)|("(?:[^"]|"")*(?:"|$))|((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z_\u0080-\uFFFF][\w$\u0080-\uFFFF]*)|(::|[()[\],.;:])|((?:(?!--|\/\*)[-+*/<>=~!@#%^&|`?])+)|([\s\S])/gy;
const KINDS = [
  "space",
  "comment",
  "escaped",
  "string",
  "quoted",
  "number",
  "word",
  "symbol",
  "operator",
  "symbol",
] as const;

const pieces = (sql: string): Piece[] => {
  const result: Piece[] = [];
  PIECE.lastIndex = 0;

  for (let found = PIECE.exec(sql); found; found = PIECE.exec(sql)) {
    const group = found.findIndex((text, index) => index > 0 && text);
    const text = found[0];

    // A dollar quote runs to the same tag (its body is not SQL).
    if (group === 4 && text.startsWith("$")) {
      const end = sql.indexOf(text, PIECE.lastIndex);
      const close = end < 0 ? sql.length : end + text.length;
      result.push({
        kind: "string",
        text: sql.slice(found.index, close),
      });
      PIECE.lastIndex = close;
      continue;
    }

    result.push({ kind: KINDS[group - 1]!, text });
  }

  return result;
};

/**
 * SQL with a line break after the `--` comment it ends in, as a sql``
 * template's text is saved now. Snapshots saved by earlier versions hold
 * `1 -- one`, and SQL written after it (`SET DEFAULT 1 -- one;`) would be
 * part of the comment.
 */
export const commentEnded = (sql: string): string => {
  const last = pieces(sql).at(-1);

  return last?.kind === "comment" && last.text.startsWith("--")
    ? `${sql}\n`
    : sql;
};

/**
 * Words after which `(` groups an operand, as it does after an operator,
 * rather than opening an argument list (`f(-5)`, `IN (-5)`).
 */
const OPERAND_WORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "between",
  "symmetric",
  "like",
  "ilike",
  "similar",
  "to",
  "escape",
  "case",
  "when",
  "then",
  "else",
  "at",
  "zone",
  "from",
  "select",
  "where",
]);

/**
 * Writes in one spelling the literals that versions spell differently: a
 * negative number in parentheses as the bare number where the parentheses
 * change nothing (`"n" > (-5)` is `"n" > -5`; `f((-5))` is `f(-5)`;
 * `(-5)::text::real` is `-5::text::real`; not before `::text`, a subscript
 * or a field: see minusCommutes), and a bytea escape string as the
 * plain string it reads as (`E'\\x0102'::bytea` is `'\x0102'::bytea`). Schema
 * expressions write `(-5)` and `E'\\x…'::bytea`, while snapshots saved by
 * earlier versions hold `-5` and `'\x…'::bytea`; both compare the same.
 */
const literalSpellings = (sql: string): string => {
  const list = pieces(sql);
  const significant = (from: number, step: 1 | -1): number => {
    let index = from;

    while (list[index]?.kind === "space" || list[index]?.kind === "comment") {
      index += step;
    }

    return index;
  };
  /**
   * The types of the casts starting at `from`, normalized (`::text::float8`
   * is text, then double precision), or undefined where one is not a plain
   * type name: a quoted or qualified name, or an array type.
   */
  const castsFrom = (from: number) => {
    const casts: string[] = [];
    let index = from;

    while (list[index]?.text === "::") {
      let end = significant(index + 1, 1);
      const word = list[end];

      if (word?.kind !== "word") {
        return undefined;
      }

      let type = word.text;
      const second = significant(end + 1, 1);

      if (
        type.toLowerCase() === "double" &&
        list[second]?.text.toLowerCase() === "precision"
      ) {
        type = "double precision";
        end = second;
      }

      index = significant(end + 1, 1);
      const modifier = list[index]?.text === "(";

      for (let depth = 0; modifier && index < list.length; index++) {
        type += list[index]!.kind === "space" ? "" : list[index]!.text;
        depth +=
          list[index]!.text === "(" ? 1 : list[index]!.text === ")" ? -1 : 0;

        if (depth === 0) {
          index = significant(index + 1, 1);
          break;
        }
      }

      if (list[index]?.text === "[" || list[index]?.text === ".") {
        return undefined;
      }

      casts.push(normalizeSqlType(type));
    }

    return casts;
  };

  for (let index = 0; index < list.length; index++) {
    const piece = list[index]!;
    const next = significant(index + 1, 1);

    if (
      piece.kind === "escaped" &&
      /^[eE]'\\\\x[0-9A-Fa-f]*'$/.test(piece.text) &&
      list[next]?.text === "::" &&
      list[significant(next + 1, 1)]?.text.toLowerCase() === "bytea"
    ) {
      list[index] = { kind: "string", text: `'${piece.text.slice(3)}` };
    }
  }

  // Inside out, so `((-5))` loses both pairs where neither is a call's.
  for (let changed = true; changed; ) {
    changed = false;

    for (let index = 0; index < list.length; index++) {
      if (list[index]!.text !== "(") {
        continue;
      }

      const negative =
        list[index + 1]?.kind === "negative"
          ? { text: list[index + 1]!.text, length: 3 }
          : list[index + 1]?.text === "-" && list[index + 2]?.kind === "number"
            ? { text: `-${list[index + 2]!.text}`, length: 4 }
            : undefined;

      if (!negative || list[index + negative.length - 1]?.text !== ")") {
        continue;
      }

      const before = list[significant(index - 1, -1)];
      const afterIndex = significant(index + negative.length, 1);
      const after = list[afterIndex];
      const opensOperand =
        !before ||
        before.kind === "operator" ||
        ["(", "[", ","].includes(before.text) ||
        (before.kind === "word" &&
          OPERAND_WORDS.has(before.text.toLowerCase()));
      const casts = after?.text === "::" ? castsFrom(afterIndex) : [];
      const bindsTighter =
        after?.text === "[" ||
        after?.text === "." ||
        casts === undefined ||
        (casts.length > 0 &&
          !minusCommutes(negative.text.replace(/^\s*-/, ""), casts));

      if (!opensOperand || bindsTighter) {
        continue;
      }

      // Written right after an operator ending in `-` (a comment) or holding
      // one of ~ ! @ # % ^ & | ` ?, the minus sign would join it.
      const adjacent = list[index - 1];
      const glue =
        adjacent?.kind === "operator" && /-$|[~!@#%^&|`?]/.test(adjacent.text)
          ? " "
          : "";
      list.splice(index, negative.length, {
        kind: "negative",
        text: `${glue}${negative.text}`,
      });
      changed = true;
    }
  }

  return list.map((piece) => piece.text).join("");
};

/**
 * The comparison key of a CHECK expression, index predicate or key expression:
 * two expressions with equal keys are the same expression. SQL the parser does
 * not model is compared by its text, with whitespace collapsed and literals in
 * one spelling.
 */
export const expressionKey = (
  sql: string,
  columns?: ReadonlyMap<string, string>,
): string => {
  try {
    return printKey(simplifyExpression(parseExpression(sql), columns));
  } catch (error) {
    if (error instanceof UnsupportedExpression) {
      return literalSpellings(sql).replace(/\s+/g, " ").trim();
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
