import { expect, test } from "bun:test";
import {
  schema,
  table,
  bytea,
  int,
  text,
  many,
  maybe,
  one,
  sql,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import { createPostgresDriver } from "../../../packages/runtime/src/driver/pool";

const users = table({
  id: int.auto,
  name: text,
  tenantId: int,
  posts: many,
  edited: many,
  comments: many,
});
const posts = table({
  id: int.auto,
  title: text,
  author: one(users.posts),
  editor: maybe(users.edited),
  comments: many,
});
const comments = table({
  id: int.auto,
  post: one(posts.comments),
  author: one(users.comments),
  tenantId: int,
});
const files = table({ id: int.auto, body: bytea });

const recording = (rows: Record<string, unknown>[] = []) => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    { users, posts, comments, files },
    {
      executor: async (query) => {
        calls.push(query);

        return rows;
      },
    },
  );

  return { database, calls };
};

/** A pool of `max` connections that run nothing, to watch who may ask for one. */
const idlePool = (max: number) =>
  createPostgresDriver({
    execute: async () => ({ rows: [], affectedRows: 0 }),
    connect: async () => ({
      execute: async () => ({ rows: [], affectedRows: 0 }),
      release: () => {},
      discard: async () => {},
    }),
    cancel: async () => {},
    close: async () => {},
    max,
  });

test("work started inside a transaction may use the pool once the transaction has ended", async () => {
  const driver = idlePool(1);
  const query = { sql: "SELECT 1", parameters: [] };
  let later: Promise<unknown> | undefined;
  let inside: Promise<unknown> | undefined;

  await driver.transaction(async () => {
    // The transaction holds the only connection: asking now would never end.
    inside = driver.execute(query);
    inside.catch(() => {});
    // A timer inherits the transaction's context and fires after it.
    later = new Promise((resolve, reject) => {
      setTimeout(() => driver.execute(query).then(resolve, reject), 20);
    });
  });

  await expect(inside!).rejects.toThrow("would wait forever");
  expect(await later!).toEqual({ rows: [], affectedRows: 0 });

  // With two connections, two nested transactions hold both; afterwards the
  // code they started is free again.
  const pair = idlePool(2);
  let nested: Promise<unknown> | undefined;

  await pair.transaction(async () => {
    expect(await pair.execute(query)).toEqual({ rows: [], affectedRows: 0 });
    await pair.transaction(async () => {
      await expect(pair.execute(query)).rejects.toThrow("would wait forever");
      nested = new Promise((resolve, reject) => {
        setTimeout(() => pair.execute(query).then(resolve, reject), 20);
      });
    });
  });

  expect(await nested!).toEqual({ rows: [], affectedRows: 0 });
});

test("a row lock names the tables it can reach when a path adds a LEFT JOIN", () => {
  const { database } = recording();

  expect(
    database
      .posts((post) => ({ id: post.id, editor: post.editor.name }), {
        forUpdate: true,
      })
      .toSQL().sql,
  ).toEndWith('FOR UPDATE OF "posts"');
  expect(
    database
      .posts(
        (post) => ({
          id: post.id,
          author: post.author.name,
          editor: post.editor.name,
        }),
        { forShare: { skipLocked: true } },
      )
      .toSQL().sql,
  ).toEndWith('FOR SHARE OF "posts", "__symmetria_path_0" SKIP LOCKED');
  // Without an outer join, and with tables named by the caller, nothing changes.
  expect(
    database
      .posts((post) => ({ id: post.id, author: post.author.name }), {
        forUpdate: true,
      })
      .toSQL().sql,
  ).toEndWith("FOR UPDATE");
  expect(
    database
      .posts((post) => ({ id: post.id, editor: post.editor.name }), {
        forUpdate: { of: ["posts"], noWait: true },
      })
      .toSQL().sql,
  ).toEndWith('FOR UPDATE OF "posts" NOWAIT');
});

