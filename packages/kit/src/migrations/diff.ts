import { quoteIdentifier } from "symmetria/internal";
import type { CompiledQuery, SchemaSnapshot } from "symmetria";
import {
  columnSQL,
  columnTypeSQL,
  enumerationSQL,
  foreignKeySQL,
  indexSQL,
  primaryKeySQL,
  tableSQL,
  uniqueSQL,
  checkSQL,
} from "./ddl";
import {
  canonicalJSON,
  checksum,
  emptySnapshot,
  migrationSnapshot,
  objectName,
  parseMigrationSnapshot,
  quoteLiteral,
  type MigrationColumn,
  type MigrationSnapshot,
  type MigrationTable,
} from "./snapshot";

export type RenameHints = {
  /** Physical SQL names: old table -> new table. */
  readonly tables?: Readonly<Record<string, string>>;
  /** Keyed by the NEW table name: old column -> new column. */
  readonly columns?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};
export type MigrationDiffOptions = {
  /** Generate concurrent indexes, phased constraint validation and enum additions. Requires nontransactional execution. */
  readonly online?: boolean;
  readonly renames?: RenameHints;
  /** SQL USING expressions, keyed by new table and column names. */
  readonly using?: Readonly<
    Record<
      string,
      Readonly<Record<string, { readonly up: string; readonly down: string }>>
    >
  >;
};
export type MigrationPlan = {
  before: MigrationSnapshot;
  after: MigrationSnapshot;
  up: string[];
  down: string[];
};
type ColumnPair = {
  before: MigrationColumn;
  after: MigrationColumn;
  typeChanged: boolean;
};
type TablePair = {
  before: MigrationTable;
  after: MigrationTable;
  columns: ColumnPair[];
  primaryChanged: boolean;
  rebuildIndexes: boolean;
};
type Casts = Readonly<Record<string, Readonly<Record<string, string>>>>;

const equal = (left: unknown, right: unknown): boolean =>
  canonicalJSON(left ?? null) === canonicalJSON(right ?? null);

