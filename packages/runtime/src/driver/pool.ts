/**
 * Shared pool contract for the Bun and pg adapters plus the driver factory that wires sessions and transactions.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
import { queryError } from "./errors";

export type PostgresConnection = {
  readonly execute: (query: CompiledQuery) => Promise<ExecutionResult>;
  /** Return the connection to the pool; with an error, close it instead. */
  readonly release: (error?: Error) => void;
  /** Close the connection instead of returning it, so none of its session state reaches the pool. */
  readonly discard: () => Promise<void>;
};

export type PostgresPool = {
  readonly execute: PostgresConnection["execute"];
  readonly connect: () => Promise<PostgresConnection>;
  readonly cancel: (pid: number) => Promise<void>;
  readonly close: () => Promise<void>;
  /** How many connections the pool opens at most. */
  readonly max: number;
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

const rethrow = (error: unknown): never => {
  throw queryError(error);
};

/**
 * The pool whose database failures are `QueryError`s. The adapters see their
 * own driver errors first (to discard a broken connection); everything above
 * them, and the application, gets the class.
 */
const classified = (pool: PostgresPool): PostgresPool => ({
  execute: (query) => pool.execute(query).catch(rethrow),
  connect: async () => {
    const connection = await pool.connect().catch(rethrow);

    return {
      ...connection,
      execute: (query) => connection.execute(query).catch(rethrow),
    };
  },
  cancel: (pid) => pool.cancel(pid),
  close: () => pool.close(),
  max: pool.max,
});

/** SQL compilation and row codecs are shared; adapters own only the transport. */
export const createPostgresDriver = (
  adapter: PostgresPool,
  profiler?: QueryProfiler,
): PostgresDriver => {
  const pool = classified(adapter);
  const pending = createPendingTasks();
  let closing: Promise<void> | undefined;

  const track = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    if (closing) {
      return Promise.reject(new Error("symmetria: driver is closed"));
    }

    return pending.track(operation());
  };

  // The transactions and sessions around the running code, each holding one
  // of the pool's connections while it is open. When they hold all of them, a
  // request to the pool from inside would wait for a connection its own caller
  // is holding. Code started inside one and still running after it ended
  // (a timer, a background loop) inherits the list, so only open ones count.
  type Holder = { open: boolean };
  const held = new AsyncLocalStorage<readonly Holder[]>();
  const holding = async <Argument, Result>(
    run: (callback: (driver: Argument) => Promise<Result>) => Promise<Result>,
    callback: (driver: Argument) => Promise<Result>,
  ): Promise<Result> => {
    const holder: Holder = { open: true };
    const holders = [...(held.getStore() ?? []), holder];

    try {
      return await run((driver) => held.run(holders, () => callback(driver)));
    } finally {
      holder.open = false;
    }
  };
  const free = <Value>(operation: () => Promise<Value>): Promise<Value> =>
    (held.getStore() ?? []).filter((holder) => holder.open).length >= pool.max
      ? Promise.reject(
          new Error(
            `symmetria: this query asks the pool for a connection from inside ${pool.max === 1 ? "a transaction that holds the only one" : `transactions that hold all ${pool.max} of them`}, and would wait forever; run it on the transaction's own database (the callback's argument) or raise max`,
          ),
        )
      : track(operation);

  const driver: PostgresDriver = {
    execute: (query) => free(() => pool.execute(query)),
    transaction: (callback, options) =>
      free(async () => {
        transactionOptionsSQL(options);
        const connection = await pool.connect();

        try {
          return await holding(
            (inside) => runTransaction(connection, inside, options),
            callback,
          );
        } finally {
          connection.release();
        }
      }),
    session: (callback) =>
      free(() =>
        holding((inside) => runPostgresSession(pool, inside), callback),
      ),
    close: () => (closing ??= pending.settle().then(() => pool.close())),
  };

  return Object.freeze(
    profiler ? (profiler.driver(driver) as PostgresDriver) : driver,
  );
};
