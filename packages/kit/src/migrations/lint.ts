import type { MigrationPlan, RenameHints } from "./diff";
import type { MigrationColumn, MigrationTable } from "./snapshot";

/**
 * destructive: data is lost; blocking: the statement fails on existing data;
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
  const beforeTables = new Map(
    plan.before.tables.map((table) => [table.name, table]),
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

      if (renamedTo) {
        report(
          "caution",
          after.name,
          `Column "${column.name}" is renamed to "${renamedTo}".`,
          "Deploy code that tolerates both names, or add the new column and backfill it before removing the old one.",
          renamedTo,
        );
      }

      compareColumn(after, column, next);
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
    if (
      before.sqlType !== after.sqlType ||
      before.enumeration !== after.enumeration
    ) {
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

    if (renamedTo) {
      report(
        "caution",
        next.name,
        `Table "${table.name}" is renamed to "${renamedTo}".`,
        "Deploy code that tolerates both names, or create a view with the old name until every deployment is updated.",
      );
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
      report(
        "blocking",
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

  void beforeTables;

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
