import { expect, test } from "bun:test";
import {
  schema,
  table,
  prepare,
  int,
  text,
  bool,
  type CompiledQuery,
} from "../../../packages/runtime/src";

const users = table({ id: int.auto, name: text, active: bool.default(true) });
const posts = table({ id: int.auto, title: text, author: users, version: int });

/** A database whose executor records every statement and answers with canned rows. */
const recording = (rows: Record<string, unknown>[] = []) => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    { users, posts },
    {
      executor: async (query) => {
        calls.push(query);

        return rows;
      },
    },
  );

  return { database, calls, last: () => calls.at(-1)! };
};

test("count() and exists() work on tables, filtered sources and lookups", async () => {
  const { database, last } = recording([{ count: "3" }]);

  expect(await database.posts.count()).toBe(3);
  expect(last().sql).toBe(
    'SELECT COUNT(*) AS "count"\nFROM "posts" AS "posts"',
  );

  await database.posts({ where: (post) => post.version.above(1) }).count();
  expect(last().sql).toBe(
    'SELECT COUNT(*) AS "count"\nFROM "posts" AS "posts"\nWHERE "posts"."version" > $1',
  );

  // Limited, grouped or distinct sources count their result rows.
  await database.posts({ limit: 5 }).count();
  expect(last().sql).toBe(
    'SELECT COUNT(*) AS "count"\nFROM (SELECT 1 AS "present"\nFROM "posts" AS "posts"\nLIMIT 5) AS "__symmetria_count"',
  );
  await database
    .posts((post) => ({ title: post.title }), { distinct: true })
    .count();
  expect(last().sql).toContain(
    'FROM (SELECT DISTINCT "posts"."title" AS "title"\nFROM "posts" AS "posts") AS "__symmetria_count"',
  );
  await database
    .posts({ orderBy: (post) => post.id.descending, forUpdate: true })
    .count();
  expect(last().sql).not.toContain("ORDER BY");
  expect(last().sql).not.toContain("FOR UPDATE");

  // Scoped databases keep their filters.
  await database
    .$scope({ users: (user) => user.active.is(true) })
    .users.count();
  expect(last().sql).toContain('WHERE "users"."active" = $1');

  await database.users.byId(7).exists();
  expect(last().sql).toBe(
    'SELECT 1 AS "present"\nFROM "users" AS "users"\nWHERE "users"."id" = $1\nLIMIT 1',
  );
  await database.users({ limit: 3 }).exists();
  expect(last().sql).toEndWith("LIMIT 1");
  const { database: populated } = recording([{ present: 1 }]);
  expect(await populated.users.exists()).toBe(true);
  const { database: empty } = recording([]);
  expect(await empty.users.exists()).toBe(false);
});

test("prepared queries offer the query terminals", async () => {
  const { database, last } = recording([{ id: 1, name: "Ada", active: true }]);
  const byName = prepare({ name: text }, (parameters) =>
    database.users((user) => ({ id: user.id, name: user.name }), {
      where: (user) => user.name.is(parameters.name),
    }),
  );

  expect(await byName.one({ name: "Ada" })).toEqual({ id: 1, name: "Ada" });
  expect(last()).toEqual({
    sql: 'SELECT "users"."id" AS "id", "users"."name" AS "name"\nFROM "users" AS "users"\nWHERE "users"."name" = $1\nLIMIT 2',
    parameters: ["Ada"],
  });
  expect(await byName.first({ name: "Ada" })).toEqual({ id: 1, name: "Ada" });
  expect(last().sql).toEndWith("LIMIT 1");
  expect(await byName.exists({ name: "Ada" })).toBe(true);
  expect(last()).toEqual({
    sql: 'SELECT 1 AS "present"\nFROM "users" AS "users"\nWHERE "users"."name" = $1\nLIMIT 1',
    parameters: ["Ada"],
  });

  const { database: counted, last: lastCount } = recording([{ count: "2" }]);
  const countByName = prepare({ name: text, size: int }, (parameters) =>
    counted.users((user) => ({ id: user.id }), {
      where: (user) => user.name.is(parameters.name),
      limit: parameters.size,
    }),
  );
  expect(await countByName.count({ name: "Ada", size: 10 })).toBe(2);
  expect(lastCount()).toEqual({
    sql: 'SELECT COUNT(*) AS "count"\nFROM (SELECT 1 AS "present"\nFROM "users" AS "users"\nWHERE "users"."name" = $1\nLIMIT $2) AS "__symmetria_count"',
    parameters: ["Ada", 10],
  });
  expect(await countByName.exists({ name: "Ada", size: 10 })).toBe(true);
  expect(lastCount().sql).toContain('AS "__symmetria_exists"');
  expect(() => countByName.one({ name: "Ada", size: 1 })).toThrow(
    /bind a parameterized LIMIT/,
  );

  const report = await byName.inspect({ name: "Grace" });
  expect(report.parameters).toEqual(["Grace"]);
  expect(report.sql).toContain('WHERE "users"."name" = $1');
  expect(() => byName.one({} as never)).toThrow(
    /exactly its declared parameters/,
  );

  // Mutations keep the plain prepared interface.
  const update = prepare({ id: int }, (parameters) =>
    database.users.byId(parameters.id).update({ active: false }),
  );
  expect("one" in update).toBe(false);
});

