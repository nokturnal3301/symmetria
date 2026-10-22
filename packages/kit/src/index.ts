export {
  migrationSnapshot,
  parseMigrationSnapshot,
  snapshotHash,
  emptySnapshot,
  type MigrationSnapshot,
  type MigrationTable,
  type MigrationColumn,
} from "./migrations/snapshot";
export {
  createSchemaSQL,
  diffSchemas,
  type MigrationPlan,
  type MigrationDiffOptions,
  type RenameHints,
} from "./migrations/diff";
export {
  generateMigration,
  loadMigrations,
  loadMigrationState,
  squashMigrations,
  type Migration,
  type GeneratedMigration,
  type MigrationState,
  type MigrationManifest,
  type GenerateMigrationOptions,
  type SquashMigrationsOptions,
} from "./migrations/files";
export {
  lintMigration,
  formatLintFindings,
  type LintFinding,
  type LintLevel,
} from "./migrations/lint";
export {
  detectDrift,
  formatDriftFindings,
  normalizeSqlType,
  type DriftFinding,
  type DriftKind,
  type DriftOptions,
} from "./migrations/drift";
export {
  migrator,
  type MigratorOptions,
  type MigrationStatus,
} from "./migrations/runner";
export {
  defineMigrationConfig,
  type MigrationConfig,
} from "./migrations/config";
