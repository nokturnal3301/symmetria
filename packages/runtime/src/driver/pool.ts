/**
 * Shared pool contract for the Bun and pg adapters plus the driver factory that wires sessions and transactions.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CONNECTION_CLAIM,
  type CompiledQuery,
  type Driver,
  type ExecutionResult,
  type SessionDriver,
  type TransactionDriver,
  type TransactionOptions,
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
  type Holder = { open: boolean; stream?: true };
  const held = new AsyncLocalStorage<readonly Holder[]>();
  const holding = async <Argument, Result>(
    run: (callback: (driver: Argument) => Promise<Result>) => Promise<Result>,
    callback: (driver: Argument) => Promise<Result>,
  ): Promise<Result> => {
    const holder: Holder = { open: true };
    // Only open holders are carried on: a job loop whose rounds each start
    // inside the last one's transaction would otherwise grow the list forever.
    const holders = [
      ...(held.getStore() ?? []).filter((outer) => outer.open),
      holder,
    ];

    try {
      return await run((driver) =>
        held.run(holders, async () => {
          try {
            return await callback(driver);
          } finally {
            // Once the callback has returned, work it scheduled waits at most
            // for COMMIT, which frees the connection: nothing waits forever.
            holder.open = false;
          }
        }),
      );
    } finally {
      holder.open = false;
    }
  };
  const refusal = (holders: readonly Holder[]): Error => {
    const streams = holders.filter((holder) => holder.stream).length;
    const within =
      streams === 0
        ? pool.max === 1
          ? "a transaction that holds the only one"
          : `transactions that hold all ${pool.max} of them`
        : streams === holders.length
          ? pool.max === 1
            ? "a stream() loop that holds the only one"
            : `stream() loops that hold all ${pool.max} of them`
          : `transactions and stream() loops that hold all ${pool.max} of them`;
    const instead =
      streams === 0
        ? "run it on the transaction's own database (the callback's argument)"
        : streams === holders.length
          ? "run it after the loop"
          : "run it on the transaction's own database (the callback's argument) or after the loop";

    return new Error(
      `symmetria: this query asks the pool for a connection from inside ${within}, and would wait forever; ${instead} or raise max`,
    );
  };
  const free = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const holders = (held.getStore() ?? []).filter((holder) => holder.open);

    return holders.length >= pool.max
      ? Promise.reject(refusal(holders))
      : track(operation);
  };

  const driver: PostgresDriver = {
    // The holder enters the caller's context, which the loop body continues.
    [CONNECTION_CLAIM]: () => {
      const holder: Holder = { open: false, stream: true };

      held.enterWith([
        ...(held.getStore() ?? []).filter((outer) => outer.open),
        holder,
      ]);

      return holder;
    },
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
