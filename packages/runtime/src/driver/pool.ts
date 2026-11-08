/**
 * Shared pool contract for the Bun and pg adapters plus the driver factory that wires sessions and transactions.
 */
import type {
  CompiledQuery,
  Driver,
  ExecutionResult,
  SessionDriver,
  TransactionDriver,
  TransactionOptions,
} from "../query/plan/types";
import { transactionOptionsSQL, runTransaction } from "./transactions";
import { runPostgresSession } from "./session";
import { createPendingTasks } from "./pending";
import type { QueryProfiler } from "../observability/profiling";

export type PostgresConnection = {
  readonly execute: (query: CompiledQuery) => Promise<ExecutionResult>;
  readonly release: (error?: Error) => void;
};

export type PostgresPool = {
  readonly execute: PostgresConnection["execute"];
  readonly connect: () => Promise<PostgresConnection>;
  readonly cancel: (pid: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type PostgresDriver = Driver & {
  readonly execute: PostgresConnection["execute"];
  readonly transaction: <Result>(
    callback: (driver: TransactionDriver) => Promise<Result>,
    options?: TransactionOptions,
  ) => Promise<Result>;
  readonly session: <Result>(
    callback: (driver: SessionDriver) => Promise<Result>,
  ) => Promise<Result>;
};

/** SQL compilation and row codecs are shared; adapters own only the transport. */
export const createPostgresDriver = (
  pool: PostgresPool,
  profiler?: QueryProfiler,
): PostgresDriver => {
  const pending = createPendingTasks();
  let closing: Promise<void> | undefined;

  const track = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    if (closing) {
      return Promise.reject(new Error("symmetria: driver is closed"));
    }

    return pending.track(operation());
  };

  const driver: PostgresDriver = {
    execute: (query) => track(() => pool.execute(query)),
    transaction: (callback, options) =>
      track(async () => {
        transactionOptionsSQL(options);
        const connection = await pool.connect();

        try {
          return await runTransaction(connection, callback, options);
        } finally {
          connection.release();
        }
      }),
    session: (callback) => track(() => runPostgresSession(pool, callback)),
    close: () => (closing ??= pending.settle().then(() => pool.close())),
  };

  return Object.freeze(
    profiler ? (profiler.driver(driver) as PostgresDriver) : driver,
  );
};
