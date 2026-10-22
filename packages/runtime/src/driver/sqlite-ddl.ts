import { quoteIdentifier } from "../query/compiler";
import {
  sqliteColumnType,
  sqliteDefaultSQL,
  sqliteLiteral,
} from "../query/dialect";
import type {
  ColumnSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "../schema/assembly";

const IDENTIFIER = /^"(?:[^"]|"")+"$/;

const columnSQL = (
  column: ColumnSnapshot,
  keys: readonly ColumnSnapshot[],
): string => {
  const identity =
    column.default?.kind === "sql" && column.default.sql === "identity";
  const singleKey = keys.length === 1 && keys[0] === column;
  const type = sqliteColumnType(column.sqlType);
  const parts = [quoteIdentifier(column.sqlName), type];

  if (singleKey) {
    parts.push(
      identity && type === "INTEGER"
        ? "PRIMARY KEY AUTOINCREMENT"
        : "PRIMARY KEY",
    );
  }

  if (column.notNull) {
    parts.push("NOT NULL");
  }

  if (column.unique && !singleKey) {
    parts.push("UNIQUE");
  }

  if (column.default && !identity) {
    parts.push(`DEFAULT ${sqliteDefaultSQL(column, sqliteLiteral)}`);
  }

  if (column.enumerationValues) {
    parts.push(
      `CHECK (${quoteIdentifier(column.sqlName)} IN (${column.enumerationValues.map(sqliteLiteral).join(", ")}))`,
    );
  }

  if (column.references) {
    parts.push(
      `REFERENCES ${quoteIdentifier(column.references.table)} (${quoteIdentifier(column.references.column)}) ON DELETE ${column.references.onDelete.toUpperCase()}`,
    );
  }

  return parts.join(" ");
};

const tableSQL = (table: TableSnapshot): string[] => {
  const keys = table.primaryKey
    ? table.primaryKey.map(
        (name) => table.columns.find((column) => column.sqlName === name)!,
      )
    : table.columns.filter((column) => column.primaryKey);
  const definitions = [
    ...table.columns.map((column) => columnSQL(column, keys)),
    ...(keys.length > 1
      ? [
          `PRIMARY KEY (${keys.map((column) => quoteIdentifier(column.sqlName)).join(", ")})`,
        ]
      : []),
  ];
  // Partial, expression and covering indexes keep PostgreSQL syntax; plain B-tree indexes port directly.
  const indexes = (table.indexes ?? [])
    .filter(
      (definition) =>
        definition.where === undefined &&
        definition.keys.every((key) => IDENTIFIER.test(key)),
    )
    .map(
      (definition) =>
        `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(definition.sqlName)} ON ${quoteIdentifier(table.sqlName)} (${definition.keys.join(", ")})`,
    );

  return [
    `CREATE TABLE ${quoteIdentifier(table.sqlName)} (\n${definitions.map((definition) => `  ${definition}`).join(",\n")}\n)`,
    ...indexes,
  ];
};

/**
 * SQLite DDL for a schema snapshot: INTEGER/REAL/TEXT storage, rowid identities,
 * enum CHECK constraints, foreign keys and plain indexes. CHECK callbacks and
 * partial indexes are PostgreSQL-only and skipped.
 */
export const sqliteSchemaSQL = (snapshot: SchemaSnapshot): string[] =>
  snapshot.tables.flatMap(tableSQL);
