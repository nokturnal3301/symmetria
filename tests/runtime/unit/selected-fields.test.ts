import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  bigint,
  numeric,
  oneOf,
  timestamptz,
  prepare,
  type QueryColumn,
} from "../../../packages/runtime/src";

const users = table({ id: int.auto, name: text });
const posts = table({
  id: int.auto,
  author: users,
  title: text,
  state: oneOf("draft", "published"),
  views: bigint,
  createdAt: timestamptz,
});
const orders = table({ id: int.auto, customer: users, total: numeric(12, 2) });
const database = schema({ users, posts, orders });

/** Reads a field the types do not offer, as untyped JavaScript would. */
const untyped = (selected: object, name: string) =>
  (selected as Record<string, QueryColumn<unknown, string>>)[name]!;

test("groupBy, having and orderBy read the projection's fields from their third argument", () => {
  // The example of the reference.
  expect(
    database
      .posts(
        (post, { join, count, sum }) => ({
          author: join(post.author).name,
          publications: count(),
          views: sum(post.views),
        }),
        {
          where: (post) => post.state.is.published,
          groupBy: (post, tools, selected) => [selected.author],
          having: (post, tools, selected) => selected.publications.above(2),
          orderBy: (post, tools, selected) => selected.publications.descending,
        },
      )
      .toSQL(),
  ).toEqual({
    sql: `SELECT "author"."name" AS "author", COUNT(*) AS "publications", SUM("posts"."views")::numeric AS "views"\nFROM "posts" AS "posts"\nINNER JOIN "users" AS "author" ON "posts"."author_id" = "author"."id"\nWHERE "posts"."state" = $1\nGROUP BY "author"."name"\nHAVING COUNT(*) > $2\nORDER BY COUNT(*) DESC`,
    parameters: ["published", 2],
  });

  // A raw bucket with a parameter is one SQL text in every clause of a grouped query.
  expect(
    database
      .posts(
        (post, { sql, count }) => ({
          month: sql<string>`to_char(${post.createdAt}, ${"YYYY-MM"})`,
          posts: count(),
        }),
        {
          groupBy: (post, tools, selected) => [selected.month],
          orderBy: (post, tools, selected) => selected.month.ascending,
        },
      )
      .toSQL(),
  ).toEqual({
    sql: `SELECT to_char("posts"."created_at", $1) AS "month", COUNT(*) AS "posts"\nFROM "posts" AS "posts"\nGROUP BY to_char("posts"."created_at", $1)\nORDER BY to_char("posts"."created_at", $1) ASC`,
    parameters: ["YYYY-MM"],
  });
});

test("a nested aggregate is ordered by without writing it twice, at the root and inside relations", () => {
  expect(
    database
      .users(
        (user) => ({
          id: user.id,
          spent: user.orders.sum.total,
          orders: user.orders(
            (order, { sql }) => ({
              id: order.id,
              rounded: sql<string>`round(${order.total})`,
            }),
            {
              orderBy: (order, tools, selected) => [
                selected.rounded.descending,
                selected.id.ascending,
              ],
              limit: 3,
            },
          ),
        }),
        {
          orderBy: (user, { coalesce }, selected) => [
            coalesce(selected.spent, "0").descending,
            selected.id.ascending,
          ],
          limit: 10,
        },
      )
      .toSQL(),
  ).toEqual({
    sql: `SELECT "users"."id" AS "id", (SELECT SUM("__symmetria_aggregate_0"."total")::numeric AS "sum"\nFROM "orders" AS "__symmetria_aggregate_0"\nWHERE "users"."id" = "__symmetria_aggregate_0"."customer_id") AS "spent", (SELECT COALESCE(json_agg("__symmetria_row"), '[]'::json) FROM (SELECT "__symmetria_aggregate_0"."id" AS "id", round("__symmetria_aggregate_0"."total") AS "rounded"\nFROM "orders" AS "__symmetria_aggregate_0"\nWHERE "users"."id" = "__symmetria_aggregate_0"."customer_id"\nORDER BY round("__symmetria_aggregate_0"."total") DESC, "__symmetria_aggregate_0"."id" ASC\nLIMIT 3) AS "__symmetria_row") AS "orders"\nFROM "users" AS "users"\nORDER BY COALESCE((SELECT SUM("__symmetria_aggregate_0"."total")::numeric AS "sum"\nFROM "orders" AS "__symmetria_aggregate_0"\nWHERE "users"."id" = "__symmetria_aggregate_0"."customer_id"), $1) DESC, "users"."id" ASC\nLIMIT 10`,
    parameters: ["0"],
  });
});

