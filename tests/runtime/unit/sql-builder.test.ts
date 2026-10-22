import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  bool,
  numeric,
  jsonb,
  timestamptz,
  customType,
  oneOf,
  sql,
  and,
  count,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  exists,
  not,
  defaultValue,
  type CompiledQuery,
} from "../../../packages/runtime/src";

const model = schema({
  users: {
    id: int.auto,
    name: text.unique,
    balance: numeric(20, 2).default("0"),
    visits: int.default(0),
    active: bool.default(true),
  },
  posts: ({ users }) => ({
    id: int.auto,
    title: text,
    author: users,
    editor: users.nullable.inverse("edited"),
    views: bigint.default(0n),
    metadata: jsonb<{ tags: string[] }>().nullable,
    createdAt: timestamptz.now,
  }),
});

test("INSERT compiles defaults, nullable omissions and heterogeneous bulk rows", () => {
  const query = model.posts
    .insert([
      {
        title: "first",
        authorId: 3,
        views: 9007199254740993n,
        metadata: { tags: ["sql"] },
      },
      { title: "second", authorId: 3, views: defaultValue },
    ])
    .returning((posts) => [posts.id, posts.title]);
  expect(query.toSQL()).toEqual({
    sql: 'INSERT INTO "posts" AS "posts"\n("title", "views", "metadata", "author_id") VALUES ($1, $2, $3::text::jsonb, $4), ($5, DEFAULT, DEFAULT, $6)\nRETURNING "posts"."id" AS "id", "posts"."title" AS "title"',
    parameters: [
      "first",
      "9007199254740993",
      '{"tags":["sql"]}',
      3,
      "second",
      3,
    ],
  });
});

test("UPDATE supports expressions and DELETE carries predicates and RETURNING", () => {
  const update = model.users
    .update((users) => ({ visits: users.visits.plus(1), name: "Ada" }))
    .where((users) => users.id.is(7))
    .returning((users) => [users.visits])
    .toSQL();
  expect(update.sql).toBe(
    'UPDATE "users" AS "users" SET "visits" = ("users"."visits" + $1), "name" = $2\nWHERE "users"."id" = $3\nRETURNING "users"."visits" AS "visits"',
  );
  expect(update.parameters).toEqual([1, "Ada", 7]);
  expect(
    model.posts
      .delete()
      .where((posts) => posts.views.below(2n))
      .toSQL(),
  ).toEqual({
    sql: 'DELETE FROM "posts" AS "posts"\nWHERE "posts"."views" < $1',
    parameters: ["2"],
  });
});

test("upsert exposes the excluded row only to DO UPDATE", () => {
  const query = model.users
    .insert({ name: "Ada" })
    .onConflict("name")
    .doUpdate((users, excluded) => ({
      name: excluded.name,
      visits: users.visits.plus(1),
    }))
    .returning((users) => [users.id, users.visits]);
  expect(query.toSQL().sql).toContain(
    'ON CONFLICT ("name") DO UPDATE SET "name" = "excluded"."name", "visits" = ("users"."visits" + $2)',
  );
  expect(query.toSQL().parameters).toEqual(["Ada", 1]);
  expect(
    model.users.insert({ name: "Ada" }).onConflict().doNothing().toSQL().sql,
  ).toEndWith("ON CONFLICT DO NOTHING");
});

test("write validation catches missing values, unknown columns and generated identities", () => {
  // @ts-expect-error title is required
  expect(() => model.posts.insert({ authorId: 1 })).toThrow(/missing required/);
  // @ts-expect-error generated identity cannot be assigned
  expect(() => model.users.insert({ id: 1, name: "Ada" })).toThrow(
    /generated always/,
  );
  // @ts-expect-error undefined is not an explicit SQL value
  expect(() => model.users.insert({ name: "Ada", visits: undefined })).toThrow(
    /undefined/,
  );
  // @ts-expect-error unknown column
  expect(() => model.users.update({ missing: 1 })).toThrow(/unknown column/);
  expect(() => model.users.update({})).toThrow(/at least one/);
  expect(() => model.users.insert([])).toThrow(/at least one/);
  expect(() =>
    model.users
      .insert({ name: "Ada" })
      .onConflict()
      .doUpdate({ name: "Grace" }),
  ).toThrow(/conflict columns/);
});

