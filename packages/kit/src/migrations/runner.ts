import { quoteIdentifier, normalizeResult } from "symmetria/internal";
import type { QueryExecutor } from "symmetria";
import type { Driver, TransactionDriver } from "symmetria/driver";
import { loadMigrations, type Migration } from "./files";
import { splitMigrationSQL } from "./sql";

export type MigratorOptions = {
  driver: Driver;
  directory: string;
  metadataSchema?: string;
  metadataTable?: string;
};
export type MigrationStatus = {
  id: string;
  status: "applied" | "pending";
  appliedAt?: Date;
};
type HistoryEntry = {
  id: string;
  checksum: string;
  snapshotHash: string;
  appliedAt: Date;
};

export const migrator = (options: MigratorOptions) => {
  const metadataSchema = options.metadataSchema ?? "public";
  const metadataTable = options.metadataTable ?? "_symmetria_migrations";
  const qualifiedName = `${quoteIdentifier(metadataSchema)}.${quoteIdentifier(metadataTable)}`;
  const lockName = `symmetria:migrations:${qualifiedName}`;

  const execute = async (
    executor: QueryExecutor,
    sql: string,
    parameters: unknown[] = [],
  ) => normalizeResult(await executor({ sql, parameters }));

  const readHistory = async (
    driver: TransactionDriver,
    create: boolean,
  ): Promise<HistoryEntry[]> => {
    // A transaction-scoped lock is released by PostgreSQL on commit, error or disconnect.
    await execute(
      driver.execute,
      "SELECT pg_advisory_xact_lock(1937339476, hashtext($1))",
      [lockName],
    );
    await execute(driver.execute, "SET LOCAL standard_conforming_strings = on");

    if (create) {
      await execute(
        driver.execute,
        `CREATE TABLE IF NOT EXISTS ${qualifiedName} (id text PRIMARY KEY, checksum text NOT NULL, snapshot_hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
      );
    } else {
      const exists = await execute(
        driver.execute,
        "SELECT to_regclass($1)::text AS name",
        [qualifiedName],
      );

      if (!exists.rows[0]?.name) {
        return [];
      }
    }

    const result = await execute(
      driver.execute,
      `SELECT id, checksum, snapshot_hash, applied_at FROM ${qualifiedName} ORDER BY id COLLATE "C"`,
    );

    return result.rows.map(
      (row): HistoryEntry => ({
        id: String(row.id),
        checksum: String(row.checksum),
        snapshotHash: String(row.snapshot_hash),
        appliedAt: new Date(row.applied_at as string | Date),
      }),
    );
  };

  const inspect = async (
    driver: TransactionDriver,
    migrations: Migration[],
    create: boolean,
  ): Promise<HistoryEntry[]> => {
    const history = await readHistory(driver, create);

    for (const [position, entry] of history.entries()) {
      const migration = migrations[position];

      if (!migration || entry.id !== migration.id) {
        throw new Error(
          `symmetria: applied migration "${entry.id}" is missing or out of order in the local chain`,
        );
      }

      if (
        entry.checksum !== migration.checksum ||
        entry.snapshotHash !== migration.manifest.after
      ) {
        throw new Error(
          `symmetria: checksum mismatch for applied migration "${entry.id}"`,
        );
      }
    }

    return history;
  };

  const transaction = async <Result>(
    callback: (driver: TransactionDriver) => Promise<Result>,
  ): Promise<Result> => {
    if (!options.driver.transaction) {
      throw new Error(
        "symmetria: migrations require a transaction-capable driver",
      );
    }

    return options.driver.transaction(callback, {
      isolationLevel: "read committed",
    });
  };

  const apply = async (
    driver: TransactionDriver,
    migration: Migration,
    direction: "up" | "down",
  ): Promise<void> => {
    for (const statement of splitMigrationSQL(migration[direction])) {
      try {
        await execute(driver.execute, statement);
      } catch (cause) {
        throw new Error(
          `symmetria: migration "${migration.id}" failed (${direction})\n\nSQL:\n${statement}`,
          { cause },
        );
      }
    }
  };

  return Object.freeze({
    /**
     * Record the local chain as applied without running it: after a squash, or to
     * baseline a database whose schema already matches a local snapshot.
     */
    adopt: async (settings: { to?: string } = {}): Promise<string[]> => {
      const migrations = await loadMigrations(options.directory);

      return transaction(async (driver) => {
        const history = await readHistory(driver, true);
        const latest = history.at(-1);
        let target =
          settings.to !== undefined
            ? migrations.findIndex((migration) => migration.id === settings.to)
            : migrations.length - 1;

        if (settings.to === undefined && latest) {
          const matching = migrations.flatMap((migration, position) =>
            migration.manifest.after === latest.snapshotHash ? [position] : [],
          );
          // Data-only migrations share a schema hash. Preserve the known applied
          // boundary rather than replaying a backfill or skipping a pending one.
          const existing = matching.find(
            (position) =>
              migrations[position]!.id === latest.id &&
              migrations[position]!.checksum === latest.checksum,
          );

          if (existing === undefined && matching.length > 1) {
            throw new Error(
              "symmetria: the database snapshot matches multiple local migrations; pass { to } to choose the baseline explicitly",
            );
          }

          target = existing ?? matching[0] ?? -1;
        }

        if (settings.to !== undefined && target < 0) {
          throw new Error(
            `symmetria: unknown migration target "${settings.to}"`,
          );
        }

        if (target < 0) {
          throw new Error(
            "symmetria: the database snapshot matches no local migration; pass { to } to baseline it explicitly",
          );
        }

        const adopted = migrations.slice(0, target + 1);
        await execute(driver.execute, `DELETE FROM ${qualifiedName}`);

        for (const migration of adopted) {
          await execute(
            driver.execute,
            `INSERT INTO ${qualifiedName} (id, checksum, snapshot_hash) VALUES ($1, $2, $3)`,
            [migration.id, migration.checksum, migration.manifest.after],
          );
        }

        return adopted.map((migration) => migration.id);
      });
    },
    status: async (): Promise<MigrationStatus[]> => {
      const migrations = await loadMigrations(options.directory);

      return transaction(async (driver) => {
        const history = await inspect(driver, migrations, false);

        return migrations.map((migration, position) => {
          const applied = history[position];

          return applied
            ? {
                id: migration.id,
                status: "applied" as const,
                appliedAt: applied.appliedAt,
              }
            : { id: migration.id, status: "pending" as const };
        });
      });
    },
    migrate: async (settings: { to?: string } = {}): Promise<string[]> => {
      const migrations = await loadMigrations(options.directory);
      const target =
        settings.to === undefined
          ? migrations.length - 1
          : migrations.findIndex((migration) => migration.id === settings.to);

      if (settings.to !== undefined && target < 0) {
        throw new Error(`symmetria: unknown migration target "${settings.to}"`);
      }

      return transaction(async (driver) => {
        const history = await inspect(driver, migrations, true);
        const pending = migrations.slice(history.length, target + 1);

        for (const migration of pending) {
          await apply(driver, migration, "up");
          await execute(
            driver.execute,
            `INSERT INTO ${qualifiedName} (id, checksum, snapshot_hash) VALUES ($1, $2, $3)`,
            [migration.id, migration.checksum, migration.manifest.after],
          );
        }

        return pending.map((migration) => migration.id);
      });
    },
    rollback: async (settings: { steps?: number } = {}): Promise<string[]> => {
      const steps = settings.steps ?? 1;

      if (!Number.isSafeInteger(steps) || steps < 1) {
        throw new Error(
          "symmetria: rollback steps must be a positive safe integer",
        );
      }

      const migrations = await loadMigrations(options.directory);

      return transaction(async (driver) => {
        const history = await inspect(driver, migrations, false);

        if (!history.length) {
          return [];
        }

        if (steps > history.length) {
          throw new Error(
            "symmetria: rollback steps exceed the applied migration count",
          );
        }

        const reverting = migrations
          .slice(history.length - steps, history.length)
          .reverse();

        for (const migration of reverting) {
          await apply(driver, migration, "down");
          await execute(
            driver.execute,
            `DELETE FROM ${qualifiedName} WHERE id = $1`,
            [migration.id],
          );
        }

        return reverting.map((migration) => migration.id);
      });
    },
  });
};
