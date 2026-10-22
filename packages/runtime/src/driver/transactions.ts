import type { SQL } from "bun";
import { postgresDialect } from "../query/dialects/postgres";
import {
  IsolationLevel,
  type CompiledQuery,
  type ExecutionResult,
  type TransactionDriver,
  type TransactionOptions,
} from "../query/state";

/** Array parameters travel as PostgreSQL array literals; other values pass through untouched. */
const postgresParameters = (parameters: unknown[]): unknown[] => {
  for (const value of parameters) {
    if (Array.isArray(value)) {
      return parameters.map(postgresDialect.parameterValue);
    }
  }

  return parameters;
};

export const executePostgres = async (
  client: SQL,
  query: CompiledQuery,
): Promise<ExecutionResult> => {
  const result = await client.unsafe<Record<string, unknown>[]>(
    query.sql,
    postgresParameters(query.parameters),
  );

  return {
    // A plain array: Bun's result array carries extra own properties.
    rows: Array.from(result),
    affectedRows: (result as { count?: number }).count ?? result.length,
  };
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
export type TransactionStatements<Connection> = {
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
export const transactionScope = async <Connection, Result>(
  connection: Connection,
  statements: TransactionStatements<Connection>,
  callback: (driver: TransactionDriver) => Promise<Result>,
): Promise<Result> => {
  let active = true;
  let childActive = false;
  let failure: { error: unknown } | undefined;
  const pending = new Set<Promise<unknown>>();

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

  const track = <Value>(
    task: Promise<Value>,
    statement = false,
  ): Promise<Value> => {
    const tracked = task.then(
      (value) => {
        pending.delete(tracked);

        return value;
      },
      (error: unknown) => {
        pending.delete(tracked);

        if (statement && !failure) {
          failure = { error };
        }

        throw error;
      },
    );

    pending.add(tracked);
    void tracked.catch(() => {});

    return tracked;
  };

  const driver: TransactionDriver = Object.freeze({
    execute: (query) => {
      assertAvailable();

      return track(statements.execute(connection, query), true);
    },
    transaction: async <Value>(
      nested: (driver: TransactionDriver) => Promise<Value>,
    ): Promise<Value> => {
      assertAvailable();

      if (pending.size) {
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
    const unfinished = pending.size > 0;
    active = false;

    await Promise.allSettled([...pending]);

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
    await Promise.allSettled([...pending]);
  }
};

const postgresStatements: TransactionStatements<SQL> = {
  execute: executePostgres,
  savepoint: async (connection, callback) => {
    const result = await (connection as import("bun").TransactionSQL).savepoint(
      async (reserved) => ({ value: await callback(reserved) }),
    );

    return result.value;
  },
};

export const runPostgresTransaction = async <Result>(
  client: SQL,
  callback: (driver: TransactionDriver) => Promise<Result>,
  options?: TransactionOptions,
): Promise<Result> => {
  const settings = transactionOptionsSQL(options);

  const run = async (connection: import("bun").TransactionSQL) => ({
    value: await transactionScope(
      connection as SQL,
      postgresStatements,
      callback,
    ),
  });

  const result = settings
    ? await client.begin(settings, run)
    : await client.begin(run);

  return result.value;
};
