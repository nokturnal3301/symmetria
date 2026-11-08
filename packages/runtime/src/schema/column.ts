/**
 * Column builders. Property-access magic: `text.unique`, `uuid.v7`, `timestamptz.now`.
 *
 * Modifiers return new frozen column definitions. Runtime codecs live under a
 * symbol; schema assembly normalizes defaults for serializable migration snapshots.
 */

import {
  arrayCodec,
  codecFor,
  type Codec,
  type RuntimeCodec,
} from "../query/codecs";

export const COLUMN_CODEC = Symbol("symmetria.column.codec");

/** Type-level metadata carried by every column. Kept flat and minimal on purpose:
 *  every extra field here multiplies type instantiations across the whole schema. */
export type ColumnMetadata = {
  valueType: unknown;
  notNull: boolean;
  hasDefault: boolean;
  generated?: boolean | undefined;
  primaryKey?: boolean | undefined;
  computed?: boolean | undefined;
};

export type ColumnDefault =
  | { kind: "value"; value: unknown }
  | { kind: "sql"; sql: string };

export type ColumnDefinition = {
  sqlType: string;
  notNull: boolean;
  unique: boolean;
  primaryKey: boolean;
  index?: boolean;
  default?: ColumnDefault;
  enumerationValues?: readonly string[];
};

declare const COLUMN_METADATA: unique symbol;
declare const VALUE_BRAND: unique symbol;
export type Branded<Value, Name extends string> = Value & {
  readonly [VALUE_BRAND]: Name;
};

export interface Column<Metadata extends ColumnMetadata = ColumnMetadata> {
  readonly [COLUMN_METADATA]?: Metadata;
  readonly kind: "column";
  readonly definition: ColumnDefinition;
  readonly [COLUMN_CODEC]?: RuntimeCodec;
  readonly nullable: Column<
    Omit<Metadata, "notNull"> & {
      notNull: false;
    }
  >;
  readonly unique: Column<Metadata & { unique: true }>;
  readonly index: Column<Metadata>;
  readonly primaryKey: Column<Metadata & { primaryKey: true }>;
  /** PostgreSQL array of this type (`text.array` → `text[]`, `string[]`). */
  readonly array: Column<{
    valueType: Metadata["valueType"][];
    notNull: Metadata["notNull"];
    hasDefault: false;
  }>;
  readonly brand: <const Name extends string>(
    name: Name,
  ) => Column<
    Omit<Metadata, "valueType"> & {
      valueType: Branded<Metadata["valueType"], Name>;
    }
  >;
  default(
    value:
      | Metadata["valueType"]
      | (Metadata["notNull"] extends false ? null : never)
      | { kind: "sql"; sql: string },
  ): Column<
    Omit<Metadata, "hasDefault" | "generated"> & {
      hasDefault: true;
    }
  >;
}

type DefinitionTransform = (definition: ColumnDefinition) => ColumnDefinition;

const defineGetter = (
  target: object,
  name: string,
  get: () => unknown,
): void => {
  Object.defineProperty(target, name, {
    get,
    enumerable: false,
    configurable: false,
  });
};

/** Marks a column builder function so a schema can explain `price: jsonb` instead of `price: jsonb()`. */
export const COLUMN_BUILDER = Symbol("symmetria.column.builder");

const markBuilder = <Builder extends object>(
  builder: Builder,
  example: string,
): Builder =>
  Object.defineProperty(builder, COLUMN_BUILDER, {
    value: example,
    enumerable: false,
  });

/** The usage example recorded on a marked builder, or undefined. */
export const builderExample = (value: unknown): string | undefined =>
  typeof value === "function" && COLUMN_BUILDER in value
    ? String((value as Record<symbol, unknown>)[COLUMN_BUILDER])
    : undefined;

