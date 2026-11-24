/**
 * Functions over expressions: boolean combinators, aggregates, `coalesce`, `dateTrunc` and search documents.
 */
import { freeze } from "../plan/freeze";
import { countCodec, codecFor, numericCodec } from "../codecs";
import type { QueryReference } from "../plan/types";
import { expressionSqlType, valueSqlType } from "../plan/metadata";
import type { TsVector } from "../../schema/column";
import {
  COLUMN_EXPRESSION,
  type TraitsOf,
  type ValueNode,
  type ExpressionDescription,
  type SelectedColumn,
  type ExpressionValue,
  type PredicateDescription,
  type Predicate,
} from "./nodes";
import type {
  Decimal,
  Literal,
  StoredOf,
  Summable,
  SearchWeight,
  SearchDocumentOptions,
  SearchDocumentParts,
  NullWhen,
  QueryColumn,
} from "./column-types";
import {
  predicate,
  readPredicate,
  readColumn,
  valueNode,
  readQuery,
  createExpression,
} from "./core";
import {
  castNode,
  isJsonValue,
  isTextType,
  jsonScalar,
  readsAsString,
} from "./arithmetic";
import { searchLanguage } from "./search";
import { windowExpression, type WindowExpression } from "./windows";

/**
 * Entries a predicate list skips: every value `cond && predicate` can produce
 * when `cond` is falsy, so `[q && title.ilike(q)]` compiles for
 * `q: string | undefined` and an empty string adds no filter.
 */
export type SkippedPredicate = undefined | null | false | "" | 0 | 0n;
export type OptionalPredicate = Predicate | SkippedPredicate;

/** Falsy entries are skipped; anything else must be a predicate. */
export const presentPredicates = (
  conditions: readonly unknown[],
): readonly PredicateDescription[] =>
  freeze(
    conditions
      .filter((condition) => !!condition)
      .map((condition) => readPredicate(condition as Predicate)),
  );

/** AND of the given predicates; falsy entries (`undefined`, `null`, `false`, `""`, `0`, `0n`) are skipped. Empty is TRUE. */
export const and = (...conditions: OptionalPredicate[]): Predicate =>
  predicate({
    kind: "group",
    operator: "AND",
    predicates: presentPredicates(conditions),
  });

/** OR of the given predicates; falsy entries are skipped like in and(). Empty is FALSE. */
export const or = (...conditions: OptionalPredicate[]): Predicate =>
  predicate({
    kind: "group",
    operator: "OR",
    predicates: presentPredicates(conditions),
  });

export const when = <Value>(
  value: Value,
  callback: (value: NonNullable<Value>) => Predicate,
): Predicate | undefined =>
  value === null || value === undefined
    ? undefined
    : callback(value as NonNullable<Value>);

export const not = (value: Predicate): Predicate =>
  predicate({ kind: "not", predicate: readPredicate(value) });

export const exists = (query: QueryReference): Predicate =>
  predicate({ kind: "exists", query: readQuery(query), negated: false });

export const notExists = (query: QueryReference): Predicate =>
  predicate({ kind: "exists", query: readQuery(query), negated: true });

export const count = (
  expression?: SelectedColumn,
): WindowExpression<number, "count"> =>
  windowExpression({
    node: freeze({
      kind: "aggregate",
      name: "COUNT",
      ...(expression ? { value: readColumn(expression).node } : {}),
    }),
    outputName: "count",
    codec: countCodec,
  });

/** A JSON number is summed exactly, as numeric. */
export const sum = <
  Expression extends SelectedColumn<number | bigint | Decimal | null>,
>(
  expression: Expression & Summable<Expression>,
): WindowExpression<Decimal | null, "sum"> =>
  windowExpression({
    node: freeze({
      kind: "aggregate",
      name: "SUM",
      value: jsonScalar(readColumn(expression), "numeric").node,
      numeric: true,
    }),
    outputName: "sum",
    codec: numericCodec,
  });

export const average = <
  Expression extends SelectedColumn<number | bigint | Decimal | null>,
>(
  expression: Expression & Summable<Expression>,
): WindowExpression<Decimal | null, "average"> =>
  windowExpression({
    node: freeze({
      kind: "aggregate",
      name: "AVG",
      value: jsonScalar(readColumn(expression), "numeric").node,
      numeric: true,
    }),
    outputName: "average",
    codec: numericCodec,
  });

