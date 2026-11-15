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
  type Decimal,
} from "../../../packages/runtime/src";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

const users = table({ id: int.auto, name: text });
const posts = table({
  id: int.auto,
  author: users,
  title: text,
  state: oneOf("draft", "published"),
  views: bigint,
  createdAt: timestamptz,
});
const orders = table({
  id: int.auto,
  customer: users,
  total: numeric(12, 2),
  quantity: int,
  price: numeric(12, 2),
  createdAt: timestamptz,
});
const database = schema({ users, posts, orders });

// The example of the reference: fields are computed once and reused by name.
const authors = database.posts(
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
);
type Authors = Expect<
  Equal<
    Awaited<typeof authors>,
    { author: string; publications: number; views: Decimal | null }[]
  >
>;

// The other snippets of the reference.
const bySpend = database.users(
  (user) => ({
    name: user.name,
    spent: user.orders.sum((order) => order.quantity.multiply(order.price)),
  }),
  { orderBy: (user, tools, selected) => selected.spent.descending.nullsLast },
);
type BySpend = Expect<
  Equal<Awaited<typeof bySpend>, { name: string; spent: Decimal | null }[]>
>;
const perMonth = database.posts(
  (post, { sql, count }) => ({
    month: sql<string>`to_char(${post.createdAt}, 'YYYY-MM')`,
    posts: count(),
  }),
  {
    groupBy: (post, tools, selected) => [selected.month],
    orderBy: (post, tools, selected) => selected.month.ascending,
  },
);
type PerMonth = Expect<
  Equal<Awaited<typeof perMonth>, { month: string; posts: number }[]>
>;
const orderMonths = database.orders(
  (order, { dateTrunc, count }) => ({
    month: dateTrunc("month", order.createdAt, { timeZone: "Europe/Berlin" }),
    orders: count(),
  }),
  {
    groupBy: (order, tools, selected) => [selected.month],
    orderBy: (order, tools, selected) => selected.month.ascending,
  },
);
type OrderMonths = Expect<
  Equal<Awaited<typeof orderMonths>, { month: Date; orders: number }[]>
>;

// A nested aggregate and a raw bucket are ordered and grouped without repeating them.
const spenders = database.users(
  (user, { sql }) => ({
    id: user.id,
    spent: user.orders.sum.total,
    initial: sql<string>`left(${user.name}, 1)`,
    orders: user.orders((order) => ({ id: order.id, total: order.total }), {
      orderBy: (order, tools, selected) => selected.total.descending,
      limit: 3,
    }),
    latest: user.posts(
      (post, { dateTrunc }) => ({ day: dateTrunc("day", post.createdAt) }),
      {
        orderBy: (post, tools, selected) => [
          selected.day.descending,
          post.id.ascending,
        ],
      },
    ),
    profile: { name: user.name },
  }),
  {
    orderBy: (user, { coalesce }, selected) => [
      coalesce(selected.spent, "0").descending,
      selected.initial.ascending.nullsLast,
      user.id.ascending,
    ],
    limit: 10,
  },
);
type Spenders = Expect<
  Equal<
    Awaited<typeof spenders>,
    {
      id: number;
      spent: Decimal | null;
      initial: string;
      orders: { id: number; total: Decimal }[];
      latest: { day: Date }[];
      profile: { name: string };
    }[]
  >
>;

// Reusable shapes, later option calls and prepared queries see the fields too.
const card = database.posts.shape((post, { sql }) => ({
  id: post.id,
  headline: sql<string>`upper(${post.title})`,
}));
database.posts(card, {
  orderBy: (post, tools, selected) => [
    selected.headline.ascending,
    selected.id.ascending,
  ],
});
database.users((user) => ({
  posts: user.posts(card, {
    orderBy: (post, tools, selected) => selected.headline.ascending,
  }),
}));
const narrowed = database.posts(card)({
  orderBy: (post, tools, selected) => selected.headline.descending,
});
type Narrowed = Expect<
  Equal<Awaited<typeof narrowed>, { id: number; headline: string }[]>
>;
prepare({ minimum: int }, (parameters) =>
  database.posts(
    (post, { count }) => ({ authorId: post.authorId, posts: count() }),
    {
      groupBy: (post, tools, selected) => [selected.authorId],
      having: (post, tools, selected) =>
        selected.posts.atLeast(parameters.minimum),
      orderBy: (post, tools, selected) => selected.posts.descending,
    },
  ),
);

database.users(
  (user) => ({
    id: user.id,
    posts: user.posts((post) => ({ id: post.id })),
    author: { name: user.name },
    firstPost: user.posts((post) => ({ id: post.id }), { limit: 1 }),
  }),
  {
    // @ts-expect-error not a field of the projection
    orderBy: (user, tools, selected) => selected.name.ascending,
    // @ts-expect-error a nested collection is not a value to group by
    groupBy: (user, tools, selected) => [selected.posts],
    // @ts-expect-error a nested object is not a value to filter by
    having: (user, tools, selected) => selected.author.is(null),
  },
);
database.users((user) => ({ id: user.id }), {
  // @ts-expect-error where runs before the projection exists: two arguments
  where: (user, tools, selected) => selected.id.is(1),
});
database.posts(
  (post) => ({ author: post.author((user) => ({ id: user.id })) }),
  {
    // @ts-expect-error a relation selected with a shape is a nested result
    orderBy: (post, tools, selected) => selected.author.ascending,
  },
);
database.posts({
  // @ts-expect-error nothing is selected yet
  orderBy: (post, tools, selected) => selected.title.ascending,
});
