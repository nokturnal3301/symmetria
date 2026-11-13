/**
 * Executes migration SQL: splits statements into steps, runs them in a transaction with advisory locking,
 * and wraps failures with SQLSTATE details.
 */
import { setTimeout as delay } from "node:timers/promises";
import { normalizeResult } from "symmetria/internal";
import { sqlState, type QueryExecutor } from "symmetria";
import type {
  Driver,
  SessionDriver,
  TransactionDriver,
} from "symmetria/driver";
import type { Migration } from "./files";
import { parseMigrationSQL, splitMigrationSQL } from "./sql";

export type ExecutionOptions = {
  advisoryLockTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: MigrationEvent) => void;
};
export type MigrationEvent = {
  type: "statement-start" | "statement-end" | "statement-error";
  migration: string;
  direction: "up" | "down";
  statement: number;
  sql: string;
  durationMs?: number;
  sqlState?: string;
};
export type ExecutionStep = {
  id: string;
  transaction: "batch" | "each" | "none";
  group: number;
  statements: string[];
};

/** ALTER TYPE … ADD VALUE: the new label cannot be used until the transaction commits. */
const addsEnumLabel = (words: readonly string[]): boolean =>
  words[0] === "ALTER" &&
  words[1] === "TYPE" &&
  words.some(
    (word, position) => word === "ADD" && words[position + 1] === "VALUE",
  );

/**
 * Adjacent batch migrations share one transaction, except that a migration
 * adding enum labels ends its group: PostgreSQL refuses a label in the
 * transaction that added it (SQLSTATE 55P04), and the next migration may use it.
 */
export const executionPlan = (
  migrations: Migration[],
  direction: "up" | "down",
): ExecutionStep[] => {
  let group = 0;
  let previous = "";
  let labelsAdded = false;

  return migrations.map((migration) => {
    const transaction = migration.manifest.transaction ?? "batch";

    if (transaction !== "batch" || previous !== "batch" || labelsAdded) {
      group++;
    }

    previous = transaction;
    const parsed = parseMigrationSQL(migration[direction]);
    const statements = parsed.map((statement) => statement.sql);
    labelsAdded = parsed.some(({ words }) => addsEnumLabel(words));

    if (
      transaction !== "none" &&
      parsed.some(
        ({ words }) => words.includes("CONCURRENTLY") || words[0] === "VACUUM",
      )
    ) {
      throw new Error(
        `symmetria: migration "${migration.id}" requires transaction: "none"`,
      );
    }

    return { id: migration.id, transaction, group, statements };
  });
};

export { sqlState };

/** PostgreSQL's DETAIL or HINT field, as both drivers expose it. */
const serverField = (
  cause: unknown,
  field: "detail" | "hint",
): string | undefined => {
  const value =
    cause && typeof cause === "object"
      ? (cause as Record<string, unknown>)[field]
      : undefined;

  return typeof value === "string" && value ? value : undefined;
};

export class MigrationExecutionError extends Error {
  readonly migration: string;
  readonly direction: "up" | "down";
  readonly statement: number;
  readonly sql: string;
  readonly sqlState: string | undefined;
  /** PostgreSQL's DETAIL, such as which key value was duplicated. */
  readonly detail: string | undefined;
  constructor(
    migration: string,
    direction: "up" | "down",
    statement: number,
    sql: string,
    cause: unknown,
  ) {
    const state = sqlState(cause);
    const detail = serverField(cause, "detail");
    const hint = serverField(cause, "hint");
    super(
      `symmetria: migration "${migration}" failed (${direction}, statement ${statement}${state ? `, SQLSTATE ${state}` : ""}): ${cause instanceof Error ? cause.message : String(cause)}${detail ? `\nDETAIL: ${detail}` : ""}${hint ? `\nHINT: ${hint}` : ""}\n\nSQL:\n${sql}`,
      { cause },
    );
    this.name = "MigrationExecutionError";
    this.migration = migration;
    this.direction = direction;
    this.statement = statement;
    this.sql = sql;
    this.sqlState = state;
    this.detail = detail;
  }
}

export const executeSQL = async (
  executor: QueryExecutor,
  sql: string,
  parameters: unknown[] = [],
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const result = normalizeResult(await executor({ sql, parameters }));
  signal?.throwIfAborted();

  return result;
};

