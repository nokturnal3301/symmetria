import type { MigrationDiffOptions, MigrationSnapshot } from "../index";
import type { Choose } from "./terminal";

/** Suggestions are decisions, never guessed renames; persisted SQL records the result. */
export const resolveRenames = async (
  before: MigrationSnapshot,
  after: MigrationSnapshot,
  select: Choose,
  options: MigrationDiffOptions = {},
): Promise<MigrationDiffOptions> => {
  const tables = { ...options.renames?.tables };
  const columns: Record<string, Record<string, string>> = Object.fromEntries(
    Object.entries(options.renames?.columns ?? {}).map(([name, entries]) => [
      name,
      { ...entries },
    ]),
  );

  const shape = (table: MigrationSnapshot["tables"][number]) =>
    JSON.stringify(
      table.columns.map((column) => [
        column.name,
        column.sqlType,
        column.notNull,
      ]),
    );

  for (const old of before.tables.filter(
    (table) =>
      !tables[table.name] &&
      !after.tables.some((next) => next.name === table.name),
  )) {
    const candidates = after.tables.filter(
      (next) =>
        !Object.values(tables).includes(next.name) &&
        !before.tables.some((table) => table.name === next.name) &&
        shape(old) === shape(next),
    );

    if (!candidates.length) {
      continue;
    }

    const choice = await select(
      `Table ${old.name} disappeared. How should this change be represented?`,
      [
        ...candidates.map(
          (candidate) => `Rename ${old.name} → ${candidate.name}`,
        ),
        "Drop and add tables",
      ],
    );

    if (choice === undefined) {
      throw new Error("symmetria: migration generation cancelled");
    }

    if (choice < candidates.length) {
      tables[old.name] = candidates[choice]!.name;
    }
  }

  for (const oldTable of before.tables) {
    const table = after.tables.find(
      (next) => next.name === (tables[oldTable.name] ?? oldTable.name),
    );

    if (!table) {
      continue;
    }

    const hints = columns[table.name] ?? {};

    for (const old of oldTable.columns.filter(
      (column) =>
        !hints[column.name] &&
        !table.columns.some((next) => next.name === column.name),
    )) {
      const candidates = table.columns.filter(
        (next) =>
          !Object.values(hints).includes(next.name) &&
          !oldTable.columns.some((column) => column.name === next.name) &&
          next.sqlType === old.sqlType &&
          next.notNull === old.notNull,
      );

      if (!candidates.length) {
        continue;
      }

      const choice = await select(
        `${table.name}.${old.name} disappeared. How should this change be represented?`,
        [
          ...candidates.map(
            (candidate) => `Rename ${old.name} → ${candidate.name}`,
          ),
          "Drop column and add new columns",
        ],
      );

      if (choice === undefined) {
        throw new Error("symmetria: migration generation cancelled");
      }

      if (choice < candidates.length) {
        hints[old.name] = candidates[choice]!.name;
      }
    }

    if (Object.keys(hints).length) {
      columns[table.name] = hints;
    }
  }

  return { ...options, renames: { tables, columns } };
};
