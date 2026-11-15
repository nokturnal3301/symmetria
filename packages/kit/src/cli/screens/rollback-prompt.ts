/**
 * Confirmation before a rollback: shows what down.sql removes and asks before
 * anything runs. Dropping or emptying whole tables needs the database name
 * typed out.
 */
import { parseMigrationSQL } from "../../migrations/sql";
import { lintMigrationSQL } from "../../migrations/sql-lint";
import type { Choose } from "../ui/terminal";

export type RollbackSummary = {
  readonly migrations: readonly string[];
  readonly statements: number;
  readonly destructive: readonly string[];
  readonly droppedTables: number;
  readonly emptiedTables: number;
};

/** The statement's leading keywords, read past comments. */
const opening = (sql: string): string =>
  (parseMigrationSQL(`${sql};`)[0]?.words ?? []).slice(0, 2).join(" ");

const EMPTIES_TABLES = /^(?:TRUNCATE\b|DROP (?:SCHEMA|OWNED)$)/;

const oneLine = (sql: string): string => {
  const text = sql.replace(/\s+/g, " ").trim();

  return text.length > 96 ? `${text.slice(0, 95)}…` : text;
};

export const rollbackSummary = (
  steps: readonly {
    readonly id: string;
    readonly statements: readonly string[];
  }[],
): RollbackSummary => {
  const destructive = steps.flatMap((step) =>
    lintMigrationSQL(
      step.statements.map((sql) => `${sql};`).join("\n"),
      step.id,
    )
      .filter((finding) => finding.level === "destructive")
      .map((finding) => step.statements[finding.statement - 1]!),
  );
  const unique = [...new Set(destructive)];

  return {
    migrations: steps.map((step) => step.id),
    statements: steps.reduce((sum, step) => sum + step.statements.length, 0),
    destructive: unique.map(oneLine),
    droppedTables: unique.filter((sql) => opening(sql) === "DROP TABLE").length,
    emptiedTables: unique.filter((sql) => EMPTIES_TABLES.test(opening(sql)))
      .length,
  };
};

/** The database a URL points at, for the question and the typed confirmation. */
export const databaseName = (url: string | undefined): string => {
  try {
    return (
      decodeURIComponent(new URL(url ?? "").pathname.slice(1)) || "postgres"
    );
  } catch {
    return "database";
  }
};

export const rollbackPreview = (
  summary: RollbackSummary,
  database: string,
): string =>
  [
    "",
    `  Rollback on "${database}": ${summary.migrations.join(", ")}`,
    `  ${summary.statements} SQL statement${summary.statements === 1 ? "" : "s"} from down.sql`,
    ...(summary.destructive.length
      ? [
          "",
          `  Removes data or database objects (${summary.destructive.length}):`,
          ...summary.destructive.slice(0, 12).map((sql) => `    ${sql}`),
          ...(summary.destructive.length > 12
            ? [`    … and ${summary.destructive.length - 12} more (see --plan)`]
            : []),
        ]
      : []),
    "",
  ].join("\n");

/** True only after an explicit yes; closing the question or a wrong name cancels. */
export const confirmRollback = async (
  summary: RollbackSummary,
  database: string,
  prompts: {
    readonly write: (text: string) => void;
    readonly select: Choose;
    readonly ask: (question: string) => Promise<string>;
  },
): Promise<boolean> => {
  prompts.write(`${rollbackPreview(summary, database)}\n`);

  if (summary.droppedTables || summary.emptiedTables) {
    const answer = await prompts.ask(
      `${
        summary.emptiedTables
          ? "This drops or empties whole tables"
          : `This drops ${summary.droppedTables} table${summary.droppedTables === 1 ? "" : "s"}`
      }. Type the database name "${database}" to continue:`,
    );

    return answer === database;
  }

  const count = summary.migrations.length;

  return (
    (await prompts.select(
      `Roll back ${count} migration${count === 1 ? "" : "s"} on "${database}"?`,
      ["Cancel", "Roll back"],
    )) === 1
  );
};