const direction = (
  before: MigrationSnapshot,
  after: MigrationSnapshot,
  renames: RenameHints,
  casts: Casts,
  online = false,
): string[] => {
  const beforeTables = new Map(
    before.tables.map((table) => [table.name, table]),
  );
  const afterTables = new Map(after.tables.map((table) => [table.name, table]));
  const tableNames = renames.tables ?? {};

  for (const [previous, next] of Object.entries(tableNames)) {
    if (!beforeTables.has(previous) || !afterTables.has(next)) {
      throw new Error(
        `symmetria: invalid table rename "${previous}" -> "${next}"`,
      );
    }

    if (previous !== next && beforeTables.has(next)) {
      throw new Error(
        `symmetria: rename target "${next}" already exists; swaps need an explicit SQL migration`,
      );
    }
  }

  if (
    new Set(Object.values(tableNames)).size !== Object.values(tableNames).length
  ) {
    throw new Error("symmetria: duplicate table rename target");
  }

  const beforeEnumerations = new Map(
    before.enumerations.map((enumeration) => [enumeration.name, enumeration]),
  );
  const afterEnumerations = new Map(
    after.enumerations.map((enumeration) => [enumeration.name, enumeration]),
  );
  const additiveEnums = new Set(
    after.enumerations
      .filter((next) => {
        const previous = beforeEnumerations.get(next.name);

        return (
          online &&
          previous &&
          previous.values.length < next.values.length &&
          equal(
            next.values.filter((value) => previous.values.includes(value)),
            previous.values,
          )
        );
      })
      .map((enumeration) => enumeration.name),
  );

  const typeChanged = (
    previous: MigrationColumn,
    next: MigrationColumn,
  ): boolean =>
    previous.sqlType !== next.sqlType ||
    previous.enumeration !== next.enumeration ||
    !!(
      next.enumeration &&
      !additiveEnums.has(next.enumeration) &&
      !equal(
        beforeEnumerations.get(next.enumeration),
        afterEnumerations.get(next.enumeration),
      )
    );

  const pairs: TablePair[] = [];

  for (const previous of before.tables) {
    const next = afterTables.get(tableNames[previous.name] ?? previous.name);

    if (!next) {
      continue;
    }

    const columnNames = renames.columns?.[next.name] ?? {};

    for (const [previousName, nextName] of Object.entries(columnNames)) {
      if (
        !previous.columns.some((column) => column.name === previousName) ||
        !next.columns.some((column) => column.name === nextName)
      ) {
        throw new Error(
          `symmetria: invalid column rename "${next.name}.${previousName}" -> "${nextName}"`,
        );
      }

      if (
        previousName !== nextName &&
        previous.columns.some((column) => column.name === nextName)
      ) {
        throw new Error(
          "symmetria: column rename target already exists; swaps need an explicit SQL migration",
        );
      }
    }

    if (
      new Set(Object.values(columnNames)).size !==
      Object.values(columnNames).length
    ) {
      throw new Error("symmetria: duplicate column rename target");
    }

    const columns = previous.columns.flatMap((column): ColumnPair[] => {
      const target = next.columns.find(
        (candidate) =>
          candidate.name === (columnNames[column.name] ?? column.name),
      );

      return target
        ? [
            {
              before: column,
              after: target,
              typeChanged: typeChanged(column, target),
            },
          ]
        : [];
    });
    const primaryChanged =
      previous.name !== next.name ||
      !equal(previous.primaryKey, next.primaryKey) ||
      columns.some(
        (column) =>
          column.typeChanged &&
          previous.primaryKey.includes(column.before.name),
      );
    const rebuildIndexes =
      previous.name !== next.name ||
      columns.length !== previous.columns.length ||
      columns.some(
        (column) =>
          column.before.name !== column.after.name || column.typeChanged,
      );
    pairs.push({
      before: previous,
      after: next,
      columns,
      primaryChanged,
      rebuildIndexes,
    });
  }

  for (const name of Object.keys(renames.columns ?? {})) {
    if (!pairs.some((pair) => pair.after.name === name)) {
      throw new Error(`symmetria: unknown column-rename table "${name}"`);
    }
  }

  for (const [table, columns] of Object.entries(casts)) {
    for (const [column, expression] of Object.entries(columns)) {
      if (
        !expression.trim() ||
        !pairs
          .find((pair) => pair.after.name === table)
          ?.columns.some(
            (pair) => pair.after.name === column && pair.typeChanged,
          )
      ) {
        throw new Error(
          `symmetria: USING expression does not match a type change at "${table}.${column}"`,
        );
      }
    }
  }

  const previousPairs = new Map(pairs.map((pair) => [pair.before.name, pair]));
  const nextPairs = new Map(pairs.map((pair) => [pair.after.name, pair]));
  const removedTables = before.tables.filter(
    (table) => !previousPairs.has(table.name),
  );
  const addedTables = after.tables.filter(
    (table) => !nextPairs.has(table.name),
  );
  const droppedIndexes = new Set<string>();

  const changedCheck = (pair: TablePair, name: string): boolean =>
    pair.rebuildIndexes ||
    !equal(
      pair.before.checks?.find((check) => check.sqlName === name),
      pair.after.checks?.find((check) => check.sqlName === name),
    );

  const changedKeys = new Set<string>(removedTables.map((table) => table.name));

  for (const pair of pairs) {
    if (
      pair.primaryChanged ||
      pair.columns.some(
        (column) =>
          column.before.unique &&
          (!column.after.unique ||
            column.typeChanged ||
            column.before.name !== column.after.name),
      )
    ) {
      changedKeys.add(pair.before.name);
    }

    for (const definition of pair.before.indexes) {
      if (
        pair.rebuildIndexes ||
        !equal(
          definition,
          pair.after.indexes.find(
            (candidate) => candidate.sqlName === definition.sqlName,
          ),
        )
      ) {
        droppedIndexes.add(definition.sqlName);

        if (definition.unique) {
          changedKeys.add(pair.before.name);
        }
      }
    }
  }

  const uniqueChanged = (pair: TablePair, column: ColumnPair): boolean =>
    pair.before.name !== pair.after.name ||
    column.before.name !== column.after.name ||
    column.typeChanged ||
    column.before.unique !== column.after.unique;

  const statements: string[] = [];
  const droppedReferences = new Set<string>();

  const referenceKey = (table: string, column: string): string =>
    canonicalJSON([table, column]);

  // Remove dependencies before changing or removing keys, types, columns or tables.
  for (const table of before.tables) {
    for (const column of table.columns) {
      if (column.references) {
        const pair = previousPairs.get(table.name);
        const match = pair?.columns.find(
          (candidate) => candidate.before.name === column.name,
        );

        if (
          !pair ||
          !match ||
          pair.before.name !== pair.after.name ||
          match.before.name !== match.after.name ||
          match.typeChanged ||
          !equal(column.references, match.after.references) ||
          changedKeys.has(column.references.table)
        ) {
          statements.push(
            `ALTER TABLE ${quoteIdentifier(table.name)} DROP CONSTRAINT ${quoteIdentifier(objectName(table.name, column.name, "fkey"))}`,
          );
          droppedReferences.add(referenceKey(table.name, column.name));
        }
      }
    }
  }

  for (const pair of pairs) {
    for (const definition of pair.before.indexes) {
      if (droppedIndexes.has(definition.sqlName)) {
        statements.push(
          `DROP INDEX ${online ? "CONCURRENTLY " : ""}${quoteIdentifier(definition.sqlName)}`,
        );
      }
    }

    for (const definition of pair.before.checks ?? []) {
      if (changedCheck(pair, definition.sqlName)) {
        statements.push(
          `ALTER TABLE ${quoteIdentifier(pair.before.name)} DROP CONSTRAINT ${quoteIdentifier(definition.sqlName)}`,
        );
      }
    }

    if (pair.primaryChanged && pair.before.primaryKey.length) {
      statements.push(
        `ALTER TABLE ${quoteIdentifier(pair.before.name)} DROP CONSTRAINT ${quoteIdentifier(objectName(pair.before.name, "pkey"))}`,
      );
    }

    for (const column of pair.columns) {
      if (column.before.unique && uniqueChanged(pair, column)) {
        statements.push(
          `ALTER TABLE ${quoteIdentifier(pair.before.name)} DROP CONSTRAINT ${quoteIdentifier(objectName(pair.before.name, column.before.name, "key"))}`,
        );
      }
    }
  }

  for (const pair of pairs) {
    if (pair.before.name !== pair.after.name) {
      statements.push(
        `ALTER TABLE ${quoteIdentifier(pair.before.name)} RENAME TO ${quoteIdentifier(pair.after.name)}`,
      );
    }

    for (const column of pair.columns) {
      if (column.before.name !== column.after.name) {
        statements.push(
          `ALTER TABLE ${quoteIdentifier(pair.after.name)} RENAME COLUMN ${quoteIdentifier(column.before.name)} TO ${quoteIdentifier(column.after.name)}`,
        );
      }
    }
  }

  for (const table of removedTables) {
    statements.push(`DROP TABLE ${quoteIdentifier(table.name)}`);
  }

  for (const pair of pairs) {
    for (const column of pair.before.columns) {
      if (!pair.columns.some((match) => match.before.name === column.name)) {
        statements.push(
          `ALTER TABLE ${quoteIdentifier(pair.after.name)} DROP COLUMN ${quoteIdentifier(column.name)}`,
        );
      }
    }
  }

  // Replacing enums permits additions/removals/reordering within one transaction,
  // avoiding the commit required before an ALTER TYPE ... ADD VALUE label can be used.
  const oldEnumerationNames = new Map<string, string>();
  const occupied = new Set([
    ...before.tables.map((table) => table.name),
    ...after.tables.map((table) => table.name),
    ...beforeEnumerations.keys(),
    ...afterEnumerations.keys(),
  ]);

  for (const enumeration of after.enumerations) {
    const previous = beforeEnumerations.get(enumeration.name);

    if (previous && equal(previous, enumeration)) {
      continue;
    }

    if (previous && additiveEnums.has(enumeration.name)) {
      const available = new Set(previous.values);

      for (const [position, value] of enumeration.values.entries()) {
        if (available.has(value)) {
          continue;
        }

        const following = enumeration.values
          .slice(position + 1)
          .find((value) => available.has(value));
        statements.push(
          `ALTER TYPE ${quoteIdentifier(enumeration.name)} ADD VALUE ${quoteLiteral(value)}${following === undefined ? "" : ` BEFORE ${quoteLiteral(following)}`}`,
        );
        available.add(value);
      }

      continue;
    }

    if (previous) {
      let counter = 0;
      let temporary: string;
      do {
        temporary = objectName(
          enumeration.name,
          "previous",
          checksum(canonicalJSON(previous)).slice(0, 8),
          String(counter++),
        );
      } while (occupied.has(temporary));
      occupied.add(temporary);
      oldEnumerationNames.set(enumeration.name, temporary);
      statements.push(
        `ALTER TYPE ${quoteIdentifier(enumeration.name)} RENAME TO ${quoteIdentifier(temporary)}`,
      );
    }

    statements.push(enumerationSQL(enumeration.name, enumeration.values));
  }

  for (const table of addedTables) {
    statements.push(tableSQL(table));
  }

  for (const pair of pairs) {
    const alter = `ALTER TABLE ${quoteIdentifier(pair.after.name)}`;

    for (const column of pair.after.columns) {
      if (!pair.columns.some((match) => match.after.name === column.name)) {
        statements.push(`${alter} ADD COLUMN ${columnSQL(column)}`);
      }
    }

    for (const column of pair.columns) {
      const previous = column.before;
      const next = column.after;
      const prefix = `${alter} ALTER COLUMN ${quoteIdentifier(next.name)}`;

      if (previous.identity && !next.identity) {
        statements.push(`${prefix} DROP IDENTITY`);
      }

      if (
        previous.default !== undefined &&
        (column.typeChanged ||
          previous.default !== next.default ||
          next.identity)
      ) {
        statements.push(`${prefix} DROP DEFAULT`);
      }

      if (column.typeChanged) {
        const conversion =
          casts[pair.after.name]?.[next.name] ??
          `${quoteIdentifier(next.name)}${previous.enumeration || next.enumeration ? "::text" : ""}::${columnTypeSQL(next)}`;
        statements.push(
          `${prefix} TYPE ${columnTypeSQL(next)} USING ${conversion}`,
        );
      }

      if (previous.notNull !== next.notNull) {
        if (online && next.notNull) {
          const name = quoteIdentifier(
            objectName(
              pair.after.name,
              next.name,
              "not_null",
              checksum(canonicalJSON(before)).slice(0, 8),
            ),
          );
          statements.push(
            `${alter} ADD CONSTRAINT ${name} CHECK (${quoteIdentifier(next.name)} IS NOT NULL) NOT VALID`,
            `${alter} VALIDATE CONSTRAINT ${name}`,
            `${prefix} SET NOT NULL`,
            `${alter} DROP CONSTRAINT ${name}`,
          );
        } else {
          statements.push(
            `${prefix} ${next.notNull ? "SET" : "DROP"} NOT NULL`,
          );
        }
      }

      if (!previous.identity && next.identity) {
        statements.push(`${prefix} ADD GENERATED ALWAYS AS IDENTITY`);
        statements.push(
          `SELECT setval(pg_get_serial_sequence(${quoteLiteral(quoteIdentifier(pair.after.name))}, ${quoteLiteral(next.name)}), GREATEST(COALESCE(MAX(${quoteIdentifier(next.name)}), 0), 0) + 1, false) FROM ${quoteIdentifier(pair.after.name)}`,
        );
      }

      if (
        next.default !== undefined &&
        (column.typeChanged || previous.default !== next.default)
      ) {
        statements.push(`${prefix} SET DEFAULT ${next.default}`);
      }
    }

    if (pair.primaryChanged && pair.after.primaryKey.length) {
      statements.push(`${alter} ADD ${primaryKeySQL(pair.after)}`);
    }

    for (const definition of pair.after.checks ?? []) {
      if (changedCheck(pair, definition.sqlName)) {
        statements.push(
          `${alter} ADD ${checkSQL(definition)}${online ? " NOT VALID" : ""}`,
        );

        if (online) {
          statements.push(
            `${alter} VALIDATE CONSTRAINT ${quoteIdentifier(definition.sqlName)}`,
          );
        }
      }
    }

    for (const column of pair.after.columns) {
      const match = pair.columns.find(
        (candidate) => candidate.after.name === column.name,
      );

      if (column.unique && (!match || uniqueChanged(pair, match))) {
        if (online) {
          const name = quoteIdentifier(
            objectName(pair.after.name, column.name, "key"),
          );
          statements.push(
            `CREATE UNIQUE INDEX CONCURRENTLY ${name} ON ${quoteIdentifier(pair.after.name)} (${quoteIdentifier(column.name)})`,
            `${alter} ADD CONSTRAINT ${name} UNIQUE USING INDEX ${name}`,
          );
        } else {
          statements.push(`${alter} ADD ${uniqueSQL(pair.after, column)}`);
        }
      }
    }
  }

  for (const table of after.tables) {
    const pair = nextPairs.get(table.name);

    for (const definition of table.indexes) {
      if (
        !pair ||
        droppedIndexes.has(definition.sqlName) ||
        !pair.before.indexes.some(
          (previous) => previous.sqlName === definition.sqlName,
        )
      ) {
        statements.push(
          online
            ? indexSQL(table, definition).replace(
                /^(CREATE (?:UNIQUE )?INDEX) /,
                "$1 CONCURRENTLY ",
              )
            : indexSQL(table, definition),
        );
      }
    }
  }

  for (const table of after.tables) {
    for (const column of table.columns) {
      if (column.references) {
        const pair = nextPairs.get(table.name);
        const previous = pair?.columns.find(
          (candidate) => candidate.after.name === column.name,
        )?.before;

        if (
          !pair ||
          !previous?.references ||
          droppedReferences.has(referenceKey(pair.before.name, previous.name))
        ) {
          statements.push(
            `${foreignKeySQL(table, column)}${online ? " NOT VALID" : ""}`,
          );

          if (online) {
            statements.push(
              `ALTER TABLE ${quoteIdentifier(table.name)} VALIDATE CONSTRAINT ${quoteIdentifier(objectName(table.name, column.name, "fkey"))}`,
            );
          }
        }
      }
    }
  }

  for (const enumeration of before.enumerations) {
    const temporary = oldEnumerationNames.get(enumeration.name);

    if (temporary || !afterEnumerations.has(enumeration.name)) {
      statements.push(
        `DROP TYPE ${quoteIdentifier(temporary ?? enumeration.name)}`,
      );
    }
  }

  return statements;
};