const makeColumn = (
  definition: ColumnDefinition,
  extras: Record<string, DefinitionTransform> = {},
  codec?: RuntimeCodec,
  call?: (...argumentsList: never[]) => Column,
): Column => {
  // A callable column (`numeric` / `numeric(10, 2)`) is built onto its function.
  const column = Object.assign(call ?? {}, {
    kind: "column" as const,
    definition: Object.freeze({ ...definition }),
    ...(codec ? { [COLUMN_CODEC]: codec } : {}),
    brand: (name: string) => {
      if (!name) {
        throw new Error("symmetria: brand() requires a name");
      }

      return column;
    },
  });

  const chain = (nextDefinition: ColumnDefinition) =>
    makeColumn(nextDefinition, extras, codec);

  defineGetter(column, "nullable", () =>
    chain({ ...definition, notNull: false }),
  );
  defineGetter(column, "unique", () => chain({ ...definition, unique: true }));
  defineGetter(column, "index", () => chain({ ...definition, index: true }));
  defineGetter(column, "primaryKey", () =>
    chain({ ...definition, primaryKey: true }),
  );
  defineGetter(column, "array", () => {
    if (definition.enumerationValues || definition.sqlType.endsWith("[]")) {
      throw new Error(
        "symmetria: arrays are available for scalar, non-enum column types",
      );
    }

    if (/^vector(\(|$)/.test(definition.sqlType)) {
      throw new Error("symmetria: vector columns cannot be arrays");
    }

    if (
      definition.default?.kind === "sql" &&
      definition.default.sql === "identity"
    ) {
      throw new Error("symmetria: identity columns cannot be arrays");
    }

    return makeColumn(
      {
        sqlType: `${definition.sqlType}[]`,
        notNull: definition.notNull,
        unique: false,
        primaryKey: false,
      },
      {},
      arrayCodec(definition.sqlType, codec ?? codecFor(definition.sqlType)),
    );
  });

  for (const [name, transform] of Object.entries(extras)) {
    defineGetter(column, name, () => chain(transform(definition)));
  }

  Object.defineProperty(column, "default", {
    value: (value: unknown) => {
      const isSql =
        typeof value === "object" &&
        value !== null &&
        (value as { kind?: string }).kind === "sql";

      return chain({
        ...definition,
        default: isSql
          ? { kind: "sql", sql: (value as { sql: string }).sql }
          : { kind: "value", value },
      });
    },
    enumerable: false,
  });

  return Object.freeze(column) as Column;
};

const base = (
  sqlType: string,
  extras?: Record<string, DefinitionTransform>,
): Column => {
  return makeColumn(
    { sqlType, notNull: true, unique: false, primaryKey: false },
    extras,
  );
};

/** Internal literal-only SQL defaults, used by uuid and timestamp builders. */
export const sql = (
  strings: TemplateStringsArray,
  ...values: never[]
): { kind: "sql"; sql: string } => {
  void values;

  return { kind: "sql", sql: strings.join("") };
};

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface UuidColumn
  extends Column<{
    valueType: string;
    notNull: true;
    hasDefault: false;
  }> {
  /** default gen_random_uuid() */
  readonly v4: Column<{ valueType: string; notNull: true; hasDefault: true }>;
  /** default uuidv7() (PostgreSQL 18+) */
  readonly v7: Column<{ valueType: string; notNull: true; hasDefault: true }>;
}

interface IntegerColumn
  extends Column<{
    valueType: number;
    notNull: true;
    hasDefault: false;
  }> {
  /** GENERATED ALWAYS AS IDENTITY */
  readonly auto: Column<{
    valueType: number;
    notNull: true;
    hasDefault: true;
    generated: true;
  }>;
}

interface BigintColumn
  extends Column<{
    valueType: bigint;
    notNull: true;
    hasDefault: false;
  }> {
  /** GENERATED ALWAYS AS IDENTITY */
  readonly auto: Column<{
    valueType: bigint;
    notNull: true;
    hasDefault: true;
    generated: true;
  }>;
}

interface TimestampWithTimeZoneColumn
  extends Column<{
    valueType: Date;
    notNull: true;
    hasDefault: false;
  }> {
  /** default now() */
  readonly now: Column<{ valueType: Date; notNull: true; hasDefault: true }>;
}

export const uuid = base("uuid", {
  v4: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: "gen_random_uuid()" },
  }),
  v7: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: "uuidv7()" },
  }),
}) as UuidColumn;

export const text = base("text") as Column<{
  valueType: string;
  notNull: true;
  hasDefault: false;
}>;

export const int = base("integer", {
  auto: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: "identity" },
  }),
}) as IntegerColumn;

