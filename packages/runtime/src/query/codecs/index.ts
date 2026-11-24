import { dataError } from "./deferred";
import { keyAlias } from "../compile/state";
import { canonicalType } from "./type-names";

export type Codec<Value, Input = Value> = {
  readonly encode: (value: Input) => unknown;
  readonly decode: (value: unknown) => Value;
};

export type RuntimeCodec = {
  readonly encode: (value: never) => unknown;
  readonly decode: (value: unknown) => unknown;
  /** SQL type for `$n::text::<cast>` parameters, such as jsonb or text[]. */
  readonly parameterCast?: string;
  /** Declared SQL type the codec decodes, such as `numeric(12,2)`; typed expressions follow it. */
  readonly sqlType?: string;
  /**
   * The type the values have when the declared one is another name for it,
   * such as a domain's base type, in the runtime's spelling (`canonicalType`):
   * JSON precision, aggregates and arithmetic follow it. Never rendered.
   */
  readonly base?: string;
  /** Element codec of an array column. */
  readonly element?: RuntimeCodec;
  /** Decoding returns the value as it came; row decoders skip the call. */
  readonly passthrough?: boolean;
  /**
   * Decoding returns the value as it came unless PostgreSQL built it as jsonb,
   * whose sorted keys it puts back in the selected order.
   */
  readonly reorders?: boolean;
};

export type SchemaCodecs = Readonly<
  Record<string, Readonly<Record<string, RuntimeCodec>>>
>;

/** Missing column codecs must never resolve to Object.prototype properties. */
export const codecMap = (
  entries: Record<string, RuntimeCodec>,
): Record<string, RuntimeCodec> => Object.setPrototypeOf(entries, null);

/** bigint columns also accept safe JavaScript integers on write. */
export const bigintCodec: Codec<bigint, bigint | number> & {
  readonly sqlType: "bigint";
} = {
  sqlType: "bigint",
  encode: (value) => {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(
        "symmetria: bigint columns accept bigint values or safe integers",
      );
    }

    return value.toString();
  },
  decode: (value) => BigInt(value as string | number | bigint),
};

/** Normalize boolean expressions returned by a query executor. */
export const booleanCodec: Codec<boolean> & { readonly sqlType: "boolean" } = {
  sqlType: "boolean",
  encode: (value) => value,
  decode: (value) => value === true || value === 1 || value === 1n,
};

/**
 * A boolean column takes `true` or `false`. Past the types, Bun binds `1` as
 * an integer, which PostgreSQL refuses for one row and reads as true in an
 * array of a hundred; both fail here instead, with the value in the message.
 */
