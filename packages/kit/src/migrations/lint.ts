/**
 * Schema-level lint: reviews a migration plan for operations that lose data,
 * fail on populated tables or need deploy planning.
 */
import { normalizeSqlType } from "./drift";
import { objectName, quoteIdentifier } from "symmetria/internal";
import {
  changedDefinition,
  counterparts,
  renamedDefinitions,
  renameMaps,
  type DefinitionScope,
  type MigrationPlan,
  type RenameHints,
} from "./diff";
import {
  conversionMessage,
  embeddingChange,
  halfPrecision,
  typeConversion,
} from "./conversions";
import type { MigrationColumn, MigrationTable } from "./snapshot";
import { distinctDefault, VOLATILE_FUNCTION } from "./sql-lint";

/**
 * destructive: data is lost or becomes unrepresentable (generation requires
 * allowDestructive); blocking: the statement fails on existing data;
 * caution: locks, rewrites or deploy-order hazards.
 */
export type LintLevel = "destructive" | "blocking" | "caution";
export type LintFinding = {
  readonly level: LintLevel;
  readonly table: string;
  readonly column?: string;
  readonly message: string;
  readonly advice: string;
};

const levelOrder: Record<LintLevel, number> = {
  destructive: 0,
  blocking: 1,
  caution: 2,
};