export const bigint = base("bigint", {
  auto: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: "identity" },
  }),
}) as BigintColumn;

export const bool = base("boolean") as Column<{
  valueType: boolean;
  notNull: true;
  hasDefault: false;
}>;

type NumberColumn = Column<{
  valueType: number;
  notNull: true;
  hasDefault: false;
}>;
type StringColumn = Column<{
  valueType: string;
  notNull: true;
  hasDefault: false;
}>;

/** 16-bit integer; `smallint.auto` is an identity column like `int.auto`. */
export const smallint = base("smallint", {
  auto: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: "identity" },
  }),
}) as IntegerColumn;
/** Single-precision float; `NaN` and `±Infinity` round-trip. */
export const real = base("real") as NumberColumn;
/** Double-precision float; `NaN` and `±Infinity` round-trip. */
export const doublePrecision = base("double precision") as NumberColumn;
/** Calendar date as `YYYY-MM-DD` text: no time zone shifts on either driver. */
export const date = base("date") as StringColumn;
/** Time of day as `HH:MM:SS[.ffffff]` text. */
export const time = base("time") as StringColumn;
/** Interval in PostgreSQL's text form, such as `1 day 02:00:00`. */
export const interval = base("interval") as StringColumn;
/** Binary data as `Uint8Array`. */
export const bytea = base("bytea") as Column<{
  valueType: Uint8Array;
  notNull: true;
  hasDefault: false;
}>;
/** IPv4 or IPv6 address as text, such as `10.0.0.1` or `::1/128`. */
export const inet = base("inet") as StringColumn;

export const timestamptz = base("timestamptz", {
  now: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: "now()" },
  }),
}) as TimestampWithTimeZoneColumn;

type VarcharMetadata = { valueType: string; notNull: true; hasDefault: false };
/** `varchar` alone is PostgreSQL `character varying` without a limit; `varchar(255)` sets one. */
export type VarcharColumn = Column<VarcharMetadata> &
  ((length: number) => Column<VarcharMetadata>);

export const varchar: VarcharColumn = makeColumn(
  { sqlType: "varchar", notNull: true, unique: false, primaryKey: false },
  {},
  undefined,
  (length: number) => {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error("symmetria: varchar length must be a positive integer");
    }

    return base(`varchar(${length})`);
  },
) as VarcharColumn;

/** Minimal Standard Schema contract (https://standardschema.dev): Zod, Valibot, ArkType and friends. */
export type StandardSchema<Output = unknown> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  };
};
// Matches the Standard Schema V1 spec, whose optional members include undefined
// (required for compatibility under exactOptionalPropertyTypes).
type StandardIssue = {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
};
type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };
export type StandardOutput<Schema> =
  Schema extends StandardSchema<infer Output> ? Output : never;

type JsonbColumn<Value> = Column<{
  valueType: Value;
  notNull: true;
  hasDefault: false;
}>;

const formatIssue = (issue: StandardIssue): string => {
  const path = (issue.path ?? [])
    .map((segment) =>
      String(
        typeof segment === "object" && segment !== null && "key" in segment
          ? segment.key
          : segment,
      ),
    )
    .join(".");

  return path ? `${path}: ${issue.message}` : issue.message;
};

/**
 * `jsonb<Value>()` trusts the type; `jsonb(schema)` validates every written and
 * read value with a Standard Schema and infers the value type from it.
 */
export const jsonb: {
  <Value>(): JsonbColumn<Value>;
  <Schema extends StandardSchema>(
    schema: Schema,
  ): JsonbColumn<StandardOutput<Schema>>;
} = <Value>(schema?: StandardSchema): JsonbColumn<Value> => {
  if (!schema) {
    return base("jsonb") as JsonbColumn<Value>;
  }

  if (typeof schema["~standard"]?.validate !== "function") {
    throw new Error("symmetria: jsonb() expects a Standard Schema object");
  }

  const validate = (value: unknown): unknown => {
    const result = schema["~standard"].validate(value);

    if (result instanceof Promise) {
      throw new Error("symmetria: jsonb() schemas must validate synchronously");
    }

    if (result.issues) {
      throw new Error(
        `symmetria: invalid jsonb value: ${result.issues.map(formatIssue).join("; ")}`,
      );
    }

    return result.value;
  };

  return makeColumn(
    { sqlType: "jsonb", notNull: true, unique: false, primaryKey: false },
    {},
    Object.freeze({
      encode: (value: unknown) => JSON.stringify(validate(value)),
      decode: validate,
      parameterCast: "jsonb" as const,
    }),
  ) as JsonbColumn<Value>;
};

