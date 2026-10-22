/**
 * Row inference for standalone table() declarations, used by index, check and
 * computed callbacks. Public schema and query inference lives in model.ts and select.ts.
 * NonNullable removes optionality allowed by the ColumnInput type;
 * undefined definitions are rejected during runtime schema assembly.
 */

import type { ColumnMetadata, Column } from "./column";
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
      ? PrimaryKeyType<ReferenceTarget<Columns, ColumnName>> | null
      : PrimaryKeyType<ReferenceTarget<Columns, ColumnName>>;
  }
>;
