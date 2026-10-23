import type { SQL } from "bun";
import type {
  SessionDriver,
  TransactionOptions,
  TransactionDriver,
} from "../query/state";
import {
  executePostgres,
  transactionOptionsSQL,
  transactionScope,
  type TransactionStatements,
} from "./transactions";

export const runPostgresSession = async <Result>(
  client: SQL,
  callback: (session: SessionDriver) => Promise<Result>,
  cancelBackend: (pid: number) => Promise<void>,
): Promise<Result> => {
  const connection = await client.reserve();
  let pid: number;

  try {
    pid = (
      await connection.unsafe<{ pid: number }[]>(
        "SELECT pg_backend_pid() AS pid",
      )
    )[0]!.pid;
  } catch (error) {
    connection.release();
    throw error;
  }

  const cancellations = new Set<Promise<void>>();
  let nextSavepoint = 0;
  const statements: TransactionStatements<SQL> = {
    execute: executePostgres,
    savepoint: async (connection, callback) => {
      const name = `symmetria_session_${++nextSavepoint}`;
      await connection.unsafe(`SAVEPOINT ${name}`);

      try {
        const result = await callback(connection);
        await connection.unsafe(`RELEASE SAVEPOINT ${name}`);

        return result;
      } catch (error) {
        await connection.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
        await connection.unsafe(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
  let active = true;
  let transaction = false;
  const pending = new Set<Promise<unknown>>();

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

  const track = <Value>(task: Promise<Value>): Promise<Value> => {
    const tracked = task.finally(() => {
      pending.delete(tracked);
    });
    pending.add(tracked);
    void tracked.catch(() => {});

    return tracked;
  };

  const session: SessionDriver = Object.freeze({
    cancel: () => {
      if (!active) {
        throw new Error("symmetria: session context is closed");
      }

      const task = cancelBackend(pid).finally(() => {
        cancellations.delete(task);
      });
      cancellations.add(task);
      void task.catch(() => {});

      return task;
    },
    execute: (query) => {
      available();

      return track(executePostgres(connection, query));
    },
    transaction: async <Value>(
      operation: (driver: TransactionDriver) => Promise<Value>,
      options?: TransactionOptions,
    ) => {
      available();

      if (pending.size) {
        throw new Error(
          "symmetria: await pending queries before starting a session transaction",
        );
      }

      transaction = true;

      try {
        return await track(
          (async () => {
            await connection.unsafe(`BEGIN ${transactionOptionsSQL(options)}`);

            try {
              const result = await transactionScope(
                connection as SQL,
                statements,
                operation,
              );
              await Promise.allSettled([...cancellations]);

              if (!active) {
                throw new Error(
                  "symmetria: await the session transaction before returning from the callback",
                );
              }

              await connection.unsafe("COMMIT");

              return result;
            } catch (error) {
              await Promise.allSettled([...cancellations]);
              await connection.unsafe("ROLLBACK");
              throw error;
            }
          })(),
        );
      } finally {
        transaction = false;
      }
    },
  });

  try {
    const result = await callback(session);

    if (pending.size) {
      throw new Error(
        "symmetria: await all session operations before returning from the callback",
      );
    }

    return result;
  } finally {
    active = false;
    await Promise.allSettled([...pending]);
    await Promise.allSettled([...cancellations]);
    connection.release();
  }
};
