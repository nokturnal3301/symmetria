import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  bool,
  index,
  sum,
  count,
  maximum,
  over,
  type CompiledQuery,
} from "../../../packages/runtime/src";

const users = table({ id: int.auto, name: text, active: bool.default(true) });
const posts = table({ id: int.auto, title: text, author: users, version: int });
const memberships = table({ org: text, member: int }).primaryKey((row) => [
  row.org,
  row.member,
]);

/** A database whose executor records every statement and answers with canned rows. */
const recording = (rows: Record<string, unknown>[] = []) => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    { users, posts, memberships },
    {
      executor: async (query) => {
        calls.push(query);

        return rows;
      },
    },
  );

  return { database, calls, last: () => calls.at(-1)! };
};

const accounts = table({
  id: int.auto,
  email: text.unique,
  tenant: text,
  handle: text,
}).indexes((account) => ({
  identity: index(account.tenant, account.handle).unique,
}));
const logs = table({ line: text.unique });

const failing = () =>
  schema(
    { users, posts, memberships },
    {
      executor: async () => {
        throw new Error("boom");
      },
    },
  );

test("queries and writes have catch() and finally() like promises", async () => {
  const database = failing();
  const settled: string[] = [];

  expect(
    await database
      .users((user) => ({ id: user.id }))
      .catch((error: Error) => error.message),
  ).toBe("boom");
  expect(
    await database.users
      .insert({ name: "Ada" })
      .catch((error: Error) => error.message),
  ).toBe("boom");
  expect(
    await database.users
      .byId(1)
      .update({ name: "Ada" })
      .returning((user) => [user.id])
      .catch((error: Error) => error.message),
  ).toBe("boom");
  expect(
    await database.posts
      .insert({ title: "x", version: 1, author: { create: { name: "Ada" } } })
      .catch((error: Error) => error.message),
  ).toBe("symmetria: the configured driver does not support transactions");
  await database
    .users((user) => ({ id: user.id }))
    .finally(() => settled.push("select"))
    .catch(() => {});
  await database.users
    .delete()
    .all()
    .finally(() => settled.push("delete"))
    .catch(() => {});
  expect(settled).toEqual(["select", "delete"]);

  // Detached, like then().
  const { catch: caught } = database.users((user) => ({ id: user.id }));
  expect(await caught(() => "handled")).toBe("handled");

  const { database: working } = recording([{ id: 1 }]);
  expect(
    await working.users((user) => ({ id: user.id })).catch(() => []),
  ).toEqual([{ id: 1 }]);
});

test("get() and find() read one row by primary key", async () => {
  const { database, last } = recording([{ id: 7, name: "Ada", active: true }]);

  expect(await database.users.get(7)).toEqual({
    id: 7,
    name: "Ada",
    active: true,
  });
  expect(last()).toMatchObject({
    sql: 'SELECT "users"."id" AS "id", "users"."name" AS "name", "users"."active" AS "active"\nFROM "users" AS "users"\nWHERE "users"."id" = $1\nLIMIT 2',
    parameters: [7],
  });
  expect(await database.users.find(7)).toMatchObject({ id: 7 });

  await database.users.get(7, (user) => ({ name: user.name }));
  expect(last().sql).toBe(
    'SELECT "users"."name" AS "name"\nFROM "users" AS "users"\nWHERE "users"."id" = $1\nLIMIT 2',
  );
  await database.memberships.find({ org: "a", member: 2 });
  expect(last().parameters).toEqual(["a", 2]);

  const { database: empty } = recording([]);

  expect(await empty.users.find(7)).toBeNull();
  await expect(empty.users.get(7)).rejects.toMatchObject({
    code: "SYMMETRIA_RECORD_NOT_FOUND",
    table: "users",
  });
  // A malformed key rejects instead of throwing from the call.
  await expect(empty.memberships.get({ org: "a" } as never)).rejects.toThrow(
    '"org" is not the primary key or a unique key of "memberships"; its keys: [org, member]',
  );
  await expect(empty.users.find(null as never)).rejects.toThrow(
    'primary key "id" cannot be null or undefined',
  );
});

