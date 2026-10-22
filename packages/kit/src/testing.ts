import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createDatabase, type SchemaSnapshot } from "symmetria";
import {
  postgres,
  SCHEMA_BIND,
  type BindableSchema,
  type PostgresDriver,
} from "symmetria/driver";
import { createSchemaSQL } from "./migrations/diff";

export type TestDatabaseOptions<Model> = {
  /** PostgreSQL connection URL; the test schema is created inside this database. */
  readonly url: string;
  readonly schema: Model;
  /** Prefix of the generated schema name (default "symmetria_test"). */
  readonly prefix?: string;
  /** Pool size for the test driver (default 4). */
  readonly max?: number;
};

export type TestDatabase<Model extends BindableSchema> = {
  readonly database: ReturnType<Model[typeof SCHEMA_BIND]>;
  readonly driver: PostgresDriver;
  /** The isolated PostgreSQL schema that holds the tables. */
  readonly namespace: string;
  /** Close the pool and drop the schema with everything in it. */
  readonly close: () => Promise<void>;
};

/**
 * An isolated PostgreSQL schema per call: created from the declaration, bound to a
 * fresh pool whose search_path points at it, and dropped on close().
 */
export const testDatabase = async <
  Model extends BindableSchema & { readonly $snapshot: () => SchemaSnapshot },
>(
  options: TestDatabaseOptions<Model>,
): Promise<TestDatabase<Model>> => {
  const namespace = `${options.prefix ?? "symmetria_test"}_${randomUUID().replaceAll("-", "")}`;

  if (!/^[a-z_][a-z0-9_]*$/.test(namespace) || namespace.length > 63) {
    throw new Error("symmetria: test schema prefix must be a short identifier");
  }

  const admin = new SQL(options.url, { max: 1 });
  await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
  const connection = new URL(options.url);
  connection.searchParams.set("options", `-c search_path=${namespace}`);
  const driver = postgres({
    url: connection.toString(),
    max: options.max ?? 4,
  });

  try {
    for (const statement of createSchemaSQL(options.schema.$snapshot())) {
      await driver.execute(statement);
    }
  } catch (error) {
    await driver.close();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.close();
    throw error;
  }

  return Object.freeze({
    database: createDatabase({ schema: options.schema, driver }),
    driver,
    namespace,
    close: async () => {
      try {
        await driver.close();
      } finally {
        try {
          await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        } finally {
          await admin.close();
        }
      }
    },
  });
};
