/**
 * Column type conversions that can cut, round or drop part of existing values.
 * Generation leaves USING out where PostgreSQL's assignment cast rejects values
 * that do not fit (an explicit cast would cut them), and lint reports every
 * lossy conversion as destructive.
 */
import { normalizeSqlType } from "./drift";
import type { MigrationColumn } from "./snapshot";

export type TypeConversion = {
  /**
   * Leave USING out: the target is a length-limited string, where an explicit
   * `::varchar(n)` cast silently cuts long values but the assignment cast fails.
   */
  readonly assignmentCast: boolean;
  /** Existing values can change or stop fitting: the change counts as destructive. */
  readonly lossy: boolean;
  /** What happens to existing values, as a sentence fragment (lossy conversions only). */
  readonly effect?: string;
  /**
   * Nothing is cut or rounded: PostgreSQL refuses the values that do not fit,
   * so the migration fails until they are moved or changed.
   */
  readonly refused?: boolean;
  /**
   * No value can be converted, so the column is emptied (`USING NULL`): an
   * embedding of one length says nothing as an embedding of another.
   */
  readonly cleared?: boolean;
};

/**
 * Why a search's stored embeddings no longer describe their rows: the model
 * is another one, or it embeds other columns (`renamed` maps old column
 * names to new ones, so a renamed column is the same text). Undefined when
 * they still fit, or when the earlier snapshot did not record them.
 */
export const embeddingChange = (
  before: MigrationColumn,
  after: MigrationColumn,
  renamed: ReadonlyMap<string, string> = new Map(),
): string | undefined => {
  if (!before.embedding || !after.embedding) {
    return undefined;
  }

  if (before.embedding.model !== after.embedding.model) {
    return `the model changes from ${before.embedding.model} to ${after.embedding.model}`;
  }

  const sources = before.embedding.sources.map(
    (name) => renamed.get(name) ?? name,
  );

  return sources.join("\u0000") === after.embedding.sources.join("\u0000")
    ? undefined
    : `it embeds ${after.embedding.sources.join(", ")} instead of ${sources.join(", ")}`;
};

type ParsedType = {
  readonly base: string;
  readonly first: number | undefined;
  readonly second: number | undefined;
  readonly array: boolean;
};

const STRINGS = new Set([
  "text",
  "character varying",
  "varchar",
  "character",
  "char",
  "bpchar",
]);
const BITS = new Set(["bit", "bit varying", "varbit"]);
const INTEGER_DIGITS: ReadonlyMap<string, number> = new Map([
  ["smallint", 5],
  ["integer", 10],
  ["bigint", 19],
]);
const FLOATS = new Set(["real", "double precision", "float"]);
/** pgvector's types; `vector` and `halfvec` of one length cast into each other. */
const VECTORS = new Set(["vector", "halfvec"]);
const DECIMALS = new Set(["numeric", "decimal"]);
const TIMESTAMPS = new Set([
  "timestamp with time zone",
  "timestamp without time zone",
]);
const TIMES = new Set(["time with time zone", "time without time zone"]);

/**
 * The built-in types castless() knows, each with the types PostgreSQL casts
 * it into (pg_cast, in any context). A string type converts into and from
 * every type through its text form, and a type not listed here (an
 * extension's, a domain, a customType) is left to PostgreSQL. PostgreSQL 18
 * adds casts between the integer types and `bytea`; they are left out, so a
 * generated migration runs on every supported version (`using` gives them).
 */
