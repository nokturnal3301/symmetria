import { postgres as bunSQL } from "../../packages/runtime/src/entries/bun";
import { postgres as pg } from "../../packages/runtime/src/entries/pg";
import {
  testDatabase as isolated,
  type TestDatabaseOptions,
} from "../../packages/kit/src/testing";
import type { BindableSchema } from "../../packages/runtime/src/schema/binding";
import type { SchemaSnapshot } from "../../packages/runtime/src";
export type {
  Driver,
  SessionDriver,
} from "../../packages/runtime/src/entries/driver";

/**
 * `SYMMETRIA_TEST_TRANSACTION_POOLING=1` runs the suites through a PgBouncer in
 * transaction mode: Bun.SQL uses unnamed statements (`prepare: false`), as the
 * reference requires there, and tests that need session state skip.
 */
export const transactionPooling =
  process.env.SYMMETRIA_TEST_TRANSACTION_POOLING === "1";

/** Bun.SQL with the options the test server needs. */
export const bun: typeof bunSQL = (connection) =>
  transactionPooling
    ? bunSQL({
        ...(typeof connection === "string" ? { url: connection } : connection),
        prepare: false,
      })
    : bunSQL(connection);

export const postgres = process.env.SYMMETRIA_TEST_DRIVER === "pg" ? pg : bun;

/** The test URL whose connections start with `search_path` set to `namespace`. */
export const searchPathURL = (namespace: string, ...rest: string[]): string => {
  const url = new URL(
    process.env.SYMMETRIA_TEST_DATABASE_URL ?? "postgres://localhost/postgres",
  );
  url.searchParams.set(
    "options",
    `-c search_path=${[namespace, ...rest].join(",")}`,
  );

  return url.toString();
};

export const testDatabase = <
  Model extends BindableSchema & { $snapshot: () => SchemaSnapshot },
>(
  options: TestDatabaseOptions<Model>,
) => isolated({ ...options, driver: postgres });
