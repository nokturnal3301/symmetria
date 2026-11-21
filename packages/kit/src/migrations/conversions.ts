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
  renamed: Readonly<Record<string, string>> = {},
): string | undefined => {
  if (!before.embedding || !after.embedding) {
    return undefined;
  }

  if (before.embedding.model !== after.embedding.model) {
    return `the model changes from ${before.embedding.model} to ${after.embedding.model}`;
  }

  const sources = before.embedding.sources.map((name) => renamed[name] ?? name);

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
const INTEGER_DIGITS: Record<string, number> = {
  smallint: 5,
  integer: 10,
  bigint: 19,
};
const FLOATS = new Set(["real", "double precision", "float"]);
/** pgvector's types; `vector` and `halfvec` of one length cast into each other. */
const VECTORS = new Set(["vector", "halfvec"]);
const DECIMALS = new Set(["numeric", "decimal"]);
const TIMESTAMPS = new Set([
  "timestamp with time zone",
  "timestamp without time zone",
]);
const TIMES = new Set(["time with time zone", "time without time zone"]);

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
  if (type.base in INTEGER_DIGITS) {
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
  if (type.base in INTEGER_DIGITS) {
    return INTEGER_DIGITS[type.base]!;
  }

  if (DECIMALS.has(type.base)) {
    return type.first ?? Number.POSITIVE_INFINITY;
  }

  return type.base === "real" ? 6 : 15;
};

const fractionalDigits = (type: ParsedType): number => type.first ?? 6;

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
 * even on an empty table: a `uuid` from or to anything but text, and a value
 * from or to an array of it unless one side is text.
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

  return (
    source.array !== target.array ||
    (source.base !== target.base &&
      (source.base === "uuid" || target.base === "uuid"))
  );
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

  if (source.base in INTEGER_DIGITS) {
    // Any number but 0 reads as true, and the numbers cannot be told apart again.
    if (target.base === "boolean") {
      return lossy("every value other than 0 becomes true");
    }

    // A smaller integer type holds fewer values and PostgreSQL does not wrap
    // around, the way a shorter bit(n) refuses longer values.
    if (INTEGER_DIGITS[target.base]! < INTEGER_DIGITS[source.base]!) {
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

    return sourceScale > targetScale
      ? lossy(
          targetScale === 0
            ? "values are rounded to whole numbers"
            : `values are rounded to ${targetScale} decimal places`,
        )
      : undefined;
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

  return undefined;
};

/**
 * A change between `timestamptz` and `timestamp`, for a value or for an
 * array of them. A plain cast converts through the time zone of the session
 * that runs the migration, so the stored values would depend on who
 * migrates; Symmetria reads and writes `timestamp` as UTC, and the generated
 * SQL converts at UTC: `AT TIME ZONE 'UTC'` for a value, and for an array,
 * which has no such operator, the cast with the session's zone set to UTC.
 */
export const utcConversion = (
  before: MigrationColumn,
  after: MigrationColumn,
): "value" | "array" | undefined => {
  if (before.enumeration || after.enumeration) {
    return undefined;
  }

  const source = parse(before.sqlType);
  const target = parse(after.sqlType);

  return source.array === target.array &&
    TIMESTAMPS.has(source.base) &&
    TIMESTAMPS.has(target.base) &&
    source.base !== target.base
    ? source.array
      ? "array"
      : "value"
    : undefined;
};

/** The lint sentence for a lossy conversion, naming both types. */
export const conversionMessage = (
  before: MigrationColumn,
  after: MigrationColumn,
  conversion: TypeConversion,
): string =>
  `Column "${after.name}" ${conversion.cleared ? "changes" : "narrows"} from ${before.enumeration ?? before.sqlType} to ${after.enumeration ?? after.sqlType}: ${conversion.effect}.`;
