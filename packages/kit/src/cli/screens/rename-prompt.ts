import type { MigrationDiffOptions, MigrationSnapshot } from "../../index";
import { renameMaps } from "../../migrations/diff";
import type { Choose } from "../ui/terminal";

/** Suggestions are decisions, never guessed renames; persisted SQL records the result. */
export const resolveRenames = async (
  before: MigrationSnapshot,
  after: MigrationSnapshot,
  select: Choose,
  options: MigrationDiffOptions = {},
): Promise<MigrationDiffOptions> => {
  // Maps: a table or column may be called `constructor` or `__proto__`.
  const given = renameMaps(options.renames);
  const tables = new Map(given.tables);
  const columns = new Map(
    [...given.columns].map(([name, entries]) => [name, new Map(entries)]),
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
      !tables.has(table.name) &&
      !after.tables.some((next) => next.name === table.name),
  )) {
    const candidates = after.tables.filter(
      (next) =>
        ![...tables.values()].includes(next.name) &&
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
      tables.set(old.name, candidates[choice]!.name);
    }
  }

  for (const oldTable of before.tables) {
    const table = after.tables.find(
      (next) => next.name === (tables.get(oldTable.name) ?? oldTable.name),
    );

    if (!table) {
      continue;
    }

    const hints = columns.get(table.name) ?? new Map<string, string>();

    for (const old of oldTable.columns.filter(
      (column) =>
        !hints.has(column.name) &&
        !table.columns.some((next) => next.name === column.name),
    )) {
      const candidates = table.columns.filter(
        (next) =>
          ![...hints.values()].includes(next.name) &&
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
        hints.set(old.name, candidates[choice]!.name);
      }
    }

    if (hints.size) {
      columns.set(table.name, hints);
    }
  }

  // Object.fromEntries defines own properties, `__proto__` included.
  return {
    ...options,
    renames: {
      tables: Object.fromEntries(tables),
      columns: Object.fromEntries(
        [...columns].map(([name, entries]) => [
          name,
          Object.fromEntries(entries),
        ]),
      ),
    },
  };
};