test("aggregate() resolves to one object", async () => {
  const { database, last } = recording([{ total: "3", latest: 9 }]);

  expect(
    await database.posts.aggregate((post, { count, maximum }) => ({
      total: count(),
      latest: maximum(post.version),
    })),
  ).toEqual({ total: 3, latest: 9 });
  expect(last().sql).toBe(
    'SELECT COUNT(*) AS "total", MAX("posts"."version") AS "latest"\nFROM "posts" AS "posts"\nLIMIT 2',
  );

  await database
    .posts({ where: (post) => post.version.above(1) })
    .aggregate((_post, { count }) => ({ total: count() }));
  expect(last().sql).toBe(
    'SELECT COUNT(*) AS "total"\nFROM "posts" AS "posts"\nWHERE "posts"."version" > $1\nLIMIT 2',
  );

  // Grouping can return several rows; that is not one aggregate.
  const { database: grouped } = recording([{ total: "1" }, { total: "2" }]);

  await expect(
    grouped.posts.aggregate((_post, { count }) => ({ total: count() })),
  ).rejects.toMatchObject({ code: "SYMMETRIA_TOO_MANY_ROWS" });
});

test("where takes an object of equalities", () => {
  const { database } = recording();
  const sql = (query: { toSQL: () => CompiledQuery }) => query.toSQL();
  const ids = (where: Parameters<typeof database.posts>[1]) =>
    sql(database.posts((post) => ({ id: post.id }), where));

  expect(ids({ where: { title: "Hello", version: 2 } })).toMatchObject({
    sql: 'SELECT "posts"."id" AS "id"\nFROM "posts" AS "posts"\nWHERE "posts"."title" = $1 AND "posts"."version" = $2',
    parameters: ["Hello", 2],
  });
  // The same SQL as the callback form.
  expect(ids({ where: { title: "Hello", version: 2 } })).toEqual(
    ids({
      where: (post) => [post.title.is("Hello"), post.version.is(2)],
    }),
  );
  // undefined leaves a key out; an empty object adds no filter.
  expect(ids({ where: { title: undefined, version: 2 } }).parameters).toEqual([
    2,
  ]);
  expect(ids({ where: {} }).sql).not.toContain("WHERE");
  // A callback may return the object too.
  expect(ids({ where: () => ({ version: 3 }) }).parameters).toEqual([3]);
  // Relations filter the same way.
  expect(
    sql(
      database.users((user) => ({
        posts: user.posts((post) => ({ id: post.id }), {
          where: { version: 1 },
        }),
      })),
    ).sql,
  ).toContain('"version" = $1');

  expect(() => ids({ where: { titel: "x" } as never })).toThrow(
    '"posts.titel" is not a column or relation of "posts" (did you mean "title"?)',
  );
  expect(() => ids({ where: { author: 1 } as never })).toThrow(
    'symmetria: where: "author" is a relation; the object form takes columns, use a callback for relation paths',
  );
  expect(() => ids({ where: { version: [1, 2] } as never })).toThrow(
    'symmetria: where: "version" takes one value; write a list as a callback, version.in([...])',
  );
});

test("where: null in an object is IS NULL", () => {
  const drafts = schema(
    { drafts: table({ id: int.auto, note: text.nullable }) },
    { executor: async () => [] },
  );

  expect(
    drafts
      .drafts((draft) => ({ id: draft.id }), { where: { note: null } })
      .toSQL().sql,
  ).toBe(
    'SELECT "drafts"."id" AS "id"\nFROM "drafts" AS "drafts"\nWHERE "drafts"."note" IS NULL',
  );
});