// The call form preserves enum labels as a literal union through a const type parameter.

type EnumerationColumn<Value extends string> = Column<{
  valueType: Value;
  notNull: true;
  hasDefault: false;
}>;

export const oneOf = <const Values extends readonly [string, ...string[]]>(
  ...values: Values
): EnumerationColumn<Values[number]> => {
  return makeColumn({
    sqlType: "enum",
    notNull: true,
    unique: false,
    primaryKey: false,
    enumerationValues: values,
  }) as EnumerationColumn<Values[number]>;
};

export const isColumn = (value: unknown): value is Column => {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (value as { kind?: unknown }).kind === "column"
  );
};

type NumericMetadata = { valueType: string; notNull: true; hasDefault: false };
/** `numeric` alone is unconstrained; `numeric(10, 2)` fixes precision and scale. */
export type NumericColumn = Column<NumericMetadata> &
  ((precision?: number, scale?: number) => Column<NumericMetadata>);

/** PostgreSQL numeric is lossless decimal text at the JavaScript boundary. */
export const numeric: NumericColumn = makeColumn(
  { sqlType: "numeric", notNull: true, unique: false, primaryKey: false },
  {},
  undefined,
  (precision?: number, scale?: number) => {
    if (
      precision !== undefined &&
      (!Number.isInteger(precision) || precision < 1 || precision > 1000)
    ) {
      throw new Error(
        "symmetria: numeric precision must be between 1 and 1000",
      );
    }

    if (
      scale !== undefined &&
      (precision === undefined ||
        !Number.isInteger(scale) ||
        scale < 0 ||
        scale > precision)
    ) {
      throw new Error(
        "symmetria: numeric scale must be between zero and precision",
      );
    }

    return base(
      precision === undefined
        ? "numeric"
        : `numeric(${precision}${scale === undefined ? "" : `,${scale}`})`,
    );
  },
) as NumericColumn;

export const customType = <Value>(
  sqlType: string,
  codec: Codec<Value>,
): Column<{ valueType: Value; notNull: true; hasDefault: false }> =>
  makeColumn(
    { sqlType, notNull: true, unique: false, primaryKey: false },
    {},
    Object.freeze({ ...codec, sqlType }),
  ) as Column<{ valueType: Value; notNull: true; hasDefault: false }>;

/** A stored full-text document; `search()` and `searchRank()` use it directly, without `to_tsvector()`. */
export type TsVector = Branded<string, "tsvector">;

/**
 * `tsvector` column. Write it with `sql.of(tsvector)\`to_tsvector('english', ${title})\``
 * or keep it current with a trigger; read values are PostgreSQL's lexeme text.
 */
export const tsvector = customType<TsVector>("tsvector", {
  encode: (value) => value,
  decode: (value) => String(value) as TsVector,
});

/** A pgvector embedding; declared with `vector(n)` from `symmetria/vector`, written as `number[]`. */
export type Vector = Branded<number[], "vector">;

/**
 * A column whose codec also controls parameter casts; for package entries such as
 * `symmetria/vector`. Not part of the public API.
 * @internal
 */
export const typedColumn = <Value>(
  sqlType: string,
  codec: RuntimeCodec,
): Column<{ valueType: Value; notNull: true; hasDefault: false }> =>
  makeColumn(
    { sqlType, notNull: true, unique: false, primaryKey: false },
    {},
    Object.freeze({ ...codec, sqlType: codec.sqlType ?? sqlType }),
  ) as Column<{ valueType: Value; notNull: true; hasDefault: false }>;

markBuilder(jsonb, "jsonb<Value>() or jsonb(standardSchema)");
markBuilder(oneOf, 'oneOf("draft", "published")');
markBuilder(customType, 'customType<Value>("sql_type", { encode, decode })');
