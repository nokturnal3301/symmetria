/**
 * The `sql` tag: raw SQL fragments with bound values.
 */
import { freeze } from "../plan/freeze";
import { booleanCodec, codecFor, type RuntimeCodec } from "../codecs";
import {
  COLUMN_CODEC,
  SQL_DEFAULT,
  type Column,
  type SqlDefault,
  type MetadataTraits,
} from "../../schema/column";
import {
  COLUMN_EXPRESSION,
  ORDERING_EXPRESSION,
  PREDICATE_EXPRESSION,
  type ValueNode,
  type ExpressionDescription,
  type Ordering,
  type Predicate,
  type PredicateDescription,
} from "./nodes";
import type { QueryColumn } from "./column-types";
import { valueNode, ColumnHandle, chained } from "./core";
import type { OptionalPredicate } from "./functions";
import { readTemplate } from "./raw-text";
import { QUERY_PLAN } from "../plan/types";

const TRUE: ValueNode = freeze({ kind: "raw", parts: freeze(["TRUE"]) });

export const SQL_TEMPLATE = Symbol("symmetria.query.sql");

export class SqlHandle extends ColumnHandle {
  readonly kind = "sql" as const;
  readonly [SQL_DEFAULT] = true as const;
  readonly [SQL_TEMPLATE]: {
    readonly strings: TemplateStringsArray;
    readonly interpolated: boolean;
  };

  constructor(
    description: ExpressionDescription,
    strings: TemplateStringsArray,
    interpolated: boolean,
  ) {
    super(description);
    this[SQL_TEMPLATE] = { strings, interpolated };
  }

  /**
   * The template as a condition, for `where: sql<boolean>\`…\``: compared with
   * TRUE, which PostgreSQL folds away while planning.
   */
  get [PREDICATE_EXPRESSION](): PredicateDescription {
    return freeze({
      kind: "comparison",
      left: this[COLUMN_EXPRESSION].node,
      operator: "=",
      right: TRUE,
    });
  }

  and(...conditions: OptionalPredicate[]): Predicate {
    return chained(this[PREDICATE_EXPRESSION], "AND", conditions);
  }

  or(...conditions: OptionalPredicate[]): Predicate {
    return chained(this[PREDICATE_EXPRESSION], "OR", conditions);
  }

  get sql(): string {
    if (this[SQL_TEMPLATE].interpolated) {
      throw new Error("symmetria: SQL defaults cannot contain interpolations");
    }

    return readTemplate(this[SQL_TEMPLATE].strings).strings.join("");
  }
}

/** Whether drivers bind the value: a primitive, a Date, bytes, a plain JSON object, or an array of these. */
const isBindable = (value: unknown): boolean => {
  if (typeof value === "function" || typeof value === "symbol") {
    return false;
  }

  if (value === null || typeof value !== "object") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isBindable);
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null ||
    value instanceof Date ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  );
};

/** What a non-value interpolation is, for the message that refuses it. */
const describeInterpolation = (value: unknown): string => {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    QUERY_PLAN in value
  ) {
    return "a query; interpolate query.scalar() for its one value, or use exists(query) or column.in(query)";
  }

  if (Array.isArray(value)) {
    return "an array that holds a column, SQL expression, condition or other non-value; interpolate each element on its own, as in (${a}, ${b})";
  }

  if (typeof value === "function") {
    return "a function; call it and interpolate its result";
  }

  if (typeof value === "symbol") {
    return "a symbol";
  }

  const name = (value as object).constructor?.name;

  return `${name ? `a ${name}` : "an object"} that is no value a driver binds; interpolate a string, number, bigint, boolean, Date, Buffer, plain JSON object or array of these (for example String(value))`;
};

/**
 * What a value in sql`` stands for: a column, expression, condition or
 * ordering renders as its SQL; anything else must be a value to bind.
 */
