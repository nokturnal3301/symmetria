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

/** The lint sentence for a lossy conversion, naming both types. */
export const conversionMessage = (
  before: MigrationColumn,
  after: MigrationColumn,
  conversion: TypeConversion,
): string =>
  `Column "${after.name}" narrows from ${before.enumeration ?? before.sqlType} to ${after.enumeration ?? after.sqlType}: ${conversion.effect}.`;
