import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  schema,
  table,
  int,
  text,
  oneOf,
  index,
} from "../../../packages/runtime/src";
import {
  postgres,
  type Driver,
  type SessionDriver,
} from "../../../packages/runtime/src/driver";
import {
  detectDrift,
  generateMigration,
  migrator,
  verifyMigrations,
  type MigrationEvent,
} from "../../../packages/kit/src";
import { migrationDirectory } from "../../support/directories";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;

const sandbox = async (
  callback: (context: {
    driver: Driver;
    directory: string;
    namespace: string;
    address: string;
  }) => Promise<void>,
) => {
  const namespace = `production_${randomUUID().replaceAll("-", "")}`;
  const directory = await migrationDirectory();
  const address = new URL(url!);
  address.searchParams.set("options", `-c search_path=${namespace}`);
  const driver = postgres({ url: address.toString(), max: 1 });

  try {
    await driver.execute({
      sql: `CREATE SCHEMA "${namespace}"`,
      parameters: [],
    });
    await callback({
      driver,
      directory,
      namespace,
      address: address.toString(),
    });
  } finally {
    await driver.execute({
      sql: `DROP SCHEMA "${namespace}" CASCADE`,
      parameters: [],
    });
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
};

describe.skipIf(!url)("production migrations", () => {
  test("cancellation with an uncertain lock result never leaves a session advisory lock behind", () =>
    sandbox(async ({ driver, directory, namespace, address }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({ records: { id: int } }).$snapshot(),
      });
      const cancellation = new AbortController();
      const interrupted: Driver = {
        ...driver,
        session: (callback) =>
          driver.session!(async (session) =>
            callback({
              ...session,
              execute: async (query) => {
                const result = await session.execute(query);

                if (query.sql.includes("pg_try_advisory_")) {
                  cancellation.abort(new Error("uncertain acquisition"));
                  throw cancellation.signal.reason;
                }

                return result;
              },
            }),
          ),
      };
      await expect(
        migrator({
          driver: interrupted,
          directory,
          metadataSchema: namespace,
          signal: cancellation.signal,
        }).migrate(),
      ).rejects.toThrow(/uncertain acquisition/);
      const other = postgres(address);

      try {
        expect(
          await migrator({
            driver: other,
            directory,
            metadataSchema: namespace,
            advisoryLockTimeoutMs: 50,
          }).migrate(),
        ).toHaveLength(1);
      } finally {
        await other.close();
      }
    }));
  test("an interrupted nontransactional rollback can be completed without replaying committed DDL", () =>
    sandbox(async ({ driver, directory, namespace }) => {
      const first = schema({ records: { id: int, name: text } });
      const second = schema({
        records: table({ id: int, name: text }).indexes((record) => ({
          name: index(record.name),
        })),
      });
      await generateMigration({
        directory,
        name: "initial",
        snapshot: first.$snapshot(),
      });
      const added = (await generateMigration({
        directory,
        name: "index",
        snapshot: second.$snapshot(),
        online: true,
      }))!;
      await writeFile(
        join(directory, added.id, "down.sql"),
        `${added.down}\nSELECT missing_column;`,
      );
      const runner = migrator({
        driver,
        directory,
        metadataSchema: namespace,
        verificationDatabaseUrl: url!,
      });
      await runner.migrate();
      await expect(runner.rollback()).rejects.toMatchObject({
        direction: "down",
        statement: 2,
      });
      expect((await runner.status()).at(-1)).toMatchObject({
        status: "incomplete",
        direction: "down",
        statement: 1,
      });
      await expect(runner.adopt()).rejects.toThrow(/repair incomplete/);
      await runner.repair({ id: added.id, action: "complete" });
      expect((await runner.status()).at(-1)?.status).toBe("pending");
      expect(await runner.migrate()).toEqual([added.id]);
    }));
  test("pinned sessions preserve connection identity and transaction lifecycle guards", () =>
    sandbox(async ({ driver }) => {
      let escaped: SessionDriver | undefined;
      await driver.session!(async (session) => {
        escaped = session;
        const pid = await session.execute({
          sql: "SELECT pg_backend_pid() AS pid",
          parameters: [],
        });
        await session.transaction(async (tx) => {
          expect(
            await tx.execute({
              sql: "SELECT pg_backend_pid() AS pid",
              parameters: [],
            }),
          ).toEqual(pid);
          await expect(
            tx.transaction(async (nested) => {
              await nested.execute({
                sql: "SELECT missing_column",
                parameters: [],
              });
            }),
          ).rejects.toThrow(/missing_column/);
          expect(
            await tx.execute({ sql: "SELECT 1 AS value", parameters: [] }),
          ).toMatchObject({ rows: [{ value: 1 }] });
        });
        expect(
          await session.execute({
            sql: "SELECT pg_backend_pid() AS pid",
            parameters: [],
          }),
        ).toEqual(pid);
      });
      expect(() =>
        escaped!.execute({ sql: "SELECT 1", parameters: [] }),
      ).toThrow(/context is closed/);
      await expect(
        driver.session!(async (session) => {
          void session.execute({
            sql: "SELECT pg_sleep(0.01)",
            parameters: [],
          });
        }),
      ).rejects.toThrow(/await all session operations/);
    }));
  test("online unique-index failure persists incomplete state and requires verified repair", () =>
    sandbox(async ({ driver, directory, namespace }) => {
      const first = schema({ records: { id: int.auto, name: text } });
      const second = schema({
        records: table({ id: int.auto, name: text }).indexes((record) => ({
          name: index(record.name).unique,
        })),
      });
      await generateMigration({
        directory,
        name: "initial",
        snapshot: first.$snapshot(),
      });
      const runner = migrator({
        driver,
        directory,
        metadataSchema: namespace,
        verificationDatabaseUrl: url!,
      });
      await runner.migrate();
      await driver.execute({
        sql: "INSERT INTO records(name) VALUES ('same'), ('same')",
        parameters: [],
      });
      const migration = (await generateMigration({
        directory,
        name: "unique",
        snapshot: second.$snapshot(),
        online: true,
      }))!;
      expect(migration.up).toContain("CREATE UNIQUE INDEX CONCURRENTLY");
      await expect(runner.migrate()).rejects.toMatchObject({
        migration: migration.id,
        statement: 1,
        sqlState: "23505",
      });
      expect((await runner.status()).at(-1)).toMatchObject({
        status: "incomplete",
        statement: 0,
        direction: "up",
      });
      await expect(runner.migrate()).rejects.toThrow(/incomplete/);
      await expect(
        runner.repair({ id: migration.id, action: "complete" }),
      ).rejects.toThrow(/invalid-index/);
      // A retry names the leftover invalid index and how to reconcile it.
      await expect(
        runner.repair({ id: migration.id, action: "retry" }),
      ).rejects.toThrow(
        /unexpected invalid index records_name_idx \(left by a failed CONCURRENTLY build; DROP INDEX CONCURRENTLY it before retrying\)/,
      );
      await driver.execute({
        sql: "DROP INDEX records_name_idx",
        parameters: [],
      });
      await driver.execute({
        sql: "DELETE FROM records WHERE id = 2",
        parameters: [],
      });
      await runner.repair({ id: migration.id, action: "retry" });
      expect(await runner.migrate()).toEqual([migration.id]);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: second.$snapshot(),
          metadataSchema: namespace,
        }),
      ).toEqual([]);
      expect(await runner.rollback()).toEqual([migration.id]);
    }));

  test("each commits its predecessor while a failing default batch remains atomic", () =>
    sandbox(async ({ driver, directory, namespace }) => {
      const initial = (await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({ records: { id: int } }).$snapshot(),
      }))!;
      const second = (await generateMigration({
        directory,
        name: "separate",
        empty: true,
        transaction: "each",
      }))!;
      await writeFile(
        join(directory, second.id, "up.sql"),
        "INSERT INTO records VALUES (1); SELECT missing_column;",
      );
      const runner = migrator({ driver, directory, metadataSchema: namespace });
      expect(
        (await runner.plan()).map((step) => [step.group, step.transaction]),
      ).toEqual([
        [1, "batch"],
        [2, "each"],
      ]);
      await expect(runner.migrate()).rejects.toMatchObject({
        sqlState: "42703",
        statement: 2,
      });
      expect(await runner.status()).toMatchObject([
        { id: initial.id, status: "applied" },
        { id: second.id, status: "pending" },
      ]);
      expect(
        await driver.execute({ sql: "SELECT * FROM records", parameters: [] }),
      ).toMatchObject({ rows: [] });
    }));

  test("session advisory locks survive commit boundaries and have a bounded wait", () =>
    sandbox(async ({ driver, directory, namespace, address }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({ records: { id: int } }).$snapshot(),
      });
      const slow = (await generateMigration({
        directory,
        name: "slow",
        empty: true,
        transaction: "none",
      }))!;
      await writeFile(
        join(directory, slow.id, "up.sql"),
        "SELECT pg_sleep(0.3);",
      );
      const entered = Promise.withResolvers<void>();
      const events: MigrationEvent[] = [];
      const first = migrator({
        driver,
        directory,
        metadataSchema: namespace,
        onEvent: (event) => {
          events.push(event);

          if (event.migration === slow.id && event.type === "statement-start") {
            entered.resolve();
          }
        },
      });
      const other = postgres(address);
      const running = first.migrate();

      try {
        await entered.promise;
        await expect(
          migrator({
            driver: other,
            directory,
            metadataSchema: namespace,
            advisoryLockTimeoutMs: 30,
          }).migrate(),
        ).rejects.toThrow(/advisory lock timeout/);
        // Reads do not queue behind the running migration.
        expect(
          await migrator({
            driver: other,
            directory,
            metadataSchema: namespace,
            advisoryLockTimeoutMs: 30,
          }).status(),
        ).toMatchObject([
          { status: "applied" },
          { id: slow.id, status: "incomplete", direction: "up" },
        ]);
        await running;
        expect(
          events.filter((event) => event.type === "statement-end"),
        ).toHaveLength(2);
        expect(
          await migrator({
            driver: other,
            directory,
            metadataSchema: namespace,
          }).migrate(),
        ).toEqual([]);
      } finally {
        await running;
        await other.close();
      }
    }));

  test("statement timeout and cancellation roll back and preserve structured diagnostics", () =>
    sandbox(async ({ driver, directory, namespace }) => {
      const migration = (await generateMigration({
        directory,
        name: "slow",
        empty: true,
      }))!;
      await writeFile(
        join(directory, migration.id, "up.sql"),
        "SELECT pg_sleep(5);",
      );
      await expect(
        migrator({
          driver,
          directory,
          metadataSchema: namespace,
          statementTimeoutMs: 25,
        }).migrate(),
      ).rejects.toMatchObject({ sqlState: "57014", statement: 1 });
      await expect(
        migrator({
          driver,
          directory,
          metadataSchema: namespace,
          signal: AbortSignal.timeout(50),
        }).migrate(),
      ).rejects.toMatchObject({ sqlState: "57014" });
      expect(
        await migrator({
          driver,
          directory,
          metadataSchema: namespace,
        }).status(),
      ).toEqual([{ id: migration.id, status: "pending" }]);
    }));

  test("online enum additions retain the type OID and permit new defaults after commit", () =>
    sandbox(async ({ driver, directory, namespace }) => {
      const first = schema({
        records: {
          id: int.auto,
          state: oneOf("draft", "done").default("draft"),
        },
      });
      const second = schema({
        records: {
          id: int.auto,
          state: oneOf("draft", "active", "done").default("active"),
        },
      });
      await generateMigration({
        directory,
        name: "initial",
        snapshot: first.$snapshot(),
      });
      const runner = migrator({ driver, directory, metadataSchema: namespace });
      await runner.migrate();

      const oid = () =>
        driver.execute({
          sql: "SELECT 'records_state_enum'::regtype::oid AS oid",
          parameters: [],
        });

      const before = await oid();
      const migration = (await generateMigration({
        directory,
        name: "active",
        snapshot: second.$snapshot(),
        online: true,
      }))!;
      expect(migration.up).toContain("ADD VALUE E'active' BEFORE E'done'");
      expect(migration.up).not.toContain("RENAME TO");
      await runner.migrate();
      expect(await oid()).toEqual(before);
      expect(
        await driver.execute({
          sql: "INSERT INTO records DEFAULT VALUES RETURNING state",
          parameters: [],
        }),
      ).toMatchObject({ rows: [{ state: "active" }] });
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: second.$snapshot(),
          metadataSchema: namespace,
        }),
      ).toEqual([]);
    }));

  test("DDL lock timeout releases the migration lock and restores session settings", () =>
    sandbox(async ({ driver, directory, namespace, address }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: schema({ records: { id: int } }).$snapshot(),
      });
      const runner = migrator({
        driver,
        directory,
        metadataSchema: namespace,
        lockTimeoutMs: 30,
      });
      await runner.migrate();
      await generateMigration({
        directory,
        name: "name",
        snapshot: schema({
          records: { id: int, name: text.nullable },
        }).$snapshot(),
      });
      const blocker = postgres(address);
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holding = blocker.transaction!(async (tx) => {
        await tx.execute({
          sql: "LOCK TABLE records IN ACCESS EXCLUSIVE MODE",
          parameters: [],
        });
        locked.resolve();
        await release.promise;
      });

      try {
        await locked.promise;
        await expect(runner.migrate()).rejects.toMatchObject({
          sqlState: "55P03",
        });
      } finally {
        release.resolve();
        await holding;
        await blocker.close();
      }

      expect(
        await driver.execute({ sql: "SHOW lock_timeout", parameters: [] }),
      ).toMatchObject({ rows: [{ lock_timeout: "0" }] });
      expect(await runner.migrate()).toHaveLength(1);
    }));

  test("drift detects defaults, identity, FK actions, constraints, enum order and unrelated _key indexes", () =>
    sandbox(async ({ driver, directory, namespace }) => {
      const users = table({ id: int.auto, name: text.unique });
      const model = schema({
        users,
        posts: table({
          id: int.auto,
          author: users,
          count: int.default(3),
          state: oneOf("draft", "done").default("draft"),
        }).checks((post) => ({ positive: post.count.atLeast(1) })),
      });
      await generateMigration({
        directory,
        name: "initial",
        snapshot: model.$snapshot(),
      });
      const runner = migrator({ driver, directory, metadataSchema: namespace });
      await runner.migrate();

      const drift = () =>
        detectDrift({
          execute: driver.execute,
          snapshot: model.$snapshot(),
          metadataSchema: namespace,
        });

      expect(await drift()).toEqual([]);

      for (const sql of [
        "ALTER TABLE posts ALTER COLUMN count SET DEFAULT 4",
        "ALTER TABLE users ALTER COLUMN id SET GENERATED BY DEFAULT",
        "ALTER TABLE users DROP CONSTRAINT users_name_key",
        "ALTER TABLE posts DROP CONSTRAINT posts_author_id_fkey",
        "ALTER TABLE posts ADD CONSTRAINT posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON UPDATE CASCADE NOT VALID",
        "ALTER TABLE posts DROP CONSTRAINT posts_positive_check",
        "ALTER TABLE posts ADD CONSTRAINT posts_positive_check CHECK (count >= 0) NOT VALID",
        "CREATE INDEX unrelated_key ON users(name)",
        "ALTER TYPE posts_state_enum ADD VALUE 'active' BEFORE 'done'",
      ]) {
        await driver.execute({ sql, parameters: [] });
      }

      expect((await drift()).map((finding) => finding.kind)).toEqual(
        expect.arrayContaining([
          "default-mismatch",
          "identity-mismatch",
          "missing-constraint",
          "constraint-mismatch",
          "invalid-constraint",
          "extra-index",
          "enum-mismatch",
        ]),
      );
      await expect(runner.adopt()).rejects.toThrow(/schema does not match/);
      expect((await runner.status())[0]?.status).toBe("applied");
    }));

  test("online constraints validate existing data and finish with the declared catalog", () =>
    sandbox(async ({ driver, directory, namespace }) => {
      const first = schema({ records: { id: int, name: text.nullable } });
      const second = schema({
        records: table({ id: int, name: text.unique }).checks((record) => ({
          name: record.name.isNot(""),
        })),
      });
      await generateMigration({
        directory,
        name: "initial",
        snapshot: first.$snapshot(),
      });
      const runner = migrator({ driver, directory, metadataSchema: namespace });
      await runner.migrate();
      await driver.execute({
        sql: "INSERT INTO records VALUES (1, 'retained')",
        parameters: [],
      });
      const migration = (await generateMigration({
        directory,
        name: "validate",
        snapshot: second.$snapshot(),
        online: true,
      }))!;
      expect(migration.up).toContain("NOT VALID");
      expect(migration.up).toContain("VALIDATE CONSTRAINT");
      expect(migration.up).toContain("UNIQUE USING INDEX");
      await runner.migrate();
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: second.$snapshot(),
          metadataSchema: namespace,
        }),
      ).toEqual([]);
    }));

  test(
    "verify runs real SQL, populated hooks and rollback checks in disposable databases",
    () =>
      sandbox(async ({ directory, namespace }) => {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({
            records: { id: int.auto, name: text },
          }).$snapshot(),
        });
        const added = (await generateMigration({
          directory,
          name: "note",
          snapshot: schema({
            records: { id: int.auto, name: text, note: text.nullable },
          }).$snapshot(),
        }))!;
        const phases: string[] = [];
        expect(
          await verifyMigrations({
            directory,
            url: url!,
            schemaName: namespace,
            metadataSchema: namespace,
            beforeMigration: async ({ driver, migration, phase }) => {
              phases.push(`${migration}:${phase}`);

              if (migration === added.id && phase === "up") {
                await driver.execute({
                  sql: "INSERT INTO records(name) VALUES ('retained')",
                  parameters: [],
                });
              }
            },
            afterMigration: async ({ driver, migration }) => {
              if (migration === added.id) {
                expect(
                  await driver.execute({
                    sql: "SELECT name FROM records",
                    parameters: [],
                  }),
                ).toMatchObject({ rows: [{ name: "retained" }] });
              }
            },
          }),
        ).toMatchObject({ verified: true });
        expect(phases).toHaveLength(6);
        await writeFile(
          join(directory, added.id, "down.sql"),
          "-- deliberately broken rollback",
        );
        await expect(
          verifyMigrations({ directory, url: url! }),
        ).rejects.toThrow(/rollback.*catalog/);
        await writeFile(
          join(directory, added.id, "up.sql"),
          "-- schema and SQL diverge",
        );
        await expect(
          verifyMigrations({ directory, url: url! }),
        ).rejects.toThrow(/missing-column/);
      }),
    30000,
  );
});
