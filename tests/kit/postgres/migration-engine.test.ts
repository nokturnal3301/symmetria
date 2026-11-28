import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  schema,
  table,
  index,
  createDatabase,
  int,
  text,
  varchar,
  numeric,
  oneOf,
} from "../../../packages/runtime/src";
import { fullText } from "../../../packages/runtime/src/entries/search";
import {
  postgres,
  transactionPooling,
  type Driver,
} from "../../support/postgres";
import {
  detectDrift,
  generateMigration,
  migrator,
  verifyMigrations,
  MigrationExecutionError,
  type MigratorOptions,
} from "../../../packages/kit/src";
import { migrationDirectory } from "../../support/directories";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;

type Sandbox = {
  driver: Driver;
  /** A second pool on the same schema, for work concurrent with `driver`. */
  other: Driver;
  directory: string;
  namespace: string;
  address: string;
  rows: (sql: string, parameters?: unknown[]) => Promise<unknown[]>;
  runner: (overrides?: Partial<MigratorOptions>) => ReturnType<typeof migrator>;
};

const sandbox = async (
  callback: (context: Sandbox) => Promise<void>,
  database = url!,
) => {
  const namespace = `engine_${randomUUID().replaceAll("-", "")}`;
  const directory = await migrationDirectory();
  const address = new URL(database);
  address.searchParams.set("options", `-c search_path=${namespace}`);
  const driver = postgres({ url: address.toString(), max: 2 });
  const other = postgres({ url: address.toString(), max: 2 });

  const rows = async (sql: string, parameters: unknown[] = []) => {
    const result = await driver.execute({ sql, parameters });

    return Array.isArray(result) ? result : result.rows;
  };

  try {
    await rows(`CREATE SCHEMA "${namespace}"`);
    await callback({
      driver,
      other,
      directory,
      namespace,
      address: address.toString(),
      rows,
      runner: (overrides = {}) =>
        migrator({
          driver,
          directory,
          metadataSchema: namespace,
          verificationDatabaseUrl: url!,
          ...overrides,
        }),
    });
  } finally {
    await rows(`DROP SCHEMA "${namespace}" CASCADE`);
    await Promise.all([driver.close(), other.close()]);
    await rm(directory, { recursive: true, force: true });
  }
};

/**
 * A sandbox in a database of its own. A CREATE INDEX CONCURRENTLY waits for
 * every older transaction of its database, so the long statements of these
 * tests must not reach the database other suites build indexes in.
 */
