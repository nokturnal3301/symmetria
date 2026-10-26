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

/** bigint columns also accept safe JavaScript integers on write. */
export const bigintCodec: Codec<bigint, bigint | number> = {
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

/** EXISTS and other boolean expressions arrive as 0/1 from SQLite. */
export const booleanCodec: Codec<boolean> = {
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

/** Arrays travel as JavaScript arrays; drivers serialize them for their dialect. */
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

  if (sqlType.startsWith("numeric")) {
    // The scale lets SQLite round decoded text like PostgreSQL stores it.
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
      decode: (value) =>
        value instanceof Date ? value : new Date(value as string),
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
