/**
 * Shared pool contract for the Bun and pg adapters plus the driver factory that wires sessions and transactions.
 */
import {
  CONNECTION_CLAIM,
  type CompiledQuery,
  type Driver,
  type ExecutionResult,
  type SessionDriver,
  type StreamClaim,
  type TransactionDriver,
  type TransactionOptions,
} from "../query/plan/types";
import { transactionOptionsSQL, runTransaction } from "./transactions";
import { runPostgresSession } from "./session";
import { createPendingTasks } from "./pending";
import { AsyncLocalStorage } from "node:async_hooks";
import { holders, type Holder } from "./serial";
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

/**
 * How long a request from code that started the streams holding every
 * connection waits for one of them to be read on before it is refused.
 */
const STARTED_GRACE_MS = 1000;

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
  // The streams that hold one of the pool's connections, and how to end
  // each: between two rows a stream waits for its reader, which may never
  // ask again, so close() ends them instead of waiting for their loops.
  const streams = new Map<Holder, () => Promise<void>>();

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
  // The list is shared by every pool; each counts its own holders.
  const holding = async <Argument, Result>(
    run: (callback: (driver: Argument) => Promise<Result>) => Promise<Result>,
    callback: (driver: Argument) => Promise<Result>,
  ): Promise<Result> => {
    const holder: Holder = { pool, open: true };
    // Only open holders are carried on: a job loop whose rounds each start
    // inside the last one's transaction would otherwise grow the list forever.
    const inside = [
      ...(holders.getStore() ?? []).filter((outer) => outer.open),
      holder,
    ];

    try {
      return await run((driver) =>
        holders.run(inside, async () => {
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
  const refusal = (own: readonly Holder[]): Error => {
    const streams = own.filter((holder) => holder.stream).length;
    const within =
      streams === 0
        ? pool.max === 1
          ? "a transaction that holds the only one"
          : `transactions that hold all ${pool.max} of them`
        : streams === own.length
          ? pool.max === 1
            ? "a stream() loop that holds the only one"
            : `stream() loops that hold all ${pool.max} of them`
          : `transactions and stream() loops that hold all ${pool.max} of them`;
    const instead =
      streams === 0
        ? "run it on the transaction's own database (the callback's argument)"
        : streams === own.length
          ? "run it after the loop"
          : "run it on the transaction's own database (the callback's argument) or after the loop";

    return new Error(
      `symmetria: this query asks the pool for a connection from inside ${within}, and would wait forever; ${instead} or raise max`,
    );
  };
  // Requests held back by `gate()`: each checks again when a stream gives
  // its connection back.
  const gated = new Set<() => void>();
  const ownHolders = (list: readonly Holder[]): Holder[] =>
    list.filter((holder) => holder.open && holder.pool === pool);
  /** The connections the holders stand for: a stream may be listed twice. */
  const connections = (own: readonly Holder[]): number =>
    new Set(own.map((holder) => holder.started ?? holder)).size;
  /**
   * A request from code that started streams which hold every connection,
   * where nothing tells whether that code reads them: a `for await` loop's
   * body is known (`enter`), but rows read through `ReadableStream.from()`,
   * `Readable.from()`, a generator that maps them, or by hand, are read
   * elsewhere. If it reads them, the request would wait forever; if not
   * (a loop in an async helper, called without `await`), it waits its turn.
   * It is sent once one of the streams gives its connection back, and
   * refused once all of them have waited for their readers, with no row
   * asked for, for `STARTED_GRACE_MS`; a stream that fetches is being read.
   */
  const gate = <Value>(
    operation: () => Promise<Value>,
    list: readonly Holder[],
  ): Promise<Value> => {
    const resume = AsyncLocalStorage.snapshot();
    const progress = () =>
      ownHolders(list).reduce(
        (total, holder) =>
          total + ((holder.started ?? holder).progress?.() ?? 0),
        0,
      );

    return new Promise<Value>((resolve, reject) => {
      let seen = progress();
      let since = performance.now();
      const stop = () => {
        clearInterval(timer);
        gated.delete(check);
      };
      const check = () => {
        const own = ownHolders(list);

        if (closing || connections(own) < pool.max) {
          stop();
          resolve(resume(() => track(operation)));

          return;
        }

        const current = progress();

        // A stream that fetches, or hands out a row its reader asked for,
        // is being read; one that waits for its reader may never be.
        if (
          current !== seen ||
          own.some((holder) => (holder.started ?? holder).busy?.())
        ) {
          seen = current;
          since = performance.now();
        } else if (performance.now() - since >= STARTED_GRACE_MS) {
          stop();
          reject(refusal(own));
        }
      };
      const timer = setInterval(check, STARTED_GRACE_MS / 4);

      gated.add(check);
    });
  };
  const free = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const list = holders.getStore();

    if (!list?.length) {
      return track(operation);
    }

    const own = ownHolders(list);
    // Transactions, sessions and the loops this code is the body of.
    const firm = own.filter((holder) => !holder.started);

    if (firm.length >= pool.max) {
      return Promise.reject(refusal(firm));
    }

    return connections(own) >= pool.max
      ? gate(operation, list)
      : track(operation);
  };

  const driver: PostgresDriver = {
    // Called where the stream's iterator is made. The holder enters the
    // context of the code that reads the rows, which a loop body continues
    // (see stream() in query/select/query.ts); the code that made the iterator,
    // which may or may not read it, gets a `started` entry.
    [CONNECTION_CLAIM]: () => {
      const holder: Holder & StreamClaim = {
        pool,
        open: false,
        stream: true,
        enter: () => {
          const current = holders.getStore() ?? [];

          if (!current.includes(holder)) {
            holders.enterWith([
              ...current.filter((outer) => outer.open),
              holder,
            ]);
          }
        },
        entered: () => holders.getStore()?.includes(holder) ?? false,
        // Each operation holds or waits for one connection; one held back
        // by gate() waits too.
        contended: () => pending.size() + gated.size > pool.max,
        hold: (end, progress, busy) => {
          holder.open = true;
          holder.progress = progress;
          holder.busy = busy;
          streams.set(holder, end);

          // Accepted before close() and given its connection after: it
          // ends at once.
          if (closing) {
            void end();
          }
        },
        release: () => {
          if (!holder.open) {
            return;
          }

          holder.open = false;
          streams.delete(holder);

          for (const check of [...gated]) {
            check();
          }
        },
      };
      const started: Holder = {
        pool,
        stream: true,
        started: holder,
        get open() {
          return holder.open;
        },
      };

      holders.enterWith([
        ...(holders.getStore() ?? []).filter((outer) => outer.open),
        started,
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
    // New work is refused from here on; open streams end their transactions,
    // then accepted work drains.
    close: () =>
      (closing ??= Promise.allSettled([...streams.values()].map((end) => end()))
        .then(() => pending.settle())
        .then(() => pool.close())),
  };

  return Object.freeze(
    profiler ? (profiler.driver(driver) as PostgresDriver) : driver,
  );
};
