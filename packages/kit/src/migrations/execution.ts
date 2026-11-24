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
import { parseMigrationSQL, type ParsedStatement } from "./sql";

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

const NAME = String.raw`(?:"|[A-Z_][A-Z_0-9$]*)`;
const CONCURRENT = [
  /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY(?: |$)/,
  /^DROP INDEX CONCURRENTLY(?: |$)/,
  // REINDEX (VERBOSE, CONCURRENTLY) … and REINDEX TABLE CONCURRENTLY …
  /^REINDEX \( (?:[^)]* , )?CONCURRENTLY(?! (?:FALSE|OFF) )/,
  /^REINDEX (?:\( [^)]*\) )?(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM) CONCURRENTLY(?: |$)/,
];
const NONTRANSACTIONAL = [
  ...CONCURRENT,
  new RegExp(
    String.raw`^ALTER TABLE .* DETACH PARTITION ${NAME}(?: \. ${NAME})* CONCURRENTLY$`,
  ),
  /^VACUUM(?: |$)/,
  /^(?:CREATE|DROP) (?:DATABASE|TABLESPACE) /,
  /^ALTER SYSTEM /,
];

/**
 * The statements whose lock waits hold up no reads or writes. CONCURRENTLY
 * index builds, drops and reindexes wait under a SHARE UPDATE EXCLUSIVE lock
 * for every older transaction that could use the table, anywhere in the
 * database for a build. VALIDATE CONSTRAINT, as the only action of its ALTER
 * TABLE, waits only for that lock (and ROW SHARE on a foreign key's target).
 * Neither lock conflicts with reads or writes, so queries do not queue behind
 * the wait. Not among them: DETACH PARTITION … CONCURRENTLY, whose second
 * transaction takes an ACCESS EXCLUSIVE lock on the partition, so every query
 * of the partition would queue behind its wait; VACUUM, as VACUUM FULL takes
 * an ACCESS EXCLUSIVE lock.
 */
