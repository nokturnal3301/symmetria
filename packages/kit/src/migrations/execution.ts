import { setTimeout as delay } from "node:timers/promises";
import { normalizeResult } from "symmetria/internal";
import type { QueryExecutor } from "symmetria";
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

export const executionPlan = (
  migrations: Migration[],
  direction: "up" | "down",
): ExecutionStep[] => {
  let group = 0;
  let previous = "";

  return migrations.map((migration) => {
    const transaction = migration.manifest.transaction ?? "batch";

    if (transaction !== "batch" || previous !== "batch") {
      group++;
    }

    previous = transaction;
    const statements = splitMigrationSQL(migration[direction]);

    if (
      transaction !== "none" &&
      parseMigrationSQL(migration[direction]).some(
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

export const sqlState = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = error as { code?: unknown; errno?: unknown };

  return [value.code, value.errno].find(
    (code): code is string =>
      typeof code === "string" && /^[0-9A-Z]{5}$/.test(code),
  );
};

export class MigrationExecutionError extends Error {
  readonly migration: string;
  readonly direction: "up" | "down";
  readonly statement: number;
  readonly sql: string;
  readonly sqlState: string | undefined;
  constructor(
    migration: string,
    direction: "up" | "down",
    statement: number,
    sql: string,
    cause: unknown,
  ) {
    const state = sqlState(cause);
    super(
      `symmetria: migration "${migration}" failed (${direction}, statement ${statement}${state ? `, SQLSTATE ${state}` : ""}): ${cause instanceof Error ? cause.message : String(cause)}\n\nSQL:\n${sql}`,
      { cause },
    );
    this.name = "MigrationExecutionError";
    this.migration = migration;
    this.direction = direction;
    this.statement = statement;
    this.sql = sql;
    this.sqlState = state;
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

/** Session locks survive commits; transaction-only drivers retain atomic-batch support. */
export const withMigrationConnection = async <Result>(
  driver: Driver,
  lock: string,
  options: ExecutionOptions,
  callback: (session: SessionDriver, atomic: boolean) => Promise<Result>,
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

  const run = async (session: SessionDriver, atomic: boolean) => {
    options.signal?.throwIfAborted();
    let cancellation: Promise<void> | undefined;

    const abort = () => {
      cancellation = session.cancel?.();
      void cancellation?.catch(() => {});
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    let original: Record<string, unknown> | undefined;
    let lockAttempted = false;

    try {
      original = (
        await executeSQL(
          session.execute,
          "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout, current_setting('standard_conforming_strings') AS strings",
        )
      ).rows[0]!;
      const started = performance.now();

      while (true) {
        options.signal?.throwIfAborted();
        lockAttempted = true;
        const acquired = await executeSQL(
          session.execute,
          `SELECT pg_try_advisory_${atomic ? "xact_" : ""}lock(1937339476, hashtext($1)) AS locked`,
          [lock],
          options.signal,
        );

        if (acquired.rows[0]?.locked) {
          break;
        }

        if (performance.now() - started >= advisory) {
          throw new Error(
            `symmetria: migration advisory lock timeout after ${advisory}ms`,
          );
        }

        await delay(
          Math.min(50, advisory),
          undefined,
          options.signal ? { signal: options.signal } : {},
        );
      }

      await executeSQL(
        session.execute,
        "SELECT set_config('lock_timeout', $1, $4), set_config('statement_timeout', $2, $4), set_config('standard_conforming_strings', $3, $4)",
        [`${ddl}ms`, `${statement}ms`, "on", atomic],
      );

      return await callback(session, atomic);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await cancellation?.catch(() => {});

      if (!atomic) {
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
            await executeSQL(
              session.execute,
              "SELECT pg_advisory_unlock(1937339476, hashtext($1))",
              [lock],
            );
          }
        }
      }
    }
  };

  if (driver.session) {
    return driver.session((session) => run(session, false));
  }

  if (!driver.transaction) {
    throw new Error(
      "symmetria: migrations require a transaction-capable driver",
    );
  }

  return driver.transaction(
    (tx: TransactionDriver) =>
      run(
        { execute: tx.execute, transaction: (callback) => callback(tx) },
        true,
      ),
    { isolationLevel: "read committed" },
  );
};
