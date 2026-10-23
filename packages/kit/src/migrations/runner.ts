import { quoteIdentifier } from "symmetria/internal";
import type { QueryExecutor } from "symmetria";
import type { Driver, SessionDriver } from "symmetria/driver";
import {
  loadMigrationState,
  type Migration,
  type MigrationState,
} from "./files";
import { detectDrift, formatDriftFindings } from "./drift";
import {
  emptySnapshot,
  snapshotHash,
  type MigrationSnapshot,
} from "./snapshot";
import {
  applyStatements,
  executeSQL,
  executionPlan,
  withMigrationConnection,
  type ExecutionOptions,
  type ExecutionStep,
} from "./execution";
import { verifyBoundary } from "./verify";

export type MigratorOptions = ExecutionOptions & {
  driver: Driver;
  directory: string;
  metadataSchema?: string;
  metadataTable?: string;
  /** Administrative URL used only to create disposable databases for historical verification. */
  verificationDatabaseUrl?: string;
};
export type MigrationStatus = {
  id: string;
  status: "applied" | "pending" | "incomplete";
  appliedAt?: Date;
  direction?: "up" | "down";
  statement?: number;
  error?: string;
};
type HistoryEntry = {
  id: string;
  checksum: string;
  snapshotHash: string;
  appliedAt: Date;
  state: "applied" | "incomplete";
  direction: "up" | "down";
  statement: number;
  error?: string;
};