/** Types PostgreSQL orders without a MIN or MAX of their own, besides JSON and boolean. */
export const ELEMENT_ORDERED =
  /^(uuid|bytea|tsvector|vector|halfvec|(?:int4|int8|num|ts|tstz|date)(?:multi)?range)(\(|$)/;

/** A JSON value as jsonb: `json` has no equality or ordering. */
export const jsonbNode = (description: ExpressionDescription): ValueNode =>
  valueSqlType(description) === "json"
    ? castNode(description.node, "jsonb")
    : description.node;

/**
 * MIN or MAX in PostgreSQL's ordering of the value's type. Booleans use
 * bool_and / bool_or. JSON and the types of `ELEMENT_ORDERED` (uuid, bytea,
 * tsvector, vectors, ranges) have no MIN or MAX, so the first element of the
 * aggregated one-element arrays stands in, ordered by
 * the type's comparison: JSON orders objects above arrays above booleans above
 * numbers (numerically) above strings (textually), and skips JSON null like
 * SQL NULL.
 */
export const ordered = <Name extends "minimum" | "maximum">(
  expression: SelectedColumn,
  name: Name,
): WindowExpression<unknown, Name> => {
  const description = readColumn(expression);
  const sqlType = valueSqlType(description);
  const json = isJsonValue(description);

  return windowExpression({
    ...description,
    node: freeze({
      kind: "aggregate",
      name:
        sqlType === "boolean"
          ? name === "minimum"
            ? "BOOL_AND"
            : "BOOL_OR"
          : name === "minimum"
            ? "MIN"
            : "MAX",
      value: json ? jsonbNode(description) : description.node,
      ...(json
        ? { element: "json" as const }
        : ELEMENT_ORDERED.test(sqlType)
          ? { element: "value" as const }
          : {}),
    }),
    outputName: name,
  });
};

/** The smallest value, ignoring NULL (and JSON null); `null` for no rows. */
export const minimum = <Expression extends SelectedColumn>(
  expression: Expression,
): WindowExpression<
  ExpressionValue<Expression> | null,
  "minimum",
  TraitsOf<Expression>
> => ordered(expression, "minimum") as never;

/** The largest value, ignoring NULL (and JSON null); `null` for no rows. */
export const maximum = <Expression extends SelectedColumn>(
  expression: Expression,
): WindowExpression<
  ExpressionValue<Expression> | null,
  "maximum",
  TraitsOf<Expression>
> => ordered(expression, "maximum") as never;

/** A JSON value with JSON null turned into SQL NULL, since both decode to null. */
export const withoutJsonNull = (
  description: ExpressionDescription,
): ValueNode => {
  const value: ValueNode = freeze({
    kind: "raw",
    parts: freeze(["NULLIF(", jsonbNode(description), ", 'null'::jsonb)"]),
    sqlType: "jsonb",
  });

  return valueSqlType(description) === "json" ? castNode(value, "json") : value;
};

/**
 * `IS NOT NULL`; a JSON value must also not be JSON null, which reads as null
 * as well. `whereNotNull()` narrows with it.
 */
export const notNullPredicate = (
  description: ExpressionDescription,
): PredicateDescription =>
  isJsonValue(description)
    ? {
        kind: "nullCheck",
        value: withoutJsonNull(description),
        negated: true,
      }
    : { kind: "nullCheck", value: description.node, negated: true };

/** The value, or `fallback` where it is NULL (or JSON null): never null. */
export const coalesce = <Expression extends SelectedColumn>(
  expression: Expression,
  fallback:
    | Literal<StoredOf<Expression>>
    | SelectedColumn<NonNullable<ExpressionValue<Expression>>>,
): QueryColumn<
  NonNullable<ExpressionValue<Expression>>,
  "coalesce",
  TraitsOf<Expression>
> => {
  const description = readColumn(expression);
  const fallbackNode = valueNode(fallback, description.codec);
  // Text with an enum, uuid or date fallback: COALESCE needs one type.
  const textFallback =
    fallback !== null &&
    typeof fallback === "object" &&
    COLUMN_EXPRESSION in fallback &&
    isTextType(valueSqlType(description)) &&
    readsAsString(readColumn(fallback as SelectedColumn));

  return createExpression({
    ...description,
    node: freeze({
      kind: "coalesce",
      values: freeze([
        isJsonValue(description)
          ? withoutJsonNull(description)
          : description.node,
        textFallback ? castNode(fallbackNode, "text") : fallbackNode,
      ]),
    }),
    outputName: "coalesce",
  });
};

export const DATE_TRUNC_UNITS = [
  "microseconds",
  "milliseconds",
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "decade",
  "century",
  "millennium",
] as const;

/** A precision `date_trunc` cuts a timestamp down to. */
export type DateTruncUnit = (typeof DATE_TRUNC_UNITS)[number];

export type DateTruncOptions = {
  /**
   * The zone whose calendar decides where a day, week or month begins,
   * `"Europe/Berlin"`; the session's time zone without it. `timestamptz` only.
   */
  readonly timeZone?: string | SelectedColumn<string>;
};

/**
 * `date_trunc(unit, value)`: the start of the value's hour, day, month, …. A
 * `timestamptz` or `timestamp` keeps its type; a `date` becomes the
 * `timestamptz` of that start in the session's time zone, as in PostgreSQL.
 */
export const dateTrunc = <
  Expression extends SelectedColumn<Date | string | null>,
>(
  unit: DateTruncUnit,
  value: Expression,
  options: DateTruncOptions = {},
): QueryColumn<Date | NullWhen<ExpressionValue<Expression>>, "dateTrunc"> => {
  // The unit is written into the SQL text, so only the known names pass.
  if (!DATE_TRUNC_UNITS.includes(unit)) {
    throw new Error(
      `symmetria: dateTrunc() units are ${DATE_TRUNC_UNITS.join(", ")}`,
    );
  }

  const description = readColumn(value);
  const sqlType = expressionSqlType(description);
  const input = /^(timestamptz|timestamp|date)(\(\d\))?$/.exec(
    valueSqlType(description),
  )?.[1];

  if (!input) {
    throw new Error(
      `symmetria: dateTrunc() needs a timestamptz, timestamp or date value, not ${sqlType === "derived" ? "raw SQL of an unknown type; write it as sql.of(timestamptz)\`…\`" : sqlType}`,
    );
  }

  const { timeZone } = options;

  if (timeZone !== undefined && input !== "timestamptz") {
    throw new Error(
      `symmetria: dateTrunc() takes a timeZone for timestamptz values, not ${input}`,
    );
  }

  if (timeZone === "") {
    throw new Error("symmetria: dateTrunc() timeZone must be a zone name");
  }

  const result = input === "timestamp" ? "timestamp" : "timestamptz";

  return createExpression({
    node: freeze({
      kind: "raw",
      parts: freeze([
        `date_trunc('${unit}', `,
        description.node,
        ...(timeZone === undefined
          ? []
          : [", ", valueNode(timeZone, codecFor("text")), "::text"]),
        ")",
      ]),
      sqlType: result,
    }),
    outputName: "dateTrunc",
    codec: codecFor(result)!,
  });
};

export const SEARCH_WEIGHTS: ReadonlySet<string> = new Set([
  "A",
  "B",
  "C",
  "D",
]);

/**
 * A full-text document built from one or more expressions, optionally grouped by
 * weight: `searchDocument({ A: post.title, B: [post.body] }, { language: "english" })`.
 * Compiles to `setweight(to_tsvector(language, coalesce(expr, '')), 'A') || ...`; a
 * JSON part is `coalesce(expr, '{}')`, and a part of a type known not to be text (an
 * enum, uuid, date, …) is read as its text. The same expression declares a GIN index
 * in `.indexes()`, so the planner can use it; such an index refuses an enum, date,
 * timestamp, interval, money, range or array part.
 */
export const searchDocument = (
  parts: SearchDocumentParts,
  options: SearchDocumentOptions = {},
): QueryColumn<TsVector, "searchDocument"> => {
  const collected: {
    readonly value: ValueNode;
    readonly weight?: SearchWeight;
  }[] = [];
  const add = (part: unknown, weight?: SearchWeight) => {
    for (const entry of Array.isArray(part) ? part : [part]) {
      collected.push(
        freeze({
          value: readColumn(entry as SelectedColumn).node,
          ...(weight ? { weight } : {}),
        }),
      );
    }
  };

  if (parts && typeof parts === "object" && COLUMN_EXPRESSION in parts) {
    add(parts);
  } else if (Array.isArray(parts)) {
    add(parts);
  } else if (parts && typeof parts === "object") {
    for (const [weight, part] of Object.entries(parts)) {
      if (!SEARCH_WEIGHTS.has(weight)) {
        throw new Error(
          `symmetria: search weights are A, B, C or D, not "${weight}"`,
        );
      }

      if (part !== undefined) {
        add(part, weight as SearchWeight);
      }
    }
  }

  if (!collected.length) {
    throw new Error(
      "symmetria: searchDocument() requires at least one text expression",
    );
  }

  return createExpression<TsVector, "searchDocument">({
    outputName: "searchDocument",
    node: freeze({
      kind: "tsvector",
      parts: freeze(collected),
      language: searchLanguage(options.language),
    }),
  });
};
