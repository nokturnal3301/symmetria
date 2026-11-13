/**
 * Declares pulled CHECK constraints, index predicates and computed index keys in
 * the schema DSL: `(score > 0) AND (name <> 'x'::text)` becomes
 * `and(users.score.above(0), users.name.isNot("x"))`. A condition with any part
 * the DSL cannot express (a function call, a cast the DSL would not write) stays
 * `sql` text, as before.
 */
import { normalizeSqlType } from "../migrations/drift";
import { readExpression, type SqlExpression } from "../migrations/expressions";
import { quoteString } from "./names";

/**
 * What a column holds, which decides how its literals are written. Literals are
 * declared only in the form PostgreSQL stored, so the declaration parses back
 * to the same expression: `big < '10'::bigint` is `big.below(10n)`, while a
 * hand-written `big < 10` (an integer literal) stays `sql`.
 */
export type ValueKind =
  | {
      readonly kind:
        | "integer"
        | "real"
        | "double"
        | "bigint"
        | "decimal"
        | "boolean"
        | "other";
    }
  /** `type` is the column's type without modifiers: `text`, `date`, `uuid`, … */
  | { readonly kind: "string" | "timestamp"; readonly type: string }
  | { readonly kind: "enum"; readonly labels: readonly string[] };

export type ScopeColumn = {
  /** The column in generated code: `users.score`. */
  readonly source: string;
  readonly sqlType: string;
  readonly value: ValueKind;
};

/** The columns a condition can name, by SQL name. */
export type ConditionScope = ReadonlyMap<string, ScopeColumn>;

/** A condition in the DSL, with the functions it imports (`and`, `or`, `not`). */
export type DeclaredCondition = {
  readonly source: string;
  readonly imports: readonly string[];
};

const STRING_TYPES =
  /^(text|character varying|date|time without time zone|interval|uuid|inet)$/;
const TEXT_TYPES = new Set(["text", "character varying"]);

/** The kind of a column of the given PostgreSQL type, following the builders pull declares. */
export const valueKind = (
  sqlType: string,
  labels?: readonly string[],
): ValueKind => {
  if (labels) {
    return { kind: "enum", labels };
  }

  const type = normalizeSqlType(sqlType).replace(/\(.*?\)/, "");
  const simple = (
    {
      integer: "integer",
      smallint: "integer",
      real: "real",
      "double precision": "double",
      bigint: "bigint",
      numeric: "decimal",
      boolean: "boolean",
    } as const
  )[type];

  if (simple) {
    return { kind: simple };
  }

  if (/^timestamp with(out)? time zone$/.test(type)) {
    return { kind: "timestamp", type };
  }

  return STRING_TYPES.test(type) ? { kind: "string", type } : { kind: "other" };
};

/** Columns compare with each other only when TypeScript gives them one type. */
const typeOf = (kind: ValueKind): string =>
  kind.kind === "enum"
    ? `enum ${JSON.stringify(kind.labels)}`
    : ["integer", "real", "double"].includes(kind.kind)
      ? "number"
      : kind.kind;

/** Kinds arithmetic works on; real and double results are double precision. */
const NUMERIC_KINDS = new Set([
  "integer",
  "real",
  "double",
  "bigint",
  "decimal",
]);
/** Kinds whose column-to-column arithmetic PostgreSQL stores without casts of its own. */
const EXACT_KINDS = new Set(["integer", "bigint", "decimal"]);
const COMPARISON_METHODS: Readonly<Record<string, string>> = {
  "=": "is",
  "<>": "isNot",
  ">": "above",
  ">=": "atLeast",
  "<": "below",
  "<=": "atMost",
};
const ARITHMETIC_METHODS: Readonly<Record<string, string>> = {
  "+": "plus",
  "-": "minus",
  "*": "multiply",
  "/": "divide",
};

/** PostgreSQL's timestamp text as a Date, when a Date writes back the same instant. */
const timestampLiteral = (text: string): string | undefined => {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text,
    );

  if (!match) {
    return undefined;
  }

  // Without a zone the value is UTC wall-clock time, as the timestamp codec writes it.
  const zone = match[3]
    ? match[3] === "Z"
      ? "Z"
      : `${match[3].slice(0, 3)}:${match[3].slice(3).replace(":", "") || "00"}`
    : "Z";
  const date = new Date(`${match[1]}T${match[2]}${zone}`);

  return Number.isNaN(date.getTime())
    ? undefined
    : `new Date(${quoteString(date.toISOString())})`;
};

const INTEGER = /^-?\d+$/;

