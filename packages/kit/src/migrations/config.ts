import type { SchemaSnapshot } from "symmetria";
import type { ExecutionOptions } from "./execution";
import type { VerifyOptions } from "./verify";

export type MigrationConfig = ExecutionOptions & {
  readonly schema?: { $snapshot: () => SchemaSnapshot } | SchemaSnapshot;
  readonly directory?: string;
  readonly databaseUrl?: string | undefined;
  /** Migration journal schema (default public); does not change the application search_path. */
  readonly metadataSchema?: string;
  readonly metadataTable?: string;
  /**
   * Undeclared tables that pull, drift, adopt, repair and verify leave out:
   * another tool's tables, PostGIS `spatial_ref_sys`. A table the schema
   * declares is still compared. The CLI adds `_prisma_migrations` everywhere
   * but in pull, which reports it.
   */
  readonly ignoreTables?: readonly string[];
  readonly verificationDatabaseUrl?: string;
  readonly verify?: Pick<
    VerifyOptions,
    "schemaName" | "beforeMigration" | "afterMigration"
  >;
};

export const defineMigrationConfig = (
  config: MigrationConfig,
): MigrationConfig => config;
