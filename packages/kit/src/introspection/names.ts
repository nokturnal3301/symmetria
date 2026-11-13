/**
 * Name conversions for introspection: SQL identifiers to schema keys that round-trip
 * through the assembler's snakeCase, conventional object names and source-text escaping.
 */
import { snakeCase, sqlKey, type Casing } from "symmetria";
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
  "relations",
  "named",
  "by",
  "column",
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

/** Keys written as they are: a lowercase start, then letters and digits. */
const PRESERVED_KEY = /^[a-z][A-Za-z0-9]*$/;

/** The key whose SQL name under `casing` is exactly `sqlName`, or undefined. */
export const naturalKey = (
  sqlName: string,
  casing: Casing,
): string | undefined =>
  casing === "preserve"
    ? PRESERVED_KEY.test(sqlName)
      ? sqlName
      : undefined
    : camelKey(sqlName);

/**
 * A camelCase key for any SQL name (`User` → `user`, `CamelCol` → `camelCol`,
 * `_prisma_migrations` → `prismaMigrations`); the declaration adds `.named()`
 * when the key does not produce the name by itself.
 */
export const derivedKey = (sqlName: string): string => {
  const words = sqlName
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean);
  const key = words
    .map((word, position) =>
      position === 0
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");

  return !key ? "unnamed" : /^[0-9]/.test(key) ? `n${key}` : key;
};

export const keyFor = (sqlName: string, casing: Casing): string =>
  naturalKey(sqlName, casing) ?? derivedKey(sqlName);

/**
 * The casing that lets most names be declared without `.named()`: Prisma-style
 * camelCase (`createdAt`) chooses `"preserve"`, snake_case (`created_at`) the default.
 */
export const chooseCasing = (names: readonly string[]): Casing => {
  let snake = 0;
  let preserved = 0;

  for (const name of names) {
    const asSnake = camelKey(name) !== undefined;
    const asPreserved = PRESERVED_KEY.test(name);

    if (asSnake && !asPreserved) {
      snake += 1;
    } else if (asPreserved && !asSnake) {
      preserved += 1;
    }
  }

  return preserved > snake ? "preserve" : "snake_case";
};

/** Relation key and explicit column for a foreign-key column under a casing. */
export const referenceKey = (
  sqlName: string,
  casing: Casing,
): { key: string; column?: string } => {
  const base =
    casing === "preserve"
      ? /^[a-z][A-Za-z0-9]*Id$/.test(sqlName)
        ? sqlName.slice(0, -2)
        : undefined
      : sqlName.endsWith("_id") && sqlName.length > 3
        ? camelKey(sqlName.slice(0, -3))
        : undefined;

  if (base) {
    return { key: base };
  }

  const key = keyFor(sqlName, casing);

  return {
    key: key.endsWith("Id") && key.length > 2 ? key.slice(0, -2) : key,
    column: sqlName,
  };
};

/** Allocates distinct keys, suffixing a number when two names derive the same key. */
export const keyAllocator = (
  reserved: (key: string) => boolean = () => false,
) => {
  const taken = new Set<string>();

  return (base: string): string => {
    let key = reserved(base) ? `${base}Value` : base;
    let ordinal = 2;

    while (taken.has(key)) {
      key = `${base}${ordinal++}`;
    }

    taken.add(key);

    return key;
  };
};

/** Every identifier a generated module imports or declares at its top level. */
export const MODULE_IDENTIFIERS: readonly string[] = [
  "and",
  "bigint",
  "bool",
  "bytea",
  "customType",
  "date",
  "doublePrecision",
  "index",
  "inet",
  "int",
  "interval",
  "jsonb",
  "junction",
  "not",
  "numeric",
  "oneOf",
  "operatorClass",
  "or",
  "passthrough",
  "real",
  "schema",
  "smallint",
  "sql",
  "table",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "tsvector",
  "uuid",
  "varchar",
  "vector",
];

/** Words a module cannot use as a parameter or binding name. */
const RESERVED_WORDS = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * Identifiers for tables inside generated callbacks. A table keyed like a builder
 * (`date`, `text`) would shadow the import in `({ date }) =>`, and a reserved word
 * cannot be a parameter, so those tables are bound as `dateTable` instead.
 */
export const tableBindings = (keys: readonly string[]): Map<string, string> => {
  const taken = new Set([...MODULE_IDENTIFIERS, ...keys]);
  const bindings = new Map<string, string>();

  for (const key of keys) {
    if (!MODULE_IDENTIFIERS.includes(key) && !RESERVED_WORDS.has(key)) {
      bindings.set(key, key);
      continue;
    }

    let binding = `${key}Table`;
    let ordinal = 2;

    while (taken.has(binding)) {
      binding = `${key}Table${ordinal++}`;
    }

    taken.add(binding);
    bindings.set(key, binding);
  }

  return bindings;
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
  check: (table: string, key: string, casing?: Casing) =>
    objectName(table, sqlKey(key, casing), "check"),
  index: (table: string, key: string, casing?: Casing) =>
    objectName(table, sqlKey(key, casing), "idx"),
  /** Automatic index on one column, named after the column's SQL name. */
  columnIndex: (table: string, column: string) =>
    objectName(table, column, "idx"),
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

/** `'text'` in SQL, for suggested fixes. */
export const sqlString = (text: string): string =>
  `'${text.replaceAll("'", "''")}'`;
