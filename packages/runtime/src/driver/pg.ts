/**
 * `symmetria/pg`: PostgreSQL adapter built on node-postgres pools.
 */
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
      ) as (value: string) => (string | null)[];

      return (value: string) =>
        parseArray(value).map((entry) =>
          entry === null ? null : utcTimestamp(entry),
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
  const { profiler, url, ...options } =
    typeof connection === "string" ? { url: connection } : connection;
  const config = {
    ...options,
    ...(url ? { connectionString: url } : {}),
    types: parsers,
  } as PoolConfig;

  const pool = new Pool(config);
  pool.on("error", () => {});

  let cancellation: Pool | undefined;

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

    const onError = (error: Error) => {
      failure = error;
    };

    client.on("error", onError);

    const release = (error?: Error | true) => {
      if (!released) {
        released = true;
        client.removeListener("error", onError);
        client.release(error ?? failure);
      }
    };

    return {
      execute: async (query) => {
        if (failure) {
          throw failure;
        }

        return result(
          await client.query(
            query.sql,
            postgresParameters(query.parameters, true),
          ),
        );
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
    },
    profiler,
  );
};
