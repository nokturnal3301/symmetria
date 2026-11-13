/**
 * Row inference for standalone table() declarations, used by index, check and
 * computed callbacks. Public schema and query inference lives in model.ts and query/select/types.ts.
 * NonNullable removes optionality allowed by the ColumnInput type;
 * undefined definitions are rejected during runtime schema assembly.
 */

import type {
  ColumnInputType,
  ColumnMetadata,
  Column,
  IsDecimalText,
  MetadataTraits,
  Vector,
} from "./column";
import type { UpdateValues } from "../query/write/mutations";
import type {
  PrimaryKeyNames,
  ReferenceBuilder,
  ReferenceFlags,
  SelfReference,
  Table,
} from "./table";

type Flatten<Value> = {
  [PropertyName in keyof Value]: Value[PropertyName];
} & {};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type ReadColumn<Columns, ColumnName extends keyof Columns> = NonNullable<
  Columns[ColumnName]
>;

type ColumnMetadataOf<Definition> =
  Definition extends Column<infer Metadata> ? Metadata : never;

type ScalarColumnNames<Columns> = {
  [ColumnName in keyof Columns & string]: ReadColumn<
    Columns,
    ColumnName
  > extends { kind: "column" }
    ? ColumnName
    : never;
}[keyof Columns & string];

type ReferenceColumnNames<Columns> = Exclude<
  keyof Columns & string,
  ScalarColumnNames<Columns>
>;

type ColumnValue<Definition> =
  ColumnMetadataOf<Definition> extends infer Metadata extends ColumnMetadata
    ? Metadata["notNull"] extends true
      ? Metadata["valueType"]
      : Metadata["valueType"] | null
    : never;

/** What a write accepts: a jsonb(schema)'s input type, otherwise the read type. */
type ColumnWriteValue<Definition> =
  ColumnMetadataOf<Definition> extends infer Metadata extends ColumnMetadata
    ? Metadata["notNull"] extends true
      ? ColumnInputType<Metadata>
      : ColumnInputType<Metadata> | null
    : never;

/**
 * The query traits of the columns that have any (float and jsonb columns, a
 * jsonb(schema)'s stored input), so query columns compute and compare like the
 * SQL columns. References and other columns have none.
 */
export type TableTraits<Columns> = {
  [ColumnName in keyof Columns & string as ReadColumn<
    Columns,
    ColumnName
  > extends Column<infer Metadata>
    ? Metadata extends { numeric: unknown } | { inputType: unknown }
      ? ColumnName
      : never
    : never]: MetadataTraits<ColumnMetadataOf<ReadColumn<Columns, ColumnName>>>;
};

// ---------------------------------------------------------------------------
// Reference targets
// ---------------------------------------------------------------------------

type TargetColumnsOf<Value, SelfColumns> =
  Value extends Table<infer Columns>
    ? Columns
    : Value extends () => Table<infer Columns>
      ? Columns
      : Value extends SelfReference<ReferenceFlags>
        ? SelfColumns
        : Value extends ReferenceBuilder<infer Columns, ReferenceFlags>
          ? Columns
          : never;

type ReferenceFlagsOf<Value> =
  Value extends ReferenceBuilder<Record<string, unknown>, infer Flags>
    ? Flags
    : Value extends SelfReference<infer Flags>
      ? Flags
      : {};

type PrimaryKeyType<Columns> = ColumnMetadataOf<
  ReadColumn<Columns, PrimaryKeyNames<Columns>[number] & keyof Columns>
>["valueType"];

type ReferenceTarget<
  Columns,
  ColumnName extends keyof Columns,
> = TargetColumnsOf<ReadColumn<Columns, ColumnName>, Columns>;

/** The value a reference stores: the target's primary key, or its `by()` column. */
type ReferencedType<Columns, ColumnName extends keyof Columns> =
  ReferenceFlagsOf<ReadColumn<Columns, ColumnName>> extends {
    by: infer By extends string;
  }
    ? ReferenceTarget<Columns, ColumnName>[By &
        keyof ReferenceTarget<Columns, ColumnName>] extends Column<
        infer Metadata
      >
      ? Metadata["valueType"]
      : unknown
    : PrimaryKeyType<ReferenceTarget<Columns, ColumnName>>;

// ---------------------------------------------------------------------------
// Write values
// ---------------------------------------------------------------------------

