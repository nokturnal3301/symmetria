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
  notExists,
  not,
  or,
  defaultValue,
  table,
  index,
  uuid,
  date,
  prepare,
  timestamp,
  varchar,
  many,
  one,
  type CompiledQuery,
  type Decimal,
  type InferInsert,
} from "../../../packages/runtime/src";
import { expectDataError } from "../../support/data-errors";

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
    sql: 'INSERT INTO "posts" AS "posts"\n("title", "author_id", "views", "metadata") VALUES ($1, $2, $3, $4::text::jsonb), ($5, $6, DEFAULT, DEFAULT)\nRETURNING "posts"."id" AS "id", "posts"."title" AS "title"',
    parameters: [
      "first",
      3,
      "9007199254740993",
      '{"tags":["sql"]}',
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

test("raw SQL operands keep their own precedence", () => {
  const totals = schema({
    n: table({ id: int.auto, a: int, b: int })
      .computed((n) => ({ total: sql.of(int)`${n.a} + ${n.b}` }))
      .checks((n) => ({ capped: sql<number>`${n.a} + ${n.b}`.atMost(10) }))
      .indexes((n) => ({
        small: index(n.a).where(sql<number>`${n.a} - ${n.b}`.below(0)),
      })),
  });
  expect(
    totals
      .n(
        (n) => ({
          doubled: n.total.multiply(2),
          nested: sql<number>`${n.total} * 2`,
        }),
        {
          where: (n) => [
            n.total.is(3),
            n.total.between(1, 5),
            n.total.in([3, 4]),
            n.total.isNot(null),
          ],
        },
      )
      .toSQL(),
  ).toEqual({
    sql: 'SELECT (("n"."a" + "n"."b") * $1) AS "doubled", ("n"."a" + "n"."b") * 2 AS "nested"\nFROM "n" AS "n"\nWHERE ("n"."a" + "n"."b") = $2 AND ("n"."a" + "n"."b") BETWEEN $3 AND $4 AND ("n"."a" + "n"."b") IN ($5, $6) AND ("n"."a" + "n"."b") IS NOT NULL',
    parameters: [2, 3, 1, 5, 3, 4],
  });
  const [snapshot] = totals.$snapshot().tables;
  expect(snapshot?.checks?.[0]?.expression).toBe('("a" + "b") <= 10');
  expect(snapshot?.indexes?.[0]?.where).toBe('("a" - "b") < 0');
});

test("undefined write fields are omitted like undefined query options", async () => {
  expect(
    model.users.insert({ name: "Ada", visits: undefined }).toSQL(),
  ).toEqual(model.users.insert({ name: "Ada" }).toSQL());
  expect(
    model.posts
      .insert([
        { title: "a", authorId: 1, views: undefined },
        { title: "b", authorId: 1, views: 2n },
      ])
      .toSQL(),
  ).toEqual({
    sql: 'INSERT INTO "posts" AS "posts"\n("title", "author_id", "views") VALUES ($1, $2, DEFAULT), ($3, $4, $5)',
    parameters: ["a", 1, "b", 1, "2"],
  });
  expect(
    model.users
      .update({ name: "Grace", visits: undefined })
      .where((users) => users.id.is(1))
      .toSQL(),
  ).toEqual({
    sql: 'UPDATE "users" AS "users" SET "name" = $1\nWHERE "users"."id" = $2',
    parameters: ["Grace", 1],
  });
  expect(
    model.users
      .insert({ name: "Ada" })
      .onConflict("name")
      .doUpdate({ visits: 1, active: undefined })
      .toSQL().sql,
  ).toEndWith('DO UPDATE SET "visits" = $2');
  // Missing values are data errors: they fail the write when it runs.
  await expectDataError(
    // @ts-expect-error title is required even when spelled as undefined
    () => model.posts.insert({ title: undefined, authorId: 1 }),
    /missing required column "posts.title"/,
  );
  await expectDataError(
    () => model.users.update({ visits: undefined }).all(),
    /at least one/,
  );
  // @ts-expect-error unknown keys fail even when undefined
  expect(() => model.users.insert({ name: "Ada", nmae: undefined })).toThrow(
    /unknown column/,
  );
});

test("write validation catches missing values, unknown columns and generated identities", async () => {
  await expectDataError(
    // @ts-expect-error title is required
    () => model.posts.insert({ authorId: 1 }),
    /missing required/,
  );
  await expectDataError(
    // @ts-expect-error generated identity cannot be assigned
    () => model.users.insert({ id: 1, name: "Ada" }),
    /generated always/,
  );
  // A column named like an Object.prototype member is missing all the same.
  const named = schema({ things: { id: int.auto, constructor: int } });
  await expectDataError(
    // @ts-expect-error constructor is required
    () => named.things.insert({}),
    /missing required column "things.constructor"/,
  );
  // Unknown columns are about the query's shape and throw where it is built,
  // even after a data error.
  // @ts-expect-error unknown column
  expect(() => model.users.update({ missing: 1 })).toThrow(/unknown column/);
  expect(() =>
    // @ts-expect-error unknown column
    model.users.insert({ name: null as never, missing: 1 }),
  ).toThrow(/unknown column/);
  await expectDataError(() => model.users.update({}).all(), /at least one/);
  expect(() => model.users.insert([]).toSQL()).toThrow(/no-op/);
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
    .posts(
      (posts) => ({
        authorId: posts.authorId,
      }),
      { where: (posts) => posts.views.above(9n) },
    )
    .as("recent");
  const query = model.users(
    (users, { innerJoin }) => {
      const _recentRow = innerJoin(recent, (recentRow) =>
        users.id.is(recentRow.authorId),
      );

      return {
        greeting: sql<string>`concat(${"Hello "}::text, ${users.name})`.as(
          "greeting",
        ),
      };
    },
    { where: (users, { innerJoin }) => users.name.isNot("Guest") },
  );
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
  const query = model.users(
    (users) => ({
      name: users.name,
    }),
    {
      where: (users) => [
        exists(
          model.posts(
            (posts) => ({
              id: posts.id,
            }),
            {
              where: (posts) => [
                posts.authorId.is(users.id),
                posts.title.ilike("%sql%"),
              ],
            },
          ),
        ),
        users.id.in(model.posts((posts) => ({ authorId: posts.authorId }))),
        users.visits.above(
          model.users
            .as("others")((others) => ({ maximum: maximum(others.visits) }))
            .scalar(),
        ),
      ],
    },
  );
  expect(query.toSQL().parameters).toEqual(["%sql%"]);
  expect(query.toSQL().sql).toContain('"posts"."author_id" = "users"."id"');
  expect(query.toSQL().sql).toContain(
    '"users"."visits" > (SELECT MAX("others"."visits")',
  );
});

test("aggregates, GROUP BY, HAVING, DISTINCT and null ordering compile together", () => {
  const query = model.posts(
    (posts, { innerJoin }) => {
      const author = innerJoin(posts.author);

      return {
        name: author.name,
        postCount: count().as("postCount"),
        sum: sum(posts.views),
        average: average(posts.views),
        minimum: minimum(posts.createdAt),
        maximum: maximum(posts.id),
      };
    },
    {
      groupBy: (posts) => [posts.author.name],
      having: (posts, { innerJoin }) => count().above(1),
      orderBy: (posts) => posts.author.name.ascending.nullsLast,
      distinct: true,
    },
  );
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
    .users(
      (users) => ({
        name: users.name,
      }),
      {
        where: (users) => [
          users.id.in([]),
          users.id.notIn([]),
          not(users.visits.between(1, 10)),
          users.name.like("A%"),
          users.name.isDistinctFrom(null),
        ],
      },
    )
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

test("only a sql template is a raw SQL default; an object shaped like one is a JSON value", () => {
  const lookalike = { kind: "sql", sql: "now()" } as const;
  const local = schema({
    events: {
      id: int.auto,
      payload: jsonb<{ kind: "sql"; sql: string }>().default(lookalike),
      createdAt: timestamptz.default(sql`now()`),
    },
  });
  const columns = local.$snapshot().tables[0]!.columns;

  expect(columns[1]?.default).toEqual({ kind: "value", value: lookalike });
  expect(columns[2]?.default).toEqual({ kind: "sql", sql: "now()" });
});

test("a raw fragment's comment, string or quoted name cannot reach the SQL written after it", () => {
  const local = schema({
    posts: {
      id: int.auto,
      title: text,
      views: int,
      deletedAt: timestamptz.nullable,
    },
  });
  const live = local.$scope({ posts: (post) => post.deletedAt.is(null) });

  // A `--` comment ends with a line break, before ` AS`, ` DESC`, the next
  // assignment or the $scope() check of RETURNING.
  expect(
    local
      .posts((post) => ({ score: sql<number>`${post.views} * 2 -- double` }), {
        orderBy: (post) => sql<number>`${post.views} -- by views`.descending,
      })
      .toSQL().sql,
  ).toBe(
    'SELECT "posts"."views" * 2 -- double\n AS "score"\nFROM "posts" AS "posts"\nORDER BY "posts"."views" -- by views\n DESC',
  );
  expect(
    local.posts
      .update(
        (post) => ({
          views: sql<number>`${post.views} + 1 -- one more`,
          deletedAt: sql<Date>`now()`,
        }),
        { where: (post) => post.id.is(1) },
      )
      .toSQL().sql,
  ).toStartWith(
    'UPDATE "posts" AS "posts" SET "views" = "posts"."views" + 1 -- one more\n, "deleted_at" = now()',
  );
  expect(
    live.posts
      .insert({ title: "x", views: 0 })
      .returning((post) => ({ note: sql<string>`${post.title} -- shown` }))
      .toSQL().sql,
  ).toContain('"posts"."title" -- shown\n AS "note", CASE WHEN');

  // Without a comment marker the SQL is the template's text, as before.
  const plain = (fragment: ReturnType<typeof sql<string>>) =>
    local.posts(() => ({ value: fragment })).toSQL().sql;

  expect(plain(sql<string>`upper(${"a"}) || ' -- quoted' || "x"`)).toBe(
    `SELECT upper($1) || ' -- quoted' || "x" AS "value"\nFROM "posts" AS "posts"`,
  );
  for (const text of [
    sql<string>`'a' /* closed /* nested */ */`,
    sql<string>`E'it\\'s -- not a comment'`,
    sql<string>`replace('C:\\temp', '\\', '/')`,
    sql<string>`$tag$ -- $tag$ || $$'$$`,
  ]) {
    expect(plain(text)).not.toContain("\n AS");
  }

  // Left open, they would take in the SQL after them: refused where written.
  expect(() => sql`now() /* open`).toThrow(/leaves a \/\* comment open/);
  expect(() => sql`'open`).toThrow(/leaves a '…' string open/);
  expect(() => sql`"open`).toThrow(/leaves a "…" quoted name open/);
  expect(() => sql`$body$ open`).toThrow(/dollar-quoted string open/);
  expect(() => sql`E'it\\'`).toThrow(/string open/);

  // A value inside a comment or quoted text: PostgreSQL reads no parameter
  // there, and its SQL must not end the comment early.
  expect(() => plain(sql<string>`'%${"term"}%'`)).toThrow(
    /inside a comment or quoted text, where PostgreSQL reads no parameter/,
  );
  expect(() =>
    local
      .posts((post) => ({ value: sql<string>`${post.title} -- ${post.views}` }))
      .toSQL(),
  ).not.toThrow();
  expect(() =>
    local
      .posts((post) => ({
        value: sql<string>`${post.title} /* ${sql`'*/'`} */`,
      }))
      .toSQL(),
  ).toThrow(/leaves a '…' string open/);

  // Schema expressions and defaults get the same line break.
  const ddl = schema({
    events: table({
      id: int.auto,
      n: int.default(sql`1 -- one`),
    }).checks((event) => ({ positive: sql`${event.n} > 0 -- positive` })),
  });
  const [events] = ddl.$snapshot().tables;

  expect(events?.columns[1]?.default).toEqual({
    kind: "sql",
    sql: "1 -- one\n",
  });
  expect(events?.checks?.[0]?.expression).toBe('"n" > 0 -- positive\n');
});

test("a template escape without a value is refused with the escape it names", () => {
  for (const build of [
    () => sql<boolean>`${"x"} LIKE 'C:\users%'`,
    () => text.default(sql`'C:\users'`),
    () => sql`'\xZ'`,
    () => sql`'\1'`,
  ]) {
    expect(build).toThrow(
      /has the escape \\[ux1], which JavaScript reads as no text at all; write \\\\ for a backslash/,
    );
  }

  expect(text.default(sql`'C:\\users'`).definition.default as unknown).toEqual({
    kind: "sql",
    sql: "'C:\\users'",
  });
});

test("a condition or ordering in sql`` is its SQL; a query, a Map or an array of columns is refused", () => {
  const local = schema({
    items: { id: int.auto, name: text },
  });

  expect(
    local
      .items(
        (item) => ({
          matches: sql<string>`(${item.name.is("a")})::text`,
          rank: sql<number>`row_number() OVER (ORDER BY ${item.name.descending.nullsLast}, ${item.id.ascending})`,
        }),
        {
          where: (item) => sql<boolean>`${item.name.is("b")} OR ${item.id} > 1`,
        },
      )
      .toSQL(),
  ).toEqual({
    sql: 'SELECT (("items"."name" = $1))::text AS "matches", row_number() OVER (ORDER BY "items"."name" DESC NULLS LAST, "items"."id" ASC) AS "rank"\nFROM "items" AS "items"\nWHERE (("items"."name" = $2) OR "items"."id" > 1) = (TRUE)',
    parameters: ["a", "b"],
  });

  const refused = (value: unknown, message: RegExp) =>
    expect(() =>
      local.items(() => ({ value: sql<string>`${value}` })).toSQL(),
    ).toThrow(message);

  local.items((item) => {
    refused(
      [item.id, item.name],
      /cannot interpolate an array that holds a column/,
    );
    return { id: item.id };
  });
  refused(
    local.items((item) => ({ id: item.id })),
    /cannot interpolate a query; interpolate query.scalar\(\)/,
  );
  refused(
    new Map(),
    /cannot interpolate a Map that is no value a driver binds/,
  );
  refused(() => 1, /cannot interpolate a function/);

  // Values still bind as before.
  expect(
    local
      .items(() => ({
        value: sql<string>`${{ a: 1 }}::text::jsonb || ${[1, 2]} || ${new Date(0)} || ${Buffer.from("a")}`,
      }))
      .toSQL().parameters,
  ).toEqual([{ a: 1 }, [1, 2], new Date(0), Buffer.from("a")]);

  // A schema expression writes the condition into its DDL.
  expect(
    schema({
      checked: table({ id: int.auto, n: int.nullable }).checks((row) => ({
        positive: sql<boolean>`${row.n.above(0)} OR ${row.n.is(null)}`,
      })),
    }).$snapshot().tables[0]?.checks?.[0]?.expression,
  ).toBe('("n" > 0) OR ("n" IS NULL)');

  // Elsewhere a condition, an ordering or a query is no bound value either.
  expect(() =>
    local.items({ where: (item) => item.name.is(item.id.is(1) as never) }),
  ).toThrow(/a condition is not a value/);
  expect(() =>
    local.items({
      where: (item) =>
        item.name.is(local.items((other) => ({ n: other.name })) as never),
    }),
  ).toThrow(/a query is not a value/);
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
    .wallets(
      (wallets) => ({
        total: wallets.amount,
      }),
      { where: (wallets) => wallets.amount.is({ cents: 9007199254740993n }) },
    )
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
  expect(await local.events.delete().all().execute()).toEqual({
    affectedRows: 2,
  });
  expect(
    await local.events
      .insert({ value: 5n })
      .returning((events) => [events.value])
      .execute(),
  ).toEqual({ value: 9007199254740993n });
  expect(
    await local.events((events) => ({ id: events.id }), { limit: 0 }).first(),
  ).toBeNull();
  expect(queries.at(-1)?.parameters).toEqual([]);
  expect(queries.at(-1)?.sql).toContain("LIMIT 0");
  // insert([]) executes nothing and resolves like a zero-row write.
  const executed = queries.length;
  expect(await local.events.insert([]).execute()).toEqual({ affectedRows: 0 });
  expect(
    await local.events
      .insert([])
      .returning((events) => [events.id])
      .execute(),
  ).toEqual([]);
  expect(queries.length).toBe(executed);
});

test("a write's count comes from the executor's result, and a write without returning() needs one", async () => {
  const run = (result: unknown) =>
    schema(
      { events: { id: int.auto, value: bigint } },
      { executor: async () => result as never },
    );

  // Bun.SQL and postgres.js count on the array, node-postgres as rowCount.
  expect(
    await run(Object.assign([], { count: 3 }))
      .events.delete()
      .all(),
  ).toEqual({ affectedRows: 3 });
  expect(
    await run({ rows: [], rowCount: 4, command: "UPDATE" })
      .events.update({ value: 1n })
      .all(),
  ).toEqual({ affectedRows: 4 });
  // Rows a write returns count themselves, and so do the rows of a read.
  expect(
    await run([{ id: 1 }, { id: 2 }])
      .events.delete()
      .all()
      .returning((event) => [event.id]),
  ).toEqual([{ id: 1 }, { id: 2 }]);
  expect(await run([{ id: 1 }]).events((event) => ({ id: event.id }))).toEqual([
    { id: 1 },
  ]);
  // A write without RETURNING returns no rows: an array alone cannot tell
  // how many it changed, so the write is refused rather than reporting 0.
  for (const result of [[], { rows: [] }, { rows: [], rowCount: null }]) {
    await expect(
      Promise.resolve(run(result).events.insert({ value: 1n })),
    ).rejects.toThrow(
      "symmetria: the executor's result does not say how many rows the write changed (the statement ran); return { rows, affectedRows }",
    );
  }
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
    .authors(
      (authors) => ({
        id: authors.id,
        name: authors.name,
        articles: authors.articles((articles) => ({
          id: articles.id,
          visits: articles.visits,
          authorId: articles.authorId,
          writtenAt: articles.writtenAt,
        })),
      }),
      { limit: 1 },
    )
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
  expect(await local.events.delete().all()).toEqual({ affectedRows: 1 });
  expect(() => local.events.delete().toSQL()).toThrow(/call \.all\(\)/);
  expect(() => local.events.update({ value: 1 }).toSQL()).toThrow(
    /update\(\) on "events" has no where\(\)/,
  );
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
      local.events(
        (events) => ({
          id: events.id,
        }),
        { where: (events) => "broken" as never },
      ))(),
  ).rejects.toThrow(/SQL predicate/);
});

test("bigint columns accept safe integers and DO NOTHING resolves a single insert to null", async () => {
  expect(
    model
      .posts((posts) => ({ id: posts.id }), {
        where: (posts) => posts.views.above(10),
      })
      .toSQL().parameters,
  ).toEqual(["10"]);
  expect(
    model.posts.insert({ title: "n", authorId: 1, views: 7 }).toSQL()
      .parameters,
  ).toContain("7");
  await expectDataError(
    () => model.posts.insert({ title: "n", authorId: 1, views: 1.5 }),
    /safe integers/,
  );
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
    .posts(
      (posts) => ({
        id: posts.id,
      }),
      {
        where: (posts) =>
          and(
            posts.title.is("Typed"),
            posts.editorId.is(null),
            posts.metadata.isNot(null),
            posts.views.isNot(1n),
          ),
      },
    )
    .toSQL();
  expect(compiled.sql).toContain(
    `WHERE ("posts"."title" = $1 AND "posts"."editor_id" IS NULL AND (NULLIF("posts"."metadata", 'null'::jsonb)) IS NOT NULL AND "posts"."views" <> $2)`,
  );
  expect(compiled.parameters).toEqual(["Typed", "1"]);
  const states = schema({
    records: { id: int.auto, state: oneOf("draft", "published") },
  });
  const byCall = states
    .records(
      (records) => ({
        id: records.id,
      }),
      { where: (records) => records.state.is("published") },
    )
    .toSQL();
  const byMember = states
    .records(
      (records) => ({
        id: records.id,
      }),
      { where: (records) => records.state.is.published },
    )
    .toSQL();
  expect(byCall).toEqual(byMember);
  expect(byCall.parameters).toEqual(["published"]);
  expect(
    states
      .records(
        (records) => ({
          id: records.id,
        }),
        { where: (records) => records.state.isNot.draft },
      )
      .toSQL().sql,
  ).toContain('"records"."state" <> $1');
  expect(() =>
    model.posts({ where: (posts) => posts.views.above(null as never) }),
  ).toThrow(/is\(null\) or isNot\(null\)/);
  expect(() =>
    model.posts({ where: (posts) => posts.title.is(undefined as never) }),
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
  // The scope bounds a write; every row inside it still takes all().
  expect(() => tenant.posts.delete().toSQL()).toThrow(
    'delete() on "posts" has no where(); call .all() to delete every row',
  );
  expect(tenant.posts.delete().all().toSQL()).toEqual({
    sql: 'DELETE FROM "posts" AS "posts"\nWHERE "posts"."author_id" = $1',
    parameters: [7],
  });
  // Every row a scoped write leaves behind is checked in the statement: a row
  // outside the scope fails the cast, which aborts the statement.
  // The failing text names the check and the table for the error.
  const check = (
    failure: "insert" | "update" | "conflict",
    parameter: number,
  ) =>
    `CASE WHEN "posts"."author_id" = $${parameter} THEN TRUE ELSE ('SYMMETRIA_OUT_OF_SCOPE:${failure}:posts:' || "posts".tableoid)::boolean END`;
  expect(
    tenant.posts
      .update({ title: "x" })
      .where((posts) => posts.id.is(1))
      .toSQL(),
  ).toEqual({
    sql: `UPDATE "posts" AS "posts" SET "title" = $1\nWHERE "posts"."author_id" = $2 AND "posts"."id" = $3\nRETURNING ${check("update", 4)} AS "__symmetria_scope"`,
    parameters: ["x", 7, 1, 7],
  });
  // A lookup's key restricts the update; only the scope is checked.
  expect(tenant.posts.byId(1).update({ title: "x" }).toSQL()).toEqual({
    sql: `UPDATE "posts" AS "posts" SET "title" = $1\nWHERE "posts"."author_id" = $2 AND "posts"."id" = $3\nRETURNING ${check("update", 4)} AS "__symmetria_scope"`,
    parameters: ["x", 7, 1, 7],
  });
  expect(
    tenant.posts
      .insert([
        { title: "x", authorId: 7 },
        { title: "y", authorId: 7 },
      ])
      .returning((posts) => ({ id: posts.id }))
      .toSQL(),
  ).toEqual({
    sql: `INSERT INTO "posts" AS "posts"\n("title", "author_id") VALUES ($1, $2), ($3, $4)\nRETURNING "posts"."id" AS "id", ${check("insert", 5)} AS "__symmetria_scope"`,
    parameters: ["x", 7, "y", 7, 7],
  });
  // An upsert never rewrites a conflicting row outside the scope, and the
  // inserted or updated row must stay inside it.
  expect(
    tenant.posts
      .insert({ title: "x", authorId: 1 })
      .onConflict("id")
      .doUpdate("title")
      .toSQL(),
  ).toEqual({
    sql: `INSERT INTO "posts" AS "posts"\n("title", "author_id") VALUES ($1, $2)\nON CONFLICT ("id") DO UPDATE SET "title" = "excluded"."title"\nWHERE ${check("conflict", 3)}\nRETURNING ${check("insert", 4)} AS "__symmetria_scope"`,
    parameters: ["x", 1, 7, 7],
  });
  // A false condition skips a conflicting row inside the scope; a row outside
  // it fails the statement before the condition is evaluated.
  expect(
    tenant.posts
      .insert({ title: "x", authorId: 7 })
      .onConflict("id")
      .doUpdate(
        { title: "y" },
        { where: (current, incoming) => incoming.views.above(current.views) },
      )
      .toSQL().sql,
  ).toContain(
    `WHERE CASE WHEN "posts"."author_id" = $4 THEN "excluded"."views" > "posts"."views" ELSE ('SYMMETRIA_OUT_OF_SCOPE:conflict:posts:' || "posts".tableoid)::boolean END\nRETURNING ${check("insert", 5)} AS "__symmetria_scope"`,
  );
  expect(
    tenant.posts
      .insert({ title: "x", authorId: 1 })
      .onConflict("id")
      .doNothing()
      .toSQL().sql,
  ).toBe(
    `INSERT INTO "posts" AS "posts"\n("title", "author_id") VALUES ($1, $2)\nON CONFLICT ("id") DO NOTHING\nRETURNING ${check("insert", 3)} AS "__symmetria_scope"`,
  );
  // Unscoped writes keep their SQL: no checks and no RETURNING.
  expect(model.posts.insert({ title: "x", authorId: 1 }).toSQL().sql).toBe(
    'INSERT INTO "posts" AS "posts"\n("title", "author_id") VALUES ($1, $2)',
  );
  expect(
    model.posts
      .insert({ title: "x", authorId: 7 })
      .onConflict("id")
      .doUpdate(
        { title: "y" },
        { where: (current, incoming) => incoming.views.above(current.views) },
      )
      .toSQL().sql,
  ).toEndWith(
    'DO UPDATE SET "title" = $3\nWHERE "excluded"."views" > "posts"."views"',
  );

  // Relation subqueries carry the scope once, inside their correlation.
  for (const query of [
    tenant.users((users) => ({ total: users.posts.count() })),
    tenant.users((users) => ({
      latest: users.posts.maximum((posts) => posts.views),
    })),
    tenant.users((users) => ({
      titles: users.posts((posts) => ({ title: posts.title })),
    })),
    tenant.users((users) => ({ id: users.id }), {
      where: (users) => users.posts.some(),
    }),
  ]) {
    const compiled = query.toSQL();
    expect(compiled.parameters).toEqual([7]);
    expect(compiled.sql).toContain(
      'WHERE ("users"."id" = "__symmetria_aggregate_0"."author_id" AND "__symmetria_aggregate_0"."author_id" = $1)',
    );
  }

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

test("a scoped table joined into another database's query keeps its scope", () => {
  const owners = model.$scope({ users: (users) => users.active.is(true) });
  const ada = model.$scope({ users: (users) => users.name.is("Ada") });
  const busy = owners.$scope({ users: (users) => users.visits.above(3) });
  const joined = (
    database: typeof model,
    source: typeof model.users | ReturnType<typeof model.users.as<"writer">>,
  ) =>
    database.posts((posts, { innerJoin }) => ({
      id: posts.id,
      name: innerJoin(source, (users) => users.id.is(posts.authorId)).name,
    }));
  const on = (alias: string, scope: string) =>
    `INNER JOIN "users" AS "${alias}" ON (("${alias}"."id" = "posts"."author_id") AND ${scope})`;

  expect(joined(model, owners.users).toSQL()).toEqual({
    sql: `SELECT "posts"."id" AS "id", "users"."name" AS "name"\nFROM "posts" AS "posts"\n${on("users", '"users"."active" = $1')}`,
    parameters: [true],
  });
  expect(joined(model, owners.users.as("writer")).toSQL().sql).toContain(
    on("writer", '"writer"."active" = $1'),
  );
  // Without a condition the scope filters the CROSS JOIN's rows.
  expect(
    model
      .posts((posts, { crossJoin }) => ({
        id: posts.id,
        name: crossJoin(owners.users).name,
      }))
      .toSQL().sql,
  ).toContain('CROSS JOIN "users" AS "users"\nWHERE "users"."active" = $1');
  // The same scope, or one the query's own scope contains, is applied once.
  expect(joined(owners, owners.users).toSQL().sql).toContain(
    on("users", '"users"."active" = $1'),
  );
  expect(joined(busy, owners.users).toSQL().sql).toContain(
    on("users", '("users"."active" = $1 AND "users"."visits" > $2)'),
  );
  // A narrower scope of the source, or another database's, is added.
  expect(joined(owners, busy.users).toSQL().sql).toContain(
    on("users", '("users"."active" = $1 AND "users"."visits" > $2)'),
  );
  expect(joined(owners, ada.users).toSQL().sql).toContain(
    on("users", '"users"."active" = $1 AND "users"."name" = $2'),
  );
  // A built query's filter or limit would be lost in a JOIN of its table.
  for (const source of [
    model.users({ where: (users) => users.active.is(true) }),
    model.users({ limit: 1 }),
    model.users((users) => ({ id: users.id })),
    model.users.byId(1),
  ]) {
    expect(() => joined(model, source as never)).toThrow(
      /a join source is a table .*would be lost in a JOIN of its table/,
    );
  }
});

test("$scope() reads each table's callback as a property of any object", () => {
  type Active = { active: { is: (value: boolean) => never } };
  const active = (users: Active) => users.active.is(true);

  class ActiveUsers {
    // Data a class keeps for its methods is no misspelt table.
    constructor(readonly flag: boolean) {}

    users(users: Active) {
      return users.active.is(this.flag);
    }
  }
  const where = (scopes: object) =>
    model
      .$scope(scopes as never)
      .users((users) => ({ id: users.id }))
      .toSQL();
  const expected = {
    sql: 'SELECT "users"."id" AS "id"\nFROM "users" AS "users"\nWHERE "users"."active" = $1',
    parameters: [true],
  };

  expect(where(new ActiveUsers(true))).toEqual(expected);
  expect(where(Object.create({ users: active }))).toEqual(expected);
  expect(where(Object.defineProperty({}, "users", { value: active }))).toEqual(
    expected,
  );
  // Arguments whose callbacks it cannot read are refused, never ignored.
  for (const [input, received] of [
    [new Map([["users", () => undefined]]), "a Map"],
    [[], "an array"],
    [() => undefined, "a function"],
    [undefined, "undefined"],
  ] as const) {
    expect(() => model.$scope(input as never)).toThrow(
      `$scope() expects an object of predicate callbacks by table name, such as { posts: (post) => post.tenantId.is(tenantId) }; received ${received}`,
    );
  }
  // A misspelt table is refused, also as a class's own function field.
  expect(() =>
    model.$scope(
      new (class {
        user = () => undefined;
      })() as never,
    ),
  ).toThrow('$scope() received unknown table "user"');
  // A table named like a member of every object has no scope of its own.
  const named = schema({ toString: { id: int, label: text } });
  const select = (database: typeof named) =>
    database.toString((row) => ({ id: row.id })).toSQL().sql;

  expect(select(named)).toBe(
    'SELECT "toString"."id" AS "id"\nFROM "to_string" AS "toString"',
  );
  expect(select(named.$scope({}))).toBe(select(named));
  expect(
    select(named.$scope({ toString: (row) => row.label.is("x") })),
  ).toEndWith('WHERE "toString"."label" = $1');
});

test("UPDATE and DELETE where() combines predicate arrays with AND, like the where option", () => {
  expect(
    model.posts
      .update({ title: "x" })
      .where((posts) => [posts.authorId.is(1), posts.views.above(0n)])
      .toSQL(),
  ).toEqual(
    model.posts
      .update({ title: "x" })
      .where((posts) => and(posts.authorId.is(1), posts.views.above(0n)))
      .toSQL(),
  );
  expect(
    model.posts
      .delete()
      .where((posts) => [posts.author.name.is("Ada"), posts.views.is(0n)])
      .toSQL().sql,
  ).toContain('"__symmetria_path_0"."name" = $1 AND "posts"."views" = $2');
  // A list that filtered down to nothing is a missing filter, not "every row".
  const nobody: number | undefined = undefined;

  for (const empty of [
    () => model.posts.delete().where(() => []),
    () =>
      model.posts
        .delete()
        .where((posts) => [nobody && posts.authorId.is(nobody)]),
    () => model.posts.delete().where(() => and()),
    () => model.posts.delete().where(() => not(or())),
    () => model.posts.delete({ where: [] }),
    () => model.posts.delete({ where: (posts) => posts.id.notIn([]) }),
    () => model.posts.update({ title: "x" }, { where: () => [and(), and()] }),
  ]) {
    // Refused when the statement is compiled, as a missing where() is.
    expect(() => empty().toSQL()).toThrow("leaves no condition");
  }

  // A filter no row passes is a filter: it writes nothing.
  expect(
    model.posts
      .delete()
      .where(() => or())
      .toSQL().sql,
  ).toBe('DELETE FROM "posts" AS "posts"\nWHERE FALSE');
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

test("a relation quantifier that holds for every row is no filter for UPDATE or DELETE", () => {
  const search = "" as string;
  const selected: number[] = [];

  for (const everyRow of [
    // Over a list whose entries were all skipped.
    () =>
      model.users.delete({
        where: (users) =>
          users.posts.every((posts) => [search && posts.title.is(search)]),
      }),
    () =>
      model.users.delete({
        where: (users) => users.posts.none((posts) => posts.id.in(selected)),
      }),
    () =>
      model.users.delete({
        where: (users) =>
          not(users.posts.some((posts) => posts.id.in(selected))),
      }),
    () =>
      model.users.delete({ where: (users) => users.posts.every(() => and()) }),
    () =>
      model.users.delete({ where: (users) => users.posts.none(() => or()) }),
    () =>
      model.users.delete({
        where: () =>
          notExists(
            model.posts((posts) => ({ id: posts.id }), {
              where: (posts) => posts.id.in(selected),
            }),
          ),
      }),
    () =>
      model.users.update(
        { active: false },
        {
          where: (users) => users.posts.none((posts) => posts.id.in(selected)),
        },
      ),
  ]) {
    expect(() => everyRow().toSQL()).toThrow("where() leaves no condition");
  }

  // Real conditions stay conditions: no post at all, posts that pass, and a
  // quantifier no row passes, which writes nothing.
  for (const filtered of [
    () => model.users.delete({ where: (users) => users.posts.none() }),
    () =>
      model.users.delete({
        where: (users) => users.posts.every((posts) => posts.title.is("x")),
      }),
    () =>
      model.users.delete({
        where: (users) => users.posts.some((posts) => posts.id.in(selected)),
      }),
  ]) {
    expect(() => filtered().toSQL()).not.toThrow();
  }
});

test("UPDATE and DELETE refuse membership in a query that finds nothing and aggregates of an emptied relation", () => {
  const selected: number[] = [];
  const chosen = () =>
    model.posts((posts) => ({ authorId: posts.authorId }), {
      where: (posts) => posts.id.in(selected),
    });

  for (const everyRow of [
    () => model.users.delete({ where: (users) => users.id.notIn(chosen()) }),
    () => model.users.delete({ where: (users) => not(users.id.in(chosen())) }),
    () =>
      model.users.delete({
        where: (users) =>
          users.id.notIn(
            model.posts((posts) => ({ authorId: posts.authorId }), {
              limit: 0,
            }),
          ),
      }),
    () =>
      model.users.update(
        { active: false },
        {
          where: (users) =>
            users
              .posts({ where: (posts) => posts.id.in(selected) })
              .count()
              .is(0),
        },
      ),
    () =>
      model.users.delete({
        where: (users) =>
          not(
            users
              .posts({ where: (posts) => posts.id.in(selected) })
              .count()
              .above(0),
          ),
      }),
    // Two where() calls that both hold for every row.
    () =>
      model.users
        .delete()
        .where(() => [])
        .where(() => and()),
    // One row whatever the data: an aggregate without grouping.
    () =>
      model.users.delete({
        where: (users) =>
          exists(
            model.posts(() => ({ total: count() }), {
              where: (posts) => posts.authorId.is(users.id),
            }),
          ),
      }),
    // A count is a whole number of at least 0, never NULL.
    () =>
      model.users.delete({
        where: (users) => users.posts.count().atLeast(0),
      }),
    () =>
      model.users.delete({ where: (users) => users.posts.count().isNot(-1) }),
    // A NOT NULL column of the written table is never NULL.
    () => model.users.delete({ where: (users) => users.name.isNot(null) }),
  ]) {
    expect(() => everyRow().toSQL()).toThrow("where() leaves no condition");
  }

  for (const filtered of [
    // No row passes: the write writes nothing.
    () =>
      model.users.delete({
        where: (users) =>
          users
            .posts({ where: (posts) => posts.id.in(selected) })
            .count()
            .above(0),
      }),
    // COUNT of no rows is still one row: NOT EXISTS of it holds for none.
    () =>
      model.users.delete({
        where: () =>
          notExists(
            model.posts(() => ({ total: count() }), {
              where: (posts) => posts.id.in(selected),
            }),
          ),
      }),
    () =>
      model.users.delete({
        where: (users) =>
          users.id.notIn(
            model.posts(() => ({ total: count() }), {
              where: (posts) => posts.id.in(selected),
            }),
          ),
      }),
    () => model.users.delete({ where: (users) => users.posts.count().is(0) }),
    // Another where() gives the filter its condition, in either order.
    () =>
      model.users
        .delete()
        .where((users) => users.id.is(1))
        .where((users) => users.posts.every(() => [])),
    () =>
      model.users
        .delete()
        .where(() => [])
        .where((users) => users.id.is(1)),
    // Data decides these.
    () =>
      model.users.delete({
        where: (users) => users.posts.count().atLeast(1),
      }),
    () => model.posts.delete({ where: (posts) => posts.editorId.isNot(null) }),
    () =>
      model.posts.delete({
        where: (posts) => posts.editor.name.isNot(null),
      }),
    // all(), before or after, asks for every row.
    () =>
      model.users
        .delete()
        .where(() => [])
        .all(),
    () =>
      model.users
        .delete()
        .all()
        .where(() => []),
  ]) {
    expect(() => filtered().toSQL()).not.toThrow();
  }
});

test("UPDATE and DELETE refuse an emptied contains(), a condition with its opposite and a coalesce() that is never NULL", () => {
  const { items } = schema({
    items: {
      id: int.auto,
      tags: text.array,
      labels: text.array.nullable,
      score: int.nullable,
      note: text.nullable,
      active: bool,
      meta: jsonb<Record<string, unknown>>(),
      data: jsonb<unknown>().nullable,
    },
  });
  const requested: string[] = [];

  for (const everyRow of [
    // An empty list asks for nothing, as notIn([]) does.
    () => items.delete({ where: (item) => item.tags.contains(requested) }),
    () => items.delete({ where: (item) => item.labels.contains([]) }),
    () => items.delete({ where: (item) => item.meta.contains({}) }),
    () => items.delete({ where: (item) => item.data.contains([]) }),
    () => items.delete({ where: (item) => not(item.tags.overlaps(requested)) }),
    // A condition and its opposite.
    () =>
      items.delete({
        where: (item) => or(item.score.is(null), item.score.isNot(null)),
      }),
    () =>
      items.delete({
        where: (item) => not(and(item.score.is(null), item.score.isNot(null))),
      }),
    () =>
      items.delete({
        where: (item) => or(item.data.is(null), item.data.isNot(null)),
      }),
    () =>
      items.delete({
        where: (item) =>
          or(item.score.is(null), item.score.above(0), item.score.atMost(0)),
      }),
    () =>
      items.delete({
        where: (item) => or(item.active.is(true), item.active.is(false)),
      }),
    () =>
      items.update(
        { note: "x" },
        { where: (item) => or(item.id.below(5), item.id.atLeast(5)) },
      ),
    // A coalesce() with a value that is never NULL.
    () =>
      items.delete({ where: (item) => coalesce(item.score, 0).isNot(null) }),
    () =>
      items.delete({
        where: (item) => coalesce(item.score, item.id).isNot(null),
      }),
  ]) {
    expect(() => everyRow().toSQL()).toThrow("where() leaves no condition");
  }

  // The refusal of an emptied contains() says what it would match, on an
  // array, a jsonb column and a JSON path alike.
  for (const emptied of [
    () => items.delete({ where: (item) => item.labels.contains([]) }),
    () => items.delete({ where: (item) => item.meta.contains({}) }),
    () => items.delete({ where: (item) => item.meta.path("a").contains([]) }),
  ]) {
    expect(() => emptied().toSQL()).toThrow(
      "delete() where() leaves no condition: contains() of an empty list or object matches every row that holds a value, as notIn([]) matches every row; use isNot(null) for the rows that hold one, or call .all() to delete every row",
    );
  }

  for (const filtered of [
    () => items.delete({ where: (item) => item.tags.contains(["a"]) }),
    () => items.delete({ where: (item) => item.meta.contains({ a: 1 }) }),
    // No row overlaps an empty list: it writes nothing.
    () => items.delete({ where: (item) => item.tags.overlaps(requested) }),
    () => items.delete({ where: (item) => item.tags.is([]) }),
    () => items.delete({ where: (item) => item.score.is(null) }),
    // A NULL score passes neither side.
    () =>
      items.delete({
        where: (item) => or(item.score.is(1), item.score.isNot(1)),
      }),
    () =>
      items.delete({
        where: (item) => or(item.score.above(0), item.score.atMost(0)),
      }),
    () =>
      items.delete({
        where: (item) => or(item.note.is(null), item.score.isNot(null)),
      }),
    () => items.delete({ where: (item) => coalesce(item.score, 0).is(0) }),
    // A missing key and JSON null pass neither side.
    () =>
      items.delete({
        where: (item) =>
          or(item.meta.path("a").is(1), not(item.meta.path("a").is(1))),
      }),
  ]) {
    expect(() => filtered().toSQL()).not.toThrow();
  }
});

test("UPDATE and DELETE refuse opposites in other spellings, ranges over every value, an emptied like() and a condition alone in sql<boolean>", () => {
  const { items } = schema({
    items: {
      id: int.auto,
      name: text,
      nick: text.nullable,
      score: int.nullable,
      amount: numeric(12, 2),
      nums: int.array,
      meta: jsonb<unknown>(),
    },
  });
  const prefix = "" as string;

  for (const everyRow of [
    // is(null) and isNot(null) of a NOT NULL jsonb column count JSON null.
    () =>
      items.delete({
        where: (item) => or(item.meta.is(null), item.meta.isNot(null)),
      }),
    () =>
      items.update(
        { name: "x" },
        {
          where: (item) => not(and(item.meta.is(null), item.meta.isNot(null))),
        },
      ),
    // isDistinctFrom(2) is the opposite of is(2), NULL included; notIn([2])
    // is isNot(2); in() of the same list in any order.
    () =>
      items.delete({
        where: (item) => or(item.id.isDistinctFrom(2), item.id.is(2)),
      }),
    () =>
      items.delete({
        where: (item) => or(item.score.isDistinctFrom(2), item.score.is(2)),
      }),
    () =>
      items.delete({ where: (item) => or(item.id.notIn([2]), item.id.is(2)) }),
    () =>
      items.delete({
        where: (item) => or(not(item.id.in([1, 2])), item.id.in([2, 1])),
      }),
    // Ranges that together cover every value, or in an AND none.
    () =>
      items.delete({
        where: (item) => or(item.id.atLeast(5), item.id.below(6)),
      }),
    () =>
      items.delete({
        where: (item) => or(item.amount.above("1"), item.amount.atMost("1")),
      }),
    () =>
      items.delete({
        where: (item) => not(and(item.id.above(6), item.id.below(5))),
      }),
    () => items.delete({ where: (item) => not(item.id.between(5, 1)) }),
    // A length is a count: never NULL, never below 0.
    () => items.delete({ where: (item) => item.nums.length().atLeast(0) }),
    // A pattern of only % matches every text.
    () => items.delete({ where: (item) => item.name.like(`${prefix}%`) }),
    () => items.delete({ where: (item) => item.nick.ilike("%%") }),
    // A condition interpolated alone into sql<boolean> is that condition.
    () =>
      items.update(
        { name: "x" },
        { where: (item) => sql<boolean>`${item.id.notIn([])}` },
      ),
    () =>
      items.delete({
        where: (item) =>
          sql<boolean>` ${or(item.score.is(null), item.score.isNot(null))} `,
      }),
  ]) {
    expect(() => everyRow().toSQL()).toThrow("where() leaves no condition");
  }

  expect(() =>
    items.delete({ where: (item) => item.nick.like("%") }).toSQL(),
  ).toThrow(
    "delete() where() leaves no condition: like() or ilike() of a pattern of only % (an empty prefix) matches every row that holds a text, as notIn([]) matches every row; use isNot(null) for the rows that hold one, or call .all() to delete every row",
  );

  for (const filtered of [
    // A value lies between the bounds, or a NULL passes neither side.
    () =>
      items.delete({
        where: (item) => or(item.id.below(5), item.id.above(5)),
      }),
    () =>
      items.delete({
        where: (item) => or(item.id.below(5), item.id.atLeast(6)),
      }),
    () =>
      items.delete({
        where: (item) => or(item.score.atLeast(5), item.score.below(6)),
      }),
    () =>
      items.delete({
        where: (item) => not(and(item.id.atLeast(5), item.id.atMost(5))),
      }),
    () => items.delete({ where: (item) => not(item.id.between(1, 5)) }),
    // Text orders as text, not as numbers.
    () =>
      items.delete({
        where: (item) => or(item.name.atLeast("9"), item.name.below("10")),
      }),
    // JSON null passes neither side.
    () =>
      items.delete({
        where: (item) => or(item.meta.above(5), item.meta.atMost(5)),
      }),
    () => items.delete({ where: (item) => item.name.like("a%") }),
    () => items.delete({ where: (item) => item.name.like("_%") }),
    () =>
      items.delete({ where: (item) => sql<boolean>`${item.id.notIn([1])}` }),
  ]) {
    expect(() => filtered().toSQL()).not.toThrow();
  }
});

test("UPDATE and DELETE refuse JSON null tests in either spelling, points and pieces of number ranges, negated groups and conditions in redundant sql<boolean>", () => {
  const { items } = schema({
    items: {
      id: int.auto,
      name: text,
      score: int.nullable,
      born: date,
      meta: jsonb<unknown>(),
      data: jsonb<unknown>().nullable,
      doc: jsonb<{ k?: number }>(),
    },
  });
  type Where = NonNullable<Parameters<typeof items.delete>[0]>["where"];

  const everyRow: Where[] = [
    // isDistinctFrom(null) of a jsonb column is isNot(null), in either order.
    (item) => or(item.meta.isDistinctFrom(null), item.meta.is(null)),
    (item) => or(item.meta.is(null), item.meta.isDistinctFrom(null)),
    (item) => or(item.data.isDistinctFrom(null), item.data.is(null)),
    // IS DISTINCT FROM a value holds where the operand is JSON null or missing.
    (item) => or(item.meta.isDistinctFrom(2), item.meta.is(2)),
    (item) =>
      or(item.doc.path("k").isDistinctFrom(1), item.doc.path("k").is(1)),
    // An equality between a lower and an upper bound, isNot() beside a range
    // that holds its value, between() as a piece, a list of one value twice.
    (item) => or(item.id.below(5), item.id.is(5), item.id.above(5)),
    (item) => or(item.id.isNot(5), item.id.atLeast(5)),
    (item) => or(item.id.isNot(1), item.id.isNot(2)),
    (item) => or(item.id.below(3), item.id.between(3, 5), item.id.above(5)),
    (item) => or(item.id.in([1, 1]), item.id.notIn([1])),
    (item) => not(and(item.id.is(1), item.id.is(2))),
    // An AND whose numbers the points it leaves out use up, also a long one.
    (item) => not(and(item.id.atLeast(5), item.id.atMost(5), item.id.isNot(5))),
    (item) =>
      not(
        and(
          item.id.between(0, 0),
          ...Array.from({ length: 1000 }, (_unused, k) => item.id.isNot(k)),
        ),
      ),
    // A group below a not() is read by De Morgan.
    (item) => or(item.id.below(5), not(or(item.id.below(5), item.id.below(4)))),
    (item) => or(item.id.below(5), and(item.id.atLeast(5), item.id.atLeast(5))),
    // Parentheses and `= true` around a condition alone in sql<boolean>.
    (item) => sql<boolean>`(${item.id.notIn([])})`,
    (item) => sql<boolean>`((${item.id.notIn([])}) = true)`,
    (item) => sql<boolean>`${item.id.notIn([])} IS TRUE`,
    // A NOT NULL id: `id <> 1 IS TRUE` or `id = 1` holds for every row.
    (item) => or(sql<boolean>`${item.id.isNot(1)} IS TRUE`, item.id.is(1)),
    // like() of only % of a value cast to text.
    (item) => item.born.like("%"),
  ];

  for (const where of everyRow) {
    expect(() => items.delete({ where }).toSQL()).toThrow(
      "where() leaves no condition",
    );
  }

  const filtered: Where[] = [
    // A NULL score, JSON null and a missing key pass neither side.
    (item) => or(item.score.below(5), item.score.is(5), item.score.above(5)),
    (item) => or(item.score.isNot(1), item.score.isNot(2)),
    (item) => or(item.meta.is(2), item.meta.isNot(2)),
    (item) => or(item.meta.is(2), not(item.meta.is(2))),
    (item) => or(item.meta.isDistinctFrom(2), item.meta.isNot(2)),
    (item) => or(item.id.below(5), item.id.above(5)),
    (item) => or(item.id.below(3), item.id.between(4, 5), item.id.above(5)),
    (item) => or(item.id.in([1, 2]), item.id.notIn([1])),
    (item) => or(item.id.below(5), not(or(item.id.below(6), item.id.below(7)))),
    (item) => not(and(item.id.atLeast(5), item.id.atMost(6), item.id.isNot(5))),
    (item) =>
      not(
        and(
          item.id.between(0, 1000),
          ...Array.from({ length: 1000 }, (_unused, k) => item.id.isNot(k)),
        ),
      ),
    // IS TRUE reads NULL as FALSE, so NOT (P IS TRUE) is not not(P): this
    // subquery finds the rows whose score is NULL.
    () =>
      notExists(
        items((other) => ({ id: other.id }), {
          where: (other) => [
            other.score.is(null),
            not(sql<boolean>`${other.score.below(5)} IS TRUE`),
          ],
        }),
      ),
    (item) =>
      item.id.notIn(
        items((other) => ({ id: other.id }), {
          where: (other) =>
            and(
              other.score.is(null),
              not(sql<boolean>`(${other.score.below(5)}) IS TRUE`),
            ),
        }),
      ),
    // A NULL score passes neither side.
    (item) =>
      or(sql<boolean>`${item.score.isNot(1)} IS TRUE`, item.score.is(1)),
    // Other SQL around a condition keeps it opaque.
    (item) => sql<boolean>`NOT (${item.id.notIn([])})`,
    (item) => sql<boolean>`${item.id.notIn([])} = false`,
    (item) => sql<boolean>`(${item.id.notIn([])}) OR false`,
    (item) => item.born.like("2024%"),
  ];

  for (const where of filtered) {
    expect(() => items.delete({ where }).toSQL()).not.toThrow();
  }
});

test("UPDATE and DELETE check deep and()/or()/not() filters in time that grows with their size, with the same refusals", () => {
  const { items } = schema({
    items: { id: int.auto, name: text, age: int.nullable },
  });
  type Where = NonNullable<Parameters<typeof items.delete>[0]>["where"];
  type Row = Parameters<Extract<Where, (row: never) => unknown>>[0];
  const depth = 1000;
  // A filter built step by step: `where = or(where, …)` / `and(where, …)`.
  const folded = (item: Row) => {
    let where = item.id.is(0);

    for (let k = 1; k < depth; k += 1) {
      where = k % 2 ? or(where, item.id.is(k)) : and(where, item.id.isNot(k));
    }

    return where;
  };
  // not(or(id < k, not(and(id > k - 1, …)))), from a first condition.
  const negated = (item: Row, first: ReturnType<typeof or>) => {
    let where = first;

    for (let k = 1; k <= depth; k += 1) {
      where =
        k % 2
          ? not(or(item.age.below(k), where))
          : not(and(item.age.above(k), where));
    }

    return where;
  };
  const started = performance.now();

  for (const where of [
    folded,
    (item: Row) => negated(item, item.id.is(0)),
    (item: Row) => and(item.id.is(1), negated(item, item.name.is("x"))),
  ]) {
    expect(() => items.delete({ where }).toSQL()).not.toThrow();
  }

  // In 3.6.0 candidates before this, each took seconds to minutes.
  expect(performance.now() - started).toBeLessThan(1000);

  // The not()s turn a condition with its opposite, deep inside, into the
  // answer of the whole: past the 1,024 terms searched at once, it is still
  // found where it is.
  expect(() =>
    items
      .delete({
        where: (item) => negated(item, or(item.id.is(1), item.id.isNot(1))),
      })
      .toSQL(),
  ).toThrow("where() leaves no condition");
  expect(() =>
    items
      .delete({
        where: (item) => negated(item, or(item.age.is(1), item.age.isNot(1))),
      })
      .toSQL(),
  ).not.toThrow();
});

test("a write's subquery over its own table, built from the same handle, keeps its correlation with the written row", () => {
  const namesake = (user: { id: unknown; name: unknown }) =>
    notExists(
      model.users((other) => ({ id: other.id }), {
        where: (other) => [
          other.name.is(user.name as never),
          other.id.isNot(user.id as never),
        ],
      }),
    );
  const correlated =
    'WHERE NOT EXISTS (SELECT "users_2"."id" AS "id"\nFROM "users" AS "users_2"\nWHERE "users_2"."name" = "users"."name" AND "users_2"."id" <> "users"."id")';

  expect(model.users.delete({ where: namesake }).toSQL().sql).toBe(
    `DELETE FROM "users" AS "users"\n${correlated}`,
  );
  expect(
    model.users.update({ active: false }).where(namesake).toSQL().sql,
  ).toBe(`UPDATE "users" AS "users" SET "active" = $1\n${correlated}`);
  expect(
    model.users
      .insert({ name: "Ada" })
      .onConflict("name")
      .doUpdate({ active: false }, { where: (current) => namesake(current) })
      .toSQL().sql,
  ).toContain(`DO UPDATE SET "active" = $2\n${correlated}`);

  // The value of SET and of RETURNING, too.
  const namesakes = (user: { name: unknown }) =>
    model
      .users(() => ({ total: count() }), {
        where: (other) => other.name.is(user.name as never),
      })
      .scalar();
  const counted =
    '(SELECT COUNT(*) AS "total"\nFROM "users" AS "users_2"\nWHERE "users_2"."name" = "users"."name")';

  expect(
    model.users
      .update((user) => ({ visits: coalesce(namesakes(user), 0) }))
      .all()
      .toSQL().sql,
  ).toBe(`UPDATE "users" AS "users" SET "visits" = COALESCE(${counted}, $1)`);
  expect(
    model.users
      .delete({ where: (user) => user.id.is(1) })
      .returning((user) => ({ id: user.id, namesakes: namesakes(user) }))
      .toSQL().sql,
  ).toContain(`RETURNING "users"."id" AS "id", ${counted} AS "namesakes"`);
});

test("not() over JSON leaves JSON null out of a query, and DDL keeps the condition as written", () => {
  const documents = table({
    id: int.auto,
    tag: int,
    meta: jsonb<{ state: string }>(),
  });
  const declared = schema({
    documents: documents
      .checks((document) => ({
        live: not(document.meta.path("state").is("archived")),
      }))
      .indexes((document) => ({
        live: index(document.tag).where(
          not(document.meta.path("state").is("archived")),
        ),
      })),
  });
  const [snapshot] = declared.$snapshot().tables;
  const plain = `NOT (("meta" #> ARRAY[E'state'::text]) = E'"archived"'::text::jsonb)`;

  expect(snapshot!.checks![0]!.expression).toBe(plain);
  expect(snapshot!.indexes![0]!.where).toBe(plain);
  // The path is compared bare, with a part that makes JSON null answer NULL,
  // so the negation is plain. A filter drops that constant-NULL part, which
  // leaves the condition a partial index declared with it matches.
  expect(
    declared
      .documents((document) => ({ id: document.id }), {
        where: (document) => not(document.meta.path("state").is("archived")),
      })
      .toSQL().sql,
  ).toEndWith(
    `WHERE NOT ((("documents"."meta" #> ARRAY[$1::text]) = $2::text::jsonb OR (("documents"."meta" #> ARRAY[$1::text]) = 'null'::jsonb AND NULL)))`,
  );
  // So it is with several conditions.
  expect(
    declared
      .documents((document) => ({ id: document.id }), {
        where: (document) =>
          not(or(document.meta.path("state").is("a"), document.tag.is(1))),
      })
      .toSQL().sql,
  ).toEndWith(
    `WHERE NOT (((("documents"."meta" #> ARRAY[$1::text]) = $2::text::jsonb OR (("documents"."meta" #> ARRAY[$1::text]) = 'null'::jsonb AND NULL)) OR "documents"."tag" = $3))`,
  );
  // A JSON expression that is no column or path still keeps both forms.
  expect(
    declared
      .documents((document) => ({ id: document.id }), {
        where: (document) =>
          not(
            or(
              coalesce(document.meta.path("state"), "b").is("a"),
              document.tag.is(1),
            ),
          ),
      })
      .toSQL().sql,
  ).toContain(" AND NOT (((NULLIF(COALESCE(");
});

test("JSON null in a NOT NULL jsonb column is null in a query, while DDL and page cursors keep the earlier SQL", async () => {
  const notes = table({
    id: int.auto,
    body: jsonb<unknown>(),
    list: jsonb<unknown>().nullable,
    extra: jsonb<{ a?: unknown }>().nullable,
  });
  const declared = schema({
    notes: notes
      .checks((note) => ({ small: note.body.isNot(0) }))
      .indexes((note) => ({
        wide: index(note.id).where(note.extra.path("a").between([], [9])),
      })),
  });
  const [snapshot] = declared.$snapshot().tables;

  expect(snapshot!.checks![0]!.expression).toBe(`"body" <> E'0'::text::jsonb`);
  expect(snapshot!.indexes![0]!.where).toBe(
    `("extra" #> ARRAY[E'a'::text]) BETWEEN E'[]'::text::jsonb AND E'[9]'::text::jsonb`,
  );

  const where = (options: Parameters<typeof declared.notes>[1]) =>
    declared
      .notes((note) => ({ id: note.id }), options)
      .toSQL()
      .sql.split("WHERE ")[1];

  // The column stays bare, as an index and a partial index declared with the
  // same condition need, and JSON null answers NULL beside it, in any context.
  expect(where({ where: (note) => note.body.isNot(0) })).toBe(
    `("notes"."body" <> $1::text::jsonb AND ("notes"."body" <> 'null'::jsonb OR NULL))`,
  );
  expect(where({ where: (note) => note.body.below(5) })).toBe(
    `("notes"."body" < $1::text::jsonb AND ("notes"."body" <> 'null'::jsonb OR NULL))`,
  );
  // JSON null sorts below every value but `[]`: above 5 is FALSE for it.
  expect(where({ where: (note) => note.body.above(5) })).toBe(
    `("notes"."body" > $1::text::jsonb OR ("notes"."body" = 'null'::jsonb AND NULL))`,
  );
  expect(where({ where: (note) => note.body.atLeast([]) })).toBe(
    `("notes"."body" >= $1::text::jsonb AND ("notes"."body" <> 'null'::jsonb OR NULL))`,
  );
  expect(where({ where: (note) => note.body.above(note.list) })).toBe(
    `(("notes"."body" > "notes"."list" OR ("notes"."body" = 'null'::jsonb AND NULL)) AND ("notes"."body" <> 'null'::jsonb OR NULL))`,
  );
  // Below a not(), JSON null is null and stays out.
  expect(where({ where: (note) => not(note.body.above(5)) })).toBe(
    `NOT (("notes"."body" > $1::text::jsonb OR ("notes"."body" = 'null'::jsonb AND NULL)))`,
  );
  // So it does inside sql``, where only the comparison reads it.
  expect(
    where({ where: (note) => sql<boolean>`NOT ${note.body.below(5)}` }),
  ).toBe(
    `(NOT (("notes"."body" < $1::text::jsonb AND ("notes"."body" <> 'null'::jsonb OR NULL)))) = (TRUE)`,
  );
  // IS DISTINCT FROM a value holds for JSON null as for NULL.
  expect(where({ where: (note) => note.body.isDistinctFrom(1) })).toBe(
    `"notes"."body" IS DISTINCT FROM $1::text::jsonb`,
  );
  expect(where({ where: (note) => note.body.isDistinctFrom(null) })).toBe(
    `NULLIF("notes"."body", 'null'::jsonb) IS DISTINCT FROM $1::text::jsonb`,
  );
  // Both sides read JSON null as null: two JSON nulls are not distinct.
  expect(where({ where: (note) => note.body.isDistinctFrom(note.list) })).toBe(
    `NULLIF("notes"."body", 'null'::jsonb) IS DISTINCT FROM NULLIF("notes"."list", 'null'::jsonb)`,
  );
  expect(where({ where: (note) => note.body.notIn([0]) })).toBe(
    `NULLIF("notes"."body", 'null'::jsonb) NOT IN ($1::text::jsonb)`,
  );
  // An empty top-level array sorts below JSON null; from another bound,
  // BETWEEN is FALSE for JSON null, which the statement makes NULL.
  expect(where({ where: (note) => note.list.between([], [9]) })).toBe(
    `("notes"."list" BETWEEN $1::text::jsonb AND $2::text::jsonb AND ("notes"."list" <> 'null'::jsonb OR NULL))`,
  );
  expect(where({ where: (note) => note.list.between(0, [9]) })).toBe(
    `("notes"."list" BETWEEN $1::text::jsonb AND $2::text::jsonb OR ("notes"."list" = 'null'::jsonb AND NULL))`,
  );
  // Equality, IN lists and containment keep the plain column an index
  // serves; they are TRUE for JSON null only against JSON null, and their
  // FALSE for it is NULL, also below a NOT written in sql``.
  expect(where({ where: (note) => note.body.is(0) })).toBe(
    `("notes"."body" = $1::text::jsonb OR ("notes"."body" = 'null'::jsonb AND NULL))`,
  );
  expect(where({ where: (note) => note.list.in([1, 2]) })).toBe(
    `("notes"."list" IN ($1::text::jsonb, $2::text::jsonb) OR ("notes"."list" = 'null'::jsonb AND NULL))`,
  );
  expect(where({ where: (note) => note.body.contains({ a: 1 }) })).toBe(
    `("notes"."body" @> $1::text::jsonb OR ("notes"."body" = 'null'::jsonb AND NULL))`,
  );
  expect(where({ where: (note) => not(note.extra.path("a").is(1)) })).toBe(
    `NOT ((("notes"."extra" #> ARRAY[$1::text]) = $2::text::jsonb OR (("notes"."extra" #> ARRAY[$1::text]) = 'null'::jsonb AND NULL)))`,
  );
  expect(where({ where: (note) => sql<boolean>`NOT ${note.body.is(0)}` })).toBe(
    `(NOT (("notes"."body" = $1::text::jsonb OR ("notes"."body" = 'null'::jsonb AND NULL)))) = (TRUE)`,
  );
  // A subquery keeps IN as written, and not() reads it with JSON null as null.
  expect(
    where({
      where: (note) =>
        note.body.in(declared.notes((other) => ({ v: other.list }))),
    }),
  ).toBe(
    `"notes"."body" IN (SELECT "notes_2"."list" AS "v"\nFROM "notes" AS "notes_2")`,
  );
  expect(where({ where: (note) => not(note.body.is(null)) })).toBe(
    `NOT (("notes"."body" IS NULL OR "notes"."body" = ('null'::jsonb)))`,
  );

  const rows = [
    { id: 1, __symmetria_cursor_0: "1" },
    { id: 2, __symmetria_cursor_0: "2" },
    { id: 3, __symmetria_cursor_0: "3" },
  ];
  const database = schema({ notes }, { executor: async () => rows });
  const page = await database
    .notes((note) => ({ id: note.id }), {
      where: (note) => [
        note.body.isNot(0),
        note.body.notIn([1, 2]),
        note.body.isDistinctFrom(null),
        note.body.below(5),
        not(note.body.is(3)),
        note.list.between([], [9]),
        note.extra.path("a").between([], [9]),
        not(note.extra.path("a").in([1, 2])),
        note.extra
          .path("a")
          .notIn(database.notes((other) => ({ v: other.extra.path("a") }))),
        note.body.is(4),
        note.list.in([5, 6]),
        note.body.between(1, 9),
        note.body.contains({ a: 1 }),
        not(note.extra.path("a").contains([1])),
      ],
      orderBy: (note) => note.id.asc,
    })
    .page({ size: 2 });

  // The cursor 3.5.0 issued, before these conditions read JSON null as null.
  expect(String(page.nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6Ijk3MjMyY2E0ODUwZDRkZDVjNmE0NDc0MTQ5MmQxNmNhNmVlNWRlYTBmNDljYjM4ZTU0Y2FjOWQxNjg2ZGEwOTkiLCJ2YWx1ZXMiOlsiMiJdfQ",
  );

  const compared = await database
    .notes((note) => ({ id: note.id }), {
      where: (note) => [
        note.body.isDistinctFrom(note.list),
        note.list.isDistinctFrom(note.body),
        note.body.above(5),
        not(note.body.below(note.list)),
      ],
      orderBy: (note) => note.id.asc,
    })
    .page({ size: 2 });

  expect(String(compared.nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6ImY2ODljYmFhMDI4ZDkwN2JkNjExYjI5MDg5ZDdkMWJhMmQ2ZjBmMmM1YzYxNzU4MGNjNjVmNTE1MDliZWQ5ZTEiLCJ2YWx1ZXMiOlsiMiJdfQ",
  );

  // Schema DDL keeps both sides bare, as 3.5.0 wrote them.
  const [distinct] = schema({
    notes: notes.checks((note) => ({
      apart: note.body.isDistinctFrom(note.list),
    })),
  }).$snapshot().tables;

  expect(distinct!.checks![0]!.expression).toBe(
    `"body" IS DISTINCT FROM "list"`,
  );
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
    .events((events) => ({ id: events.id }), {
      orderBy: (events) => events.id.ascending,
    })
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
  // Writes are validated but stored as given; the transform runs on read only.
  expect(
    local.users.insert({ settings: { theme: "Dark" } }).toSQL().parameters,
  ).toEqual(['{"theme":"Dark"}']);
  await expectDataError(
    () => local.users.insert({ settings: { theme: 42 } as never }),
    /theme: theme must be a string/,
  );
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
  await expectDataError(
    () =>
      schema({
        users: { id: int.auto, settings: jsonb(asynchronous) },
      }).users.insert({
        settings: {},
      }),
    /synchronously/,
  );
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
    .items(
      (items) => ({
        id: items.id,
        count: items.tags.length().as("count"),
      }),
      {
        where: (items) =>
          and(
            items.tags.has("a"),
            items.tags.contains(["a"]),
            items.tags.overlaps(["x", "y"]),
            items.scores.has(5),
          ),
      },
    )
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
  await expectDataError(
    () => local.items.insert({ title: "t", tags: "a" as never }),
    /accept arrays/,
  );
});

test("search() and searchRank() compile to PostgreSQL full-text search", () => {
  const query = model
    .posts(
      (posts) => ({
        id: posts.id,
        searchRank: posts.title.searchRank("bun sql", { language: "english" }),
      }),
      {
        where: (posts) => posts.title.search("bun sql"),
        orderBy: (posts) => posts.title.searchRank("bun sql").descending,
      },
    )
    .toSQL();
  expect(query.sql).toContain(
    `ts_rank(to_tsvector('english', "posts"."title"), (SELECT websearch_to_tsquery('english', $1))) AS "searchRank"`,
  );
  expect(query.sql).toContain(
    `WHERE to_tsvector('simple', "posts"."title") @@ websearch_to_tsquery('simple', $2)`,
  );
  expect(query.parameters).toEqual(["bun sql", "bun sql", "bun sql"]);
  expect(() =>
    model.posts({
      where: (posts) => posts.title.search("x", { language: "en;drop" }),
    }),
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
  first.parameters.fill("changed");
  expect(query.toSQL().parameters).toContain('{"tags":["original"]}');
  // timestamptz values are bound as UTC ISO text, captured when the query was built.
  expect(query.toSQL().parameters).toContain("2026-01-01T00:00:00.000Z");
});

const inferred = model.posts((posts, { leftJoin }) => {
  const editor = leftJoin(posts.editor);

  return {
    title: posts.title,
    editorName: coalesce(editor.name, "Nobody").as("editorName"),
    shownName: coalesce(editor.name, posts.title),
    count: count(),
  };
});
type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;
test("jsonb(schema).contains() takes a partial value without schema validation", () => {
  const strict = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) =>
        value && typeof (value as { id?: unknown }).id === "number"
          ? { value: value as { id: number; type: string } }
          : { issues: [{ message: "id is required" }] },
    },
  } as const;
  const events = schema({ events: { id: int.auto, payload: jsonb(strict) } });
  expect(
    events
      .events(
        (event) => ({
          id: event.id,
        }),
        { where: (event) => event.payload.contains({ type: "created" }) },
      )
      .toSQL(),
  ).toEqual({
    sql: `SELECT "events"."id" AS "id"\nFROM "events" AS "events"\nWHERE ("events"."payload" @> $1::text::jsonb OR ("events"."payload" = 'null'::jsonb AND NULL))`,
    parameters: ['{"type":"created"}'],
  });
  expect(() =>
    events.events.insert({ payload: { type: "created" } as never }).toSQL(),
  ).toThrow(/id is required/);
});

test("long literal IN lists bind one array parameter on PostgreSQL", () => {
  const ids = Array.from({ length: 1001 }, (_, id) => id);
  const query = model.users(
    (users) => ({
      id: users.id,
    }),
    { where: (users) => [users.id.in(ids), users.name.notIn(ids.map(String))] },
  );
  expect(query.toSQL()).toEqual({
    sql: 'SELECT "users"."id" AS "id"\nFROM "users" AS "users"\nWHERE "users"."id" = ANY(($1)::integer[]) AND "users"."name" <> ALL(($2)::text[])',
    parameters: [ids, ids.map(String)],
  });
  expect(
    model
      .users((users) => ({ id: users.id }), {
        where: (users) => users.id.in([1, 2]),
      })
      .toSQL().sql,
  ).toEndWith('WHERE "users"."id" IN ($1, $2)');

  // An enum (whose type name the runtime need not know) and a typed column
  // with a precision leave the array untyped: PostgreSQL types it from the
  // column as it types each $n of a short list, and rounds nothing.
  const events = schema({
    events: {
      id: int.auto,
      kind: oneOf("a", "b"),
      at: customType<string>("timestamp(3)", {
        encode: (value: string) => value,
        decode: (value: unknown) => String(value),
      }),
      meta: jsonb<{ n: number }>(),
    },
  });
  const kinds = Array.from({ length: 1001 }, () => "a" as const);
  const moments = ids.map((id) => `2024-01-01 00:00:${id % 60}`);
  expect(
    events
      .events((event) => ({ id: event.id }), {
        where: (event) => [
          event.kind.in(kinds),
          event.at.notIn(moments),
          event.meta.path("n").in(ids),
        ],
      })
      .toSQL(),
  ).toEqual({
    sql: `SELECT "events"."id" AS "id"\nFROM "events" AS "events"\nWHERE "events"."kind" = ANY($1) AND "events"."at" <> ALL($2) AND (("events"."meta" #> ARRAY[$3::text]) = ANY($4::text[]::jsonb[]) OR (("events"."meta" #> ARRAY[$3::text]) = 'null'::jsonb AND NULL))`,
    parameters: [kinds, moments, "n", ids.map(String)],
  });
});

test("coalesce accepts a non-null expression fallback", () => {
  expect(inferred.toSQL().sql).toContain(
    'COALESCE("editor"."name", "posts"."title") AS "shownName"',
  );
});
type ResultMatches = Expect<
  AreEqual<
    Awaited<ReturnType<typeof inferred.execute>>,
    { title: string; editorName: string; shownName: string; count: number }[]
  >
>;
const returned = model.users
  .insert({ name: "Ada" })
  .returning((users) => [users.id, users.balance]);
type ReturningMatches = Expect<
  AreEqual<
    Awaited<ReturnType<typeof returned.execute>>,
    { id: number; balance: Decimal }
  >
>;

test("JSON values convert for LIKE, arithmetic and sums, and order for MIN/MAX", () => {
  const local = schema({
    documents: {
      id: int.auto,
      meta: jsonb<{ theme: string; size: number }>(),
      label: jsonb<string | null>(),
    },
  });
  const { sql: text } = local
    .documents(
      (document) => ({
        next: document.meta.path("size").plus(1),
        total: sum(document.meta.path("size")),
      }),
      { where: (document) => document.meta.path("theme").like("d%") },
    )
    .toSQL();

  // The JSON value enters as its text (`#>> '{}'`), cast for arithmetic and sums.
  expect(text).toContain(
    `("documents"."meta" #> ARRAY[$1::text]) #>> '{}')))::double precision) + $2::text::double precision) AS "next"`,
  );
  expect(text).toContain(
    `SUM(((((\"documents\".\"meta\" #> ARRAY[$3::text]) #>> '{}')))::numeric)::numeric AS "total"`,
  );
  expect(text).toEndWith(
    `WHERE ((("documents"."meta" #> ARRAY[$4::text]) #>> '{}')) LIKE $5`,
  );
  // jsonb has no MIN or MAX: the first element of MIN(ARRAY[...]) orders as jsonb.
  expect(
    local
      .documents((document) => ({
        smallest: minimum(document.meta.path("size")),
      }))
      .toSQL().sql,
  ).toBe(
    `SELECT (MIN(ARRAY[("documents"."meta" #> ARRAY[$1::text])]) FILTER (WHERE ("documents"."meta" #> ARRAY[$1::text]) <> 'null'::jsonb))[1] AS "smallest"\nFROM "documents" AS "documents"`,
  );

  // A non-nullable jsonb column stores JS null as the JSON value null.
  expect(
    local.documents
      .insert({ meta: { theme: "a", size: 1 }, label: null })
      .toSQL().parameters,
  ).toEqual(['{"theme":"a","size":1}', "null"]);
  expect(
    local
      .documents((document) => ({ id: document.id }), {
        where: (document) => document.label.is(null),
      })
      .toSQL().sql,
  ).toEndWith(
    `WHERE ("documents"."label" IS NULL OR "documents"."label" = ('null'::jsonb))`,
  );
});

test("duplicate DO UPDATE conflict keys and table-named CTEs fail before SQL runs", async () => {
  const local = schema({
    counters: { id: int.auto, code: int.unique, label: text },
  });

  await expectDataError(
    () =>
      local.counters
        .insert([
          { code: 1, label: "a" },
          { code: 2, label: "b" },
          { code: 1, label: "c" },
        ])
        .onConflict("code")
        .doUpdate("label"),
    /rows 1 and 3 of the upsert on "counters" share a conflict key/,
    "SYMMETRIA_DUPLICATE_CONFLICT_KEY",
  );
  expect(
    local.counters
      .insert([
        { code: 1, label: "a" },
        { code: 1, label: "c" },
      ])
      .onConflict("code")
      .doNothing()
      .toSQL().parameters,
  ).toEqual([1, "a", 1, "c"]);
  expect(() =>
    local.counters((counter) => ({ id: counter.id })).cte("counters"),
  ).toThrow(/CTE "counters" has the SQL name of table "counters"/);
});

test("timestamp conflict keys before 2000 round the way PostgreSQL does", () => {
  const local = schema({
    stamps: { id: int.auto, at: timestamptz(0).unique, n: int },
  });
  const millennium = Date.UTC(2000, 0, 1);
  const upsert = (first: number, second: number) => () =>
    local.stamps
      .upsert(
        [
          { at: new Date(first), n: 1 },
          { at: new Date(second), n: 2 },
        ],
        { by: "at" },
      )
      .toSQL();

  // PostgreSQL counts from 2000-01-01 and rounds halves away from it:
  // 23:59:59.5 on the last day of 1999 is 23:59:59, not midnight.
  expect(upsert(millennium - 500, millennium - 1000)).toThrow(
    /rows 1 and 2 of the upsert on "stamps" share a conflict key/,
  );
  expect(upsert(millennium - 500, millennium)).not.toThrow();
  expect(upsert(millennium + 500, millennium + 1000)).toThrow(
    /share a conflict key/,
  );
});

test("column.is exposes enum labels as predicates and is otherwise a plain function", () => {
  const local = schema({
    records: {
      id: int.auto,
      title: text,
      state: oneOf("draft", "published", "name", "length"),
    },
  });
  const id = <Id>(records: { id: Id }) => ({ id: records.id });
  let seen: Record<string, unknown> = {};

  local.records((records) => {
    const is = records.state.is as unknown as Record<string, unknown>;
    const isNot = records.state.isNot as unknown as Record<string, unknown>;
    const plain = records.id.is as unknown as Record<string, unknown>;

    seen = {
      then: is.then,
      archived: is.archived,
      call: is.call,
      bind: is.bind,
      apply: is.apply,
      toString: is.toString,
      notThen: isNot.then,
      notCall: isNot.call,
      plainName: plain.name,
      plainLength: plain.length,
      plainThen: plain.then,
      called: records.state.is.call(undefined, "draft"),
      direct: records.state.is("draft"),
    };

    return { id: records.id };
  });

  expect(seen.then).toBeUndefined();
  expect(seen.archived).toBeUndefined();
  expect(seen.call).toBe(Function.prototype.call);
  expect(seen.bind).toBe(Function.prototype.bind);
  expect(seen.apply).toBe(Function.prototype.apply);
  expect(seen.toString).toBe(Function.prototype.toString);
  expect(seen.notThen).toBeUndefined();
  expect(seen.notCall).toBe(Function.prototype.call);
  expect(typeof seen.plainName).toBe("string");
  expect(seen.plainLength).toBe(1);
  expect(seen.plainThen).toBeUndefined();
  expect(seen.called).toEqual(seen.direct);

  // Labels that share a name with a function property are still predicates.
  for (const label of ["name", "length"] as const) {
    const byMember = local
      .records(id, { where: (records) => records.state.is[label] })
      .toSQL();
    const negated = local
      .records(id, { where: (records) => records.state.isNot[label] })
      .toSQL();

    expect(byMember).toEqual(
      local
        .records(id, { where: (records) => records.state.is(label) })
        .toSQL(),
    );
    expect(byMember.parameters).toEqual([label]);
    expect(negated.sql).toContain('"records"."state" <> $1');
  }

  // Without an enum column the labels live only in the types.
  const typed = local
    .records(id, { where: () => sql<"a" | "b">`'a'`.is.b })
    .toSQL();
  expect(typed.parameters).toEqual(["b"]);
});

test("JSON null is null in comparisons that tell NULL from a value", () => {
  const sqlOf = (where: Parameters<typeof model.posts>[1]) =>
    model.posts((posts) => ({ id: posts.id }), where).toSQL().sql;
  const path = '("posts"."metadata" #> ARRAY[$1::text])';

  // is(null) counts JSON null; so do the comparisons that skip NULL.
  expect(
    sqlOf({ where: (posts) => posts.metadata.path("tags").isNot(["a"]) }),
  ).toContain(`(NULLIF(${path}, 'null'::jsonb)) <>`);
  expect(
    sqlOf({ where: (posts) => posts.metadata.path("tags").notIn([["a"]]) }),
  ).toContain(`(NULLIF(${path}, 'null'::jsonb)) NOT IN`);
  // Equality keeps the plain path, with JSON null answering NULL beside it.
  expect(
    sqlOf({ where: (posts) => posts.metadata.path("tags").is(["a"]) }),
  ).toContain(
    `WHERE (${path} = $2::text::jsonb OR (${path} = 'null'::jsonb AND NULL))`,
  );
});

test("text operations on an enum, uuid or date read it as text", () => {
  const local = schema({
    records: {
      id: int.auto,
      state: oneOf("draft", "published"),
      token: uuid,
      day: date,
      label: text,
    },
  });
  const where = (
    filter: Parameters<typeof local.records>[1] extends infer Options
      ? Options extends { where?: infer Where }
        ? Where
        : never
      : never,
  ) =>
    local.records((records) => ({ id: records.id }), { where: filter }).toSQL()
      .sql;

  expect(where((records) => records.state.like("dr%"))).toContain(
    '(("records"."state")::text) LIKE $1',
  );
  expect(where((records) => records.day.like("2024-%"))).toContain(
    '(("records"."day")::text) LIKE $1',
  );
  expect(where((records) => records.token.ilike("abc%"))).toContain(
    '(("records"."token")::text) ILIKE $1',
  );
  // A text column compared with an enum or uuid column compares as text.
  expect(where((records) => records.label.is(records.state))).toContain(
    '"records"."label" = (("records"."state")::text)',
  );
  expect(where((records) => records.label.is(records.token))).toContain(
    '"records"."label" = (("records"."token")::text)',
  );
  // Text itself is left alone.
  expect(where((records) => records.label.like("a%"))).toContain(
    '"records"."label" LIKE $1',
  );
});

test("jsonb(schema).array reads, writes and filters with the schema's input", () => {
  // A schema whose input (stored) is a string and whose output is a Date.
  const event = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: (value: unknown) => ({
        value: { at: new Date((value as { at: string }).at) },
      }),
      types: undefined as unknown as {
        input: { at: string };
        output: { at: Date };
      },
    },
  };
  const local = schema({
    logs: { id: int.auto, one: jsonb(event), list: jsonb(event).array },
  });
  type Insert = InferInsert<typeof local.logs>;
  const stored = { at: "2026-01-01T00:00:00Z" };
  const row: Insert = { one: stored, list: [stored] };
  // @ts-expect-error writes take what is stored, not the schema's output
  const output: Insert = { one: stored, list: [{ at: new Date(0) }] };

  void output;
  expect(row.list).toEqual([stored]);
  expect(
    local.logs((logs) => ({ id: logs.id }), {
      where: (logs) => logs.list.has(stored),
    }),
  ).toBeDefined();
});

test("casts of bound values drop every type modifier, so a compared value is never rounded or cut", async () => {
  const as = (sqlType: string) =>
    customType<string>(sqlType, {
      encode: (value) => value,
      decode: (value) => String(value),
    });
  const local = schema({
    events: {
      id: int.auto,
      ats: timestamptz(0).array,
      local: timestamp(3).array,
      zoned: as("time(0) with time zone").array,
      spans: as("interval day to second(2)").array,
      bits: as("bit(3)").array,
      bit: as("bit").array,
      varying: as("bit varying(3)").array,
      letters: as("char").array,
      codes: varchar(5).array,
      prices: numeric(5, 2).array,
      // pg_catalog-qualified and quoted names of the same types.
      qualifiedBits: as("pg_catalog.bit(3)").array,
      qualifiedLetters: as("pg_catalog.bpchar(3)").array,
      quotedBits: as('"bit"(3)').array,
      quotedCodes: as('"varchar"(5)').array,
      amount: customType<string>("amount", { base: "numeric(30,10)" }),
      code: as("code5"),
      at: timestamptz(0),
    },
  });
  const where = (
    condition: Parameters<typeof local.events>[1] & object,
  ): string =>
    local
      .events((event) => ({ id: event.id }), condition)
      .toSQL()
      .sql.split("WHERE ")[1]!;
  const at = new Date("2020-01-01T12:00:00.400Z");

  expect(
    where({
      where: (event) => [
        event.ats.contains([at]),
        event.local.overlaps([at]),
        event.zoned.contains(["12:00:00.4+00"]),
        event.spans.contains(["1 day 02:00"]),
        event.bits.is(["10101"]),
        event.bit.contains(["10"]),
        event.varying.contains(["10101"]),
        event.letters.contains(["ab"]),
        event.codes.contains(["abcdefg"]),
        event.prices.contains(["1.501"]),
        event.qualifiedBits.contains(["1011"]),
        event.qualifiedLetters.contains(["abcd"]),
        event.quotedBits.contains(["1011"]),
        event.quotedCodes.contains(["abcdefg"]),
      ],
    }),
  ).toBe(
    [
      `"events"."ats" @> $1::text::timestamptz[]`,
      `"events"."local" && $2::text::timestamp[]`,
      `"events"."zoned" @> $3::text::time with time zone[]`,
      `"events"."spans" @> $4::text::interval[]`,
      `"events"."bits" = $5::text::"bit"[]`,
      `"events"."bit" @> $6::text::"bit"[]`,
      `"events"."varying" @> $7::text::bit varying[]`,
      `"events"."letters" @> $8::text::bpchar[]`,
      `"events"."codes" @> $9::text::varchar[]`,
      `"events"."prices" @> $10::text::numeric[]`,
      `"events"."qualified_bits" @> $11::text::pg_catalog.bit[]`,
      `"events"."qualified_letters" @> $12::text::pg_catalog.bpchar[]`,
      `"events"."quoted_bits" @> $13::text::"bit"[]`,
      `"events"."quoted_codes" @> $14::text::"varchar"[]`,
    ].join(" AND "),
  );

  // A prepared .nullable value: PostgreSQL's own types are named without
  // the precision; a domain, with or without a declared base, takes its type
  // from the comparison, never the domain's own (nor the base's, which for
  // citext declared with base "text" would compare case-sensitively).
  const nullable = (column: "amount" | "code" | "at") =>
    prepare(
      {
        value:
          column === "amount"
            ? customType<string>("amount", { base: "numeric(30,10)" }).nullable
            : column === "code"
              ? as("code5").nullable
              : timestamptz(0).nullable,
      },
      (parameters) =>
        local.events((event) => ({ id: event.id }), {
          where: (event) => event[column].is(parameters.value as never),
        }),
    )
      .toSQL({ value: null })
      .sql.split("WHERE ")[1];

  expect(nullable("amount")).toBe(
    `(("events"."amount" = $1 AND $1 IS NOT NULL) OR ($1 IS NULL AND "events"."amount" IS NULL))`,
  );
  expect(nullable("code")).toBe(
    `(("events"."code" = $1 AND $1 IS NOT NULL) OR ($1 IS NULL AND "events"."code" IS NULL))`,
  );
  expect(nullable("at")).toBe(
    `(CASE WHEN ($1)::timestamptz IS NULL THEN "events"."at" IS NULL ELSE "events"."at" = $1 END)`,
  );

  const rows = [
    { id: 1, __symmetria_cursor_0: "1" },
    { id: 2, __symmetria_cursor_0: "2" },
    { id: 3, __symmetria_cursor_0: "3" },
  ];
  const events = {
    id: int.auto,
    ats: timestamptz(0).array,
    local: timestamp(3).array,
    bits: as("bit(3)").array,
    spans: as("interval day").array,
    times: as("time(0)").array,
    // Other names of bigint and numeric, which nested values now keep exact.
    big: as("int8"),
    exact: as("decimal(30,10)"),
    dec: as("dec(30,10)"),
    bigs: customType<string[]>("_int8", {
      encode: (value) => value,
      decode: (value) => value as string[],
    }),
  };
  const paged = schema({ events }, { executor: async () => rows });
  const page = await paged
    .events(
      (event) => ({
        id: event.id,
        values: {
          big: event.big,
          exact: event.exact,
          dec: event.dec,
          bigs: event.bigs,
        },
      }),
      {
        where: (event) => [
          event.ats.contains([at]),
          event.local.overlaps([at]),
          event.bits.contains(["101"]),
          event.spans.contains(["1 day"]),
          event.times.is(["12:00:00"]),
        ],
        orderBy: (event) => event.id.asc,
      },
    )
    .page({ size: 2 });

  // The cursor 3.5.0 issued, whose casts kept the modifiers and whose nested
  // values were read by the declared spelling.
  expect(String(page.nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6ImJhZGQwOTFiZTZhZDc5ZWJjNmFjNjIyNTY4ZWFlOGQ3NTdkYWY5NzExMTEyMDY0ZmM5MWE4NjUzYmVlZTY4ZGIiLCJ2YWx1ZXMiOlsiMiJdfQ",
  );
});

test("page cursors 3.5.0 issued for nested-object keys with a backslash and a nested field named __symmetria_row stay valid", async () => {
  const rows = [1, 2, 3].map((id) => ({
    id,
    __symmetria_cursor_0: String(id),
  }));
  const users = table({ id: int.auto, name: text, posts: many });
  const posts = table({ id: int.auto, title: text, author: one(users.posts) });
  const paged = schema({ users, posts }, { executor: async () => rows });
  const query = paged.users(
    (user) => ({
      id: user.id,
      names: { "first\\last": user.name, "it's\\": user.id },
      posts: user.posts((post) => ({
        __symmetria_row: post.title,
        keys: { "a\\b": post.id },
      })),
    }),
    { orderBy: (user) => user.id.asc },
  );

  // The query writes such a key as an escape string, and renames the rows'
  // alias away from the field.
  expect(query.toSQL().sql).toContain(`E'first\\\\last', "users"."name"`);
  expect(query.toSQL().sql).toContain(`json_agg("__symmetria_row_")`);
  // The cursor 3.5.0 issued, when keys were plain literals and the rows'
  // alias was always "__symmetria_row".
  expect(String((await query.page({ size: 2 })).nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6IjQ4N2E2ZjdkYjJiNjVlMjM2ODViZjBhZmIxOWExNWNkOGQzMTZhMDQ5MTFjNTE3OWY5NDU4NmJjYTg1YjFiOTkiLCJ2YWx1ZXMiOlsiMiJdfQ",
  );
});
