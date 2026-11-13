/**
 * Schema-level lint: reviews a migration plan for operations that lose data,
 * fail on populated tables or need deploy planning.
 */
import { quoteIdentifier } from "symmetria/internal";
import type { MigrationPlan, RenameHints } from "./diff";
import { conversionMessage, typeConversion } from "./conversions";
import { renameExpressionIdentifiers } from "./expression-tokens";
import type { MigrationColumn, MigrationTable } from "./snapshot";

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
  const renamedTables = renames.tables ?? {};
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

  const compareColumns = (
    before: MigrationTable,
    after: MigrationTable,
  ): void => {
    const renamedColumns = renames.columns?.[after.name] ?? {};
    const afterColumns = new Map(
      after.columns.map((column) => [column.name, column]),
    );
    const beforeColumns = new Map(
      before.columns.map((column) => [column.name, column]),
    );

    for (const column of before.columns) {
      const renamedTo = renamedColumns[column.name];
      const next = afterColumns.get(renamedTo ?? column.name);

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

      // Renames are catalog-only changes, and SQL lint passes the generated
      // RENAME statements; reporting them here would fail --strict only until
      // the migration is generated.
      compareColumn(after, column, next);

      // A new foreign key validates every existing value; a changed action on
      // the same target column cannot fail, as the old key held.
      const target = column.references && {
        table:
          renamedTables[column.references.table] ?? column.references.table,
        column: column.references.column,
      };
      const targetColumn =
        target &&
        (renames.columns?.[target.table]?.[target.column] ?? target.column);

      if (
        next.references &&
        (target?.table !== next.references.table ||
          targetColumn !== next.references.column)
      ) {
        report(
          "blocking",
          after.name,
          `Column "${next.name}" gains a foreign key to ${next.references.table}.${next.references.column}; the statement fails when an existing value has no match.`,
          "Fix or clear unmatched values first, or generate with --online, which adds the key NOT VALID and validates it separately.",
          next.name,
        );
      }
    }

    // CHECK constraints validate every existing row, like NOT NULL.
    const columnNames = new Map(
      Object.entries(renamedColumns).map(([previous, next]) => [
        quoteIdentifier(previous),
        quoteIdentifier(next),
      ]),
    );
    const previousChecks = (before.checks ?? []).map((check) =>
      renameExpressionIdentifiers(check.expression, columnNames),
    );

    for (const definition of after.checks ?? []) {
      if (!previousChecks.includes(definition.expression)) {
        report(
          "blocking",
          after.name,
          `CHECK constraint "${definition.sqlName}" is added; the statement fails when an existing row violates it.`,
          "Fix violating rows first, or generate with --online, which adds the check NOT VALID and validates it separately.",
        );
      }
    }

    for (const column of after.columns) {
      if (
        beforeColumns.has(column.name) ||
        Object.values(renamedColumns).includes(column.name)
      ) {
        continue;
      }

      if (column.notNull && column.default === undefined && !column.identity) {
        report(
          "blocking",
          after.name,
          `Column "${column.name}" is added as NOT NULL without a default; the statement fails when the table has rows.`,
          "Add a default, or add the column as nullable, backfill it and set NOT NULL in a later migration.",
          column.name,
        );
      }

      if (column.unique) {
        report(
          "caution",
          after.name,
          `Column "${column.name}" is added with a UNIQUE constraint.`,
          "Existing rows all receive the same default; make sure the default is unique or add the constraint after backfilling.",
          column.name,
        );
      }
    }

    for (const definition of after.indexes) {
      if (
        before.indexes.some(
          (existing) =>
            existing.sqlName === definition.sqlName &&
            JSON.stringify(existing) === JSON.stringify(definition),
        )
      ) {
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

    if (
      JSON.stringify(before.primaryKey) !== JSON.stringify(after.primaryKey)
    ) {
      report(
        "caution",
        after.name,
        `Primary key changes from (${before.primaryKey.join(", ")}) to (${after.primaryKey.join(", ")}).`,
        "The table is rewritten and foreign keys are rebuilt; plan the deploy for low traffic.",
      );
    }
  };

  const compareColumn = (
    table: MigrationTable,
    before: MigrationColumn,
    after: MigrationColumn,
  ): void => {
    const retyped =
      before.sqlType !== after.sqlType ||
      (before.enumeration !== after.enumeration &&
        !renamedEnumeration(before.enumeration, after.enumeration));
    const change = retyped ? typeConversion(before, after) : undefined;

    if (change?.lossy) {
      report(
        "destructive",
        table.name,
        conversionMessage(before, after, change),
        change.assignmentCast
          ? "Shorten or move longer values first, then generate with --allow-destructive; the SQL has no truncating cast, so PostgreSQL refuses values that still do not fit."
          : "Copy the column or back up the table if the lost precision matters, then generate with --allow-destructive.",
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
    }
  };

  for (const table of plan.before.tables) {
    const renamedTo = renamedTables[table.name];
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
      report(
        "caution",
        enumeration.name,
        `Enum "${enumeration.name}" is rebuilt to change its labels.`,
        "Dependent columns are rewritten while the type is replaced; plan for the lock.",
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
