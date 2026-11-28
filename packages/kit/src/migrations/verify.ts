/**
 * Replays migrations against a scratch database and compares the resulting catalog with the expected snapshot.
 */
import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "symmetria";
import { postgres, type Driver } from "symmetria/driver";
import { quoteIdentifier } from "symmetria/internal";
import { readCatalog } from "./catalog";
import { canonicalJSON } from "./snapshot";
import { detectDrift, formatDriftFindings, undeclaredTables } from "./drift";
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
  /**
   * Undeclared tables (other tools, extensions such as PostGIS) left out of
   * catalog comparisons; tables the latest snapshot declares are compared.
   */
  ignoreTables?: readonly string[];
  /**
   * Milliseconds the server of `url` may take to accept a connection; without
   * it a server that does not answer is waited for as long as the operating
   * system keeps trying.
   */
  connectionTimeoutMs?: number;
  /**
   * Called each time a connection to the server of `url` opens. Until the
   * first call nothing has reached that server.
   */
  onConnect?: () => void;
  beforeMigration?: (context: VerificationContext) => Promise<void>;
  afterMigration?: (context: VerificationContext) => Promise<void>;
};

/** node-postgres's message when a connection was not accepted in time. */
const CONNECT_TIMEOUT = "Connection terminated due to connection timeout";

/**
 * The server a connection URL points at, as `host:port` or as its socket
 * directory, for messages: never the credentials, the database or the
 * options. Undefined when the text names no host (node-postgres then takes
 * PGHOST or localhost).
 */
export const serverAddress = (url: string): string | undefined => {
  if (url.startsWith("/")) {
    return `the socket directory ${url.split(" ")[0]}`;
  }

  const parsed = /^postgres(?:ql)?:\/\//i.test(url) ? URL.parse(url) : null;
  // `?host=` (a socket directory, as Cloud SQL uses) overrides the URL's host.
  const host = parsed?.searchParams.get("host") || parsed?.hostname;

  return host
    ? host.startsWith("/")
      ? `the socket directory ${host}`
      : `${host}:${parsed?.searchParams.get("port") || parsed?.port || "5432"}`
    : undefined;
};

const disposableDatabase = async <Result>(
  url: string,
  schemaName: string,
  callback: (driver: Driver) => Promise<Result>,
  {
    connectionTimeoutMs,
    onConnect,
  }: Pick<VerifyOptions, "connectionTimeoutMs" | "onConnect"> = {},
): Promise<Result> => {
  const connecting = {
    ...(connectionTimeoutMs
      ? { connectionTimeoutMillis: connectionTimeoutMs }
      : {}),
    ...(onConnect ? { onConnect } : {}),
  };
  const admin = postgres({ url, max: 1, ...connecting });
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
    // Migrations run in sessions, whose connections are closed afterwards, so
    // every connection takes the search_path from its startup options. The
    // second connection answers the migrator's transaction-pooling check.
    // Start-up settings the URL already carries stay; the search_path,
    // written last, is the one in force.
    const given = address.searchParams.getAll("options").at(-1);
    address.searchParams.set(
      "options",
      `${given ? `${given} ` : ""}-c search_path=${quoteIdentifier(schemaName).replace(/[\\\s]/g, "\\$&")}`,
    );
    driver = postgres({ url: address.toString(), max: 2, ...connecting });

    if (schemaName !== "public") {
      await executeSQL(
        driver.execute,
        `CREATE SCHEMA ${quoteIdentifier(schemaName)}`,
      );
    }

    return await callback(driver);
  } catch (error) {
    // The driver's own error names neither the server nor the limit.
    throw connectionTimeoutMs &&
      error instanceof Error &&
      error.message === CONNECT_TIMEOUT
      ? Object.assign(
          new Error(
            `symmetria: no connection to the verification server: ${serverAddress(url) ?? "it"} did not answer within ${connectionTimeoutMs}ms`,
          ),
          { code: "ETIMEDOUT" },
        )
      : error;
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

type BoundaryOptions = ExecutionOptions & {
  execute: QueryExecutor;
  state: MigrationState;
  target: number;
  url: string;
  directory: string;
  metadataSchema?: string;
  metadataTable?: string;
  ignoreTables?: readonly string[];
  connectionTimeoutMs?: number;
};

/** Reconstruct an older boundary by replaying SQL; no historical snapshots are persisted. */
const readBoundary = async (
  options: BoundaryOptions,
): Promise<{ expected: unknown; actual: unknown }> => {
  const schemaName = String(
    (await executeSQL(options.execute, "SELECT current_schema() AS name"))
      .rows[0]!.name,
  );
  const ignoreTables = undeclaredTables(
    options.ignoreTables,
    options.state.snapshot,
  );
  const actual = await readCatalog({ ...options, schemaName, ignoreTables });
  const expected = await disposableDatabase(
    options.url,
    schemaName,
    async (driver) => {
      if (options.target >= 0) {
        await migrator({ ...options, driver }).migrate({
          to: options.state.migrations[options.target]!.id,
        });
      }

      return readCatalog({
        ...options,
        execute: driver.execute,
        schemaName,
        ignoreTables,
      });
    },
    options,
  );

  return { expected, actual };
};

/** Refuses a database whose catalog is not what the chain up to `target` builds. */
export const verifyBoundary = async (
  options: BoundaryOptions,
): Promise<void> => {
  const { expected, actual } = await readBoundary(options);
  catalogMatches(
    expected,
    actual,
    "schema does not match the adoption/recovery target",
  );
};

/**
 * What the database has more or less than the chain up to `target` builds, one
 * line each; empty when they match. For `drift` on a database that is
 * intentionally behind the latest snapshot.
 */
export const boundaryDifferences = async (
  options: BoundaryOptions,
): Promise<string[]> => {
  const { expected, actual } = await readBoundary(options);

  return canonicalJSON(expected) === canonicalJSON(actual)
    ? []
    : catalogDifferences(
        expected as Record<string, readonly unknown[]>,
        actual as Record<string, readonly unknown[]>,
      ).map((line) => line.trim());
};

/** Exercise fresh installation, populated upgrades, rollback and reapplication on real PostgreSQL. */
export const verifyMigrations = async (
  options: VerifyOptions,
): Promise<{ migrations: string[]; verified: true }> => {
  const state = await loadMigrationState(options.directory);
  const schemaName = options.schemaName ?? "public";
  const ignoreTables = undeclaredTables(options.ignoreTables, state.snapshot);

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

  await disposableDatabase(
    options.url,
    schemaName,
    async (driver) => {
      await migrator({ ...options, driver }).migrate();
      await assertLatest(driver);
    },
    options,
  );
  await disposableDatabase(
    options.url,
    schemaName,
    async (driver) => {
      const runner = migrator({ ...options, driver });

      const catalog = () =>
        readCatalog({
          ...options,
          execute: driver.execute,
          schemaName,
          ignoreTables,
        });

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
    },
    options,
  );

  return {
    migrations: state.migrations.map((migration) => migration.id),
    verified: true,
  };
};
