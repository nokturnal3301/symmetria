import {
  schema,
  table,
  int,
  text,
  bigint,
  bool,
  numeric,
  timestamptz,
  index,
  prepare,
  type Decimal,
} from "../../../packages/runtime/src";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
const users = table({ id: int.auto, name: text, email: text.unique });
const posts = table({
  id: int.auto,
  author: users,
  title: text,
  views: bigint,
  amount: numeric(12, 2),
  live: bool,
  createdAt: timestamptz,
});
const db = schema({
  users,
  posts,
  memberships: table({ tenant: int, user: users, label: text })
    .primaryKey(({ tenant, userId }) => [tenant, userId])
    .indexes(({ tenant, label }) => ({
      tenantLabel: index(tenant, label).unique,
    })),
});
const published = db.posts({ where: ({ live }) => live.is(true) });
// @ts-expect-error an unselected query does not execute
published.execute();
const selected = published(({ title }) => ({ title }))({ limit: 3 });
type Selected = Expect<Equal<Awaited<typeof selected>, { title: string }[]>>;
const grouped = db.users(({ name, posts }) => {
  const filtered = posts({ where: ({ live }) => live.is(true) });
  filtered.some();
  const limited = filtered({ orderBy: ({ id }) => id.descending, limit: 3 });
  // @ts-expect-error paginated relations do not expose quantifiers
  limited.some();
  // @ts-expect-error boolean fields cannot be summed
  posts.sum.live;
  // @ts-expect-error unknown aggregate column
  posts.maximum.missing;
  // @ts-expect-error unknown relation option
  posts({ limti: 1 });

  return {
    name,
    total: limited.sum.views,
    average: posts.average.amount,
    last: posts.maximum.createdAt,
    title: posts.minimum.title,
  };
});
type Grouped = Expect<
  Equal<
    Awaited<typeof grouped>,
    {
      name: string;
      total: Decimal | null;
      average: Decimal | null;
      last: Date | null;
      title: string | null;
    }[]
  >
>;
const card = db.users.shape(({ id, name }, { sql }) => ({
  id,
  name,
  upper: sql.of(text)`upper(${name})`,
}));
const created = db.users.insert({ name: "Ada", email: "ada" }).returning(card);
type Created = Expect<
  Equal<Awaited<typeof created>, { id: number; name: string; upper: string }>
>;
const updated = db.users.byId(1).update({ name: "Lin" }).returning(card);
type Updated = Expect<
  Equal<Awaited<typeof updated>, { id: number; name: string; upper: string }[]>
>;
db.users.by.email("ada").delete().returning(card);
db.memberships.byId({ tenant: 1, userId: 2 }).update({ label: "admin" });
db.memberships.by.tenantLabel({ tenant: 1, label: "admin" }).delete();
// @ts-expect-error lookup writes keep the source's write types
db.users.byId(1).update({ name: 123 });
// @ts-expect-error generated identities remain unwritable
db.users.byId(1).update({ id: 2 });
// @ts-expect-error a projection belongs to its table
db.posts.delete().returning(card);
const nested = db.users
  .insert({
    name: "Ada",
    email: "ada",
    posts: {
      create: [
        {
          title: "post",
          views: 1n,
          amount: "1.25",
          live: true,
          createdAt: new Date(),
        },
      ],
    },
  })
  .returning(card);
type Nested = Expect<Equal<Awaited<typeof nested>, Awaited<typeof created>>>;
const find = prepare({ id: int }, (p) =>
  db.users.byId(p.id)(({ name }) => ({ name })),
);
type Found = Expect<
  Equal<Awaited<ReturnType<typeof find>>, { name: string }[]>
>;
find({ id: 1 });
// @ts-expect-error prepared calls require all named parameters
find();
// @ts-expect-error prepared call parameter types are retained
find({ id: "1" });
selected.prepare()();
export type ErgonomicContracts =
  | Selected
  | Grouped
  | Created
  | Updated
  | Nested
  | Found;
