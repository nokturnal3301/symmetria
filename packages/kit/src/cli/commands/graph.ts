import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { renderMermaid, schemaGraph } from "../../graph/mermaid";
import { loadMigrationState } from "../../migrations/files";
import type { CliContext, Project } from "../context";
import { formatCreated } from "../ui/format";

/**
 * `graph [file]`: a Mermaid entity-relationship diagram of the declared schema,
 * or of the latest migration snapshot when the config declares no schema.
 * Printed to stdout, or written to a file (`.md` files get a ```mermaid fence).
 */
export const graph = async (
  context: CliContext,
  project: Project,
  name: string | undefined,
): Promise<void> => {
  const { values, color } = context;
  const declared = project.snapshot();
  const snapshot =
    declared ??
    (await loadMigrationState(project.directory).then(
      ({ migrations, snapshot }) => (migrations.length ? snapshot : undefined),
    ));

  if (!snapshot) {
    throw new Error(
      "symmetria: graph needs a schema in the config or a migration chain",
    );
  }

  const model = schemaGraph(snapshot);
  const summary = `${model.tables.length} ${model.tables.length === 1 ? "table" : "tables"}, ${model.edges.length} ${model.edges.length === 1 ? "relation" : "relations"}`;

  if (!name) {
    context.emit({
      json: model,
      indent: 2,
      plain: () =>
        renderMermaid(model, { compact: !!values.compact }).trimEnd(),
    });

    return;
  }

  const path = resolve(name);
  const diagram = renderMermaid(model, {
    fenced: extname(path).toLowerCase() === ".md",
    compact: !!values.compact,
  });
  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(path, diagram, { flag: values.force ? "w" : "wx" });
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

  context.emit({
    json: { path, tables: model.tables.length, relations: model.edges.length },
    indent: 2,
    pretty: () =>
      `${formatCreated(dirname(path), [basename(path)], color)}  ${context.style(summary, "muted")}`,
    plain: () => `Created\n  ${path}\n  ${summary}`,
  });
};
