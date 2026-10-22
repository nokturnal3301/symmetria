import { quoteIdentifier } from "symmetria/internal";
import type { IndexSnapshot, CheckSnapshot } from "symmetria";
import {
  objectName,
  quoteLiteral,
  type MigrationColumn,
  type MigrationTable,
} from "./snapshot";

export const columnTypeSQL = (column: MigrationColumn): string =>
  column.enumeration ? quoteIdentifier(column.enumeration) : column.sqlType;

export const enumerationSQL = (
  name: string,
  values: readonly string[],
): string =>
  `CREATE TYPE ${quoteIdentifier(name)} AS ENUM (${values.map(quoteLiteral).join(", ")})`;

export const columnSQL = (column: MigrationColumn): string =>
  `${quoteIdentifier(column.name)} ${columnTypeSQL(column)}${column.identity ? " GENERATED ALWAYS AS IDENTITY" : ""}${column.default === undefined ? "" : ` DEFAULT ${column.default}`}${column.notNull ? " NOT NULL" : ""}`;

export const primaryKeySQL = (table: MigrationTable): string =>
  `CONSTRAINT ${quoteIdentifier(objectName(table.name, "pkey"))} PRIMARY KEY (${table.primaryKey.map(quoteIdentifier).join(", ")})`;

export const uniqueSQL = (
  table: MigrationTable,
  column: MigrationColumn,
): string =>
  `CONSTRAINT ${quoteIdentifier(objectName(table.name, column.name, "key"))} UNIQUE (${quoteIdentifier(column.name)})`;

export const checkSQL = (definition: CheckSnapshot): string =>
  `CONSTRAINT ${quoteIdentifier(definition.sqlName)} CHECK (${definition.expression})`;

export const foreignKeySQL = (
  table: MigrationTable,
  column: MigrationColumn,
): string => {
  const reference = column.references!;

  return `ALTER TABLE ${quoteIdentifier(table.name)} ADD CONSTRAINT ${quoteIdentifier(objectName(table.name, column.name, "fkey"))} FOREIGN KEY (${quoteIdentifier(column.name)}) REFERENCES ${quoteIdentifier(reference.table)} (${quoteIdentifier(reference.column)}) ON DELETE ${reference.onDelete.toUpperCase()}`;
};

export const tableSQL = (table: MigrationTable): string => {
  const definitions = [
    ...table.columns.map(columnSQL),
    ...(table.primaryKey.length ? [primaryKeySQL(table)] : []),
    ...table.columns
      .filter((column) => column.unique)
      .map((column) => uniqueSQL(table, column)),
    ...(table.checks ?? []).map(checkSQL),
  ];

  return `CREATE TABLE ${quoteIdentifier(table.name)} (\n${definitions.map((definition) => `  ${definition}`).join(",\n")}\n)`;
};

export const indexSQL = (
  table: MigrationTable,
  definition: IndexSnapshot,
): string =>
  `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(definition.sqlName)} ON ${quoteIdentifier(table.name)} USING ${definition.method} (${definition.keys.join(", ")})${definition.include.length ? ` INCLUDE (${definition.include.join(", ")})` : ""}${definition.where === undefined ? "" : ` WHERE ${definition.where}`}`;
