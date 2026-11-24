/**
 * DDL fragments shared by migration generation: column types, constraints, tables and indexes.
 */
import { indexClausesSQL, quoteIdentifier } from "symmetria/internal";
import type { IndexSnapshot, CheckSnapshot } from "symmetria";
import {
  commentText,
  objectName,
  quoteLiteral,
  type MigrationColumn,
  type MigrationTable,
} from "./snapshot";

/** The column's type with its collation: `text COLLATE "C"`, also valid after `::` in a cast. */
export const columnTypeSQL = (column: MigrationColumn): string =>
  `${column.enumeration ? quoteIdentifier(column.enumeration) : column.sqlType}${column.collation === undefined ? "" : ` COLLATE ${quoteIdentifier(column.collation)}`}`;

export const identitySQL = (column: MigrationColumn): string =>
  `GENERATED ${column.identityByDefault ? "BY DEFAULT" : "ALWAYS"} AS IDENTITY`;

export const enumerationSQL = (
  name: string,
  values: readonly string[],
): string =>
  `CREATE TYPE ${quoteIdentifier(name)} AS ENUM (${values.map(quoteLiteral).join(", ")})`;

const IDENTIFIER =
  /^(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*))*/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i;
const TYPE_WORDS =
  /^(?: varying| precision| with time zone| without time zone)?(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\d*\])*/i;

/** The end of the parenthesized text starting at `start`, quotes skipped. */
const closing = (text: string, start: number): number => {
  let depth = 0;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (char === "'" || char === '"') {
      const end = text.indexOf(char, index + 1);

      if (end < 0) {
        return -1;
      }

      index = end;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")" && (depth -= 1) === 0) {
      return index + 1;
    }
  }

  return -1;
};

/**
 * Whether an SQL default is one value: a literal, a number, a name, a call or
 * a parenthesized expression, each with casts. `DEFAULT` in CREATE TABLE takes
 * only a restricted expression, and reads the rest of a longer one as more of
 * the column: `DEFAULT 'a' COLLATE "C"` collates the column itself, and
 * `DEFAULT NOT false` does not parse. Anything else goes in parentheses.
 */
const singleValue = (expression: string): boolean => {
  const text = expression.trim();
  let index = 0;

  if (/^E?'/i.test(text)) {
    const escapes = text[0] !== "'";

    index = escapes ? 2 : 1;

    while (index < text.length) {
      if (escapes && text[index] === "\\") {
        index += 2;
      } else if (text[index] === "'") {
        if (text[index + 1] !== "'") {
          break;
        }

        index += 2;
      } else {
        index += 1;
      }
    }

    if (index >= text.length) {
      return false;
    }

    index += 1;
  } else if (text[0] === "(") {
    index = closing(text, 0);
  } else if (NUMBER.test(text)) {
    index = NUMBER.exec(text)![0].length;
  } else {
    const name = IDENTIFIER.exec(text);

    if (!name) {
      return false;
    }

    index = name[0].length;

    if (text[index] === "(") {
      index = closing(text, index);
    }
  }

  while (index > 0 && text.startsWith("::", index)) {
    const type = IDENTIFIER.exec(text.slice(index + 2));

    if (!type) {
      return false;
    }

    index += 2 + type[0].length;
    index += TYPE_WORDS.exec(text.slice(index))![0].length;
  }

  return index === text.length;
};

export const defaultSQL = (expression: string): string =>
  singleValue(expression) ? expression : `(${expression})`;

export const columnSQL = (column: MigrationColumn): string =>
  `${quoteIdentifier(column.name)} ${columnTypeSQL(column)}${column.identity ? ` ${identitySQL(column)}` : ""}${column.default === undefined ? "" : ` DEFAULT ${defaultSQL(column.default)}`}${column.generated === undefined ? "" : ` GENERATED ALWAYS AS (${column.generated}) STORED`}${column.notNull ? " NOT NULL" : ""}`;

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

  return `ALTER TABLE ${quoteIdentifier(table.name)} ADD CONSTRAINT ${quoteIdentifier(objectName(table.name, column.name, "fkey"))} FOREIGN KEY (${quoteIdentifier(column.name)}) REFERENCES ${quoteIdentifier(reference.table)} (${quoteIdentifier(reference.column)}) ON DELETE ${reference.onDelete.toUpperCase()}${reference.onUpdate ? ` ON UPDATE ${reference.onUpdate.toUpperCase()}` : ""}`;
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
  `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(definition.sqlName)} ON ${quoteIdentifier(table.name)} USING ${definition.method} ${indexClausesSQL(definition)}`;

export const extensionSQL = (name: string): string =>
  `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(name)}`;

/** Removing an extension from the schema never drops it: other schemas may depend on it. */
export const keptExtensionSQL = (name: string): string =>
  `-- ${commentText(`extension ${quoteIdentifier(name)} is kept; drop it manually once nothing else uses it`)}`;
