/**
 * Computes the migration plan between two schema snapshots: table, column, constraint, index and enum changes,
 * rename hints and the full CREATE script for an empty database.
 */
import { normalizeSqlType } from "./drift";
import { quoteIdentifier } from "symmetria/internal";
import {
  expressionUsesLiteral,
  renameExpressionIdentifiers,
} from "./expression-tokens";
import { commentEnded, expressionKey, indexKeyKey } from "./expressions";
import {
  conversionMessage,
  castless,
  embeddingChange,
  typeConversion,
  utcConversion,
  widens,
} from "./conversions";
import { CAUTION_NOTE, DESTRUCTIVE_NOTE } from "./sql-lint";
import { defaultKey } from "./default-values";
import type { CompiledQuery, SchemaSnapshot } from "symmetria";
import {
  columnSQL,
  columnTypeSQL,
  identitySQL,
  enumerationSQL,
  foreignKeySQL,
  indexSQL,
  primaryKeySQL,
  tableSQL,
  uniqueSQL,
  checkSQL,
  extensionSQL,
  keptExtensionSQL,
} from "./ddl";
import {
  canonicalJSON,
  checksum,
  commentText,
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
  readonly tables?: Readonly<Record<string, string>>;
  readonly columns?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

/**
 * Rename hints as maps. Table and column names are chosen by the user, and a
 * plain object answers `constructor`, `toString` or `__proto__` from its
 * prototype, which would make such a table or column look renamed to nothing.
 */
export type RenameMaps = {
  readonly tables: ReadonlyMap<string, string>;
  readonly columns: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

export const renameMaps = (hints: RenameHints = {}): RenameMaps => ({
  tables: new Map(Object.entries(hints.tables ?? {})),
  columns: new Map(
    Object.entries(hints.columns ?? {}).map(
      ([table, columns]) =>
        [table, new Map(Object.entries(columns ?? {}))] as const,
    ),
  ),
});

const NO_RENAMES: ReadonlyMap<string, string> = new Map();

export type MigrationDiffOptions = {
  readonly online?: boolean;
  readonly renames?: RenameHints;
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
  primaryRenamed: boolean;
  affected: string[];
  renamed: <Definition>(definition: Definition) => Definition;
  types: ReadonlyMap<string, string>;
};

/** USING expressions by table and column. */
type Casts = ReadonlyMap<string, ReadonlyMap<string, string>>;

const equal = (left: unknown, right: unknown): boolean =>
  canonicalJSON(left ?? null) === canonicalJSON(right ?? null);

/** A definition without its declared and SQL names: what a rename leaves unchanged. */
const anonymous = (definition: unknown): unknown =>
  Object.fromEntries(
    Object.entries(definition as Record<string, unknown>).filter(
      ([key]) => key !== "name" && key !== "sqlName",
    ),
  );

/**
 * A check or index as the diff compares it: without names, and with its
 * expressions in normalized form, so rendering differences (outer parentheses,
 * literal casts, `= TRUE`, `= ANY (ARRAY[…])` for `IN`) are no change.
 * `columns` maps column names to SQL types.
 */
const comparable = (
  definition: unknown,
  columns: ReadonlyMap<string, string>,
): unknown => {
  const entry = anonymous(definition) as Record<string, unknown>;

  return {
    ...entry,
    ...(typeof entry.expression === "string"
      ? { expression: expressionKey(entry.expression, columns) }
      : {}),
    ...(typeof entry.where === "string"
      ? { where: expressionKey(entry.where, columns) }
      : {}),
    ...(Array.isArray(entry.keys)
      ? {
          keys: entry.keys.map((key) =>
            typeof key === "string" ? indexKeyKey(key, columns) : key,
          ),
        }
      : {}),
    // PostgreSQL keeps storage parameters as text: fillfactor 50 is "50".
    ...(entry.with && typeof entry.with === "object"
      ? {
          with: Object.fromEntries(
            Object.entries(entry.with as Record<string, unknown>).map(
              ([name, value]) => [name, String(value)],
            ),
          ),
        }
      : {}),
  };
};

/**
 * A check or index with its expressions in the form the diff compares,
 * names kept: two that are equal need no SQL (`diff` lists neither).
 */
export const normalizedDefinition = <Definition extends object>(
  definition: Definition,
  columns: ReadonlyMap<string, string>,
): Definition => ({
  ...definition,
  ...(comparable(definition, columns) as object),
});

/** A string as it appears inside canonical JSON, without the surrounding quotes. */
const escapedJSON = (value: string): string =>
  JSON.stringify(value).slice(1, -1);

/** What comparing a table's previous and next checks and indexes needs to know. */
export type DefinitionScope = Pick<TablePair, "affected" | "renamed" | "types">;

/**
 * Applies column renames (quoted old name to quoted new name) to every
 * expression of a definition.
 */
export const renamedDefinitions =
  (columnRenames: ReadonlyMap<string, string>): TablePair["renamed"] =>
  (definition) =>
    columnRenames.size
      ? JSON.parse(
          JSON.stringify(definition, (_name, value) =>
            typeof value === "string"
              ? renameExpressionIdentifiers(value, columnRenames)
              : value,
          ),
        )
      : definition;

/** A definition survives when only renamed columns changed and no column it uses is retyped or dropped. */
export const changedDefinition = (
  pair: DefinitionScope,
  previous: unknown,
  next: unknown,
): boolean => {
  if (!previous || !next) {
    return true;
  }

  const text = canonicalJSON(previous);

  return (
    pair.affected.some((name) => text.includes(escapedJSON(name))) ||
    !equal(
      comparable(pair.renamed(previous), pair.types),
      comparable(next, pair.types),
    )
  );
};

/**
 * The definition each previous index or check continues as: the one with the
 * same SQL name, or else the single one equal to it apart from names. Renamed
 * tables and columns change SQL names, and snapshots keep no declared key.
 */
export const counterparts = <Definition extends { sqlName: string }>(
  pair: DefinitionScope,
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

    const shape = canonicalJSON(
      comparable(pair.renamed(definition), pair.types),
    );
    const candidates = next.filter(
      (candidate) =>
        !taken.has(candidate.sqlName) &&
        canonicalJSON(comparable(candidate, pair.types)) === shape,
    );

    if (candidates.length === 1) {
      matches.set(definition.sqlName, candidates[0]!);
      taken.add(candidates[0]!.sqlName);
    }
  }

  return matches;
};

const direction = (
  before: MigrationSnapshot,
  after: MigrationSnapshot,
  renames: RenameMaps,
  casts: Casts,
  online = false,
  /** Down SQL: USING expressions name columns as the up migration left them. */
  reverse = false,
): string[] => {
  const beforeTables = new Map(
    before.tables.map((table) => [table.name, table]),
  );
  const afterTables = new Map(after.tables.map((table) => [table.name, table]));
  const tableNames = renames.tables;

  /** A reference as it reads after this diff's table and column renames. */
  const renamedReference = (reference: {
    table: string;
    column: string;
    onDelete: string;
    onUpdate?: string;
  }): {
    table: string;
    column: string;
    onDelete: string;
    onUpdate?: string;
  } => {
    const table = tableNames.get(reference.table) ?? reference.table;

    return {
      table,
      column:
        renames.columns.get(table)?.get(reference.column) ?? reference.column,
      onDelete: reference.onDelete,
      ...(reference.onUpdate === undefined
        ? {}
        : { onUpdate: reference.onUpdate }),
    };
  };

  for (const [previous, next] of tableNames) {
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

  if (new Set(tableNames.values()).size !== tableNames.size) {
    throw new Error("symmetria: duplicate table rename target");
  }

  const beforeEnumerations = new Map(
    before.enumerations.map((enumeration) => [enumeration.name, enumeration]),
  );
  const afterEnumerations = new Map(
    after.enumerations.map((enumeration) => [enumeration.name, enumeration]),
  );

  // An enum that keeps its labels and its columns under a new name (a typeName()
  // edit, or a renamed table or column behind a derived name) is renamed in place.
  const enumerationColumns = (
    snapshot: MigrationSnapshot,
    name: string,
  ): [string, string][] =>
    snapshot.tables.flatMap((table) =>
      table.columns
        .filter((column) => column.enumeration === name)
        .map((column): [string, string] => [table.name, column.name]),
    );
  const enumerationRenames = new Map<string, string>();

  for (const next of after.enumerations) {
    if (beforeEnumerations.has(next.name)) {
      continue;
    }

    const candidates = before.enumerations.filter((previous) => {
      if (
        afterEnumerations.has(previous.name) ||
        !equal(previous.values, next.values)
      ) {
        return false;
      }

      const continued = enumerationColumns(before, previous.name).map(
        ([table, column]) => {
          const tableName = tableNames.get(table) ?? table;
          const columnName =
            renames.columns.get(tableName)?.get(column) ?? column;

          return afterTables
            .get(tableName)
            ?.columns.find((candidate) => candidate.name === columnName)
            ?.enumeration;
        },
      );

      return (
        continued.includes(next.name) &&
        continued.every(
          (enumeration) =>
            enumeration === undefined || enumeration === next.name,
        )
      );
    });

    if (
      candidates.length === 1 &&
      ![...enumerationRenames.keys()].includes(candidates[0]!.name)
    ) {
      enumerationRenames.set(candidates[0]!.name, next.name);
    }
  }

  /** The before-name of an enum, through a rename detected above. */
  const previousEnumeration = (name: string): string =>
    [...enumerationRenames].find(([, next]) => next === name)?.[0] ?? name;

  // ALTER TYPE ... ADD VALUE runs inside a transaction on PostgreSQL 12+, but the new
  // label cannot be used until commit. Values that a default or CHECK in this migration
  // already needs force the replace-and-cast rewrite instead.
  const usedInMigration = (enumeration: string, value: string): boolean => {
    return after.tables.some(
      (table) =>
        table.columns.some(
          (column) =>
            column.enumeration === enumeration &&
            column.default !== undefined &&
            expressionUsesLiteral(column.default, value),
        ) ||
        (table.checks ?? []).some((check) =>
          expressionUsesLiteral(check.expression, value),
        ) ||
        table.indexes.some(
          (index) =>
            (index.where !== undefined &&
              expressionUsesLiteral(index.where, value)) ||
            index.keys.some((key) => expressionUsesLiteral(key, value)),
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
    // numeric(6) is numeric(6,0): spellings of one type change nothing.
    normalizeSqlType(previous.sqlType) !== normalizeSqlType(next.sqlType) ||
    (previous.enumeration === undefined
      ? undefined
      : (enumerationRenames.get(previous.enumeration) ??
        previous.enumeration)) !== next.enumeration ||
    // A new collation is applied with ALTER COLUMN ... TYPE ... COLLATE.
    previous.collation !== next.collation ||
    !!(
      next.enumeration &&
      !additiveEnums.has(next.enumeration) &&
      !equal(
        beforeEnumerations.get(previousEnumeration(next.enumeration))?.values,
        afterEnumerations.get(next.enumeration)?.values,
      )
    );

  const pairs: TablePair[] = [];

  for (const previous of before.tables) {
    const next = afterTables.get(
      tableNames.get(previous.name) ?? previous.name,
    );

    if (!next) {
      continue;
    }

    const columnNames = renames.columns.get(next.name) ?? NO_RENAMES;

    for (const [previousName, nextName] of columnNames) {
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

    if (new Set(columnNames.values()).size !== columnNames.size) {
      throw new Error("symmetria: duplicate column rename target");
    }

    const matched = previous.columns.flatMap((column): ColumnPair[] => {
      const target = next.columns.find(
        (candidate) =>
          candidate.name === (columnNames.get(column.name) ?? column.name),
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
    const retyped = matched
      .filter((pair) => pair.typeChanged)
      .map((pair) => quoteIdentifier(pair.before.name));
    const renamedColumns = new Map(
      [...columnNames].map(
        ([from, to]) => [quoteIdentifier(from), quoteIdentifier(to)] as const,
      ),
    );
    // A generated column cannot be altered into another expression, and
    // PostgreSQL refuses to retype a column it is computed from. Unless it
    // stays exactly what it was, it is dropped and added again, like a column
    // that leaves and one that arrives.
    const columns = matched.filter(({ before, after, typeChanged }) =>
      before.generated === undefined && after.generated === undefined
        ? true
        : before.generated !== undefined &&
          after.generated !== undefined &&
          !typeChanged &&
          renameExpressionIdentifiers(before.generated, renamedColumns) ===
            after.generated &&
          !retyped.some((name) => before.generated!.includes(name)),
    );
    const primaryChanged =
      !equal(
        previous.primaryKey.map((name) => columnNames.get(name) ?? name),
        next.primaryKey,
      ) ||
      columns.some(
        (column) =>
          column.typeChanged &&
          previous.primaryKey.includes(column.before.name),
      );
    // A widened column keeps its indexes and checks: PostgreSQL changes its
    // declaration in place, and rebuilding an index of a large table for it
    // would hold a lock for nothing.
    const affected = previous.columns
      .filter(
        (column) =>
          !columns.some(
            (pair) =>
              pair.before.name === column.name &&
              (!pair.typeChanged || widens(pair.before, pair.after)),
          ),
      )
      .map((column) => quoteIdentifier(column.name));
    const columnRenames = new Map(
      columns
        .filter((column) => column.before.name !== column.after.name)
        .map(
          (column) =>
            [
              quoteIdentifier(column.before.name),
              quoteIdentifier(column.after.name),
            ] as const,
        ),
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
      types: new Map(
        next.columns.map((column) => [column.name, column.sqlType]),
      ),
      renamed: renamedDefinitions(columnRenames),
    });
  }

  for (const name of renames.columns.keys()) {
    if (!pairs.some((pair) => pair.after.name === name)) {
      throw new Error(`symmetria: unknown column-rename table "${name}"`);
    }
  }

  for (const [table, columns] of casts) {
    for (const [column, expression] of columns) {
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

  // Down SQL retypes a renamed column before renaming it back: the reverse of
  // up's rename-then-retype, so a `using` down expression sees the name up gave it.
  const renamedAfterRetype = (column: ColumnPair): boolean =>
    reverse && column.typeChanged && column.before.name !== column.after.name;

  const statements: string[] = [];
  const droppedReferences = new Set<string>();
  // Foreign keys dropped only to change their actions: the same column and
  // target held, so adding them again cannot fail.
  const heldReferences = new Set<string>();
  // Indexes, constraints and types this migration drops, and the names it
  // creates: a drop whose name is not created again removes something no
  // longer declared, which loses no data, and the saved SQL says so (SQL lint
  // alone would rate it destructive).
  const drops: { position: number; note: string; name?: string }[] = [];
  const created = new Set<string>();

  const pushDrop = (statement: string, note: string, name?: string): void => {
    statements.push(statement);
    drops.push({
      position: statements.length - 1,
      note,
      ...(name === undefined ? {} : { name }),
    });
  };

  // Remove dependencies before changing or removing keys, types, columns or tables.
  for (const table of before.tables) {
    for (const column of table.columns) {
      if (column.references) {
        const pair = previousPairs.get(table.name);
        const match = pair?.columns.find(
          (candidate) => candidate.before.name === column.name,
        );

        const renamed = renamedReference(column.references);
        const keyKept =
          !removedTableNames.has(column.references.table) &&
          !changedKeys.has(
            referenceKey(column.references.table, column.references.column),
          );

        if (
          !pair ||
          !match ||
          match.typeChanged ||
          !equal(renamed, match.after.references) ||
          !keyKept
        ) {
          const name = objectName(table.name, column.name, "fkey");
          const statement = `ALTER TABLE ${quoteIdentifier(table.name)} DROP CONSTRAINT ${quoteIdentifier(name)}`;

          // With its column or table gone, the drop goes with a destructive one.
          if (pair && match) {
            pushDrop(
              statement,
              `foreign key "${name}" is no longer declared; dropping it loses no data.`,
              name,
            );
          } else {
            statements.push(statement);
          }

          droppedReferences.add(referenceKey(table.name, column.name));

          if (
            match &&
            !match.typeChanged &&
            keyKept &&
            match.after.references?.table === renamed.table &&
            match.after.references.column === renamed.column
          ) {
            heldReferences.add(referenceKey(table.name, column.name));
          }
        }
      }
    }
  }

  for (const pair of pairs) {
    for (const definition of pair.before.indexes) {
      if (droppedIndexes.has(definition.sqlName)) {
        pushDrop(
          `DROP INDEX ${online ? "CONCURRENTLY " : ""}${quoteIdentifier(definition.sqlName)}`,
          definition.unique
            ? `unique index "${definition.sqlName}" is no longer declared; dropping it loses no data, and the database stops refusing duplicates.`
            : `index "${definition.sqlName}" is no longer declared; dropping it loses no data, but queries that used it can get slower.`,
          definition.sqlName,
        );
      }
    }

    for (const definition of pair.before.checks ?? []) {
      if (changedCheck(pair, definition)) {
        pushDrop(
          `ALTER TABLE ${quoteIdentifier(pair.before.name)} DROP CONSTRAINT ${quoteIdentifier(definition.sqlName)}`,
          `CHECK constraint "${definition.sqlName}" is no longer declared; dropping it loses no data.`,
          definition.sqlName,
        );
      }
    }

    if (pair.primaryChanged && pair.before.primaryKey.length) {
      const name = objectName(pair.before.name, "pkey");

      pushDrop(
        `ALTER TABLE ${quoteIdentifier(pair.before.name)} DROP CONSTRAINT ${quoteIdentifier(name)}`,
        `primary key "${name}" is no longer declared; dropping it loses no data.`,
        name,
      );
    }

    for (const column of pair.columns) {
      if (column.before.unique && uniqueChanged(column)) {
        const name = objectName(pair.before.name, column.before.name, "key");

        pushDrop(
          `ALTER TABLE ${quoteIdentifier(pair.before.name)} DROP CONSTRAINT ${quoteIdentifier(name)}`,
          `unique constraint "${name}" is no longer declared; dropping it loses no data.`,
          name,
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
      if (
        column.before.name !== column.after.name &&
        !renamedAfterRetype(column)
      ) {
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
    const leaving = pair.before.columns.filter(
      (column) =>
        !pair.columns.some((match) => match.before.name === column.name),
    );

    // A generated column goes before the columns it is computed from, which
    // PostgreSQL refuses to drop while it depends on them.
    for (const column of [
      ...leaving.filter((column) => column.generated !== undefined),
      ...leaving.filter((column) => column.generated === undefined),
    ]) {
      statements.push(
        `ALTER TABLE ${quoteIdentifier(pair.after.name)} DROP COLUMN ${quoteIdentifier(column.name)}`,
      );
    }
  }

  // Extensions provide types that tables and indexes depend on, so they come first.
  for (const name of after.extensions ?? []) {
    if (!(before.extensions ?? []).includes(name)) {
      statements.push(extensionSQL(name));
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
    const renamedFrom = previousEnumeration(enumeration.name);

    if (renamedFrom !== enumeration.name) {
      statements.push(
        `ALTER TYPE ${quoteIdentifier(renamedFrom)} RENAME TO ${quoteIdentifier(enumeration.name)}`,
      );
      continue;
    }

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

    // Rows using a removed label make the rebuild fail; generate needed
    // --allow-destructive for it, and the saved SQL says so.
    const removed = previous
      ? previous.values.filter((value) => !enumeration.values.includes(value))
      : [];

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

    statements.push(
      `${removed.length ? `${DESTRUCTIVE_NOTE} ${commentText(`Enum "${enumeration.name}" drops ${removed.map((value) => `'${value}'`).join(", ")}; rows using those labels make the rebuild fail.`)}\n` : ""}${enumerationSQL(enumeration.name, enumeration.values)}`,
    );
  }

  for (const table of addedTables) {
    statements.push(tableSQL(table));
  }

  for (const pair of pairs) {
    const alter = `ALTER TABLE ${quoteIdentifier(pair.after.name)}`;

    for (const column of pair.after.columns) {
      if (
        pair.columns.some((match) => match.after.name === column.name) ||
        // Computed from the other columns: added once they are what they will be.
        column.generated !== undefined
      ) {
        continue;
      }

      if (column.notNull && column.default === undefined && !column.identity) {
        // Existing rows have no value for the column: add it nullable and leave a
        // place for the backfill before NOT NULL is enforced.
        statements.push(
          `${alter} ADD COLUMN ${columnSQL({ ...column, notNull: false })}`,
          `-- ${commentText(`Backfill ${quoteIdentifier(pair.after.name)}.${quoteIdentifier(column.name)} for existing rows before this statement.`)}\n${alter} ALTER COLUMN ${quoteIdentifier(column.name)} SET NOT NULL`,
        );
        continue;
      }

      statements.push(`${alter} ADD COLUMN ${columnSQL(column)}`);
    }

    for (const column of pair.columns) {
      const previous = column.before;
      const next = column.after;
      const renameLater = renamedAfterRetype(column);
      const current = renameLater ? previous.name : next.name;
      let prefix = `${alter} ALTER COLUMN ${quoteIdentifier(current)}`;

      if (previous.identity && !next.identity) {
        statements.push(`${prefix} DROP IDENTITY`);
      }

      // SET DEFAULT replaces a default in place; dropping it first would leave
      // a window without one when each statement commits (--online).
      if (
        previous.default !== undefined &&
        (column.typeChanged || next.identity || next.default === undefined)
      ) {
        statements.push(`${prefix} DROP DEFAULT`);
      }

      if (column.typeChanged) {
        // An explicit ::varchar(n) cuts long values; without USING, PostgreSQL's
        // assignment cast rejects them instead.
        const supplied = casts.get(pair.after.name)?.get(next.name);
        // A cast would use the migrating session's time zone.
        const atUtc =
          supplied === undefined ? utcConversion(previous, next) : undefined;
        if (supplied === undefined && castless(previous, next)) {
          // `using` is keyed by the names the up migration gives.
          const [table, name] = reverse
            ? [pair.before.name, previous.name]
            : [pair.after.name, next.name];

          throw new Error(
            reverse
              ? `symmetria: PostgreSQL has no cast from ${previous.sqlType} back to ${next.sqlType} for "${table}"."${name}", so the migration could not be rolled back; give the conversion for both directions in the --diff file: { "using": { "${table}": { "${name}": { "up": "…", "down": "…" } } } }`
              : `symmetria: PostgreSQL has no cast from ${previous.sqlType} to ${next.sqlType} for "${table}"."${name}", so the migration could not run; give the conversion for both directions in the --diff file: { "using": { "${table}": { "${name}": { "up": "…", "down": "…" } } } }`,
          );
        }

        const change = typeConversion(previous, next);
        const conversion =
          supplied ??
          (change?.assignmentCast
            ? undefined
            : change?.cleared
              ? "NULL"
              : typeof atUtc === "function"
                ? atUtc(quoteIdentifier(current), columnTypeSQL(next))
                : `${quoteIdentifier(current)}${previous.enumeration || next.enumeration ? "::text" : ""}::${columnTypeSQL(next)}`);

        // An array has no AT TIME ZONE, a timetz takes the session's offset
        // and USING takes no subquery, so the cast itself runs with the zone
        // set to UTC.
        if (atUtc === "session") {
          statements.push("SET TIME ZONE 'UTC'");
        }

        // The saved SQL says what generate knew: lint of the file rates it
        // as generate did.
        statements.push(
          `${change?.lossy ? `${DESTRUCTIVE_NOTE} ${commentText(supplied === undefined ? conversionMessage(previous, next, change) : `Column "${next.name}" narrows from ${previous.enumeration ?? previous.sqlType} to ${next.enumeration ?? next.sqlType} with the USING conversion given for it.`)}\n` : ""}${prefix} TYPE ${columnTypeSQL(next)}${conversion === undefined ? "" : ` USING ${conversion}`}`,
        );

        if (atUtc === "session") {
          statements.push("RESET TIME ZONE");
        }

        if (renameLater) {
          statements.push(
            `${alter} RENAME COLUMN ${quoteIdentifier(previous.name)} TO ${quoteIdentifier(next.name)}`,
          );
          prefix = `${alter} ALTER COLUMN ${quoteIdentifier(next.name)}`;
        }
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
          created.add(
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

      if (
        previous.identity &&
        next.identity &&
        !previous.identityByDefault !== !next.identityByDefault
      ) {
        statements.push(
          `${prefix} SET GENERATED ${next.identityByDefault ? "BY DEFAULT" : "ALWAYS"}`,
        );
      }

      if (!previous.identity && next.identity) {
        statements.push(`${prefix} ADD ${identitySQL(next)}`);
        statements.push(
          `SELECT setval(pg_get_serial_sequence(${quoteLiteral(quoteIdentifier(pair.after.name))}, ${quoteLiteral(next.name)}), GREATEST(COALESCE(MAX(${quoteIdentifier(next.name)}), 0), 0) + 1, false) FROM ${quoteIdentifier(pair.after.name)}`,
        );
      }

      if (
        next.default !== undefined &&
        (column.typeChanged ||
          (previous.default !== next.default &&
            // Two spellings of one value (a pulled default) are no change.
            (previous.default === undefined ||
              defaultKey(previous.default, next) !==
                defaultKey(next.default, next))))
      ) {
        statements.push(`${prefix} SET DEFAULT ${next.default}`);
      }

      // Embeddings of other text, or of another model, would rank rows by
      // what they no longer say; emptied, reindex() computes them again.
      const stale = embeddingChange(
        previous,
        next,
        new Map(
          pair.columns.map((match) => [match.before.name, match.after.name]),
        ),
      );

      if (
        stale &&
        !(column.typeChanged && typeConversion(previous, next)?.cleared)
      ) {
        statements.push(
          `${DESTRUCTIVE_NOTE} ${commentText(`the embeddings in "${next.name}" are cleared: ${stale}.`)}\nUPDATE ${quoteIdentifier(pair.after.name)} SET ${quoteIdentifier(next.name)} = NULL WHERE ${quoteIdentifier(next.name)} IS NOT NULL`,
        );
      }
    }

    for (const column of pair.after.columns) {
      if (
        column.generated !== undefined &&
        !pair.columns.some((match) => match.after.name === column.name)
      ) {
        statements.push(`${alter} ADD COLUMN ${columnSQL(column)}`);
      }
    }

    if (pair.primaryChanged && pair.after.primaryKey.length) {
      created.add(objectName(pair.after.name, "pkey"));
      // A key over columns that contain the previous one, none of them
      // retyped, keeps existing rows unique.
      const previousKey = pair.before.primaryKey.map(
        (name) =>
          pair.columns.find((column) => column.before.name === name)?.after
            .name ?? name,
      );
      const contained =
        previousKey.length > 0 &&
        previousKey.every((name) => pair.after.primaryKey.includes(name)) &&
        !pair.columns.some(
          (column) =>
            column.typeChanged &&
            pair.before.primaryKey.includes(column.before.name),
        );
      statements.push(
        `${contained ? `${CAUTION_NOTE} ${commentText(`the primary key (${pair.after.primaryKey.join(", ")}) contains the previous key (${previousKey.join(", ")}), so existing rows stay unique.`)}\n` : ""}${alter} ADD ${primaryKeySQL(pair.after)}`,
      );
    }

    for (const definition of pair.after.checks ?? []) {
      const previousName = previousOf(checkMatches.get(pair), definition);
      const previous = pair.before.checks?.find(
        (candidate) => candidate.sqlName === previousName,
      );

      if (!previous || changedCheck(pair, previous)) {
        created.add(definition.sqlName);
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
        created.add(objectName(pair.after.name, column.name, "key"));

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
        created.add(definition.sqlName);
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
          const held =
            !online &&
            !!pair &&
            !!previous &&
            heldReferences.has(referenceKey(pair.before.name, previous.name));
          created.add(objectName(table.name, column.name, "fkey"));
          statements.push(
            `${held ? `${CAUTION_NOTE} the foreign key held with the same column and target; only its actions change, so existing rows still match.\n` : ""}${foreignKeySQL(table, column)}${online ? " NOT VALID" : ""}`,
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

    if (
      temporary ||
      (!afterEnumerations.has(enumeration.name) &&
        !enumerationRenames.has(enumeration.name))
    ) {
      // DROP TYPE without CASCADE fails while a column uses the type.
      pushDrop(
        `DROP TYPE ${quoteIdentifier(temporary ?? enumeration.name)}`,
        temporary
          ? `type "${temporary}" held the previous labels of "${enumeration.name}" and is no longer used; dropping it loses no data.`
          : `type "${enumeration.name}" is no longer used; dropping it loses no data.`,
      );
    }
  }

  for (const name of before.extensions ?? []) {
    if (!(after.extensions ?? []).includes(name)) {
      statements.push(keptExtensionSQL(name));
    }
  }

  for (const drop of drops) {
    if (drop.name === undefined || !created.has(drop.name)) {
      statements[drop.position] =
        `${CAUTION_NOTE} ${commentText(drop.note)}\n${statements[drop.position]}`;
    }
  }

  return statements;
};

/**
 * A snapshot whose defaults, generated columns, checks and index predicates
 * end a `--` comment at their end with a line break. Snapshots saved by
 * earlier versions hold `1 -- one`, which a migration restoring it wrote as
 * `SET DEFAULT 1 -- one;`, commenting out the semicolon and joining the next
 * statement to it.
 */
const commentsEnded = (snapshot: MigrationSnapshot): MigrationSnapshot => ({
  ...snapshot,
  tables: snapshot.tables.map((table) => ({
    ...table,
    columns: table.columns.map((column) => ({
      ...column,
      ...(column.default === undefined
        ? {}
        : { default: commentEnded(column.default) }),
      ...(column.generated === undefined
        ? {}
        : { generated: commentEnded(column.generated) }),
    })),
    indexes: table.indexes.map((index) =>
      index.where === undefined
        ? index
        : { ...index, where: commentEnded(index.where) },
    ),
    ...(table.checks
      ? {
          checks: table.checks.map((check) => ({
            ...check,
            expression: commentEnded(check.expression),
          })),
        }
      : {}),
  })),
});

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
  const renames = renameMaps(options.renames);
  const reverseTables = new Map(
    [...renames.tables].map(([previous, next]) => [next, previous] as const),
  );
  const reverseColumns = new Map(
    [...renames.columns].map(
      ([table, columns]) =>
        [
          reverseTables.get(table) ?? table,
          new Map(
            [...columns].map(([previous, next]) => [next, previous] as const),
          ),
        ] as const,
    ),
  );
  const forwardCasts = new Map<string, Map<string, string>>();
  const reverseCasts = new Map<string, Map<string, string>>();

  for (const [table, columns] of Object.entries(options.using ?? {})) {
    for (const [column, conversion] of Object.entries(columns ?? {})) {
      const missing = (["up", "down"] as const).filter((direction) => {
        const expression = (
          conversion as Partial<Record<string, unknown>> | undefined
        )?.[direction];

        return typeof expression !== "string" || !expression.trim();
      });

      if (missing.length) {
        throw new Error(
          `symmetria: the USING conversion for "${table}.${column}" needs both directions, and ${missing.map((direction) => `"${direction}"`).join(" and ")} ${missing.length === 1 ? "is" : "are"} missing or empty: { "using": { "${table}": { "${column}": { "up": "…", "down": "…" } } } }`,
        );
      }
    }

    forwardCasts.set(
      table,
      new Map(
        Object.entries(columns).map(([column, conversion]) => [
          column,
          conversion.up,
        ]),
      ),
    );
    const originalTable = reverseTables.get(table) ?? table;
    reverseCasts.set(
      originalTable,
      new Map(
        Object.entries(columns).map(([column, conversion]) => [
          reverseColumns.get(originalTable)?.get(column) ?? column,
          conversion.down,
        ]),
      ),
    );
  }

  // The SQL is written from expressions whose `--` comment at the end has a
  // line break after it; the plan keeps the snapshots as they were saved.
  const from = commentsEnded(before);
  const to = commentsEnded(after);

  return {
    before,
    after,
    up: direction(from, to, renames, forwardCasts, options.online),
    down: direction(
      to,
      from,
      { tables: reverseTables, columns: reverseColumns },
      reverseCasts,
      options.online,
      true,
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
