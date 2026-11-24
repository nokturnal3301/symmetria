/**
 * Schema-only CLI commands that need no database: inspect, lint, diff and generate.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SchemaSnapshot } from "symmetria";
import {
  diffSchemas,
  formatLintFindings,
  generateMigration,
  lintMigration,
  lintMigrationSQL,
  loadMigrationState,
  migrationSnapshot,
  migrator,
  type MigrationDiffOptions,
} from "../../index";
import { commentText } from "../../migrations/snapshot";
import { formatCreated, formatDiff, formatSchema } from "../ui/format";
import { inspectSchema } from "../screens/schema-browser";
import { resolveRenames } from "../screens/rename-prompt";
import { interruption } from "../signals";
import { ask, withScreen } from "../ui/terminal";
import { databaseDriver, type CliContext, type Project } from "../context";

/** The declared schema, required unless the command can run without one. */
const declaredSchema = (
  project: Project,
  required: boolean,
): SchemaSnapshot | undefined => {
  const snapshot = project.snapshot();

  if (required && !snapshot) {
    throw new Error(
      "symmetria: configure schema in symmetria.config.ts before inspecting or generating a migration",
    );
  }

  return snapshot;
};

const readDiffOptions = async (
  context: CliContext,
): Promise<MigrationDiffOptions> => {
  const { values } = context;
  const options: MigrationDiffOptions = values.diff
    ? JSON.parse(await readFile(resolve(values.diff), "utf8"))
    : {};

  return values.online ? { ...options, online: true } : options;
};

/** `inspect [table]`: the schema browser, or a listing of tables, columns and relations. */
export const inspect = async (
  context: CliContext,
  project: Project,
  name: string | undefined,
): Promise<void> => {
  const { values, color } = context;
  const snapshot = declaredSchema(project, true)!;
  const tables = name
    ? snapshot.tables.filter(
        (table) => table.name === name || table.sqlName === name,
      )
    : snapshot.tables;

  if (name && !tables.length) {
    throw new Error(`symmetria: unknown table "${name}"`);
  }

  if (context.interactive) {
    return withScreen(() =>
      inspectSchema(snapshot, {
        color,
        ...(name ? { table: name } : {}),
        tab: values.relations ? "Relations" : "Columns",
      }),
    );
  }

  context.emit({
    json: {
      tables: values.relations
        ? tables.map((table) => ({
            name: table.name,
            relations: table.relations,
          }))
        : tables,
    },
    replacer: (_name, value) =>
      typeof value === "bigint" ? value.toString() : value,
    indent: 2,
    pretty: () => formatSchema(snapshot, name, values.relations, color),
    plain: () => formatSchema(snapshot, name, values.relations, false),
  });
};

/** `lint`: review saved up.sql files and the ungenerated schema diff. */
export const lint = async (
  context: CliContext,
  project: Project,
): Promise<void> => {
  const { values } = context;
  const diffOptions = await readDiffOptions(context);
  const snapshot = declaredSchema(project, false);
  const { snapshot: before, migrations } = await loadMigrationState(
    project.directory,
  );
  const after = snapshot ? migrationSnapshot(snapshot) : before;
  const plan = diffSchemas(before, after, diffOptions);
  let selected = migrations;

  if (values.pending) {
    if (!project.databaseUrl) {
      throw new Error(
        "symmetria: --pending needs a database: set databaseUrl in the config, DATABASE_URL or --database-url",
      );
    }

    const driver = databaseDriver(project);

    try {
      const statuses = await migrator({
        driver,
        ...project.runnerOptions,
      }).status();

      const incomplete = statuses.filter(
        (entry) => entry.status === "incomplete",
      );
      // One that another process is running needs no repair: it is not
      // finished yet.
      const running = incomplete.find((entry) => entry.running);

      if (running) {
        throw new Error(
          `symmetria: migration "${commentText(running.id)}" is running in another process (it holds the migration lock); lint the pending chain when it finishes`,
        );
      }

      if (incomplete.length) {
        throw new Error(
          "symmetria: repair incomplete migrations before linting the pending chain",
        );
      }

      selected = migrations.filter((migration) =>
        statuses.some(
          (status) => status.id === migration.id && status.status === "pending",
        ),
      );
    } finally {
      await driver.close();
    }
  }

  const findings = [
    ...selected.flatMap((migration) =>
      lintMigrationSQL(migration.up, migration.id),
    ),
    ...lintMigration(plan, diffOptions.renames),
  ];
  context.emit({
    json: { findings },
    indent: 2,
    plain: () => formatLintFindings(findings),
  });

  if (
    findings.some((finding) => values.strict || finding.level !== "caution")
  ) {
    process.exitCode = 1;
  }
};

