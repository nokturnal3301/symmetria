import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

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
const model = schema({ users, posts, orders });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("selected fields in query options", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_selected",
      max: 1,
    });
    database = isolated.database;
    await database.users.insert([
      { name: "Ada" },
      { name: "Bob" },
      { name: "Cy" },
      { name: "alan" },
    ]);
    await database.orders.insert([
      { customerId: 1, total: "10.00" },
      { customerId: 1, total: "15.50" },
      { customerId: 2, total: "99.99" },
      { customerId: 2, total: "0.01" },
      { customerId: 2, total: "5.00" },
      { customerId: 4, total: "25.49" },
    ]);
    await database.posts.insert(
      [
        [1, "Zeta", "published", 5n, "2024-01-10"],
        [1, "alpha", "published", 7n, "2024-01-20"],
        [1, "Beta", "published", 1n, "2024-02-05"],
        [1, "Draft", "draft", 100n, "2024-02-06"],
        [2, "Gamma", "published", 50n, "2024-02-07"],
        [2, "Delta", "published", 2n, "2024-03-01"],
        [4, "Omega", "published", 3n, "2024-03-02"],
      ].map(([authorId, title, state, views, day]) => ({
        authorId: authorId as number,
        title: title as string,
        state: state as "draft" | "published",
        views: views as bigint,
        createdAt: new Date(`${day as string}T12:00:00Z`),
      })),
    );
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("the reference example groups, filters and orders by its own fields", async () => {
    expect(
      await database.posts(
        (post, { join, count, sum }) => ({
          author: join(post.author).name,
          publications: count(),
          views: sum(post.views),
        }),
        {
          where: (post) => post.state.is.published,
          groupBy: (post, tools, selected) => [selected.author],
          having: (post, tools, selected) => selected.publications.above(1),
          orderBy: (post, tools, selected) => selected.publications.descending,
        },
      ),
    ).toEqual([
      { author: "Ada", publications: 3, views: "13" },
      { author: "Bob", publications: 2, views: "52" },
    ]);

    // A bucket with bound parameters is the same expression in every clause.
    expect(
      await database.posts(
        (post, { sql, count }) => ({
          month: sql<string>`to_char(${post.createdAt} at time zone ${"UTC"}, ${"YYYY-MM"})`,
          posts: count(),
        }),
        {
          groupBy: (post, tools, selected) => [selected.month],
          having: (post, tools, selected) => selected.posts.above(1),
          orderBy: (post, tools, selected) => selected.month.descending,
        },
      ),
    ).toEqual([
      { month: "2024-03", posts: 2 },
      { month: "2024-02", posts: 3 },
      { month: "2024-01", posts: 2 },
    ]);
    expect(
      await database.posts(
        (post, { sql }) => ({
          initial: sql<string>`upper(left(${post.title}, ${1}))`,
        }),
        {
          distinct: true,
          orderBy: (post, tools, selected) => selected.initial.descending,
          limit: 3,
        },
      ),
    ).toEqual([{ initial: "Z" }, { initial: "O" }, { initial: "G" }]);
  });

  test("nested aggregates order the root and relations order by their own fields", async () => {
    expect(
      await database.users(
        (user) => ({
          name: user.name,
          spent: user.orders.sum.total,
          orders: user.orders(
            (order, { sql }) => ({
              total: order.total,
              rounded: sql.of(int)`round(${order.total})::int`,
            }),
            {
              orderBy: (order, tools, selected) => [
                selected.rounded.descending,
                selected.total.ascending,
              ],
              limit: 2,
            },
          ),
        }),
        {
          orderBy: (user, { coalesce }, selected) => [
            coalesce(selected.spent, "0").descending,
            selected.name.ascending,
          ],
        },
      ),
    ).toEqual([
      {
        name: "Bob",
        spent: "105.00",
        orders: [
          { total: "99.99", rounded: 100 },
          { total: "5.00", rounded: 5 },
        ],
      },
      {
        name: "Ada",
        spent: "25.50",
        orders: [
          { total: "15.50", rounded: 16 },
          { total: "10.00", rounded: 10 },
        ],
      },
      {
        name: "alan",
        spent: "25.49",
        orders: [{ total: "25.49", rounded: 25 }],
      },
      { name: "Cy", spent: null, orders: [] },
    ]);
  });

  test("shapes, later options and prepared queries order by selected fields", async () => {
    const card = database.posts.shape((post, { sql }) => ({
      id: post.id,
      headline: sql<string>`upper(${post.title})`,
    }));
    const headlines = [
      "ALPHA",
      "BETA",
      "DELTA",
      "DRAFT",
      "GAMMA",
      "OMEGA",
      "ZETA",
    ];

    expect(
      (
        await database.posts(card, {
          orderBy: (post, tools, selected) => selected.headline.ascending,
        })
      ).map((post) => post.headline),
    ).toEqual(headlines);
    expect(
      (
        await database.posts(card)({
          orderBy: (post, tools, selected) => selected.headline.descending,
        })
      ).map((post) => post.headline),
    ).toEqual(headlines.toReversed());
    expect(
      await database.users(
        (user) => ({
          posts: user.posts(card, {
            orderBy: (post, tools, selected) => selected.headline.ascending,
            limit: 2,
          }),
        }),
        { where: (user) => user.id.is(1) },
      ),
    ).toEqual([
      {
        posts: [
          { id: 2, headline: "ALPHA" },
          { id: 3, headline: "BETA" },
        ],
      },
    ]);

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
    expect(await busy.execute({ minimum: 2 })).toEqual([
      { authorId: 1, posts: 4 },
      { authorId: 2, posts: 2 },
    ]);
    expect(await busy.execute({ minimum: 4 })).toEqual([
      { authorId: 1, posts: 4 },
    ]);
  });

  test("keyset pages follow a selected expression in both directions", async () => {
    const feed = database.posts(
      (post, { sql }) => ({
        id: post.id,
        headline: sql.of(text)`upper(${post.title})`,
      }),
      {
        where: (post) => post.state.is.published,
        orderBy: (post, tools, selected) => [
          selected.headline.descending,
          selected.id.ascending,
        ],
      },
    );
    const all = await feed;
    const seen: typeof all = [];

    for await (const page of feed.pages({ size: 4 })) {
      seen.push(...page.items);
    }

    expect(all.map((post) => post.headline)).toEqual([
      "ZETA",
      "OMEGA",
      "GAMMA",
      "DELTA",
      "BETA",
      "ALPHA",
    ]);
    expect(seen).toEqual(all);

    const first = await feed.page({ size: 2 });
    const second = await feed.page({ size: 2, after: first.nextCursor });
    const back = await feed.page({ size: 2, before: second.previousCursor });
    expect(second.items).toEqual(all.slice(2, 4));
    expect(back.items).toEqual(first.items);
  });
});
