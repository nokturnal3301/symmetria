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
  /** What writes accept when it differs from what reads return: a jsonb(schema)'s input. */
  inputType?: unknown;
  /**
   * How values compute when it is not by their type alone: `"float"` for real
   * and double precision, `"json"` for jsonb, `"raw"` for a computed `sql<Value>`.
   */
  numeric?: "float" | "json" | "raw" | undefined;
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
  /** PostgreSQL type name set with `oneOf(...).typeName()`; otherwise derived from the table and column. */
  enumerationName?: string;
  /** Collation set with `.collate()`; absent when the type's default applies. */
  collation?: string;
  /** SQL name set with `.named()`; otherwise the schema key decides it. */
  sqlName?: string;
};

/** The value a column stores and accepts on write: its input type when it declares one. */
export type ColumnInputType<Metadata extends ColumnMetadata> =
  Metadata extends {
    inputType: infer Input;
  }
    ? Input
    : Metadata["valueType"];

/**
 * The query traits of a column (see `ColumnTraits` in the query expressions):
 * how its values compute and, for a jsonb(schema), the input form it stores.
 */
export type MetadataTraits<Metadata> = (Metadata extends {
  numeric: infer Numeric;
}
  ? { readonly numeric: Numeric }
  : {}) &
  (Metadata extends { inputType: infer Input }
    ? { readonly stored: Input }
    : {});

/** Column metadata carrying an expression's query traits, for computed fields. */
export type TraitsMetadata<Traits> = (Traits extends {
  readonly numeric: infer Numeric extends "float" | "json" | "raw";
}
  ? { numeric: Numeric }
  : {}) &
  (Traits extends { readonly stored: infer Stored }
    ? { inputType: Stored }
    : {});

declare const COLUMN_METADATA: unique symbol;
declare const VALUE_BRAND: unique symbol;
export type Branded<Value, Name extends string> = Value & {
  readonly [VALUE_BRAND]: Name;
};

type BrandName<Value> = Value extends { readonly [VALUE_BRAND]: infer Name }
  ? Name
  : never;
/**
 * Whether a value type is decimal text, `${number}` or a brand of it: what
 * `numeric` columns, sums and decimal arithmetic hold. String literals that
 * merely look numeric, such as an enum label `"1"`, are not.
 */
