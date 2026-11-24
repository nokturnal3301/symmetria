/**
 * Rewrites an expression tree into the form PostgreSQL's printing and the
 * schema DSL's rendering share, keeping its meaning.
 */
import { normalizeSqlType } from "./drift";
import type { SqlExpression } from "./expression-tree";

export const NUMERIC_TYPES =
  /^(integer|bigint|smallint|numeric|real|double precision)(\(|$)/;
/**
 * Types whose cast to text PostgreSQL adds on its own and that compare the
 * same either way; not `char(n)`, which trims, or `citext`, which ignores case.
 */
export const TEXT_TYPES = /^(text|character varying)(\(|$)/;
/** The text types without a length: a cast to one never truncates. */
export const UNBOUNDED_TEXT = /^(text|character varying)$/;
export const NEGATED_COMPARISON: Readonly<Record<string, string>> = {
  "=": "<>",
  "<>": "=",
  "<": ">=",
  ">=": "<",
  ">": "<=",
  "<=": ">",
};
export const FLIPPED_COMPARISON: Readonly<Record<string, string>> = {
  "=": "=",
  "<>": "<>",
  "<": ">",
  ">": "<",
  "<=": ">=",
  ">=": "<=",
};
export const LIKE_OPERATORS: Readonly<
  Record<string, { operator: "LIKE" | "ILIKE"; negated: boolean }>
> = {
  "~~": { operator: "LIKE", negated: false },
  "~~*": { operator: "ILIKE", negated: false },
  "!~~": { operator: "LIKE", negated: true },
  "!~~*": { operator: "ILIKE", negated: true },
};

/** `0042` and `42` are one integer; other numbers keep their digits. */
export const canonicalNumber = (text: string): string => {
  const value = text.replace(/^\+/, "");

  return /^-?\d+$/.test(value) ? BigInt(value).toString() : value.toLowerCase();
};

/** Float types, whose zero has a sign: `-0::float8` is -0, `(-0)::float8` is 0. */
const FLOAT_TYPES = /^(?:real|double precision|float[48]?(?:\(\d+\))?)$/;
const ZERO = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i;
/** The magnitude of each integer type's most negative value, which its positive side lacks. */
const INTEGER_LIMITS: ReadonlyMap<string, bigint> = new Map([
  ["smallint", 32768n],
  ["integer", 2147483648n],
  ["bigint", 9223372036854775808n],
]);

/** A number of a type in one spelling: a zero has no sign, except a float's. */
const typedNumber = (text: string, type: string | undefined): string => {
  if (!ZERO.test(text)) {
    return canonicalNumber(text);
  }

  const zero = canonicalNumber(text.replace(/^[+-]/, ""));

  return text.startsWith("-") && type !== undefined && FLOAT_TYPES.test(type)
    ? `-${zero}`
    : zero;
};

const INTERVAL_UNITS: Readonly<
  Record<string, [months: number, micros: number]>
> = {
  year: [12, 0],
  month: [1, 0],
  mon: [1, 0],
  week: [0, 7 * 86_400e6],
  day: [0, 86_400e6],
  hour: [0, 3_600e6],
  minute: [0, 60e6],
  min: [0, 60e6],
  second: [0, 1e6],
  sec: [0, 1e6],
};

/**
 * An interval as months and microseconds: `90 minutes` and `01:30:00` are
 * one interval. Days count as 24 hours here, which only matters across a
 * daylight-saving change, never for comparing two spellings of a default.
 */
export const intervalKey = (text: string): string | undefined => {
  let months = 0;
  let micros = 0;
  let rest = text.trim().toLowerCase();
  const time = /(-?)(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*$/.exec(rest);

  if (time) {
    const sign = time[1] ? -1 : 1;

    micros +=
      sign *
      (Number(time[2]) * 3_600e6 +
        Number(time[3]) * 60e6 +
        Number(time[4] ?? 0) * 1e6);
    rest = rest.slice(0, time.index).trim();
  }

  for (const part of rest.matchAll(/(-?\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const name = part[2]!.replace(/s$/, "");
    const unit = Object.hasOwn(INTERVAL_UNITS, name)
      ? INTERVAL_UNITS[name]
      : undefined;

    if (!unit) {
      return undefined;
    }

    months += Number(part[1]) * unit[0];
    micros += Number(part[1]) * unit[1];
  }

  return rest.replace(/(-?\d+(?:\.\d+)?)\s*([a-z]+)/g, "").trim()
    ? undefined
    : `${months} ${Math.round(micros)}`;
};

/** Interval units as PostgreSQL reads them (`m` is a minute, `mon` a month). */
const INTERVAL_FIELDS: ReadonlyMap<string, string> = new Map(
  (
    [
      ["year", ["year", "years", "y", "yr", "yrs"]],
      ["month", ["month", "months", "mon", "mons"]],
      ["week", ["week", "weeks", "w"]],
      ["day", ["day", "days", "d"]],
      ["hour", ["hour", "hours", "h", "hr", "hrs"]],
      ["minute", ["minute", "minutes", "m", "min", "mins"]],
      ["second", ["second", "seconds", "s", "sec", "secs"]],
      ["millisecond", ["millisecond", "milliseconds", "ms", "msec", "msecs"]],
      ["microsecond", ["microsecond", "microseconds", "us", "usec", "usecs"]],
    ] as const
  ).flatMap(([field, spellings]) =>
    spellings.map((spelling) => [spelling, field] as const),
  ),
);
const TIME_MICROS: ReadonlyMap<string, number> = new Map([
  ["hour", 3_600e6],
  ["minute", 60e6],
  ["second", 1e6],
  ["millisecond", 1e3],
  ["microsecond", 1],
]);

/**
 * An interval literal as PostgreSQL keeps it: months, days and time apart,
 * since a day is not always 24 hours and a month not always 30 days. So
 * `'24 hours'`, `'1440 minutes'` and `'24:00:00'` are one value and `'1 day'`
 * another, as are `'1 mon'` and `'30 days'`; `'1.5 days'` is `1 day 12:00:00`.
 * Undefined for a spelling it does not read (it then compares as written).
 */
const intervalParts = (text: string): string | undefined => {
  let rest = text.trim().toLowerCase().replace(/^@\s*/, "");
  const ago = /\s+ago$/.test(rest);
  let months = 0;
  let days = 0;
  let micros = 0;

  rest = rest.replace(/\s+ago$/, "");

  while (rest) {
    const time =
      /^([+-]?)(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?(?:\s+|$)/.exec(rest);

    if (time) {
      micros +=
        (time[1] === "-" ? -1 : 1) *
        (Number(time[2]) * 3_600e6 +
          Number(time[3]) * 60e6 +
          Number(time[4] ?? 0) * 1e6);
      rest = rest.slice(time[0].length);
      continue;
    }

    const field = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-z]*)(?:\s+|$)/.exec(
      rest,
    );
    const unit = field && (field[2] ? INTERVAL_FIELDS.get(field[2]) : "second");

    if (!field || !unit) {
      return undefined;
    }

    const value = Number(field[1]);
    const whole = Math.trunc(value);
    const fraction = value - whole;

    // Fractions carry down as PostgreSQL carries them: a year's into
    // months, a month's (30 days) and a week's into days, a day's into time.
    if (unit === "year") {
      if (!Number.isInteger(fraction * 12)) {
        return undefined;
      }

      months += whole * 12 + fraction * 12;
    } else if (unit === "month" || unit === "week") {
      const spread = fraction * (unit === "month" ? 30 : 7);

      months += unit === "month" ? whole : 0;
      days += (unit === "week" ? whole * 7 : 0) + Math.trunc(spread);
      micros += (spread - Math.trunc(spread)) * 86_400e6;
    } else if (unit === "day") {
      days += whole;
      micros += fraction * 86_400e6;
    } else {
      micros += value * TIME_MICROS.get(unit)!;
    }

    rest = rest.slice(field[0].length);
  }

  const sign = ago ? -1 : 1;

  return `${sign * months} ${sign * days} ${sign * Math.round(micros)}`;
};

/**
 * A literal of a date or time, uuid or inet type in the form PostgreSQL
 * prints it back, for comparing two spellings: `'23:00'::time` is stored as
 * `'23:00:00'`, `'24 hours'::interval` as `'24:00:00'` (both compared as
 * months, days and time), an upper-case uuid in lower case and
 * `'10.0.0.1/32'::inet` as `'10.0.0.1'`. Other text stays. A comparison key
 * only: pull writes what PostgreSQL stored.
 */
export const canonicalLiteral = (value: string, type: string): string => {
  const base = type.replace(/\(\d+\)/, "");
  const text = value.trim();

  if (base === "time without time zone" || base === "time with time zone") {
    const time =
      /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?(?:([+-])(\d{1,2})(?::?(\d{2}))?|\s*(z|utc|gmt))?$/i.exec(
        text,
      );

    if (!time) {
      return value;
    }

    const fraction = time[4]?.replace(/0+$/, "");
    // A plain time ignores a zone written after it; UTC is +00.
    const offset =
      base === "time without time zone"
        ? ""
        : time[8]
          ? "+00"
          : time[5]
            ? `${time[5]}${time[6]!.padStart(2, "0")}${time[7] && time[7] !== "00" ? `:${time[7]}` : ""}`
            : "";

    return `${time[1]!.padStart(2, "0")}:${time[2]!.padStart(2, "0")}:${(time[3] ?? "00").padStart(2, "0")}${fraction ? `.${fraction}` : ""}${offset}`;
  }

  if (base === "interval") {
    return intervalParts(text) ?? value;
  }

  if (base === "uuid") {
    const hex = text
      .replace(/^\{|\}$/g, "")
      .replaceAll("-", "")
      .toLowerCase();

    return /^[0-9a-f]{32}$/.test(hex)
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      : value;
  }

  if (base === "inet") {
    const lower = text.toLowerCase();
    // Octets with leading zeros are the same numbers: 10.0.0.01 is 10.0.0.1.
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/.exec(
      lower,
    );
    const address = v4
      ? `${v4.slice(1, 5).map(Number).join(".")}${v4[5] ?? ""}`
      : lower;

    return /^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(address) ||
      (address.includes(":") && address.endsWith("/128"))
      ? address.replace(/\/\d+$/, "")
      : address;
  }

  return value;
};

export const INTEGER_TYPES = /^(integer|bigint|smallint)$/;
export const LENGTH_TYPES = /^(?:character varying|character|char)\((\d+)\)$/;
export const SCALE_TYPES = /^numeric\(\d+(?:,(\d+))?\)$/;
const PRECISION_TYPES = /^numeric\((\d+)(?:,(\d+))?\)$/;
/** Exponents beyond any integer or numeric(p,s) type's digits: such a cast fails. */
const EXPONENT_LIMIT = 2000;

/**
 * A number's digits before and after the point, exponent applied, without
 * leading or trailing zeros: `2.5e0` is 2 and 5, `1.5e1` is 15 and nothing.
 * Undefined for text that is no number, or an exponent past any type's digits.
 */
const decimalDigits = (
  text: string,
): { negative: boolean; whole: string; fraction: string } | undefined => {
  const number = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?\s*$/i.exec(text);

  if (!number || (!number[2] && !number[3])) {
    return undefined;
  }

  const exponent = Number(number[4] ?? 0);

  if (Math.abs(exponent) > EXPONENT_LIMIT) {
    return undefined;
  }

  const point = number[2]!.length + exponent;
  const digits = `${number[2]}${number[3] ?? ""}`;
  const padded =
    point < 0 ? `${"0".repeat(-point)}${digits}` : digits.padEnd(point, "0");
  const at = Math.max(point, 0);

  return {
    negative: number[1] === "-",
    whole: padded.slice(0, at).replace(/^0+/, ""),
    fraction: padded.slice(at).replace(/0+$/, ""),
  };
};

/**
 * Whether a cast gives a literal another value, so it is no rendering detail:
 * `'abc'::varchar(2)` is `'ab'`, `1.9::integer` and `2.5e0::integer` round,
 * `1.25::numeric(3,1)` is `1.3`, and a number out of an integer type's range
 * (`32768::smallint`) or a numeric(p,s)'s digits fails. The casts PostgreSQL
 * prints on its own (`'a'::text`, `'-100'::integer`) never do.
 */
export const castChangesLiteral = (
  literal: Extract<SqlExpression, { kind: "constant" }>,
  type: string,
): boolean => {
  const length = LENGTH_TYPES.exec(type);

  if (length) {
    return [...literal.value].length > Number(length[1]);
  }

  const integer = INTEGER_TYPES.test(type);
  const precision = PRECISION_TYPES.exec(type);

  if (!integer && !precision) {
    return false;
  }

  const digits = decimalDigits(literal.value);

  if (!digits) {
    // A number with an exponent past any type's digits; other text is read by the type.
    return /^\s*[+-]?(?:\d+\.?\d*|\.\d+)e/i.test(literal.value);
  }

  if (integer) {
    const limit = INTEGER_LIMITS.get(type)!;
    const magnitude = BigInt(digits.whole || "0");

    return (
      digits.fraction !== "" ||
      (digits.negative ? magnitude > limit : magnitude >= limit)
    );
  }

  const scale = Number(precision![2] ?? 0);

  return (
    digits.fraction.length > scale ||
    digits.whole.length > Number(precision![1]) - scale
  );
};

/** The significant digits a float keeps of a decimal: more, and it holds another number. */
const FLOAT_DIGITS = (type: string): number => (type === "real" ? 6 : 15);

/**
 * Whether a cast of a float literal shows that the float is not the decimal
 * written: a float rounds half to even where a decimal rounds half away from
 * zero (`2.5::float8::integer` is 2, `2.5::integer` 3), a real holds another
 * double than the decimal (`0.1::real::float8`), and a decimal of more digits
 * than the float keeps comes back rounded.
 */
const floatCastShows = (
  literal: Extract<SqlExpression, { kind: "constant" }>,
  type: string,
): boolean => {
  const from = literal.type;

  if (!literal.numeric || from === undefined || !FLOAT_TYPES.test(from)) {
    return false;
  }

  if (type === from) {
    return false;
  }

  if (from === "real" && FLOAT_TYPES.test(type)) {
    return true;
  }

  if (
    !INTEGER_TYPES.test(type) &&
    !/^numeric(?:\(|$)/.test(type) &&
    !FLOAT_TYPES.test(type)
  ) {
    return false;
  }

  const digits = decimalDigits(literal.value);

  return (
    !digits ||
    `${digits.whole}${digits.fraction}`.replace(/^0+/, "").length >
      FLOAT_DIGITS(from) ||
    (INTEGER_TYPES.test(type) && digits.fraction !== "")
  );
};

/** Rounds a magnitude half to even, as PostgreSQL rounds a float to an integer. */
const roundHalfEven = (value: number): number => {
  const rounded = Math.round(value);

  return rounded - value === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
};

/** Rounds a magnitude's digits half away from zero to `scale` decimals, as PostgreSQL rounds a numeric. */
const roundDigits = (
  whole: bigint,
  fraction: string,
  scale: number,
): { whole: bigint; fraction: string } => {
  if (fraction.length <= scale) {
    return { whole, fraction };
  }

  const unit = 10n ** BigInt(scale);
  const kept =
    whole * unit +
    BigInt(fraction.slice(0, scale) || "0") +
    (fraction[scale]! >= "5" ? 1n : 0n);

  return {
    whole: kept / unit,
    fraction: (kept % unit).toString().padStart(scale, "0").replace(/0+$/, ""),
  };
};

/** Whether a double lies exactly halfway between two reals (single-precision floats). */
const halfwayReal = (value: number): boolean => {
  const real = Math.fround(value);
  const other = 2 * value - real;

  return real !== value && Math.fround(other) === other;
};

/** A float's text: the fewest digits that read back as it, as PostgreSQL writes it. */
const shortestFloat = (float: { value: number; type: string }): string => {
  if (float.type !== "real") {
    return String(float.value);
  }

  for (let digits = 1; digits < 9; digits++) {
    const text = float.value.toPrecision(digits);

    if (Math.fround(Number(text)) === float.value) {
      return text;
    }
  }

  return float.value.toPrecision(9);
};

/**
 * Whether a minus before a number cast through `types` (inside out) gives the
 * value the casts give the negated number: `-0.5::integer`, which PostgreSQL
 * reads as `-(0.5::integer)`, is `(-0.5)::integer`, and `-0.25::real::float8`
 * is `(-0.25)::real::float8`. A cast to an integer, a numeric, a numeric(p,s)
 * or a float rounds the same on either side of zero, so it holds for those
 * casts, except where the positive number reaches an integer type's most
 * negative value on the way, which only the negated one holds
 * (`-32767.5::smallint` and `-2147483647::real::integer` fail, the negated
 * casts are -32768 and -2147483648), and where a float comes out zero, whose
 * sign the minus keeps only outside the casts (`-1e-7::integer::float8` is -0,
 * `(-1e-7)::integer::float8` is 0). The casts are followed as PostgreSQL makes
 * them; where a float's rounding, computed here in double precision, lands
 * next to one of those edges, it says no. `types` are normalized type names.
 */
export const minusCommutes = (
  digits: string,
  written: readonly string[],
): boolean => {
  const start = decimalDigits(digits);
  // `float` is double precision; `float(p)` is real up to 24 binary digits.
  const types = written.map((type) => {
    const float = /^float(?:\((\d+)\))?$/.exec(type);

    return !float
      ? type
      : Number(float[1] ?? 53) <= 24
        ? "real"
        : "double precision";
  });

  if (!start || start.negative || types.length === 0) {
    return false;
  }

  let whole = BigInt(start.whole || "0");
  let fraction = start.fraction;
  /**
   * The magnitude while it is a float, which float, and whether it may be a
   * unit off: a decimal made a real here is rounded twice (to a double, then
   * to a real), where PostgreSQL rounds once. The two differ only where the
   * double lies halfway between two reals, and an integer up to 2^53 is its
   * double.
   */
  let float: { value: number; type: string; near: boolean } | undefined;
  /** Whether the magnitude is zero; a zero stays zero through every cast. */
  let zero: boolean | "unsure" = whole === 0n && fraction === "";
  const settle = (isZero: boolean, unsure: boolean): boolean | "unsure" =>
    zero === true || isZero
      ? true
      : zero === "unsure" || unsure
        ? "unsure"
        : false;

  for (const [index, type] of types.entries()) {
    if (type === "real" || type === "double precision") {
      const exact = float?.value ?? Number(`${whole}.${fraction || "0"}`);
      const value = type === "real" ? Math.fround(exact) : exact;

      // Out of the float's range, both spellings fail.
      if (!Number.isFinite(value) || (value === 0 && zero === false)) {
        return false;
      }

      float = {
        value,
        type,
        near: float
          ? float.near
          : type === "real" &&
            !(fraction === "" && whole <= 2n ** 53n) &&
            halfwayReal(exact),
      };
      continue;
    }

    // A number written as text and read back keeps its value. A float is
    // written in the fewest digits that read back as it, not those of its
    // cast to numeric.
    if (type === "text" && index < types.length - 1) {
      if (float) {
        const printed = !float.near && decimalDigits(shortestFloat(float));

        if (!printed) {
          return false;
        }

        whole = BigInt(printed.whole || "0");
        fraction = printed.fraction;
        float = undefined;
      }

      continue;
    }

    const limit = INTEGER_LIMITS.get(type);
    const precision = PRECISION_TYPES.exec(type);

    if (limit === undefined && type !== "numeric" && !precision) {
      return false;
    }

    if (float && limit !== undefined) {
      const edge = Number(limit);
      const rounded = roundHalfEven(float.value);
      // Where the float may be a unit off, close to the edge is not known.
      const close = (to: number, scale: number) =>
        float!.near && Math.abs(float!.value - to) <= scale * 2 ** -20;

      if (close(edge - 0.5, edge) || rounded >= edge) {
        return false;
      }

      zero = settle(rounded === 0, close(0.5, 1));
      whole = BigInt(rounded);
      fraction = "";
      float = undefined;
      continue;
    }

    if (float) {
      // A float becomes a numeric through its first 6 (real) or 15 digits.
      const printed = decimalDigits(
        float.value.toPrecision(FLOAT_DIGITS(float.type)),
      );

      if (!printed) {
        return false;
      }

      whole = BigInt(printed.whole || "0");
      fraction = printed.fraction;
      float = undefined;
    }

    const scale =
      limit !== undefined
        ? 0
        : precision
          ? Number(precision[2] ?? 0)
          : undefined;

    if (scale !== undefined) {
      ({ whole, fraction } = roundDigits(whole, fraction, scale));
    }

    if (limit !== undefined && whole >= limit) {
      return false;
    }

    zero = settle(whole === 0n && fraction === "", false);
  }

  return !FLOAT_TYPES.test(types[types.length - 1]!) || zero === false;
};

/**
 * The number under a chain of casts (`0.5` in `0.5::real::float8`) with the
 * casts' types from the inside out, or undefined for anything else.
 */
const castNumber = (
  node: SqlExpression,
): { digits: string; types: string[] } | undefined => {
  const types: string[] = [];
  let current = node;

  while (current.kind === "cast") {
    types.unshift(current.type);
    current = current.value;
  }

  return current.kind === "constant" && current.numeric
    ? { digits: current.value, types }
    : undefined;
};

/** The type PostgreSQL names in a literal's cast: `numeric`, not `numeric(10,2)`. */
const castType = (sqlType: string): string =>
  sqlType.startsWith("numeric(") ? "numeric" : sqlType;

export const isLiteral = (node: SqlExpression): boolean =>
  node.kind === "constant" || node.kind === "boolean" || node.kind === "null";

/**
 * Rewrites an expression into the form both renderings share, keeping its
 * meaning: casts that leave a literal's value alone and PostgreSQL's implicit
 * casts of text columns (`(nick)::text` for a varchar) go, `IN` replaces
 * `= ANY (ARRAY[…])`, `LIKE` replaces `~~`, `BETWEEN` becomes its two
 * comparisons, a literal moves to the right of a comparison, `x = true`
 * becomes `x`, `NOT` folds into the test it negates and nested AND/OR flatten.
 * `columns` maps column names to SQL types.
 */
export const simplifyExpression = (
  node: SqlExpression,
  columns: ReadonlyMap<string, string> = new Map(),
): SqlExpression => {
  const simplify = (current: SqlExpression): SqlExpression =>
    simplifyExpression(current, columns);

  /**
   * A quoted literal compared with a column (`=`, `<`, an `IN` list) takes
   * the column's type, as PostgreSQL resolves it and prints it back:
   * `num > E'0'` is stored as `num > '0'::numeric`, `iv IN (E'1 day')` as
   * `iv = ANY (ARRAY['1 day'::interval])`. Text columns compare as text,
   * which PostgreSQL prints with casts of its own, and are left as they are.
   */
  const typedLiteral = (
    column: SqlExpression,
    literal: SqlExpression,
  ): SqlExpression => {
    if (
      column.kind !== "column" ||
      literal.kind !== "constant" ||
      literal.numeric ||
      literal.type !== undefined
    ) {
      return literal;
    }

    const type = columns.get(column.name);
    const own = type === undefined ? undefined : normalizeSqlType(type);

    return own !== undefined &&
      !TEXT_TYPES.test(own) &&
      !LENGTH_TYPES.test(own) &&
      !own.endsWith("[]")
      ? simplify({ kind: "cast", value: literal, type: castType(own) })
      : literal;
  };

  switch (node.kind) {
    case "constant":
      return node.numeric
        ? { ...node, value: canonicalNumber(node.value) }
        : node;
    case "boolean":
    case "null":
    case "column":
      return node;
    case "cast": {
      const value = simplify(node.value);

      if (value.kind === "constant") {
        if (floatCastShows(value, node.type)) {
          const { type, ...digits } = value;

          return {
            ...node,
            value: { kind: "cast", value: digits, type: type! },
          };
        }

        if (castChangesLiteral(value, node.type)) {
          // A number in quotes is that number to a numeric(p,s) cast, as
          // PostgreSQL prints one it keeps quoted (`'2147483649'::numeric(3,0)`).
          return !value.numeric &&
            value.type === undefined &&
            PRECISION_TYPES.test(node.type) &&
            /^[+-]?[\d.]/.test(value.value) &&
            decimalDigits(value.value) !== undefined
            ? {
                ...node,
                value: {
                  kind: "constant",
                  value: canonicalNumber(value.value),
                  numeric: true,
                },
              }
            : { ...node, value };
        }

        return NUMERIC_TYPES.test(node.type) && /^[+-]?[\d.]/.test(value.value)
          ? {
              kind: "constant",
              value: typedNumber(value.value, node.type),
              numeric: true,
              type: node.type,
            }
          : { ...value, type: node.type };
      }

      if (value.kind === "null") {
        return value;
      }

      if (value.kind === "array" && value.values.every(isLiteral)) {
        return value;
      }

      // A second cast to the same type changes nothing; PostgreSQL drops it.
      if (value.kind === "cast" && value.type === node.type) {
        return value;
      }

      // PostgreSQL compares a length-limited string as text and prints that
      // cast: `('abc'::character varying(2))::text`.
      if (
        value.kind === "cast" &&
        UNBOUNDED_TEXT.test(node.type) &&
        LENGTH_TYPES.test(value.type) &&
        (value.value.kind === "constant" ||
          value.type.startsWith("character varying"))
      ) {
        return value;
      }

      if (value.kind === "column") {
        const type = columns.get(value.name);
        const own = type === undefined ? undefined : normalizeSqlType(type);

        if (
          own !== undefined &&
          (own === node.type ||
            (TEXT_TYPES.test(own) && UNBOUNDED_TEXT.test(node.type)))
        ) {
          return value;
        }
      }

      return { ...node, value };
    }
    case "unary": {
      const value = simplify(node.value);

      // A number cast to text stays text: `-5::text` negates text, which fails.
      if (
        value.kind === "constant" &&
        value.numeric &&
        (value.type === undefined ||
          NUMERIC_TYPES.test(value.type) ||
          FLOAT_TYPES.test(value.type))
      ) {
        if (node.operator === "+") {
          return value;
        }

        // `-2147483648::integer` fails where `(-2147483648)::integer` does not.
        const limit =
          value.type === undefined ? undefined : INTEGER_LIMITS.get(value.type);
        const magnitude = decimalDigits(value.value);

        if (
          node.operator === "-" &&
          limit !== undefined &&
          !value.value.startsWith("-") &&
          !(
            magnitude?.fraction === "" && BigInt(magnitude.whole || "0") < limit
          )
        ) {
          return { ...node, value };
        }

        if (node.operator === "-") {
          return {
            ...value,
            value: value.value.startsWith("-")
              ? value.value.slice(1)
              : typedNumber(`-${value.value}`, value.type),
          };
        }
      }

      // A cast that gives the number another value stays a cast:
      // `-0.5::integer` is `(-0.5)::integer` where minusCommutes says so.
      const chain =
        node.operator === "-" && value.kind === "cast"
          ? castNumber(node.value)
          : undefined;

      if (chain && minusCommutes(chain.digits, chain.types)) {
        return simplify(
          chain.types.reduce<SqlExpression>(
            (inner, type) => ({ kind: "cast", value: inner, type }),
            {
              kind: "unary",
              operator: "-",
              value: { kind: "constant", value: chain.digits, numeric: true },
            },
          ),
        );
      }

      return { ...node, value };
    }
    case "call":
      return { ...node, arguments: node.arguments.map(simplify) };
    case "binary": {
      let left = simplify(node.left);
      let right = simplify(node.right);
      let operator = node.operator;
      const like = LIKE_OPERATORS[operator];

      if (like) {
        return { kind: "like", value: left, pattern: right, ...like };
      }

      if (FLIPPED_COMPARISON[operator] === undefined) {
        return { ...node, left, right };
      }

      if (isLiteral(left) && !isLiteral(right)) {
        [left, right] = [right, left];
        operator = FLIPPED_COMPARISON[operator]!;
      }

      right = typedLiteral(left, right);

      // `x = true` holds exactly when x does, NULL included; `x = false` is `NOT x`.
      if (right.kind === "boolean" && (operator === "=" || operator === "<>")) {
        return right.value === (operator === "=")
          ? left
          : simplify({ kind: "not", value: left });
      }

      return { kind: "binary", operator, left, right };
    }
    case "not": {
      const value = simplify(node.value);

      switch (value.kind) {
        case "not":
          return value.value;
        case "boolean":
          return { kind: "boolean", value: !value.value };
        case "null-test":
        case "in":
        case "like":
        case "distinct":
        case "truth-test":
          return { ...value, negated: !value.negated };
        case "binary":
          return NEGATED_COMPARISON[value.operator]
            ? { ...value, operator: NEGATED_COMPARISON[value.operator]! }
            : { kind: "not", value };
        case "logical":
          // NOT BETWEEN reads as NOT (x >= a AND x <= b); PostgreSQL stores x < a OR x > b.
          return value.operator === "AND" &&
            value.values.length === 2 &&
            value.values.every(
              (entry) =>
                entry.kind === "binary" &&
                NEGATED_COMPARISON[entry.operator] !== undefined,
            )
            ? simplify({
                kind: "logical",
                operator: "OR",
                values: value.values.map((entry) => ({
                  kind: "not",
                  value: entry,
                })),
              })
            : { kind: "not", value };
        default:
          return { kind: "not", value };
      }
    }
    case "logical": {
      const values = node.values
        .map(simplify)
        .flatMap((value) =>
          value.kind === "logical" && value.operator === node.operator
            ? value.values
            : [value],
        );

      return values.length === 1 ? values[0]! : { ...node, values };
    }
    case "null-test":
    case "truth-test":
      return { ...node, value: simplify(node.value) };
    case "distinct": {
      const left = simplify(node.left);
      const right = simplify(node.right);

      return isLiteral(left) && !isLiteral(right)
        ? { ...node, left: right, right: left }
        : { ...node, left, right };
    }
    case "in": {
      const value = simplify(node.value);
      const values = node.values.map((entry) =>
        typedLiteral(value, simplify(entry)),
      );

      return values.length === 1
        ? {
            kind: "binary",
            operator: node.negated ? "<>" : "=",
            left: value,
            right: values[0]!,
          }
        : { ...node, value, values };
    }
    case "quantified": {
      const left = simplify(node.left);
      const right = simplify(node.right);

      if (
        right.kind === "array" &&
        ((node.operator === "=" && node.quantifier === "ANY") ||
          (node.operator === "<>" && node.quantifier === "ALL"))
      ) {
        return simplify({
          kind: "in",
          value: left,
          values: right.values,
          negated: node.operator === "<>",
        });
      }

      return { ...node, left, right };
    }
    case "array":
      return { ...node, values: node.values.map(simplify) };
    case "between": {
      if (node.symmetric) {
        return {
          ...node,
          value: simplify(node.value),
          lower: simplify(node.lower),
          upper: simplify(node.upper),
        };
      }

      // PostgreSQL stores BETWEEN as these comparisons.
      const comparisons: SqlExpression = {
        kind: "logical",
        operator: "AND",
        values: [
          {
            kind: "binary",
            operator: ">=",
            left: node.value,
            right: node.lower,
          },
          {
            kind: "binary",
            operator: "<=",
            left: node.value,
            right: node.upper,
          },
        ],
      };

      return simplify(
        node.negated ? { kind: "not", value: comparisons } : comparisons,
      );
    }
    case "like":
      return {
        ...node,
        value: simplify(node.value),
        pattern: simplify(node.pattern),
      };
    case "collate":
      return { ...node, value: simplify(node.value) };
    case "case":
      return {
        ...node,
        subject: node.subject && simplify(node.subject),
        branches: node.branches.map((branch) => ({
          when: simplify(branch.when),
          then: simplify(branch.then),
        })),
        otherwise: node.otherwise && simplify(node.otherwise),
      };
  }
};