/** Writes accept safe integers wherever a column stores bigint, plain arrays for vectors and strings for decimals. */
export type WriteValue<Value> = [NonNullable<Value>] extends [never]
  ? Value
  : NonNullable<Value> extends Vector
    ? Value | readonly number[]
    : IsDecimalText<NonNullable<Value>> extends true
      ? // Decimal columns read exact text and accept any string on write.
        Value | string
      : NonNullable<Value> extends readonly (infer Element)[]
        ? IsDecimalText<Element> extends true
          ? Value | readonly (string | null)[]
          :
              | Value
              | (NonNullable<Value> extends readonly bigint[]
                  ? (bigint | number)[]
                  : never)
        : Value | (bigint extends NonNullable<Value> ? number : never);
export type Writable<Shape> = {
  [PropertyName in keyof Shape]: WriteValue<Shape[PropertyName]>;
} & {};
/** Optional write fields also accept `undefined`, which means "omitted". */
export type Omittable<Shape> = {
  [PropertyName in keyof Shape]?: Shape[PropertyName] | undefined;
};

// ---------------------------------------------------------------------------
// Row / Insert
// ---------------------------------------------------------------------------

/** The row a read returns; with `Write`, the values a write accepts. */
export type RowOf<Columns, Write extends boolean = false> = Flatten<
  {
    [ColumnName in ScalarColumnNames<Columns>]: Write extends true
      ? ColumnWriteValue<ReadColumn<Columns, ColumnName>>
      : ColumnValue<ReadColumn<Columns, ColumnName>>;
  } & {
    [ColumnName in ReferenceColumnNames<Columns> as `${ColumnName}Id`]: ReferenceFlagsOf<
      ReadColumn<Columns, ColumnName>
    > extends {
      nullable: true;
    }
      ? ReferencedType<Columns, ColumnName> | null
      : ReferencedType<Columns, ColumnName>;
  }
>;

type OptionalNamesOf<Columns> = {
  [ColumnName in keyof Columns & string]: ReadColumn<
    Columns,
    ColumnName
  > extends { kind: "column" }
    ? ColumnMetadataOf<
        ReadColumn<Columns, ColumnName>
      >["hasDefault"] extends true
      ? ColumnName
      : ColumnMetadataOf<
            ReadColumn<Columns, ColumnName>
          >["notNull"] extends false
        ? ColumnName
        : never
    : ReferenceFlagsOf<ReadColumn<Columns, ColumnName>> extends {
          nullable: true;
        }
      ? `${ColumnName}Id`
      : never;
}[keyof Columns & string];

type GeneratedNamesOf<Columns> = {
  [ColumnName in ScalarColumnNames<Columns>]: ColumnMetadataOf<
    ReadColumn<Columns, ColumnName>
  > extends { generated: true } | { computed: true }
    ? ColumnName
    : never;
}[ScalarColumnNames<Columns>];

/** Insert input for a standalone table(): defaults, nullable fields and nullable references are optional. */
export type InsertOf<Columns> = Writable<
  Omit<
    RowOf<Columns, true>,
    OptionalNamesOf<Columns> | GeneratedNamesOf<Columns>
  > &
    Omittable<
      Pick<
        RowOf<Columns, true>,
        Exclude<OptionalNamesOf<Columns>, GeneratedNamesOf<Columns>> &
          keyof RowOf<Columns, true>
      >
    > & { [ColumnName in GeneratedNamesOf<Columns>]?: undefined }
>;

/** The row type of a schema table (`Infer<typeof db.users>`) or a standalone table (`Infer<typeof users>`). */
export type Infer<Source> = Source extends { readonly $row: infer Row }
  ? Row
  : Source extends Table<infer Columns>
    ? RowOf<Columns>
    : never;

/** The insert input of a schema table or a standalone table. */
export type InferInsert<Source> = Source extends {
  readonly $insert: infer Input;
}
  ? Input
  : Source extends Table<infer Columns>
    ? InsertOf<Columns>
    : never;

/** The `update()` / `doUpdate()` input: every insert field optional, SQL expressions and `defaultValue` allowed. */
export type InferUpdate<Source> =
  InferInsert<Source> extends infer Input extends Record<string, unknown>
    ? UpdateValues<Input>
    : never;