export const applyStatements = async (
  executor: QueryExecutor,
  migration: Migration,
  direction: "up" | "down",
  options: ExecutionOptions,
  completed?: (statement: number) => Promise<void>,
): Promise<void> => {
  for (const [position, sql] of splitMigrationSQL(
    migration[direction],
  ).entries()) {
    const event = {
      migration: migration.id,
      direction,
      statement: position + 1,
      sql,
    };
    const started = performance.now();
    options.onEvent?.({ ...event, type: "statement-start" });

    try {
      await executeSQL(executor, sql, [], options.signal);
      await completed?.(position + 1);
    } catch (cause) {
      const error = new MigrationExecutionError(
        migration.id,
        direction,
        position + 1,
        sql,
        cause,
      );
      options.onEvent?.({
        ...event,
        type: "statement-error",
        durationMs: performance.now() - started,
        ...(error.sqlState ? { sqlState: error.sqlState } : {}),
      });
      throw error;
    }

    options.onEvent?.({
      ...event,
      type: "statement-end",
      durationMs: performance.now() - started,
    });
  }

  options.signal?.throwIfAborted();
};

/**
 * Where the runner works: transactions that hold the migration lock and, on a
 * driver with sessions, the pinned session that nontransactional migrations need.
 */
export type MigrationConnection = {
  /**
   * Runs `callback` in a READ COMMITTED transaction that holds the migration
   * lock. A session driver keeps one session lock across these transactions;
   * a transaction-only driver takes a transaction-level lock in each one, so
   * another runner can commit between two of them.
   */
  readonly transaction: <Result>(
    callback: (tx: TransactionDriver) => Promise<Result>,
  ) => Promise<Result>;
  /** The pinned session for `transaction: "none"` migrations; absent on transaction-only drivers. */
  readonly session?: SessionDriver;
  /** The driver has sessions, but its connection pools transactions, so they cannot pin a server. */
  readonly pooled?: boolean;
};

const LOCK_SETTINGS =
  "SELECT set_config('lock_timeout', $1, $4), set_config('statement_timeout', $2, $4), set_config('standard_conforming_strings', $3, $4)";

/** How long the pooling check waits for a second pool connection to answer. */
const POOLING_PROBE_TIMEOUT_MS = 1000;

const POOLED = Symbol("symmetria.pooled");

const backendPid = async (
  execute: QueryExecutor,
  signal?: AbortSignal,
): Promise<number> =>
  Number(
    (await executeSQL(execute, "SELECT pg_backend_pid() AS pid", [], signal))
      .rows[0]!.pid,
  );

/**
 * The server process a session runs on, or undefined when the connection pools
 * transactions (PgBouncer with pool_mode=transaction, for example): then one
 * client connection's statements move between server processes and two client
 * connections share one, so a session lock or setting protects nothing. A
 * direct or session-pooled connection never does either. The second client
 * connection comes from the driver's pool; a pool with no free connection
 * cannot answer within the timeout, and then only the session's own
 * statements are compared.
 */
const pinnedBackend = async (
  driver: Driver,
  session: SessionDriver,
  signal?: AbortSignal,
): Promise<number | undefined> => {
  const first = await backendPid(session.execute, signal);
  let latest = first;

  // Other clients of a busy pooler can take the free server between two
  // statements and hide it once; three rounds make that unlikely.
  for (let round = 0; round < 3; round++) {
    const timer = new AbortController();
    const other = await Promise.race([
      backendPid(driver.execute).catch(() => undefined),
      delay(POOLING_PROBE_TIMEOUT_MS, undefined, {
        signal: timer.signal,
      }).catch(() => undefined),
    ]);
    timer.abort();
    const next = await backendPid(session.execute, signal);

    if (next !== first || other === latest || other === next) {
      return undefined;
    }

    latest = next;

    if (other === undefined) {
      break;
    }
  }

  return first;
};

/** A session transaction must run on the session's server process, which holds the lock. */
const assertPinned = async (
  execute: QueryExecutor,
  pid: number,
): Promise<void> => {
  const current = await backendPid(execute);

  if (current !== pid) {
    throw new Error(
      `symmetria: the migration session moved from PostgreSQL process ${pid} to ${current}: this connection pools transactions (such as PgBouncer with pool_mode=transaction), which cannot hold the migration's session lock. Migrate over a direct or session-pooled connection`,
    );
  }
};

/**
 * Session locks survive commits, so a session driver locks once. A driver that
 * only offers whole transactions locks each transaction with
 * pg_advisory_xact_lock and the same timeouts, so every driver gets the same
 * transaction boundaries. A session driver whose connection pools transactions
 * works like a transaction-only driver, since its sessions cannot hold a lock.
 */
