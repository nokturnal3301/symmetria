import { randomUUID } from "node:crypto";
import { createDatabase, type SchemaSnapshot } from "symmetria";
import {
  postgres,
  type SCHEMA_BIND,
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
  /** Adapter used by both the administration and isolated-schema pools. */
  readonly driver?: (options: { url: string; max: number }) => PostgresDriver;
  /**
   * Schemas appended to the test schema on the search_path, for example `["public"]`
   * when the tables use types from an extension installed there.
   */
  readonly searchPath?: readonly string[];
};

export type TestDatabase<Model extends BindableSchema> = {
  readonly database: ReturnType<Model[typeof SCHEMA_BIND]>;
  readonly driver: PostgresDriver;
  /** The isolated PostgreSQL schema that holds the tables. */
  readonly namespace: string;
  /** Close the pool and drop the schema with everything in it. */
  readonly close: () => Promise<void>;
};

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

/**
 * The extensions a schema needs (`vector`, `pg_search`), installed once for
 * the database where they are missing, and the schemas their types and
 * operators live in, which the test schema's search_path must name.
 */
const installExtensions = async (
  execute: (sql: string, parameters?: unknown[]) => Promise<unknown>,
  names: readonly string[],
): Promise<readonly string[]> => {
  const schemas: string[] = [];

  for (const name of names) {
    const located = async () =>
      rowsOf(
        await execute(
          `SELECT n.nspname AS home,
             ARRAY(SELECT m.nspname::text FROM pg_depend d JOIN pg_namespace m ON m.oid = d.objid
                   WHERE d.classid = 'pg_namespace'::regclass AND d.refclassid = 'pg_extension'::regclass
                     AND d.refobjid = e.oid AND d.deptype = 'e' ORDER BY m.nspname) AS members
           FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
           WHERE e.extname = $1`,
          [name],
        ),
      )[0] as { home: string; members: string[] | string } | undefined;
    let found = await located();

    if (!found) {
      try {
        // Into the database's default schema, usually public, where it stays
        // for the next test: a test schema is dropped, an extension is shared.
        await execute(
          `CREATE EXTENSION IF NOT EXISTS "${name.replaceAll('"', '""')}"`,
        );
      } catch (error) {
        // Another test may have created it at the same moment.
        found = await located();

        if (!found) {
          throw new Error(
            `symmetria: the test database needs the "${name}" extension and could not create it (${error instanceof Error ? error.message : String(error)}); install it, or use a role that may`,
            { cause: error },
          );
        }
      }

      found ??= await located();
    }

    if (found) {
      const members = Array.isArray(found.members)
        ? found.members
        : // node-postgres and Bun.SQL both read name[] as an array; text is a fallback.
          String(found.members)
            .replace(/^\{|\}$/g, "")
            .split(",");

      schemas.push(
        found.home,
        ...members.filter((member) => member && member !== "pg_catalog"),
      );
    }
  }

  return schemas.filter(
    (schema) => schema !== "pg_catalog" && /^[a-z_][a-z0-9_]*$/.test(schema),
  );
};

/**
 * An isolated PostgreSQL schema per call: created from the declaration, bound to a
 * fresh pool whose search_path points at it, and dropped on close(). The
 * extensions the declaration needs are installed when missing, and their
 * schemas follow the test schema on the search_path.
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

  const connect = options.driver ?? postgres;
  const admin = connect({ url: options.url, max: 1 });

  const adminSQL = (sql: string, parameters: unknown[] = []) =>
    admin.execute({ sql, parameters });

  try {
    await adminSQL(`CREATE SCHEMA "${namespace}"`);
  } catch (error) {
    await admin.close();
    throw error;
  }

  for (const schemaName of options.searchPath ?? []) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("symmetria: search_path entries must be identifiers");
    }
  }

  let extensionSchemas: readonly string[];

  try {
    extensionSchemas = await installExtensions(
      adminSQL,
      options.schema.$snapshot().extensions ?? [],
    );
  } catch (error) {
    await adminSQL(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.close();
    throw error;
  }

  const connection = new URL(options.url);
  connection.searchParams.set(
    "options",
    `-c search_path=${[
      ...new Set([
        namespace,
        ...(options.searchPath ?? []),
        ...extensionSchemas,
      ]),
    ].join(",")}`,
  );
  const driver = connect({
    url: connection.toString(),
    max: options.max ?? 4,
  });

  let database: TestDatabase<Model>["database"];

  try {
    for (const statement of createSchemaSQL(options.schema.$snapshot())) {
      await driver.execute(statement);
    }

    database = createDatabase({ schema: options.schema, driver });
  } catch (error) {
    await driver.close();
    await adminSQL(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.close();
    throw error;
  }

  let closing: Promise<void> | undefined;

  return Object.freeze({
    database,
    driver,
    namespace,
    close: () =>
      (closing ??= (async () => {
        try {
          await driver.close();
        } finally {
          try {
            await adminSQL(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
          } finally {
            await admin.close();
          }
        }
      })()),
  });
};