test("orderBy takes field names, and selected is among the tools", () => {
  const { database } = recording();
  const sql = (query: { toSQL: () => CompiledQuery }) => query.toSQL().sql;
  const report = (orderBy: unknown) =>
    sql(
      database.users(
        (user) => ({ name: user.name, written: user.posts.count() }),
        { orderBy } as never,
      ),
    );
  const callback = report(
    (
      user: never,
      _tools: never,
      selected: { written: { descending: unknown } },
    ) => selected.written.descending,
  );

  // A selected field by name is the callback form's SQL.
  expect(report({ written: "desc" })).toBe(callback);
  expect(
    report(
      (
        _user: never,
        tools: { selected: { written: { descending: unknown } } },
      ) => tools.selected.written.descending,
    ),
  ).toBe(callback);
  // Columns that are not selected work too, in key order, mixed with expressions.
  expect(report({ written: "desc", id: "asc" })).toEndWith(
    'DESC, "users"."id" ASC',
  );
  expect(
    sql(
      database.users((user) => ({ name: user.name }), {
        orderBy: (user) => [{ name: "asc" }, user.id.descending],
      }),
    ),
  ).toEndWith('ORDER BY "users"."name" ASC, "users"."id" DESC');
  expect(report({ written: undefined, id: "asc" })).toEndWith(
    'ORDER BY "users"."id" ASC',
  );

  // The words of the column properties, and the short properties, mean the same.
  expect(report({ written: "descending", id: "ascending" })).toBe(
    report({ written: "desc", id: "asc" }),
  );
  expect(
    sql(
      database.users((user) => ({ name: user.name }), {
        orderBy: (user) => [user.name.asc, user.id.desc.nullsLast],
      }),
    ),
  ).toEndWith('ORDER BY "users"."name" ASC, "users"."id" DESC NULLS LAST');

  expect(() => report({ id: "up" })).toThrow(
    'symmetria: orderBy: "id" must be "asc" or "desc" ("ascending" or "descending"), received "up"',
  );
  expect(() => report({ nmae: "asc" })).toThrow('did you mean "name"');
  expect(() => report({ posts: "asc" })).toThrow(
    'symmetria: orderBy: "posts" is a relation',
  );
  expect(() => report({})).toThrow("orderBy() requires expressions");
  expect(() => report([])).toThrow("orderBy() requires expressions");
});

test("a query given options and no fields reads the whole row", async () => {
  const { database, last } = recording([{ id: 1, name: "Ada", active: true }]);

  expect(await database.users({ where: { active: true }, limit: 5 })).toEqual([
    { id: 1, name: "Ada", active: true },
  ]);
  expect(last().sql).toBe(
    'SELECT "users"."id" AS "id", "users"."name" AS "name", "users"."active" AS "active"\nFROM "users" AS "users"\nWHERE "users"."active" = $1\nLIMIT 5',
  );
  await database
    .users({ limit: 5 })({ where: { id: 1 } })
    .one();
  expect(last().sql).toEndWith('WHERE "users"."id" = $1\nLIMIT 2');
  expect(database.users({ limit: 1 }).toSQL().sql).toStartWith(
    'SELECT "users"."id" AS "id", "users"."name" AS "name"',
  );
  // Fields chosen later replace the whole row.
  expect(
    database
      .users({ limit: 1 })((user) => ({ name: user.name }))
      .toSQL().sql,
  ).toStartWith('SELECT "users"."name" AS "name"\n');

  // A CTE and a derived table read the fields they were built with.
  const ranked = database
    .posts((post) => ({ id: post.id, author: { name: post.author.name } }))
    .cte("ranked");

  await ranked({ where: { id: 1 }, limit: 3 });
  expect(last().sql).toEndWith(
    'SELECT "ranked"."id" AS "id", "ranked"."author" AS "author"\nFROM "ranked" AS "ranked"\nWHERE "ranked"."id" = $1\nLIMIT 3',
  );
  await database
    .users((user) => ({ name: user.name }))
    .as("named")({ limit: 1 })
    .first();
  expect(last().sql).toStartWith('SELECT "named"."name" AS "name"\nFROM (');

  // A bare table or alias is not a query: awaiting one by accident reads nothing.
  expect(() =>
    (database.users as unknown as { toSQL: () => unknown }).toSQL(),
  ).toThrow("select fields in a shape before compiling or executing a query");
  await expect(
    (
      database.users.as("u") as unknown as { execute: () => Promise<unknown> }
    ).execute(),
  ).rejects.toThrow("select fields in a shape");
  expect(() => (ranked as unknown as { toSQL: () => unknown }).toSQL()).toThrow(
    "select fields in a shape",
  );
  expect(() =>
    (
      database.users({ groupBy: (user) => [user.active] }) as unknown as {
        toSQL: () => unknown;
      }
    ).toSQL(),
  ).toThrow("select fields in a shape");
});

