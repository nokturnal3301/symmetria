import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  junction,
  schema,
  table,
  int,
  text,
  varchar,
  bigint,
  bool,
  jsonb,
  timestamptz,
  oneOf,
  index,
  sql,
} from "../../../packages/runtime/src";
import { postgres } from "../../../packages/runtime/src/driver";
import {
  createSchemaSQL,
  detectDrift,
  diffSchemas,
  emptySnapshot,
  generateMigration,
  loadMigrationState,
  migrator,
  squashMigrations,
  type DriftFinding,
} from "../../../packages/kit/src";
import { migrationDirectory } from "../../support/directories";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL migrations", () => {
  const driver = postgres({
    url: databaseUrl ?? "postgres://localhost/postgres",
    max: 1,
  });
  const secondDriver = postgres({
    url: databaseUrl ?? "postgres://localhost/postgres",
    max: 1,
  });
  const namespace = `symmetria_migrate_${crypto.randomUUID().replaceAll("-", "")}`;
  let directory: string;

  const execute = async (statement: string, parameters: unknown[] = []) => {
    const result = await driver.execute({ sql: statement, parameters });

    return Array.isArray(result) ? result : result.rows;
  };

  const runner = () =>
    migrator({ driver, directory, metadataSchema: namespace });

  const catalog = async () => ({
    columns: await execute(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, is_identity
      FROM information_schema.columns WHERE table_schema = $1 AND table_name <> '_symmetria_migrations' ORDER BY table_name, column_name`,
      [namespace],
    ),
    constraints: await execute(
      `SELECT relation.relname, constraint_definition.conname, pg_get_constraintdef(constraint_definition.oid) AS definition
      FROM pg_constraint constraint_definition JOIN pg_class relation ON relation.oid = constraint_definition.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname <> '_symmetria_migrations'
      ORDER BY relation.relname, constraint_definition.conname`,
      [namespace],
    ),
    indexes: await execute(
      "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename <> '_symmetria_migrations' ORDER BY tablename, indexname",
      [namespace],
    ),
    enumerations: await execute(
      `SELECT type.typname, enumeration.enumlabel, enumeration.enumsortorder FROM pg_type type
      JOIN pg_enum enumeration ON enumeration.enumtypid = type.oid JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1 ORDER BY type.typname, enumeration.enumsortorder`,
      [namespace],
    ),
  });

  beforeAll(async () => {
    await execute(`SET search_path TO "${namespace}"`);
    await secondDriver.execute({
      sql: `SET search_path TO "${namespace}"`,
      parameters: [],
    });
  });
  beforeEach(async () => {
    directory = await migrationDirectory();
    await execute(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await execute(`CREATE SCHEMA "${namespace}"`);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    try {
      await execute(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await Promise.all([driver.close(), secondDriver.close()]);
    }
  });

  test("generated DDL supports defaults, enums, composite keys, cyclic and self foreign keys", async () => {
    const model = schema(
      {
        users: ({ teams }) => ({
          id: int.auto,
          email: text.unique,
          status: oneOf("active", "disabled").default("active"),
          team: teams.nullable,
          balance: bigint.default(9007199254740993n),
          settings: jsonb<{ theme: string }>().default({ theme: "dark" }),
          createdAt: timestamptz.default(new Date("2026-01-01T00:00:00Z")),
        }),
        teams: ({ users }) => ({ id: int.auto, owner: users.nullable }),
        tags: { id: int.auto, name: text },
        userTags: ({ users, tags }) => junction({ user: users, tag: tags }),
        categories: ({ categories }) => ({
          id: int.auto,
          parent: categories.nullable.inverse("children"),
        }),
      },
      {
        driver,
        indexes: ({ users }) => ({
          byStatus: index(users.status),
          emailLower: index(sql<string>`lower(${users.email})`).unique,
        }),
      },
    );
    await driver.transaction!(async (transaction) => {
      for (const query of createSchemaSQL(model.$snapshot())) {
        await transaction.execute(query);
      }
    });
    const rows = await model.users
      .insert({ email: "Ada" })
      .returning((users) => [
        users.id,
        users.status,
        users.balance,
        users.settings,
        users.createdAt,
      ])
      .execute();
    expect(rows).toEqual({
      id: 1,
      status: "active",
      balance: 9007199254740993n,
      settings: { theme: "dark" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await expect(
      model.users.insert({ email: "ada" }).execute(),
    ).rejects.toThrow();
    await model.tags.insert({ name: "sql" }).execute();
    await model.userTags.insert({ userId: 1, tagId: 1 }).execute();
    await expect(
      model.userTags.insert({ userId: 1, tagId: 1 }).execute(),
    ).rejects.toThrow();
    await expect(
      model.categories.insert({ parentId: 999 }).execute(),
    ).rejects.toThrow();
    await model.categories.insert({}).execute();
    await model.categories.insert({ parentId: 2 }).execute();
    await driver.transaction!(async (transaction) => {
      for (const sql of diffSchemas(model.$snapshot(), emptySnapshot()).up) {
        await transaction.execute({ sql, parameters: [] });
      }
    });
    expect((await catalog()).columns).toEqual([]);
  });

  test("generate -> migrate -> rename/type/index changes -> rollback restores the catalog and retained data", async () => {
    const first = schema(
      {
        accounts: {
          id: int.auto,
          email: text.unique,
          state: oneOf("active", "disabled").default("active"),
          score: int.default(1),
        },
        posts: ({ accounts }) => ({
          id: int.auto,
          account: accounts,
          title: text,
          legacy: text.nullable,
        }),
      },
      {
        driver,
        indexes: ({ accounts, posts }) => ({
          accountsByState: index(accounts.state),
          postsByAccount: index(posts.accountId).include(posts.title),
        }),
      },
    );
    const initial = await generateMigration({
      directory,
      name: "initial",
      snapshot: first.$snapshot(),
    });
    expect((await runner().status())[0]?.status).toBe("pending");
    expect(await runner().migrate()).toEqual([initial!.id]);
    await first.accounts.insert({ email: "Ada" }).execute();
    await first.posts
      .insert({ accountId: 1, title: "SQL first", legacy: "old data" })
      .execute();
    const baseline = await catalog();
    const second = schema(
      {
        members: {
          id: int.auto,
          address: text.unique,
          state: oneOf("active", "disabled", "paused").default("paused"),
          score: bigint.default(1n),
        },
        posts: ({ members }) => ({
          id: int.auto,
          account: members,
          title: varchar(80),
          published: bool.default(false),
        }),
      },
      {
        driver,
        indexes: ({ members, posts }) => ({
          accountsByState: index(members.state),
          postsByAccount: index(posts.accountId, posts.title.descending),
        }),
      },
    );
    const changed = await generateMigration({
      directory,
      name: "members",
      snapshot: second.$snapshot(),
      renames: {
        tables: { accounts: "members" },
        columns: { members: { email: "address" } },
      },
    });
    expect(await runner().migrate()).toEqual([changed!.id]);
    expect(
      await second
        .members((members) => ({
          address: members.address,
          state: members.state,
          score: members.score,
        }))
        .execute(),
    ).toEqual([{ address: "Ada", state: "active", score: 1n }]);
    expect(
      await second
        .posts((posts) => ({
          id: posts.id,
          title: posts.title,
          published: posts.published,
          accountId: posts.accountId,
          account: posts.account((account) => ({
            id: account.id,
            address: account.address,
            state: account.state,
            score: account.score,
          })),
        }))
        .execute(),
    ).toMatchObject([
      { title: "SQL first", published: false, account: { address: "Ada" } },
    ]);
    expect(
      await second.members
        .insert({ address: "New" })
        .returning((members) => [members.state])
        .execute(),
    ).toEqual({ state: "paused" });
    await second.members
      .delete()
      .where((members) => members.address.is("New"))
      .execute();
    expect(await runner().rollback()).toEqual([changed!.id]);
    expect(await catalog()).toEqual(baseline);
    expect(await execute("SELECT email, score FROM accounts")).toEqual([
      { email: "Ada", score: 1 },
    ]);
    expect(await execute("SELECT title, legacy FROM posts")).toEqual([
      { title: "SQL first", legacy: null },
    ]);
    expect(await runner().migrate()).toEqual([changed!.id]);
    expect(await runner().rollback({ steps: 2 })).toEqual([
      changed!.id,
      initial!.id,
    ]);
    expect((await catalog()).columns).toEqual([]);
    expect((await runner().status()).map((entry) => entry.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  test("fluent table indexes are generated, enforce partial uniqueness and roll back independently", async () => {
    const records = table({
      id: int.auto,
      email: text,
      active: bool.default(true),
    });
    const initial = schema({ records }, { driver });
    await generateMigration({
      directory,
      name: "initial",
      snapshot: initial.$snapshot(),
    });
    await runner().migrate();
    await initial.records.insert({ email: "Ada" }).execute();
    const indexed = schema(
      {
        records: records.indexes((records) => ({
          activeEmail: index(sql<string>`lower(${records.email})`).unique.where(
            records.active.is(true),
          ),
          byActivity: index(records.active, records.id.descending).include(
            records.email,
          ),
        })),
      },
      { driver },
    );
    const migration = await generateMigration({
      directory,
      name: "indexes",
      snapshot: indexed.$snapshot(),
    });
    expect(migration?.up).toContain(
      'CREATE UNIQUE INDEX "records_active_email_idx"',
    );
    await runner().migrate();
    expect((await catalog()).indexes.map((row) => row.indexname)).toContain(
      "records_by_activity_idx",
    );
    await expect(
      indexed.records.insert({ email: "ada" }).execute(),
    ).rejects.toThrow();
    await indexed.records.insert({ email: "ada", active: false }).execute();
    expect(await runner().rollback()).toEqual([migration!.id]);
    expect((await catalog()).indexes.map((row) => row.indexname)).toEqual([
      "records_pkey",
    ]);
    await initial.records.insert({ email: "ada" }).execute();
    expect(
      await execute("SELECT email, active FROM records ORDER BY id"),
    ).toEqual([
      { email: "Ada", active: true },
      { email: "ada", active: false },
      { email: "ada", active: true },
    ]);
  });

  test("same-name enum replacement applies new defaults atomically and narrowing failure rolls back cleanly", async () => {
    const first = schema(
      { records: { id: int.auto, status: oneOf("draft").default("draft") } },
      { driver },
    );
    await generateMigration({
      directory,
      name: "initial",
      snapshot: first.$snapshot(),
    });
    await runner().migrate();
    await first.records.insert({}).execute();
    const second = schema(
      {
        records: {
          id: int.auto,
          status: oneOf("draft", "archived").default("archived"),
        },
      },
      { driver },
    );
    await generateMigration({
      directory,
      name: "archive",
      snapshot: second.$snapshot(),
    });
    await runner().migrate();
    expect(
      await second.records
        .insert({})
        .returning((records) => [records.status])
        .execute(),
    ).toEqual({ status: "archived" });
    const baseline = await catalog();
    await expect(runner().rollback()).rejects.toThrow(/failed \(down\)/);
    expect(await catalog()).toEqual(baseline);
    expect((await runner().status()).map((entry) => entry.status)).toEqual([
      "applied",
      "applied",
    ]);
    await second.records
      .delete()
      .where((records) => records.status.is("archived"))
      .execute();
    await runner().rollback();
    expect(await execute("SELECT status FROM records")).toEqual([
      { status: "draft" },
    ]);
  });

  test("CHECK constraints and explicit keys survive renames, type changes and rollback", async () => {
    const first = schema(
      {
        tenants: table({ code: text.index, title: text }).primaryKey(
          (tenants) => [tenants.code],
        ),
        records: ({ tenants }) =>
          table({
            tenant: tenants.index,
            externalId: text,
            stock: int,
            state: oneOf("draft", "published"),
          })
            .primaryKey((records) => [records.externalId, records.tenantId])
            .checks((records) => ({
              stock: records.stock.atLeast(0),
              state: records.state.isNot("draft"),
            })),
      },
      { driver },
    );
    await generateMigration({
      directory,
      name: "initial",
      snapshot: first.$snapshot(),
    });
    await runner().migrate();
    await first.tenants.insert({ code: "team", title: "Team" }).execute();
    await first.records
      .insert({
        tenantId: "team",
        externalId: "first",
        stock: 3,
        state: "published",
      })
      .execute();
    await expect(
      first.records
        .insert({
          tenantId: "team",
          externalId: "negative",
          stock: -1,
          state: "published",
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      first.records
        .insert({
          tenantId: "team",
          externalId: "first",
          stock: 1,
          state: "published",
        })
        .execute(),
    ).rejects.toThrow();
    const baseline = await catalog();
    expect(baseline.indexes.map((row) => row.indexname)).toEqual([
      "records_pkey",
      "records_tenant_id_idx",
      "tenants_pkey",
    ]);
    expect(
      baseline.constraints.find((row) => row.conname === "records_pkey")
        ?.definition,
    ).toBe("PRIMARY KEY (external_id, tenant_id)");
    expect(
      await first
        .records((records) => ({
          state: records.state,
          externalId: records.externalId,
          stock: records.stock,
          tenantId: records.tenantId,
          tenant: records.tenant((tenant) => ({
            title: tenant.title,
            code: tenant.code,
          })),
        }))
        .execute(),
    ).toMatchObject([{ tenant: { code: "team", title: "Team" } }]);
    const second = schema(
      {
        tenants: table({ code: text.index, title: text }).primaryKey(
          (tenants) => [tenants.code],
        ),
        inventory: ({ tenants }) =>
          table({
            tenant: tenants.index,
            externalId: text,
            quantity: bigint,
            state: oneOf("draft", "published", "archived"),
          })
            .primaryKey((inventory) => [
              inventory.tenantId,
              inventory.externalId,
            ])
            .checks((inventory) => ({
              stock: inventory.quantity.atLeast(0n),
              state: inventory.state.isNot("draft"),
            })),
      },
      { driver },
    );
    await generateMigration({
      directory,
      name: "inventory",
      snapshot: second.$snapshot(),
      renames: {
        tables: { records: "inventory" },
        columns: { inventory: { stock: "quantity" } },
      },
    });
    await runner().migrate();
    expect(
      await second
        .inventory((inventory) => ({ quantity: inventory.quantity }))
        .execute(),
    ).toEqual([{ quantity: 3n }]);
    await expect(
      second.inventory
        .insert({
          tenantId: "team",
          externalId: "negative",
          quantity: -1n,
          state: "published",
        })
        .execute(),
    ).rejects.toThrow();
    await runner().rollback();
    expect(await catalog()).toEqual(baseline);
    expect(
      await first.records((records) => ({ stock: records.stock })).execute(),
    ).toEqual([{ stock: 3 }]);
  });

  test("a failed batch rolls back both schema changes and migration history", async () => {
    const model = schema({ records: { id: int.auto, name: text } });
    await generateMigration({
      directory,
      name: "initial",
      snapshot: model.$snapshot(),
    });
    const invalid = await generateMigration({
      directory,
      name: "broken",
      empty: true,
    });
    await writeFile(
      join(directory, invalid!.id, "up.sql"),
      "INSERT INTO records (name) VALUES ('before failure'); SELECT missing_column FROM records;",
    );
    await expect(runner().migrate()).rejects.toThrow(invalid!.id);
    expect(
      await execute("SELECT to_regclass('records')::text AS name"),
    ).toEqual([{ name: null }]);
    expect(
      await execute(
        "SELECT to_regclass('_symmetria_migrations')::text AS name",
      ),
    ).toEqual([{ name: null }]);
    await writeFile(
      join(directory, invalid!.id, "up.sql"),
      "INSERT INTO records (name) VALUES ('fixed');",
    );
    expect(await runner().migrate()).toHaveLength(2);
    expect(await execute("SELECT name FROM records")).toEqual([
      { name: "fixed" },
    ]);
  });

  test("targeted migration and rollback use the journal without changing the shared snapshot", async () => {
    const first = schema({ records: { id: int.auto } });
    const second = schema({ records: { id: int.auto, name: text.nullable } });
    const initial = (await generateMigration({
      directory,
      name: "initial",
      snapshot: first.$snapshot(),
    }))!;
    const added = (await generateMigration({
      directory,
      name: "name",
      snapshot: second.$snapshot(),
    }))!;

    const readMetadata = () =>
      Promise.all(
        ["migration.json", "snapshot.json"].map((file) =>
          readFile(join(directory, "meta", file), "utf8"),
        ),
      );

    const metadata = await readMetadata();
    expect(await runner().migrate({ to: initial.id })).toEqual([initial.id]);
    expect((await runner().status()).map((entry) => entry.status)).toEqual([
      "applied",
      "pending",
    ]);
    expect(
      (await catalog()).columns.map((column) => column.column_name),
    ).toEqual(["id"]);
    expect(await runner().adopt()).toEqual([initial.id]);
    expect(await runner().migrate()).toEqual([added.id]);
    expect(await runner().rollback()).toEqual([added.id]);
    expect(
      (await catalog()).columns.map((column) => column.column_name),
    ).toEqual(["id"]);
    expect(await readMetadata()).toEqual(metadata);
    expect(
      await generateMigration({
        directory,
        name: "unchanged",
        snapshot: second.$snapshot(),
      }),
    ).toBeNull();
    expect(await runner().migrate()).toEqual([added.id]);
    expect(await runner().rollback({ steps: 2 })).toEqual([
      added.id,
      initial.id,
    ]);
    expect((await catalog()).columns).toEqual([]);
    expect(await readMetadata()).toEqual(metadata);
  });

  test("checksums reject edits to applied up/down SQL before executing any further migrations", async () => {
    const model = schema({ records: { id: int.auto } });
    const initial = await generateMigration({
      directory,
      name: "initial",
      snapshot: model.$snapshot(),
    });
    await runner().migrate();
    const path = join(directory, initial!.id, "down.sql");
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}\n-- modified\n`);
    await expect(runner().status()).rejects.toThrow(/checksum mismatch/);
    await expect(runner().rollback()).rejects.toThrow(/checksum mismatch/);
    await writeFile(path, original);
    expect(await runner().migrate()).toEqual([]);
  });

  test("adopt preserves the applied boundary across data-only migrations with equal schema hashes", async () => {
    const initial = (await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ records: { id: int.auto, name: text } }).$snapshot(),
    }))!;
    const seed = (await generateMigration({
      directory,
      name: "seed",
      empty: true,
    }))!;
    const pending = (await generateMigration({
      directory,
      name: "pending",
      empty: true,
    }))!;
    await writeFile(
      join(directory, seed.id, "up.sql"),
      "INSERT INTO records (name) VALUES ('seed');",
    );
    await writeFile(
      join(directory, pending.id, "up.sql"),
      "INSERT INTO records (name) VALUES ('pending');",
    );
    await runner().migrate({ to: seed.id });

    expect(await runner().adopt()).toEqual([initial.id, seed.id]);
    expect(await runner().migrate()).toEqual([pending.id]);
    expect(await execute("SELECT name FROM records ORDER BY id")).toEqual([
      { name: "seed" },
      { name: "pending" },
    ]);
    expect(await runner().adopt()).toEqual([initial.id, seed.id, pending.id]);
    expect(await runner().migrate()).toEqual([]);
  });

  test("adopt rejects ambiguous snapshot matches after squash without rewriting history", async () => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ records: { id: int.auto, name: text } }).$snapshot(),
    });
    await generateMigration({ directory, name: "empty", empty: true });
    await runner().migrate();
    const history = await execute(
      'SELECT id FROM "_symmetria_migrations" ORDER BY id',
    );
    const baseline = (await squashMigrations({ directory, name: "baseline" }))!;
    const seed = (await generateMigration({
      directory,
      name: "empty",
      empty: true,
    }))!;
    await writeFile(
      join(directory, seed.id, "up.sql"),
      "INSERT INTO records (name) VALUES ('seed');",
    );

    // Reusing an old ID with different SQL must not identify it as already applied.
    await expect(runner().adopt()).rejects.toThrow(/multiple local migrations/);
    expect(
      await execute('SELECT id FROM "_symmetria_migrations" ORDER BY id'),
    ).toEqual(history);
    expect(await runner().adopt({ to: baseline.id })).toEqual([baseline.id]);
    expect(await runner().migrate()).toEqual([seed.id]);
    expect(await execute("SELECT name FROM records")).toEqual([
      { name: "seed" },
    ]);
  });

  test("two concurrent runners serialize initialization and apply each migration once", async () => {
    const model = schema({ records: { id: int.auto, name: text } });
    await generateMigration({
      directory,
      name: "initial",
      snapshot: model.$snapshot(),
    });
    const seed = await generateMigration({
      directory,
      name: "seed",
      empty: true,
    });
    await writeFile(
      join(directory, seed!.id, "up.sql"),
      "INSERT INTO records (name) VALUES ('once');",
    );
    const second = migrator({
      driver: secondDriver,
      directory,
      metadataSchema: namespace,
    });
    const results = await Promise.all([runner().migrate(), second.migrate()]);
    expect(results.map((result) => result.length).sort()).toEqual([0, 2]);
    expect(await execute("SELECT name FROM records")).toEqual([
      { name: "once" },
    ]);
    expect(
      (await runner().status()).every((entry) => entry.status === "applied"),
    ).toBe(true);
  });

  test("manual SQL supports dollar-quoted bodies and semicolons inside literals", async () => {
    const model = schema({ records: { id: int.auto, name: text } });
    await generateMigration({
      directory,
      name: "initial",
      snapshot: model.$snapshot(),
    });
    const seed = await generateMigration({
      directory,
      name: "seed",
      empty: true,
    });
    await writeFile(
      join(directory, seed!.id, "up.sql"),
      `DO $body$ BEGIN INSERT INTO records (name) VALUES ('one;two'); END $body$;
      INSERT INTO records (name) VALUES (E'quote\\';backslash\\\\'); -- trailing ;\n`,
    );
    await writeFile(
      join(directory, seed!.id, "down.sql"),
      "DELETE FROM records;",
    );
    await runner().migrate({ to: seed!.id });
    expect(await execute("SELECT name FROM records ORDER BY id")).toEqual([
      { name: "one;two" },
      { name: "quote';backslash\\" },
    ]);
    await runner().rollback();
    expect(await execute("SELECT name FROM records")).toEqual([]);
  });

  test("promoting an existing primary key to identity resumes above existing values", async () => {
    const first = schema({ records: { id: int, name: text } });
    const second = schema(
      { records: { id: int.auto, name: text } },
      { driver },
    );

    for (const query of createSchemaSQL(first.$snapshot())) {
      await driver.execute(query);
    }

    await execute("INSERT INTO records (id, name) VALUES (12, 'existing')");
    const plan = diffSchemas(first.$snapshot(), second.$snapshot());
    await driver.transaction!(async (transaction) => {
      for (const sql of plan.up) {
        await transaction.execute({ sql, parameters: [] });
      }
    });
    expect(
      await second.records
        .insert({ name: "next" })
        .returning((records) => [records.id])
        .execute(),
    ).toEqual({ id: 13 });
    await driver.transaction!(async (transaction) => {
      for (const sql of plan.down) {
        await transaction.execute({ sql, parameters: [] });
      }
    });
    expect(await execute("SELECT id FROM records ORDER BY id")).toEqual([
      { id: 12 },
      { id: 13 },
    ]);
  });

  test("primary-key type changes rebuild incoming foreign keys in dependency order", async () => {
    const first = schema(
      {
        parents: { id: int.auto },
        children: ({ parents }) => ({ id: int.auto, parent: parents }),
      },
      { driver },
    );
    const second = schema(
      {
        parents: { id: bigint },
        children: ({ parents }) => ({ id: int.auto, parent: parents }),
      },
      { driver },
    );
    await generateMigration({
      directory,
      name: "initial",
      snapshot: first.$snapshot(),
    });
    await runner().migrate();
    await first.parents.insert({}).execute();
    await first.children.insert({ parentId: 1 }).execute();
    await generateMigration({
      directory,
      name: "big_identifiers",
      snapshot: second.$snapshot(),
    });
    await runner().migrate();
    expect(
      await second
        .children((children) => ({ parentId: children.parentId }))
        .execute(),
    ).toEqual([{ parentId: 1n }]);
    await expect(
      second.children.insert({ parentId: 999n }).execute(),
    ).rejects.toThrow();
    await runner().rollback();
    expect(
      await first.parents
        .insert({})
        .returning((parents) => [parents.id])
        .execute(),
    ).toEqual({ id: 2 });
  });

  test("enum primary keys and referencing columns migrate together", async () => {
    const first = schema(
      {
        codes: { id: oneOf("first", "second") },
        records: ({ codes }) => ({ id: int.auto, code: codes }),
      },
      { driver },
    );
    const second = schema(
      {
        codes: { id: oneOf("second", "first", "third") },
        records: ({ codes }) => ({ id: int.auto, code: codes }),
      },
      { driver },
    );
    await generateMigration({
      directory,
      name: "initial",
      snapshot: first.$snapshot(),
    });
    await runner().migrate();
    await first.codes.insert({ id: "first" }).execute();
    await first.records.insert({ codeId: "first" }).execute();
    await generateMigration({
      directory,
      name: "more_codes",
      snapshot: second.$snapshot(),
    });
    await runner().migrate();
    expect(
      await second
        .records((records) => ({
          id: records.id,
          codeId: records.codeId,
          code: records.code((code) => ({ id: code.id })),
        }))
        .execute(),
    ).toEqual([{ id: 1, codeId: "first", code: { id: "first" } }]);
    await runner().rollback();
    expect(
      await first.records((records) => ({ codeId: records.codeId })).execute(),
    ).toEqual([{ codeId: "first" }]);
  });

  test("CLI migrate/status/rollback use the persisted files and return failure exit codes", async () => {
    const model = schema({ cliRecords: { id: int.auto, name: text } });
    const snapshot = model.$snapshot();
    // CLI uses its own connection; create a separate schema-qualified search_path
    // in config by passing a connection URL with PostgreSQL startup options.
    const config = join(directory, "config.ts");
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${namespace}`);
    await writeFile(
      config,
      `export default ${JSON.stringify({ schema: snapshot, directory: "files", databaseUrl: url.toString(), metadataSchema: namespace })};\n`,
    );

    const run = async (...argumentsList: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve("packages/kit/src/cli.ts"),
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

    expect(await run("generate", "cli")).toMatchObject({
      exitCode: 0,
      stdout: "Generated 000001_cli\n",
    });
    expect(await run("migrate")).toMatchObject({
      exitCode: 0,
      stdout: "Applied 000001_cli\n",
    });
    expect((await run("status")).stdout).toContain("applied 000001_cli");
    expect(
      (await execute("SELECT to_regclass('cli_records')::text AS name"))[0]
        ?.name,
    ).toBe("cli_records");
    expect(await run("rollback")).toMatchObject({
      exitCode: 0,
      stdout: "Reverted 000001_cli\n",
    });
    expect((await run("rollback", "--steps", "0")).exitCode).toBe(1);
    expect(
      (await loadMigrationState(join(directory, "files"))).snapshot.tables[0]
        ?.name,
    ).toBe("cli_records");
  });

  test("drift detection reports manual changes and adopt re-baselines history after a squash", async () => {
    const first = schema({
      users: { id: int.auto, email: text.unique, name: text },
    });
    const second = schema({
      users: {
        id: int.auto,
        email: text.unique,
        name: text,
        age: int.nullable,
      },
      tags: { id: int.auto, label: text },
    });
    await generateMigration({
      directory,
      name: "users",
      snapshot: first.$snapshot(),
    });
    await generateMigration({
      directory,
      name: "tags",
      snapshot: second.$snapshot(),
    });
    expect(await runner().migrate()).toHaveLength(2);

    const sorted = (findings: readonly DriftFinding[]) =>
      [...findings].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );

    const drift = () =>
      detectDrift({
        execute: driver.execute,
        snapshot: second.$snapshot(),
        schemaName: namespace,
      });

    expect(await drift()).toEqual([]);
    await execute(`ALTER TABLE "users" ADD COLUMN "manual" text`);
    await execute(`ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL`);
    await execute(`ALTER TABLE "tags" ALTER COLUMN "label" TYPE varchar(10)`);
    await execute(`CREATE INDEX "tags_manual_idx" ON "tags" ("label")`);
    await execute(`CREATE TABLE "scratch" ("id" int)`);
    expect(sorted(await drift())).toEqual(
      sorted([
        {
          kind: "nullability-mismatch",
          table: "users",
          column: "name",
          expected: "NOT NULL",
          actual: "NULL",
        },
        { kind: "extra-column", table: "users", column: "manual" },
        {
          kind: "type-mismatch",
          table: "tags",
          column: "label",
          expected: "text",
          actual: "character varying(10)",
        },
        { kind: "extra-index", table: "tags", actual: "tags_manual_idx" },
        { kind: "extra-table", table: "scratch" },
      ]),
    );
    await execute(`DROP TABLE "scratch"`);
    await execute(`DROP INDEX "tags_manual_idx"`);
    expect((await drift()).map((finding) => finding.kind).sort()).toEqual([
      "extra-column",
      "nullability-mismatch",
      "type-mismatch",
    ]);
    const squashed = await squashMigrations({ directory, name: "baseline" });
    expect(squashed?.id).toBe("000001_baseline");
    await expect(runner().status()).rejects.toThrow(/missing or out of order/);
    expect(await runner().adopt()).toEqual(["000001_baseline"]);
    expect(await runner().status()).toMatchObject([
      { id: "000001_baseline", status: "applied" },
    ]);
    expect(await runner().migrate()).toEqual([]);
    const third = schema({
      users: {
        id: int.auto,
        email: text.unique,
        name: text,
        age: int.nullable,
      },
      tags: { id: int.auto, label: text },
      notes: { id: int.auto, body: text },
    });
    await generateMigration({
      directory,
      name: "notes",
      snapshot: third.$snapshot(),
    });
    expect(await runner().migrate()).toEqual(["000002_notes"]);
    await expect(runner().adopt({ to: "000009_missing" })).rejects.toThrow(
      /unknown migration target/,
    );
  });
});
