import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "symmetria";
import { postgres, type Driver } from "symmetria/driver";
import { quoteIdentifier } from "symmetria/internal";
import { readCatalog } from "./catalog";
import { canonicalJSON } from "./snapshot";
import { detectDrift, formatDriftFindings } from "./drift";
import { executeSQL, type ExecutionOptions } from "./execution";
import { loadMigrationState, type MigrationState } from "./files";
import { migrator } from "./runner";

export type VerificationContext = {
  driver: Driver;
  migration: string;
  phase: "up" | "down" | "reapply";
};
export type VerifyOptions = ExecutionOptions & {
  directory: string;
  /** A connection with CREATEDB permission. Only newly created databases receive migration SQL. */
  url: string;
  schemaName?: string;
  metadataSchema?: string;
  metadataTable?: string;
  beforeMigration?: (context: VerificationContext) => Promise<void>;
  afterMigration?: (context: VerificationContext) => Promise<void>;
};

const disposableDatabase = async <Result>(
  url: string,
  schemaName: string,
  callback: (driver: Driver) => Promise<Result>,
): Promise<Result> => {
  const admin = postgres({ url, max: 1 });
  const name = `symmetria_verify_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let driver: Driver | undefined;

  try {
    await executeSQL(
      admin.execute,
      `CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE template0`,
    );
    created = true;
    const address = new URL(url);
    address.pathname = `/${name}`;
    address.searchParams.delete("options");
    driver = postgres({ url: address.toString(), max: 1 });

    if (schemaName !== "public") {
      await executeSQL(
        driver.execute,
        `CREATE SCHEMA ${quoteIdentifier(schemaName)}`,
      );
    }

    await executeSQL(
      driver.execute,
      "SELECT set_config('search_path', $1, false)",
      [quoteIdentifier(schemaName)],
    );

    return await callback(driver);
  } finally {
    try {
      await driver?.close();
    } finally {
      try {
        if (created) {
          await executeSQL(
            admin.execute,
            `DROP DATABASE ${quoteIdentifier(name)} WITH (FORCE)`,
          );
        }
      } finally {
        await admin.close();
      }
    }
  }
};

/** Catalog rows present on one side only, so a refused repair or adoption says what to reconcile. */
const catalogDifferences = (
  expected: Record<string, readonly unknown[]>,
  actual: Record<string, readonly unknown[]>,
): string[] =>
  Object.keys({ ...expected, ...actual })
    .sort()
    .flatMap((section) => {
      const wanted = new Set((expected[section] ?? []).map(canonicalJSON));
      const found = new Set((actual[section] ?? []).map(canonicalJSON));

      return [
        ...[...found]
          .filter((row) => !wanted.has(row))
          .map((row) => {
            const index = JSON.parse(row) as { name?: string; valid?: boolean };

            return section === "indexes" && index.valid === false
              ? `  unexpected invalid index ${index.name} (left by a failed CONCURRENTLY build; DROP INDEX CONCURRENTLY it before retrying): ${row}`
              : `  unexpected ${section}: ${row}`;
          }),
        ...[...wanted]
          .filter((row) => !found.has(row))
          .map((row) => `  missing ${section}: ${row}`),
      ];
    });

const catalogMatches = (expected: unknown, actual: unknown, label: string) => {
  if (canonicalJSON(expected) !== canonicalJSON(actual)) {
    const differences = catalogDifferences(
      expected as Record<string, readonly unknown[]>,
      actual as Record<string, readonly unknown[]>,
    );
    const shown = differences.slice(0, 20);

    throw new Error(
      [
        `symmetria: ${label}: database catalog does not match the verified migration boundary`,
        ...shown,
        ...(differences.length > shown.length
          ? [`  … ${differences.length - shown.length} more`]
          : []),
      ].join("\n"),
    );
  }
};

/** Reconstruct an older boundary by replaying SQL; no historical snapshots are persisted. */
export const verifyBoundary = async (
  options: ExecutionOptions & {
    execute: QueryExecutor;
    state: MigrationState;
    target: number;
    url: string;
    directory: string;
    metadataSchema?: string;
    metadataTable?: string;
  },
): Promise<void> => {
  const schemaName = String(
    (await executeSQL(options.execute, "SELECT current_schema() AS name"))
      .rows[0]!.name,
  );
  const actual = await readCatalog({ ...options, schemaName });
  await disposableDatabase(options.url, schemaName, async (driver) => {
    if (options.target >= 0) {
      await migrator({ ...options, driver }).migrate({
        to: options.state.migrations[options.target]!.id,
      });
    }

    const expected = await readCatalog({
      ...options,
      execute: driver.execute,
      schemaName,
    });
    catalogMatches(
      expected,
      actual,
      "schema does not match the adoption/recovery target",
    );
  });
};

/** Exercise fresh installation, populated upgrades, rollback and reapplication on real PostgreSQL. */
export const verifyMigrations = async (
  options: VerifyOptions,
): Promise<{ migrations: string[]; verified: true }> => {
  const state = await loadMigrationState(options.directory);
  const schemaName = options.schemaName ?? "public";

  const assertLatest = async (driver: Driver) => {
    const findings = await detectDrift({
      ...options,
      execute: driver.execute,
      snapshot: state.snapshot,
      schemaName,
    });

    if (findings.length) {
      throw new Error(
        `symmetria: verified SQL differs from the latest snapshot\n${formatDriftFindings(findings)}`,
      );
    }
  };

  await disposableDatabase(options.url, schemaName, async (driver) => {
    await migrator({ ...options, driver }).migrate();
    await assertLatest(driver);
  });
  await disposableDatabase(options.url, schemaName, async (driver) => {
    const runner = migrator({ ...options, driver });

    const catalog = () =>
      readCatalog({ ...options, execute: driver.execute, schemaName });

    for (const migration of state.migrations) {
      const before = await catalog();
      const up: VerificationContext = {
        driver,
        migration: migration.id,
        phase: "up",
      };
      await options.beforeMigration?.(up);
      await runner.migrate({ to: migration.id });
      const after = await catalog();
      await options.afterMigration?.(up);
      const down: VerificationContext = { ...up, phase: "down" };
      await options.beforeMigration?.(down);
      await runner.rollback();
      catalogMatches(before, await catalog(), `rollback of ${migration.id}`);
      await options.afterMigration?.(down);
      const reapply: VerificationContext = { ...up, phase: "reapply" };
      await options.beforeMigration?.(reapply);
      await runner.migrate({ to: migration.id });
      catalogMatches(
        after,
        await catalog(),
        `reapplication of ${migration.id}`,
      );
      await options.afterMigration?.(reapply);
    }

    await assertLatest(driver);
  });

  return {
    migrations: state.migrations.map((migration) => migration.id),
    verified: true,
  };
};
