import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  int,
  text,
  bigint,
  bool,
  bytea,
  numeric,
  timestamptz,
  jsonb,
  NotFoundError,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import { postgres } from "../../support/postgres";
import { testDatabase } from "../../../packages/kit/src/testing";

const users = table({
  id: int.auto,
  name: text,
  tenant: int.default(1),
  posts: many,
});
const posts = table({
  id: int.auto,
  title: text,
  author: one(users.posts),
  views: bigint.default(0n),
  price: numeric(12, 2).default("0"),
  published: bool.default(false),
  at: timestamptz,
  raw: bytea.nullable,
  meta: jsonb<{ tags: string[] }>().nullable,
});
const model = schema({ users, posts });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("$batch on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;
  const sent: CompiledQuery[] = [];
  const at = new Date("2026-03-05T10:20:30.123Z");

  beforeAll(async () => {
    // Every statement the database sends is recorded.
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_batch",
      driver: (options) => {
        const driver = postgres(options);

        return {
          ...driver,
          execute: (query: CompiledQuery) => {
            sent.push(query);

            return driver.execute(query);
          },
        } as typeof driver;
      },
    });
    database = isolated.database;
    await database.users.insert([{ name: "Ada" }, { name: "Bob", tenant: 2 }]);
    await database.posts.insert([
      {
        title: "Notes",
        authorId: 1,
        views: 9007199254740993n,
        price: "10.50",
        published: true,
        at,
        raw: new Uint8Array([0, 1, 255]),
        meta: { tags: ["a"] },
      },
      { title: "Engine", authorId: 1, at },
      { title: "Draft", authorId: 2, at },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("several reads are one statement and each keeps its own result", async () => {
    sent.length = 0;

    const [user, list, total, exists, missing, totals, whole] =
      await database.$batch((db) => [
        db.users.get(1),
        db.posts(
          (post) => ({
            title: post.title,
            author: post.author.name,
            views: post.views,
          }),
          { where: { authorId: 1 }, orderBy: { id: "asc" } },
        ),
        db.posts({ where: { published: true } }).count(),
        db.users({ where: { name: "Nobody" } }).exists(),
        db.users.find(99),
        db.posts.aggregate((post, { sum, maximum }) => ({
          price: sum(post.price),
          last: maximum(post.at),
        })),
        db.posts({ where: { id: 1 } }),
      ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).toStartWith("SELECT (SELECT COALESCE(json_agg(");
    expect(user).toEqual({ id: 1, name: "Ada", tenant: 1 });
    expect(list).toEqual([
      { title: "Notes", author: "Ada", views: 9007199254740993n },
      { title: "Engine", author: "Ada", views: 0n },
    ]);
    expect(total).toBe(1);
    expect(exists).toBe(false);
    expect(missing).toBeNull();
    expect(totals).toEqual({ price: "10.50", last: at });
    // Every column type survives the trip, as in a nested read.
    expect(whole).toEqual([
      {
        id: 1,
        title: "Notes",
        authorId: 1,
        views: 9007199254740993n,
        price: "10.50",
        published: true,
        at,
        raw: new Uint8Array([0, 1, 255]),
        meta: { tags: ["a"] },
      },
    ]);
  });

  test("an object of reads, nested results and queries that were not awaited", async () => {
    sent.length = 0;

    const page = await database.$batch((db) => ({
      authors: db.users(
        (user) => ({
          name: user.name,
          posts: user.posts((post) => ({ title: post.title }), {
            orderBy: { id: "asc" },
            limit: 1,
          }),
        }),
        { orderBy: { id: "asc" } },
      ),
      drafts: db.posts({ where: { published: false } }).count(),
      label: "plain values pass through",
    }));

    expect(sent).toHaveLength(1);
    expect(page).toEqual({
      authors: [
        { name: "Ada", posts: [{ title: "Notes" }] },
        { name: "Bob", posts: [{ title: "Draft" }] },
      ],
      drafts: 2,
      label: "plain values pass through",
    });
  });

  test("a failing read fails alone; scopes and transactions apply", async () => {
    sent.length = 0;

    const outcome = await database.$batch((db) => [
      db.users.get(99).catch((error: unknown) => error),
      db.posts.count(),
      db.users
        .byId(1.5 as never)
        .one()
        .catch((error: Error) => error.message),
    ]);

    expect(outcome[0]).toBeInstanceOf(NotFoundError);
    expect(outcome[1]).toBe(3);
    expect(outcome[2]).toContain("integer values are integers");
    expect(sent).toHaveLength(1);

    let tenant = 1;
    const scoped = database.$scope({ users: (user) => user.tenant.is(tenant) });
    const names = () =>
      scoped.$batch((db) => [
        db.users((user) => ({ name: user.name })),
        db.users.count(),
      ]);

    expect(await names()).toEqual([[{ name: "Ada" }], 1]);
    tenant = 2;
    expect(await names()).toEqual([[{ name: "Bob" }], 1]);

    // Inside a transaction the batch sees its uncommitted rows, in one statement.
    await database
      .$transaction(async (transaction) => {
        await transaction.users.insert({ name: "Cy" });
        sent.length = 0;
        expect(
          await transaction.$batch((db) => [
            db.users.count(),
            db.users({ where: { name: "Cy" } }).exists(),
          ]),
        ).toEqual([3, true]);
        expect(sent).toHaveLength(1);

        throw new Error("rollback");
      })
      .catch(() => {});
    expect(await database.users.count()).toBe(2);
  });

  test("pages, batches inside batches and more reads than one statement holds", async () => {
    const pages = database.posts((post) => ({ id: post.id }), {
      orderBy: (post) => [post.at.descending, post.id.ascending],
    });
    const alone = await pages.page({ size: 2 });

    sent.length = 0;

    const [page, inner] = await database.$batch((db) => [
      db
        .posts((post) => ({ id: post.id }), {
          orderBy: (post) => [post.at.descending, post.id.ascending],
        })
        .page({ size: 2 }),
      db.$batch((nested) => ({
        users: nested.users.count(),
        first: nested.users.get(1),
      })),
    ]);

    expect(sent).toHaveLength(1);
    expect(page.items).toEqual(alone.items);
    // The cursor of a batched page continues the same walk.
    expect(
      (await pages.page({ size: 2, after: page.nextCursor! })).items,
    ).toEqual((await pages.page({ size: 2, after: alone.nextCursor! })).items);
    expect(inner).toEqual({
      users: 2,
      first: { id: 1, name: "Ada", tenant: 1 },
    });

    // A SELECT holds 1,664 fields: 2,500 reads are three statements.
    sent.length = 0;

    const found = await database.$batch((db) =>
      Array.from({ length: 2500 }, (_, position) =>
        db.users.find(1 + (position % 3)),
      ),
    );

    expect(sent).toHaveLength(3);
    expect(found.map((user) => user?.id ?? null).slice(0, 6)).toEqual([
      1,
      2,
      null,
      1,
      2,
      null,
    ]);

    // A statement that fails fails every read in it, and nothing else.
    const failed = await database.$batch((db) => [
      db
        .posts((post) => ({ broken: post.views.divide(0) }))
        .execute()
        .catch((error: Error) => error.name),
      db.users.count().catch((error: Error) => error.name),
    ]);

    expect(failed).toEqual(["QueryError", "QueryError"]);
    expect(await database.users.count()).toBe(2);
  });

  test("writes, locks and a callback that does not return its reads are refused", async () => {
    await expect(
      database.$batch((db) => [db.users.insert({ name: "X" }).execute()]),
    ).rejects.toThrow("$batch() sends reads as one statement");
    // A nested insert, a stream and a transaction need a connection of their own.
    await expect(
      database.$batch((db) => [
        db.posts
          .insert({ title: "X", at, author: { create: { name: "X" } } })
          .execute(),
      ]),
    ).rejects.toThrow("cannot be part of it, run it outside the batch");
    await expect(
      database.$batch((db) => [
        db.$transaction(async (transaction) => transaction.users.count()),
      ]),
    ).rejects.toThrow("$batch() sends reads as one statement");
    await expect(
      database.$batch((db) => [
        db
          .users((user) => ({ id: user.id }))
          .stream()
          [Symbol.asyncIterator]()
          .next(),
      ]),
    ).rejects.toThrow("$batch() sends reads as one statement");
    await expect(
      database.$batch((db) => [db.users({ forUpdate: true }).execute()]),
    ).rejects.toThrow("a write, a row lock, a stream or a transaction");
    await expect(
      database.$batch((async (db: typeof database) => [
        await db.users.count(),
      ]) as never),
    ).rejects.toThrow("a $batch() callback returns its reads at once");
    expect(await database.users.count()).toBe(2);
    expect(await database.$batch(() => [])).toEqual([]);
  });

  test("reads whose CTEs share a name, and DISTINCT ordered by a bigint or numeric column", async () => {
    const ranked = (db: typeof database) =>
      db
        .posts((post, { rowNumber }) => ({
          id: post.id,
          position: rowNumber().over({
            partitionBy: [post.authorId],
            orderBy: post.views.desc,
          }),
        }))
        .cte("ranked");
    const views = (db: typeof database) =>
      db.posts((post) => ({ views: post.views }), {
        distinct: true,
        orderBy: (post) => post.views.desc,
      });
    const prices = (db: typeof database) =>
      db.posts((post) => ({ price: post.price }), {
        distinct: true,
        orderBy: { price: "asc" },
      });
    const alone = {
      best: await ranked(database)({
        where: (row) => row.position.is(1),
        orderBy: (row) => row.id.asc,
      }),
      second: await ranked(database)({
        where: (row) => row.position.is(2),
      }).count(),
      total: await database.posts.count(),
      views: await views(database),
      prices: await prices(database),
    };

    expect(alone.views[0]).toEqual({ views: 9007199254740993n });
    expect(
      await database.$batch((db) => ({
        best: ranked(db)({
          where: (row) => row.position.is(1),
          orderBy: (row) => row.id.asc,
        }),
        second: ranked(db)({ where: (row) => row.position.is(2) }).count(),
        total: db.posts.count(),
        views: views(db),
        prices: prices(db),
      })),
    ).toEqual(alone);
  });
});