test("row spreads the source's columns into a shape", () => {
  const { database } = recording();

  expect(
    database
      .posts((post, { row }) => ({ ...row, author: post.author.name }))
      .toSQL().sql,
  ).toBe(
    'SELECT "posts"."id" AS "id", "posts"."title" AS "title", "posts"."author_id" AS "authorId", "posts"."version" AS "version", "__symmetria_path_0"."name" AS "author"\nFROM "posts" AS "posts"\nINNER JOIN "users" AS "__symmetria_path_0" ON "posts"."author_id" = "__symmetria_path_0"."id"',
  );
  expect(
    database
      .users((user) => ({
        posts: user.posts((_post, { row }) => ({ ...row })),
      }))
      .toSQL().sql,
  ).toContain('"title" AS "title"');
});

test("predicates chain with and() and or()", () => {
  const { database } = recording();
  const where = (
    build: (
      post: Parameters<Parameters<typeof database.posts>[0]>[0],
    ) => unknown,
  ) =>
    database
      .posts((post) => ({ id: post.id }), { where: build as never })
      .toSQL()
      .sql.split("WHERE ")[1];

  expect(where((post) => post.version.above(1).and(post.title.is("a")))).toBe(
    '("posts"."version" > $1 AND "posts"."title" = $2)',
  );
  // A chain is one flat group, like and(a, b, c).
  expect(
    where((post) =>
      post.version.above(1).and(post.title.is("a")).and(post.id.is(3)),
    ),
  ).toBe(
    '("posts"."version" > $1 AND "posts"."title" = $2 AND "posts"."id" = $3)',
  );
  expect(
    where((post) =>
      post.version.above(1).and(post.title.is("a").or(post.id.is(3), false)),
    ),
  ).toBe(
    '("posts"."version" > $1 AND ("posts"."title" = $2 OR "posts"."id" = $3))',
  );
  expect(where((post) => post.version.above(1).and(undefined))).toBe(
    '("posts"."version" > $1)',
  );
});

test("update() and delete() take their filter as an option", () => {
  const { database } = recording();
  const chained = database.posts
    .update({ title: "x" })
    .where((post) => post.id.is(1))
    .toSQL();

  expect(
    database.posts.update({ title: "x" }, { where: { id: 1 } }).toSQL(),
  ).toEqual(chained);
  expect(
    database.posts
      .update({ title: "x" }, { where: (post) => post.id.is(1) })
      .toSQL(),
  ).toEqual(chained);
  expect(
    database.posts.delete({ where: { version: 2 } }).toSQL(),
  ).toMatchObject({
    sql: 'DELETE FROM "posts" AS "posts"\nWHERE "posts"."version" = $1',
    parameters: [2],
  });
  // Relation paths and further where() calls work as with the chained form.
  expect(
    database.posts
      .delete({ where: (post) => post.author.name.is("Ada") })
      .where((post) => post.version.is(1))
      .toSQL().sql,
  ).toBe(
    'DELETE FROM "posts" AS "posts"\nWHERE "posts"."id" IN (SELECT "posts"."id" AS "id"\nFROM "posts" AS "posts"\nINNER JOIN "users" AS "__symmetria_path_0" ON "posts"."author_id" = "__symmetria_path_0"."id"\nWHERE "__symmetria_path_0"."name" = $1) AND "posts"."version" = $2',
  );
  // Lookups take the option as one more condition.
  expect(
    database.posts
      .byId(3)
      .update({ title: "x" }, { where: { version: 1 } })
      .toSQL().sql,
  ).toEndWith('WHERE "posts"."id" = $2 AND "posts"."version" = $3');

  // An object that names no column must not become "every row".
  expect(() => database.posts.delete({ where: {} })).toThrow(
    "symmetria: delete() where: {} names no column; call .all() to delete every row",
  );
  expect(() =>
    database.posts.update({ title: "x" }, { where: { id: undefined } }),
  ).toThrow("update() where: {} names no column");
  // A missing option leaves the statement unrestricted, which is refused as before.
  expect(() => database.posts.delete({ where: undefined }).toSQL()).toThrow(
    'delete() on "posts" has no where(); call .all()',
  );
  expect(() => database.posts.delete({ wher: {} } as never)).toThrow(
    'unknown delete() option "wher"',
  );
});

