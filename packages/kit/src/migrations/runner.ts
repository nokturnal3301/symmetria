/**
 * The migrator: applies and rolls back migrations against a database, tracking status in the migrations table.
 */
import { quoteIdentifier } from "symmetria/internal";
import { sqlState, type QueryExecutor } from "symmetria";
import type { Driver } from "symmetria/driver";
import {
  checksumMatches,
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
  type MigrationConnection,
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
  /** Undeclared tables that adoption and repair leave out of their schema comparison. */
  ignoreTables?: readonly string[];
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

/** Journal columns added after the first release; older journals gain them once. */
const JOURNAL_COLUMNS: Readonly<Record<string, string>> = {
  state: "text NOT NULL DEFAULT 'applied'",
  direction: "text NOT NULL DEFAULT 'up'",
  statement: "integer NOT NULL DEFAULT 0",
  error: "text",
};
/** How long status waits for a lock on the journal before reporting it as busy. */
const STATUS_LOCK_TIMEOUT_MS = 2000;

/** Names the migrations whose identical schema hash makes a baseline ambiguous. */
const ambiguousBaseline = (migrations: readonly Migration[]): Error =>
  new Error(
    `symmetria: the database schema matches multiple local migrations (${migrations.map((migration) => migration.id).join(", ")}); migrations that change only data cannot be told apart by schema, so choose the baseline with --to <id> (adopt({ to }) in the API)`,
  );

export const migrator = (options: MigratorOptions) => {
  const metadataSchema = options.metadataSchema ?? "public";
  const metadataTable = options.metadataTable ?? "_symmetria_migrations";
  const qualifiedName = `${quoteIdentifier(metadataSchema)}.${quoteIdentifier(metadataTable)}`;
  const lockName = `symmetria:migrations:${qualifiedName}`;

  const connection = <Result>(
    callback: (connection: MigrationConnection) => Promise<Result>,
  ) => withMigrationConnection(options.driver, lockName, options, callback);

  /**
   * Creates the journal, or adds columns an older journal lacks. The catalog is
   * read first: ALTER TABLE takes an ACCESS EXCLUSIVE lock until commit even when
   * every column exists, which would block status for the whole migration.
   */
  const ensureJournal = async (execute: QueryExecutor): Promise<void> => {
    const present = (
      await executeSQL(
        execute,
        `SELECT attribute.attname AS name FROM pg_attribute attribute WHERE attribute.attrelid = to_regclass($1) AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
        [qualifiedName],
      )
    ).rows.map((row) => String(row.name));

    if (present.length) {
      const missing = Object.entries(JOURNAL_COLUMNS).filter(
        ([name]) => !present.includes(name),
      );

      if (missing.length) {
        await executeSQL(
          execute,
          `ALTER TABLE ${qualifiedName} ${missing.map(([name, definition]) => `ADD COLUMN IF NOT EXISTS ${name} ${definition}`).join(", ")}`,
        );
      }

      return;
    }

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
      `CREATE TABLE IF NOT EXISTS ${qualifiedName} (id text PRIMARY KEY, checksum text NOT NULL, snapshot_hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), ${Object.entries(
        JOURNAL_COLUMNS,
      )
        .map(([name, definition]) => `${name} ${definition}`)
        .join(", ")})`,
    );
  };

  const readHistory = async (
    execute: QueryExecutor,
    create: boolean,
  ): Promise<HistoryEntry[]> => {
    if (create) {
      await ensureJournal(execute);
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
        !checksumMatches(migration, entry.checksum) ||
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
          `symmetria: incomplete migration "${entry.id}" is not the last journal entry`,
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
        ...(options.ignoreTables ? { ignoreTables: options.ignoreTables } : {}),
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

  /**
   * Applies migrations one transactional group at a time. Each group's
   * transaction reads the journal again and asks `pending` what is left, given
   * the migrations this run already completed: a transaction-only driver
   * releases the lock between groups, so another runner may have applied or
   * reverted migrations in the meantime.
   */
  const run = async (
    link: MigrationConnection,
    migrations: Migration[],
    direction: "up" | "down",
    pending: (
      history: HistoryEntry[],
      completed: readonly string[],
    ) => Migration[],
  ): Promise<string[]> => {
    const completed: string[] = [];

    while (true) {
      const next = await link.transaction(async (tx) => {
        const history = await inspect(tx.execute, migrations);
        const remaining = pending(history, completed);

        if (!remaining.length) {
          return undefined;
        }

        // Created, or given the columns an older journal lacks, only when
        // there is work, so an up-to-date run leaves the journal alone.
        await ensureJournal(tx.execute);

        const plan = executionPlan(remaining, direction);

        if (!link.session && plan.some((step) => step.transaction === "none")) {
          const id = plan.find((step) => step.transaction === "none")!.id;

          throw new Error(
            link.pooled
              ? `symmetria: migration "${id}" uses transaction: "none", which needs one server connection for its statements and the migration lock; this connection pools transactions (such as PgBouncer with pool_mode=transaction). Run it over a direct or session-pooled connection`
              : `symmetria: migration "${id}" uses transaction: "none", which needs a driver with sessions (driver.session); this driver only runs whole transactions`,
          );
        }

        const [first] = plan;

        if (first!.transaction === "none") {
          const migration = remaining[0]!;

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

          return { migrations: [migration], transactional: false };
        }

        const group = remaining.filter(
          (_, position) => plan[position]!.group === first!.group,
        );

        for (const migration of group) {
          await applyStatements(tx.execute, migration, direction, options);
          await record(tx.execute, migration, direction);
        }

        options.signal?.throwIfAborted();

        return { migrations: group, transactional: true };
      });

      if (!next) {
        return completed;
      }

      if (!next.transactional) {
        // Statements of a "none" migration commit one by one on the session.
        const session = link.session!;
        const migration = next.migrations[0]!;

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
      }

      completed.push(...next.migrations.map((migration) => migration.id));
    }
  };

  return Object.freeze({
    status: async (): Promise<MigrationStatus[]> => {
      const { migrations } = await loadMigrationState(options.directory);
      // A read of committed journal rows: it must not wait for a running
      // migration's advisory lock, so a deploy in progress still reports. A
      // short lock_timeout turns a journal held by DDL into an error, not a hang.
      const read = (execute: QueryExecutor) =>
        inspect(execute, migrations, false, true);
      const history = await (options.driver.transaction
        ? options.driver.transaction(
            async (tx) => {
              await executeSQL(
                tx.execute,
                "SELECT set_config('lock_timeout', $1, true)",
                [`${STATUS_LOCK_TIMEOUT_MS}ms`],
              );

              return read(tx.execute);
            },
            { isolationLevel: "read committed", readOnly: true },
          )
        : read(options.driver.execute)
      ).catch((error: unknown) => {
        if (sqlState(error) === "55P03") {
          throw new Error(
            `symmetria: the migration journal ${qualifiedName} is locked by another session; status gave up after ${STATUS_LOCK_TIMEOUT_MS}ms. A migration creating or upgrading the journal holds the lock until it commits; try again when it finishes`,
            { cause: error },
          );
        }

        throw error;
      });

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
    },
    plan: async (
      settings: { to?: string; steps?: number; direction?: "up" | "down" } = {},
    ): Promise<ExecutionStep[]> => {
      const { migrations } = await loadMigrationState(options.directory);

      return connection((link) =>
        link.transaction(async (tx) => {
          const history = await inspect(tx.execute, migrations);
          const direction = settings.direction ?? "up";
          const steps = settings.steps ?? 1;

          if (
            direction === "down" &&
            (!Number.isSafeInteger(steps) ||
              steps < 1 ||
              steps > history.length)
          ) {
            throw new Error(
              `symmetria: invalid rollback steps: ${steps} requested, ${history.length} applied`,
            );
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
        }),
      );
    },
    migrate: async (settings: { to?: string } = {}): Promise<string[]> => {
      const { migrations } = await loadMigrationState(options.directory);
      const target = targetIndex(migrations, settings.to);

      return connection((link) =>
        run(link, migrations, "up", (history) =>
          migrations.slice(history.length, target + 1),
        ),
      );
    },
    rollback: async (settings: { steps?: number } = {}): Promise<string[]> => {
      const steps = settings.steps ?? 1;

      if (!Number.isSafeInteger(steps) || steps < 1) {
        throw new Error(
          "symmetria: rollback steps must be a positive safe integer",
        );
      }

      const { migrations } = await loadMigrationState(options.directory);
      // Chosen from the journal the first group reads; later groups revert the
      // rest, and only while it is still the latest applied migration.
      let reverting: Migration[] | undefined;

      return connection((link) =>
        run(link, migrations, "down", (history, completed) => {
          if (!reverting) {
            if (steps > history.length && history.length) {
              throw new Error(
                `symmetria: rollback steps exceed the applied migration count: ${steps} requested, ${history.length} applied`,
              );
            }

            reverting = migrations
              .slice(Math.max(history.length - steps, 0), history.length)
              .reverse();
          }

          const remaining = reverting.filter(
            (migration) => !completed.includes(migration.id),
          );

          if (remaining.length && history.at(-1)?.id !== remaining[0]!.id) {
            throw new Error(
              `symmetria: the migration journal changed during rollback: "${history.at(-1)?.id}" is now the latest applied migration, not "${remaining[0]!.id}"; check status and roll back again`,
            );
          }

          return remaining;
        }),
      );
    },
    adopt: async (
      settings: { to?: string; snapshot?: MigrationSnapshot } = {},
    ): Promise<string[]> => {
      const state = await loadMigrationState(options.directory);
      const { migrations } = state;

      return connection((link) =>
        link.transaction(async (tx) => {
          const history = await readHistory(tx.execute, true);

          if (history.some((entry) => entry.state === "incomplete")) {
            throw new Error(
              "symmetria: repair incomplete migrations before adopting history",
            );
          }

          const latest = history.at(-1);
          let target = targetIndex(migrations, settings.to);

          /** Local migrations that leave the schema at this hash. */
          const matchingHash = (hash: string | undefined): number[] =>
            migrations.flatMap((migration, position) =>
              migration.manifest.after === hash ? [position] : [],
            );

          if (settings.to === undefined && latest) {
            const matching = matchingHash(latest.snapshotHash);
            const existing = matching.find(
              (position) =>
                migrations[position]!.id === latest.id &&
                checksumMatches(migrations[position]!, latest.checksum),
            );

            if (existing === undefined && matching.length > 1) {
              throw ambiguousBaseline(
                matching.map((position) => migrations[position]!),
              );
            }

            target = existing ?? matching[0] ?? -1;
          } else if (settings.to === undefined && target >= 0) {
            // Without history the latest migration is only a guess: a data-only
            // migration (a seed, an --empty migration) leaves the same schema
            // hash as the one before it, and recording it would skip its SQL.
            const matching = matchingHash(migrations[target]!.manifest.after);

            if (matching.length > 1) {
              throw ambiguousBaseline(
                matching.map((position) => migrations[position]!),
              );
            }
          }

          if (target < 0) {
            throw new Error(
              "symmetria: the database schema matches no local migration; choose the baseline with --to <id> (adopt({ to }) in the API)",
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
      await connection((link) =>
        link.transaction(async (tx) => {
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
              `symmetria: repair requires the last, incomplete migration; "${settings.id}" is ${entry ? (entry.state === "incomplete" ? "not the last journal entry" : "applied") : "not in the journal"}`,
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
