/**
 * Transaction lifecycle shared by both adapters: BEGIN options, savepoints, scope poisoning after a
 * failed statement and nested-scope serialisation.
 */
import {
  IsolationLevel,
  type CompiledQuery,
  type ExecutionResult,
  type TransactionDriver,
  type TransactionOptions,
} from "../query/plan/types";
import type { PostgresConnection } from "./pool";
import { createPendingTasks } from "./pending";

const transactionStatements = (): TransactionStatements<PostgresConnection> => {
  let nextSavepoint = 0;

  const execute = (connection: PostgresConnection, sql: string) =>
    connection.execute({ sql, parameters: [] });

  return {
    execute: (connection, query) => connection.execute(query),
    savepoint: async (connection, callback) => {
      const name = `symmetria_savepoint_${++nextSavepoint}`;
      await execute(connection, `SAVEPOINT ${name}`);

      try {
        const result = await callback(connection);
        await execute(connection, `RELEASE SAVEPOINT ${name}`);

        return result;
      } catch (error) {
        try {
          await execute(connection, `ROLLBACK TO SAVEPOINT ${name}`);
          await execute(connection, `RELEASE SAVEPOINT ${name}`);
        } catch (rollbackError) {
          throw Object.assign(
            rollbackError instanceof Error
              ? rollbackError
              : new Error(String(rollbackError)),
            { cause: error },
          );
        }

        throw error;
      }
    },
  };
};

export const runTransaction = async <Result>(
  connection: PostgresConnection,
  callback: (driver: TransactionDriver) => Promise<Result>,
  options?: TransactionOptions,
): Promise<Result> => {
  const settings = transactionOptionsSQL(options);

  await connection.execute({
    sql: `BEGIN${settings ? ` ${settings}` : ""}`,
    parameters: [],
  });

  try {
    const result = await transactionScope(
      connection,
      transactionStatements(),
      callback,
    );
    await connection.execute({ sql: "COMMIT", parameters: [] });

    return result;
  } catch (error) {
    try {
      await connection.execute({ sql: "ROLLBACK", parameters: [] });
    } catch (rollbackError) {
      connection.release(
        rollbackError instanceof Error
          ? rollbackError
          : new Error(String(rollbackError)),
      );
    }

    throw error;
  }
};

export const transactionOptionsSQL = (
  options: TransactionOptions = {},
): string => {
  const fragments: string[] = [];

  if (options.isolationLevel !== undefined) {
    if (
      ![
        IsolationLevel.ReadCommitted,
        IsolationLevel.RepeatableRead,
        IsolationLevel.Serializable,
      ].includes(options.isolationLevel)
    ) {
      throw new Error("symmetria: invalid transaction isolation level");
    }

    fragments.push(`ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`);
  }

  for (const name of ["readOnly", "deferrable"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") {
      throw new Error(`symmetria: ${name} must be a boolean`);
    }
  }

  if (options.readOnly !== undefined) {
    fragments.push(options.readOnly ? "READ ONLY" : "READ WRITE");
  }

  if (
    options.deferrable === true &&
    (options.isolationLevel !== IsolationLevel.Serializable ||
      options.readOnly !== true)
  ) {
    throw new Error("symmetria: DEFERRABLE requires SERIALIZABLE READ ONLY");
  }

  if (options.deferrable !== undefined) {
    fragments.push(options.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE");
  }

  return fragments.join(", ");
};

/** Connection-specific statement execution and savepoint handling for a transaction scope. */
type TransactionStatements<Connection> = {
  readonly execute: (
    connection: Connection,
    query: CompiledQuery,
  ) => Promise<ExecutionResult>;
  readonly savepoint: <Result>(
    connection: Connection,
    callback: (connection: Connection) => Promise<Result>,
  ) => Promise<Result>;
};

/**
 * Shared transaction lifecycle: closed contexts reject late queries, a failed
 * statement poisons the scope, and nested savepoints serialize against their parent.
 */
const transactionScope = async <Connection, Result>(
  connection: Connection,
  statements: TransactionStatements<Connection>,
  callback: (driver: TransactionDriver) => Promise<Result>,
): Promise<Result> => {
  const pending = createPendingTasks();

  let active = true;
  let childActive = false;
  let failure: { error: unknown } | undefined;

  const assertAvailable = (): void => {
    if (!active) {
      throw new Error("symmetria: transaction context is closed");
    }

    if (childActive) {
      throw new Error(
        "symmetria: await the nested transaction before using its parent context",
      );
    }

    if (failure) {
      throw failure.error;
    }
  };

  // A failed statement poisons the scope; savepoints report through their own scope.
  const track = <Value>(
    task: Promise<Value>,
    statement = false,
  ): Promise<Value> =>
    pending.track(
      statement
        ? task.then(undefined, (error: unknown) => {
            failure ??= { error };
            throw error;
          })
        : task,
    );

  const driver: TransactionDriver = Object.freeze({
    execute: (query) => {
      assertAvailable();

      return track(statements.execute(connection, query), true);
    },
    transaction: async <Value>(
      nested: (driver: TransactionDriver) => Promise<Value>,
    ): Promise<Value> => {
      assertAvailable();

      if (pending.size()) {
        throw new Error(
          "symmetria: await pending queries before starting a savepoint",
        );
      }

      childActive = true;

      try {
        return await track(
          statements.savepoint(connection, (reserved) =>
            transactionScope(reserved, statements, nested),
          ),
        );
      } finally {
        childActive = false;
      }
    },
  });

  try {
    const result = await callback(driver);
    const unfinished = pending.size() > 0;
    active = false;

    await pending.settle();

    if (failure) {
      throw failure.error;
    }

    if (unfinished) {
      throw new Error(
        "symmetria: await all transaction operations before returning from the callback",
      );
    }

    return result;
  } finally {
    active = false;
    await pending.settle();
  }
};
