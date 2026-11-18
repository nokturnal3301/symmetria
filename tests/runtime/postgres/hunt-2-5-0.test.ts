import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  bytea,
  doublePrecision,
  int,
  interval,
  many,
  maybe,
  one,
  text,
} from "../../../packages/runtime/src";
import { postgres as pg } from "../../../packages/runtime/src/entries/pg";
import { testDatabase as isolatedDatabase } from "../../../packages/kit/src/testing";
import { testDatabase, transactionPooling } from "../../support/postgres";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

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
  tenantId: int,
  author: one(users.posts),
  editor: maybe(users.edited),
  comments: many,
});
const comments = table({
  id: int.auto,
  body: text,
  tenantId: int,
  post: one(posts.comments).cascade,
  author: one(users.comments),
});
const model = schema({ users, posts, comments });

describe.skipIf(!databaseUrl)("fixes of the 2.5.0 bug hunt", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_hunt25",
      max: 1,
    });
    database = isolated.database;
    // Ada and her post belong to tenant 1; Bob, of tenant 2, commented on it.
    await database.users.insert([
      { name: "Ada", tenantId: 1 },
      { name: "Bob", tenantId: 2 },
    ]);
    await database.posts.insert([
      { title: "first", tenantId: 1, authorId: 1 },
      { title: "second", tenantId: 1, authorId: 1, editorId: 2 },
    ]);
    await database.comments.insert([
      { body: "by Ada", tenantId: 1, postId: 1, authorId: 1 },
      { body: "by Bob", tenantId: 1, postId: 1, authorId: 2 },
      { body: "also Ada", tenantId: 1, postId: 2, authorId: 1 },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  const tenant = () =>
    database.$scope({
      users: (user) => user.tenantId.is(1),
      posts: (post) => post.tenantId.is(1),
      comments: (comment) => comment.tenantId.is(1),
    });

  test("under $scope() a comment stays when the scope hides its author", async () => {
    // Read through the path, filtered by it and ordered by it.
    expect(
      await tenant().comments(
        (comment) => ({ body: comment.body, author: comment.author.name }),
        { orderBy: (comment) => comment.id.asc },
      ),
    ).toEqual([
      { body: "by Ada", author: "Ada" },
      // The type says string; the scope makes it null.
      { body: "by Bob", author: null as unknown as string },
      { body: "also Ada", author: "Ada" },
    ]);
    expect(
      await tenant().comments((comment) => ({ body: comment.body }), {
        orderBy: (comment) => [comment.author.name.asc.nullsFirst],
        limit: 1,
      }),
    ).toEqual([{ body: "by Bob" }]);
    // Not every comment of the first post is Ada's: one is by someone unseen.
    expect(
      await tenant().posts((post) => ({ title: post.title }), {
        where: (post) =>
          post.comments.every((comment) => comment.author.name.is("Ada")),
      }),
    ).toEqual([{ title: "second" }]);
  });

  test("a row lock works with a path through an optional relation", async () => {
    expect(
      await database.$transaction((transaction) =>
        transaction.posts(
          (post) => ({
            title: post.title,
            author: post.author.name,
            editor: post.editor.name,
          }),
          { orderBy: (post) => post.id.asc, forUpdate: true },
        ),
      ),
    ).toEqual([
      { title: "first", author: "Ada", editor: null },
      { title: "second", author: "Ada", editor: "Bob" },
    ]);
  });

  test("a write whose filter came out empty is refused and writes nothing", async () => {
    const nobody: number | undefined = undefined;

    expect(() =>
      database.comments.delete({
        where: (comment) => [nobody && comment.authorId.is(nobody)],
      }),
    ).toThrow("leaves no condition");
    expect(() =>
      database.comments.update({ body: "x" }, { where: [] }),
    ).toThrow("leaves no condition");
    await expect(tenant().comments.delete().execute()).rejects.toThrow(
      'delete() on "comments" has no where()',
    );
    expect(await database.comments.count()).toBe(3);
    // A filter no row passes is still a filter.
    expect(
      await database.comments.delete({
        where: (comment) => comment.id.in([]),
      }),
    ).toEqual({ affectedRows: 0 });
  });

  test("code started inside a transaction uses the pool after it", async () => {
    // The pool has one connection.
    let later: Promise<number> | undefined;

    await database.$transaction(async (transaction) => {
      await transaction.users.count();
      later = new Promise((resolve, reject) => {
        setTimeout(() => database.users.count().then(resolve, reject), 30);
      });
    });

    expect(await later!).toBe(2);
  });
});

const values = table({
  id: int.auto,
  span: interval,
  body: bytea,
  ratio: doublePrecision,
  holders: many,
});
const holders = table({ id: int.auto, value: one(values.holders) });
const outputs = schema({ values, holders });

// A pooler in transaction mode does not keep a session's settings.
describe.skipIf(!databaseUrl || transactionPooling)(
  "output settings of the database or role (node-postgres)",
  () => {
    test("an interval, bytea and a double read the same whatever the server prints by default", async () => {
      const isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: outputs,
        prefix: "symmetria_hunt25_output",
        max: 1,
        driver: ({ url, max }) => {
          const address = new URL(url);

          address.searchParams.set(
            "options",
            `${address.searchParams.get("options") ?? ""} -c IntervalStyle=iso_8601 -c bytea_output=escape -c extra_float_digits=0`.trim(),
          );

          return pg({ url: address.toString(), max });
        },
      });

      try {
        const written = {
          span: "1 day 02:00:00",
          body: Uint8Array.from([0, 1, 92, 39, 255]),
          ratio: 0.1 + 0.2,
        };
        const row = await isolated.database.values
          .insert(written)
          .returning("id", "span", "body", "ratio");

        expect(row).toEqual({ id: 1, ...written });
        await isolated.database.holders.insert({ valueId: row.id });
        // Inside nested JSON the values are PostgreSQL's own text.
        expect(
          await isolated.database
            .holders((holder) => ({
              value: holder.value(({ span, body, ratio }) => ({
                span,
                body,
                ratio,
              })),
            }))
            .one(),
        ).toEqual({ value: written });
      } finally {
        await isolated.close();
      }
    });
  },
);

describe.skipIf(!databaseUrl || transactionPooling)(
  "named prepared statements (node-postgres, prepare: true)",
  () => {
    test("a statement with values is prepared once per connection; the rest is sent as before", async () => {
      const prepared = async (prepare: boolean) => {
        const driver = pg({ url: databaseUrl!, max: 1, prepare });
        const run = async (sql: string, parameters: unknown[] = []) => {
          const result = await driver.execute({ sql, parameters });

          return Array.isArray(result) ? result : result.rows;
        };

        try {
          for (const value of [1, 2, 3]) {
            expect(await run("SELECT $1::int AS value", [value])).toEqual([
              { value },
            ]);
          }

          expect(await run("SELECT $1::text AS word", ["a"])).toEqual([
            { word: "a" },
          ]);
          // No values: the simple protocol, which takes several commands.
          await run("SELECT 1; SELECT 2");
          // Not a read or a write: never prepared.
          await run("SET LOCAL statement_timeout = $1", []).catch(() => {});

          return (
            await run(
              "SELECT name, statement FROM pg_prepared_statements ORDER BY name",
            )
          ).map((row) => `${row.name}: ${row.statement}`);
        } finally {
          await driver.close();
        }
      };

      expect(await prepared(true)).toEqual([
        "symmetria_0: SELECT $1::int AS value",
        "symmetria_1: SELECT $1::text AS word",
      ]);
      expect(await prepared(false)).toEqual([]);
    });
  },
);