const CASTS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (
    [
      [
        "smallint",
        ["integer", "bigint", "real", "double precision", "numeric"],
      ],
      [
        "integer",
        [
          "smallint",
          "bigint",
          "real",
          "double precision",
          "numeric",
          "money",
          "boolean",
          "bit",
        ],
      ],
      [
        "bigint",
        [
          "smallint",
          "integer",
          "real",
          "double precision",
          "numeric",
          "money",
          "bit",
        ],
      ],
      [
        "real",
        ["smallint", "integer", "bigint", "double precision", "numeric"],
      ],
      [
        "double precision",
        ["smallint", "integer", "bigint", "real", "numeric"],
      ],
      [
        "numeric",
        ["smallint", "integer", "bigint", "real", "double precision", "money"],
      ],
      ["money", ["numeric"]],
      ["boolean", ["integer"]],
      ["date", ["timestamp without time zone", "timestamp with time zone"]],
      ["time without time zone", ["time with time zone", "interval"]],
      ["time with time zone", ["time without time zone"]],
      [
        "timestamp without time zone",
        ["date", "time without time zone", "timestamp with time zone"],
      ],
      [
        "timestamp with time zone",
        [
          "date",
          "time without time zone",
          "time with time zone",
          "timestamp without time zone",
        ],
      ],
      ["interval", ["time without time zone"]],
      ["bytea", []],
      ["uuid", []],
      ["inet", ["cidr"]],
      ["cidr", ["inet"]],
      ["json", ["jsonb"]],
      [
        "jsonb",
        [
          "json",
          "boolean",
          "smallint",
          "integer",
          "bigint",
          "real",
          "double precision",
          "numeric",
        ],
      ],
      ["tsvector", []],
      ["xml", []],
      ["bit", ["bit varying", "integer", "bigint"]],
      ["bit varying", ["bit"]],
    ] as const
  ).map(([source, targets]) => [source, new Set<string>(targets)]),
);
/** Other spellings of the types above. */
const CAST_NAMES: ReadonlyMap<string, string> = new Map([
  ["varbit", "bit varying"],
  ["float", "double precision"],
]);

const parse = (sqlType: string): ParsedType => {
  const normalized = normalizeSqlType(sqlType);
  const element = normalized.replace(/(?:\[\])+$/, "");
  const match = /^(.*?)(?:\((\d+)(?:,(\d+))?\))?$/.exec(element)!;

  return {
    base: match[1]!.trim(),
    first: match[2] === undefined ? undefined : Number(match[2]),
    second: match[3] === undefined ? undefined : Number(match[3]),
    array: element !== normalized,
  };
};

/** Characters (or bits) a string-like type holds; Infinity when unbounded. */
const lengthLimit = (type: ParsedType): number =>
  type.first ??
  (["character", "char", "bit"].includes(type.base)
    ? 1
    : Number.POSITIVE_INFINITY);

/** Decimal places a number of this type can carry. */
const scaleOf = (type: ParsedType): number | undefined => {
  if (INTEGER_DIGITS.has(type.base)) {
    return 0;
  }

  if (FLOATS.has(type.base)) {
    return Number.POSITIVE_INFINITY;
  }

  if (DECIMALS.has(type.base)) {
    return type.first === undefined
      ? Number.POSITIVE_INFINITY
      : (type.second ?? 0);
  }

  return undefined;
};

/** Significant digits a type keeps exactly, for conversions into floating point. */
const exactDigits = (type: ParsedType): number => {
  if (INTEGER_DIGITS.has(type.base)) {
    return INTEGER_DIGITS.get(type.base)!;
  }

  if (DECIMALS.has(type.base)) {
    return type.first ?? Number.POSITIVE_INFINITY;
  }

  return type.base === "real" ? 6 : 15;
};

const fractionalDigits = (type: ParsedType): number => type.first ?? 6;

/** Digits before the decimal point a value of an integer or `numeric` type can have. */
const integerDigits = (type: ParsedType): number =>
  INTEGER_DIGITS.get(type.base) ??
  (type.first === undefined
    ? Number.POSITIVE_INFINITY
    : type.first - (type.second ?? 0));

/**
 * Digits before the decimal point every value with that many digits fits
 * into: 9 for `integer`, whose largest value has 10 digits but not every
 * 10-digit number fits.
 */
