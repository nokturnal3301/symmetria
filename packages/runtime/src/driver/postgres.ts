import { SQL } from "bun";
import type { Driver } from "../query/state";
import { executePostgres, runPostgresTransaction } from "./transactions";
import type { QueryProfiler } from "../observability/profiling";
import { runPostgresSession } from "./session";

export type PostgresOptions = Omit<
  SQL.PostgresOrMySQLOptions,
  "adapter" | "bigint"
> & { readonly profiler?: QueryProfiler | undefined };

/** Bun owns the pool; query builders only depend on the functional Driver contract. */
export type PostgresDriver = Driver;

export const postgres = (
  connection: string | PostgresOptions,
): PostgresDriver => {
  const { profiler, ...options } =
    typeof connection === "string" ? { url: connection } : connection;
  const client =
    typeof connection === "string"
      ? new SQL(connection, { adapter: "postgres", bigint: true })
      : new SQL({ ...options, adapter: "postgres", bigint: true });
  let cancellation: SQL | undefined;

  const base: Driver = {
    execute: (query) => executePostgres(client, query),
    transaction: (callback, options) =>
      runPostgresTransaction(client, callback, options),
    session: (callback) =>
      runPostgresSession(client, callback, async (pid) => {
        cancellation ??= new SQL({
          ...options,
          adapter: "postgres",
          bigint: true,
          max: 1,
        });
        await cancellation.unsafe("SELECT pg_cancel_backend($1)", [pid]);
      }),
    close: async () => {
      await client.close();
      await cancellation?.close();
    },
  };

  return Object.freeze(profiler ? profiler.driver(base) : base);
};