/**
 * A literal as TypeScript source for a value of `kind`, or undefined when it
 * does not fit or was stored with another type than the DSL would write.
 */
const literal = (node: SqlExpression, kind: ValueKind): string | undefined => {
  if (node.kind === "boolean") {
    return kind.kind === "boolean" ? String(node.value) : undefined;
  }

  if (node.kind !== "constant") {
    return undefined;
  }

  const { value: text, type } = node;

  switch (kind.kind) {
    case "integer":
      // PostgreSQL prints integer literals bare, negative ones as '-1'::integer.
      return INTEGER.test(text) &&
        (type === "integer" || (type === undefined && node.numeric)) &&
        Math.abs(Number(text)) <= 2147483647
        ? String(Number(text))
        : undefined;
    case "real":
    case "double":
      return type === (kind.kind === "real" ? "real" : "double precision") &&
        /^-?\d/.test(text) &&
        String(Number(text)) === text
        ? text
        : undefined;
    case "bigint":
      return type === "bigint" && INTEGER.test(text)
        ? `${BigInt(text)}n`
        : undefined;
    case "decimal":
      return (type === "numeric" || (type === undefined && node.numeric)) &&
        /^-?\d+(\.\d+)?$/.test(text)
        ? quoteString(text)
        : undefined;
    case "string":
      return type === undefined ||
        type === kind.type ||
        (TEXT_TYPES.has(kind.type) && TEXT_TYPES.has(type))
        ? quoteString(text)
        : undefined;
    case "enum":
      return kind.labels.includes(text) ? quoteString(text) : undefined;
    case "timestamp":
      return type?.replace(/\(.*?\)/, "") === kind.type
        ? timestampLiteral(text)
        : undefined;
    default:
      return undefined;
  }
};

/**
 * The kind of `left` combined with `right`, as plus() and friends type it. Any
 * real or double operand makes a double precision result.
 */
const promoted = (left: ValueKind, right: ValueKind): ValueKind => {
  const kinds: string[] = [left.kind, right.kind];

  return {
    kind: kinds.includes("decimal")
      ? "decimal"
      : kinds.includes("real") || kinds.includes("double")
        ? "double"
        : kinds.includes("bigint")
          ? "bigint"
          : "integer",
  };
};