test("explicit aliases, nested relation joins and repeated relations have separate scopes", () => {
  const query = model.posts((posts, { innerJoin, leftJoin }) => {
    const reviewer = innerJoin(model.users.as("reviewer"), (reviewer) =>
      posts.editorId.is(reviewer.id),
    );
    const writer = leftJoin(posts.author.as("writer"));
    const otherPosts = leftJoin(writer.posts.as("otherPosts"));

    return {
      title: posts.title,
      name: reviewer.name,
      writerName: writer.name,
      otherId: otherPosts.id,
    };
  });
  expect(query.toSQL().sql).toContain(
    'INNER JOIN "users" AS "reviewer" ON ("posts"."editor_id" = "reviewer"."id")',
  );
  expect(query.toSQL().sql).toContain(
    'LEFT JOIN "posts" AS "otherPosts" ON "writer"."id" = "otherPosts"."author_id"',
  );
  const repeated = model.posts((posts, { leftJoin }) => {
    const author = leftJoin(posts.author);
    const otherAuthor = leftJoin(posts.author.as("otherAuthor"));

    return { id: author.id, otherId: otherAuthor.id };
  });
  expect(repeated.toSQL().sql).toContain('AS "otherAuthor"');
});

test("subqueries number parameters in text order and preserve derived aliases", () => {
  const recent = model
    .posts((posts) => ({
      authorId: posts.authorId,
      $where: posts.views.above(9n),
    }))
    .as("recent");
  const query = model.users((users, { innerJoin }) => {
    const recentRow = innerJoin(recent, (recentRow) =>
      users.id.is(recentRow.authorId),
    );

    return {
      greeting: sql<string>`concat(${"Hello "}::text, ${users.name})`.as(
        "greeting",
      ),
      $where: users.name.isNot("Guest"),
    };
  });
  expect(query.toSQL().parameters).toEqual(["Hello ", "9", "Guest"]);
  expect(query.toSQL().sql).toContain(
    'INNER JOIN (SELECT "posts"."author_id" AS "authorId"',
  );
  expect(query.toSQL().sql).toContain('"recent"."authorId"');
  expect(
    recent((recent) => ({ authorId: recent.authorId })).toSQL().sql,
  ).toContain("FROM (SELECT");
});

test("correlated EXISTS, IN and scalar subqueries share the enclosing parameter list", () => {
  const query = model.users((users) => ({
    name: users.name,
    $where: [
      exists(
        model.posts((posts) => ({
          id: posts.id,
          $where: [posts.authorId.is(users.id), posts.title.ilike("%sql%")],
        })),
      ),
      users.id.in(model.posts((posts) => ({ authorId: posts.authorId }))),
      users.visits.above(
        model.users
          .as("others")((others) => ({ maximum: maximum(others.visits) }))
          .scalar(),
      ),
    ],
  }));
  expect(query.toSQL().parameters).toEqual(["%sql%"]);
  expect(query.toSQL().sql).toContain('"posts"."author_id" = "users"."id"');
  expect(query.toSQL().sql).toContain(
    '"users"."visits" > (SELECT MAX("others"."visits")',
  );
});

test("aggregates, GROUP BY, HAVING, DISTINCT and null ordering compile together", () => {
  const query = model.posts((posts, { innerJoin }) => {
    const author = innerJoin(posts.author);

    return {
      name: author.name,
      postCount: count().as("postCount"),
      sum: sum(posts.views),
      average: average(posts.views),
      minimum: minimum(posts.createdAt),
      maximum: maximum(posts.id),
      $groupBy: [author.name],
      $having: count().above(1),
      $orderBy: author.name.ascending.nullsLast,
      $distinct: true,
    };
  });
  expect(query.toSQL().sql).toStartWith(
    'SELECT DISTINCT "author"."name" AS "name", COUNT(*) AS "postCount"',
  );
  expect(query.toSQL().sql).toContain(
    'GROUP BY "author"."name"\nHAVING COUNT(*) > $1\nORDER BY "author"."name" ASC NULLS LAST',
  );
  expect(query.toSQL().parameters).toEqual([1]);
});

