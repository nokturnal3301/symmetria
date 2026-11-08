/**
 * Runs a callback on one pinned connection (a $scope session) and releases it afterwards.
 */
import type {
  SessionDriver,
  TransactionOptions,
  TransactionDriver,
} from "../query/plan/types";
import type { PostgresPool } from "./pool";
import { runTransaction } from "./transactions";
import { createPendingTasks } from "./pending";

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
    connection.release();
    throw error;
  }

  const cancellations = createPendingTasks();
  const pending = createPendingTasks();
  let active = true;
  let transaction = false;

  const available = () => {
    if (!active) {
      throw new Error("symmetria: session context is closed");
    }

    if (transaction) {
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

      return pending.track(connection.execute(query));
    },
    transaction: async <Value>(
      operation: (driver: TransactionDriver) => Promise<Value>,
      options?: TransactionOptions,
    ) => {
      available();

      if (pending.size()) {
        throw new Error(
          "symmetria: await pending queries before starting a session transaction",
        );
      }

      transaction = true;

      try {
        return await pending.track(
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
        transaction = false;
      }
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
    connection.release();
  }
};
