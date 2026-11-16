// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  int,
  bigint,
  text,
  bool,
  index,
  sum,
  count,
  maximum,
} from "../../../packages/runtime/src";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const users = table({ id: int.auto, name: text, active: bool.default(true) });
const posts = table({
  id: int.auto,
  title: text,
  author: users,
  views: bigint.default(0n),
});
const logs = table({ line: text });
const model = schema({ users, posts, logs });

{
  const caught = await model
    .users((user) => ({ id: user.id }))
    .catch(() => "failed" as const);
  type Caught = Expect<AreEqual<typeof caught, { id: number }[] | "failed">>;
  const written = await model.users
    .insert({ name: "Ada" })
    .returning((user) => [user.id])
    .catch(() => null);
  type Written = Expect<AreEqual<typeof written, { id: number } | null>>;
  const settled = await model.users
    .delete()
    .all()
    .finally(() => {});
  type Settled = Expect<AreEqual<typeof settled, { affectedRows: number }>>;
  const nested = await model.posts
    .insert({ title: "x", author: { create: { name: "Ada" } } })
    .catch(() => undefined);
  type Nested = Expect<
    AreEqual<typeof nested, { affectedRows: number } | undefined>
  >;
}

{
  const user = await model.users.get(1);
  type User = Expect<
    AreEqual<typeof user, { id: number; name: string; active: boolean }>
  >;
  const maybe = await model.users.find(1);
  type Maybe = Expect<
    AreEqual<typeof maybe, { id: number; name: string; active: boolean } | null>
  >;
  const card = await model.posts.find(1, (post) => ({
    title: post.title,
    author: post.author.name,
  }));
  type Card = Expect<
    AreEqual<typeof card, { title: string; author: string } | null>
  >;
  // @ts-expect-error the key is a number
  model.users.get("1");
  // @ts-expect-error a table without a primary key has no get()
  model.logs.get(1);
}

{
  const accounts = table({
    id: int.auto,
    email: text.unique,
    tenant: text,
    handle: text,
  }).indexes((account) => ({
    identity: index(account.tenant, account.handle).unique,
  }));
  const lines = table({ line: text.unique });
  const keyed = schema({ accounts, lines });

  const account = await keyed.accounts.get({ email: "ada@x.test" });
  type Account = Expect<
    AreEqual<
      typeof account,
      { id: number; email: string; tenant: string; handle: string }
    >
  >;
  const card = await keyed.accounts.find(
    { tenant: "team", handle: "ada" },
    (found) => ({ id: found.id }),
  );
  type Card = Expect<AreEqual<typeof card, { id: number } | null>>;
  await keyed.accounts.find({ id: 1 });
  // A table without a primary key is read by its unique column.
  const line = await keyed.lines.find({ line: "started" });
  type Line = Expect<AreEqual<typeof line, { line: string } | null>>;
  // @ts-expect-error the email is text
  keyed.accounts.get({ email: 1 });
  // @ts-expect-error half of a composite key
  keyed.accounts.get({ tenant: "team" });
  // @ts-expect-error not a key
  keyed.accounts.get({ handle: "ada" });
  // @ts-expect-error without a primary key there is no bare value
  keyed.lines.get("started");
}

{
  const running = await model.posts((post) => ({
    views: sum(post.views).over({ orderBy: post.id.asc }),
    seen: count().over({ partitionBy: [post.authorId] }),
    top: maximum(post.views).over(),
    plain: sum(post.views),
  }));
  type Running = Expect<
    AreEqual<
      typeof running,
      {
        views: `${number}` | null;
        seen: number;
        top: bigint | null;
        plain: `${number}` | null;
      }[]
    >
  >;
  model.posts((post) => ({ id: post.id }), {
    orderBy: (post) => [{ id: "descending", title: "ascending" }, post.id.desc],
  });
}

{
  const totals = await model.posts.aggregate((post, { count, sum }) => ({
    posts: count(),
    views: sum(post.views),
  }));
  type Totals = Expect<
    AreEqual<typeof totals, { posts: number; views: `${number}` | null }>
  >;
}

