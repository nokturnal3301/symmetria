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
  /** The table rename changes the primary key's name, not its definition. */
  primaryRenamed: boolean;
  /** Quoted names of retyped or dropped columns; definitions mentioning them are rebuilt. */
  affected: string[];
  /** Applies column renames to a previous definition; PostgreSQL renames them in place. */
  renamed: <Definition>(definition: Definition) => Definition;
};
type Casts = Readonly<Record<string, Readonly<Record<string, string>>>>;

const equal = (left: unknown, right: unknown): boolean =>
  canonicalJSON(left ?? null) === canonicalJSON(right ?? null);

/** A definition without its declared and SQL names: what a rename leaves unchanged. */
const anonymous = (definition: unknown): unknown =>
  Object.fromEntries(
    Object.entries(definition as Record<string, unknown>).filter(
      ([key]) => key !== "name" && key !== "sqlName",
    ),
  );

/** A string as it appears inside canonical JSON, without the surrounding quotes. */
const escapedJSON = (value: string): string =>
  JSON.stringify(value).slice(1, -1);

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

  /** A reference as it reads after this diff's table and column renames. */
  const renamedReference = (reference: {
    table: string;
    column: string;
    onDelete: string;
  }): { table: string; column: string; onDelete: string } => {
    const table = tableNames[reference.table] ?? reference.table;

    return {
      table,
      column: renames.columns?.[table]?.[reference.column] ?? reference.column,
      onDelete: reference.onDelete,
    };
  };

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

  // ALTER TYPE ... ADD VALUE runs inside a transaction on PostgreSQL 12+, but the new
  // label cannot be used until commit. Values that a default or CHECK in this migration
  // already needs force the replace-and-cast rewrite instead.
  const usedInMigration = (enumeration: string, value: string): boolean => {
    const literal = quoteLiteral(value);

    return after.tables.some(
      (table) =>
        table.columns.some(
          (column) =>
            column.enumeration === enumeration &&
            column.default !== undefined &&
            column.default.includes(literal),
        ) ||
        (table.checks ?? []).some((check) =>
          check.expression.includes(literal),
        ),
    );
  };

  const additiveEnums = new Set(
    after.enumerations
      .filter((next) => {
        const previous = beforeEnumerations.get(next.name);

        return (
          previous &&
          previous.values.length < next.values.length &&
          equal(
            next.values.filter((value) => previous.values.includes(value)),
            previous.values,
          ) &&
          // Online migrations commit each statement, so later defaults may use the label.
          (online ||
            !next.values.some(
              (value) =>
                !previous.values.includes(value) &&
                usedInMigration(next.name, value),
            ))
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
      !equal(
        previous.primaryKey.map((name) => columnNames[name] ?? name),
        next.primaryKey,
      ) ||
      columns.some(
        (column) =>
          column.typeChanged &&
          previous.primaryKey.includes(column.before.name),
      );
    const affected = previous.columns
      .filter(
        (column) =>
          !columns.some(
            (pair) => pair.before.name === column.name && !pair.typeChanged,
          ),
      )
      .map((column) => quoteIdentifier(column.name));
    const columnRenames = columns
      .filter((column) => column.before.name !== column.after.name)
      .map(
        (column) =>
          [
            escapedJSON(quoteIdentifier(column.before.name)),
            escapedJSON(quoteIdentifier(column.after.name)),
          ] as const,
      );
    pairs.push({
      before: previous,
      after: next,
      columns,
      primaryChanged,
      primaryRenamed:
        !primaryChanged &&
        previous.name !== next.name &&
        previous.primaryKey.length > 0,
      affected,
      renamed: (definition) =>
        columnRenames.length
          ? JSON.parse(
              columnRenames.reduce(
                (text, [from, to]) => text.replaceAll(from, to),
                canonicalJSON(definition),
              ),
            )
          : definition,
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

  /** A definition survives when only renamed columns changed and no column it uses is retyped or dropped. */
  const changedDefinition = (
    pair: TablePair,
    previous: unknown,
    next: unknown,
  ): boolean => {
    if (!previous || !next) {
      return true;
    }

    const text = canonicalJSON(previous);

    return (
      pair.affected.some((name) => text.includes(escapedJSON(name))) ||
      !equal(anonymous(pair.renamed(previous)), anonymous(next))
    );
  };

  /**
   * The definition each previous index or check continues as: the one with the
   * same SQL name, or else the single one equal to it apart from names. Renamed
   * tables and columns change SQL names, and snapshots keep no declared key.
   */
  const counterparts = <Definition extends { sqlName: string }>(
    pair: TablePair,
    previous: readonly Definition[],
    next: readonly Definition[],
  ): Map<string, Definition> => {
    const matches = new Map<string, Definition>();
    const taken = new Set<string>();

    for (const definition of previous) {
      const same = next.find(
        (candidate) => candidate.sqlName === definition.sqlName,
      );

      if (same) {
        matches.set(definition.sqlName, same);
        taken.add(same.sqlName);
      }
    }

    for (const definition of previous) {
      if (matches.has(definition.sqlName)) {
        continue;
      }

      const shape = canonicalJSON(anonymous(pair.renamed(definition)));
      const candidates = next.filter(
        (candidate) =>
          !taken.has(candidate.sqlName) &&
          canonicalJSON(anonymous(candidate)) === shape,
      );

      if (candidates.length === 1) {
        matches.set(definition.sqlName, candidates[0]!);
        taken.add(candidates[0]!.sqlName);
      }
    }

    return matches;
  };

  const indexMatches = new Map(
    pairs.map(
      (pair) =>
        [
          pair,
          counterparts(pair, pair.before.indexes, pair.after.indexes),
        ] as const,
    ),
  );
  const checkMatches = new Map(
    pairs.map(
      (pair) =>
        [
          pair,
          counterparts(pair, pair.before.checks ?? [], pair.after.checks ?? []),
        ] as const,
    ),
  );

  /** The previous SQL name that continues as `next`, if any. */
  const previousOf = <Definition extends { sqlName: string }>(
    matches: Map<string, Definition> | undefined,
    next: Definition,
  ): string | undefined =>
    matches &&
    [...matches].find(
      ([, candidate]) => candidate.sqlName === next.sqlName,
    )?.[0];

  const changedCheck = (
    pair: TablePair,
    definition: NonNullable<MigrationTable["checks"]>[number],
  ): boolean =>
    changedDefinition(
      pair,
      definition,
      checkMatches.get(pair)?.get(definition.sqlName),
    );

  const referenceKey = (table: string, column: string): string =>
    canonicalJSON([table, column]);

  // Foreign keys depend on the referenced key column, not on the whole table.
  const removedTableNames = new Set(removedTables.map((table) => table.name));
  const changedKeys = new Set<string>();

  for (const pair of pairs) {
    if (pair.primaryChanged) {
      for (const column of pair.before.primaryKey) {
        changedKeys.add(referenceKey(pair.before.name, column));
      }
    }

    for (const column of pair.columns) {
      if (
        column.before.unique &&
        (!column.after.unique || column.typeChanged)
      ) {
        changedKeys.add(referenceKey(pair.before.name, column.before.name));
      }
    }

    for (const definition of pair.before.indexes) {
      if (
        changedDefinition(
          pair,
          definition,
          indexMatches.get(pair)?.get(definition.sqlName),
        )
      ) {
        droppedIndexes.add(definition.sqlName);

        // A unique index can back foreign keys that reference its single column.
        if (definition.unique) {
          for (const column of pair.before.columns) {
            if (equal(definition.keys, [quoteIdentifier(column.name)])) {
              changedKeys.add(referenceKey(pair.before.name, column.name));
            }
          }
        }
      }
    }
  }

  const uniqueChanged = (column: ColumnPair): boolean =>
    column.typeChanged || column.before.unique !== column.after.unique;

  const statements: string[] = [];
  const droppedReferences = new Set<string>();

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
          match.typeChanged ||
          !equal(renamedReference(column.references), match.after.references) ||
          removedTableNames.has(column.references.table) ||
          changedKeys.has(
            referenceKey(column.references.table, column.references.column),
          )
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
      if (changedCheck(pair, definition)) {
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
      if (column.before.unique && uniqueChanged(column)) {
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

    // Constraints and indexes named after the table or a column follow the
    // rename; PostgreSQL keeps their definitions, so nothing is rebuilt.
    const table = quoteIdentifier(pair.after.name);

    const renameConstraint = (previous: string, next: string): void => {
      if (previous !== next) {
        statements.push(
          `ALTER TABLE ${table} RENAME CONSTRAINT ${quoteIdentifier(previous)} TO ${quoteIdentifier(next)}`,
        );
      }
    };

    if (pair.primaryRenamed) {
      renameConstraint(
        objectName(pair.before.name, "pkey"),
        objectName(pair.after.name, "pkey"),
      );
    }

    for (const column of pair.columns) {
      if (column.before.unique && !uniqueChanged(column)) {
        renameConstraint(
          objectName(pair.before.name, column.before.name, "key"),
          objectName(pair.after.name, column.after.name, "key"),
        );
      }

      if (
        column.before.references &&
        !droppedReferences.has(
          referenceKey(pair.before.name, column.before.name),
        )
      ) {
        renameConstraint(
          objectName(pair.before.name, column.before.name, "fkey"),
          objectName(pair.after.name, column.after.name, "fkey"),
        );
      }
    }

    for (const definition of pair.before.checks ?? []) {
      const next = checkMatches.get(pair)?.get(definition.sqlName);

      if (next && !changedCheck(pair, definition)) {
        renameConstraint(definition.sqlName, next.sqlName);
      }
    }

    for (const definition of pair.before.indexes) {
      const next = indexMatches.get(pair)?.get(definition.sqlName);

      if (
        next &&
        !droppedIndexes.has(definition.sqlName) &&
        next.sqlName !== definition.sqlName
      ) {
        statements.push(
          `ALTER INDEX ${quoteIdentifier(definition.sqlName)} RENAME TO ${quoteIdentifier(next.sqlName)}`,
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
      if (pair.columns.some((match) => match.after.name === column.name)) {
        continue;
      }

      if (column.notNull && column.default === undefined && !column.identity) {
        // Existing rows have no value for the column: add it nullable and leave a
        // place for the backfill before NOT NULL is enforced.
        statements.push(
          `${alter} ADD COLUMN ${columnSQL({ ...column, notNull: false })}`,
          `-- Backfill ${quoteIdentifier(pair.after.name)}.${quoteIdentifier(column.name)} for existing rows before this statement.\n${alter} ALTER COLUMN ${quoteIdentifier(column.name)} SET NOT NULL`,
        );
        continue;
      }

      statements.push(`${alter} ADD COLUMN ${columnSQL(column)}`);
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
      const previousName = previousOf(checkMatches.get(pair), definition);
      const previous = pair.before.checks?.find(
        (candidate) => candidate.sqlName === previousName,
      );

      if (!previous || changedCheck(pair, previous)) {
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

      if (column.unique && (!match || uniqueChanged(match))) {
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
      const previous = pair
        ? previousOf(indexMatches.get(pair), definition)
        : undefined;

      if (!pair || previous === undefined || droppedIndexes.has(previous)) {
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
