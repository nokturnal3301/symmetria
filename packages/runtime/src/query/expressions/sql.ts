/**
 * The `sql` tag: raw SQL fragments with bound values.
 */
import { freeze } from "../plan/freeze";
import { booleanCodec, codecFor, type RuntimeCodec } from "../codecs";
import {
  COLUMN_CODEC,
  SQL_DEFAULT,
  type Column,
  type SqlDefault,
  type MetadataTraits,
} from "../../schema/column";
import type { ValueNode, ExpressionDescription } from "./nodes";
import type { QueryColumn } from "./column-types";
import { valueNode, ColumnHandle } from "./core";

export const SQL_TEMPLATE = Symbol("symmetria.query.sql");

export class SqlHandle extends ColumnHandle {
  readonly kind = "sql" as const;
  readonly [SQL_DEFAULT] = true as const;
  readonly [SQL_TEMPLATE]: {
    readonly strings: TemplateStringsArray;
    readonly interpolated: boolean;
  };

  constructor(
    description: ExpressionDescription,
    strings: TemplateStringsArray,
    interpolated: boolean,
  ) {
    super(description);
    this[SQL_TEMPLATE] = { strings, interpolated };
  }

  get sql(): string {
    if (this[SQL_TEMPLATE].interpolated) {
      throw new Error("symmetria: SQL defaults cannot contain interpolations");
    }

    return this[SQL_TEMPLATE].strings.join("");
  }
}

/** A `sql<Value>` template: its SQL type is whatever the SQL says, unknown to Symmetria. */
export type RawTraits = { readonly numeric: "raw" };

export type SqlTemplate<Value, Traits = RawTraits> = QueryColumn<
  Value,
  "expression",
  Traits
> &
  SqlDefault & {
    kind: "sql";
    sql: string;
  };

export const sqlTemplate = <Value, Traits = RawTraits>(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  codec?: RuntimeCodec,
  sqlType?: string,
): SqlTemplate<Value, Traits> => {
  const parts: (string | ValueNode)[] = [];
  strings.forEach((text, index) => {
    parts.push(text);

    if (index < values.length) {
      parts.push(valueNode(values[index]));
    }
  });

  return freeze(
    new SqlHandle(
      {
        node: freeze({
          kind: "raw",
          parts: freeze(parts),
          ...(sqlType ? { sqlType } : {}),
        }),
        outputName: "expression",
        ...(codec ? { codec } : {}),
      },
      strings,
      values.length > 0,
    ),
  ) as unknown as SqlTemplate<Value, Traits>;
};

export type ColumnResult<Definition> =
  Definition extends Column<infer Metadata>
    ? Metadata["notNull"] extends false
      ? Metadata["valueType"] | null
      : Metadata["valueType"]
    : never;

/** How a column's values compute and compare in SQL (see `ColumnTraits`). */
export type DefinitionTraits<Definition> =
  Definition extends Column<infer Metadata> ? MetadataTraits<Metadata> : {};

// Keep recursive column types named when this callable is included in ShapeTools.
export interface SqlTag {
  <Value = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlTemplate<Value>;
  /**
   * A template typed and decoded like a column, including driver-specific
   * codecs; arithmetic and comparisons treat it as that column's SQL type.
   */
  of: <Definition extends Column>(
    column: Definition,
  ) => (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => SqlTemplate<ColumnResult<Definition>, DefinitionTraits<Definition>>;
}

/** Interpolations are parameters or expression nodes; only the template's literal text is SQL. */
export const sql: SqlTag = Object.assign(
  <Value = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlTemplate<Value> => sqlTemplate<Value>(strings, values),
  {
    /**
     * A template typed and decoded like a column: `sql.of(bool)` returns booleans on every
     * driver, `sql.of(timestamptz)` returns Dates and `sql.of(bigint)` bigints.
     */
    of:
      <Definition extends Column>(column: Definition) =>
      (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): SqlTemplate<ColumnResult<Definition>, DefinitionTraits<Definition>> =>
        sqlTemplate<ColumnResult<Definition>, DefinitionTraits<Definition>>(
          strings,
          values,
          column[COLUMN_CODEC] ??
            (column.definition.sqlType === "boolean"
              ? booleanCodec
              : codecFor(column.definition.sqlType)),
          column.definition.sqlType,
        ),
  },
);