test("empty membership lists are constants and values remain parameterized", () => {
  const compiled = model
    .users((users) => ({
      name: users.name,
      $where: [
        users.id.in([]),
        users.id.notIn([]),
        not(users.visits.between(1, 10)),
        users.name.like("A%"),
        users.name.isDistinctFrom(null),
      ],
    }))
    .toSQL();
  expect(compiled.sql).toContain(
    'WHERE FALSE AND TRUE AND NOT ("users"."visits" BETWEEN $1 AND $2)',
  );
  expect(compiled.parameters).toEqual([1, 10, "A%", null]);
});

test("raw SQL interpolation is parameterized and schema defaults remain serializable", () => {
  const local = schema({
    events: { id: int.auto, name: text.default(sql`'event'`) },
  });
  expect(local.$snapshot().tables[0]?.columns[1]?.default).toEqual({
    kind: "sql",
    sql: "'event'",
  });
  expect(() => text.default(sql`${"event"}`)).toThrow(
    /defaults cannot contain/,
  );
  expect(local.events.insert({}).toSQL().sql).toEndWith("DEFAULT VALUES");
  expect(local.events.insert([{}, {}]).toSQL().sql).toContain(
    '("id") VALUES (DEFAULT), (DEFAULT)',
  );
});

test("custom codecs propagate through modifiers, aliases, predicates and writes", async () => {
  const calls: CompiledQuery[] = [];
  const amount = customType<{ cents: bigint }>("bigint", {
    encode: (value) => value.cents.toString(),
    decode: (value) => ({ cents: BigInt(value as string | bigint) }),
  });
  const local = schema(
    { wallets: { id: int.auto, amount: amount.nullable } },
    {
      executor: async (query) => {
        calls.push(query);

        return [{ total: "9007199254740993" }];
      },
    },
  );
  const result = await local
    .wallets((wallets) => ({
      total: wallets.amount,
      $where: wallets.amount.is({ cents: 9007199254740993n }),
    }))
    .execute();
  expect(result).toEqual([{ total: { cents: 9007199254740993n } }]);
  expect(calls[0]?.parameters).toEqual(["9007199254740993"]);
  expect(
    local.wallets.insert({ amount: { cents: 5n } }).toSQL().parameters,
  ).toEqual(["5"]);
  expect(local.$snapshot()).toBeDefined();
});

test("execution returns affected rows, decodes results, and first preserves LIMIT zero", async () => {
  const queries: CompiledQuery[] = [];
  const local = schema(
    { events: { id: int.auto, value: bigint } },
    {
      executor: async (query) => {
        queries.push(query);

        return {
          rows: query.sql.includes("RETURNING")
            ? [{ value: "9007199254740993" }]
            : [],
          affectedRows: 2,
        };
      },
    },
  );
  expect(await local.events.delete().execute()).toEqual({ affectedRows: 2 });
  expect(
    await local.events
      .insert({ value: 5n })
      .returning((events) => [events.value])
      .execute(),
  ).toEqual({ value: 9007199254740993n });
  expect(
    await local.events((events) => ({ id: events.id, $limit: 0 })).first(),
  ).toBeNull();
  expect(queries.at(-1)?.parameters).toEqual([]);
  expect(queries.at(-1)?.sql).toContain("LIMIT 0");
});