export const migrator = (options: MigratorOptions) => {
  const metadataSchema = options.metadataSchema ?? "public";
  const metadataTable = options.metadataTable ?? "_symmetria_migrations";
  const qualifiedName = `${quoteIdentifier(metadataSchema)}.${quoteIdentifier(metadataTable)}`;
  const lockName = `symmetria:migrations:${qualifiedName}`;

  const connection = <Result>(
    callback: (session: SessionDriver, atomic: boolean) => Promise<Result>,
  ) => withMigrationConnection(options.driver, lockName, options, callback);

  const readHistory = async (
    execute: QueryExecutor,
    create: boolean,
  ): Promise<HistoryEntry[]> => {
    if (create) {
      const namespace = await executeSQL(
        execute,
        "SELECT 1 FROM pg_namespace WHERE nspname = $1",
        [metadataSchema],
      );

      if (!namespace.rows.length) {
        await executeSQL(
          execute,
          `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(metadataSchema)}`,
        );
      }

      await executeSQL(
        execute,
        `CREATE TABLE IF NOT EXISTS ${qualifiedName} (id text PRIMARY KEY, checksum text NOT NULL, snapshot_hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
      );
      await executeSQL(
        execute,
        `ALTER TABLE ${qualifiedName} ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'applied', ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'up', ADD COLUMN IF NOT EXISTS statement integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS error text`,
      );
    } else {
      const exists = await executeSQL(
        execute,
        "SELECT to_regclass($1)::text AS name",
        [qualifiedName],
      );

      if (!exists.rows[0]?.name) {
        return [];
      }
    }

    const result = await executeSQL(
      execute,
      `SELECT id, checksum, snapshot_hash, applied_at, to_jsonb(history)->>'state' AS state, to_jsonb(history)->>'direction' AS direction, to_jsonb(history)->>'statement' AS statement, to_jsonb(history)->>'error' AS error FROM ${qualifiedName} history ORDER BY id COLLATE "C"`,
    );

    return result.rows.map((row) => {
      const statement = Number(row.statement ?? 0);

      if (
        (row.state !== null &&
          !["applied", "incomplete"].includes(String(row.state))) ||
        (row.direction !== null &&
          !["up", "down"].includes(String(row.direction))) ||
        !Number.isSafeInteger(statement) ||
        statement < 0
      ) {
        throw new Error(
          `symmetria: invalid migration journal state at "${row.id}"`,
        );
      }

      return {
        id: String(row.id),
        checksum: String(row.checksum),
        snapshotHash: String(row.snapshot_hash),
        appliedAt: new Date(row.applied_at as string | Date),
        state: row.state === "incomplete" ? "incomplete" : "applied",
        direction: row.direction === "down" ? "down" : "up",
        statement,
        ...(row.error ? { error: String(row.error) } : {}),
      };
    });
  };

  const inspect = async (
    execute: QueryExecutor,
    migrations: Migration[],
    create = false,
    incomplete = false,
  ): Promise<HistoryEntry[]> => {
    const history = await readHistory(execute, create);

    for (const [position, entry] of history.entries()) {
      const migration = migrations[position];

      if (!migration || migration.id !== entry.id) {
        throw new Error(
          `symmetria: applied migration "${entry.id}" is missing or out of order in the local chain`,
        );
      }

      if (
        migration.checksum !== entry.checksum ||
        migration.manifest.after !== entry.snapshotHash
      ) {
        throw new Error(
          `symmetria: checksum mismatch for applied migration "${entry.id}"`,
        );
      }

      if (!incomplete && entry.state === "incomplete") {
        throw new Error(
          `symmetria: migration "${entry.id}" is incomplete (${entry.direction}, ${entry.statement} confirmed statements); inspect the database and use repair`,
        );
      }

      if (entry.state === "incomplete" && position !== history.length - 1) {
        throw new Error(
          "symmetria: incomplete migration is not the last journal entry",
        );
      }
    }

    return history;
  };

  const targetIndex = (migrations: Migration[], to?: string): number => {
    const target =
      to === undefined
        ? migrations.length - 1
        : migrations.findIndex((migration) => migration.id === to);

    if (to !== undefined && target < 0) {
      throw new Error(`symmetria: unknown migration target "${to}"`);
    }

    return target;
  };

  const record = async (
    execute: QueryExecutor,
    migration: Migration,
    direction: "up" | "down",
  ) => {
    if (direction === "up") {
      await executeSQL(
        execute,
        `INSERT INTO ${qualifiedName} (id, checksum, snapshot_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET state = 'applied', direction = 'up', statement = 0, error = NULL, applied_at = clock_timestamp()`,
        [migration.id, migration.checksum, migration.manifest.after],
      );
    } else {
      await executeSQL(execute, `DELETE FROM ${qualifiedName} WHERE id = $1`, [
        migration.id,
      ]);
    }
  };

  const checkBoundary = async (
    execute: QueryExecutor,
    state: MigrationState,
    target: number,
    snapshot?: MigrationSnapshot,
  ) => {
    const hash =
      target < 0
        ? snapshotHash(emptySnapshot())
        : state.migrations[target]!.manifest.after;
    const expected =
      snapshot ??
      (target < 0
        ? emptySnapshot()
        : hash === snapshotHash(state.snapshot)
          ? state.snapshot
          : undefined);

    if (expected) {
      if (snapshotHash(expected) !== hash) {
        throw new Error(
          "symmetria: verification snapshot does not match the target migration hash",
        );
      }

      const findings = await detectDrift({
        execute,
        snapshot: expected,
        metadataSchema,
        metadataTable,
      });

      if (findings.length) {
        throw new Error(
          `symmetria: schema does not match the adoption/recovery target\n${formatDriftFindings(findings)}`,
        );
      }
    } else {
      if (!options.verificationDatabaseUrl) {
        throw new Error(
          "symmetria: historical verification requires verificationDatabaseUrl or a matching snapshot",
        );
      }

      await verifyBoundary({
        ...options,
        execute,
        state,
        target,
        url: options.verificationDatabaseUrl,
        metadataSchema,
        metadataTable,
      });
    }
  };

  const run = async (
    session: SessionDriver,
    atomic: boolean,
    migrations: Migration[],
    direction: "up" | "down",
  ) => {
    const plan = executionPlan(migrations, direction);

    if (atomic && plan.some((step) => step.transaction !== "batch")) {
      throw new Error(
        "symmetria: each/none migrations require a session-capable driver",
      );
    }

    for (let position = 0; position < migrations.length; ) {
      const step = plan[position]!;

      if (step.transaction === "none") {
        const migration = migrations[position++]!;
        await session.transaction(async (tx) => {
          await readHistory(tx.execute, true);

          if (direction === "up") {
            await executeSQL(
              tx.execute,
              `INSERT INTO ${qualifiedName} (id, checksum, snapshot_hash, state, direction) VALUES ($1, $2, $3, 'incomplete', 'up')`,
              [migration.id, migration.checksum, migration.manifest.after],
            );
          } else {
            await executeSQL(
              tx.execute,
              `UPDATE ${qualifiedName} SET state = 'incomplete', direction = 'down', statement = 0, error = NULL WHERE id = $1`,
              [migration.id],
            );
          }
        });

        try {
          await applyStatements(
            session.execute,
            migration,
            direction,
            options,
            async (statement) => {
              await executeSQL(
                session.execute,
                `UPDATE ${qualifiedName} SET statement = $2 WHERE id = $1`,
                [migration.id, statement],
              );
            },
          );
          await record(session.execute, migration, direction);
        } catch (error) {
          await executeSQL(
            session.execute,
            `UPDATE ${qualifiedName} SET error = $2 WHERE id = $1`,
            [
              migration.id,
              error instanceof Error ? error.message : String(error),
            ],
          );
          throw error;
        }
      } else {
        const group: Migration[] = [];

        while (position < plan.length && plan[position]!.group === step.group) {
          group.push(migrations[position++]!);
        }

        await session.transaction(
          async (tx) => {
            await readHistory(tx.execute, true);

            for (const migration of group) {
              await applyStatements(tx.execute, migration, direction, options);
              await record(tx.execute, migration, direction);
            }

            options.signal?.throwIfAborted();
          },
          { isolationLevel: "read committed" },
        );
      }
    }

    return migrations.map((migration) => migration.id);
  };

  return Object.freeze({
    status: async (): Promise<MigrationStatus[]> => {
      const { migrations } = await loadMigrationState(options.directory);

      return connection(async (session) => {
        const history = await inspect(session.execute, migrations, false, true);

        return migrations.map((migration, position) => {
          const entry = history[position];

          return entry
            ? {
                id: migration.id,
                status: entry.state,
                appliedAt: entry.appliedAt,
                ...(entry.state === "incomplete"
                  ? {
                      direction: entry.direction,
                      statement: entry.statement,
                      ...(entry.error ? { error: entry.error } : {}),
                    }
                  : {}),
              }
            : { id: migration.id, status: "pending" };
        });
      });
    },
    plan: async (
      settings: { to?: string; steps?: number; direction?: "up" | "down" } = {},
    ): Promise<ExecutionStep[]> => {
      const { migrations } = await loadMigrationState(options.directory);

      return connection(async (session) => {
        const history = await inspect(session.execute, migrations);
        const direction = settings.direction ?? "up";
        const steps = settings.steps ?? 1;

        if (
          direction === "down" &&
          (!Number.isSafeInteger(steps) || steps < 1 || steps > history.length)
        ) {
          throw new Error("symmetria: invalid rollback steps");
        }

        return executionPlan(
          direction === "up"
            ? migrations.slice(
                history.length,
                targetIndex(migrations, settings.to) + 1,
              )
            : migrations
                .slice(history.length - steps, history.length)
                .reverse(),
          direction,
        );
      });
    },
    migrate: async (settings: { to?: string } = {}): Promise<string[]> => {
      const { migrations } = await loadMigrationState(options.directory);
      const target = targetIndex(migrations, settings.to);

      return connection(async (session, atomic) => {
        const history = await inspect(session.execute, migrations);

        return run(
          session,
          atomic,
          migrations.slice(history.length, target + 1),
          "up",
        );
      });
    },
    rollback: async (settings: { steps?: number } = {}): Promise<string[]> => {
      const steps = settings.steps ?? 1;

      if (!Number.isSafeInteger(steps) || steps < 1) {
        throw new Error(
          "symmetria: rollback steps must be a positive safe integer",
        );
      }

      const { migrations } = await loadMigrationState(options.directory);

      return connection(async (session, atomic) => {
        const history = await inspect(session.execute, migrations);

        if (!history.length) {
          return [];
        }

        if (steps > history.length) {
          throw new Error(
            "symmetria: rollback steps exceed the applied migration count",
          );
        }

        return run(
          session,
          atomic,
          migrations.slice(history.length - steps, history.length).reverse(),
          "down",
        );
      });
    },
    adopt: async (
      settings: { to?: string; snapshot?: MigrationSnapshot } = {},
    ): Promise<string[]> => {
      const state = await loadMigrationState(options.directory);
      const { migrations } = state;

      return connection((session) =>
        session.transaction(async (tx) => {
          const history = await readHistory(tx.execute, true);

          if (history.some((entry) => entry.state === "incomplete")) {
            throw new Error(
              "symmetria: repair incomplete migrations before adopting history",
            );
          }

          const latest = history.at(-1);
          let target = targetIndex(migrations, settings.to);

          if (settings.to === undefined && latest) {
            const matching = migrations.flatMap((migration, position) =>
              migration.manifest.after === latest.snapshotHash
                ? [position]
                : [],
            );
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

          if (target < 0) {
            throw new Error(
              "symmetria: the database snapshot matches no local migration; pass { to } to baseline it explicitly",
            );
          }

          await checkBoundary(tx.execute, state, target, settings.snapshot);
          await executeSQL(tx.execute, `DELETE FROM ${qualifiedName}`);
          const adopted = migrations.slice(0, target + 1);

          for (const migration of adopted) {
            await record(tx.execute, migration, "up");
          }

          return adopted.map((migration) => migration.id);
        }),
      );
    },
    repair: async (settings: {
      id: string;
      action: "retry" | "complete";
      snapshot?: MigrationSnapshot;
    }): Promise<void> => {
      if (!["retry", "complete"].includes(settings.action)) {
        throw new Error("symmetria: repair action must be retry or complete");
      }

      const state = await loadMigrationState(options.directory);
      await connection((session) =>
        session.transaction(async (tx) => {
          const history = await inspect(
            tx.execute,
            state.migrations,
            true,
            true,
          );
          const entry = history.find((entry) => entry.id === settings.id);

          if (
            !entry ||
            entry.state !== "incomplete" ||
            history.at(-1) !== entry
          ) {
            throw new Error(
              "symmetria: repair requires the last, incomplete migration",
            );
          }

          const index = state.migrations.findIndex(
            (migration) => migration.id === entry.id,
          );
          const applied =
            (settings.action === "complete") === (entry.direction === "up");
          await checkBoundary(
            tx.execute,
            state,
            applied ? index : index - 1,
            settings.snapshot,
          );
          await record(
            tx.execute,
            state.migrations[index]!,
            applied ? "up" : "down",
          );
        }),
      );
    },
  });
};