test("under $scope() a required path keeps the row whose target the scope hides", () => {
  const { database } = recording();
  const tenant = database.$scope({
    users: (user) => user.tenantId.is(1),
    comments: (comment) => comment.tenantId.is(1),
  });

  expect(
    tenant.comments((comment) => ({ author: comment.author.name })).toSQL().sql,
  ).toContain(
    'LEFT JOIN "users" AS "__symmetria_path_0" ON ("comments"."author_id" = "__symmetria_path_0"."id" AND "__symmetria_path_0"."tenant_id" = $1)',
  );
  // every(): a comment whose author is hidden fails the condition instead of
  // leaving the count.
  expect(
    tenant
      .posts((post) => ({ id: post.id }), {
        where: (post) =>
          post.comments.every((comment) => comment.author.name.is("Ada")),
      })
      .toSQL().sql,
  ).toContain('LEFT JOIN "users" AS "__symmetria_path_1_0"');
  // The smart join() follows the same rule; an unscoped target stays INNER.
  expect(
    tenant
      .comments((comment, { join }) => ({ author: join(comment.author).name }))
      .toSQL().sql,
  ).toContain('LEFT JOIN "users"');
  expect(
    tenant.comments((comment) => ({ post: comment.post.title })).toSQL().sql,
  ).toContain('INNER JOIN "posts"');
  expect(
    database.comments((comment) => ({ author: comment.author.name })).toSQL()
      .sql,
  ).toContain('INNER JOIN "users"');
});

test("a scope bounds a write without choosing its rows", () => {
  const { database } = recording();
  const tenant = database.$scope({ users: (user) => user.tenantId.is(1) });

  expect(() => tenant.users.delete().toSQL()).toThrow(
    'delete() on "users" has no where(); call .all() to delete every row',
  );
  expect(() => tenant.users.update({ name: "x" }).toSQL()).toThrow(
    'update() on "users" has no where()',
  );
  expect(tenant.users.delete().all().toSQL().sql).toBe(
    'DELETE FROM "users" AS "users"\nWHERE "users"."tenant_id" = $1',
  );
  // A key or a filter chooses rows, as before.
  expect(tenant.users.byId(3).delete().toSQL().sql).toContain(
    '"users"."id" = $2',
  );
  expect(
    tenant.users
      .delete()
      .where((user) => user.name.is("x"))
      .toSQL().sql,
  ).toContain('"users"."name" = $2');
});

test("sql is a template tag only", () => {
  const { database } = recording();
  const called = sql as unknown as (text: unknown) => never;

  expect(() => called("now()")).toThrow("sql is a template tag");
  expect(() => called(["now()"])).toThrow("sql is a template tag");
  expect(
    database.users(() => ({ at: sql<Date>`now()` })).toSQL().sql,
  ).toContain("now()");
});

test("values of the wrong shape are refused by name", async () => {
  const { database, calls } = recording();
  const loose = database as unknown as Record<
    string,
    {
      find: (key: unknown) => Promise<unknown>;
      insert: (row: unknown) => Promise<unknown>;
    } & ((shape: unknown, options: unknown) => unknown)
  >;

  await expect(loose.users!.find([1])).rejects.toThrow(
    'primary key "id" takes one value, received an array',
  );
  expect(() => loose.users!(() => ({}), { limit: "5" })).toThrow(
    "limit must be a nonnegative safe integer",
  );
  const written = async (row: unknown) => await loose.users!.insert(row);

  await expect(
    written({ name: { first: "Ada" }, tenantId: 1 }),
  ).rejects.toThrow(
    '"users.name" is text and takes a string, received an object',
  );
  await expect(written({ name: ["Ada"], tenantId: 1 })).rejects.toThrow(
    "received an array",
  );
  expect(calls).toEqual([]);
});

test("bytea reads PostgreSQL's escape form as well as hex", async () => {
  const body = (text: string) =>
    recording([{ id: 1, body: text }]).database.files.get(1);

  expect((await body("\\x00015c27ff")).body).toEqual(
    Uint8Array.from([0, 1, 92, 39, 255]),
  );
  expect((await body("\\000\\001\\\\'\\377")).body).toEqual(
    Uint8Array.from([0, 1, 92, 39, 255]),
  );
  expect((await body("plain text")).body).toEqual(
    Uint8Array.from(Buffer.from("plain text")),
  );
  expect((await body("")).body).toEqual(new Uint8Array());
});