const interpolation = (value: unknown): ValueNode => {
  if (value !== null && typeof value === "object") {
    if (COLUMN_EXPRESSION in value) {
      return valueNode(value);
    }

    if (PREDICATE_EXPRESSION in value) {
      return freeze({
        kind: "condition",
        predicate: (value as Predicate)[PREDICATE_EXPRESSION],
      });
    }

    if (ORDERING_EXPRESSION in value) {
      const { expression, direction, nulls } = (value as Ordering)[
        ORDERING_EXPRESSION
      ];

      // `column DESC NULLS LAST`, as an ORDER BY inside the template takes it.
      return freeze({
        kind: "raw",
        parts: freeze([
          expression.node,
          ` ${direction}${nulls ? ` NULLS ${nulls}` : ""}`,
        ]),
        composed: true,
        delimited: true,
      });
    }
  }

  if (value !== undefined && !isBindable(value)) {
    throw new Error(
      `symmetria: a sql\`\` template cannot interpolate ${describeInterpolation(value)}`,
    );
  }

  return valueNode(value);
};

/** A `sql<Value>` template: its SQL type is whatever the SQL says, unknown to Symmetria. */
export type RawTraits = { readonly numeric: "raw" };

export type SqlTemplate<Value, Traits = RawTraits> = QueryColumn<
  Value,
  "expression",
  Traits
> &
  SqlDefault & {
    kind: "sql";
    sql: string;
  } & BooleanCondition<Value>;

/** `sql<boolean>` is also a condition: `where`, `and()`, a JOIN's ON take it as it is. */
type BooleanCondition<Value> = unknown extends Value
  ? unknown
  : [Value] extends [boolean | null]
    ? Predicate
    : unknown;

export const sqlTemplate = <Value, Traits = RawTraits>(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  codec?: RuntimeCodec,
  sqlType?: string,
): SqlTemplate<Value, Traits> => {
  // Called as a function, `sql(text)` would run its argument as SQL: only a
  // template literal, whose text the source code wrote, is accepted.
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    throw new Error(
      "symmetria: sql is a template tag: write sql`…${value}…`, not sql(text)",
    );
  }

  const text = readTemplate(strings);
  const parts: (string | ValueNode)[] = [];
  text.strings.forEach((part, index) => {
    parts.push(part);

    if (index < values.length) {
      parts.push(interpolation(values[index]));
    }
  });

  return freeze(
    new SqlHandle(
      {
        node: freeze({
          kind: "raw",
          parts: freeze(parts),
          ...(sqlType ? { sqlType } : {}),
          // The value after the template's string `index` is part 2·index+1.
          ...(text.enclosed
            ? {
                enclosed: freeze(text.enclosed.map((index) => index * 2 + 1)),
              }
            : {}),
        }),
        outputName: "expression",
        ...(codec ? { codec } : {}),
      },
      strings,
      values.length > 0,
    ),
  ) as unknown as SqlTemplate<Value, Traits>;
};

export type ColumnResult<Definition> =
  Definition extends Column<infer Metadata>
    ? Metadata["notNull"] extends false
      ? Metadata["valueType"] | null
      : Metadata["valueType"]
    : never;

/** How a column's values compute and compare in SQL (see `ColumnTraits`). */
export type DefinitionTraits<Definition> =
  Definition extends Column<infer Metadata> ? MetadataTraits<Metadata> : {};

// Keep recursive column types named when this callable is included in ShapeTools.
export interface SqlTag {
  <Value = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlTemplate<Value>;
  /**
   * A template typed and decoded like a column, including driver-specific
   * codecs; arithmetic and comparisons treat it as that column's SQL type.
   */
  of: <Definition extends Column>(
    column: Definition,
  ) => (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => SqlTemplate<ColumnResult<Definition>, DefinitionTraits<Definition>>;
}

/**
 * Raw SQL with bound values: an interpolated value is sent as a parameter, and
 * a column, expression, condition or ordering is written as its SQL; only the
 * template's literal text is SQL. `sql<boolean>` is also a condition.
 */
export const sql: SqlTag = Object.assign(
  <Value = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlTemplate<Value> => sqlTemplate<Value>(strings, values),
  {
    /**
     * A template typed and decoded like a column: `sql.of(bool)` returns booleans on every
     * driver, `sql.of(timestamptz)` returns Dates and `sql.of(bigint)` bigints.
     */
    of:
      <Definition extends Column>(column: Definition) =>
      (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): SqlTemplate<ColumnResult<Definition>, DefinitionTraits<Definition>> =>
        sqlTemplate<ColumnResult<Definition>, DefinitionTraits<Definition>>(
          strings,
          values,
          column[COLUMN_CODEC] ??
            (column.definition.sqlType === "boolean"
              ? booleanCodec
              : codecFor(column.definition.sqlType)),
          column.definition.sqlType,
        ),
  },
);