test("upsert() inserts or overwrites the row with the same key", () => {
  const { database } = recording();
  const documents = schema(
    {
      documents: table({
        id: int.auto,
        slug: text.unique,
        title: text,
        body: text.default(""),
      }),
    },
    { executor: async () => [] },
  ).documents;

  expect(
    documents
      .upsert({ slug: "a", title: "A", body: "…" }, { by: "slug" })
      .toSQL(),
  ).toEqual(
    documents
      .insert({ slug: "a", title: "A", body: "…" })
      .onConflict("slug")
      .doUpdate("title", "body")
      .toSQL(),
  );
  expect(
    documents
      .upsert(
        [
          { slug: "a", title: "A" },
          { slug: "b", title: "B" },
        ],
        { by: "slug", update: ["title"] },
      )
      .returning("id")
      .toSQL().sql,
  ).toBe(
    'INSERT INTO "documents" AS "documents"\n("slug", "title") VALUES ($1, $2), ($3, $4)\nON CONFLICT ("slug") DO UPDATE SET "title" = "excluded"."title"\nRETURNING "documents"."id" AS "id"',
  );
  // Only the key: the row is kept and still returned.
  expect(
    database.memberships
      .upsert({ org: "a", member: 1 }, { by: ["member", "org"] })
      .toSQL().sql,
  ).toContain(
    'ON CONFLICT ("member", "org") DO UPDATE SET "member" = "excluded"."member", "org" = "excluded"."org"',
  );

  expect(() =>
    documents.upsert({ slug: "a", title: "A" }, { by: "title" }),
  ).toThrow(
    'symmetria: upsert() by: "title" is not the primary key or a unique key of "documents"; its keys: id, slug',
  );
  expect(() =>
    documents.upsert(
      [
        { slug: "a", title: "A", body: "x" },
        { slug: "b", title: "B" },
      ],
      { by: "slug" },
    ),
  ).toThrow(
    'symmetria: upsert() rows carry different columns ("body" is not in every row); list the columns to overwrite',
  );
  expect(() =>
    documents.upsert({ slug: "a", title: "A" }, {} as never),
  ).toThrow('upsert() on "documents" needs the conflict key');
});

test("returning() takes column names, or nothing for the whole row", async () => {
  const { database, last } = recording([{ id: 1, name: "Ada", active: true }]);

  expect(
    await database.users.insert({ name: "Ada" }).returning("id", "name"),
  ).toEqual({ id: 1, name: "Ada" });
  expect(last().sql).toEndWith(
    'RETURNING "users"."id" AS "id", "users"."name" AS "name"',
  );
  await database.users.byId(1).update({ name: "B" }).returning();
  expect(last().sql).toEndWith(
    'RETURNING "users"."id" AS "id", "users"."name" AS "name", "users"."active" AS "active"',
  );
  expect(() =>
    database.users
      .delete()
      .all()
      .returning("nmae" as never),
  ).toThrow('did you mean "name"');
});