test("findMany compiles nested relations into one query and decodes nested values", async () => {
  const queries: CompiledQuery[] = [];
  const local = schema(
    {
      authors: { id: int.auto, name: text },
      articles: ({ authors }) => ({
        id: int.auto,
        author: authors,
        visits: bigint,
        writtenAt: timestamptz,
      }),
    },
    {
      executor: async (query) => {
        queries.push(query);

        return [
          {
            id: 1,
            name: "Ada",
            articles: [
              {
                id: 2,
                authorId: 1,
                visits: "9007199254740993",
                writtenAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        ];
      },
    },
  );
  const result = await local
    .authors((authors) => ({
      id: authors.id,
      name: authors.name,
      articles: authors.articles((articles) => ({
        id: articles.id,
        visits: articles.visits,
        authorId: articles.authorId,
        writtenAt: articles.writtenAt,
      })),
      $limit: 1,
    }))
    .execute();
  expect(queries).toHaveLength(1);
  expect(queries[0]?.sql).toContain("json_agg");
  expect(result[0]?.articles[0]?.visits).toBe(9007199254740993n);
  expect(result[0]?.articles[0]?.writtenAt).toBeInstanceOf(Date);
});

test("queries and mutations are thenable and resolve like execute()", async () => {
  const queries: CompiledQuery[] = [];
  const local = schema(
    { events: { id: int.auto, value: bigint } },
    {
      executor: async (query) => {
        queries.push(query);

        return {
          rows: query.sql.startsWith("DELETE") ? [] : [{ id: 1, value: "5" }],
          affectedRows: 1,
        };
      },
    },
  );
  expect(await local.events((events) => ({ id: events.id }))).toEqual([
    { id: 1 },
  ]);
  expect(await local.events((events) => ({ value: events.value }))).toEqual([
    { value: 5n },
  ]);
  expect(await local.events.insert({ value: 5n })).toEqual({ affectedRows: 1 });
  expect(
    await local.events
      .insert({ value: 5n })
      .returning((events) => [events.value]),
  ).toEqual({ value: 5n });
  expect(
    await local.events
      .insert([{ value: 5 }, { value: 6n }])
      .returning((events) => [events.value]),
  ).toEqual([{ value: 5n }]);
  expect(await local.events.delete()).toEqual({ affectedRows: 1 });
  const [rows, single] = await Promise.all([
    local.events((events) => ({ id: events.id })),
    local.events((events) => ({ id: events.id })).maybeOne(),
  ]);
  expect(rows).toEqual([{ id: 1 }]);
  expect(single).toEqual({ id: 1 });
  expect(queries).toHaveLength(8);
  const query = local.events((events) => ({ id: events.id }));
  expect(typeof query.then).toBe("function");
  expect(query.toSQL().sql).toContain("SELECT");
  await expect(
    (async () =>
      local.events((events) => ({
        id: events.id,
        $where: "broken" as never,
      })))(),
  ).rejects.toThrow(/SQL predicate/);
});

test("bigint columns accept safe integers and DO NOTHING resolves a single insert to null", async () => {
  expect(
    model
      .posts((posts) => ({ id: posts.id, $where: posts.views.above(10) }))
      .toSQL().parameters,
  ).toEqual(["10"]);
  expect(
    model.posts.insert({ title: "n", authorId: 1, views: 7 }).toSQL()
      .parameters,
  ).toContain("7");
  expect(() =>
    model.posts.insert({ title: "n", authorId: 1, views: 1.5 }),
  ).toThrow(/safe integers/);
  const local = schema(
    { events: { id: int.auto, value: bigint } },
    { executor: async () => [] },
  );
  expect(
    await local.events
      .insert({ value: 1 })
      .onConflict("id")
      .doNothing()
      .returning((events) => [events.id]),
  ).toBeNull();
  expect(
    await local.events
      .insert([{ value: 1 }])
      .onConflict("id")
      .doNothing()
      .returning((events) => [events.id]),
  ).toEqual([]);
});

test("first() and maybeOne() resolve to null when no row matches", async () => {
  const local = schema(
    { events: { id: int.auto, value: bigint } },
    { executor: async () => [] },
  );
  expect(
    await local.events((events) => ({ id: events.id })).first(),
  ).toBeNull();
  expect(
    await local.events((events) => ({ id: events.id })).maybeOne(),
  ).toBeNull();
  expect(await local.events.byId(7).maybeOne()).toBeNull();
  await expect(
    local.events((events) => ({ id: events.id })).one(),
  ).rejects.toThrow(/exactly one/);
});

test("is() and isNot() cover equality, NULL checks and enum members", () => {
  const compiled = model
    .posts((posts) => ({
      id: posts.id,
      $where: and(
        posts.title.is("Typed"),
        posts.editorId.is(null),
        posts.metadata.isNot(null),
        posts.views.isNot(1n),
      ),
    }))
    .toSQL();
  expect(compiled.sql).toContain(
    'WHERE ("posts"."title" = $1 AND "posts"."editor_id" IS NULL AND "posts"."metadata" IS NOT NULL AND "posts"."views" <> $2)',
  );
  expect(compiled.parameters).toEqual(["Typed", "1"]);
  const states = schema({
    records: { id: int.auto, state: oneOf("draft", "published") },
  });
  const byCall = states
    .records((records) => ({
      id: records.id,
      $where: records.state.is("published"),
    }))
    .toSQL();
  const byMember = states
    .records((records) => ({
      id: records.id,
      $where: records.state.is.published,
    }))
    .toSQL();
  expect(byCall).toEqual(byMember);
  expect(byCall.parameters).toEqual(["published"]);
  expect(
    states
      .records((records) => ({
        id: records.id,
        $where: records.state.isNot.draft,
      }))
      .toSQL().sql,
  ).toContain('"records"."state" <> $1');
  expect(() =>
    model.posts((posts) => ({ $where: posts.views.above(null as never) })),
  ).toThrow(/is\(null\) or isNot\(null\)/);
  expect(() =>
    model.posts((posts) => ({ $where: posts.title.is(undefined as never) })),
  ).toThrow(/is\(null\)/);
});

test("$scope filters reads, writes, paths, joins and collections of scoped tables", () => {
  const tenant = model.$scope({ posts: (posts) => posts.authorId.is(7) });
  expect(tenant.posts((posts) => ({ id: posts.id })).toSQL()).toEqual({
    sql: 'SELECT "posts"."id" AS "id"\nFROM "posts" AS "posts"\nWHERE "posts"."author_id" = $1',
    parameters: [7],
  });
  expect(tenant.posts.byId(3).toSQL().sql).toContain(
    'WHERE "posts"."author_id" = $1 AND "posts"."id" = $2',
  );
  expect(tenant.posts.delete().toSQL()).toEqual({
    sql: 'DELETE FROM "posts" AS "posts"\nWHERE "posts"."author_id" = $1',
    parameters: [7],
  });
  expect(
    tenant.posts
      .update({ title: "x" })
      .where((posts) => posts.id.is(1))
      .toSQL().parameters,
  ).toEqual(["x", 7, 1]);
  expect(
    tenant.posts.insert({ title: "x", authorId: 1 }).toSQL().sql,
  ).not.toContain("WHERE");
  expect(
    tenant.users((users) => ({ total: users.posts.count() })).toSQL().sql,
  ).toContain('"author_id" = $1');
  expect(
    tenant
      .users((users, { join }) => {
        const posts = join(users.posts);

        return { id: users.id, title: posts.title };
      })
      .toSQL().sql,
  ).toContain(
    'ON ("users"."id" = "posts"."author_id" AND "posts"."author_id" = $1)',
  );
  const owners = model.$scope({ users: (users) => users.active.is(true) });
  expect(
    owners.posts((posts) => ({ name: posts.author.name })).toSQL().sql,
  ).toContain('"__symmetria_path_0"."active" = $1');
  const both = tenant.$scope({ posts: (posts) => posts.views.above(1) });
  expect(both.posts((posts) => ({ id: posts.id })).toSQL().sql).toContain(
    'WHERE ("posts"."author_id" = $1 AND "posts"."views" > $2)',
  );
  expect(() => model.$scope({ comments: () => undefined } as never)).toThrow(
    /unknown table/,
  );
  expect(model.posts((posts) => ({ id: posts.id })).toSQL().sql).not.toContain(
    "WHERE",
  );
});

test("UPDATE and DELETE accept relation paths and quantifiers through primary-key subqueries", () => {
  const removal = model.posts
    .delete()
    .where((posts) => posts.author.name.is("Ada"))
    .toSQL();
  expect(removal.sql).toBe(
    [
      'DELETE FROM "posts" AS "posts"',
      'WHERE "posts"."id" IN (SELECT "posts"."id" AS "id"',
      'FROM "posts" AS "posts"',
      'INNER JOIN "users" AS "__symmetria_path_0" ON "posts"."author_id" = "__symmetria_path_0"."id"',
      'WHERE "__symmetria_path_0"."name" = $1)',
    ].join("\n"),
  );
  expect(removal.parameters).toEqual(["Ada"]);
  const update = model.users
    .update({ active: false })
    .where((users) => users.posts.some((posts) => posts.views.above(10)))
    .toSQL();
  expect(update.sql).toContain('WHERE EXISTS (SELECT 1 AS "present"');
  expect(update.sql).not.toContain(" IN (");
  expect(update.parameters).toEqual([false, "10"]);
  expect(
    model.posts
      .delete()
      .where((posts) => posts.id.is(1))
      .toSQL().sql,
  ).toBe('DELETE FROM "posts" AS "posts"\nWHERE "posts"."id" = $1');
});

test("pages() iterates keyset pages until the cursor runs out", async () => {
  let calls = 0;
  const local = schema(
    { events: { id: int.auto, value: bigint } },
    {
      executor: async () => {
        calls += 1;

        return calls === 1
          ? [
              { id: 1, __symmetria_cursor_0: "1" },
              { id: 2, __symmetria_cursor_0: "2" },
              { id: 3, __symmetria_cursor_0: "3" },
            ]
          : [{ id: 3, __symmetria_cursor_0: "3" }];
      },
    },
  );
  const pages: number[][] = [];

  for await (const page of local
    .events((events) => ({ id: events.id, $orderBy: events.id.ascending }))
    .pages({ size: 2 })) {
    pages.push(page.items.map((row) => row.id));
  }

  expect(pages).toEqual([[1, 2], [3]]);
  expect(calls).toBe(2);
});

test("jsonb(schema) validates writes and reads through a Standard Schema", async () => {
  const settings = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { theme?: unknown }).theme === "string"
          ? {
              value: {
                theme: (value as { theme: string }).theme.toLowerCase(),
              },
            }
          : {
              issues: [{ message: "theme must be a string", path: ["theme"] }],
            },
    },
  };
  const local = schema(
    { users: { id: int.auto, settings: jsonb(settings) } },
    { executor: async () => [{ id: 1, settings: { theme: "DARK" } }] },
  );
  expect(
    local.users.insert({ settings: { theme: "Dark" } }).toSQL().parameters,
  ).toEqual(['{"theme":"dark"}']);
  expect(() =>
    local.users.insert({ settings: { theme: 42 } as never }),
  ).toThrow(/theme: theme must be a string/);
  expect(await local.users((users) => ({ settings: users.settings }))).toEqual([
    { settings: { theme: "dark" } },
  ]);
  const asynchronous = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: async () => ({ value: {} }),
    },
  };
  expect(() =>
    schema({
      users: { id: int.auto, settings: jsonb(asynchronous) },
    }).users.insert({
      settings: {},
    }),
  ).toThrow(/synchronously/);
  expect(() => jsonb({} as never)).toThrow(/Standard Schema/);
});

