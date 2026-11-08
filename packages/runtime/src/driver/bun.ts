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

/** Bun reports socket-level failures with ERR_POSTGRES_* codes; server errors carry SQLSTATE codes. */
const transportFailure = (error: Error): boolean => {
  const code: unknown = (error as { code?: unknown }).code;

  return typeof code === "string" && code.startsWith("ERR_");
};

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
    const result = await connection.unsafe<Record<string, unknown>[]>(
      query.sql,
      postgresParameters(query.parameters),
    );

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
            if (released) {
              return;
            }

            released = true;

            if (!error || transportFailure(error)) {
              reserved.release();

              return;
            }

            void reserved
              .unsafe("ROLLBACK")
              .catch(() => {})
              .finally(() => reserved.release());
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
    },
    profiler,
  );
};