const fittingDigits = (type: ParsedType): number =>
  INTEGER_DIGITS.has(type.base)
    ? INTEGER_DIGITS.get(type.base)! - 1
    : integerDigits(type);

const lossy = (effect: string): TypeConversion => ({
  assignmentCast: false,
  lossy: true,
  effect,
});

/**
 * A type change that only makes room: more digits before the decimal point, a
 * longer `varchar`, `varchar` to `text`. PostgreSQL changes the column's
 * declaration without rewriting the table or the indexes and constraints on
 * it, so nothing that uses the column has to be dropped and built again.
 */
export const widens = (
  before: MigrationColumn,
  after: MigrationColumn,
): boolean => {
  if (
    before.enumeration ||
    after.enumeration ||
    before.collation !== after.collation
  ) {
    return false;
  }

  const source = parse(before.sqlType);
  const target = parse(after.sqlType);

  if (source.array || target.array) {
    return false;
  }

  if (DECIMALS.has(source.base) && DECIMALS.has(target.base)) {
    return (
      target.first === undefined ||
      (source.first !== undefined &&
        (source.second ?? 0) === (target.second ?? 0) &&
        target.first >= source.first)
    );
  }

  const VARYING = ["character varying", "varchar"];

  return (
    VARYING.includes(source.base) &&
    (target.base === "text" ||
      (VARYING.includes(target.base) &&
        lengthLimit(target) >= lengthLimit(source)))
  );
};

/**
 * A type change PostgreSQL has no cast for, so `USING "column"::type` fails
 * even on an empty table: between two built-in types without a cast
 * (`integer` to `date`, `boolean` to `numeric`, `integer` to `jsonb`), a
 * `uuid` from or to anything but text, and a value from or to an array of it
 * unless one side is text. Arrays convert element by element. A string type
 * converts into and from every type through its text form.
 */
export const castless = (
  before: MigrationColumn,
  after: MigrationColumn,
): boolean => {
  if (before.enumeration || after.enumeration) {
    return false;
  }

  const source = parse(before.sqlType);
  const target = parse(after.sqlType);
  const textual = (type: ParsedType) => !type.array && STRINGS.has(type.base);

  if (textual(source) || textual(target)) {
    return false;
  }

  if (source.array !== target.array) {
    return true;
  }

  if (
    source.base === target.base ||
    STRINGS.has(source.base) ||
    STRINGS.has(target.base)
  ) {
    return false;
  }

  if (source.base === "uuid" || target.base === "uuid") {
    return true;
  }

  const from = CAST_NAMES.get(source.base) ?? source.base;
  const to = CAST_NAMES.get(target.base) ?? target.base;
  const casts = CASTS.get(from);

  return casts !== undefined && CASTS.has(to) && from !== to && !casts.has(to);
};

/**
 * How a column type change treats existing values, or undefined for a change
 * the generic type-change caution covers.
 */
