/**
 * Runs a callback on one pinned connection (a $scope session) and closes it afterwards.
 */
import type {
  SessionDriver,
  TransactionOptions,
  TransactionDriver,
} from "../query/plan/types";
import type { PostgresPool } from "./pool";
import { runTransaction } from "./transactions";
import { createPendingTasks } from "./pending";
import {
  callerInside,
  createSerialQueue,
  nestedFrame,
  runInFrame,
  type NestedFrame,
} from "./serial";

export const runPostgresSession = async <Result>(
  pool: PostgresPool,
  callback: (session: SessionDriver) => Promise<Result>,
): Promise<Result> => {
  const connection = await pool.connect();
  let pid: number;

  try {
    pid = (
      await connection.execute({
        sql: "SELECT pg_backend_pid() AS pid",
        parameters: [],
      })
    ).rows[0]!.pid as number;
  } catch (error) {
    await connection.discard();
    throw error;
  }

  const cancellations = createPendingTasks();
  const pending = createPendingTasks();
  // Statements run one at a time in call order; a session transaction holds
  // the connection until it ends, and session statements issued meanwhile wait.
  const queue = createSerialQueue();
  let active = true;
  let transaction: NestedFrame | undefined;

  const available = () => {
    if (!active) {
      throw new Error("symmetria: session context is closed");
    }

    // Queued behind the transaction, a call from inside its callback would wait for itself.
    if (transaction && callerInside(transaction)) {
      throw new Error(
        "symmetria: await the session transaction before using its parent context",
      );
    }
  };

  const session: SessionDriver = Object.freeze({
    cancel: () => {
      if (!active) {
        throw new Error("symmetria: session context is closed");
      }

      return cancellations.track(pool.cancel(pid));
    },
    execute: (query) => {
      available();

      return pending.track(queue.run(() => connection.execute(query)));
    },
    transaction: async <Value>(
      operation: (driver: TransactionDriver) => Promise<Value>,
      options?: TransactionOptions,
    ) => {
      available();
      const frame = nestedFrame();

      return pending.track(
        queue.run(async () => {
          transaction = frame;

          try {
            return await runInFrame(frame, () =>
              runTransaction(
                connection,
                async (driver) => {
                  try {
                    const result = await operation(driver);
                    await cancellations.settle();

                    if (!active) {
                      throw new Error(
                        "symmetria: await the session transaction before returning from the callback",
                      );
                    }

                    return result;
                  } finally {
                    await cancellations.settle();
                  }
                },
                options,
              ),
            );
          } finally {
            transaction = undefined;
          }
        }),
      );
    },
  });

  try {
    const result = await callback(session);

    if (pending.size()) {
      throw new Error(
        "symmetria: await all session operations before returning from the callback",
      );
    }

    return result;
  } finally {
    active = false;
    await pending.settle();
    await cancellations.settle();
    // Settings, advisory locks, temporary tables and a transaction left open
    // belong to the connection: it is closed rather than returned to the pool.
    await connection.discard();
  }
};
