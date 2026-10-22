import { Database } from "bun:sqlite";
import type {
  CompiledQuery,
  Driver,
  ExecutionResult,
  TransactionDriver,
  TransactionOptions,
} from "../query/state";
import { sqliteDialect } from "../query/dialects/sqlite";
import { quoteIdentifier } from "../query/compiler";
import {
  transactionOptionsSQL,
  transactionScope,
  type TransactionStatements,
} from "./transactions";
import { sqliteSchemaSQL } from "./sqlite-ddl";
import type { SchemaSnapshot } from "../schema/assembly";
import type { QueryProfiler } from "../observability/profiling";

export type SqliteOptions = {
  /** File path or ":memory:" (default). */
  readonly path?: string;
  readonly readonly?: boolean;
  readonly create?: boolean;
  /** PRAGMA foreign_keys, enabled by default. */
  readonly foreignKeys?: boolean;
  readonly profiler?: QueryProfiler;
};

type SnapshotSource =
  | { readonly $snapshot: () => SchemaSnapshot }
  | SchemaSnapshot;

export type SqliteDriver = Driver & {
  readonly dialect: "sqlite";
  /** The underlying bun:sqlite connection. */
  readonly database: Database;
  /** Run the SQLite DDL for a schema or snapshot, for tests and local tooling. */
  readonly createTables: (source: SnapshotSource) => void;
};

/**
 * Zero-dependency embedded driver on bun:sqlite. One connection serves queries
 * and transactions; statements wait for an open transaction to finish.
 */
export const sqlite = (
  connection: string | SqliteOptions = ":memory:",
): SqliteDriver => {
  const {
    profiler,
    path = ":memory:",
    readonly = false,
    create = true,
    foreignKeys = true,
  } = typeof connection === "string" ? { path: connection } : connection;
  const database = new Database(path, { readonly, create, safeIntegers: true });

  if (foreignKeys) {
    database.run("PRAGMA foreign_keys = ON");
  }

  const run = (query: CompiledQuery): ExecutionResult => {
    const statement = database.query(query.sql);
    const parameters = query.parameters.map(
      sqliteDialect.parameterValue,
    ) as never[];

    if (!statement.columnNames.length) {
      statement.run(...parameters);
      // changes() counts the statement's own rows, excluding foreign-key actions.
      const changes = database.query("SELECT changes() AS count").get() as {
        count: number | bigint;
      };

      return { rows: [], affectedRows: Number(changes.count) };
    }

    const rows = statement.all(...parameters) as Record<string, unknown>[];

    return { rows, affectedRows: rows.length };
  };

  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;

  const serialize = <Result>(task: () => Promise<Result>): Promise<Result> => {
    if (closing) {
      return Promise.reject(new Error("symmetria: database is closed"));
    }

    const result = queue.then(task, task);
    queue = result.catch(() => undefined);

    return result;
  };

  let savepoints = 0;
  const statements: TransactionStatements<null> = {
    execute: async (_connection, query) => run(query),
    savepoint: async (_connection, callback) => {
      const name = quoteIdentifier(`__symmetria_savepoint_${savepoints++}`);
      database.run(`SAVEPOINT ${name}`);

      try {
        const value = await callback(null);
        database.run(`RELEASE ${name}`);

        return value;
      } catch (error) {
        database.run(`ROLLBACK TO ${name}`);
        database.run(`RELEASE ${name}`);
        throw error;
      }
    },
  };

  const transaction = <Result>(
    callback: (driver: TransactionDriver) => Promise<Result>,
    options?: TransactionOptions,
  ): Promise<Result> =>
    serialize(async () => {
      // Validates the options; SQLite transactions are always serializable.
      transactionOptionsSQL(options);
      database.run("BEGIN");

      if (options?.readOnly) {
        database.run("PRAGMA query_only = ON");
      }

      try {
        const value = await transactionScope(null, statements, callback);
        database.run("COMMIT");

        return value;
      } catch (error) {
        database.run("ROLLBACK");
        throw error;
      } finally {
        if (options?.readOnly) {
          database.run("PRAGMA query_only = OFF");
        }
      }
    });

  const base: Driver = {
    dialect: "sqlite",
    execute: (query) => serialize(async () => run(query)),
    transaction,
    close: () =>
      (closing ??= queue.then(() => {
        database.close();
      })),
  };

  const createTables = (source: SnapshotSource): void => {
    if (closing) {
      throw new Error("symmetria: database is closed");
    }

    const snapshot = "$snapshot" in source ? source.$snapshot() : source;

    for (const statement of sqliteSchemaSQL(snapshot)) {
      database.run(statement);
    }
  };

  const driver: SqliteDriver = Object.freeze({
    ...(profiler ? profiler.driver(base) : base),
    dialect: "sqlite" as const,
    database,
    createTables,
  });

  return driver;
};