test("array columns encode PostgreSQL literals with casts and expose has/contains/overlaps/length", async () => {
  const local = schema(
    {
      items: {
        id: int.auto,
        title: text,
        tags: text.array,
        scores: bigint.array.nullable,
      },
    },
    {
      executor: async () => [
        { id: 1, tags: ["a", "b"], scores: ["9007199254740993", "2"] },
      ],
    },
  );
  const insert = local.items
    .insert({ title: "t", tags: ["a", "b"], scores: [1n, 2] })
    .toSQL();
  expect(insert.sql).toContain("$2::text::text[], $3::text::bigint[]");
  expect(insert.parameters).toEqual(["t", ["a", "b"], ["1", "2"]]);
  const filtered = local
    .items((items) => ({
      id: items.id,
      count: items.tags.length().as("count"),
      $where: and(
        items.tags.has("a"),
        items.tags.contains(["a"]),
        items.tags.overlaps(["x", "y"]),
        items.scores.has(5),
      ),
    }))
    .toSQL();
  expect(filtered.sql).toContain('cardinality("items"."tags") AS "count"');
  expect(filtered.sql).toContain(
    '$1 = ANY("items"."tags") AND "items"."tags" @> $2::text::text[] AND "items"."tags" && $3::text::text[] AND $4 = ANY("items"."scores")',
  );
  expect(filtered.parameters).toEqual(["a", ["a"], ["x", "y"], "5"]);
  expect(
    await local.items((items) => ({
      id: items.id,
      tags: items.tags,
      scores: items.scores,
    })),
  ).toEqual([{ id: 1, tags: ["a", "b"], scores: [9007199254740993n, 2n] }]);
  expect(() => oneOf("a", "b").array).toThrow(/scalar, non-enum/);
  expect(() => int.auto.array).toThrow(/identity/);
  expect(() => text.array.array).toThrow(/scalar, non-enum/);
  expect(() => local.items.insert({ title: "t", tags: "a" as never })).toThrow(
    /accept arrays/,
  );
});

