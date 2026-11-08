/**
 * `symmetria/pg`: PostgreSQL adapter built on node-postgres pools.
 */
import { Pool, types, type PoolConfig, type QueryResult } from "pg";
import type { CompiledQuery, ExecutionResult } from "../query/plan/types";
import type { QueryProfiler } from "../observability/profiling";
import { postgresParameters } from "./parameters";
import {
  createPostgresDriver,
  type PostgresDriver,
  type PostgresConnection,
} from "./pool";

export type PostgresOptions = Omit<PoolConfig, "types"> & {
  readonly url?: string;
  readonly profiler?: QueryProfiler | undefined;
};
export type { PostgresDriver } from "./pool";

/** `2024-01-31 12:00:00.123` as UTC; infinity and BC dates stay text for the codec to report. */
const utcTimestamp = (value: string): Date | string =>
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(value)
    ? new Date(`${value.replace(" ", "T")}Z`)
    : value;

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

export const postgres = (
  connection: string | PostgresOptions,
): PostgresDriver => {
  const { profiler, url, ...options } =
    typeof connection === "string" ? { url: connection } : connection;
  const config: PoolConfig = {
    ...options,
    ...(url ? { connectionString: url } : {}),
    types: parsers,
  };

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

    return {
      execute: async (query) => {
        if (failure) {
          throw failure;
        }

        return result(
          await client.query(query.sql, postgresParameters(query.parameters)),
        );
      },
      release: (error) => {
        if (!released) {
          released = true;
          client.removeListener("error", onError);
          client.release(error ?? failure);
        }
      },
    };
  };

  return createPostgresDriver(
    {
      execute: async (query: CompiledQuery) => {
        const connection = await connect();

        try {
          return await connection.execute(query);
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