test("$batch sends its reads as one statement and settles each read", async () => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    { users, posts, memberships },
    {
      executor: async (query) => {
        calls.push(query);

        // One row, one JSON array per read, in the order the reads started:
        // get() and count() run when they are called, a query when it is awaited.
        return [
          {
            q0: [{ id: 1, name: "Ada", active: true }],
            q1: [{ count: "2" }],
            q2: [{ title: "Notes" }, { title: "Engine" }],
          },
        ];
      },
    },
  );

  const [user, titles, total] = await database.$batch((db) => [
    db.users.get(1),
    db.posts((post) => ({ title: post.title }), { where: { version: 1 } }),
    db.posts.count(),
  ]);

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    sql: `SELECT (SELECT COALESCE(json_agg("__symmetria_row"), '[]'::json) FROM (SELECT "users"."id" AS "id", "users"."name" AS "name", "users"."active" AS "active"
FROM "users" AS "users"
WHERE "users"."id" = $1
LIMIT 2) AS "__symmetria_row") AS "q0", (SELECT COALESCE(json_agg("__symmetria_row"), '[]'::json) FROM (SELECT (COUNT(*))::text AS "count"
FROM "posts" AS "posts") AS "__symmetria_row") AS "q1", (SELECT COALESCE(json_agg("__symmetria_row"), '[]'::json) FROM (SELECT "posts"."title" AS "title"
FROM "posts" AS "posts"
WHERE "posts"."version" = $2) AS "__symmetria_row") AS "q2"`,
    parameters: [1, 1],
  });
  expect(user).toEqual({ id: 1, name: "Ada", active: true });
  expect(titles).toEqual([{ title: "Notes" }, { title: "Engine" }]);
  expect(total).toBe(2);

  // Nothing to read: nothing is sent.
  calls.length = 0;
  expect(await database.$batch(() => ({ note: "none" }))).toEqual({
    note: "none",
  });
  expect(calls).toHaveLength(0);
  // A table cannot be named like the method.
  expect(() =>
    schema({ $batch: table({ id: int.auto }) } as never, {
      executor: async () => [],
    }),
  ).toThrow('reserved table name "$batch"');
});

test("get() and find() read one row by a unique key given as an object", async () => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    { accounts, logs },
    {
      executor: async (query) => {
        calls.push(query);

        return [];
      },
    },
  );
  const where = () => calls.at(-1)!.sql.split("\n").at(-2);

  expect(await database.accounts.find({ email: "ada@x.test" })).toBeNull();
  expect(where()).toBe('WHERE "accounts"."email" = $1');
  expect(calls.at(-1)!.parameters).toEqual(["ada@x.test"]);
  // The same statement as the lookup it shortens.
  await database.accounts.by.email("ada@x.test").maybeOne();
  expect(calls.at(-1)).toEqual(calls.at(-2)!);

  // A composite unique index is found by its columns, in any order.
  await database.accounts.find({ handle: "ada", tenant: "team" });
  expect(where()).toBe(
    'WHERE "accounts"."tenant" = $1 AND "accounts"."handle" = $2',
  );
  expect(calls.at(-1)!.parameters).toEqual(["team", "ada"]);
  await database.accounts.find({ id: 7 });
  expect(where()).toBe('WHERE "accounts"."id" = $1');
  await database.accounts.find({ email: "ada@x.test" }, (account) => ({
    id: account.id,
  }));
  expect(calls.at(-1)!.sql).toStartWith('SELECT "accounts"."id" AS "id"\n');
  // A table without a primary key is read by its unique column.
  await database.logs.find({ line: "started" });
  expect(where()).toBe('WHERE "logs"."line" = $1');

  await expect(
    database.accounts.get({ email: "ada@x.test" }),
  ).rejects.toMatchObject({ code: "SYMMETRIA_RECORD_NOT_FOUND" });
  await expect(
    database.accounts.get({ tenant: "team" } as never),
  ).rejects.toThrow(
    '"tenant" is not the primary key or a unique key of "accounts"; its keys: id, email, [tenant, handle]',
  );
  await expect(
    database.accounts.find({ email: null } as never),
  ).rejects.toThrow('unique key "email" cannot be null or undefined');
});

