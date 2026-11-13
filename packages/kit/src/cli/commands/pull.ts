import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pullSchema } from "../../introspection";
import { loadProject, withDatabase, type CliContext } from "../context";
import { formatCreated, formatPullWarnings } from "../ui/format";

/**
 * `pull [file]`: introspect the configured database and write a schema module.
 * The connection comes from --database-url, the config (when it loads) or DATABASE_URL.
 */
export const pull = async (
  context: CliContext,
  name: string | undefined,
): Promise<void> => {
  const { values, color } = context;
  const path = resolve(name ?? "schema.ts");
  const explicit = values["database-url"] ?? process.env.DATABASE_URL;
  const project = await loadProject(context).catch((error: unknown) => {
    // A config that imports the schema module being generated cannot load yet.
    if (!explicit) {
      throw error;
    }

    return undefined;
  });
  const databaseUrl =
    values["database-url"] ?? project?.databaseUrl ?? explicit;
  const { metadataSchema, metadataTable } = project?.config ?? {};
  // Only the tables the config and flags name: Prisma's history table, which
  // other commands leave out on their own, stays listed for review here.
  const ignoreTables = [
    ...new Set([
      ...(project?.config.ignoreTables ?? []),
      ...(values["ignore-table"] ?? []),
    ]),
  ];
  const result = await withDatabase({ databaseUrl }, (driver) =>
    context.progress("Reading the database", () =>
      pullSchema({
        execute: driver.execute,
        ...(metadataSchema ? { metadataSchema } : {}),
        ...(metadataTable ? { metadataTable } : {}),
        ...(ignoreTables.length ? { ignoreTables } : {}),
      }),
    ),
  );

  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(path, result.source, { flag: values.force ? "w" : "wx" });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(`symmetria: ${path} exists; use --force to overwrite it`);
    }

    throw error;
  }

  const summary = `${result.tables.length} ${result.tables.length === 1 ? "table" : "tables"} from schema "${result.schemaName}"`;
  context.emit({
    json: {
      path,
      schema: result.schemaName,
      tables: result.tables,
      enumerations: result.enumerations,
      warnings: result.warnings,
    },
    indent: 2,
    pretty: () =>
      `${formatCreated(dirname(path), [basename(path)], color)}  ${context.style(summary, "muted")}\n\n${formatPullWarnings(result.warnings, color)}`,
    plain: () =>
      [
        "Created",
        `  ${path}`,
        `  ${summary}`,
        "",
        ...(result.warnings.length
          ? [
              `Review (${result.warnings.length})`,
              ...result.warnings.flatMap((warning) => [
                `  [${warning.code}] ${warning.message}`,
                ...(warning.fix ? [`    fix: ${warning.fix}`] : []),
              ]),
            ]
          : ["Nothing needs review; the schema matches the database."]),
      ].join("\n"),
  });
};
