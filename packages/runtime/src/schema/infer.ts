/**
 * Row inference for standalone table() declarations, used by index, check and
 * computed callbacks. Public schema and query inference lives in model.ts and query/select/types.ts.
 * NonNullable removes optionality allowed by the ColumnInput type;
 * undefined definitions are rejected during runtime schema assembly.
 */

import type { ColumnMetadata, Column, Vector } from "./column";
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

/** Writes accept safe integers wherever a column stores bigint, and plain arrays for vectors. */
export type WriteValue<Value> = [NonNullable<Value>] extends [never]
  ? Value
  : NonNullable<Value> extends Vector
    ? Value | readonly number[]
    :
        | Value
        | (bigint extends NonNullable<Value> ? number : never)
        | (NonNullable<Value> extends readonly bigint[]
            ? (bigint | number)[]
            : never);
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

export type RowOf<Columns> = Flatten<
  {
    [ColumnName in ScalarColumnNames<Columns>]: ColumnValue<
      ReadColumn<Columns, ColumnName>
    >;
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
  Omit<RowOf<Columns>, OptionalNamesOf<Columns> | GeneratedNamesOf<Columns>> &
    Omittable<
      Pick<
        RowOf<Columns>,
        Exclude<OptionalNamesOf<Columns>, GeneratedNamesOf<Columns>> &
          keyof RowOf<Columns>
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