export const diffSchemas = (
  previous: SchemaSnapshot | MigrationSnapshot,
  next: SchemaSnapshot | MigrationSnapshot,
  options: MigrationDiffOptions = {},
): MigrationPlan => {
  const before =
    "version" in previous
      ? parseMigrationSnapshot(previous)
      : migrationSnapshot(previous);
  const after =
    "version" in next ? parseMigrationSnapshot(next) : migrationSnapshot(next);
  const reverseTables = Object.fromEntries(
    Object.entries(options.renames?.tables ?? {}).map(([previous, next]) => [
      next,
      previous,
    ]),
  );
  const reverseColumns = Object.fromEntries(
    Object.entries(options.renames?.columns ?? {}).map(([table, columns]) => [
      reverseTables[table] ?? table,
      Object.fromEntries(
        Object.entries(columns).map(([previous, next]) => [next, previous]),
      ),
    ]),
  );
  const forwardCasts: Record<string, Record<string, string>> = {};
  const reverseCasts: Record<string, Record<string, string>> = {};

  for (const [table, columns] of Object.entries(options.using ?? {})) {
    forwardCasts[table] = Object.fromEntries(
      Object.entries(columns).map(([column, conversion]) => [
        column,
        conversion.up,
      ]),
    );
    const originalTable = reverseTables[table] ?? table;
    reverseCasts[originalTable] = Object.fromEntries(
      Object.entries(columns).map(([column, conversion]) => [
        reverseColumns[originalTable]?.[column] ?? column,
        conversion.down,
      ]),
    );
  }

  return {
    before,
    after,
    up: direction(
      before,
      after,
      options.renames ?? {},
      forwardCasts,
      options.online,
    ),
    down: direction(
      after,
      before,
      { tables: reverseTables, columns: reverseColumns },
      reverseCasts,
      options.online,
    ),
  };
};

export const createSchemaSQL = (
  snapshot: SchemaSnapshot | MigrationSnapshot,
): CompiledQuery[] =>
  diffSchemas(emptySnapshot(), snapshot).up.map((sql) => ({
    sql,
    parameters: [],
  }));