export const typeConversion = (
  before: MigrationColumn,
  after: MigrationColumn,
): TypeConversion | undefined => {
  if (after.enumeration) {
    return undefined;
  }

  const target = parse(after.sqlType);
  const source: ParsedType = before.enumeration
    ? { base: "enum", first: undefined, second: undefined, array: false }
    : parse(before.sqlType);

  if (source.array !== target.array) {
    return undefined;
  }

  // pgvector refuses a vector of another length, so every stored embedding
  // would fail the cast. A nullable column is emptied instead, and the model
  // of the new length computes the embeddings again.
  if (
    VECTORS.has(source.base) &&
    VECTORS.has(target.base) &&
    !source.array &&
    source.first !== undefined &&
    target.first !== undefined &&
    source.first !== target.first &&
    !after.notNull
  ) {
    return {
      ...lossy(
        `stored vectors of ${source.first} numbers cannot become vectors of ${target.first}, so the column is emptied`,
      ),
      cleared: true,
    };
  }

  if (STRINGS.has(target.base)) {
    const limit = lengthLimit(target);

    if (limit === Number.POSITIVE_INFINITY) {
      return undefined;
    }

    return {
      assignmentCast: true,
      ...(STRINGS.has(source.base) && lengthLimit(source) > limit
        ? {
            lossy: true,
            effect: `values longer than ${limit} characters make the migration fail, and trailing spaces past the limit are cut`,
          }
        : { lossy: false }),
    };
  }

  // A fixed bit(n) refuses any other length on assignment, so widening keeps
  // its explicit, zero-padding cast; only shortening must not cut.
  if (BITS.has(target.base) && BITS.has(source.base)) {
    const limit = lengthLimit(target);

    return lengthLimit(source) > limit
      ? {
          assignmentCast: true,
          lossy: true,
          effect: `values longer than ${limit} bits make the migration fail`,
        }
      : undefined;
  }

  if (INTEGER_DIGITS.has(source.base)) {
    // Any number but 0 reads as true, and the numbers cannot be told apart again.
    if (target.base === "boolean") {
      return lossy("every value other than 0 becomes true");
    }

    // A smaller integer type holds fewer values and PostgreSQL does not wrap
    // around, the way a shorter bit(n) refuses longer values.
    if (
      INTEGER_DIGITS.has(target.base) &&
      INTEGER_DIGITS.get(target.base)! < INTEGER_DIGITS.get(source.base)!
    ) {
      return {
        ...lossy(
          `values outside the ${target.base} range make the migration fail`,
        ),
        refused: true,
      };
    }
  }

  const targetScale = scaleOf(target);
  const sourceScale = scaleOf(source);

  if (targetScale !== undefined && sourceScale !== undefined) {
    if (FLOATS.has(target.base)) {
      const kept = exactDigits(target);

      return exactDigits(source) > kept
        ? lossy(`values keep only about ${kept} significant digits`)
        : undefined;
    }

    const rounding =
      sourceScale > targetScale
        ? targetScale === 0
          ? "values are rounded to whole numbers"
          : `values are rounded to ${targetScale} decimal places`
        : undefined;
    // numeric(20, 0) holds whole numbers no integer type can, and
    // numeric(10, 2) ones numeric(8, 2) cannot: PostgreSQL refuses them.
    const fitting = fittingDigits(target);
    const range =
      !FLOATS.has(source.base) && integerDigits(source) > fitting
        ? INTEGER_DIGITS.has(target.base)
          ? `values outside the ${target.base} range make the migration fail`
          : `values with more than ${fitting} digits before the decimal point make the migration fail`
        : undefined;

    if (rounding === undefined) {
      return range === undefined
        ? undefined
        : { ...lossy(range), refused: true };
    }

    return lossy(range === undefined ? rounding : `${rounding}, and ${range}`);
  }

  if (
    (TIMESTAMPS.has(target.base) && TIMESTAMPS.has(source.base)) ||
    (TIMES.has(target.base) && TIMES.has(source.base)) ||
    (target.base === "interval" && source.base === "interval")
  ) {
    const kept = fractionalDigits(target);

    return fractionalDigits(source) > kept
      ? lossy(`fractional seconds are rounded to ${kept} digits`)
      : undefined;
  }

  if (TIMESTAMPS.has(source.base)) {
    if (target.base === "date") {
      return lossy("the time of day is dropped");
    }

    if (TIMES.has(target.base)) {
      return lossy("the date is dropped");
    }
  }

  // PostgreSQL's cast keeps what is left after whole days of hours:
  // `1 day 02:00:00` and `26:00:00` both become `02:00:00`. An interval
  // declared with fields (`interval hour to minute`) loses the same.
  if (
    (source.base === "interval" || source.base.startsWith("interval ")) &&
    TIMES.has(target.base)
  ) {
    return lossy(
      "months and days are dropped, and so are whole days of hours (26:00:00 becomes 02:00:00)",
    );
  }

  return undefined;
};