/** `diff`: compare the declared schema with the latest local snapshot. */
export const diff = async (
  context: CliContext,
  project: Project,
): Promise<void> => {
  const { values, color, output } = context;
  const diffOptions = await readDiffOptions(context);
  const snapshot = declaredSchema(project, true)!;
  const { snapshot: before } = await loadMigrationState(project.directory);
  const plan = diffSchemas(before, migrationSnapshot(snapshot), diffOptions);

  if (values.sql) {
    output(plan.up.map((statement) => `${statement};`).join("\n\n"));

    return;
  }

  context.emit({
    json: plan,
    indent: 2,
    // Coloured on a terminal, plain text elsewhere (and with NO_COLOR).
    pretty: () => formatDiff(plan, color, diffOptions.renames),
    plain: () => formatDiff(plan, false, diffOptions.renames),
  });
};

/** `generate [name]`: write up.sql, down.sql and the versioned snapshot. */
export const generate = async (
  context: CliContext,
  project: Project,
  requestedName: string | undefined,
): Promise<void> => {
  const { values, color, pretty, interactive, output } = context;
  let diffOptions = await readDiffOptions(context);
  const snapshot = declaredSchema(project, !values.empty);
  const { snapshot: before } = await loadMigrationState(project.directory);
  const after =
    snapshot && !values.empty ? migrationSnapshot(snapshot) : before;

  if (interactive && !values.empty) {
    diffOptions = await resolveRenames(
      before,
      after,
      context.select,
      diffOptions,
    );
  }

  const plan = diffSchemas(before, after, diffOptions);
  const name = requestedName ?? (await ask("Migration name:", color));

  if (!name) {
    throw new Error(
      interruption()
        ? "symmetria: interrupted"
        : "symmetria: generate requires a migration name",
    );
  }

  if (pretty && !values.json && !values.empty) {
    output(formatDiff(plan, color, diffOptions.renames));
  }

  const migration = await context.progress("Writing migration", () =>
    generateMigration({
      ...diffOptions,
      directory: project.directory,
      name,
      ...(snapshot ? { snapshot } : {}),
      ...(values.empty ? { empty: true } : {}),
      ...(values["allow-destructive"] ? { allowDestructive: true } : {}),
      ...(values.transaction
        ? { transaction: values.transaction as "batch" | "each" | "none" }
        : {}),
      ...(values.online ? { online: true } : {}),
    }),
  );
  const directory = project.directory;
  // What the migration does to existing data and to the running application:
  // the same review as lint, shown where the migration is made.
  const findings = migration ? lintMigration(plan, diffOptions.renames) : [];
  const review = findings.length
    ? `\n\nReview before applying:\n${formatLintFindings(findings)}`
    : "";
  context.emit({
    json: migration
      ? {
          id: migration.id,
          directory: resolve(directory, migration.id),
          metadataDirectory: resolve(directory, "meta"),
          up: migration.up,
          down: migration.down,
          findings,
        }
      : { id: null, changed: false },
    pretty: () =>
      migration
        ? `${formatCreated(
            directory,
            [
              `${migration.id}/up.sql`,
              `${migration.id}/down.sql`,
              "meta/snapshot.json",
              "meta/migration.json",
            ],
            color,
          )}${review}`
        : "No schema changes.",
    plain: () =>
      migration ? `Generated ${migration.id}${review}` : "No schema changes.",
  });
};
