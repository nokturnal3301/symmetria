import {
  schema,
  table,
  int,
  text,
  bool,
  bigint,
  prepare,
  type QueryOptions,
  type QueryColumn,
} from "../../../packages/runtime/src";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

const users = table({ id: int.auto, name: text, email: text.unique });
const posts = table({
  id: int.auto,
  author: users,
  title: text,
  views: bigint.default(0n),
  published: bool.default(false),
});
const db = schema({ users, posts });
const authors = db.users(
  ({ name, posts }) => ({
    name,
    posts: posts(({ title, views }) => ({ title, views }), {
      where: ({ published }) => published.is(true),
      orderBy: ({ id }) => id.descending,
      limit: 3,
    }),
  }),
  { orderBy: ({ id }) => id.ascending, limit: 20 },
);
type Authors = Expect<
  Equal<
    Awaited<typeof authors>,
    { name: string; posts: { title: string; views: bigint }[] }[]
  >
>;
const card = db.posts.shape(({ title, views }) => ({ title, views }));
const shaped = db.posts(card, {
  where: ({ views }) => views.above(0n),
  limit: 3,
});
type Shaped = Expect<
  Equal<Awaited<typeof shaped>, { title: string; views: bigint }[]>
>;
const nestedShape = db.users(({ posts }) => ({
  posts: posts(card, { limit: 3 }),
}));
type Nested = Expect<
  Equal<
    Awaited<typeof nestedShape>,
    { posts: { title: string; views: bigint }[] }[]
  >
>;
const prepared = prepare({ size: int, name: text }, (p) =>
  db.users(({ name }) => ({ name }), {
    where: ({ name }) => name.is(p.name),
    limit: p.size,
  }),
);
const derived = shaped.cte("popular")(({ title }) => ({ title }), {
  orderBy: ({ views }) => views.descending,
});
type Derived = Expect<Equal<Awaited<typeof derived>, { title: string }[]>>;
db.posts(({ title }) => ({ title }), {
  where: undefined,
  limit: undefined,
  having: () => undefined,
});
const options: QueryOptions<{ id: QueryColumn<number, "id"> }, {}> = {
  orderBy: ({ id }) => id.ascending,
};
db.users(({ name }) => ({ name }), options);
db.users(({ posts }) => {
  const filtered = posts(() => ({}), {
    where: ({ published }) => published.is(true),
  });
  filtered.some();
  const limited = posts(() => ({}), { limit: 3 });
  // @ts-expect-error quantifiers cannot follow relation pagination
  limited.some();
  // @ts-expect-error relation options reject unknown keys
  posts(({ title }) => ({ title }), { wat: 1 });

  return { total: limited.count() };
});
db.posts(({ title }) => ({ title }), {
  // @ts-expect-error unknown option name
  $limit: 3,
});
db.posts(({ title }) => ({ title }), {
  // @ts-expect-error source columns are typed
  orderBy: ({ missing }) => missing.descending,
});
db.posts(({ title }) => ({ title }), {
  // @ts-expect-error ordering requires a direction
  orderBy: ({ id }) => id,
});
db.posts(({ title }) => ({ title }), {
  // @ts-expect-error limits are numeric
  limit: "3",
});
db.posts(({ title }) => ({ title }), {
  // @ts-expect-error option callbacks are synchronous
  where: async ({ id }) => id.is(1),
});

export type QueryOptionsContracts =
  | Authors
  | Shaped
  | Nested
  | Derived
  | typeof prepared;
