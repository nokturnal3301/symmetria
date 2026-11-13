/**
 * Schema-only CLI commands that need no database: inspect, lint, diff and generate.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { postgres } from "symmetria/driver";
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
import { formatCreated, formatDiff, formatSchema } from "../ui/format";
import { inspectSchema } from "../screens/schema-browser";
import { resolveRenames } from "../screens/rename-prompt";
import { ask, withScreen } from "../ui/terminal";
import type { CliContext, Project } from "../context";

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
    plain: () => formatSchema(snapshot, name, values.relations, color),
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

    const driver = postgres(project.databaseUrl);

    try {
      const statuses = await migrator({
        driver,
        ...project.runnerOptions,
      }).status();

      if (statuses.some((entry) => entry.status === "incomplete")) {
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
    plain: () => formatDiff(plan, color, diffOptions.renames),
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
    throw new Error("symmetria: generate requires a migration name");
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
  context.emit({
    json: migration
      ? {
          id: migration.id,
          directory: resolve(directory, migration.id),
          metadataDirectory: resolve(directory, "meta"),
          up: migration.up,
          down: migration.down,
        }
      : { id: null, changed: false },
    pretty: () =>
      migration
        ? formatCreated(
            directory,
            [
              `${migration.id}/up.sql`,
              `${migration.id}/down.sql`,
              "meta/snapshot.json",
              "meta/migration.json",
            ],
            color,
          )
        : "No schema changes.",
    plain: () =>
      migration ? `Generated ${migration.id}` : "No schema changes.",
  });
};
