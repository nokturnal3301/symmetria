import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  many,
  maybe,
  one,
  NotFoundError,
  TooManyRowsError,
  type CompiledQuery,
} from "../../../packages/runtime/src";

const users = table({
  id: int.auto,
  email: text.unique,
  name: text,
  count: int.default(0),
  posts: many,
  edited: many,
});
const posts = table({
  id: int.auto,
  title: text,
  author: one(users.posts),
  editor: maybe(users.edited),
});

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

  return { database, calls };
};

const ada = { id: 7, email: "ada@example.com", name: "Ada", count: 0 };

test("byId().one() and maybeOne() read like get() and find()", async () => {
  const { database, calls } = recording([ada]);

  expect(await database.users.byId(7).one()).toEqual(ada);
  expect(await database.users.byId(7).maybeOne()).toEqual(ada);
  expect(await database.users.by.email("ada@example.com").one()).toEqual(ada);
  expect(await database.users.get(7)).toEqual(ada);
  // One statement text per key, with the key as its only parameter.
  expect(new Set(calls.map((call) => call.sql)).size).toBe(2);
  expect(calls.map((call) => call.parameters)).toEqual([
    [7],
    [7],
    ["ada@example.com"],
    [7],
  ]);
  expect(calls[0]!.sql).toBe(calls[3]!.sql);
  expect(calls[0]!.sql).toEndWith("LIMIT 2");

  // A value is bound per call: the statement is shared, the key is not.
  await database.users.byId(8).one();
  expect(calls.at(-1)!.parameters).toEqual([8]);
});

test("byId() terminals keep their errors and their ordinary path", async () => {
  const none = recording([]);

  await expect(none.database.users.byId(7).one()).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect(await none.database.users.byId(7).maybeOne()).toBeNull();

  const two = recording([ada, ada]);

  await expect(two.database.users.byId(7).maybeOne()).rejects.toBeInstanceOf(
    TooManyRowsError,
  );
  await expect(
    (
      two.database.users.byId as unknown as (key: unknown) => {
        one: () => Promise<unknown>;
      }
    )(1.5).one(),
  ).rejects.toThrow("integer values are integers");

  // A shape, options or a scope make it a query of its own.
  const { database, calls } = recording([{ name: "Ada" }]);

  expect(
    await database.users
      .byId(7)((user) => ({ name: user.name }))
      .one(),
  ).toEqual({ name: "Ada" });
  expect(calls[0]!.sql).toContain('SELECT "users"."name" AS "name"');
  await database.users.byId(7)({ forUpdate: true }).one();
  expect(calls[1]!.sql).toEndWith("FOR UPDATE");
  await database
    .$scope({ users: (user) => user.name.is("Ada") })
    .users.byId(7)
    .maybeOne();
  expect(calls[2]!.sql).toContain('"users"."name" = $1');
  // The same lookup still reads as a list, a count and a write.
  expect(database.users.byId(7).toSQL().parameters).toEqual([7]);
  expect(database.users.byId(7).update({ name: "x" }).toSQL().sql).toContain(
    'UPDATE "users"',
  );
});

test("a to-one relation is a path, a shape and its methods alike", () => {
  const { database } = recording();
  const sqlOf = (query: { toSQL: () => CompiledQuery }) => query.toSQL().sql;

  // Path only: one JOIN, nothing else.
  expect(
    sqlOf(database.posts((post) => ({ author: post.author.name }))),
  ).toContain('INNER JOIN "users" AS "__symmetria_path_0"');
  // A column named like a method is the method; the column is read in a shape.
  expect(
    sqlOf(database.posts((post) => ({ users: post.author.count() }))),
  ).toContain("COUNT(*)");
  expect(
    sqlOf(
      database.posts((post) => ({
        author: post.author((user) => ({ count: user.count })),
      })),
    ),
  ).toContain('"count"');
  // Called, asked for a method and used as a path in one callback.
  expect(
    sqlOf(
      database.posts(
        (post) => ({
          name: post.editor.name,
          editor: post.editor((user) => ({ name: user.name })),
          has: post.editor.exists(),
          posts: post.author.posts.count(),
        }),
        { where: (post) => post.author.posts.some() },
      ),
    ),
  ).toContain('LEFT JOIN "users"');
  expect(
    sqlOf(
      database.posts((post, { join, innerJoin }) => ({
        a: join(post.author).name,
        e: innerJoin(post.editor.as("reviewer")).name,
      })),
    ),
  ).toContain('INNER JOIN "users" AS "reviewer"');
  expect(
    sqlOf(
      database.users((user) => ({
        total: user.posts.sum((post) => post.id),
        top: user.posts.maximum.id,
        again: user.posts.maximum.id,
      })),
    ),
  ).toContain("MAX(");
  const loose = database.posts as unknown as (
    shape: (post: { author: Record<string, unknown> }) => unknown,
  ) => unknown;

  expect(() => loose((post) => ({ nope: post.author.nope }))).toThrow(
    '"users.nope" is not a column or relation of "users"',
  );
  database.posts((post) => {
    expect("count" in post.author).toBe(true);
    expect(typeof post.author).toBe("function");

    return { id: post.id };
  });
});

test("two shapes of one relation in a callback read sources of their own", () => {
  const { database } = recording();
  const { sql } = database
    .users((user) => ({
      id: user.id,
      first: user.posts((post) => ({ title: post.title })),
      second: user.posts((post) => ({ id: post.id }), {
        where: (post) => post.title.is("x"),
      }),
      total: user.posts.count(),
    }))
    .toSQL();

  expect(sql).toContain('AS "first"');
  expect(sql).toContain('AS "second"');
  expect(sql).toContain('AS "total"');
  // A relation handle answers `name` and `length` as a missing column would.
  database.users((user) => {
    expect((user.posts as { name?: unknown }).name).toBeUndefined();
    expect((user.posts as { length?: unknown }).length).toBeUndefined();

    return { id: user.id };
  });
});

test("nested rows that need no decoding are returned as the driver parsed them", async () => {
  const tags = [{ title: "a" }, { title: "b" }];
  const { database } = recording([{ id: 7, posts: tags }]);
  const [row] = await database.users((user) => ({
    id: user.id,
    posts: user.posts((post) => ({ title: post.title })),
  }));

  expect(row).toEqual({ id: 7, posts: [{ title: "a" }, { title: "b" }] });
});

test("the selected fields reach only the option callbacks that take them", () => {
  const { database } = recording();
  const seen: unknown[] = [];

  database
    .users(
      (user, tools) => {
        seen.push((tools as { selected?: unknown }).selected);

        return { label: user.name };
      },
      {
        where: (user, tools) => {
          seen.push((tools as { selected?: unknown }).selected);

          return user.id.is(1);
        },
        orderBy: (_user, tools) => {
          const { selected } = tools as unknown as {
            selected: { label: { ascending: never } };
          };

          seen.push(Object.keys(selected));

          return selected.label.ascending;
        },
      },
    )
    .toSQL();

  expect(seen).toEqual([undefined, undefined, ["label"]]);
});