const booleanColumnCodec: RuntimeCodec = {
  encode: (value: unknown) => {
    if (typeof value !== "boolean") {
      throw new Error(
        `symmetria: boolean values are true or false, received ${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
      );
    }

    return value;
  },
  decode: (value) => value,
};

/** COUNT and ranking results are safe integers in practice; decode them as numbers. */
export const countCodec: Codec<number> = {
  encode: (value) => value,
  decode: (value) => {
    const count = Number(value);

    if (!Number.isSafeInteger(count)) {
      throw new Error(
        `symmetria: count ${String(value)} exceeds Number.MAX_SAFE_INTEGER`,
      );
    }

    return count;
  },
};

/**
 * What every supported PostgreSQL reads as a numeric: a sign, digits with an
 * optional fraction and exponent, `NaN` or a signed `Infinity` (`inf`), in any
 * letter case, between optional whitespace. The `0x1F` and `1_000` forms of
 * PostgreSQL 16 are left out: versions 14 and 15 reject them.
 */
const NUMERIC_TEXT =
  /^[ \t\n\v\f\r]*(?:[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?)|nan)[ \t\n\v\f\r]*$/i;

/**
 * Decimals are typed as strings, which `"abc"` satisfies as well: text that is
 * not a number fails here, with the value in the message, instead of inside
 * PostgreSQL. Numbers and bigints only arrive past the types; their text is
 * exact, so they are sent as it.
 */
export const numericCodec: Codec<string> = {
  encode: (value: unknown) => {
    if (
      typeof value === "string"
        ? !NUMERIC_TEXT.test(value)
        : typeof value !== "number" && typeof value !== "bigint"
    ) {
      throw new Error(
        `symmetria: numeric values are decimal text such as "12.50", received ${
          typeof value === "string" ? JSON.stringify(value) : typeof value
        }`,
      );
    }

    // A driver may bind a JavaScript number as a float and round it.
    return typeof value === "string" ? value : String(value);
  },
  decode: (value) => String(value),
};

/** Drivers deliver numbers; JSON and text casts deliver strings such as "NaN". */
const readNumber = (value: unknown): number =>
  typeof value === "number" ? value : Number(value);

/** Double-precision floats. */
const numberCodec = (sqlType: string): RuntimeCodec => ({
  sqlType,
  encode: (value) => value,
  decode: readNumber,
});

const single = new Float32Array(1);
const singleBits = new Uint32Array(single.buffer);

/** Whether a positive float's exact decimal expansion has `length + 1` digits ending in 5. */
const tiesAt = (magnitude: number, length: number): boolean => {
  const longer = magnitude.toExponential(length);

  // Cheap filter first; the exact expansion (every float has a finite one) confirms it.
  if (Number(longer) !== magnitude || !/5e/.test(longer)) {
    return false;
  }

  const digits = magnitude.toExponential(99).split("e")[0]!.replace(".", "");

  return !/[1-9]/.test(digits.slice(length + 1));
};

/**
 * The shortest decimal that reads back as the same single-precision float,
 * which is how PostgreSQL prints `real` values (and node-postgres parses
 * them). Bun's binary protocol hands over the exact float instead, so
 * `0.1::real` would arrive as 0.10000000149011612. Values that are not exact
 * floats came from that text form already and are returned unchanged.
 */
export const shortestReal = (value: number): number => {
  if (value === 0 || !Number.isFinite(value) || Math.fround(value) !== value) {
    return value;
  }

  // PostgreSQL's float output (Ryu) never picks a decimal exactly halfway to
  // a neighbouring float, even one that would read back by round-half-even.
  single[0] = value;
  singleBits[0]! += 1;
  const away = (value + single[0]!) / 2;
  singleBits[0]! -= 2;
  const toward = (value + single[0]!) / 2;
  const readsBack = (candidate: number) =>
    Math.fround(candidate) === value &&
    candidate !== away &&
    candidate !== toward;

  const magnitude = Math.abs(value);
  const signed = (decimal: number) => (value < 0 ? -decimal : decimal);

  /** The decimal of this many digits PostgreSQL would print, if one reads back. */
  const candidate = (length: number): number | undefined => {
    // The nearest decimal of this length, ties rounded away from zero.
    const text = magnitude.toExponential(length - 1);
    const marker = text.indexOf("e");
    const significand = Number(text.slice(0, marker).replace(".", ""));
    const scale = `e${Number(text.slice(marker + 1)) - length + 1}`;
    const nearest = Number(`${significand}${scale}`);
    // Next to a power of two the rounding interval is lopsided: the decimal on
    // the other side of the value can read back where the nearer one cannot.
    const other = Number(
      `${nearest > magnitude ? significand - 1 : significand + 1}${scale}`,
    );

    // Exact ties go to the even digit, as in PostgreSQL's output.
    if (
      nearest > magnitude &&
      significand % 2 === 1 &&
      tiesAt(magnitude, length) &&
      readsBack(signed(other))
    ) {
      return signed(other);
    }

    return readsBack(signed(nearest))
      ? signed(nearest)
      : readsBack(signed(other))
        ? signed(other)
        : undefined;
  };

  // A length that has a decimal inside the interval keeps one at every longer
  // length, so the shortest is found by bisection; nine digits always suffice.
  let shortest = 9;
  let found: number | undefined;

  for (let low = 1; low < shortest; ) {
    const middle = (low + shortest) >> 1;
    const decimal = candidate(middle);

    if (decimal === undefined) {
      low = middle + 1;
    } else {
      shortest = middle;
      found = decimal;
    }
  }

  return found ?? candidate(9) ?? Number(value.toPrecision(9));
};

/**
 * Single-precision floats read the same on both drivers (see shortestReal).
 * Parameters go through text, as node-postgres sends them: Bun binds numbers
 * as double precision, so `real = 0.1` would compare 0.1 with the float
 * 0.10000000149011612 and miss.
 */
const realCodec: RuntimeCodec = {
  sqlType: "real",
  parameterCast: "real",
  encode: (value) => value,
  decode: (value) => shortestReal(readNumber(value)),
};

/**
 * `integer` and `smallint` accept only integers in range. PostgreSQL rejects
 * `6.5` or `2 ** 31` sent as text (node-postgres), while Bun sends them as
 * double precision and compares silently, so both drivers fail here instead.
 */
const integerCodec = (
  sqlType: "integer" | "smallint",
  bits: 16 | 32,
): RuntimeCodec => {
  const limit = 2 ** (bits - 1);

  return {
    // `integer` declares no type, so its parameters stay untyped in the SQL.
    ...(sqlType === "smallint" ? { sqlType } : {}),
    encode: (value: unknown) => {
      if (
        (typeof value === "number" &&
          !(Number.isInteger(value) && value >= -limit && value < limit)) ||
        (typeof value === "bigint" &&
          (value < -BigInt(limit) || value >= BigInt(limit))) ||
        typeof value === "boolean"
      ) {
        throw new Error(
          `symmetria: ${sqlType} values are integers from ${-limit} to ${limit - 1}, received ${String(value)}`,
        );
      }

      // Bun sends -0 as a double, which would run integer arithmetic in
      // double precision and answer -0.
      return Object.is(value, -0) ? 0 : value;
    },
    decode: readNumber,
  };
};

const integerCodecs = {
  integer: integerCodec("integer", 32),
  smallint: integerCodec("smallint", 16),
};

const pad = (value: number) => String(value).padStart(2, "0");

/** A calendar date as PostgreSQL prints it: `0999-05-05`, `0044-03-15 BC`. */
const dateText = (year: number, month: number, day: number): string =>
  year > 0
    ? `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`
    : // JavaScript counts 1 BC as year 0.
      `${String(1 - year).padStart(4, "0")}-${pad(month)}-${pad(day)} BC`;

/** Calendar dates stay text in PostgreSQL's form; a driver Date is read in UTC (Bun) or local time (pg midnight). */
export const dateCodec: RuntimeCodec = {
  sqlType: "date",
  encode: (value) => {
    if (!((value as unknown) instanceof Date)) {
      // Past the types: the drivers disagree on what a number is as a date.
      if (typeof value !== "string") {
        throw new Error(
          `symmetria: date values are text such as "2024-01-31" or Dates, received ${typeof value}`,
        );
      }

      return value;
    }

    if (Number.isNaN((value as unknown as Date).getTime())) {
      throw new Error("symmetria: date values cannot be an invalid Date");
    }

    return dateCodec.decode(value);
  },
  decode: (value) => {
    if (value instanceof Date) {
      // Bun makes every date a Date, and a Date ends at 275760-09-13.
      if (Number.isNaN(value.getTime())) {
        throw new Error(
          "symmetria: a date beyond 275760-09-13 (or before 271821-04-20 BC) cannot be read through Bun.SQL, which reads it as a JavaScript Date; read it as text (sql<string>`${column}::text`) or use symmetria/pg",
        );
      }

      // Bun parses dates as UTC midnight; node-postgres as local midnight.
      const utc = value.getUTCHours() === 0 && value.getUTCMinutes() === 0;

      return utc
        ? dateText(
            value.getUTCFullYear(),
            value.getUTCMonth() + 1,
            value.getUTCDate(),
          )
        : dateText(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }

    // Bun reads PostgreSQL's infinity dates as ±Infinity.
    if (typeof value === "number" && !Number.isFinite(value)) {
      return value > 0 ? "infinity" : "-infinity";
    }

    return String(value);
  },
};

/** Intervals stay PostgreSQL text; node-postgres interval objects print themselves back. */
export const intervalCodec: RuntimeCodec = {
  sqlType: "interval",
  encode: (value) => value,
  decode: (value) =>
    typeof value === "object" &&
    value !== null &&
    "toPostgres" in value &&
    typeof value.toPostgres === "function"
      ? String(value.toPostgres())
      : String(value),
};

/** Binary columns are `Uint8Array`; JSON and text casts deliver PostgreSQL's `\x…` hex form. */
export const bytesCodec: RuntimeCodec = {
  sqlType: "bytea",
  encode: (value) => {
    if (!((value as unknown) instanceof Uint8Array)) {
      throw new Error("symmetria: bytea columns accept Uint8Array values");
    }

    return value;
  },
  decode: (value) => {
    if (value instanceof Uint8Array) {
      // A driver's Buffer can be a view into memory other values share:
      // Node's 8 KB pool holds other queries' SQL, parameters and rows behind
      // `value.buffer`. Such a value gets bytes of its own.
      return value.byteOffset === 0 &&
        value.byteLength === value.buffer.byteLength
        ? new Uint8Array(value.buffer)
        : new Uint8Array(value);
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (typeof value === "string" && value.startsWith("\\x")) {
      return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
    }

    // `bytea_output = escape`, which a pooler may keep where a SET does not
    // reach: printable bytes as they are, two backslashes for one, and a
    // backslash with three octal digits for any other byte.
    if (
      typeof value === "string" &&
      /^(?:[\x20-\x5b\x5d-\x7e]|\\\\|\\[0-3][0-7]{2})*$/.test(value)
    ) {
      const bytes: number[] = [];

      for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "\\") {
          bytes.push(value.charCodeAt(index));
        } else if (value[index + 1] === "\\") {
          bytes.push(92);
          index += 1;
        } else {
          bytes.push(Number.parseInt(value.slice(index + 1, index + 4), 8));
          index += 3;
        }
      }

      return Uint8Array.from(bytes);
    }

    throw new Error(
      `symmetria: cannot read bytea value ${JSON.stringify(value)}`,
    );
  },
};

/**
 * Arrays travel as JavaScript arrays; the adapters bind them as PostgreSQL
 * array parameters. Their elements are typed non-null (`int.array` is
 * `number[]`), so a NULL element, which only SQL written outside Symmetria can
 * store, fails loudly instead of reaching code that trusts the type. JSON
 * elements are exempt: `null` is a JSON value.
 */
export const arrayCodec = (
  elementType: string,
  element?: RuntimeCodec,
): RuntimeCodec => {
  const type = element?.base ?? canonicalType(elementType);
  const nullable = type === "jsonb" || type === "json";
  // PostgreSQL separates the elements of a box array with ";": its own
  // elements hold commas.
  const delimiter = type === "box" ? ";" : ",";
  // An array arriving as text has PostgreSQL's text form of each element,
  // which the codecs read like a driver's value, except booleans and JSON.
  const fromText =
    type === "boolean"
      ? (text: string): unknown =>
          text === "t" || text === "true"
            ? true
            : text === "f" || text === "false"
              ? false
              : text
      : nullable
        ? (text: string): unknown => JSON.parse(text)
        : undefined;

  const nullElement = (direction: "store" | "read"): Error =>
    new Error(
      direction === "store"
        ? `symmetria: ${elementType}[] columns cannot store NULL elements`
        : `symmetria: ${elementType}[] value from the database contains a NULL element; drop NULL elements in SQL with array_remove(…, NULL)`,
    );

  return {
    encode: (values: unknown) => {
      if (!Array.isArray(values)) {
        throw new Error("symmetria: array columns accept arrays");
      }

      const encoded = values.map((value) => {
        if (value == null && !nullable) {
          throw nullElement("store");
        }

        return encodeValue(value, element);
      });

      // The drivers write an array with commas; this one goes as its text.
      return delimiter === ","
        ? encoded
        : `{${encoded
            .map(
              (value) =>
                `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
            )
            .join(delimiter)}}`;
    },
    decode: (value) => {
      const values =
        typeof value === "string" && value.startsWith("[")
          ? (JSON.parse(value) as unknown[])
          : // A type the driver has no parser for (an enum, tsvector or range
            // array on node-postgres, an enum array on Bun, an array of a
            // domain on both) arrives as text.
            typeof value === "string" && value.startsWith("{")
            ? fromText
              ? arrayLiteral(value, delimiter).map((text) =>
                  text === null ? text : fromText(text),
                )
              : arrayLiteral(value, delimiter)
            : // Bun reads integer[] and real[] parameters and RETURNING values as typed arrays.
              ArrayBuffer.isView(value) && !(value instanceof DataView)
              ? Array.from(value as unknown as ArrayLike<unknown>)
              : value;

      if (!Array.isArray(values)) {
        throw new Error("symmetria: expected an array value from the database");
      }

      return values.map((entry) => {
        if (entry == null && !nullable) {
          throw nullElement("read");
        }

        return decodeValue(entry, element);
      });
    },
    parameterCast: `${elementType}[]`,
    ...(element ? { element } : {}),
  };
};

/**
 * A one-dimensional array in PostgreSQL's text form, `{a,"b c",NULL}`, as
 * its element texts; `NULL` unquoted is a NULL element. A box array
 * separates its elements with ";".
 */
const arrayLiteral = (text: string, delimiter = ","): (string | null)[] => {
  const values: (string | null)[] = [];

  if (!text.endsWith("}")) {
    throw new Error("symmetria: expected an array value from the database");
  }

  let position = 1;

  if (text === "{}") {
    return values;
  }

  while (position < text.length) {
    let element = "";

    if (text[position] === '"') {
      position += 1;

      while (text[position] !== '"') {
        if (position >= text.length) {
          throw new Error(
            "symmetria: expected an array value from the database",
          );
        }

        if (text[position] === "\\") {
          position += 1;
        }

        element += text[position];
        position += 1;
      }

      position += 1;
      values.push(element);
    } else {
      while (text[position] !== delimiter && text[position] !== "}") {
        if (text[position] === "{") {
          throw new Error(
            "symmetria: multidimensional arrays are not supported",
          );
        }

        element += text[position];
        position += 1;
      }

      values.push(element === "NULL" ? null : element);
    }

    // The delimiter after the element, or the closing brace.
    position += 1;
  }

  return values;
};

/**
 * A timestamp as PostgreSQL prints it in text and JSON: `2024-01-31 12:00:00.123`,
 * `…T12:00:00+05:30`, years past 9999 and a ` BC` suffix. Zone offsets may
 * carry seconds (`+02:02:04` for historic local mean time).
 */
const TIMESTAMP_TEXT =
  /^(\d{4,})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?(?:(Z)|([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?)?( BC)?$/;

/**
 * The instant a PostgreSQL timestamp text names; text without an offset is
 * UTC. Undefined for anything else, such as `infinity`. Date's own parser
 * knows neither BC years nor offsets with seconds.
 */
export const timestampFromText = (text: string): Date | undefined => {
  const parts = TIMESTAMP_TEXT.exec(text);

  if (!parts) {
    return undefined;
  }

  const [
    ,
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    fraction,
    ,
    sign,
    offsetHours,
    offsetMinutes,
    offsetSeconds,
    bc,
  ] = parts;
  const date = new Date(0);
  // JavaScript counts 1 BC as year 0; Date keeps milliseconds of the microseconds.
  date.setUTCFullYear(
    bc ? 1 - Number(year) : Number(year),
    Number(month) - 1,
    Number(day),
  );
  date.setUTCHours(
    Number(hours),
    Number(minutes),
    Number(seconds ?? 0),
    Number(`${fraction ?? ""}000`.slice(0, 3)),
  );

  if (!sign) {
    return date;
  }

  const offset =
    Number(offsetHours) * 3600 +
    Number(offsetMinutes ?? 0) * 60 +
    Number(offsetSeconds ?? 0);

  return new Date(date.getTime() - (sign === "-" ? -offset : offset) * 1000);
};

/**
 * A Date as text PostgreSQL reads exactly: ISO 8601 in UTC, with four-digit
 * years and a ` BC` suffix where ISO would print `-000043` or `+010000`.
 */
export const timestampText = (value: Date): string => {
  const year = value.getUTCFullYear();
  const iso = value.toISOString();

  if (year >= 1 && year <= 9999) {
    return iso;
  }

  // The ISO tail `-MM-DDTHH:MM:SS.sssZ` after the expanded year.
  return `${String(year > 0 ? year : 1 - year).padStart(4, "0")}${iso.slice(-20)}${year > 0 ? "" : " BC"}`;
};

/**
 * Dates are sent as UTC text on both drivers: node-postgres would print them
 * in local time with a whole-minute offset, shifting instants whose historic
 * offset has seconds. Invalid Dates fail before they reach PostgreSQL.
 */
const timestampParameter =
  (sqlType: string) =>
  (value: unknown): unknown => {
    if (!(value instanceof Date)) {
      // Past the types: the drivers disagree on what a number is as a time.
      if (typeof value !== "string") {
        throw new Error(
          `symmetria: ${sqlType} values are Dates or text, received ${typeof value}`,
        );
      }

      return value;
    }

    if (Number.isNaN(value.getTime())) {
      throw new Error(
        `symmetria: ${sqlType} values must be valid Dates, received Invalid Date`,
      );
    }

    return timestampText(value);
  };

/** The codec of a built-in type, by any of its names (`int8`, `DECIMAL(12,2)`). */
export const codecFor = (declared: string): RuntimeCodec | undefined => {
  const sqlType = canonicalType(declared);

  if (sqlType.endsWith("[]")) {
    const elementType = sqlType.slice(0, -2);

    return arrayCodec(elementType, codecFor(elementType));
  }

  if (sqlType === "bigint") {
    return bigintCodec;
  }

  if (sqlType === "integer" || sqlType === "smallint") {
    return integerCodecs[sqlType];
  }

  if (sqlType === "real") {
    return realCodec;
  }

  if (sqlType === "double precision") {
    return numberCodec(sqlType);
  }

  if (sqlType === "date") {
    return dateCodec;
  }

  if (sqlType === "boolean") {
    return booleanColumnCodec;
  }

  if (sqlType === "interval") {
    return intervalCodec;
  }

  if (sqlType === "bytea") {
    return bytesCodec;
  }

  if (sqlType.startsWith("numeric")) {
    // Retain the declared precision and scale for typed expressions.
    return sqlType.includes(",") ? { ...numericCodec, sqlType } : numericCodec;
  }

  if (sqlType === "jsonb" || sqlType === "json") {
    return {
      encode: jsonText,
      decode: (value) => value,
      parameterCast: sqlType,
    };
  }

  if (/^timestamp(tz)?(\(\d\))?$/.test(sqlType)) {
    return {
      // A Date is sent as its UTC ISO text; without a time zone, PostgreSQL
      // stores that wall-clock time, so those values are UTC as well.
      encode: timestampParameter(sqlType),
      decode: (value) => {
        const date =
          value instanceof Date
            ? value
            : (timestampFromText(String(value)) ?? new Date(String(value)));

        // PostgreSQL's infinity and -infinity have no Date representation;
        // node-postgres hands them over as text, Bun as ±Infinity. Fail loudly
        // instead of returning an Invalid Date that only breaks later.
        if (Number.isNaN(date.getTime())) {
          const shown =
            value === Infinity
              ? "infinity"
              : value === -Infinity
                ? "-infinity"
                : String(value);

          throw new Error(
            `symmetria: cannot represent ${sqlType} value ${JSON.stringify(shown)} as a Date; read it with sql.of(text)\`…\` instead`,
          );
        }

        return date;
      },
    };
  }

  return undefined;
};

/**
 * JSON.stringify's replacer that refuses NaN and ±Infinity where it writes
 * them: it sees each value as written, after its `toJSON(key)`, under its key.
 */
const refuseNonFinite = (key: string, value: unknown): unknown => {
  if (
    (typeof value === "number" || value instanceof Number) &&
    !Number.isFinite(Number(value))
  ) {
    throw new Error(
      `symmetria: a json or jsonb value cannot hold NaN or Infinity${key === "" ? "" : ` (at ${JSON.stringify(key)})`}: JSON has neither, and JSON.stringify would write null`,
    );
  }

  return value;
};

const dateToJSON = Date.prototype.toJSON;

/**
 * Whether a value may hold NaN or ±Infinity where JSON.stringify writes it:
 * a quick walk of what JSON.stringify writes, calling each `toJSON(key)` as
 * it does, that may answer yes for a value that does not (a key from the
 * prototype, a getter that answers differently the second time), never no
 * for one that does. A Date's own `toJSON()` writes its text or null, never a
 * number.
 */
const mayHoldNonFinite = (
  value: unknown,
  key: string | number,
  written = false,
): boolean => {
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!written) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;

    if (typeof toJSON === "function") {
      return toJSON === dateToJSON
        ? false
        : mayHoldNonFinite(toJSON.call(value, String(key)), key, true);
    }
  }

  if (value instanceof Number) {
    return !Number.isFinite(Number(value));
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];

      if (
        typeof item === "number"
          ? !Number.isFinite(item)
          : typeof item === "object" &&
            item !== null &&
            mayHoldNonFinite(item, index)
      ) {
        return true;
      }
    }

    return false;
  }

  for (const name in value) {
    const item: unknown = (value as Record<string, unknown>)[name];

    if (
      typeof item === "number"
        ? !Number.isFinite(item)
        : typeof item === "object" &&
          item !== null &&
          mayHoldNonFinite(item, name)
    ) {
      return true;
    }
  }

  return false;
};

/**
 * Matches every `null` JSON.stringify writes as a value, and a few inside
 * strings (`"a,null]"` does, `"nullable"` does not): a match is only a reason
 * to look closer.
 */
const NULL_TOKEN = /(?:^|[[,:])null(?=[,\]}]|$)/;

/**
 * A value as JSON text, refusing NaN and ±Infinity at any depth:
 * JSON.stringify writes them as null, which would store or compare JSON null.
 * Only a text that holds a `null` value can hide one, so others need no
 * second look; one that may is written again, checking each value as it is
 * written, and that text is the one returned.
 */
export const jsonText = (value: unknown): string => {
  const text = JSON.stringify(value);

  return text?.includes("null") &&
    NULL_TOKEN.test(text) &&
    mayHoldNonFinite(value, "")
    ? JSON.stringify(value, refuseNonFinite)
    : text;
};

/**
 * A value the codec rejects is a data error: while a query is built it is
 * recorded for execution and stands in as NULL (see `./deferred`).
 */
export const encodeValue = (value: unknown, codec?: RuntimeCodec): unknown => {
  if (value === null || value === undefined || !codec) {
    return value;
  }

  try {
    return codec.encode(value as never);
  } catch (error) {
    dataError(error);

    return null;
  }
};

export const decodeValue = (value: unknown, codec?: RuntimeCodec): unknown =>
  value === null || value === undefined || !codec ? value : codec.decode(value);

export const createRowDecoder = (
  selection: readonly {
    readonly outputName: string;
    readonly codec?: RuntimeCodec;
  }[],
  /** Rows of a statement, whose columns are the keys' SQL aliases (`keyAlias`); JSON rows carry the keys. */
  columns = false,
): ((row: Record<string, unknown>) => Record<string, unknown>) => {
  const sources = columns
    ? selection.map((expression) => keyAlias(expression.outputName))
    : undefined;

  // Assignment to __proto__ would invoke Object.prototype's setter instead of
  // defining a selected field. Keep data-property semantics for that projection.
  // A key too long for an SQL alias comes back under its shorter `keyAlias`.
  if (
    selection.some(
      (expression, position) =>
        expression.outputName === "__proto__" ||
        (sources && sources[position] !== expression.outputName),
    )
  ) {
    return (row) =>
      Object.fromEntries(
        selection.map((expression, position) => [
          expression.outputName,
          decodeValue(
            row[sources?.[position] ?? expression.outputName],
            expression.codec,
          ),
        ]),
      );
  }

  // The same fields are selected again and again; the factory is found by
  // comparing their names, without rendering the decoder's source first.
  const known = knownDecoders.get(selection[0]?.outputName ?? "");

  if (known) {
    search: for (const entry of known) {
      if (entry.names.length !== selection.length) {
        continue;
      }

      const codecs: RuntimeCodec[] = [];

      for (let position = 0; position < selection.length; position++) {
        const { outputName, codec } = selection[position]!;
        const decoded = !!codec && !codec.passthrough;

        if (
          entry.names[position] !== outputName ||
          entry.decoded[position] !== decoded
        ) {
          continue search;
        }

        if (decoded) {
          codecs.push(codec);
        }
      }

      return entry.factory(codecs);
    }
  }

  // A generated decoder reads and writes literal keys, which keeps property
  // access monomorphic; a generic loop over dynamic keys is several times slower.
  const codecs: RuntimeCodec[] = [];
  const fields = selection.map((expression) => {
    const key = JSON.stringify(expression.outputName);

    if (!expression.codec || expression.codec.passthrough) {
      return `${key}: row[${key}]`;
    }

    const codec = `c${codecs.push(expression.codec) - 1}`;

    return `${key}: (v = row[${key}]) == null ? v : ${codec}.decode(v)`;
  });
  const source = `${codecs.map((_codec, index) => `const c${index} = codecs[${index}];`).join("\n")}
return (row) => { let v; return { ${fields.join(", ")} }; };`;
  let factory = decoderFactories.get(source);

  if (!factory) {
    factory = new Function("codecs", source) as DecoderFactory;

    // FIFO bounds retention of dynamic projections; live decoders remain valid.
    if (decoderFactories.size >= 256) {
      const [oldest, evicted] = decoderFactories.entries().next().value!;
      const first = knownFirstNames.get(evicted)!;
      const remaining = knownDecoders
        .get(first)!
        .filter((entry) => entry.factory !== evicted);

      decoderFactories.delete(oldest);
      knownFirstNames.delete(evicted);

      if (remaining.length) {
        knownDecoders.set(first, remaining);
      } else {
        knownDecoders.delete(first);
      }
    }

    const first = selection[0]?.outputName ?? "";
    const entries = knownDecoders.get(first) ?? [];

    entries.push({
      names: selection.map((expression) => expression.outputName),
      decoded: selection.map(
        (expression) => !!expression.codec && !expression.codec.passthrough,
      ),
      factory,
    });
    knownDecoders.set(first, entries);
    knownFirstNames.set(factory, first);
    decoderFactories.set(source, factory);
  }

  return factory(codecs);
};

type DecoderFactory = (
  codecs: RuntimeCodec[],
) => (row: Record<string, unknown>) => Record<string, unknown>;

/** Generated code depends only on field names and codec positions, so factories are shared. */
const decoderFactories = new Map<string, DecoderFactory>();

/** The same factories by the first selected name, then by every name and whether its field is decoded. */
const knownDecoders = new Map<
  string,
  {
    readonly names: readonly string[];
    readonly decoded: readonly boolean[];
    readonly factory: DecoderFactory;
  }[]
>();
const knownFirstNames = new Map<DecoderFactory, string>();

/** Primitive parameter values can be reused; object-backed values are cloned defensively. */
export const cloneParameter = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    // Functions and symbols cannot be copied: `cloned` refuses them by name.
    return typeof value === "function" || typeof value === "symbol"
      ? cloned(value)
      : value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry !== null && typeof entry === "object") {
        return cloned(value);
      }
    }

    return value.slice();
  }

  return cloned(value);
};

/** structuredClone, failing with what cannot be bound instead of a DataCloneError. */
const cloned = (value: unknown): unknown => {
  try {
    return structuredClone(value);
  } catch (error) {
    const name = (value as { constructor?: { name?: unknown } }).constructor
      ?.name;
    const what =
      typeof value === "function"
        ? "a function"
        : typeof value === "symbol"
          ? "a symbol"
          : Array.isArray(value)
            ? "an array with a part that cannot be copied"
            : typeof name === "string" && name !== "Object"
              ? `a ${name}`
              : "an object with a part that cannot be copied";

    throw new Error(
      `symmetria: ${what} cannot be bound as a SQL value; pass a string, number, bigint, boolean, Date, Buffer, plain JSON object or an array of these`,
      { cause: error },
    );
  }
};
