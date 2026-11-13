/**
 * Transaction lifecycle shared by both adapters: BEGIN options, savepoints, scope poisoning after a
 * failed statement, one operation at a time per connection and nested-scope serialisation.
 */
import {
  IsolationLevel,
  type CompiledQuery,
  type ExecutionResult,
  type TransactionDriver,
  type TransactionOptions,
} from "../query/plan/types";
import type { PostgresConnection } from "./pool";
import { scopeViolation } from "./errors";
import { createPendingTasks } from "./pending";
import {
  callerInside,
  createSerialQueue,
  nestedFrame,
  runInFrame,
  type NestedFrame,
} from "./serial";

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

/** The cursor of a `stream()` (see streamRows in query/select/query.ts). */
const STREAM_CURSOR = /^(DECLARE|CLOSE) ("__symmetria_stream_\d+")/;

/** What an operation still waiting to start returns once the scope has closed. */
const ABANDONED = Symbol("symmetria.abandoned");

/**
 * Shared transaction lifecycle: operations run one at a time in call order,
 * closed contexts reject late queries, a failed statement poisons the scope,
 * and a nested savepoint holds the connection until it ends; parent operations
 * issued meanwhile wait for it. An operation still pending when the callback
 * returns rejects, since the transaction then rolls back.
 */
const transactionScope = async <Connection, Result>(
  connection: Connection,
  statements: TransactionStatements<Connection>,
  callback: (driver: TransactionDriver) => Promise<Result>,
): Promise<Result> => {
  const pending = createPendingTasks();
  const queue = createSerialQueue();
  // Cursors of streams that have not finished: open work like a pending query.
  const cursors = new Set<string>();

  let closed = false;
  let unsettled = 0;
  let nested: NestedFrame | undefined;
  let failure: { error: unknown } | undefined;

  const assertAvailable = (): void => {
    if (closed) {
      throw new Error("symmetria: transaction context is closed");
    }

    // Queued behind the nested transaction, a call from inside its own
    // callback would wait for itself.
    if (nested && callerInside(nested)) {
      throw new Error(
        "symmetria: await the nested transaction before using its parent context",
      );
    }

    if (failure) {
      throw failure.error;
    }
  };

  // A failed statement poisons the scope; savepoints report through their own scope.
  const schedule = <Value>(
    operation: () => Promise<Value>,
    statement: boolean,
  ): Promise<Value> => {
    unsettled += 1;

    return pending.track(
      queue
        .run(async (): Promise<Value | typeof ABANDONED> => {
          if (closed) {
            return ABANDONED;
          }

          if (failure) {
            throw failure.error;
          }

          return operation();
        })
        .then(
          (value) => {
            unsettled -= 1;

            if (closed) {
              throw new Error(
                "symmetria: the transaction ended before this operation was awaited; it was rolled back",
              );
            }

            return value as Value;
          },
          (error: unknown) => {
            unsettled -= 1;

            if (!statement) {
              throw error;
            }

            // Later operations report a failed $scope() write check as such too.
            const reported = scopeViolation(error);
            failure ??= { error: reported };

            throw reported;
          },
        ),
    );
  };

  const driver: TransactionDriver = Object.freeze({
    execute: (query) => {
      assertAvailable();
      const cursor = STREAM_CURSOR.exec(query.sql);

      return schedule(async () => {
        if (cursor?.[1] === "CLOSE") {
          cursors.delete(cursor[2]!);
        }

        const result = await statements.execute(connection, query);

        if (cursor?.[1] === "DECLARE") {
          cursors.add(cursor[2]!);
        }

        return result;
      }, true);
    },
    transaction: async <Value>(
      callback: (driver: TransactionDriver) => Promise<Value>,
    ): Promise<Value> => {
      assertAvailable();
      const frame = nestedFrame();

      return schedule(async () => {
        nested = frame;

        try {
          return await runInFrame(frame, () =>
            statements.savepoint(connection, (reserved) =>
              transactionScope(reserved, statements, callback),
            ),
          );
        } finally {
          nested = undefined;
        }
      }, false);
    },
  });

  try {
    const result = await callback(driver);
    closed = true;
    const unfinished = unsettled > 0;
    const streaming = cursors.size > 0;

    await pending.settle();

    if (failure) {
      throw failure.error;
    }

    if (unfinished) {
      throw new Error(
        "symmetria: await all transaction operations before returning from the callback",
      );
    }

    if (streaming) {
      throw new Error(
        "symmetria: finish or break out of every stream() before returning from the transaction callback",
      );
    }

    return result;
  } finally {
    closed = true;
    await pending.settle();
  }
};