const sameNode = (left: SqlExpression, right: SqlExpression): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const renderer = (scope: ConditionScope) => {
  const imports = new Set<string>();

  /** A column or arithmetic over columns: `users.score.plus(1)`. */
  const value = (
    node: SqlExpression,
  ): { source: string; kind: ValueKind } | undefined => {
    if (node.kind === "column") {
      const column = scope.get(node.name);

      return column && { source: column.source, kind: column.value };
    }

    if (node.kind !== "binary" || !ARITHMETIC_METHODS[node.operator]) {
      return undefined;
    }

    // plus() casts a non-decimal operand to numeric when the other one is
    // decimal, the cast PostgreSQL prints, so it is left to plus() again.
    const decimal = (side: SqlExpression, other: SqlExpression) =>
      side.kind === "cast" &&
      side.type === "numeric" &&
      value(other)?.kind.kind === "decimal"
        ? side.value
        : side;
    const left = value(decimal(node.left, node.right));

    if (!left || !NUMERIC_KINDS.has(left.kind.kind)) {
      return undefined;
    }

    // PostgreSQL widens a literal next to a real to double precision.
    const floating = left.kind.kind === "real" || left.kind.kind === "double";
    const kind: ValueKind = floating ? { kind: "double" } : left.kind;
    const constant = literal(node.right, kind);

    if (constant !== undefined) {
      return {
        source: `${left.source}.${ARITHMETIC_METHODS[node.operator]}(${constant})`,
        kind,
      };
    }

    const right = value(decimal(node.right, node.left));

    return right &&
      EXACT_KINDS.has(left.kind.kind) &&
      EXACT_KINDS.has(right.kind.kind)
      ? {
          source: `${left.source}.${ARITHMETIC_METHODS[node.operator]}(${right.source})`,
          kind: promoted(left.kind, right.kind),
        }
      : undefined;
  };

  /** The right side of a comparison with `left`: a literal of its type or a value of the same type. */
  const operand = (
    node: SqlExpression,
    left: { kind: ValueKind },
  ): string | undefined => {
    const constant = literal(node, left.kind);

    if (constant !== undefined) {
      return constant;
    }

    const right = value(node);

    return right && typeOf(right.kind) === typeOf(left.kind)
      ? right.source
      : undefined;
  };

  const negated = (call: string, negate: boolean): string => {
    if (!negate) {
      return call;
    }

    imports.add("not");

    return `not(${call})`;
  };

  /** `x >= a AND x <= b`, as PostgreSQL stores BETWEEN, back as `x.between(a, b)`. */
  const between = (
    lower: SqlExpression,
    upper: SqlExpression | undefined,
  ): string | undefined => {
    if (
      lower.kind !== "binary" ||
      lower.operator !== ">=" ||
      upper?.kind !== "binary" ||
      upper.operator !== "<=" ||
      !sameNode(lower.left, upper.left)
    ) {
      return undefined;
    }

    const subject = value(lower.left);
    const from = subject && operand(lower.right, subject);
    const to = subject && operand(upper.right, subject);

    return from === undefined || to === undefined
      ? undefined
      : `${subject!.source}.between(${from}, ${to})`;
  };

  const predicate = (node: SqlExpression): string | undefined => {
    switch (node.kind) {
      case "column": {
        const column = value(node);

        return column?.kind.kind === "boolean"
          ? `${column.source}.is(true)`
          : undefined;
      }
      case "logical": {
        const parts: (string | undefined)[] = [];

        for (let position = 0; position < node.values.length; position += 1) {
          const range =
            node.operator === "AND"
              ? between(node.values[position]!, node.values[position + 1])
              : undefined;

          if (range !== undefined) {
            parts.push(range);
            position += 1;
          } else {
            parts.push(predicate(node.values[position]!));
          }
        }

        if (parts.some((part) => part === undefined)) {
          return undefined;
        }

        if (parts.length === 1) {
          return parts[0];
        }

        const name = node.operator === "AND" ? "and" : "or";
        imports.add(name);

        return `${name}(${parts.join(", ")})`;
      }
      case "not": {
        const column =
          node.value.kind === "column" ? value(node.value) : undefined;

        if (column?.kind.kind === "boolean") {
          return `${column.source}.is(false)`;
        }

        const inner = predicate(node.value);

        return inner === undefined ? undefined : negated(inner, true);
      }
      case "binary": {
        const method = COMPARISON_METHODS[node.operator];
        const left = method ? value(node.left) : undefined;
        const right = left && operand(node.right, left);

        return right === undefined
          ? undefined
          : `${left!.source}.${method}(${right})`;
      }
      case "null-test": {
        const subject = value(node.value);

        return subject
          ? `${subject.source}.${node.negated ? "isNot" : "is"}(null)`
          : undefined;
      }
      case "in": {
        const subject = value(node.value);
        const items = subject
          ? node.values.map((entry) => literal(entry, subject.kind))
          : [];

        return subject && items.every((item) => item !== undefined)
          ? `${subject.source}.${node.negated ? "notIn" : "in"}([${items.join(", ")}])`
          : undefined;
      }
      case "like": {
        const subject = value(node.value);

        return subject &&
          (subject.kind.kind === "string" || subject.kind.kind === "enum") &&
          node.pattern.kind === "constant"
          ? negated(
              `${subject.source}.${node.operator === "LIKE" ? "like" : "ilike"}(${quoteString(node.pattern.value)})`,
              node.negated,
            )
          : undefined;
      }
      case "distinct": {
        const subject = value(node.left);
        const right =
          subject &&
          (node.right.kind === "null" ? "null" : operand(node.right, subject));

        return right === undefined
          ? undefined
          : negated(
              `${subject!.source}.isDistinctFrom(${right})`,
              node.negated,
            );
      }
      default:
        return undefined;
    }
  };

  return { value, predicate, imports };
};

const columnTypes = (scope: ConditionScope): Map<string, string> =>
  new Map([...scope].map(([name, column]) => [name, column.sqlType]));

/**
 * A CHECK or WHERE condition, as PostgreSQL prints it, declared in the DSL; a
 * boolean column stands alone. Undefined when only `sql` can declare it.
 */
export const declaredCondition = (
  sql: string,
  scope: ConditionScope,
): DeclaredCondition | undefined => {
  const node = readExpression(sql, columnTypes(scope));

  if (!node) {
    return undefined;
  }

  const { value, predicate, imports } = renderer(scope);
  const column = node.kind === "column" ? value(node) : undefined;
  const source =
    column?.kind.kind === "boolean" ? column.source : predicate(node);

  return source === undefined
    ? undefined
    : { source, imports: [...imports].sort() };
};

/** An index key computed from columns, `users.score.plus(1)`, or undefined. */
export const declaredKey = (
  sql: string,
  scope: ConditionScope,
): string | undefined => {
  const node = readExpression(sql, columnTypes(scope));

  return node?.kind === "binary"
    ? renderer(scope).value(node)?.source
    : undefined;
};
