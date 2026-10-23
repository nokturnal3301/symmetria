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
  readonly verificationDatabaseUrl?: string;
  readonly verify?: Pick<
    VerifyOptions,
    "schemaName" | "beforeMigration" | "afterMigration"
  >;
};

export const defineMigrationConfig = (
  config: MigrationConfig,
): MigrationConfig => config;