export type IsDecimalText<Value> = [Value] extends [`${number}`]
  ? [
      `${number}` &
        ([BrandName<Value>] extends [never]
          ? unknown
          : { readonly [VALUE_BRAND]: BrandName<Value> }),
    ] extends [Value]
    ? true
    : false
  : false;

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
  /**
   * PostgreSQL array of this type (`text.array` → `text[]`, `string[]`); its
   * elements compute like the column (JSON elements as JSON).
   */
  readonly array: Column<
    {
      valueType: Metadata["valueType"][];
      notNull: Metadata["notNull"];
      hasDefault: false;
    } & (Metadata extends { numeric: infer Numeric }
      ? { numeric: Numeric }
      : {})
  >;
  readonly brand: <const Name extends string>(
    name: Name,
  ) => Column<
    Omit<Metadata, "valueType"> & {
      valueType: Branded<Metadata["valueType"], Name>;
    }
  >;
  /** The column's SQL name when the key should not decide it, such as `"createdAt"`. */
  named(sqlName: string): Column<Metadata>;
  /**
   * The column's collation, such as `text.collate("C")` for byte-order comparison
   * and sorting; text-like columns only (other types throw).
   */
  collate(collation: string): Column<Metadata>;
  default(
    value:
      | ColumnInputType<Metadata>
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

/** The sentinel SQL defaults of identity columns: `int.auto` and `int.auto.byDefault`. */
export const IDENTITY_ALWAYS = "identity";
export const IDENTITY_BY_DEFAULT = "identity by default";

/** Whether a column default declares an identity column, of either generation. */
export const isIdentityDefault = (value: ColumnDefault | undefined): boolean =>
  value?.kind === "sql" &&
  (value.sql === IDENTITY_ALWAYS || value.sql === IDENTITY_BY_DEFAULT);

/** Built-in types without collations; `collate()` rejects them. */
const NOT_COLLATABLE =
  /^(enum|integer|bigint|smallint|real|double precision|boolean|uuid|timestamptz|timestamp|date|time|interval|bytea|inet|jsonb|json|numeric|tsvector|vector)(\(|\[|$)/;

/** A name PostgreSQL accepts for a type or collation: nonempty, no null bytes, at most 63 bytes. */
const validName = (name: unknown): name is string =>
  typeof name === "string" &&
  !!name &&
  !name.includes("\0") &&
  Buffer.byteLength(name) <= 63;

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

    if (isIdentityDefault(definition.default)) {
      throw new Error("symmetria: identity columns cannot be arrays");
    }

    return makeColumn(
      {
        sqlType: `${definition.sqlType}[]`,
        notNull: definition.notNull,
        unique: false,
        primaryKey: false,
        ...(definition.sqlName !== undefined
          ? { sqlName: definition.sqlName }
          : {}),
        ...(definition.collation !== undefined
          ? { collation: definition.collation }
          : {}),
      },
      {},
      arrayCodec(definition.sqlType, codec ?? codecFor(definition.sqlType)),
    );
  });

  for (const [name, transform] of Object.entries(extras)) {
    defineGetter(column, name, () => chain(transform(definition)));
  }

  Object.defineProperty(column, "named", {
    value: (sqlName: string) => {
      if (typeof sqlName !== "string" || !sqlName) {
        throw new Error("symmetria: named() expects the column's SQL name");
      }

      return chain({ ...definition, sqlName });
    },
    enumerable: false,
  });

  Object.defineProperty(column, "collate", {
    value: (collation: string) => {
      if (!validName(collation)) {
        throw new Error(
          'symmetria: collate() expects a collation name, such as "C"',
        );
      }

      if (
        definition.enumerationValues ||
        NOT_COLLATABLE.test(definition.sqlType)
      ) {
        throw new Error(
          `symmetria: collate() needs a text column; ${definition.sqlType} has no collation`,
        );
      }

      return chain({ ...definition, collation });
    },
    enumerable: false,
  });

  // Enum columns can name their PostgreSQL type, which several columns may share.
  if (definition.enumerationValues) {
    Object.defineProperty(column, "typeName", {
      value: (name: string) => {
        if (!validName(name)) {
          throw new Error(
            'symmetria: typeName() expects the enum type\'s SQL name, such as "Role"',
          );
        }

        return chain({ ...definition, enumerationName: name });
      },
      enumerable: false,
    });
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

/** `GENERATED ALWAYS AS IDENTITY`; `.byDefault` also accepts explicit values. */
interface IdentityColumn<Value>
  extends Column<{
    valueType: Value;
    notNull: true;
    hasDefault: true;
    generated: true;
  }> {
  /**
   * `GENERATED BY DEFAULT AS IDENTITY`: inserts may supply their own value, as
   * with `serial`, so code that writes explicit ids keeps working.
   */
  readonly byDefault: Column<{
    valueType: Value;
    notNull: true;
    hasDefault: true;
  }>;
}

interface IntegerColumn
  extends Column<{
    valueType: number;
    notNull: true;
    hasDefault: false;
  }> {
  /** GENERATED ALWAYS AS IDENTITY */
  readonly auto: IdentityColumn<number>;
}

interface BigintColumn
  extends Column<{
    valueType: bigint;
    notNull: true;
    hasDefault: false;
  }> {
  /** GENERATED ALWAYS AS IDENTITY */
  readonly auto: IdentityColumn<bigint>;
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

/** `.auto` and `.auto.byDefault` of the integer builders. */
const identityExtras: Record<string, DefinitionTransform> = {
  auto: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: IDENTITY_ALWAYS },
  }),
  byDefault: (definition) => {
    if (!isIdentityDefault(definition.default)) {
      throw new Error(
        "symmetria: byDefault follows auto, as in int.auto.byDefault",
      );
    }

    return {
      ...definition,
      default: { kind: "sql", sql: IDENTITY_BY_DEFAULT },
    };
  },
};

export const int = base("integer", identityExtras) as IntegerColumn;

export const bigint = base("bigint", identityExtras) as BigintColumn;

export const bool = base("boolean") as Column<{
  valueType: boolean;
  notNull: true;
  hasDefault: false;
}>;

/** Floats compute in double precision: dividing one keeps the fraction as a number. */
type FloatColumn = Column<{
  valueType: number;
  numeric: "float";
  notNull: true;
  hasDefault: false;
}>;
type StringColumn = Column<{
  valueType: string;
  notNull: true;
  hasDefault: false;
}>;

/** 16-bit integer; `smallint.auto` is an identity column like `int.auto`. */
export const smallint = base("smallint", identityExtras) as IntegerColumn;
/** Single-precision float; `NaN` and `±Infinity` round-trip. */
export const real = base("real") as FloatColumn;
/** Double-precision float; `NaN` and `±Infinity` round-trip. */
export const doublePrecision = base("double precision") as FloatColumn;
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

