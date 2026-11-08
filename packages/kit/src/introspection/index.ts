/**
 * `pullSchema()`: introspect an existing PostgreSQL schema and render it as a
 * Symmetria schema module, reporting everything that needed an approximation.
 */
import type { QueryExecutor } from "symmetria";
import { readPullCatalog } from "./catalog";
import { buildPulledSchema, type PullWarning } from "./model";
import { renderSchema, type RenderOptions } from "./render";

export type PullOptions = RenderOptions & {
  readonly execute: QueryExecutor;
  /** Schema to introspect; defaults to the connection's current_schema(). */
  readonly schemaName?: string;
  /** Location of the migration journal, which is never part of the declared schema. */
  readonly metadataSchema?: string;
  readonly metadataTable?: string;
};

export type PullResult = {
  /** The generated schema module. */
  readonly source: string;
  readonly schemaName: string;
  /** SQL names of the declared tables. */
  readonly tables: string[];
  /** Enum types declared with oneOf(). */
  readonly enumerations: string[];
  /** Extensions declared through the schema options. */
  readonly extensions: string[];
  readonly warnings: PullWarning[];
};

export const pullSchema = async (options: PullOptions): Promise<PullResult> => {
  const catalog = await readPullCatalog(options);
  const model = buildPulledSchema(catalog);
  const declaredEnums = new Set(
    model.tables.flatMap((table) =>
      table.members.flatMap((member) =>
        member.kind === "column" && member.type.kind === "enum"
          ? [`${table.sqlName}_${member.sqlName}_enum`]
          : [],
      ),
    ),
  );

  return {
    source: renderSchema(model, options),
    schemaName: model.schemaName,
    tables: model.tables.map((table) => table.sqlName),
    enumerations: catalog.enumerations
      .map((entry) => entry.name)
      .filter((name) => declaredEnums.has(name)),
    extensions: model.extensions,
    warnings: model.warnings,
  };
};

export type { PullWarning, PullWarningCode } from "./model";
