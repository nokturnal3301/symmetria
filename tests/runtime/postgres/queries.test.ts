import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  junction,
  schema,
  int,
  text,
  bigint,
  bool,
  numeric,
  jsonb,
  timestamptz,
  oneOf,
  customType,
  count,
  sum,
  average,
  minimum,
  maximum,
  exists,
  sql,
  coalesce,
} from "../../../packages/runtime/src";
import { postgres } from "../../../packages/runtime/src/driver";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL through Bun SQL", () => {
  const driver = postgres({
    url: databaseUrl ?? "postgres://localhost/postgres",
    max: 1,
  });
  const namespace = `symmetria_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let queryCount = 0;
  const model = schema(
    {
      users: {
        id: int.auto,
        name: text.unique,
        balance: numeric(30, 2).default("0"),
        visits: int.default(0),
        active: bool.default(true),
        role: oneOf("admin", "member").default("member"),
      },
      profiles: ({ users }) => ({
        id: int.auto,
        user: users.unique.inverse("profile"),
        bio: text.nullable,
      }),
      posts: ({ users }) => ({
        id: int.auto,
        title: text,
        author: users,
        editor: users.nullable.inverse("edited"),
        views: bigint.default(0n),
        metadata: jsonb<{ tags: string[] }>().nullable,
        createdAt: timestamptz.now,
      }),
      tags: {
        id: int.auto,
        name: text.unique,
      },
      postTags: ({ posts, tags }) => junction({ post: posts, tag: tags }),
      categories: ({ categories }) => ({
        id: int.auto,
        name: text,
        parent: categories.nullable.inverse("children"),
      }),
      wallets: {
        id: int.auto,
        amount: customType<{ cents: bigint }>("bigint", {
          encode: (value) => value.cents.toString(),
          decode: (value) => ({ cents: BigInt(value as string | bigint) }),
        }),
      },
    },
    {
      executor: async (query) => {
        queryCount += 1;

        return driver.execute(query);
      },
    },
  );

  const run = async (statement: string) =>
    driver.execute({ sql: statement, parameters: [] });

  beforeAll(async () => {
    await run(`CREATE SCHEMA "${namespace}"`);
    await run(`SET search_path TO "${namespace}"`);

    for (const statement of [
      "CREATE TYPE user_role AS ENUM ('admin', 'member')",
      "CREATE TABLE users (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text UNIQUE NOT NULL, balance numeric(30,2) NOT NULL DEFAULT 0, visits integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, role user_role NOT NULL DEFAULT 'member')",
      "CREATE TABLE profiles (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id integer UNIQUE NOT NULL REFERENCES users(id), bio text)",
      "CREATE TABLE posts (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text NOT NULL, author_id integer NOT NULL REFERENCES users(id), editor_id integer REFERENCES users(id), views bigint NOT NULL DEFAULT 0, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now())",
      "CREATE TABLE tags (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text UNIQUE NOT NULL)",
      "CREATE TABLE post_tags (post_id integer REFERENCES posts(id), tag_id integer REFERENCES tags(id), PRIMARY KEY (post_id, tag_id))",
      "CREATE TABLE categories (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, parent_id integer REFERENCES categories(id))",
      "CREATE TABLE wallets (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, amount bigint NOT NULL)",
    ]) {
      await run(statement);
    }
  });

  beforeEach(async () => {
    await run(
      "TRUNCATE users, profiles, posts, tags, post_tags, categories, wallets RESTART IDENTITY CASCADE",
    );
    await model.users
      .insert([
        { name: "Ada", role: "admin", balance: "12345678901234567890.12" },
        { name: "Grace" },
        { name: "Nobody" },
      ])
      .execute();
    await model.posts
      .insert([
        {
          title: "SQL first",
          authorId: 3,
          editorId: 2,
          views: 9007199254740993n,
          metadata: { tags: ["sql"] },
          createdAt: new Date("2026-01-01T12:00:00.000Z"),
        },
        { title: "TypeScript", authorId: 1, views: 5n },
      ])
      .execute();
    await model.profiles.insert({ userId: 1, bio: "Engineer" }).execute();
    await model.tags
      .insert([{ name: "sql" }, { name: "typescript" }])
      .execute();
    await model.postTags
      .insert([
        { postId: 1, tagId: 1 },
        { postId: 1, tagId: 2 },
      ])
      .execute();
    queryCount = 0;
  });

  afterAll(async () => {
    try {
      await run(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await driver.close();
    }
  });

  test("INSERT/SELECT round-trip bigint, decimal, JSON, enum, timestamp and nullable joins", async () => {
    const rows = await model
      .posts((posts, { leftJoin }) => {
        const author = leftJoin(posts.author);
        const editor = leftJoin(posts.editor);

        return {
          title: posts.title,
          views: posts.views,
          metadata: posts.metadata,
          createdAt: posts.createdAt,
          balance: author.balance,
          role: author.role,
          editorName: editor.name,
          $orderBy: posts.id.ascending,
        };
      })
      .execute();
    expect(rows[0]).toEqual({
      title: "SQL first",
      views: 9007199254740993n,
      metadata: { tags: ["sql"] },
      createdAt: new Date("2026-01-01T12:00:00.000Z"),
      balance: "0.00",
      role: "member",
      editorName: "Grace",
    });
    expect(rows[1]?.editorName).toBeNull();
    expect(rows[1]?.metadata).toBeNull();
    expect(
      await model.wallets
        .insert({ amount: { cents: 9007199254740993n } })
        .returning((wallets) => [wallets.amount])
        .execute(),
    ).toEqual({ amount: { cents: 9007199254740993n } });
  });

  test("terminal JSON and intermediate JSONB preserve nested codecs, empty collections and optional rows", async () => {
    const query = model.users((users) => ({
      id: users.id,
      details: { name: users.name, balance: users.balance },
      profile: users.profile((profile) => ({ bio: profile.bio })),
      posts: users.posts((posts) => ({
        title: posts.title,
        views: posts.views,
        createdAt: posts.createdAt,
        metadata: posts.metadata,
        tags: posts.tags((tags) => ({
          name: tags.name,
          $orderBy: tags.id.ascending,
        })),
        $orderBy: posts.id.ascending,
      })),
      $orderBy: users.id.ascending,
    }));
    const rows = await query.execute();
    expect(rows[0]?.details.balance).toBe("12345678901234567890.12");
    expect(rows[0]?.profile).toEqual({ bio: "Engineer" });
    expect(rows[0]?.posts[0]?.metadata).toBeNull();
    expect(rows[1]?.posts).toEqual([]);
    expect(rows[1]?.profile).toBeNull();
    expect(rows[2]?.posts[0]).toEqual({
      title: "SQL first",
      views: 9007199254740993n,
      createdAt: new Date("2026-01-01T12:00:00.000Z"),
      metadata: { tags: ["sql"] },
      tags: [{ name: "sql" }, { name: "typescript" }],
    });
    expect(await query.prepare().execute()).toEqual(rows);
    expect(await query((users) => ({ $distinct: true })).execute()).toEqual(
      rows,
    );
    expect(
      await query((users) => ({
        $groupBy: [users.id],
        $having: count().above(0),
      })).execute(),
    ).toEqual(rows);
    expect(
      await model.wallets
        .insert({ amount: { cents: 9007199254740993n } })
        .returning((wallets) => ({ details: { amount: wallets.amount } }))
        .execute(),
    ).toEqual({ details: { amount: { cents: 9007199254740993n } } });
  });

  test("derived and CTE JSON projections remain usable by JSONB operators", async () => {
    const selection = model.users((users) => ({
      name: users.name,
      posts: users.posts((posts) => ({
        title: posts.title,
        views: posts.views,
        $orderBy: posts.id.ascending,
      })),
    }));

    for (const source of [selection.as("authors"), selection.cte("authors")]) {
      const query = source((authors) => ({
        name: authors.name,
        posts: authors.posts,
        $where: authors.posts.path(0, "title").is("SQL first"),
      }));
      expect(await query.execute()).toEqual([
        {
          name: "Nobody",
          posts: [{ title: "SQL first", views: 9007199254740993n }],
        },
      ]);
    }
  });

  test("UPDATE, DELETE, UPSERT and RETURNING report actual affected rows", async () => {
    expect(
      await model.users
        .update((users) => ({ visits: users.visits.plus(2) }))
        .where((users) => users.name.is("Ada"))
        .execute(),
    ).toEqual({ affectedRows: 1 });
    expect(
      await model.users
        .insert({ name: "Ada" })
        .onConflict("name")
        .doUpdate((users, excluded) => ({
          name: excluded.name,
          visits: users.visits.plus(3),
        }))
        .returning((users) => [users.visits])
        .execute(),
    ).toEqual({ visits: 5 });
    expect(
      await model.users
        .insert({ name: "Ada" })
        .onConflict()
        .doNothing()
        .execute(),
    ).toEqual({ affectedRows: 0 });
    expect(
      await model.posts
        .delete()
        .where((posts) => posts.id.is(2))
        .returning((posts) => [posts.title])
        .execute(),
    ).toEqual([{ title: "TypeScript" }]);
    expect(
      await model.users
        .delete()
        .where((users) => users.name.is("missing"))
        .execute(),
    ).toEqual({ affectedRows: 0 });
    await model.users.insert({ name: "Temporary" }).execute();
    expect(
      await model.users
        .delete()
        .where((users) => users.name.is("Temporary"))
        .execute(),
    ).toEqual({ affectedRows: 1 });
    await expect(
      model.users.insert({ name: "Ada" }).execute(),
    ).rejects.toThrow();
  });

  test("JSON objects, arrays and scalar values round-trip without double encoding", async () => {
    const partialModel = schema(
      { posts: { id: int.auto, metadata: jsonb<unknown>().nullable } },
      { driver },
    );

    for (const metadata of [
      { key: "value" },
      ["one", 2],
      "text",
      42,
      true,
      null,
    ]) {
      const rows = await partialModel.posts
        .update({ metadata })
        .where((posts) => posts.id.is(1))
        .returning((posts) => [posts.metadata])
        .execute();
      expect(rows).toEqual([{ metadata }]);
    }
  });

  test("GROUP BY, HAVING and aggregate decoding match PostgreSQL semantics", async () => {
    await model.posts
      .insert({ title: "Another article", authorId: 1, views: 5n })
      .execute();
    const rows = await model
      .posts((posts, { innerJoin }) => {
        const author = innerJoin(posts.author);

        return {
          name: author.name,
          count: count(),
          sum: sum(posts.views),
          average: average(posts.views),
          minimum: minimum(posts.views),
          maximum: maximum(posts.views),
          $groupBy: [author.name],
          $having: count().above(1),
        };
      })
      .execute();
    expect(rows).toEqual([
      {
        name: "Ada",
        count: 2,
        sum: "10",
        average: expect.stringMatching(/^5\.0+$/),
        minimum: 5n,
        maximum: 5n,
      },
    ]);
    expect(
      await model
        .posts((posts) => ({
          count: count(),
          sum: sum(posts.views),
          $where: posts.id.in([]),
        }))
        .execute(),
    ).toEqual([{ count: 0, sum: null }]);
  });

  test("explicit and derived joins execute with aliases and independent parameters", async () => {
    const recent = model
      .posts((posts) => ({
        authorId: posts.authorId,
        $where: posts.views.above(10n),
      }))
      .as("recent");
    expect(
      await model
        .users((users, { innerJoin }) => {
          const recentRow = innerJoin(recent, (recentRow) =>
            users.id.is(recentRow.authorId),
          );

          return {
            greeting: sql<string>`concat(${"Hello "}::text, ${users.name})`.as(
              "greeting",
            ),
          };
        })
        .execute(),
    ).toEqual([{ greeting: "Hello Nobody" }]);
    expect(
      await model
        .posts((posts, { leftJoin }) => {
          const reviewer = leftJoin(model.users.as("reviewer"), (reviewer) =>
            posts.editorId.is(reviewer.id),
          );

          return {
            title: posts.title,
            reviewer: coalesce(reviewer.name, "none").as("reviewer"),
            $orderBy: posts.id.ascending,
          };
        })
        .execute(),
    ).toEqual([
      { title: "SQL first", reviewer: "Grace" },
      { title: "TypeScript", reviewer: "none" },
    ]);
    expect(
      await model
        .users((users, { crossJoin }) => {
          const tags = crossJoin(model.tags);

          return { name: users.name, tagName: tags.name };
        })
        .execute(),
    ).toHaveLength(6);
  });

  test("correlated EXISTS, scalar subqueries and IN filter real rows", async () => {
    const rows = await model
      .users((users) => ({
        name: users.name,
        $where: [
          exists(
            model.posts((posts) => ({
              id: posts.id,
              $where: [posts.authorId.is(users.id), posts.title.ilike("%sql%")],
            })),
          ),
          users.id.in(model.posts((posts) => ({ authorId: posts.authorId }))),
        ],
      }))
      .execute();
    expect(rows).toEqual([{ name: "Nobody" }]);
    const highest = model
      .posts((posts) => ({ maximum: maximum(posts.views) }))
      .scalar();
    expect(
      await model
        .posts((posts) => ({
          title: posts.title,
          $where: posts.views.is(highest),
        }))
        .execute(),
    ).toEqual([{ title: "SQL first" }]);
    expect(
      await model
        .users((users) => ({
          name: users.name,
          $where: users.name.is("'; DROP TABLE users; --"),
        }))
        .execute(),
    ).toEqual([]);
  });

  test("findMany loads nested 1:1, 1:M, M:N and optional relations in one statement", async () => {
    const rows = await model
      .users((users) => ({
        id: users.id,
        active: users.active,
        name: users.name,
        balance: users.balance,
        visits: users.visits,
        role: users.role,
        profile: users.profile((profile) => ({
          id: profile.id,
          bio: profile.bio,
          userId: profile.userId,
        })),
        posts: users.posts((posts) => ({
          id: posts.id,
          title: posts.title,
          createdAt: posts.createdAt,
          views: posts.views,
          metadata: posts.metadata,
          authorId: posts.authorId,
          editorId: posts.editorId,
          tags: posts.tags((tags) => ({ id: tags.id, name: tags.name })),
          editor: posts.editor((editor) => ({
            id: editor.id,
            active: editor.active,
            name: editor.name,
            balance: editor.balance,
            visits: editor.visits,
            role: editor.role,
          })),
        })),
        $where: (({ users }) => users.id.isNot(2))({ users }),
        $orderBy: (({ users }) => users.id.ascending)({ users }),
        $limit: 2,
      }))
      .execute();
    expect(queryCount).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.profile?.bio).toBe("Engineer");
    expect(rows[0]?.posts).toHaveLength(1);
    const article = rows[1]?.posts.find((post) => post.title === "SQL first");
    expect(article?.views).toBe(9007199254740993n);
    expect(article?.createdAt).toEqual(new Date("2026-01-01T12:00:00.000Z"));
    expect(article?.editor?.name).toBe("Grace");
    expect(article?.tags.map((tag) => tag.name).sort()).toEqual([
      "sql",
      "typescript",
    ]);
    expect(rows[1]?.profile).toBeNull();
    const empty = await model
      .users((users) => ({
        id: users.id,
        active: users.active,
        name: users.name,
        balance: users.balance,
        visits: users.visits,
        role: users.role,
        posts: users.posts((posts) => ({
          id: posts.id,
          title: posts.title,
          createdAt: posts.createdAt,
          views: posts.views,
          metadata: posts.metadata,
          authorId: posts.authorId,
          editorId: posts.editorId,
        })),
        $where: (({ users }) => users.name.is("Grace"))({ users }),
      }))
      .execute();
    expect(empty[0]?.posts).toEqual([]);
    const reversed = await model
      .tags((tags) => ({
        id: tags.id,
        name: tags.name,
        posts: tags.posts((posts) => ({
          id: posts.id,
          title: posts.title,
          createdAt: posts.createdAt,
          views: posts.views,
          metadata: posts.metadata,
          authorId: posts.authorId,
          editorId: posts.editorId,
          author: posts.author((author) => ({
            id: author.id,
            active: author.active,
            name: author.name,
            balance: author.balance,
            visits: author.visits,
            role: author.role,
          })),
        })),
        $limit: 1,
      }))
      .execute();
    expect(reversed[0]?.posts[0]?.author?.balance).toBe("0.00");
  });

  test("self references and nested relation joins maintain direction", async () => {
    await model.categories.insert({ name: "root" }).execute();
    await model.categories.insert({ name: "leaf", parentId: 1 }).execute();
    const rows = await model
      .categories((categories) => ({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        children: categories.children((children) => ({
          id: children.id,
          name: children.name,
          parentId: children.parentId,
          parent: children.parent((parent) => ({
            id: parent.id,
            name: parent.name,
            parentId: parent.parentId,
          })),
        })),
        $where: (({ categories }) => categories.parentId.is(null))({
          categories,
        }),
      }))
      .execute();
    expect(rows[0]?.children[0]?.parent?.name).toBe("root");
    const joined = await model
      .posts((posts, { innerJoin }) => {
        const author = innerJoin(posts.author);
        const authorProfile = innerJoin(author.profile.as("authorProfile"));

        return { title: posts.title, bio: authorProfile.bio, $limit: 1 };
      })
      .execute();
    expect(joined[0]?.bio).toBe("Engineer");
  });

  test("immutable branches, pagination and NULL ordering affect only the derived query", async () => {
    const base = model.posts((posts, { leftJoin }) => {
      const editor = leftJoin(posts.editor);

      return { title: posts.title, editorName: editor.name };
    });
    expect(
      await base((posts) => ({
        $orderBy: posts.editor.name.ascending.nullsFirst,
        $limit: 1,
      })).first(),
    ).toEqual({ title: "TypeScript", editorName: null });
    expect(await base((posts) => ({ $limit: 0 })).first()).toBeNull();
    expect(await base.execute()).toHaveLength(2);
    expect(
      await base((posts) => ({
        $orderBy: posts.id.ascending,
        $offset: 1,
      })).execute(),
    ).toEqual([{ title: "TypeScript", editorName: null }]);
  });
});