test("reusable shapes, later option calls and prepared queries receive the fields", () => {
  const card = database.posts.shape((post, { sql }) => ({
    id: post.id,
    headline: sql<string>`upper(${post.title})`,
  }));
  const ordered = `SELECT "posts"."id" AS "id", upper("posts"."title") AS "headline"\nFROM "posts" AS "posts"\nORDER BY upper("posts"."title") DESC, "posts"."id" ASC`;

  expect(
    database
      .posts(card, {
        orderBy: (post, tools, selected) => [
          selected.headline.descending,
          selected.id.ascending,
        ],
      })
      .toSQL().sql,
  ).toBe(ordered);
  // Options added to a selected query read the selection it already has.
  expect(
    database
      .posts(card)({
        orderBy: (post, tools, selected) => [
          selected.headline.descending,
          selected.id.ascending,
        ],
      })
      .toSQL().sql,
  ).toBe(ordered);
  expect(
    database
      .users((user) => ({
        posts: user.posts(card, {
          orderBy: (post, tools, selected) => selected.headline.ascending,
        }),
      }))
      .toSQL().sql,
  ).toBe(
    `SELECT (SELECT COALESCE(json_agg("__symmetria_row"), '[]'::json) FROM (SELECT "__symmetria_aggregate_0"."id" AS "id", upper("__symmetria_aggregate_0"."title") AS "headline"\nFROM "posts" AS "__symmetria_aggregate_0"\nWHERE "users"."id" = "__symmetria_aggregate_0"."author_id"\nORDER BY upper("__symmetria_aggregate_0"."title") ASC) AS "__symmetria_row") AS "posts"\nFROM "users" AS "users"`,
  );

  const busy = prepare({ minimum: int }, (parameters) =>
    database.posts(
      (post, { count }) => ({ authorId: post.authorId, posts: count() }),
      {
        groupBy: (post, tools, selected) => [selected.authorId],
        having: (post, tools, selected) =>
          selected.posts.atLeast(parameters.minimum),
        orderBy: (post, tools, selected) => [
          selected.posts.descending,
          selected.authorId.ascending,
        ],
      },
    ),
  );
  expect(busy.toSQL({ minimum: 2 })).toEqual({
    sql: `SELECT "posts"."author_id" AS "authorId", COUNT(*) AS "posts"\nFROM "posts" AS "posts"\nGROUP BY "posts"."author_id"\nHAVING COUNT(*) >= $1\nORDER BY COUNT(*) DESC, "posts"."author_id" ASC`,
    parameters: [2],
  });
});

test("nested results and unknown names are rejected; where receives no fields", () => {
  expect(() =>
    database.users((user) => ({ id: user.id }), {
      orderBy: (user, tools, selected) => untyped(selected, "name").ascending,
    }),
  ).toThrow(
    `symmetria: "name" is not a selected field; the third callback argument holds the projection's fields: id`,
  );
  expect(() =>
    database.users({
      orderBy: (user, tools, selected) => untyped(selected, "id").ascending,
    }),
  ).toThrow(/holds the projection's fields: none/);

  const nested = (name: string) =>
    `symmetria: selected field "${name}" is a nested result; orderBy, groupBy and having take scalar fields`;

  for (const name of ["author", "profile"]) {
    expect(() =>
      database.posts(
        (post) => ({
          id: post.id,
          author: post.author((user) => ({ id: user.id })),
          profile: { title: post.title },
        }),
        { groupBy: (post, tools, selected) => [untyped(selected, name)] },
      ),
    ).toThrow(nested(name));
  }

  expect(() =>
    database.users(
      (user) => ({
        id: user.id,
        posts: user.posts((post) => ({ id: post.id })),
        drafts: database.posts((post) => ({ id: post.id })),
      }),
      {
        having: (user, tools, selected) => [
          untyped(selected, "drafts").is(null),
        ],
      },
    ),
  ).toThrow(nested("drafts"));
  expect(() =>
    database.users(
      (user) => ({
        id: user.id,
        posts: user.posts((post) => ({ id: post.id })),
      }),
      {
        orderBy: (user, tools, selected) =>
          untyped(selected, "posts").ascending,
      },
    ),
  ).toThrow(nested("posts"));

  let received: unknown[] = [];
  database.users((user) => ({ id: user.id }), {
    where: (...received_: unknown[]) => {
      received = received_;

      return undefined as never;
    },
  });
  expect(received).toHaveLength(2);
});

test("page() orders by selected expressions over root columns and still refuses aggregates", async () => {
  const feed = database.users(
    (user, { sql }) => ({
      id: user.id,
      initial: sql.of(text)`left(${user.name}, 1)`,
      posts: user.posts.count(),
    }),
    {
      orderBy: (user, tools, selected) => [
        selected.initial.ascending,
        selected.id.ascending,
      ],
    },
  );

  expect(feed.toSQL().sql).toEndWith(
    `ORDER BY left("users"."name", 1) ASC, "users"."id" ASC`,
  );
  await expect(
    feed({
      orderBy: (user, tools, selected) => selected.posts.descending,
    }).page({ size: 2 }),
  ).rejects.toThrow(
    "symmetria: page() ORDER BY accepts root columns and expressions over them only",
  );
});