/** Review a diff for operations that fail or lose data on a populated database. */
export const lintMigration = (
  plan: MigrationPlan,
  renames: RenameHints = {},
): LintFinding[] => {
  const findings: LintFinding[] = [];
  const { tables: renamedTables, columns: renamedColumnsByTable } =
    renameMaps(renames);
  const afterTables = new Map(
    plan.after.tables.map((table) => [table.name, table]),
  );

  const report = (
    level: LintLevel,
    table: string,
    message: string,
    advice: string,
    column?: string,
  ): void => {
    findings.push({
      level,
      table,
      ...(column ? { column } : {}),
      message,
      advice,
    });
  };

  /**
   * A constraint the plan adds NOT VALID and validates in its own statement
   * (--online): the validation still fails on a violating row, but under a
   * lock that lets reads and writes go on, as SQL lint rates it.
   */
  const validatedLater = (table: string, constraint: string): boolean =>
    plan.up.includes(
      `ALTER TABLE ${quoteIdentifier(table)} VALIDATE CONSTRAINT ${quoteIdentifier(constraint)}`,
    );
  const validation = (
    table: string,
    constraint: string,
    level: LintLevel,
    message: string,
    advice: string,
    column?: string,
  ): void =>
    validatedLater(table, constraint)
      ? report(
          "caution",
          table,
          `${message.replace(/; the statement fails when .*$/, "")}; it is added NOT VALID and validated in a separate statement, which fails when an existing row violates it.`,
          "Fix violating rows before the migration runs.",
          column,
        )
      : report(level, table, message, advice, column);

  // A type that keeps its labels under a new name is renamed in place (ALTER TYPE … RENAME TO).
  const renamedEnumeration = (from?: string, to?: string): boolean => {
    const previous = plan.before.enumerations.find(
      (enumeration) => enumeration.name === from,
    );
    const next = plan.after.enumerations.find(
      (enumeration) => enumeration.name === to,
    );

    return (
      previous !== undefined &&
      next !== undefined &&
      !plan.after.enumerations.some(
        (enumeration) => enumeration.name === from,
      ) &&
      !plan.before.enumerations.some(
        (enumeration) => enumeration.name === to,
      ) &&
      previous.values.join("\u0000") === next.values.join("\u0000")
    );
  };

  const rewritten = (table: MigrationTable, column: MigrationColumn): void => {
    if (column.generated !== undefined) {
      // Rewriting a table builds every index on it again; a vector index is
      // the slowest of them by far.
      const vectors = table.indexes.filter(
        (definition) =>
          definition.method === "hnsw" || definition.method === "ivfflat",
      );
      const indexes = vectors.length
        ? ` and builds every index on it again, the vector ${vectors.length === 1 ? "index" : "indexes"} ${vectors.map((definition) => `"${definition.sqlName}"`).join(", ")} too,`
        : " and builds every index on it again";

      report(
        "caution",
        table.name,
        `Column "${column.name}" is computed and stored for every existing row; PostgreSQL rewrites the table${indexes} while it holds a lock that blocks reads and writes.`,
        vectors.length
          ? "On a large table run the migration in a quiet hour; a vector index of many rows takes minutes to build."
          : "On a large table run the migration in a quiet hour.",
        column.name,
      );
    }
  };

  const compareColumns = (
    before: MigrationTable,
    after: MigrationTable,
  ): void => {
    const renamedColumns =
      renamedColumnsByTable.get(after.name) ?? new Map<string, string>();
    const afterColumns = new Map(
      after.columns.map((column) => [column.name, column]),
    );
    const beforeColumns = new Map(
      before.columns.map((column) => [column.name, column]),
    );

    for (const column of before.columns) {
      const renamedTo = renamedColumns.get(column.name);
      const next = afterColumns.get(renamedTo ?? column.name);

      // A generated column holds nothing of its own: PostgreSQL computes it
      // again from the columns that stay.
      if (!next && column.generated !== undefined) {
        continue;
      }

      if (!next) {
        report(
          "destructive",
          after.name,
          `Column "${column.name}" is dropped; its data is lost.`,
          "Stop reading and writing the column in a release first, then drop it in a later migration.",
          column.name,
        );
        continue;
      }

      if (column.generated !== undefined || next.generated !== undefined) {
        if (column.generated !== next.generated) {
          rewritten(after, next);
        }

        continue;
      }

      // Renames are catalog-only changes, and SQL lint passes the generated
      // RENAME statements; reporting them here would fail --strict only until
      // the migration is generated.
      compareColumn(after, column, next, renamedColumns);

      // A new foreign key validates every existing value; a changed action on
      // the same target column cannot fail, as the old key held.
      const target = column.references && {
        table:
          renamedTables.get(column.references.table) ?? column.references.table,
        column: column.references.column,
      };
      const targetColumn =
        target &&
        (renamedColumnsByTable.get(target.table)?.get(target.column) ??
          target.column);

      if (
        next.references &&
        (target?.table !== next.references.table ||
          targetColumn !== next.references.column)
      ) {
        validation(
          after.name,
          objectName(after.name, next.name, "fkey"),
          "blocking",
          `Column "${next.name}" gains a foreign key to ${next.references.table}.${next.references.column}; the statement fails when an existing value has no match.`,
          "Fix or clear unmatched values first, or generate with --online, which adds the key NOT VALID and validates it separately.",
          next.name,
        );
      } else if (column.references && !next.references) {
        report(
          "caution",
          after.name,
          `Column "${next.name}" loses its foreign key to ${column.references.table}.${column.references.column}; the database stops checking it.`,
          "Dropping the key loses no data; make sure nothing relies on it.",
          next.name,
        );
      } else if (
        column.references &&
        next.references &&
        (column.references.onDelete !== next.references.onDelete ||
          column.references.onUpdate !== next.references.onUpdate)
      ) {
        report(
          "caution",
          after.name,
          `The foreign key of column "${next.name}" is rebuilt to change its actions; PostgreSQL checks every existing row again while it holds a lock.`,
          "It cannot fail, as the key held; on a large table run the migration in a quiet hour, or generate with --online.",
          next.name,
        );
      }
    }

    // Checks and indexes are matched the way the diff matches them, so one
    // that only follows a renamed table or column, or is written differently,
    // is not reported as new.
    const scope: DefinitionScope = {
      affected: [],
      renamed: renamedDefinitions(
        new Map(
          [...renamedColumns].map(([previous, next]) => [
            quoteIdentifier(previous),
            quoteIdentifier(next),
          ]),
        ),
      ),
      types: new Map(
        after.columns.map((column) => [column.name, column.sqlType]),
      ),
    };
    /** The next definitions that continue a previous one unchanged, and the previous ones none continues. */
    const kept = <Definition extends { sqlName: string }>(
      previous: readonly Definition[],
      next: readonly Definition[],
    ): { kept: Set<string>; removed: Definition[] } => {
      const matches = counterparts(scope, previous, next);

      return {
        kept: new Set(
          previous.flatMap((definition) => {
            const match = matches.get(definition.sqlName);

            return match && !changedDefinition(scope, definition, match)
              ? [match.sqlName]
              : [];
          }),
        ),
        removed: previous.filter(
          (definition) => !matches.has(definition.sqlName),
        ),
      };
    };
    const checks = kept(before.checks ?? [], after.checks ?? []);
    const keptChecks = checks.kept;
    const indexes = kept(before.indexes, after.indexes);
    const keptIndexes = indexes.kept;

    // Removing a check or an index loses no data.
    for (const definition of checks.removed) {
      report(
        "caution",
        after.name,
        `CHECK constraint "${definition.sqlName}" is dropped; the database stops checking it.`,
        "Dropping the constraint loses no data; make sure nothing relies on it.",
      );
    }

    for (const definition of indexes.removed) {
      report(
        "caution",
        after.name,
        definition.unique
          ? `Unique index "${definition.sqlName}" is dropped; the database stops refusing duplicates.`
          : `Index "${definition.sqlName}" is dropped; queries that used it can get slower.`,
        "Dropping the index loses no data; make sure nothing relies on it.",
      );
    }

    // CHECK constraints validate every existing row, like NOT NULL.
    for (const definition of after.checks ?? []) {
      if (!keptChecks.has(definition.sqlName)) {
        validation(
          after.name,
          definition.sqlName,
          "blocking",
          `CHECK constraint "${definition.sqlName}" is added; the statement fails when an existing row violates it.`,
          "Fix violating rows first, or generate with --online, which adds the check NOT VALID and validates it separately.",
        );
      }
    }

    for (const column of after.columns) {
      if (
        beforeColumns.has(column.name) ||
        [...renamedColumns.values()].includes(column.name)
      ) {
        continue;
      }

      if (column.generated !== undefined) {
        rewritten(after, column);
        continue;
      }

      const unfilled =
        column.notNull && column.default === undefined && !column.identity;
      // A volatile default is computed for every existing row; an identity, a
      // sequence or a uuid generator gives each its own value, while
      // clock_timestamp() or random() can repeat.
      const volatile =
        column.default !== undefined && VOLATILE_FUNCTION.test(column.default);
      const distinct =
        column.identity ||
        (column.default !== undefined && distinctDefault(column.default));

      if (unfilled) {
        report(
          "blocking",
          after.name,
          `Column "${column.name}" is added as NOT NULL without a default; the statement fails when the table has rows.`,
          "Add a default, or add the column as nullable, backfill it and set NOT NULL in a later migration.",
          column.name,
        );
      }

      if (column.identity || volatile) {
        report(
          "caution",
          after.name,
          column.identity
            ? `Column "${column.name}" is added as an identity column; PostgreSQL numbers every existing row and rewrites the table while it holds a lock that blocks reads and writes.`
            : `Column "${column.name}" gets its default computed for every existing row; PostgreSQL rewrites the table while it holds a lock that blocks reads and writes.`,
          "On a large table run the migration in a quiet hour.",
          column.name,
        );
      }

      if (column.unique && !unfilled) {
        if (column.default !== undefined && !distinct) {
          report(
            "blocking",
            after.name,
            volatile
              ? `Column "${column.name}" is added with a UNIQUE constraint and the default ${column.default}, whose values can repeat across existing rows; the statement fails when two rows get the same one.`
              : `Column "${column.name}" is added with a UNIQUE constraint and the default ${column.default}; every existing row receives that value, so the statement fails when the table has two or more rows.`,
            "Add the column without UNIQUE, give existing rows distinct values, then add the constraint in a later migration.",
            column.name,
          );
        } else {
          report(
            "caution",
            after.name,
            `Column "${column.name}" is added with a UNIQUE constraint; existing rows hold distinct values or NULL, and the index is built while writes wait.`,
            "On a large table run the migration in a quiet hour.",
            column.name,
          );
        }
      }

      // Existing rows that get a value are checked against the key.
      if (
        column.references &&
        !unfilled &&
        (column.identity || column.default !== undefined)
      ) {
        validation(
          after.name,
          objectName(after.name, column.name, "fkey"),
          "blocking",
          `Column "${column.name}" is added with a foreign key to ${column.references.table}.${column.references.column} and a value for every existing row; the statement fails when one has no match.`,
          "Add the column without a default, or generate with --online, which adds the key NOT VALID and validates it separately.",
          column.name,
        );
      }
    }

    for (const definition of after.indexes) {
      if (keptIndexes.has(definition.sqlName)) {
        continue;
      }

      report(
        definition.unique ? "blocking" : "caution",
        after.name,
        definition.unique
          ? `Unique index "${definition.sqlName}" fails when existing rows contain duplicates.`
          : `Index "${definition.sqlName}" is created inside the migration transaction and blocks writes while it builds.`,
        definition.unique
          ? "Deduplicate the data first, then add the index."
          : "For large tables create it separately with $createIndexes({ concurrently: true }).",
      );
    }

    const previousKey = before.primaryKey.map(
      (name) => renamedColumns.get(name) ?? name,
    );

    if (JSON.stringify(previousKey) !== JSON.stringify(after.primaryKey)) {
      // A key over columns that contain the previous one, none retyped,
      // keeps existing rows unique.
      const contained =
        previousKey.length > 0 &&
        previousKey.every((name) => after.primaryKey.includes(name)) &&
        before.primaryKey.every((name) => {
          const previous = beforeColumns.get(name)!;
          const next = afterColumns.get(renamedColumns.get(name) ?? name);

          return (
            next !== undefined &&
            normalizeSqlType(previous.sqlType) ===
              normalizeSqlType(next.sqlType) &&
            previous.enumeration === next.enumeration
          );
        });
      // A column added with an identity, a sequence or a uuid generator gives
      // every existing row its own non-null value, so a key over it cannot fail.
      const fresh = after.primaryKey.some((name) => {
        const column = afterColumns.get(name);

        return (
          column !== undefined &&
          !beforeColumns.has(name) &&
          ![...renamedColumns.values()].includes(name) &&
          column.generated === undefined &&
          (column.identity ||
            (column.default !== undefined && distinctDefault(column.default)))
        );
      });

      if (!after.primaryKey.length) {
        report(
          "caution",
          after.name,
          `Primary key (${before.primaryKey.join(", ")}) is dropped; the database stops refusing duplicate keys.`,
          "Dropping the key loses no data; foreign keys that reference it must go first.",
        );
      } else if (contained || fresh) {
        report(
          "caution",
          after.name,
          `Primary key changes from (${before.primaryKey.join(", ")}) to (${after.primaryKey.join(", ")}).`,
          "The table is rewritten and foreign keys are rebuilt; plan the deploy for low traffic.",
        );
      } else {
        report(
          "blocking",
          after.name,
          `Primary key changes from (${before.primaryKey.join(", ")}) to (${after.primaryKey.join(", ")}); the statement fails when existing rows share a key or hold NULL in it.`,
          "Make the new key's values unique first; the table is rewritten and foreign keys are rebuilt, so plan the deploy for low traffic.",
        );
      }
    }
  };

  const compareColumn = (
    table: MigrationTable,
    before: MigrationColumn,
    after: MigrationColumn,
    renamedColumns: ReadonlyMap<string, string> = new Map(),
  ): void => {
    const retyped =
      normalizeSqlType(before.sqlType) !== normalizeSqlType(after.sqlType) ||
      (before.enumeration !== after.enumeration &&
        !renamedEnumeration(before.enumeration, after.enumeration));
    const change = retyped ? typeConversion(before, after) : undefined;
    const stale = embeddingChange(before, after, renamedColumns);

    if (stale && !change?.cleared) {
      report(
        "destructive",
        table.name,
        `The embeddings in "${after.name}" are cleared: ${stale}, so the stored ones describe other text. Every row of the table is updated.`,
        "Generate with --allow-destructive, then run search.reindex() after the migration to compute them again; search.missing() counts what is left.",
        after.name,
      );
    }

    if (change?.lossy) {
      report(
        "destructive",
        table.name,
        conversionMessage(before, after, change),
        change.assignmentCast
          ? "Shorten or move longer values first, then generate with --allow-destructive; the SQL has no truncating cast, so PostgreSQL refuses values that still do not fit."
          : change.cleared
            ? "Generate with --allow-destructive, then compute the embeddings again after the migration (search.reindex() for a search's own column)."
            : change.refused
              ? "Move or change the values that do not fit first, then generate with --allow-destructive; PostgreSQL refuses values that still do not fit."
              : "Copy the column or back up the table if the lost precision matters, then generate with --allow-destructive.",
        after.name,
      );
    } else if (retyped && halfPrecision(before, after)) {
      report(
        "caution",
        table.name,
        `Column "${after.name}" changes from ${before.sqlType} to ${after.sqlType}: every stored number is rounded to half precision, about 3 significant digits, and a number beyond ±65504 makes the migration fail.`,
        "Distances barely change at half precision, and embedding models stay far inside the range; PostgreSQL rewrites the table and builds its vector indexes again, so run it in a quiet hour.",
        after.name,
      );
    } else if (retyped) {
      report(
        "caution",
        table.name,
        `Column "${after.name}" changes type from ${before.enumeration ?? before.sqlType} to ${after.enumeration ?? after.sqlType}.`,
        "PostgreSQL rewrites the table and the USING cast can fail on existing values; add a new column, backfill in batches and swap it in a later migration.",
        after.name,
      );
    }

    if (!before.notNull && after.notNull) {
      report(
        "blocking",
        table.name,
        `Column "${after.name}" becomes NOT NULL; the statement fails when existing rows contain NULL.`,
        "Backfill NULL values first, or add a default and set NOT NULL in a later migration.",
        after.name,
      );
    }

    if (!before.unique && after.unique) {
      report(
        "blocking",
        table.name,
        `Column "${after.name}" becomes UNIQUE; the statement fails when existing rows contain duplicates.`,
        "Deduplicate the data first, then add the constraint.",
        after.name,
      );
    } else if (before.unique && !after.unique) {
      report(
        "caution",
        table.name,
        `Column "${after.name}" is no longer UNIQUE; the database stops refusing duplicates.`,
        "Dropping the constraint loses no data; make sure nothing relies on it.",
        after.name,
      );
    }
  };

  for (const table of plan.before.tables) {
    const renamedTo = renamedTables.get(table.name);
    const next = afterTables.get(renamedTo ?? table.name);

    if (!next) {
      report(
        "destructive",
        table.name,
        `Table "${table.name}" is dropped; its rows are lost.`,
        "Stop using the table in a release first, keep a backup, then drop it in a later migration.",
      );
      continue;
    }

    compareColumns(table, next);
  }

  for (const enumeration of plan.before.enumerations) {
    const next = plan.after.enumerations.find(
      (candidate) => candidate.name === enumeration.name,
    );

    if (!next) {
      continue;
    }

    const removed = enumeration.values.filter(
      (value) => !next.values.includes(value),
    );

    if (removed.length) {
      // Removing a label is gated like a dropped column: rows that use it must
      // be rewritten or deleted first, and the rebuild cannot restore them.
      report(
        "destructive",
        enumeration.name,
        `Enum "${enumeration.name}" drops ${removed.map((value) => `'${value}'`).join(", ")}; rows using those labels make the rebuild fail.`,
        "Update or delete the rows that use the removed labels before migrating.",
      );
    } else if (
      JSON.stringify(enumeration.values) !== JSON.stringify(next.values)
    ) {
      const added = plan.up.some((statement) =>
        statement.startsWith(
          `ALTER TYPE ${quoteIdentifier(enumeration.name)} ADD VALUE `,
        ),
      );

      report(
        "caution",
        enumeration.name,
        added
          ? `Enum "${enumeration.name}" gains labels in place.`
          : `Enum "${enumeration.name}" is rebuilt to change its labels.`,
        added
          ? "A new label can be used only after the migration that adds it commits."
          : "Dependent columns are rewritten while the type is replaced; plan for the lock.",
      );
    }
  }

  return findings.sort(
    (left, right) =>
      levelOrder[left.level] - levelOrder[right.level] ||
      left.table.localeCompare(right.table),
  );
};

export const formatLintFindings = (findings: readonly LintFinding[]): string =>
  findings.length
    ? findings
        .map(
          (finding) =>
            `${finding.level.toUpperCase().padEnd(11)} ${finding.table}${finding.column ? `.${finding.column}` : ""}: ${finding.message}\n            ${finding.advice}`,
        )
        .join("\n")
    : "No risky operations found.";