test("search() and searchRank() compile to PostgreSQL full-text search", () => {
  const query = model
    .posts((posts) => ({
      id: posts.id,
      searchRank: posts.title.searchRank("bun sql", { language: "english" }),
      $where: posts.title.search("bun sql"),
      $orderBy: posts.title.searchRank("bun sql").descending,
    }))
    .toSQL();
  expect(query.sql).toContain(
    `ts_rank(to_tsvector('english', "posts"."title"), websearch_to_tsquery('english', $1)) AS "searchRank"`,
  );
  expect(query.sql).toContain(
    `WHERE to_tsvector('simple', "posts"."title") @@ websearch_to_tsquery('simple', $2)`,
  );
  expect(query.parameters).toEqual(["bun sql", "bun sql", "bun sql"]);
  expect(() =>
    model.posts((posts) => ({
      $where: posts.title.search("x", { language: "en;drop" }),
    })),
  ).toThrow(/text search configuration/);
});

test("mutable input values and compiled parameters cannot mutate a query", () => {
  const metadata = { tags: ["original"] };
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const query = model.posts.insert({
    title: "Immutable",
    authorId: 1,
    metadata,
    createdAt,
  });
  metadata.tags.push("changed");
  createdAt.setUTCFullYear(2000);
  const first = query.toSQL();
  const compiledDate = first.parameters.find(
    (parameter) => parameter instanceof Date,
  ) as Date;
  compiledDate.setUTCFullYear(2001);
  expect(query.toSQL().parameters).toContain('{"tags":["original"]}');
  expect(query.toSQL().parameters).toContainEqual(
    new Date("2026-01-01T00:00:00Z"),
  );
});

const inferred = model.posts((posts, { leftJoin }) => {
  const editor = leftJoin(posts.editor);

  return {
    title: posts.title,
    editorName: coalesce(editor.name, "Nobody").as("editorName"),
    count: count(),
  };
});
type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;
type ResultMatches = Expect<
  AreEqual<
    Awaited<ReturnType<typeof inferred.execute>>,
    { title: string; editorName: string; count: number }[]
  >
>;
const returned = model.users
  .insert({ name: "Ada" })
  .returning((users) => [users.id, users.balance]);
type ReturningMatches = Expect<
  AreEqual<
    Awaited<ReturnType<typeof returned.execute>>,
    { id: number; balance: string }
  >
>;
