import { SQL } from "bun";
import type { Driver } from "../query/state";
import { executePostgres, runPostgresTransaction } from "./transactions";
import type { QueryProfiler } from "../observability/profiling";

export type PostgresOptions = Omit<
  SQL.PostgresOrMySQLOptions,
  "adapter" | "bigint"
> & { readonly profiler?: QueryProfiler };

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

  const base: Driver = {
    execute: (query) => executePostgres(client, query),
    transaction: (callback, options) =>
      runPostgresTransaction(client, callback, options),
    close: async () => {
      await client.close();
    },
  };

  return Object.freeze(profiler ? profiler.driver(base) : base);
};