export const withMigrationConnection = async <Result>(
  driver: Driver,
  lock: string,
  options: ExecutionOptions,
  callback: (connection: MigrationConnection) => Promise<Result>,
): Promise<Result> => {
  const advisory = options.advisoryLockTimeoutMs ?? 10000;
  const ddl = options.lockTimeoutMs ?? 5000;
  const statement = options.statementTimeoutMs ?? 600000;

  for (const value of [advisory, ddl, statement]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
      throw new Error(
        "symmetria: migration timeouts must be integers between 0 and 2147483647 milliseconds",
      );
    }
  }

  /** Tries the advisory lock until it is free or the advisory timeout passes. */
  const acquire = async (
    execute: QueryExecutor,
    scope: "session" | "transaction",
    attempted?: () => void,
  ): Promise<void> => {
    const started = performance.now();

    while (true) {
      options.signal?.throwIfAborted();
      attempted?.();
      const acquired = await executeSQL(
        execute,
        `SELECT pg_try_advisory_${scope === "transaction" ? "xact_" : ""}lock(1937339476, hashtext($1)) AS locked`,
        [lock],
        options.signal,
      );

      if (acquired.rows[0]?.locked) {
        return;
      }

      if (performance.now() - started >= advisory) {
        throw new Error(
          `symmetria: migration advisory lock timeout after ${advisory}ms`,
        );
      }

      // An abort during the wait reports the signal's reason, not AbortError.
      await delay(
        Math.min(50, advisory),
        undefined,
        options.signal ? { signal: options.signal } : {},
      ).catch((error: unknown) => {
        options.signal?.throwIfAborted();
        throw error;
      });
    }
  };

  if (driver.session) {
    const outcome = await driver.session<Result | typeof POOLED>(
      async (session) => {
        options.signal?.throwIfAborted();
        const pid = await pinnedBackend(driver, session, options.signal);

        if (pid === undefined) {
          return POOLED;
        }

        let cancellation: Promise<void> | undefined;

        const abort = () => {
          cancellation = session.cancel?.();
          void cancellation?.catch(() => {});
        };

        options.signal?.addEventListener("abort", abort, { once: true });
        let original: Record<string, unknown> | undefined;
        let lockAttempted = false;
        let moved = false;

        /**
         * Releases the session lock. After the session moved to another server
         * process (a pooler the check missed), an unlock can reach a process
         * that does not hold it, so it is repeated until one does, briefly.
         */
        const release = async () => {
          for (let attempt = 0; attempt < 50; attempt++) {
            const { rows } = await executeSQL(
              session.execute,
              "SELECT pg_advisory_unlock(1937339476, hashtext($1)) AS released",
              [lock],
            );

            if (rows[0]?.released || !moved) {
              return;
            }

            await delay(10);
          }
        };

        try {
          original = (
            await executeSQL(
              session.execute,
              "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout, current_setting('standard_conforming_strings') AS strings",
            )
          ).rows[0]!;
          await acquire(session.execute, "session", () => {
            lockAttempted = true;
          });
          await executeSQL(session.execute, LOCK_SETTINGS, [
            `${ddl}ms`,
            `${statement}ms`,
            "on",
            false,
          ]);

          return await callback({
            transaction: (work) =>
              session.transaction(
                async (tx) => {
                  try {
                    await assertPinned(tx.execute, pid);
                  } catch (error) {
                    moved = true;
                    throw error;
                  }

                  return work(tx);
                },
                { isolationLevel: "read committed" },
              ),
            session,
          });
        } finally {
          options.signal?.removeEventListener("abort", abort);
          await cancellation?.catch(() => {});

          try {
            if (original) {
              await executeSQL(
                session.execute,
                "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false), set_config('standard_conforming_strings', $3, false)",
                [
                  original.lock_timeout,
                  original.statement_timeout,
                  original.strings,
                ],
              );
            }
          } finally {
            // A cancellation can arrive after PostgreSQL acquires the lock but
            // before its result reaches us. Release even when acquisition is uncertain.
            if (lockAttempted) {
              await release();
            }
          }
        }
      },
    );

    if (outcome !== POOLED) {
      return outcome as Result;
    }
  }

  if (!driver.transaction) {
    throw new Error(
      "symmetria: migrations require a transaction-capable driver",
    );
  }

  return callback({
    transaction: (work) =>
      driver.transaction!(
        async (tx) => {
          options.signal?.throwIfAborted();
          // Released at commit or rollback, like the settings.
          await acquire(tx.execute, "transaction");
          await executeSQL(tx.execute, LOCK_SETTINGS, [
            `${ddl}ms`,
            `${statement}ms`,
            "on",
            true,
          ]);

          return work(tx);
        },
        { isolationLevel: "read committed" },
      ),
    ...(driver.session ? { pooled: true } : {}),
  });
};
