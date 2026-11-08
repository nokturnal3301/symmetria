import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bool,
  bigint,
  prepare,
  type Ordering,
} from "../../../packages/runtime/src";

const db = schema({
  users: { id: int, name: text },
  posts: ({ users }) => ({
    id: int,
    author: users,
    title: text,
    views: bigint,
    published: bool,
  }),
});

test("separate options retain nested limits, source fields and prepared parameter order", () => {
  const modern = prepare({ title: text, size: int }, (p) =>
    db.users(
      ({ name, posts }) => ({
        name,
        posts: posts(({ title, views }) => ({ title, views }), {
          where: ({ title, published }, { and }) =>
            and(title.is(p.title), published.is(true)),
          orderBy: ({ id }) => id.descending,
          limit: p.size,
        }),
      }),
      {
        where: ({ id }) => id.above(1),
        orderBy: ({ id }) => id.ascending,
        limit: 20,
      },
    ),
  );
  const existing = prepare({ title: text, size: int }, (p) =>
    db.users(
      (user) => ({
        name: user.name,
        posts: user.posts(
          (post, { and }) => ({
            title: post.title,
            views: post.views,
          }),
          {
            where: (post, { and }) =>
              and(post.title.is(p.title), post.published.is(true)),
            orderBy: (post, { and }) => post.id.descending,
            limit: p.size,
          },
        ),
      }),
      {
        where: (user) => user.id.above(1),
        orderBy: (user) => user.id.ascending,
        limit: 20,
      },
    ),
  );
  expect(modern.toSQL({ title: "typed", size: 3 })).toEqual(
    existing.toSQL({ title: "typed", size: 3 }),
  );
});

test("reusable shapes, aliases and CTEs accept options without losing selections", () => {
  const card = db.posts.shape(({ title, views }) => ({ title, views }));
  const base = db.posts.as("article")(card, {
    where: ({ views }) => views.above(0n),
  });
  const before = base.toSQL();
  const branch = base(() => ({}), {
    orderBy: ({ id }) => id.descending,
    limit: 3,
  });
  expect(branch.toSQL().sql).toContain('ORDER BY "article"."id" DESC\nLIMIT 3');
  expect(base.toSQL()).toEqual(before);
  const derived = branch.cte("popular")(({ title }) => ({ title }), {
    orderBy: ({ views }) => views.descending,
  });
  expect(derived.toSQL().sql).toContain('ORDER BY "popular"."views" DESC');
  expect(
    db.users(({ posts }) => ({ posts: posts(card, { limit: 2 }) })).toSQL().sql,
  ).toContain("LIMIT 2");
});

test("options of a later call append conditions and ordering; limits and DISTINCT replace", () => {
  const query = db.posts(({ title }) => ({ title }), {
    where: ({ views }) => views.above(0n),
    orderBy: ({ id }) => id.ascending,
    limit: 20,
    distinct: true,
  })({
    where: ({ published }) => published.is(true),
    orderBy: ({ title }) => title.descending,
    limit: () => 3,
    distinct: false,
  });
  const expected = db.posts(({ title }) => ({ title }), {
    where: ({ views, published }) => [views.above(0n), published.is(true)],
    orderBy: ({ id, title }) => [id.ascending, title.descending],
    limit: 3,
  });
  expect(query.toSQL()).toEqual(expected.toSQL());
  expect(() =>
    db.posts(({ title }) => ({ title }), { forShare: true, forUpdate: true }),
  ).toThrow(/choose either/);
});

test("option callbacks share relation bindings and local JOIN tools with the projection", () => {
  let descending: Ordering;
  const query = db.posts(
    ({ title, author }) => ({ title, author: author.name }),
    {
      where: ({ author }, { join }) => join(author).name.is("Ada"),
      orderBy: ({ author }) => (descending = author.name.descending),
    },
  );
  expect(query.toSQL().sql).toContain("JOIN");
  expect(query.toSQL().parameters).toEqual(["Ada"]);
  expect(descending!).toBeDefined();

  let leaked: () => unknown = () => {};

  db.posts(({ title }) => ({ title }), {
    where: ({ author }, { join }) => {
      leaked = () => join(author);

      return author.id.is(1);
    },
  });
  expect(leaked).toThrow(/inside their shape callback/);
});

test("grouping, having, distinct and locks use the existing PostgreSQL plan", () => {
  const grouped = db
    .posts(
      ({ authorId, views }, { sum }) => ({ authorId, total: sum(views) }),
      {
        groupBy: ({ authorId }) => [authorId],
        having: ({ views }, { sum }) => sum(views).above("10"),
        orderBy: ({ authorId }) => authorId.ascending,
        distinct: true,
        offset: 2,
      },
    )
    .toSQL();
  expect(grouped.sql).toContain("SELECT DISTINCT");
  expect(grouped.sql).toContain('GROUP BY "posts"."author_id"');
  expect(grouped.sql).toContain("HAVING");
  expect(grouped.sql).toEndWith("OFFSET 2");
  expect(
    db
      .posts(({ title }) => ({ title }), { forUpdate: { skipLocked: true } })
      .toSQL().sql,
  ).toEndWith("FOR UPDATE SKIP LOCKED");
});

test("invalid options fail before execution and optional controls can be omitted", () => {
  const select = ({
    title,
  }: Parameters<Parameters<typeof db.posts>[0]>[0]) => ({ title });

  expect(() => db.posts(select, { unknown: 1 } as never)).toThrow(
    /unknown query option/,
  );
  expect(() => db.posts(select, null as never)).toThrow(
    /options must be an object/,
  );
  expect(() => db.posts(select, { forUpdate: true, forShare: true })).toThrow(
    /choose either/,
  );
  expect(() => db.posts(select, { limit: -1 })).toThrow();
  expect(
    db.posts(select, { where: undefined, limit: undefined }).toSQL(),
  ).toEqual(db.posts(select).toSQL());
});