{
  const filtered = await model.posts({ where: { title: "x", authorId: 1 } });
  type Filtered = Expect<
    AreEqual<
      typeof filtered,
      { id: number; title: string; authorId: number; views: bigint }[]
    >
  >;
  const first = await model
    .users({ limit: 1 })({ where: { id: 1 } })
    .first();
  type First = Expect<
    AreEqual<typeof first, { id: number; name: string; active: boolean } | null>
  >;
  const ranked = model
    .posts((post) => ({
      id: post.id,
      views: post.views,
      author: { name: post.author.name },
    }))
    .cte("ranked");
  const top = await ranked({ where: (post) => post.views.above(1n) });
  type Top = Expect<
    AreEqual<
      typeof top,
      { id: number; views: bigint; author: { name: string } }[]
    >
  >;
  // @ts-expect-error a bare CTE is not a query
  ranked.execute();
  model.posts((post) => ({ id: post.id }), {
    where: { views: 1n, title: undefined },
    orderBy: { id: "desc", title: "asc" },
  });
  model.users((user) => ({ id: user.id }), {
    where: (user) => [
      user.posts.some((post) => [post.views.above(1n), undefined]),
      user.posts.none((post) => [post.title.is("x")]),
      user.posts.every((post) => [post.views.above(1n)]),
    ],
  });
  model.posts((post) => ({ id: post.id }), {
    // @ts-expect-error no such column
    where: { titel: "x" },
  });
  model.posts((post) => ({ id: post.id }), {
    // @ts-expect-error the title is text
    where: { title: 1 },
  });
  model.posts((post) => ({ id: post.id }), {
    // @ts-expect-error a relation is not a column
    where: { author: 1 },
  });
  model.posts((post) => ({ id: post.id }), {
    // @ts-expect-error a direction is "asc" or "desc"
    orderBy: { id: "up" },
  });
  model.users((user) => ({ name: user.name, written: user.posts.count() }), {
    orderBy: [{ written: "desc" }, { id: "asc" }],
    having: (_user, { selected }) => selected.written.above(1),
  });
  model.users((user) => ({ name: user.name }), {
    orderBy: (user, { selected }) => [
      selected.name.ascending,
      user.id.descending,
    ],
  });
  model.users((user) => ({ name: user.name }), {
    // @ts-expect-error where has no selected fields
    where: (user, { selected }) => selected.name.is("x"),
  });
  // @ts-expect-error a bare table does not execute
  model.users.execute();
}

{
  const whole = await model.posts((post, { row }) => ({
    ...row,
    author: post.author.name,
  }));
  type Whole = Expect<
    AreEqual<
      typeof whole,
      {
        id: number;
        title: string;
        authorId: number;
        views: bigint;
        author: string;
      }[]
    >
  >;
  const nested = await model.users((user) => ({
    posts: user.posts((_post, { row }) => ({ ...row })),
  }));
  type Nested = Expect<
    AreEqual<
      typeof nested,
      {
        posts: { id: number; title: string; authorId: number; views: bigint }[];
      }[]
    >
  >;
}

model.posts((post) => ({ id: post.id }), {
  where: (post) =>
    post.views.above(1).and(post.title.is("a").or(post.id.is(2))),
});

{
  model.posts.update({ title: "x" }, { where: { id: 1 } });
  model.posts.update(
    { title: "x" },
    { where: (post) => post.author.name.is("Ada") },
  );
  model.posts.delete({ where: (post) => [post.id.is(1), post.views.above(2)] });
  model.posts.byId(1).delete({ where: { title: "x" } });
  // @ts-expect-error no such column
  model.posts.delete({ where: { titel: "x" } });
  // @ts-expect-error where is the only option
  model.posts.delete({ limit: 1 });

  const upserted = await model.users
    .upsert({ name: "Ada" }, { by: "id", update: ["name"] })
    .returning("id", "name");
  type Upserted = Expect<
    AreEqual<typeof upserted, { id: number; name: string }>
  >;
  const many = await model.users.upsert([{ name: "Ada" }], { by: ["id"] });
  type Many = Expect<AreEqual<typeof many, { affectedRows: number }>>;
  // @ts-expect-error the key is required
  model.users.upsert({ name: "Ada" }, {});
  // @ts-expect-error not a column
  model.users.upsert({ name: "Ada" }, { by: "nmae" });

  const whole = await model.users.byId(1).update({ name: "B" }).returning();
  type Whole = Expect<
    AreEqual<typeof whole, { id: number; name: string; active: boolean }[]>
  >;
  const nested = await model.posts
    .insert({ title: "x", author: { create: { name: "Ada" } } })
    .returning("id");
  type NestedId = Expect<AreEqual<typeof nested, { id: number }>>;
  // @ts-expect-error not a column
  model.users.delete().all().returning("nmae");
}

{
  const [user, titles, total] = await model.$batch((db) => [
    db.users.get(1),
    db.posts((post) => ({ title: post.title })),
    db.posts.count(),
  ]);
  type User = Expect<
    AreEqual<typeof user, { id: number; name: string; active: boolean }>
  >;
  type Titles = Expect<AreEqual<typeof titles, { title: string }[]>>;
  type Total = Expect<AreEqual<typeof total, number>>;

  const page = await model.$batch((db) => ({
    author: db.users.find(1, (found) => ({ name: found.name })),
    drafts: db.posts({ where: { title: "x" } }).exists(),
  }));
  type Page = Expect<
    AreEqual<typeof page, { author: { name: string } | null; drafts: boolean }>
  >;

  await model.$transaction((transaction) =>
    transaction.$batch((db) => [db.users.count()]),
  );
}
