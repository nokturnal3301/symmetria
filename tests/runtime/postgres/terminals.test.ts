import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  prepare,
  int,
  text,
  bool,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const users = table({ id: int.auto, name: text, active: bool.default(true) });
const documents = table({
  id: int.auto,
  externalId: text.unique,
  content: text,
  version: int,
  rank: int.nullable,
});
const model = schema({ users, documents });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("query terminals on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_terminals",
      max: 1,
    });
    database = isolated.database;
    await database.users.insert(
      Array.from({ length: 7 }, (_, index) => ({
        name: `user ${index}`,
        active: index % 2 === 0,
      })),
    );
    await database.documents.insert([
      { externalId: "a", content: "first", version: 1, rank: 2 },
      { externalId: "b", content: "second", version: 1, rank: null },
      { externalId: "c", content: "third", version: 1, rank: 1 },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("count() and exists() on sources, lookups and prepared queries", async () => {
    expect(await database.users.count()).toBe(7);
    expect(
      await database.users({ where: (user) => user.active.is(true) }).count(),
    ).toBe(4);
    expect(await database.users({ limit: 2 }).count()).toBe(2);
    expect(
      await database
        .users((user) => ({ active: user.active }), { distinct: true })
        .count(),
    ).toBe(2);
    expect(await database.users.byId(1).exists()).toBe(true);
    expect(await database.users.byId(99).exists()).toBe(false);
    expect(
      await database
        .$scope({ users: (user) => user.active.is(false) })
        .users.count(),
    ).toBe(3);

    const active = prepare({ active: bool }, (parameters) =>
      database.users((user) => ({ id: user.id, name: user.name }), {
        where: (user) => user.active.is(parameters.active),
        orderBy: (user) => user.id.ascending,
      }),
    );
    expect(await active.count({ active: true })).toBe(4);
    expect(await active.exists({ active: false })).toBe(true);
    expect(await active.first({ active: true })).toEqual({
      id: 1,
      name: "user 0",
    });
    await expect(active.one({ active: true })).rejects.toThrow(/exactly one/);
    const byId = prepare({ id: int }, (parameters) =>
      database.users((user) => ({ name: user.name }), {
        where: (user) => user.id.is(parameters.id),
      }),
    );
    expect(await byId.one({ id: 2 })).toEqual({ name: "user 1" });
    expect(await byId.maybeOne({ id: 99 })).toBeNull();
    const report = await byId.inspect({ id: 2 }, { execute: true });
    expect(report.results?.rows).toEqual([{ name: "user 1" }]);
  });

  test("pages walk forward to the end and back to the start", async () => {
    const feed = database.users((user) => ({ id: user.id }), {
      orderBy: (user) => user.id.ascending,
    });
    const first = await feed.page({ size: 3 });
    const second = await feed.page({ size: 3, after: first.nextCursor });
    const third = await feed.page({ size: 3, after: second.nextCursor });

    expect(first.items.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(first.previousCursor).toBeNull();
    expect(second.items.map((row) => row.id)).toEqual([4, 5, 6]);
    expect(third.items.map((row) => row.id)).toEqual([7]);
    expect(third.nextCursor).toBeNull();
    expect(third.previousCursor).not.toBeNull();

    const back = await feed.page({ size: 3, before: third.previousCursor });
    expect(back.items.map((row) => row.id)).toEqual([4, 5, 6]);
    const start = await feed.page({ size: 3, before: back.previousCursor });
    expect(start.items.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(start.previousCursor).toBeNull();
    expect(start.nextCursor).not.toBeNull();
    expect(
      (await feed.page({ size: 3, after: start.nextCursor })).items.map(
        (row) => row.id,
      ),
    ).toEqual([4, 5, 6]);

    // Nullable ordering columns keep their NULLS placement when reversed.
    const ranked = database.documents((document) => ({ id: document.id }), {
      orderBy: (document) => [
        document.rank.descending.nullsFirst,
        document.id.ascending,
      ],
    });
    const all = await ranked.page({ size: 10 });
    expect(all.items.map((row) => row.id)).toEqual([2, 1, 3]);
    const lastTwo = await ranked.page({
      size: 2,
      after: (await ranked.page({ size: 1 })).nextCursor,
    });
    expect(lastTwo.items.map((row) => row.id)).toEqual([1, 3]);
    const backToFirst = await ranked.page({
      size: 2,
      before: lastTwo.previousCursor,
    });
    expect(backToFirst.items.map((row) => row.id)).toEqual([2]);
  });

  test("conditional upserts write only when the condition holds", async () => {
    const stale = await database.documents
      .insert({ externalId: "a", content: "stale", version: 0 })
      .onConflict("externalId")
      .doUpdate(
        (_current, incoming) => ({
          content: incoming.content,
          version: incoming.version,
        }),
        {
          where: (current, incoming) => incoming.version.above(current.version),
        },
      )
      .returning((document) => ({ content: document.content }));
    expect(stale).toBeNull();

    const fresh = await database.documents
      .insert({ externalId: "a", content: "fresh", version: 2 })
      .onConflict("externalId")
      .doUpdate(
        (_current, incoming) => ({
          content: incoming.content,
          version: incoming.version,
        }),
        {
          where: (current, incoming) => incoming.version.above(current.version),
        },
      )
      .returning((document) => ({
        content: document.content,
        version: document.version,
      }));
    expect(fresh).toEqual({ content: "fresh", version: 2 });
    expect(
      await database.documents
        .insert({ externalId: "a", content: "older", version: 1 })
        .onConflict("externalId")
        .doUpdate(
          { content: "older" },
          { where: (current) => current.version.below(1) },
        ),
    ).toEqual({ affectedRows: 0 });

    // Scoped databases combine the scope with the condition instead of throwing.
    const scoped = database.$scope({
      documents: (document) => document.version.above(0),
    });
    expect(
      await scoped.documents
        .insert({ externalId: "b", content: "scoped", version: 5 })
        .onConflict("externalId")
        .doUpdate(
          { content: "scoped" },
          { where: (current) => current.version.is(99) },
        ),
    ).toEqual({ affectedRows: 0 });
  });
});