/**
 * `vector(n)` to `halfvec(n)`: every number is rounded to half precision, the
 * point of the change (half the storage, distances barely move), and one
 * beyond ±65504 fails the cast. A caution rather than a destructive change.
 */
export const halfPrecision = (
  before: MigrationColumn,
  after: MigrationColumn,
): boolean => {
  if (before.enumeration || after.enumeration) {
    return false;
  }

  const source = parse(before.sqlType);
  const target = parse(after.sqlType);

  return (
    source.base === "vector" &&
    target.base === "halfvec" &&
    source.array === target.array &&
    source.first === target.first
  );
};

/**
 * A type change whose cast goes through the time zone of the session that
 * runs the migration: `timestamp` or `date` to `timestamptz` (read as local
 * time), `timestamptz` to `timestamp`, `date` or `time` (the local date and
 * time), a value to `timetz` (the session's offset), and a string to or from
 * `timestamptz` or `timetz`. The stored values would depend on who migrates;
 * Symmetria reads and writes `timestamp` as UTC, and the generated SQL
 * converts at UTC: through `AT TIME ZONE 'UTC'` where a value allows it (a
 * function of the quoted column and the target type), and otherwise
 * (`"session"`: an array, which has no such operator, a `timetz` target, a
 * string, also one that holds an array as text) with the session's zone set
 * to UTC around the statement.
 */
export const utcConversion = (
  before: MigrationColumn,
  after: MigrationColumn,
): ((column: string, type: string) => string) | "session" | undefined => {
  if (before.enumeration || after.enumeration) {
    return undefined;
  }

  const source = parse(before.sqlType);
  const target = parse(after.sqlType);
  const TIMESTAMPTZ = "timestamp with time zone";
  const TIMETZ = "time with time zone";

  // One string holds a whole array as text (`{"2024-03-10 23:30:00+00"}`):
  // PostgreSQL reads and writes each element as it does a single value.
  if (source.array !== target.array) {
    const text = (type: ParsedType) => !type.array && STRINGS.has(type.base);

    return (text(source) &&
      (target.base === TIMESTAMPTZ || target.base === TIMETZ)) ||
      (source.base === TIMESTAMPTZ && text(target))
      ? "session"
      : undefined;
  }

  if (source.base === target.base) {
    return undefined;
  }

  const pair = (from: string, to: string) =>
    source.base === from && target.base === to;
  const value = (
    conversion: (column: string, type: string) => string,
  ): ((column: string, type: string) => string) | "session" =>
    source.array ? "session" : conversion;

  if (
    pair("timestamp without time zone", TIMESTAMPTZ) ||
    pair(TIMESTAMPTZ, "timestamp without time zone")
  ) {
    return value((column) => `${column} AT TIME ZONE 'UTC'`);
  }

  if (pair("date", TIMESTAMPTZ)) {
    return value((column) => `${column}::timestamp AT TIME ZONE 'UTC'`);
  }

  if (
    pair(TIMESTAMPTZ, "date") ||
    pair(TIMESTAMPTZ, "time without time zone")
  ) {
    return value((column, type) => `(${column} AT TIME ZONE 'UTC')::${type}`);
  }

  return pair(TIMESTAMPTZ, TIMETZ) ||
    pair("time without time zone", TIMETZ) ||
    (STRINGS.has(source.base) &&
      (target.base === TIMESTAMPTZ || target.base === TIMETZ)) ||
    (source.base === TIMESTAMPTZ && STRINGS.has(target.base))
    ? "session"
    : undefined;
};

/** The lint sentence for a lossy conversion, naming both types. */
export const conversionMessage = (
  before: MigrationColumn,
  after: MigrationColumn,
  conversion: TypeConversion,
): string =>
  `Column "${after.name}" ${conversion.cleared ? "changes" : "narrows"} from ${before.enumeration ?? before.sqlType} to ${after.enumeration ?? after.sqlType}: ${conversion.effect}.`;
