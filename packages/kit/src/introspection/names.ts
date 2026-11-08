/**
 * Name conversions for introspection: SQL identifiers to schema keys that round-trip
 * through the assembler's snakeCase, conventional object names and source-text escaping.
 */
import { snakeCase } from "symmetria";
import { objectName } from "../migrations/snapshot";

/** Names the table handle resolves to its own methods before columns. */
const RESERVED_COLUMN_KEYS = new Set([
  "indexes",
  "checks",
  "primaryKey",
  "computed",
  "nullable",
  "unique",
  "index",
  "onDelete",
  "inverse",
]);
const RESERVED_TABLE_KEYS = new Set(["constructor", "prototype", "__proto__"]);

/**
 * The camelCase key whose snake_case form is exactly `sqlName`, or undefined when
 * no key can produce that SQL name (uppercase letters, leading/trailing or doubled
 * underscores, digits after an underscore, a leading digit).
 */
export const camelKey = (sqlName: string): string | undefined => {
  if (!/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)*$/.test(sqlName)) {
    return undefined;
  }

  const key = sqlName.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );

  return snakeCase(key) === sqlName ? key : undefined;
};

export const isReservedColumnKey = (key: string): boolean =>
  RESERVED_COLUMN_KEYS.has(key);

export const isReservedTableKey = (key: string): boolean =>
  RESERVED_TABLE_KEYS.has(key);

export const pascal = (key: string): string =>
  key.charAt(0).toUpperCase() + key.slice(1);

/** The constraint and index names the DSL derives for a table. */
export const conventionalNames = {
  primaryKey: (table: string) => objectName(table, "pkey"),
  unique: (table: string, column: string) => objectName(table, column, "key"),
  foreignKey: (table: string, column: string) =>
    objectName(table, column, "fkey"),
  check: (table: string, key: string) =>
    objectName(table, snakeCase(key), "check"),
  index: (table: string, key: string) =>
    objectName(table, snakeCase(key), "idx"),
  enumeration: (table: string, column: string) =>
    objectName(table, column, "enum"),
};

/** Escapes text for a JavaScript template literal. */
export const escapeTemplate = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

/** A double-quoted JavaScript string literal. */
export const quoteString = (text: string): string => JSON.stringify(text);

/** `"identifier"` in SQL, for suggested fixes. */
export const quoteSql = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;