const ownDatabase = async (callback: (context: Sandbox) => Promise<void>) => {
  const name = `engine_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres({ url: url!, max: 1 });
  const address = new URL(url!);
  address.pathname = `/${name}`;

  try {
    await admin.execute({ sql: `CREATE DATABASE "${name}"`, parameters: [] });
    await sandbox(callback, address.toString());
  } finally {
    await admin.execute({
      sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      parameters: [],
    });
    await admin.close();
  }
};

const runCli = async (config: string, ...argumentsList: string[]) => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("packages/kit/src/cli/index.ts"),
      ...argumentsList,
      "--config",
      config,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, exitCode };
};

/**
 * A driver that offers only whole transactions, like a custom executor without
 * pinned sessions. `afterCommit` runs once a transaction has committed.
 */
const transactionOnly = (
  driver: Driver,
  afterCommit?: () => Promise<void>,
): Driver & { readonly transactions: () => number } => {
  let count = 0;

  return {
    execute: (query) => driver.execute(query),
    close: async () => {},
    transaction: async (callback, options) => {
      const result = await driver.transaction!(callback, options);
      count += 1;
      await afterCommit?.();

      return result;
    },
    transactions: () => count,
  };
};

/**
 * A driver whose sessions cannot pin a server, as through PgBouncer with
 * pool_mode=transaction: every statement and transaction of every client
 * connection runs on whichever server connection is free, here the single one
 * of a one-connection pool. Records the SQL it runs.
 */
const transactionPooler = (address: string) => {
  const server = postgres({ url: address, max: 1 });
  const statements: string[] = [];

  const execute: Driver["execute"] = (query) => {
    statements.push(query.sql);

    return server.execute(query);
  };

  const transaction: NonNullable<Driver["transaction"]> = (callback, options) =>
    server.transaction(
      (tx) =>
        callback({
          execute: (query) => {
            statements.push(query.sql);

            return tx.execute(query);
          },
          transaction: tx.transaction,
        }),
      options,
    );

  const driver: Driver = {
    execute,
    transaction,
    session: (callback) => callback({ execute, transaction }),
    close: () => server.close(),
  };

  return { driver, statements };
};

/** Writes the SQL of an --empty migration. */
const writeMigration = async (
  directory: string,
  id: string,
  up: string,
  down: string,
) => {
  await writeFile(join(directory, id, "up.sql"), up);
  await writeFile(join(directory, id, "down.sql"), down);
};

/** The up.sql of a generated migration, executed without recording history. */
const applyWithoutHistory = async (
  driver: Driver,
  directory: string,
  id: string,
) => {
  await driver.execute({
    sql: await readFile(join(directory, id, "up.sql"), "utf8"),
    parameters: [],
  });
};

describe.skipIf(!url)("migration engine on PostgreSQL", () => {
  test("a narrowing type change needs --allow-destructive and fails instead of cutting values", () =>
    sandbox(async ({ directory, rows, runner }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({ users: { id: int.auto, name: text } }).$snapshot(),
      });
      await runner().migrate();
      await rows("INSERT INTO users (name) VALUES ('Alexandria')");
      const shorter = schema({ users: { id: int.auto, name: varchar(5) } });

      await expect(
        generateMigration({
          directory,
          name: "shorten",
          snapshot: shorter.$snapshot(),
        }),
      ).rejects.toThrow(/users\.name: Column "name" narrows from text/);

      const shorten = (await generateMigration({
        directory,
        name: "shorten",
        snapshot: shorter.$snapshot(),
        allowDestructive: true,
      }))!;
      expect(shorten.up).toBe(
        '-- symmetria: destructive: Column "name" narrows from text to varchar(5): values longer than 5 characters make the migration fail, and trailing spaces past the limit are cut.\nALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5);\n',
      );

      const failure = await runner()
        .migrate()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MigrationExecutionError);
      expect((failure as MigrationExecutionError).sqlState).toBe("22001");
      expect(await rows("SELECT name FROM users")).toEqual([
        { name: "Alexandria" },
      ]);

      await rows("UPDATE users SET name = 'Alex'");
      expect(await runner().migrate()).toEqual([shorten.id]);
      expect(await runner().rollback()).toEqual([shorten.id]);
      expect(await rows("SELECT name FROM users")).toEqual([{ name: "Alex" }]);
    }));

  test("a full-text search added to a table with rows stores its document, and follows its columns", () =>
    sandbox(async ({ directory, driver, namespace, rows, runner }) => {
      const columns = (length: number) => ({
        id: int.auto,
        title: varchar(length),
        body: text,
      });
      const plain = schema({ notes: table(columns(40)) });
      const notes = (length: number) =>
        schema({
          notes: table(columns(length)).search((note) => ({
            about: { words: fullText({ A: note.title, B: note.body }) },
          })),
        });
      const clean = (model: { $snapshot: typeof plain.$snapshot }) =>
        detectDrift({
          execute: driver.execute,
          snapshot: model.$snapshot(),
          schemaName: namespace,
          ignoreTables: ["_symmetria_migrations"],
        });

      await generateMigration({
        directory,
        name: "initial",
        snapshot: plain.$snapshot(),
      });
      await runner().migrate();
      await rows(
        "INSERT INTO notes (title, body) VALUES ('Garage keys', 'On the hook by the door'), ('Passport', 'Top drawer of the desk')",
      );

      const searched = (await generateMigration({
        directory,
        name: "search",
        snapshot: notes(40).$snapshot(),
      }))!;

      expect(searched.up).toContain("GENERATED ALWAYS AS");
      await runner().migrate();
      expect(await clean(notes(40))).toEqual([]);

      // Rows written before the search are found: PostgreSQL computed their documents.
      const database = createDatabase({ schema: notes(40), driver });

      expect(
        await database.notes.search((note) => ({ title: note.title }), {
          about: "garage",
        }),
      ).toEqual([{ title: "Garage keys" }]);
      await database.notes.insert({
        title: "Bike",
        body: "Keys are in the shed",
      });
      await database.notes.update(
        { body: "Sold it" },
        { where: { title: "Bike" } },
      );
      expect(
        await database.notes.search((note) => ({ title: note.title }), {
          about: "shed",
        }),
      ).toEqual([]);

      // PostgreSQL refuses to retype a column the document is computed from.
      const wider = (await generateMigration({
        directory,
        name: "wider",
        snapshot: notes(80).$snapshot(),
      }))!;

      await runner().migrate();
      expect(await clean(notes(80))).toEqual([]);
      expect(
        await database.notes.search((note) => ({ title: note.title }), {
          about: "passport",
        }),
      ).toEqual([{ title: "Passport" }]);
      expect(await runner().rollback()).toEqual([wider.id]);
      expect(await clean(notes(40))).toEqual([]);
      expect(await runner().rollback()).toEqual([searched.id]);
      expect(await clean(plain)).toEqual([]);
    }));

  test("widening a column rewrites neither the table nor its indexes", () =>
    sandbox(async ({ directory, driver, namespace, rows, runner }) => {
      const orders = (total: 14 | 16, wideCode: boolean) =>
        schema({
          orders: table({
            id: int.auto,
            total: numeric(total, 2),
            code: wideCode ? text : varchar(10),
          })
            .indexes((order) => ({
              total: index(order.total),
              code: index(order.code),
            }))
            .checks((order) => ({ positive: order.total.atLeast("0") })),
        });

      await generateMigration({
        directory,
        name: "initial",
        snapshot: orders(14, false).$snapshot(),
      });
      await runner().migrate();
      await rows(
        "INSERT INTO orders (total, code) SELECT n, 'c' || n FROM generate_series(1, 500) AS n",
      );

      // A file on disk per table and index: a rewrite or a rebuild gives a new one.
      const files = () =>
        rows(
          "SELECT c.relname, c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname LIKE 'orders%' AND c.relkind IN ('r', 'i') ORDER BY 1",
          [namespace],
        );
      const before = await files();
      const widen = (await generateMigration({
        directory,
        name: "widen",
        snapshot: orders(16, true).$snapshot(),
      }))!;

      expect(widen.up).not.toContain("DROP INDEX");
      expect(await runner().migrate()).toEqual([widen.id]);
      expect(await files()).toEqual(before);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: orders(16, true).$snapshot(),
          schemaName: namespace,
          ignoreTables: ["_symmetria_migrations"],
        }),
      ).toEqual([]);
      await rows(
        "INSERT INTO orders (total, code) VALUES (12345678901234.56, 'a code of any length')",
      );
      await rows("DELETE FROM orders WHERE id > 500");
      // The way back narrows again, with the indexes rebuilt around it.
      expect(await runner().rollback()).toEqual([widen.id]);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: orders(14, false).$snapshot(),
          schemaName: namespace,
          ignoreTables: ["_symmetria_migrations"],
        }),
      ).toEqual([]);
    }));

  test(
    "a label added by one batch migration can be used by the next in the same run",
    () =>
      sandbox(async ({ directory, namespace, rows, runner }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({
            posts: {
              id: int.auto,
              state: oneOf("draft", "published").default("draft"),
            },
          }).$snapshot(),
        });
        const added = (await generateMigration({
          directory,
          name: "add_review",
          snapshot: schema({
            posts: {
              id: int.auto,
              state: oneOf("draft", "published", "review").default("draft"),
            },
          }).$snapshot(),
        }))!;
        const used = (await generateMigration({
          directory,
          name: "default_review",
          snapshot: schema({
            posts: {
              id: int.auto,
              state: oneOf("draft", "published", "review").default("review"),
            },
          }).$snapshot(),
        }))!;
        expect(added.up).toContain("ADD VALUE E'review'");
        // A default change replaces the default in one statement.
        expect(used.up).toBe(
          `ALTER TABLE "posts" ALTER COLUMN "state" SET DEFAULT E'review';\n`,
        );

        // The group ends after the migration that adds the label.
        expect(
          (await runner().plan()).map((step) => [step.id, step.group]),
        ).toEqual([
          ["000001_initial", 1],
          [added.id, 1],
          [used.id, 2],
        ]);
        expect(await runner().migrate()).toHaveLength(3);
        await rows("INSERT INTO posts DEFAULT VALUES");
        expect(await rows("SELECT state::text AS state FROM posts")).toEqual([
          { state: "review" },
        ]);

        // A fresh installation and every upgrade/rollback boundary replay too.
        expect(
          await verifyMigrations({
            directory,
            url: url!,
            schemaName: namespace,
            metadataSchema: namespace,
          }),
        ).toMatchObject({ verified: true });
      }),
    30000,
  );

  test(
    "a transaction-only driver commits after a migration that adds enum labels, like a session driver",
    () =>
      sandbox(async ({ driver, directory, rows, runner }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({
            posts: {
              id: int.auto,
              state: oneOf("draft", "published").default("draft"),
            },
          }).$snapshot(),
        });
        const added = (await generateMigration({
          directory,
          name: "add_review",
          snapshot: schema({
            posts: {
              id: int.auto,
              state: oneOf("draft", "published", "review").default("draft"),
            },
          }).$snapshot(),
        }))!;
        const used = (await generateMigration({
          directory,
          name: "default_review",
          snapshot: schema({
            posts: {
              id: int.auto,
              state: oneOf("draft", "published", "review").default("review"),
            },
          }).$snapshot(),
        }))!;
        const separate = (await generateMigration({
          directory,
          name: "separate",
          snapshot: schema({
            posts: {
              id: int.auto,
              state: oneOf("draft", "published", "review").default("review"),
              note: text.nullable,
            },
          }).$snapshot(),
          transaction: "each",
        }))!;
        const transactional = transactionOnly(driver);

        expect(
          (await runner({ driver: transactional }).plan()).map((step) => [
            step.id,
            step.group,
          ]),
        ).toEqual([
          ["000001_initial", 1],
          [added.id, 1],
          [used.id, 2],
          [separate.id, 3],
        ]);
        expect(await runner({ driver: transactional }).migrate()).toEqual([
          "000001_initial",
          added.id,
          used.id,
          separate.id,
        ]);
        // plan(), then one transaction per group, then the final journal read.
        expect(transactional.transactions()).toBe(5);
        await rows("INSERT INTO posts DEFAULT VALUES");
        expect(await rows("SELECT state::text AS state FROM posts")).toEqual([
          { state: "review" },
        ]);

        // Rollback takes the same groups, newest first.
        expect(
          await runner({ driver: transactional }).rollback({ steps: 2 }),
        ).toEqual([separate.id, used.id]);
        expect(await runner().migrate()).toEqual([used.id, separate.id]);
      }),
    30000,
  );

  test(
    "transaction-only runners continue from the journal and refuse what needs a session",
    () =>
      sandbox(async ({ driver, other, directory, runner }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ records: { id: int.auto } }).$snapshot(),
        });

        for (const name of ["add_label", "use_label"]) {
          await generateMigration({ directory, name, empty: true });
        }

        await writeMigration(
          directory,
          "000002_add_label",
          "CREATE TYPE mood AS ENUM ('calm'); ALTER TYPE mood ADD VALUE 'busy';",
          "DROP TYPE mood;",
        );
        await writeMigration(
          directory,
          "000003_use_label",
          "ALTER TABLE records ADD COLUMN mood mood NOT NULL DEFAULT 'busy';",
          "ALTER TABLE records DROP COLUMN mood; ALTER TYPE mood ADD VALUE IF NOT EXISTS 'idle';",
        );

        // A second runner starts between the two groups of the first one: it
        // applies the rest, and the first one finds nothing left to do.
        let second: string[] = [];
        let started = false;
        const first = transactionOnly(driver, async () => {
          if (!started) {
            started = true;
            second = await runner({ driver: transactionOnly(other) }).migrate();
          }
        });

        expect(await runner({ driver: first }).migrate()).toEqual([
          "000001_initial",
          "000002_add_label",
        ]);
        expect(second).toEqual(["000003_use_label"]);
        expect((await runner().status()).map((entry) => entry.status)).toEqual([
          "applied",
          "applied",
          "applied",
        ]);

        // A rollback stops when another runner changed the journal between its
        // groups, instead of reverting migrations it did not choose.
        let migrated = false;
        const rolling = transactionOnly(driver, async () => {
          if (!migrated) {
            migrated = true;
            await runner({ driver: transactionOnly(other) }).migrate();
          }
        });
        await runner().rollback();
        await runner().migrate();
        migrated = false;
        const reverted = runner({ driver: rolling }).rollback({ steps: 2 });
        await expect(reverted).rejects.toThrow(
          'the migration journal changed during rollback: "000003_use_label" is now the latest applied migration, not "000002_add_label"',
        );

        // Nontransactional migrations need a session; nothing runs without one.
        await generateMigration({
          directory,
          name: "concurrent",
          empty: true,
          transaction: "none",
        });
        await expect(
          runner({ driver: transactionOnly(driver) }).migrate(),
        ).rejects.toThrow(
          'migration "000004_concurrent" uses transaction: "none", which needs a driver with sessions',
        );
        expect((await runner().status()).at(-1)).toEqual({
          id: "000004_concurrent",
          status: "pending",
        });
      }),
    30000,
  );

  // Runs with SYMMETRIA_TEST_TRANSACTION_POOLING=1 through a real PgBouncer.
  test.if(transactionPooling)(
    "through a transaction pooler the runner locks each transaction and refuses nontransactional migrations",
    () =>
      sandbox(async ({ directory, runner }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ records: { id: int.auto } }).$snapshot(),
        });
        expect(await runner().migrate()).toEqual(["000001_initial"]);
        await generateMigration({
          directory,
          name: "concurrent",
          empty: true,
          transaction: "none",
        });
        await expect(runner().migrate()).rejects.toThrow(
          "this connection pools transactions",
        );
        expect((await runner().status()).at(-1)?.status).toBe("pending");
      }),
  );

  // Compares the simulated pooler with a direct connection.
  test.skipIf(transactionPooling)(
    "a connection that pools transactions migrates under transaction locks and refuses what needs a session",
    () =>
      sandbox(async ({ directory, address, runner }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ records: { id: int.auto } }).$snapshot(),
        });
        const pooler = transactionPooler(address);

        try {
          expect(await runner({ driver: pooler.driver }).migrate()).toEqual([
            "000001_initial",
          ]);
          // Each transaction takes its own lock and settings, so none is left
          // on a server connection other clients share.
          expect(
            new Set(
              pooler.statements.filter((sql) => sql.includes("advisory")),
            ),
          ).toEqual(
            new Set([
              "SELECT pg_try_advisory_xact_lock(1937339476, hashtext($1)) AS locked",
            ]),
          );
          await expect(
            pooler.driver.execute({ sql: "SHOW lock_timeout", parameters: [] }),
          ).resolves.toMatchObject({ rows: [{ lock_timeout: "0" }] });

          await generateMigration({
            directory,
            name: "concurrent",
            empty: true,
            transaction: "none",
          });
          await expect(
            runner({ driver: pooler.driver }).migrate(),
          ).rejects.toThrow(
            'migration "000002_concurrent" uses transaction: "none", which needs one server connection for its statements and the migration lock; this connection pools transactions',
          );
          expect((await runner().status()).at(-1)).toEqual({
            id: "000002_concurrent",
            status: "pending",
          });
          // When the check cannot tell, as when another client took the free
          // server, a transaction on another server stops the run before it
          // changes anything, and the session lock is released.
          const sessionServer = postgres({ url: address, max: 1 });
          const otherServer = postgres({ url: address, max: 1 });
          const moving: Driver = {
            execute: otherServer.execute,
            transaction: otherServer.transaction,
            session: (callback) =>
              callback({
                execute: sessionServer.execute,
                transaction: otherServer.transaction,
              }),
            close: async () => {},
          };

          try {
            await expect(runner({ driver: moving }).migrate()).rejects.toThrow(
              /the migration session moved from PostgreSQL process \d+ to \d+: this connection pools transactions/,
            );
          } finally {
            await Promise.all([sessionServer.close(), otherServer.close()]);
          }

          // A direct connection still holds one session lock for the whole run.
          expect(await runner().migrate()).toEqual(["000002_concurrent"]);
        } finally {
          await pooler.driver.close();
        }
      }),
  );

  // Waits for a session lock that a pooled connection does not take.
  test.skipIf(transactionPooling)(
    "Ctrl-C keeps exit code 130 and prints JSON while migrate waits for the lock",
    () =>
      sandbox(async ({ driver, other, directory, namespace, address }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ users: { id: int.auto } }).$snapshot(),
        });
        const config = join(directory, "symmetria.config.ts");
        await writeFile(
          config,
          `export default { directory: ".", databaseUrl: ${JSON.stringify(address)}, metadataSchema: ${JSON.stringify(namespace)}, advisoryLockTimeoutMs: 30000 };\n`,
        );
        const lock = `symmetria:migrations:"${namespace}"."_symmetria_migrations"`;

        await other.session!(async (session) => {
          await session.execute({
            sql: "SELECT pg_advisory_lock(1937339476, hashtext($1))",
            parameters: [lock],
          });
          const child = Bun.spawn(
            [
              process.execPath,
              resolve("packages/kit/src/cli/index.ts"),
              "migrate",
              "--json",
              "--config",
              config,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );

          // Wait until the CLI is trying the lock, so its handler is installed.
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const result = await driver.execute({
              sql: "SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE query LIKE 'SELECT pg_try_advisory_lock%' AND pid <> pg_backend_pid()",
              parameters: [],
            });

            if ((Array.isArray(result) ? result : result.rows)[0]?.waiting) {
              break;
            }

            await Bun.sleep(50);
          }

          child.kill("SIGINT");
          const [stdout, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            child.exited,
          ]);
          await session.execute({
            sql: "SELECT pg_advisory_unlock(1937339476, hashtext($1))",
            parameters: [lock],
          });

          expect(exitCode).toBe(130);
          expect(JSON.parse(stdout)).toEqual({
            error: { message: "symmetria: interrupted" },
          });
        });
      }),
    30000,
  );

  // In a terminal the spinner runs; its exit must not beat the cancellation.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test.skipIf(transactionPooling)(
      `${signal} in a terminal cancels the running statement before migrate exits with ${code}`,
      () =>
        sandbox(async ({ driver, directory, namespace, address }) => {
          await generateMigration({
            directory,
            name: "initial",
            snapshot: schema({ notes: { id: int.auto } }).$snapshot(),
          });
          await generateMigration({ directory, name: "slow", empty: true });
          await writeMigration(
            directory,
            "000002_slow",
            // The namespace in the statement tells this run's backend from
            // those of other suites on the same server.
            `ALTER TABLE notes ADD COLUMN x integer; SELECT pg_sleep(30), '${namespace}'::text;`,
            "ALTER TABLE notes DROP COLUMN x;",
          );
          const config = join(directory, "symmetria.config.ts");
          await writeFile(
            config,
            `export default { directory: ".", databaseUrl: ${JSON.stringify(address)}, metadataSchema: ${JSON.stringify(namespace)} };\n`,
          );
          await runCli(config, "migrate", "--to", "000001_initial");

          const sleeping = async () => {
            const result = await driver.execute({
              sql: "SELECT count(*)::integer AS running FROM pg_stat_activity WHERE query LIKE '%pg_sleep(30)%' AND query LIKE '%' || $1 || '%' AND state = 'active' AND pid <> pg_backend_pid()",
              parameters: [namespace],
            });

            return (Array.isArray(result) ? result : result.rows)[0]!
              .running as number;
          };
          const child = Bun.spawn(
            [
              process.execPath,
              resolve("packages/kit/src/cli/index.ts"),
              "migrate",
              "--config",
              config,
            ],
            {
              env: { ...process.env, TERM: "xterm-256color" },
              terminal: { cols: 100, rows: 30, data: () => {} },
            },
          );

          let exitCode: number | null;
          let left: number;

          try {
            // A loaded server can take a while to start the CLI.
            for (let attempt = 0; attempt < 400; attempt += 1) {
              if (await sleeping()) {
                break;
              }

              await Bun.sleep(50);
            }

            expect(await sleeping()).toBe(1);

            if (signal === "SIGINT") {
              // Ctrl-C as a terminal sends it.
              child.terminal!.write("\u0003");
            } else {
              child.kill("SIGTERM");
            }

            exitCode = await child.exited;
            // Read before the cleanup below cancels anything left.
            left = await sleeping();
          } finally {
            // A failed check must not leave the statement holding the table
            // the sandbox drops.
            child.kill("SIGKILL");
            await driver.execute({
              sql: "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(30)%' AND query LIKE '%' || $1 || '%' AND pid <> pg_backend_pid()",
              parameters: [namespace],
            });
          }

          expect(exitCode).toBe(code);
          // Cancelled and rolled back before the exit: no statement, no column.
          expect(left).toBe(0);
          const column = await driver.execute({
            sql: `SELECT count(*)::integer AS columns FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'notes' AND column_name = 'x'`,
            parameters: [namespace],
          });
          expect(
            (Array.isArray(column) ? column : column.rows)[0]!.columns,
          ).toBe(0);
        }),
      30000,
    );
  }

  test.skipIf(transactionPooling)(
    "Ctrl-C at either rollback question exits with 130 and rolls nothing back",
    () =>
      sandbox(async ({ directory, namespace, address, runner }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ notes: { id: int.auto } }).$snapshot(),
        });
        await generateMigration({
          directory,
          name: "extra",
          snapshot: schema({
            notes: { id: int.auto, extra: text.nullable },
          }).$snapshot(),
        });
        const config = join(directory, "symmetria.config.ts");
        await writeFile(
          config,
          `export default { directory: ".", databaseUrl: ${JSON.stringify(address)}, metadataSchema: ${JSON.stringify(namespace)} };\n`,
        );
        expect((await runCli(config, "migrate")).exitCode).toBe(0);

        // One step drops a column: a Cancel / Roll back menu. Two steps drop
        // the table: the database name typed out.
        for (const [steps, prompt] of [
          ["1", "Roll back"],
          ["2", "to continue"],
        ] as const) {
          let output = "";
          const decoder = new TextDecoder();
          const child = Bun.spawn(
            [
              process.execPath,
              resolve("packages/kit/src/cli/index.ts"),
              "rollback",
              "--steps",
              steps,
              "--no-animation",
              "--config",
              config,
            ],
            {
              env: { ...process.env, TERM: "xterm-256color" },
              terminal: {
                cols: 100,
                rows: 30,
                data: (_terminal, data) => {
                  output += decoder.decode(data, { stream: true });
                },
              },
            },
          );

          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (output.includes(prompt)) {
              break;
            }

            await Bun.sleep(50);
          }

          await Bun.sleep(200);
          child.terminal!.write("\u0003");

          expect(await child.exited).toBe(130);
          expect(output).toContain("Rollback cancelled; nothing was changed.");
          expect(output).not.toContain("Aborted");
        }

        expect((await runner().status()).map((entry) => entry.status)).toEqual([
          "applied",
          "applied",
        ]);
      }),
    30000,
  );

  test(
    "verify compares a declared table even when ignoreTables names it, as drift does",
    () =>
      sandbox(async ({ directory, namespace }) => {
        const initial = (await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ audit: { id: int.auto } }).$snapshot(),
        }))!;
        // A down.sql that forgets the table it should drop.
        await writeFile(join(directory, initial.id, "down.sql"), "SELECT 1;");

        await expect(
          verifyMigrations({
            directory,
            url: url!,
            schemaName: namespace,
            metadataSchema: namespace,
            ignoreTables: ["audit", "spatial_ref_sys"],
          }),
        ).rejects.toThrow(`rollback of ${initial.id}`);
      }),
    30000,
  );

  test("adopt without history refuses data-only migrations it cannot tell apart", () =>
    sandbox(async ({ driver, directory, namespace, rows, runner }) => {
      const initial = (await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({ users: { id: int.auto, name: text } }).$snapshot(),
      }))!;
      const seed = (await generateMigration({
        directory,
        name: "seed",
        empty: true,
      }))!;
      await writeFile(
        join(directory, seed.id, "up.sql"),
        "INSERT INTO users (name) VALUES ('admin');",
      );
      await applyWithoutHistory(driver, directory, initial.id);

      await expect(runner().adopt()).rejects.toThrow(
        "matches multiple local migrations (000001_initial, 000002_seed)",
      );
      expect(
        await rows("SELECT to_regclass($1)::text AS name", [
          `"${namespace}"._symmetria_migrations`,
        ]),
      ).toEqual([{ name: null }]);

      expect(await runner().adopt({ to: initial.id })).toEqual([initial.id]);
      expect(await runner().migrate()).toEqual([seed.id]);
      expect(await rows("SELECT name FROM users")).toEqual([{ name: "admin" }]);
    }));

  test(
    "status reports while another migrate holds its transaction open",
    () =>
      sandbox(async ({ driver, other, directory, namespace, runner }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ users: { id: int.auto } }).$snapshot(),
        });
        await runner().migrate();
        const slow = (await generateMigration({
          directory,
          name: "slow",
          empty: true,
        }))!;
        await writeFile(
          join(directory, slow.id, "up.sql"),
          "SELECT pg_sleep(3);",
        );
        const observer = migrator({
          driver: other,
          directory,
          metadataSchema: namespace,
        });

        const running = runner().migrate();

        try {
          // Wait until the migration's transaction is inside pg_sleep.
          for (let attempt = 0; attempt < 100; attempt++) {
            const active = await other.execute({
              sql: "SELECT count(*)::int AS count FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(3)' AND state = 'active'",
              parameters: [],
            });

            if (
              (Array.isArray(active) ? active : active.rows)[0]?.count === 1
            ) {
              break;
            }

            await Bun.sleep(20);
          }

          const started = performance.now();
          expect(
            (await observer.status()).map((entry) => entry.status),
          ).toEqual(["applied", "pending"]);
          expect(performance.now() - started).toBeLessThan(1500);
        } finally {
          expect(await running).toEqual([slow.id]);
        }

        // A journal held by DDL turns into a clear error instead of a hang.
        await driver.transaction!(async (tx) => {
          await tx.execute({
            sql: `LOCK TABLE "${namespace}"._symmetria_migrations IN ACCESS EXCLUSIVE MODE`,
            parameters: [],
          });
          await expect(observer.status()).rejects.toThrow(
            /journal .* is locked by another session; status gave up after 2000ms/,
          );
        });
      }),
    20000,
  );

  test("SQL-standard function bodies and rule action lists run as single statements", () =>
    sandbox(async ({ directory, rows, runner }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({
          records: { id: int.auto, name: text },
        }).$snapshot(),
      });
      const routines = (await generateMigration({
        directory,
        name: "routines",
        empty: true,
      }))!;
      await writeFile(
        join(directory, routines.id, "up.sql"),
        `CREATE FUNCTION record_label(amount integer) RETURNS text LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN amount > 1 THEN 'many' ELSE 'one' END;
END;

CREATE TABLE audit (name text);

CREATE RULE records_audit AS ON INSERT TO records DO ALSO (
  INSERT INTO audit VALUES (NEW.name);
  INSERT INTO audit VALUES (NEW.name || ';')
);
`,
      );
      await writeFile(
        join(directory, routines.id, "down.sql"),
        "DROP RULE records_audit ON records; DROP TABLE audit; DROP FUNCTION record_label(integer);",
      );

      expect(
        (await runner().plan()).find((step) => step.id === routines.id)
          ?.statements,
      ).toHaveLength(3);
      expect(await runner().migrate()).toHaveLength(2);
      expect(await rows("SELECT record_label(2) AS label")).toEqual([
        { label: "many" },
      ]);
      await rows("INSERT INTO records (name) VALUES ('a')");
      expect(await rows("SELECT name FROM audit ORDER BY name")).toEqual([
        { name: "a" },
        { name: "a;" },
      ]);
      expect(await runner().rollback()).toEqual([routines.id]);
    }));

  test("a rename with a using hint rolls back with the data", () =>
    sandbox(async ({ directory, rows, runner }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({
          users: { id: int.auto, ageText: text },
        }).$snapshot(),
      });
      await runner().migrate();
      await rows("INSERT INTO users (age_text) VALUES ('42')");
      const retype = (await generateMigration({
        directory,
        name: "retype",
        snapshot: schema({ users: { id: int.auto, age: int } }).$snapshot(),
        renames: { columns: { users: { age_text: "age" } } },
        using: {
          users: { age: { up: '"age"::integer', down: '"age"::text' } },
        },
      }))!;
      // Down retypes while the column still has the new name, then renames it back.
      expect(retype.down).toBe(
        'ALTER TABLE "users" ALTER COLUMN "age" TYPE text USING "age"::text;\n\nALTER TABLE "users" RENAME COLUMN "age" TO "age_text";\n',
      );

      expect(await runner().migrate()).toEqual([retype.id]);
      expect(await rows("SELECT age FROM users")).toEqual([{ age: 42 }]);
      expect(await runner().rollback()).toEqual([retype.id]);
      expect(await rows("SELECT age_text FROM users")).toEqual([
        { age_text: "42" },
      ]);
      expect(await runner().migrate()).toEqual([retype.id]);
    }));

  test(
    "adopt and drift leave ignored undeclared tables out",
    () =>
      sandbox(async ({ driver, directory, namespace, rows, runner }) => {
        const initial = (await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ records: { id: int.auto } }).$snapshot(),
        }))!;
        const latest = (await generateMigration({
          directory,
          name: "note",
          snapshot: schema({
            records: { id: int.auto, note: text.nullable },
          }).$snapshot(),
        }))!;
        await applyWithoutHistory(driver, directory, initial.id);
        await rows("CREATE TABLE spatial_ref_sys (srid integer PRIMARY KEY)");
        await rows("CREATE TABLE _prisma_migrations (id varchar(36))");
        const ignoreTables = ["spatial_ref_sys", "_prisma_migrations"];

        // The historical boundary is replayed in a disposable database.
        await expect(runner().adopt({ to: initial.id })).rejects.toThrow(
          /unexpected tables: .*spatial_ref_sys/,
        );
        expect(
          await runner({ ignoreTables }).adopt({ to: initial.id }),
        ).toEqual([initial.id]);
        expect(await runner().migrate()).toEqual([latest.id]);
        // The latest boundary is compared with the snapshot directly.
        await expect(runner().adopt()).rejects.toThrow(/extra-table/);
        expect(await runner({ ignoreTables }).adopt()).toEqual([
          initial.id,
          latest.id,
        ]);

        const snapshot = schema({
          records: { id: int.auto, note: text.nullable },
        }).$snapshot();
        const drift = {
          execute: driver.execute,
          snapshot,
          metadataSchema: namespace,
        };
        expect(
          (await detectDrift(drift)).map(
            (finding) => `${finding.kind} ${finding.table}`,
          ),
        ).toEqual([
          "extra-table _prisma_migrations",
          "extra-table spatial_ref_sys",
        ]);
        expect(await detectDrift({ ...drift, ignoreTables })).toEqual([]);

        // A declared table is compared even when the list names it.
        await rows("ALTER TABLE records ADD COLUMN extra text");
        expect(
          await detectDrift({
            ...drift,
            ignoreTables: [...ignoreTables, "records"],
          }),
        ).toEqual([
          { kind: "extra-column", table: "records", column: "extra" },
        ]);
      }),
    30000,
  );

  test(
    "CLI failures carry PostgreSQL's DETAIL once and print JSON with --json",
    () =>
      sandbox(async ({ directory, address, namespace, rows }) => {
        const config = join(directory, "config.ts");
        await writeFile(
          config,
          `export default ${JSON.stringify({ directory: "files", databaseUrl: address, metadataSchema: namespace })};\n`,
        );
        const files = join(directory, "files");
        const initial = (await generateMigration({
          directory: files,
          name: "initial",
          snapshot: schema({
            users: { id: int.auto, email: text },
          }).$snapshot(),
        }))!;
        expect((await runCli(config, "migrate")).exitCode).toBe(0);
        await rows(
          "INSERT INTO users (email) VALUES ('ada@example.com'), ('ada@example.com')",
        );
        await generateMigration({
          directory: files,
          name: "unique_email",
          snapshot: schema({
            users: { id: int.auto, email: text.unique },
          }).$snapshot(),
        });

        const plain = await runCli(config, "migrate", "--no-color");
        expect(plain.exitCode).toBe(1);
        expect(plain.stderr).toContain(
          "DETAIL: Key (email)=(ada@example.com) is duplicated.",
        );
        expect(
          plain.stderr.split("could not create unique index"),
        ).toHaveLength(2);

        const json = await runCli(config, "migrate", "--json");
        expect(json.exitCode).toBe(1);
        expect(JSON.parse(json.stdout)).toMatchObject({
          error: {
            migration: "000002_unique_email",
            direction: "up",
            statement: 1,
            sqlState: "23505",
            detail: "Key (email)=(ada@example.com) is duplicated.",
          },
        });

        // --to an applied migration says where the database stands.
        expect(
          await runCli(config, "migrate", "--to", initial.id),
        ).toMatchObject({
          exitCode: 0,
          stdout: `Database is already at ${initial.id}.\n`,
        });
        await rows("DELETE FROM users WHERE id = 2");
        expect((await runCli(config, "migrate")).exitCode).toBe(0);
        expect(
          await runCli(config, "migrate", "--to", initial.id),
        ).toMatchObject({
          exitCode: 0,
          stdout: `${initial.id} is already applied; the database is further along, at 000002_unique_email. Use rollback to go back.\n`,
        });
      }),
    30000,
  );
  /** Waits until a statement matching `pattern` runs in another session, and returns its process. */
  const runningBackend = async (
    rows: Sandbox["rows"],
    pattern: string,
  ): Promise<number> => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = (await rows(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE $1 AND state = 'active' AND pid <> pg_backend_pid()",
        [pattern],
      )) as { pid: number }[];

      if (row) {
        return Number(row.pid);
      }

      await Bun.sleep(25);
    }

    throw new Error(`no statement like ${pattern} started`);
  };

  // Terminates the migration session's server process, which a pooler hides.
  test.skipIf(transactionPooling)(
    "a migration whose connection is lost mid-statement reports that migration and statement",
    () =>
      ownDatabase(async ({ directory, rows, runner, namespace }) => {
        // Tagged, so that only this test's statement is terminated.
        const sleep = `SELECT pg_sleep(30), '${namespace}'::text`;
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ records: { id: int.auto } }).$snapshot(),
        });
        await runner().migrate();

        for (const transaction of ["batch", "none"] as const) {
          const slow = (await generateMigration({
            directory,
            name: `slow_${transaction}`,
            empty: true,
            transaction,
          }))!;
          const up = join(directory, slow.id, "up.sql");
          await writeFile(
            up,
            `ALTER TABLE records ADD COLUMN ${transaction} text;\n${sleep};\n`,
          );
          // Handled from the start: the failure can arrive before the
          // terminating query below has answered.
          const run = runner()
            .migrate()
            .then(
              () => undefined,
              (failure: unknown) => failure as MigrationExecutionError,
            );
          await rows("SELECT pg_terminate_backend($1)", [
            await runningBackend(rows, sleep),
          ]);
          const error = await run;

          // The cleanup on the lost session failed too; it is a note, not the error.
          expect(error).toBeInstanceOf(MigrationExecutionError);
          expect(error).toMatchObject({
            migration: slow.id,
            direction: "up",
            statement: 2,
            sql: sleep,
            sqlState: "57P01",
          });
          expect(error!.message).toMatch(
            /\nAfterwards, restoring the session settings and releasing the migration lock failed too: .+\. PostgreSQL releases the session's lock when the session ends\.\n\nSQL:\n/,
          );
          expect(error!.message.endsWith(`\n\nSQL:\n${sleep}`)).toBe(true);

          if (transaction === "batch") {
            // Rolled back; the next run applies it once its SQL is fixed.
            expect((await runner().status()).at(-1)).toEqual({
              id: slow.id,
              status: "pending",
            });
            await writeFile(up, "SELECT 1;\n");
            expect(await runner().migrate()).toEqual([slow.id]);
          } else {
            // The first statement committed; a fresh connection recorded the error.
            expect((await runner().status()).at(-1)).toMatchObject({
              id: slow.id,
              status: "incomplete",
              statement: 1,
              error: expect.stringContaining(
                `migration "${slow.id}" failed (up, statement 2, SQLSTATE 57P01)`,
              ),
            });
            expect((await runner().status()).at(-1)?.running).toBeUndefined();
          }
        }
      }),
    30000,
  );

  // A failover or network blip drops the pool's idle connections with the
  // session's; the pool hands them out until each fails, here with
  // node-postgres's EPIPE on a closed socket.
  test.skipIf(transactionPooling)(
    "a none migration's error reaches the journal when the pool's idle connections were lost with its session",
    () =>
      ownDatabase(async ({ directory, driver, rows, runner, namespace }) => {
        const sleep = `SELECT pg_sleep(30), '${namespace}'::text`;
        const slow = (await generateMigration({
          directory,
          name: "slow",
          empty: true,
          transaction: "none",
        }))!;
        await writeFile(
          join(directory, slow.id, "up.sql"),
          `CREATE TABLE records (id int);\n${sleep};\n`,
        );
        let dead = 0;
        const flaky: Driver = {
          ...driver,
          transaction: (callback, options) => {
            if (dead > 0) {
              dead -= 1;

              return Promise.reject(
                Object.assign(new Error("write EPIPE"), {
                  errno: -32,
                  syscall: "write",
                  code: "EPIPE",
                }),
              );
            }

            return driver.transaction!(callback, options);
          },
        };
        // Handled from the start, as the failure may arrive at any time.
        const run = runner({ driver: flaky })
          .migrate()
          .then(
            () => undefined,
            (failure: unknown) => failure as MigrationExecutionError,
          );
        const backend = await runningBackend(rows, sleep);
        dead = 2;
        await rows("SELECT pg_terminate_backend($1)", [backend]);
        const error = await run;

        expect(dead).toBe(0);
        expect(error).toBeInstanceOf(MigrationExecutionError);
        expect(error!.message).not.toContain("journal does not record");
        expect((await runner().status()).at(-1)).toMatchObject({
          id: slow.id,
          status: "incomplete",
          statement: 1,
          error: expect.stringContaining(
            `migration "${slow.id}" failed (up, statement 2, SQLSTATE 57P01)`,
          ),
        });
      }),
    30000,
  );

  // With the server down, a new connection is refused: the write is not
  // tried again for ten seconds. While connections keep failing as lost
  // ones, an abort (Ctrl-C) ends the wait.
  test.skipIf(transactionPooling)(
    "a none migration's error is reported at once when new connections are refused, or when the wait is aborted",
    async () => {
      const failedRun = (failure: () => Error, abort?: AbortController) => {
        let attempts = 0;
        let result: [MigrationExecutionError, number, number] | undefined;

        return ownDatabase(
          async ({ directory, driver, rows, runner, namespace }) => {
            const sleep = `SELECT pg_sleep(30), '${namespace}'::text`;
            const slow = (await generateMigration({
              directory,
              name: "slow",
              empty: true,
              transaction: "none",
            }))!;
            await writeFile(
              join(directory, slow.id, "up.sql"),
              `CREATE TABLE records (id int);\n${sleep};\n`,
            );
            const flaky: Driver = {
              ...driver,
              transaction: () => {
                attempts += 1;

                return Promise.reject(failure());
              },
            };
            const run = runner({
              driver: flaky,
              ...(abort ? { signal: abort.signal } : {}),
            }).migrate();
            await rows("SELECT pg_terminate_backend($1)", [
              await runningBackend(rows, sleep),
            ]);
            const lost = performance.now();

            if (abort) {
              setTimeout(() => abort.abort(new Error("interrupted")), 300);
            }

            const error = await run.then(
              () => undefined,
              (failure: unknown) => failure as MigrationExecutionError,
            );
            result = [error!, performance.now() - lost, attempts];
          },
        ).then(() => result!);
      };

      const [refused, refusedAfter, refusedAttempts] = await failedRun(() =>
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
        }),
      );

      expect(refusedAttempts).toBe(1);
      expect(refusedAfter).toBeLessThan(2000);
      expect(refused).toBeInstanceOf(MigrationExecutionError);
      expect(refused.message).toContain(
        "The migration journal does not record this error: connect ECONNREFUSED 127.0.0.1:5432.",
      );

      const [aborted, abortedAfter, abortedAttempts] = await failedRun(
        () =>
          Object.assign(new Error("write EPIPE"), {
            errno: -32,
            syscall: "write",
            code: "EPIPE",
          }),
        new AbortController(),
      );

      expect(abortedAttempts).toBeGreaterThan(1);
      expect(abortedAfter).toBeLessThan(2000);
      expect(aborted).toBeInstanceOf(MigrationExecutionError);
      expect(aborted.message).toContain(
        "The migration journal does not record this error: interrupted while waiting for a connection.",
      );
    },
    30000,
  );

  // The wait ends while a new connection is still opening (here 1.5 s late).
  // The attempt then writes nothing, so the message holds; and the abort
  // cancels nothing on the lost session, where a cancellation's own new
  // connection would wait as long as the server does not answer.
  test.skipIf(transactionPooling)(
    "a journal write the wait gave up on writes nothing, and an abort after the session was lost cancels nothing",
    () =>
      ownDatabase(async ({ directory, driver, rows, runner, namespace }) => {
        const sleep = `SELECT pg_sleep(30), '${namespace}'::text`;
        const slow = (await generateMigration({
          directory,
          name: "slow",
          empty: true,
          transaction: "none",
        }))!;
        await writeFile(
          join(directory, slow.id, "up.sql"),
          `CREATE TABLE records (id int);\n${sleep};\n`,
        );
        let late = false;
        let cancels = 0;
        const attempts: Promise<unknown>[] = [];
        const hanging: Driver = {
          ...driver,
          transaction: (callback, options) => {
            if (!late) {
              return driver.transaction!(callback, options);
            }

            const attempt = Bun.sleep(1500).then(() =>
              driver.transaction!(callback, options),
            );
            attempts.push(attempt.catch(() => {}));

            return attempt;
          },
          session: (callback) =>
            driver.session!((session) =>
              callback({
                ...session,
                cancel: () => {
                  cancels += 1;

                  return new Promise<void>(() => {});
                },
              }),
            ),
        };
        const abort = new AbortController();
        const run = runner({ driver: hanging, signal: abort.signal }).migrate();
        const backend = await runningBackend(rows, sleep);
        late = true;
        await rows("SELECT pg_terminate_backend($1)", [backend]);
        setTimeout(() => abort.abort(new Error("interrupted")), 300);
        const started = performance.now();
        const error = await run.then(
          () => undefined,
          (failure: unknown) => failure as MigrationExecutionError,
        );

        expect(performance.now() - started).toBeLessThan(1500);
        expect(error).toBeInstanceOf(MigrationExecutionError);
        expect(error!.message).toContain(
          "The migration journal does not record this error: interrupted while waiting for a connection.",
        );
        expect(cancels).toBe(0);
        await Promise.all(attempts);
        const entry = (await runner().status()).at(-1);
        expect(entry).toMatchObject({
          id: slow.id,
          status: "incomplete",
          statement: 1,
        });
        expect(entry?.error).toBeUndefined();
      }),
    30000,
  );

  // New connections reach the server but get no answer (a frozen server, a
  // pooler waiting for its backend). Ctrl-C ends the journal's wait; the CLI
  // prints the migration's error and exits without waiting for the attempt.
  test.skipIf(transactionPooling)(
    "the CLI reports a none migration's error at once on Ctrl-C while new connections get no answer",
    async () => {
      const upstream = new URL(url!);
      type Link = {
        upstream?: { write: (chunk: Uint8Array) => void; end: () => void };
        pending: Uint8Array[];
      };
      const links = new Set<{ end: () => void; data: Link }>();
      let hang = false;
      const proxy = Bun.listen<Link>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          async open(client) {
            client.data = { pending: [] };
            links.add(client);

            if (hang) {
              return;
            }

            client.data.upstream = await Bun.connect({
              hostname: upstream.hostname,
              port: Number(upstream.port || 5432),
              socket: {
                data: (_server, chunk) => {
                  client.write(chunk);
                },
                close: () => {
                  client.end();
                },
                error: () => {
                  client.end();
                },
              },
            });

            for (const chunk of client.data.pending) {
              client.data.upstream.write(chunk);
            }

            client.data.pending = [];
          },
          data(client, chunk) {
            if (client.data.upstream) {
              client.data.upstream.write(chunk);
            } else {
              client.data.pending.push(new Uint8Array(chunk));
            }
          },
          close(client) {
            links.delete(client);
            client.data.upstream?.end();
          },
          error(client) {
            client.data.upstream?.end();
          },
        },
      });

      try {
        await ownDatabase(async ({ directory, address, rows, namespace }) => {
          const proxied = new URL(address);
          proxied.hostname = "127.0.0.1";
          proxied.port = String(proxy.port);
          const config = join(directory, "config.ts");
          await writeFile(
            config,
            `export default ${JSON.stringify({ directory: "files", databaseUrl: proxied.toString(), metadataSchema: namespace })};\n`,
          );
          const files = join(directory, "files");
          const sleep = `SELECT pg_sleep(30), '${namespace}'::text`;
          const slow = (await generateMigration({
            directory: files,
            name: "slow",
            empty: true,
            transaction: "none",
          }))!;
          await writeFile(
            join(files, slow.id, "up.sql"),
            `CREATE TABLE records (id int);\n${sleep};\n`,
          );
          const child = Bun.spawn(
            [
              process.execPath,
              resolve("packages/kit/src/cli/index.ts"),
              "migrate",
              "--config",
              config,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          const output = Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          const guard = setTimeout(() => child.kill("SIGKILL"), 20000);

          try {
            await runningBackend(rows, sleep);
            hang = true;

            for (const link of links) {
              link.data.upstream?.end();
              link.end();
            }

            await Bun.sleep(300);
            child.kill("SIGINT");
            const interrupted = performance.now();
            const exitCode = await child.exited;
            const [, stderr] = await output;

            expect(performance.now() - interrupted).toBeLessThan(3000);
            expect(exitCode).toBe(130);
            expect(stderr).toContain(
              `migration "${slow.id}" failed (up, statement 2`,
            );
            expect(stderr).toContain(
              "The migration journal does not record this error: interrupted while waiting for a connection.",
            );
            expect(stderr).not.toContain("exited before");
          } finally {
            clearTimeout(guard);
            child.kill("SIGKILL");
          }
        });
      } finally {
        hang = false;

        for (const link of links) {
          link.end();
        }

        proxy.stop(true);
      }
    },
    40000,
  );

  // A session lock and nontransactional statements need a pinned server.
  test.skipIf(transactionPooling)(
    "an online index waits for older transactions without the default lock timeout; a configured one applies",
    () =>
      ownDatabase(async ({ directory, rows, runner, other }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({
            records: { id: int.auto, name: text },
            reports: { id: int.auto },
          }).$snapshot(),
        });
        await runner().migrate();
        const online = (await generateMigration({
          directory,
          name: "name_index",
          online: true,
          snapshot: schema({
            records: table({ id: int.auto, name: text }).indexes((record) => ({
              name: index(record.name),
            })),
            reports: { id: int.auto },
          }).$snapshot(),
        }))!;
        const up = join(directory, online.id, "up.sql");
        expect(await readFile(up, "utf8")).toContain(
          "CREATE INDEX CONCURRENTLY",
        );
        // Statements that may block others keep the default.
        await writeFile(
          up,
          `${await readFile(up, "utf8")}\nCREATE TABLE seen AS SELECT current_setting('lock_timeout') AS value;\n`,
        );
        const after = (await generateMigration({
          directory,
          name: "after",
          empty: true,
        }))!;
        await writeFile(
          join(directory, after.id, "up.sql"),
          "CREATE TABLE seen_after AS SELECT current_setting('lock_timeout') AS value;\n",
        );

        // A report on another table that runs longer than the 5 s default:
        // the concurrent build waits for it, which blocks nobody.
        const report = other.execute({
          sql: "SELECT count(*), pg_sleep(6) FROM reports",
          parameters: [],
        });
        await runningBackend(rows, "SELECT count(*), pg_sleep(6)%");
        const started = performance.now();
        expect(await runner().migrate()).toEqual([online.id, after.id]);
        expect(performance.now() - started).toBeGreaterThan(4000);
        await report;
        expect(
          await rows(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('records_name_idx')",
          ),
        ).toEqual([{ indisvalid: true }]);
        expect(await rows("SELECT value FROM seen")).toEqual([{ value: "5s" }]);
        expect(await rows("SELECT value FROM seen_after")).toEqual([
          { value: "5s" },
        ]);

        // A lock timeout you set applies to it too.
        const pair = (await generateMigration({
          directory,
          name: "pair_index",
          empty: true,
          transaction: "none",
        }))!;
        await writeFile(
          join(directory, pair.id, "up.sql"),
          "CREATE INDEX CONCURRENTLY records_pair_idx ON records (id, name);\n",
        );
        const again = other.execute({
          sql: "SELECT count(*), pg_sleep(3) FROM reports",
          parameters: [],
        });
        await runningBackend(rows, "SELECT count(*), pg_sleep(3)%");
        await expect(
          runner({ lockTimeoutMs: 500 }).migrate(),
        ).rejects.toMatchObject({
          migration: pair.id,
          statement: 1,
          sqlState: "55P03",
        });
        await again;
      }),
    40000,
  );

  // A session lock needs a pinned server.
  test.skipIf(transactionPooling)(
    "a connection that opens slowly is not taken for a transaction pooler",
    async () => {
      const upstream = new URL(url!);
      type Link = {
        upstream?: { write: (chunk: Uint8Array) => void; end: () => void };
        pending: Uint8Array[];
        closed?: boolean;
      };
      // Each new connection reaches the server 1.5 s late, as over TLS and
      // a password exchange to a distant server.
      const proxy = Bun.listen<Link>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open(client) {
            client.data = { pending: [] };
            setTimeout(async () => {
              if (client.data.closed) {
                return;
              }

              client.data.upstream = await Bun.connect({
                hostname: upstream.hostname,
                port: Number(upstream.port || 5432),
                socket: {
                  data: (_server, chunk) => {
                    client.write(chunk);
                  },
                  close: () => {
                    client.end();
                  },
                  error: () => {
                    client.end();
                  },
                },
              });

              for (const chunk of client.data.pending) {
                client.data.upstream.write(chunk);
              }

              client.data.pending = [];
            }, 1500);
          },
          data(client, chunk) {
            if (client.data.upstream) {
              client.data.upstream.write(chunk);
            } else {
              client.data.pending.push(new Uint8Array(chunk));
            }
          },
          close(client) {
            client.data.closed = true;
            client.data.upstream?.end();
          },
          error(client) {
            client.data.upstream?.end();
          },
        },
      });

      try {
        await ownDatabase(async ({ directory, address, namespace }) => {
          const slow = new URL(address);
          slow.hostname = "127.0.0.1";
          slow.port = String(proxy.port);
          const pool = postgres({ url: slow.toString(), max: 3 });
          const sessionSQL: string[] = [];
          const recorded: Driver = {
            ...pool,
            session: (callback) =>
              pool.session!((session) =>
                callback({
                  ...session,
                  execute: (query) => {
                    sessionSQL.push(query.sql);

                    return session.execute(query);
                  },
                }),
              ),
          };

          try {
            const initial = (await generateMigration({
              directory,
              name: "initial",
              snapshot: schema({
                records: { id: int.auto, name: text },
              }).$snapshot(),
            }))!;
            const online = (await generateMigration({
              directory,
              name: "name_index",
              online: true,
              snapshot: schema({
                records: table({ id: int.auto, name: text }).indexes(
                  (record) => ({ name: index(record.name) }),
                ),
              }).$snapshot(),
            }))!;

            expect(
              await migrator({
                driver: recorded,
                directory,
                metadataSchema: namespace,
              }).migrate(),
            ).toEqual([initial.id, online.id]);
            // The batch migration ran under the session lock, as on any
            // direct connection, not under a lock per transaction.
            expect(sessionSQL).toContain(
              "SELECT pg_try_advisory_lock(1937339476, hashtext($1)) AS locked",
            );
          } finally {
            await pool.close();
          }
        });
      } finally {
        proxy.stop(true);
      }
    },
    60000,
  );

  // A session lock and nontransactional statements need a pinned server.
  test.skipIf(transactionPooling)(
    "status tells an online migration another process runs from an interrupted one, and drift names the repair",
    () =>
      ownDatabase(
        async ({ directory, address, namespace, rows, runner, other }) => {
          const config = join(directory, "config.ts");
          await writeFile(
            config,
            `export default ${JSON.stringify({ directory: ".", databaseUrl: address, metadataSchema: namespace })};\n`,
          );
          await generateMigration({
            directory,
            name: "initial",
            snapshot: schema({ records: { id: int.auto } }).$snapshot(),
          });
          await runner().migrate();
          const long = (await generateMigration({
            directory,
            name: "long",
            empty: true,
            transaction: "none",
          }))!;
          await writeFile(
            join(directory, long.id, "up.sql"),
            "SELECT pg_sleep(5);\nCREATE TABLE done (id integer);\n",
          );
          await writeFile(
            join(directory, long.id, "down.sql"),
            "DROP TABLE done;\n",
          );

          // Running in this process: its journal row is incomplete, and it
          // holds the migration lock.
          const run = runner().migrate();
          await runningBackend(rows, "SELECT pg_sleep(5)%");
          const status = await runCli(config, "status", "--json");
          expect(status.exitCode).toBe(0);
          expect(JSON.parse(status.stdout).migrations.at(-1)).toMatchObject({
            id: long.id,
            status: "incomplete",
            running: true,
          });
          expect((await runCli(config, "status")).stdout).toContain(
            `incomplete ${long.id} · up · 0 confirmed statements · running in another process`,
          );
          // It needs no repair: lint of the pending chain waits for it.
          expect(await runCli(config, "lint", "--pending")).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining(
              `migration "${long.id}" is running in another process`,
            ),
          });
          expect(await runCli(config, "drift")).toMatchObject({
            exitCode: 0,
            stdout: expect.stringContaining(
              "Another process holds the migration lock and is still running it",
            ),
          });
          // Another migrate waits for the lock and says who holds it.
          await expect(
            runner({ driver: other, advisoryLockTimeoutMs: 200 }).migrate(),
          ).rejects.toThrow(
            /^symmetria: migration advisory lock timeout after 200ms: PostgreSQL process \d+ \(active for \d+s\) holds the migration lock\. .*pg_terminate_backend\(\d+\)$/,
          );
          expect(await run).toEqual([long.id]);

          // One that stopped part-way needs repair, and drift says so.
          const broken = (await generateMigration({
            directory,
            name: "broken",
            empty: true,
            transaction: "none",
          }))!;
          await writeFile(
            join(directory, broken.id, "up.sql"),
            "CREATE TABLE half (id integer);\nSELECT 1/0;\n",
          );
          await expect(runner().migrate()).rejects.toMatchObject({
            migration: broken.id,
            statement: 2,
            sqlState: "22012",
          });
          const stopped = await runCli(config, "status", "--json");
          expect(stopped.exitCode).toBe(1);
          expect(await runCli(config, "lint", "--pending")).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining(
              "repair incomplete migrations before linting the pending chain",
            ),
          });
          expect(JSON.parse(stopped.stdout).migrations.at(-1)).toEqual({
            id: broken.id,
            status: "incomplete",
            appliedAt: expect.any(String),
            direction: "up",
            statement: 1,
            error: expect.stringContaining("division by zero"),
          });
          const drift = await runCli(config, "drift");
          expect(drift.exitCode).toBe(0);
          expect(drift.stdout).toBe(
            `Migration ${broken.id} is incomplete (up, 1 confirmed statements): the schema is between two migrations, so drift does not compare it.\nIt stopped with: migration "${broken.id}" failed (up, statement 2, SQLSTATE 22012): division by zero\nInspect the database, then run \`symmetria repair ${broken.id} --action retry\` after undoing what it did, or \`--action complete\` after finishing it by hand.\n`,
          );
          expect((await runCli(config, "drift", "--strict")).exitCode).toBe(1);
          expect(
            JSON.parse((await runCli(config, "drift", "--json")).stdout),
          ).toMatchObject({
            findings: [],
            incomplete: { id: broken.id, direction: "up", statement: 1 },
          });
          await expect(runner().migrate()).rejects.toThrow(
            `migration "${broken.id}" is incomplete (up, 1 confirmed statements): it stopped part-way, and no other process is running it (none holds the migration lock). Inspect the database and use repair`,
          );
        },
      ),
    40000,
  );
});
