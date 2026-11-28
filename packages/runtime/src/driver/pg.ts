/**
 * `symmetria/pg`: PostgreSQL adapter built on node-postgres pools.
 */
import { isDate } from "node:util/types";
import { Pool, types, type PoolConfig, type QueryResult } from "pg";
import type { CompiledQuery, ExecutionResult } from "../query/plan/types";
import type { QueryProfiler } from "../observability/profiling";
import { timestampFromText } from "../query/codecs";
import { postgresParameters } from "./parameters";
import { isConnectionError, sqlState } from "./errors";
import {
  createPostgresDriver,
  type PostgresDriver,
  type PostgresConnection,
} from "./pool";

/**
 * node-postgres pool options (`pg.PoolConfig` without `types`, which the
 * adapter sets), declared here so the published types need no `@types/pg`.
 * Callback options receive node-postgres objects.
 */
export type PostgresOptions = {
  readonly url?: string | undefined;
  readonly profiler?: QueryProfiler | undefined;
  /**
   * Send reads and writes as named prepared statements, which PostgreSQL
   * parses once per connection instead of on every call. Off unless set:
   * a connection pooler in transaction mode needs its own support for them.
   */
  readonly prepare?: boolean | undefined;
  readonly connectionString?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly user?: string | undefined;
  readonly password?: string | (() => string | Promise<string>) | undefined;
  readonly database?: string | undefined;
  /** `true` or Node.js `tls.ConnectionOptions`. */
  readonly ssl?: boolean | object | undefined;
  readonly sslnegotiation?: "postgres" | "direct" | undefined;
  readonly enableChannelBinding?: boolean | undefined;
  readonly max?: number | undefined;
  readonly min?: number | undefined;
  readonly idleTimeoutMillis?: number | null | undefined;
  readonly connectionTimeoutMillis?: number | undefined;
  readonly maxUses?: number | undefined;
  readonly maxLifetimeSeconds?: number | undefined;
  readonly allowExitOnIdle?: boolean | undefined;
  readonly keepAlive?: boolean | undefined;
  readonly keepAliveInitialDelayMillis?: number | undefined;
  readonly statement_timeout?: false | number | undefined;
  readonly query_timeout?: number | undefined;
  readonly lock_timeout?: number | undefined;
  readonly idle_in_transaction_session_timeout?: number | undefined;
  readonly application_name?: string | undefined;
  readonly fallback_application_name?: string | undefined;
  readonly options?: string | undefined;
  readonly client_encoding?: string | undefined;
  readonly pipeline?: boolean | undefined;
  readonly log?: ((...messages: unknown[]) => void) | undefined;
  readonly Promise?: PromiseConstructorLike | undefined;
  /** A socket factory: `() => stream.Duplex`. */
  readonly stream?: (() => unknown) | undefined;
  /** A `pg.Client` subclass. */
  readonly Client?: (new () => object) | undefined;
  /** Receives each new `pg.PoolClient`. */
  readonly onConnect?: ((client: never) => void | Promise<void>) | undefined;
  readonly verify?:
    | ((client: never, done: (error?: Error) => void) => void)
    | undefined;
};
export type { PostgresDriver } from "./pool";

/** `2024-01-31 12:00:00.123` (also BC) as UTC; infinity stays text for the codec to report. */
const utcTimestamp = (value: string): Date | string =>
  timestampFromText(value) ?? value;

// Per-pool parsers preserve integer precision without changing pg's global state.
const parsers: NonNullable<PoolConfig["types"]> = {
  getTypeParser: (oid: number, format) => {
    if (oid === 20 && format !== "binary") {
      return BigInt;
    }

    // timestamp without time zone is UTC, as Bun.SQL reads it.
    if (oid === 1114 && format !== "binary") {
      return utcTimestamp;
    }

    if (oid === 1115 && format !== "binary") {
      const parseArray = types.getTypeParser(
        1009 as Parameters<typeof types.getTypeParser>[0],
        "text",
      ) as (value: string) => (string | null | unknown[])[];

      // An array of more dimensions keeps its nested arrays, which the
      // column's codec refuses by name.
      return (value: string) =>
        parseArray(value).map((entry) =>
          entry === null || Array.isArray(entry) ? entry : utcTimestamp(entry),
        );
    }

    // date and interval stay text so both drivers agree; symmetria's codecs
    // keep `YYYY-MM-DD` and PostgreSQL's interval form.
    if ((oid === 1082 || oid === 1186) && format !== "binary") {
      return (value: string) => value;
    }

    if (
      (oid === 1231 || oid === 1003 || oid === 1182 || oid === 1187) &&
      format !== "binary"
    ) {
      return types.getTypeParser(
        1009 as Parameters<typeof types.getTypeParser>[0],
        "text",
      );
    }

    return types.getTypeParser(
      oid as Parameters<typeof types.getTypeParser>[0],
      format,
    );
  },
};

