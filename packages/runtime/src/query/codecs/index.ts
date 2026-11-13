import { dataError } from "./deferred";

export type Codec<Value, Input = Value> = {
  readonly encode: (value: Input) => unknown;
  readonly decode: (value: unknown) => Value;
};

export type RuntimeCodec = {
  readonly encode: (value: never) => unknown;
  readonly decode: (value: unknown) => unknown;
  /** SQL type for `$n::text::<cast>` parameters, such as jsonb or text[]. */
  readonly parameterCast?: string;
  /** Declared SQL type the codec decodes, when parameters need no cast: `numeric(12,2)`. */
  readonly sqlType?: string;
  /** Element codec of an array column. */
  readonly element?: RuntimeCodec;
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

export const numericCodec: Codec<string> = {
  encode: (value) => value,
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
    // `integer` keeps no declared type, so parameters stay as untyped as before.
    ...(sqlType === "smallint" ? { sqlType } : {}),
    encode: (value: unknown) => {
      if (
        (typeof value === "number" &&
          !(Number.isInteger(value) && value >= -limit && value < limit)) ||
        (typeof value === "bigint" &&
          (value < -BigInt(limit) || value >= BigInt(limit)))
      ) {
        throw new Error(
          `symmetria: ${sqlType} values are integers from ${-limit} to ${limit - 1}, received ${String(value)}`,
        );
      }

      return value;
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
  encode: (value) =>
    (value as unknown) instanceof Date ? dateCodec.decode(value) : value,
  decode: (value) => {
    if (value instanceof Date) {
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
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (typeof value === "string" && value.startsWith("\\x")) {
      return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
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
  const nullable = elementType === "jsonb" || elementType === "json";

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

      return values.map((value) => {
        if (value == null && !nullable) {
          throw nullElement("store");
        }

        return encodeValue(value, element);
      });
    },
    decode: (value) => {
      const values =
        typeof value === "string" && value.startsWith("[")
          ? (JSON.parse(value) as unknown[])
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
      return value;
    }

    if (Number.isNaN(value.getTime())) {
      throw new Error(
        `symmetria: ${sqlType} values must be valid Dates, received Invalid Date`,
      );
    }

    return timestampText(value);
  };

export const codecFor = (sqlType: string): RuntimeCodec | undefined => {
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
      encode: (value) => JSON.stringify(value),
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
): ((row: Record<string, unknown>) => Record<string, unknown>) => {
  // Assignment to __proto__ would invoke Object.prototype's setter instead of
  // defining a selected field. Keep data-property semantics for that projection.
  if (selection.some((expression) => expression.outputName === "__proto__")) {
    return (row) =>
      Object.fromEntries(
        selection.map((expression) => [
          expression.outputName,
          decodeValue(row[expression.outputName], expression.codec),
        ]),
      );
  }

  // A generated decoder reads and writes literal keys, which keeps property
  // access monomorphic; a generic loop over dynamic keys is several times slower.
  const codecs: RuntimeCodec[] = [];
  const fields = selection.map((expression) => {
    const key = JSON.stringify(expression.outputName);

    if (!expression.codec) {
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
      decoderFactories.delete(decoderFactories.keys().next().value!);
    }

    decoderFactories.set(source, factory);
  }

  return factory(codecs);
};

type DecoderFactory = (
  codecs: RuntimeCodec[],
) => (row: Record<string, unknown>) => Record<string, unknown>;

/** Generated code depends only on field names and codec positions, so factories are shared. */
const decoderFactories = new Map<string, DecoderFactory>();

/** Primitive parameter values can be reused; object-backed values are cloned defensively. */
export const cloneParameter = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    // Functions and symbols are rejected by structuredClone, as before.
    return typeof value === "function" || typeof value === "symbol"
      ? structuredClone(value)
      : value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry !== null && typeof entry === "object") {
        return structuredClone(value);
      }
    }

    return value.slice();
  }

  return structuredClone(value);
};
