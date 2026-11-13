import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  schema,
  int,
  text,
  varchar,
  oneOf,
} from "../../../packages/runtime/src";
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

const sandbox = async (callback: (context: Sandbox) => Promise<void>) => {
  const namespace = `engine_${randomUUID().replaceAll("-", "")}`;
  const directory = await migrationDirectory();
  const address = new URL(url!);
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
        'ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5);\n',
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
});
