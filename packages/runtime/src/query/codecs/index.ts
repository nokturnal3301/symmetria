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

/** Floats and smallint: drivers deliver numbers; JSON and text casts deliver strings such as "NaN". */
const numberCodec = (sqlType: string): RuntimeCodec => ({
  sqlType,
  encode: (value) => value,
  decode: (value) => (typeof value === "number" ? value : Number(value)),
});

const pad = (value: number) => String(value).padStart(2, "0");

/** Calendar dates stay `YYYY-MM-DD` text; a driver Date is read in UTC (Bun) or local time (pg midnight). */
export const dateCodec: RuntimeCodec = {
  sqlType: "date",
  encode: (value) =>
    (value as unknown) instanceof Date ? dateCodec.decode(value) : value,
  decode: (value) => {
    if (value instanceof Date) {
      // Bun parses dates as UTC midnight; node-postgres as local midnight.
      const utc = value.getUTCHours() === 0 && value.getUTCMinutes() === 0;

      return utc
        ? `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
        : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
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

/** Arrays travel as JavaScript arrays; the adapters bind them as PostgreSQL array parameters. */
export const arrayCodec = (
  elementType: string,
  element?: RuntimeCodec,
): RuntimeCodec => ({
  encode: (values: unknown) => {
    if (!Array.isArray(values)) {
      throw new Error("symmetria: array columns accept arrays");
    }

    return values.map((value) => encodeValue(value, element));
  },
  decode: (value) => {
    const values =
      typeof value === "string" && value.startsWith("[")
        ? (JSON.parse(value) as unknown[])
        : value;

    if (!Array.isArray(values)) {
      throw new Error("symmetria: expected an array value from the database");
    }

    return values.map((entry) => decodeValue(entry, element));
  },
  parameterCast: `${elementType}[]`,
  ...(element ? { element } : {}),
});

export const codecFor = (sqlType: string): RuntimeCodec | undefined => {
  if (sqlType.endsWith("[]")) {
    const elementType = sqlType.slice(0, -2);

    return arrayCodec(elementType, codecFor(elementType));
  }

  if (sqlType === "bigint") {
    return bigintCodec;
  }

  if (
    sqlType === "smallint" ||
    sqlType === "real" ||
    sqlType === "double precision"
  ) {
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

  if (sqlType === "timestamptz" || sqlType === "timestamp") {
    return {
      encode: (value) => value,
      decode: (value) => {
        if (value instanceof Date) {
          return value;
        }

        const date = new Date(value as string);

        // PostgreSQL's infinity and -infinity have no Date representation;
        // node-postgres hands them over as ±Infinity. Fail loudly instead of
        // returning an Invalid Date that only breaks later.
        if (Number.isNaN(date.getTime())) {
          throw new Error(
            `symmetria: cannot represent ${sqlType} value ${JSON.stringify(
              typeof value === "number" ? String(value) : value,
            )} as a Date; read it with sql.of(text)\`…\` instead`,
          );
        }

        return date;
      },
    };
  }

  return undefined;
};

export const encodeValue = (value: unknown, codec?: RuntimeCodec): unknown =>
  value === null || value === undefined || !codec
    ? value
    : codec.encode(value as never);

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