const nowDefault: Record<string, DefinitionTransform> = {
  now: (definition) => ({
    ...definition,
    default: { kind: "sql", sql: "now()" },
  }),
};

/** A timestamp builder usable bare (`timestamptz`) or with fractional-second precision (`timestamptz(3)`). */
const timestampBuilder = (sqlType: "timestamptz" | "timestamp") =>
  makeColumn(
    { sqlType, notNull: true, unique: false, primaryKey: false },
    nowDefault,
    undefined,
    (precision?: number) => {
      if (
        precision !== undefined &&
        (!Number.isInteger(precision) || precision < 0 || precision > 6)
      ) {
        throw new Error(
          `symmetria: ${sqlType} precision must be an integer between 0 and 6`,
        );
      }

      return base(
        precision === undefined ? sqlType : `${sqlType}(${precision})`,
        nowDefault,
      );
    },
  );

/** `timestamp with time zone`, read as a `Date`. */
export type TimestamptzColumn = TimestampWithTimeZoneColumn &
  ((precision?: number) => TimestampWithTimeZoneColumn);

export const timestamptz = timestampBuilder("timestamptz") as TimestamptzColumn;

/**
 * `timestamp without time zone`, read and written as UTC `Date` values: the
 * convention of Prisma, Drizzle and Rails, and what Bun.SQL already does.
 * `timestamp(3)` sets millisecond precision, as Prisma declares it.
 */
export const timestamp = timestampBuilder("timestamp") as TimestamptzColumn;

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
export type StandardSchema<Output = unknown, Input = unknown> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    /** Type-only: the schema's input and output, when it declares them. */
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
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
/** The `value` of `validate`'s successful results; a failure result widened with `value?: undefined` adds nothing. */
type ValidatedOutput<Schema> = Schema extends {
  readonly "~standard": { readonly validate: (value: unknown) => infer Result };
}
  ? Exclude<Awaited<Result>, { readonly issues: readonly unknown[] }> extends {
      readonly value: infer Output;
    }
    ? Output
    : never
  : never;
/** The value a schema returns after its transforms: its declared output type, else what `validate` returns. */
export type StandardOutput<Schema> = Schema extends {
  readonly "~standard": { readonly types?: infer Types };
}
  ? NonNullable<Types> extends { readonly output: infer Output }
    ? Output
    : ValidatedOutput<Schema>
  : ValidatedOutput<Schema>;
/** The value a schema validates before its transforms; its output when it declares no input type. */
export type StandardInput<Schema> = Schema extends {
  readonly "~standard": { readonly types?: infer Types };
}
  ? NonNullable<Types> extends { readonly input: infer Input }
    ? Input
    : StandardOutput<Schema>
  : StandardOutput<Schema>;

/** JSON values compute in double precision and order as jsonb. */
type JsonbColumn<Value> = Column<{
  valueType: Value;
  numeric: "json";
  notNull: true;
  hasDefault: false;
}>;
/**
 * Reads return the schema's output; writes, filters, `contains()` and paths
 * take its input, which is what is stored.
 */
type SchemaJsonbColumn<Schema> = Column<{
  valueType: StandardOutput<Schema>;
  inputType: StandardInput<Schema>;
  numeric: "json";
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
 * read value with a Standard Schema. The database stores the schema's input
 * form: a write is validated but stored as given, so transforms run once, on
 * read, and reads return the schema's output.
 */
export const jsonb: {
  <Value>(): JsonbColumn<Value>;
  <Schema extends StandardSchema>(schema: Schema): SchemaJsonbColumn<Schema>;
} = (schema?: StandardSchema): never => {
  if (!schema) {
    return base("jsonb") as never;
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
      // Storing the output would run the transforms again on every read.
      encode: (value: unknown) => {
        validate(value);

        return JSON.stringify(value);
      },
      decode: validate,
      parameterCast: "jsonb" as const,
    }),
  ) as never;
};

// The call form preserves enum labels as a literal union through a const type parameter.

export interface EnumerationColumn<Value extends string>
  extends Column<{
    valueType: Value;
    notNull: true;
    hasDefault: false;
  }> {
  /**
   * The PostgreSQL type's name, such as Prisma's `"Role"`; without it the type is
   * `<table>_<column>_enum`. Columns naming the same type share one, so their
   * labels must match.
   */
  typeName(name: string): EnumerationColumn<Value>;
}

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

/** Decimal text (`"202.10"`), kept exact; see `Decimal`. */
type NumericMetadata = {
  valueType: `${number}`;
  notNull: true;
  hasDefault: false;
};
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