test("page({ before }) runs the reversed order and returns both cursors", async () => {
  const rows = [
    { id: 3, title: "c", __symmetria_cursor_0: "3" },
    { id: 2, title: "b", __symmetria_cursor_0: "2" },
    { id: 1, title: "a", __symmetria_cursor_0: "1" },
  ];
  const { database, last } = recording(rows);
  const feed = database.posts((post) => ({ id: post.id, title: post.title }), {
    orderBy: (post) => post.id.ascending,
  });
  const forward = await feed.page({ size: 2 });

  expect(last().sql).toContain('ORDER BY "posts"."id" ASC\nLIMIT 3');
  expect(forward.items).toEqual([
    { id: 3, title: "c" },
    { id: 2, title: "b" },
  ]);
  expect(forward.previousCursor).toBeNull();
  expect(forward.nextCursor).not.toBeNull();

  const backward = await feed.page({ size: 2, before: forward.nextCursor });
  expect(last().sql).toContain(
    'WHERE "posts"."id" < $1\nORDER BY "posts"."id" DESC NULLS FIRST\nLIMIT 3',
  );
  // The mock answers [3, 2, 1] again; the first two rows are flipped back to the declared order.
  expect(backward.items).toEqual([
    { id: 2, title: "b" },
    { id: 3, title: "c" },
  ]);
  expect(backward.nextCursor).not.toBeNull();
  expect(backward.previousCursor).not.toBeNull();

  const page = await feed.page({ size: 2, after: forward.nextCursor });
  expect(page.previousCursor).not.toBeNull();
  await expect(
    feed.page({
      size: 2,
      after: forward.nextCursor,
      before: forward.nextCursor,
    }),
  ).rejects.toThrow(/either after or before/);
});

test("doUpdate() accepts a where condition over the current and proposed rows", () => {
  const { database } = recording();
  const compiled = database.posts
    .insert({ title: "x", authorId: 1, version: 2 })
    .onConflict("id")
    .doUpdate(
      (_post, incoming) => ({
        title: incoming.title,
        version: incoming.version,
      }),
      {
        where: (post, incoming) => incoming.version.above(post.version),
      },
    )
    .toSQL();

  expect(compiled.sql).toEndWith(
    'ON CONFLICT ("id") DO UPDATE SET "title" = "excluded"."title", "version" = "excluded"."version"\nWHERE "excluded"."version" > "posts"."version"',
  );
  expect(
    database.posts
      .insert({ title: "x", authorId: 1, version: 2 })
      .onConflict("id")
      .doUpdate(
        { title: "y" },
        { where: (post) => [post.version.above(1), undefined] },
      )
      .toSQL().sql,
  ).toContain('WHERE ("posts"."version" > $5)');
  expect(() =>
    database.posts
      .insert({ title: "x", authorId: 1, version: 2 })
      .onConflict("id")
      .doUpdate({ title: "y" }, { nope: 1 } as never),
  ).toThrow(/where callback only/);
});

test("returning() callbacks receive scalar tools", () => {
  const { database } = recording();
  const { sql } = database.users
    .insert({ name: "Ada" })
    .returning((user, { coalesce, sql }) => ({
      id: user.id,
      label: coalesce(user.name, "anonymous"),
      upper: sql<string>`upper(${user.name})`,
    }))
    .toSQL();

  expect(sql).toContain(
    'RETURNING "users"."id" AS "id", COALESCE("users"."name", $2) AS "label", upper("users"."name") AS "upper"',
  );
});
