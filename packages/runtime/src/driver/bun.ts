/**
 * `symmetria/bun`: PostgreSQL adapter built on Bun's SQL pool.
 */
import { SQL } from "bun";
import { createPostgresDriver, type PostgresDriver } from "./pool";
import { postgresParameters } from "./parameters";
import type { CompiledQuery, ExecutionResult } from "../query/plan/types";
import type { QueryProfiler } from "../observability/profiling";

export type PostgresOptions = Omit<
  SQL.PostgresOrMySQLOptions,
  "adapter" | "bigint"
> & { readonly profiler?: QueryProfiler | undefined };
export type { PostgresDriver } from "./pool";

/**
 * Hands a reserved connection back. After a clean end it returns to the pool.
 * With an error, from a ROLLBACK that failed, it is closed, as node-postgres
 * closes it: the session may still hold the transaction. Bun's error codes do
 * not tell a lost socket from a statement the server refused: every server
 * error is ERR_POSTGRES_SERVER_ERROR (its SQLSTATE in `errno`), and a session
 * the server ended reports one too (57P01). Closing a lost connection is as
 * safe as returning it.
 */
export const releaseReserved = (
  reserved: {
    readonly release: () => void;
    readonly close: () => Promise<unknown>;
  },
  error?: Error,
): void => {
  if (error) {
    void reserved.close().catch(() => {});
  } else {
    reserved.release();
  }
};

/**
 * Bun.SQL reads a bytea column only in the hex form PostgreSQL prints by
 * default; a database, role or pooler may set `bytea_output = escape`. The
 * adapter has no place to run a SET on each connection, and a start-up
 * parameter it added would make poolers that refuse unknown ones (PgBouncer
 * by default) refuse every connection, so the setting is the caller's.
 */
const unreadableBytea = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code ===
  "ERR_POSTGRES_UNSUPPORTED_BYTEA_FORMAT";

export const postgres = (
  connection: string | PostgresOptions,
): PostgresDriver => {
  const { profiler, ...options } =
    typeof connection === "string" ? { url: connection } : connection;
  const client = new SQL({ ...options, adapter: "postgres", bigint: true });
  let cancellation: SQL | undefined;

  const execute = async (
    connection: SQL,
    query: CompiledQuery,
  ): Promise<ExecutionResult> => {
    let result: Record<string, unknown>[];

    try {
      result = await connection.unsafe<Record<string, unknown>[]>(
        query.sql,
        postgresParameters(query.parameters),
      );
    } catch (error) {
      // The error stays Bun's own, with its class, code and stack, so code
      // that checks them still matches; only its message changes, to say
      // what to do.
      if (unreadableBytea(error) && error instanceof Error) {
        error.message =
          'symmetria: the server sends bytea values in the escape form (bytea_output = escape), which Bun.SQL cannot read; give the adapter the default: postgres({ url, connection: { bytea_output: "hex" } })';
      }

      throw error;
    }

    return {
      rows: Array.from(result),
      affectedRows: (result as { count?: number }).count ?? result.length,
    };
  };

  return createPostgresDriver(
    {
      execute: (query) => execute(client, query),
      connect: async () => {
        const reserved = await client.reserve();
        let released = false;

        return {
          execute: (query) => execute(reserved, query),
          release: (error) => {
            if (!released) {
              released = true;
              releaseReserved(reserved, error);
            }
          },
          // Closing a reserved connection frees its pool slot for a fresh one.
          discard: async () => {
            if (!released) {
              released = true;
              await reserved.close().catch(() => {});
            }
          },
        };
      },
      cancel: async (pid) => {
        cancellation ??= new SQL({
          ...options,
          adapter: "postgres",
          bigint: true,
          max: 1,
        });

        await cancellation.unsafe("SELECT pg_cancel_backend($1)", [pid]);
      },
      close: async () => {
        try {
          await client.close();
        } finally {
          await cancellation?.close();
        }
      },
      // Bun.SQL opens ten connections unless told otherwise.
      max: options.max ?? 10,
    },
    profiler,
  );
};