/** Statements worth preparing: one SELECT or write, not DDL, cursors or transaction control. */
const PREPARABLE = /^(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/;
const PREPARED_LIMIT = 500;

/**
 * A parameter node-postgres sends as JSON text: an object that is not bytes,
 * a Date or an array, and does not convert itself with `toPostgres()`.
 */
const sentAsJson = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !ArrayBuffer.isView(value) &&
  !Array.isArray(value) &&
  !isDate(value) &&
  typeof (value as { toPostgres?: unknown }).toPostgres !== "function";

/**
 * The values of a named statement with their JSON text made here.
 * node-postgres makes that text only while it binds, when the statement is
 * already on its way: a value JSON cannot hold (a BigInt inside, a circular
 * reference, a `toJSON()` that throws) fails there, and node-postgres then
 * closes the statement on the server while it goes on counting the name as
 * prepared. Made here, the same text fails before anything is sent.
 */
const withJsonText = (values: unknown[]): unknown[] =>
  values.some(sentAsJson)
    ? values.map((value) => (sentAsJson(value) ? JSON.stringify(value) : value))
    : values;

/**
 * A failure that leaves the client unusable: the connection was lost or the
 * server ended the session, or node-postgres failed without a SQLSTATE, so not
 * because of a statement. Ordinary SQL errors and Symmetria's own parameter
 * errors keep their healthy connection.
 */
const brokenConnection = (error: unknown): boolean =>
  isConnectionError(error) ||
  (!sqlState(error) &&
    !(error instanceof Error && error.message.startsWith("symmetria:")));

export const postgres = (
  connection: string | PostgresOptions,
): PostgresDriver => {
  const { profiler, url, prepare, ...options } =
    typeof connection === "string" ? { url: connection } : connection;
  const config = {
    ...options,
    ...(url ? { connectionString: url } : {}),
    types: parsers,
  } as PoolConfig;

  const pool = new Pool(config);
  pool.on("error", () => {});
  // The parsers read PostgreSQL's default output forms. A database or role
  // may set others: DateStyle `SQL, DMY` prints 05/03/2024, which would read
  // as the wrong day or not at all; IntervalStyle changes an interval's text;
  // `bytea_output = escape` is not the hex form; `extra_float_digits = 0`
  // prints a double short of its last digits. Every new connection asks for
  // the defaults first. The statement is queued ahead of the first query; it
  // only fails with its connection, which the query behind it then reports.
  pool.on("connect", (client) => {
    client
      .query(
        "SET DateStyle TO ISO; SET IntervalStyle TO postgres; SET bytea_output TO hex; SET extra_float_digits TO 1",
      )
      .catch(() => {});
  });

  let cancellation: Pool | undefined;

  // One name per statement text, shared by the pool's connections; each
  // connection prepares a name the first time it runs it. Texts beyond the
  // limit (IN lists and literal LIMITs of every length) stay unnamed, so a
  // connection never holds more than that many prepared statements.
  const statementNames = new Map<string, string>();
  let statementOrdinal = 0;
  const statementName = (sql: string): string | undefined => {
    if (!prepare || !PREPARABLE.test(sql)) {
      return undefined;
    }

    let name = statementNames.get(sql);

    if (!name && statementNames.size < PREPARED_LIMIT) {
      name = `symmetria_${statementOrdinal++}`;
      statementNames.set(sql, name);
    }

    return name;
  };
  // A column a statement reads changed its type since the connection
  // prepared it. node-postgres would keep sending the stale name on that
  // connection, and every connection that prepared it would fail the same
  // way: the text gets a new name, which each connection prepares afresh.
  // The first connection to fail moves the text on; calls in flight on the
  // others fail with the old name after that, and are stale all the same.
  const staleStatement = (
    error: unknown,
    sql: string,
    name: string,
  ): boolean => {
    if (
      sqlState(error) !== "0A000" ||
      !/cached plan must not change result type/.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      return false;
    }

    if (statementNames.get(sql) === name) {
      statementNames.delete(sql);
    }

    return true;
  };

  const result = (value: QueryResult | QueryResult[]): ExecutionResult => {
    if (Array.isArray(value)) {
      return {
        rows: value.flatMap((entry) => entry.rows),
        affectedRows: value.reduce(
          (count, entry) => count + (entry.rowCount ?? entry.rows.length),
          0,
        ),
      };
    }

    return {
      rows: value.rows,
      affectedRows: value.rowCount ?? value.rows.length,
    };
  };

  const connect = async (): Promise<PostgresConnection> => {
    const client = await pool.connect();
    let released = false;
    let failure: Error | undefined;
    // Set when a named statement failed with something that is not the
    // server's answer: node-postgres gave up on its own (a value it could not
    // convert while binding, a timeout). It may then count a name as prepared
    // that the server no longer holds, and would bind to the missing
    // statement from then on. The connection sends the rest of its statements
    // unnamed and is closed when released.
    let unsynced: Error | undefined;

    // A server that ends the session reports why (57P01, 25P03), and the
    // closed socket follows as "Connection terminated unexpectedly": the
    // first error is the one that says what happened.
    const onError = (error: Error) => {
      failure ??= error;
    };

    client.on("error", onError);

    const release = (error?: Error | true) => {
      if (!released) {
        released = true;
        client.removeListener("error", onError);
        client.release(error ?? failure ?? unsynced);
      }
    };

    /** Rethrows what a named statement failed with; see `unsynced`. */
    const namedFailure = (error: unknown): never => {
      if (!sqlState(error)) {
        unsynced ??= error instanceof Error ? error : new Error(String(error));
      }

      throw error;
    };

    return {
      execute: async (query) => {
        if (failure) {
          throw failure;
        }

        const values = postgresParameters(query.parameters, true);
        // Without values node-postgres uses the simple protocol, which also
        // takes several commands in one text; a prepared statement takes one.
        const name =
          values.length && !unsynced ? statementName(query.sql) : undefined;

        if (!name) {
          return result(await client.query(query.sql, values));
        }

        const bound = withJsonText(values);

        try {
          return result(
            await client.query({ name, text: query.sql, values: bound }),
          );
        } catch (error) {
          if (!staleStatement(error, query.sql, name)) {
            return namedFailure(error);
          }

          // Inside a transaction the error has aborted it: the server
          // refuses this too (25P02), the error stands, and the old statement
          // is freed with the connection.
          const aborted = await client.query(`DEALLOCATE "${name}"`).then(
            () => false,
            (refusal: unknown) => sqlState(refusal) === "25P02",
          );

          if (aborted) {
            throw error;
          }

          // Outside a transaction the failed statement did nothing: it runs
          // once more, under the text's new name.
          const renamed = statementName(query.sql);

          return result(
            await (renamed
              ? client
                  .query({ name: renamed, text: query.sql, values: bound })
                  .catch(namedFailure)
              : client.query(query.sql, bound)),
          );
        }
      },
      release,
      // node-postgres closes a client released with `true`.
      discard: async () => release(true),
    };
  };

  return createPostgresDriver(
    {
      execute: async (query: CompiledQuery) => {
        const connection = await connect();

        try {
          return await connection.execute(query);
        } catch (error) {
          // A client killed mid-query may not have noticed its closed socket
          // yet; returned to the pool, it would fail the next query.
          if (brokenConnection(error)) {
            connection.release(
              error instanceof Error ? error : new Error(String(error)),
            );
          }

          throw error;
        } finally {
          connection.release();
        }
      },
      connect,
      cancel: async (pid) => {
        cancellation ??= new Pool({ ...config, max: 1 }).on("error", () => {});
        await cancellation.query("SELECT pg_cancel_backend($1)", [pid]);
      },
      close: async () => {
        try {
          await pool.end();
        } finally {
          await cancellation?.end();
        }
      },
      max: pool.options.max,
    },
    profiler,
  );
};