test("an aggregate has over() like the ranking functions", () => {
  const { database } = recording();
  const method = database
    .posts((post) => ({
      running: sum(post.version).over({
        partitionBy: [post.authorId],
        orderBy: post.id.ascending,
        rows: ["unbounded preceding", "current row"],
      }),
      seen: count().over({ partitionBy: [post.authorId] }),
      latest: maximum(post.title).over(),
    }))
    .toSQL();
  const helper = database
    .posts((post) => ({
      running: over(sum(post.version), {
        partitionBy: [post.authorId],
        orderBy: post.id.ascending,
        rows: ["unbounded preceding", "current row"],
      }),
      seen: over(count(), { partitionBy: [post.authorId] }),
      latest: over(maximum(post.title)),
    }))
    .toSQL();

  expect(method).toEqual(helper);
  expect(method.sql).toContain(
    'SUM("posts"."version") OVER (PARTITION BY "posts"."author_id" ORDER BY "posts"."id" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
  );
  // Without over() it is still the plain aggregate.
  expect(
    database.posts((post) => ({ total: sum(post.version) })).toSQL().sql,
  ).toBe(
    'SELECT SUM("posts"."version")::numeric AS "total"\nFROM "posts" AS "posts"',
  );
});

test("relation quantifiers take a list of predicates like where", () => {
  const { database } = recording();
  const where = (query: { toSQL: () => CompiledQuery }) =>
    query.toSQL().sql.split("WHERE ").slice(1).join("WHERE ");
  const list = database.users((user) => ({ id: user.id }), {
    where: (user) =>
      user.posts.some((post) => [
        post.version.above(1),
        undefined,
        post.title.is("A"),
      ]),
  });

  expect(where(list)).toBe(
    'EXISTS (SELECT 1 AS "present"\nFROM "posts" AS "__symmetria_aggregate_0"\nWHERE "users"."id" = "__symmetria_aggregate_0"."author_id" AND "__symmetria_aggregate_0"."version" > $1 AND "__symmetria_aggregate_0"."title" = $2)',
  );
  // every(): no post fails the conjunction.
  expect(
    where(
      database.users((user) => ({ id: user.id }), {
        where: (user) =>
          user.posts.every((post) => [
            post.version.above(1),
            post.title.is("A"),
          ]),
      }),
    ),
  ).toBe(
    where(
      database.users((user) => ({ id: user.id }), {
        where: (user) =>
          user.posts.every((post) =>
            post.version.above(1).and(post.title.is("A")),
          ),
      }),
    ),
  );
});

test("an ordering by a selected field reuses its text and parameters", () => {
  const { database } = recording();
  const { sql, parameters } = database
    .users(
      (user) => ({
        id: user.id,
        drafts: user.posts({ where: { title: "Draft" } }).count(),
      }),
      {
        orderBy: (user, { selected }) => [selected.drafts.desc, user.id.asc],
      },
    )
    .toSQL();

  // One parameter: PostgreSQL sees one expression and computes it once per row.
  expect(parameters).toEqual(["Draft"]);
  expect(sql.match(/\$1/g)).toHaveLength(2);
  expect(sql).not.toContain("$2");
});

