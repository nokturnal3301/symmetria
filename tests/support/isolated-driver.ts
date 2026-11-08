import { test as bunTest } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSchemaSQL } from "../../packages/kit/src";
import type { SchemaSnapshot } from "../../packages/runtime/src";
import type { Driver } from "../../packages/runtime/src/entries/driver";
import { postgres } from "./postgres";

export const test = bunTest.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL);

/** A lazily initialized, isolated PostgreSQL schema for migrated runtime regressions. */
export const isolatedDriver = () => {
  const namespace = `symmetria_regression_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.SYMMETRIA_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${namespace}`);
  const driver = postgres({ url: url.toString() });
  let ready = driver.execute({
    sql: `CREATE SCHEMA "${namespace}"`,
    parameters: [],
  });
  void ready.catch(() => {});
  const wrapped: Driver & {
    createTables(
      source: SchemaSnapshot | { $snapshot(): SchemaSnapshot },
    ): void;
  } = {
    execute: async (query) => {
      await ready;

      return driver.execute(query);
    },
    transaction: async (callback, options) => {
      await ready;

      return driver.transaction(callback, options);
    },
    session: async (callback) => {
      await ready;

      return driver.session(callback);
    },
    close: async () => {
      try {
        await ready.catch(() => {});
        await driver.execute({
          sql: `DROP SCHEMA IF EXISTS "${namespace}" CASCADE`,
          parameters: [],
        });
      } finally {
        await driver.close();
      }
    },
    createTables: (source) => {
      ready = ready.then(async () => {
        for (const statement of createSchemaSQL(
          "$snapshot" in source ? source.$snapshot() : source,
        )) {
          await driver.execute(statement);
        }

        return { rows: [], affectedRows: 0 };
      });
      void ready.catch(() => {});
    },
  };

  return wrapped;
};