const WAIT_WITHOUT_BLOCKING = [
  ...CONCURRENT,
  new RegExp(
    String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${NAME}(?: \. ${NAME})* VALIDATE CONSTRAINT ${NAME}$`,
  ),
];

/** The tokens of a statement; quoted identifiers become a bare `"`, so no name reads as a keyword. */
const tokens = (code: string): string =>
  (code.match(/"(?:[^"]|"")*"|[A-Za-z_][\w$]*|[().,]/g) ?? [])
    .map((token) => (token.startsWith('"') ? '"' : token.toUpperCase()))
    .join(" ");

/**
 * A statement PostgreSQL refuses inside a transaction block. The keyword has
 * to stand where the grammar puts it: a column, table or index may be called
 * `concurrently`, and REFRESH MATERIALIZED VIEW CONCURRENTLY runs in a
 * transaction. `code` is a statement without comments and string literals.
 */
const nontransactional = (code: string): boolean => {
  const text = tokens(code);

  return NONTRANSACTIONAL.some((pattern) => pattern.test(text));
};

/**
 * Whether a statement of a `transaction: "none"` migration may wait for locks
 * without a timeout: its waits block nobody (see WAIT_WITHOUT_BLOCKING), and
 * the default lock timeout would cancel a CREATE INDEX CONCURRENTLY whenever
 * any transaction in the database runs longer, leaving an invalid index.
 */
export const waitsWithoutBlocking = (code: string): boolean => {
  const text = tokens(code);

  return WAIT_WITHOUT_BLOCKING.some((pattern) => pattern.test(text));
};

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
      parsed.some(({ code }) => nontransactional(code))
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

/**
 * Adds a line to the message of a migration error: what went wrong after it,
 * such as cleanup on a session that was lost with the statement. The error
 * stays the one the caller gets, its SQL last. Other errors (a connection
 * lost before any statement, an abort reason the caller passed) are left as
 * they are.
 */
export const addErrorNote = (error: unknown, note: string): void => {
  if (!(error instanceof MigrationExecutionError)) {
    return;
  }

  const tail = `\n\nSQL:\n${error.sql}`;
  error.message = error.message.endsWith(tail)
    ? `${error.message.slice(0, -tail.length)}\n${note}${tail}`
    : `${error.message}\n${note}`;
};

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  /** Runs before each statement, such as to set the session's lock timeout for it. */
  prepare?: (statement: ParsedStatement) => Promise<void>,
): Promise<void> => {
  for (const [position, statement] of parseMigrationSQL(
    migration[direction],
  ).entries()) {
    const { sql } = statement;
    const event = {
      migration: migration.id,
      direction,
      statement: position + 1,
      sql,
    };
    const started = performance.now();
    options.onEvent?.({ ...event, type: "statement-start" });

    try {
      await prepare?.(statement);
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
  readonly pooled?: true;
  /** The driver has sessions, but the pooling check could not tell whether they pin a server: why, and what to do. */
  readonly unchecked?: string;
};

/**
 * The statement timeout when none is configured. It guards transactions, which
 * hold their locks until they end; the runner lifts it for the statements of a
 * `transaction: "none"` migration.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 600000;

/**
 * The lock timeout when none is configured. The runner lifts it for the
 * statements of a `transaction: "none"` migration whose waits block nobody
 * (see `waitsWithoutBlocking`).
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

const LOCK_SETTINGS =
  "SELECT set_config('lock_timeout', $1, $4), set_config('statement_timeout', $2, $4), set_config('standard_conforming_strings', $3, $4)";

/**
 * How long the pooling check waits for a second pool connection to answer. A
 * new connection to a distant server can take seconds to open (TLS and a
 * password exchange over a long round trip); the wait ends at once when the
 * connection is open, and a pool with no free connection refuses at once.
 */
const POOLING_PROBE_TIMEOUT_MS = 10000;

const POOLED = Symbol("symmetria.pooled");

/** What the pooling check found: the session's pinned server process, or why there is none. */
type PoolingCheck =
  | { readonly pid: number }
  | { readonly pooled: true }
  | { readonly unchecked: string };

/**
 * The session other than the caller's that holds the migration lock, if any:
 * a migrate, rollback, adopt or repair running in another process, or the
 * server process of one whose client went away while PostgreSQL still runs
 * its statement. `state` and `seconds` (in that state) are visible to the
 * same role, superusers and pg_read_all_stats only.
 */
export const migrationLockHolder = async (
  execute: QueryExecutor,
  lock: string,
): Promise<
  { pid: number | undefined; state?: string; seconds?: number } | undefined
> => {
  const [row] = (
    await executeSQL(
      execute,
      "SELECT holder.pid, activity.state, floor(extract(epoch FROM clock_timestamp() - activity.state_change))::integer AS seconds FROM pg_locks holder LEFT JOIN pg_stat_activity activity ON activity.pid = holder.pid WHERE holder.locktype = 'advisory' AND holder.granted AND holder.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND holder.classid = 1937339476::oid AND holder.objid = hashtext($1)::oid AND holder.objsubid = 2 AND holder.pid IS DISTINCT FROM pg_backend_pid() LIMIT 1",
      [lock],
    )
  ).rows;

  if (!row) {
    return undefined;
  }

  return {
    pid: row.pid === null ? undefined : Number(row.pid),
    ...(typeof row.state === "string" ? { state: row.state } : {}),
    ...(row.seconds === null ? {} : { seconds: Number(row.seconds) }),
  };
};

const backendPid = async (
  execute: QueryExecutor,
  signal?: AbortSignal,
): Promise<number> =>
  Number(
    (await executeSQL(execute, "SELECT pg_backend_pid() AS pid", [], signal))
      .rows[0]!.pid,
  );

/**
 * The server process a session runs on, or what kept the check from finding
 * one. A connection that pools transactions (PgBouncer with
 * pool_mode=transaction, for example) moves one client connection's
 * statements between server processes and lets two client connections share
 * one, so a session lock or setting protects nothing. A direct or
 * session-pooled connection never does either. The second client connection
 * comes from the driver's pool. A pool with no free connection (`max: 1`)
 * cannot answer, nor can one whose new connection does not open in time, and
 * a session alone cannot tell: a pooler hands a lone client the same server
 * every time. Such a session counts as unchecked, so the lock is taken per
 * transaction, which is safe either way.
 */
const pinnedBackend = async (
  driver: Driver,
  session: SessionDriver,
  signal?: AbortSignal,
): Promise<PoolingCheck> => {
  const first = await backendPid(session.execute, signal);
  let latest = first;

  // Other clients of a busy pooler can take the free server between two
  // statements and hide it once; three rounds make that unlikely.
  for (let round = 0; round < 3; round++) {
    const timer = new AbortController();
    const other = await Promise.race([
      backendPid(driver.execute).then(
        (pid) => ({ pid }),
        (error: unknown) => ({ error }),
      ),
      delay(POOLING_PROBE_TIMEOUT_MS, undefined, {
        signal: signal ? AbortSignal.any([timer.signal, signal]) : timer.signal,
      }).then(
        () => ({ late: true }),
        () => ({ late: true }),
      ),
    ]);
    timer.abort();
    signal?.throwIfAborted();
    const next = await backendPid(session.execute, signal);

    if (
      next !== first ||
      ("pid" in other && (other.pid === latest || other.pid === next))
    ) {
      return { pooled: true };
    }

    if ("error" in other) {
      return {
        unchecked: `the pool gave it no connection: its pool has a single connection, or other work holds the others ("${reason(other.error).replace(/^symmetria: /, "")}"). Give the driver a connection to spare for the check (at least max: 2)`,
      };
    }

    if ("late" in other) {
      return {
        unchecked: `it did not answer within ${POOLING_PROBE_TIMEOUT_MS}ms: opening a connection to the database takes longer than that, or other work holds every connection of the pool. Retry when connections open faster, or with one to spare for the check (raise max)`,
      };
    }

    latest = next;
  }

  return { pid: first };
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
 * transaction boundaries. A session driver whose connection pools
 * transactions, or whose pooling check cannot tell, works like a
 * transaction-only driver, since its sessions may not hold a lock.
 */
export const withMigrationConnection = async <Result>(
  driver: Driver,
  lock: string,
  options: ExecutionOptions,
  callback: (connection: MigrationConnection) => Promise<Result>,
): Promise<Result> => {
  const advisory = options.advisoryLockTimeoutMs ?? 10000;
  const ddl = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const statement = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

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
        // Who holds it tells a running migration from a client that went
        // away while its server process still runs a statement.
        const holder = await migrationLockHolder(execute, lock).catch(
          () => undefined,
        );
        const process =
          holder?.pid === undefined
            ? undefined
            : `PostgreSQL process ${holder.pid}${holder.state ? ` (${holder.state}${holder.seconds === undefined ? "" : ` for ${holder.seconds}s`})` : ""}`;

        throw new Error(
          `symmetria: migration advisory lock timeout after ${advisory}ms${
            process
              ? `: ${process} holds the migration lock. A migrate, rollback, adopt or repair is running there, or its client went away while PostgreSQL still runs its statement; wait for it to finish (status shows a migration it runs as running), or, if nothing should be running, end that process with pg_terminate_backend(${holder!.pid})`
              : ""
          }`,
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

  let unpinned: Exclude<PoolingCheck, { pid: number }> | undefined;

  if (driver.session) {
    const outcome = await driver.session<Result | typeof POOLED>(
      async (pinned) => {
        // The statements under way on the session. An abort (Ctrl-C) cancels
        // only while one runs: between them, as after the session was lost
        // with its statement, there is nothing to cancel, and the
        // cancellation's new connection would hold the session open for as
        // long as a server that does not answer keeps it waiting.
        let running = 0;
        const busy = <Value>(work: Promise<Value>): Promise<Value> => {
          running += 1;

          return work.finally(() => {
            running -= 1;
          });
        };
        const session: SessionDriver = {
          ...pinned,
          execute: (query) => busy(pinned.execute(query)),
          transaction: (work, settings) =>
            busy(pinned.transaction(work, settings)),
        };

        options.signal?.throwIfAborted();
        const check = await pinnedBackend(driver, session, options.signal);

        if (!("pid" in check)) {
          unpinned = check;

          return POOLED;
        }

        const { pid } = check;

        let cancellation: Promise<void> | undefined;

        const abort = () => {
          if (running > 0) {
            cancellation = session.cancel?.();
            void cancellation?.catch(() => {});
          }
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

        // The failure the callback ends with, if any: cleanup that fails
        // after it, as on a session lost with the statement, must not
        // replace the error that names the migration and statement.
        let failure: { error: unknown } | undefined;

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
        } catch (error) {
          failure = { error };
          throw error;
        } finally {
          options.signal?.removeEventListener("abort", abort);
          await cancellation?.catch(() => {});
          const restore = async () => {
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
          };
          // A cancellation can arrive after PostgreSQL acquires the lock but
          // before its result reaches us. Release even when acquisition is uncertain.
          const unlock = async () => {
            if (lockAttempted) {
              await release();
            }
          };

          if (failure) {
            const failed: { step: string; error: unknown }[] = [];
            const attempt = (step: string, cleanup: () => Promise<void>) =>
              cleanup().catch((error: unknown) => {
                failed.push({ step, error });
              });

            await attempt("restoring the session settings", restore);
            const settingsFailed = failed.length;
            await attempt("releasing the migration lock", unlock);

            if (failed.length) {
              const reasons = new Set(failed.map(({ error }) => reason(error)));

              addErrorNote(
                failure.error,
                `Afterwards, ${failed.map(({ step }) => step).join(" and ")} failed too: ${[...reasons].join("; ")}${failed.length > settingsFailed ? ". PostgreSQL releases the session's lock when the session ends" : ""}.`,
              );
            }
          } else {
            try {
              await restore();
            } finally {
              await unlock();
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
    ...(driver.session ? (unpinned ?? { pooled: true }) : {}),
  });
};