test("aggregates over one relation share one subquery", () => {
  const { database } = recording();
  const card = (options: Record<string, unknown>) =>
    database
      .users(
        (user) => ({
          id: user.id,
          posts: user.posts.count(),
          versions: user.posts.sum.version,
          newest: user.posts.maximum.version,
          oldestId: user.posts.minimum.id,
        }),
        options as never,
      )
      .toSQL().sql;
  const shared =
    'LEFT JOIN LATERAL (SELECT COUNT(*) AS "count", SUM("__symmetria_aggregate_0"."version")::numeric AS "sum", MAX("__symmetria_aggregate_0"."version") AS "maximum", MIN("__symmetria_aggregate_0"."id") AS "minimum"\nFROM "posts" AS "__symmetria_aggregate_0"\nWHERE "users"."id" = "__symmetria_aggregate_0"."author_id") AS "__symmetria_shared_0" ON TRUE';

  // Every row is returned: one subquery per user instead of four.
  expect(card({})).toBe(
    `SELECT "users"."id" AS "id", "__symmetria_shared_0"."count" AS "posts", "__symmetria_shared_0"."sum" AS "versions", "__symmetria_shared_0"."maximum" AS "newest", "__symmetria_shared_0"."minimum" AS "oldestId"\nFROM "users" AS "users"\n${shared}`,
  );
  // A page is cut first; only its rows reach the subquery.
  expect(card({ orderBy: { id: "asc" }, limit: 10 })).toEndWith(
    `ORDER BY "users"."id" ASC\nLIMIT 10) AS "users"\n${shared}\nORDER BY "users"."id" ASC`,
  );
  // Sorting by a total needs it for every row, and a join would compute the
  // other totals for every row too: they stay per-row subqueries.
  expect(
    card({
      orderBy: (
        _user: never,
        { selected }: { selected: { posts: { desc: unknown } } },
      ) => selected.posts.desc,
      limit: 10,
    }),
  ).not.toContain("LATERAL");
  // Different filters are different rows: nothing to share.
  expect(
    database
      .users((user) => ({
        all: user.posts.count(),
        named: user.posts({ where: { title: "A" } }).count(),
      }))
      .toSQL().sql,
  ).not.toContain("LATERAL");
  // Two sums get two column names.
  expect(
    database
      .users((user) => ({
        versions: user.posts.sum.version,
        ids: user.posts.sum.id,
      }))
      .toSQL().sql,
  ).toContain(
    '"__symmetria_shared_0"."sum" AS "versions", "__symmetria_shared_0"."sum_1" AS "ids"',
  );
});

test("get() and find() without a shape bind the key into one compiled statement", async () => {
  const { database, calls } = recording([{ id: 7, name: "Ada", active: true }]);

  await database.users.get(7);
  await database.users.find(8);
  expect(calls.map((call) => call.parameters)).toEqual([[7], [8]]);
  expect(calls[1]!.sql).toBe(calls[0]!.sql);
  // The same statement and errors as the query it shortens.
  await database.users.byId(7).one();
  expect(calls[2]).toEqual(calls[0]!);
  await expect(database.users.get(1.5)).rejects.toThrow(
    await database.users
      .byId(1.5)
      .one()
      .catch((error: Error) => error.message),
  );
  expect(calls).toHaveLength(3);

  // A scoped table keeps its filter, with the value current at the call.
  let tenant = true;
  const scoped = database.$scope({ users: (user) => user.active.is(tenant) });

  await scoped.users.find(7);
  tenant = false;
  await scoped.users.find(7);
  expect(calls.at(-2)!.sql).toContain('"users"."active" = $1');
  expect(calls.at(-2)!.parameters).toEqual([true, 7]);
  expect(calls.at(-1)!.parameters).toEqual([false, 7]);

  // Two rows for one key are an error, none is null or NotFoundError.
  const { database: doubled } = recording([{ id: 1 }, { id: 1 }]);

  await expect(doubled.users.find(1)).rejects.toMatchObject({
    code: "SYMMETRIA_TOO_MANY_ROWS",
  });

  const { database: empty } = recording([]);

  expect(await empty.users.find(1)).toBeNull();
  await expect(empty.users.get(1)).rejects.toMatchObject({
    code: "SYMMETRIA_RECORD_NOT_FOUND",
    table: "users",
  });
});
