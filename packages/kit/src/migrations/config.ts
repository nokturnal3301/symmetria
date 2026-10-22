import type { SchemaSnapshot } from "symmetria";

export type MigrationConfig = {
  readonly schema?: { $snapshot: () => SchemaSnapshot } | SchemaSnapshot;
  readonly directory?: string;
  readonly databaseUrl?: string | undefined;
  readonly metadataSchema?: string;
  readonly metadataTable?: string;
};

export const defineMigrationConfig = (
  config: MigrationConfig,
): MigrationConfig => config;
