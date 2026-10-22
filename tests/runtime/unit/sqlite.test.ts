import { afterAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  junction,
  createDatabase,
  int,
  bigint,
  text,
  bool,
  jsonb,
  numeric,
  timestamptz,
  uuid,
  oneOf,
  count,
  sum,
  rowNumber,
  prepare,
  and,
  defaultValue,
  index,
} from "../../../packages/runtime/src";
import { sqlite, sqliteSchemaSQL } from "../../../packages/runtime/src/driver";

const users = table({
  id: int.auto,
  email: text.unique,
  name: text,
  active: bool.default(true),
  settings: jsonb<{ theme: string; tags: string[] }>().nullable,
  balance: numeric(20, 2).default("0"),
  token: uuid.v4,
  createdAt: timestamptz.now,
});
const posts = table({
  id: int.auto,
  title: text,
  state: oneOf("draft", "published").default("draft"),
  views: bigint.default(0n),
  author: users.onDelete.cascade,
  editor: users.nullable.onDelete.setNull.inverse("edited"),
}).indexes((posts) => ({ byAuthor: index(posts.authorId) }));
const tags = table({ id: int.auto, label: text.unique });
const postTags = junction({
  post: posts.onDelete.cascade,
  tag: tags.onDelete.cascade,
});
const appSchema = schema({ users, posts, tags, postTags });

const driver = sqlite(":memory:");
const database = createDatabase({ schema: appSchema, driver });
driver.createTables(appSchema);

afterAll(async () => {
  await database.$close();
});

describe("sqlite dialect", () => {
  test("DDL maps PostgreSQL types to SQLite storage classes", () => {
    const statements = sqliteSchemaSQL(appSchema.$snapshot());
    expect(
      statements.find((statement) =>
        statement.startsWith('CREATE TABLE "users"'),
      ),
    ).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL');
    expect(statements.join("\n")).toContain(
      `"state" TEXT NOT NULL DEFAULT 'draft' CHECK ("state" IN ('draft', 'published'))`,
    );
    expect(statements.join("\n")).toContain(
      '"author_id" INTEGER NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE',
    );
    expect(statements.join("\n")).toContain(
      'PRIMARY KEY ("post_id", "tag_id")',
    );
    expect(statements.join("\n")).toContain(
      'CREATE INDEX "posts_by_author_idx" ON "posts" ("author_id")',
    );
    expect(statements.join("\n")).toContain(
      "\"created_at\" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    );
  });

  test("placeholders, RETURNING, defaults and codecs round-trip through bun:sqlite", async () => {
    const insert = database.users
      .insert({
        email: "ada@example.test",
        name: "Ada",
        settings: { theme: "dark", tags: ["sql"] },
        balance: "12.50",
      })
      .returning((users) => [
        users.id,
        users.active,
        users.settings,
        users.balance,
        users.token,
        users.createdAt,
      ]);
    expect(insert.toSQL().sql).toContain("?1");
    expect(insert.toSQL().sql).not.toContain("$1");
    const ada = await insert;
    expect(ada.id).toBe(1);
    expect(ada.active).toBe(true);
    expect(ada.settings).toEqual({ theme: "dark", tags: ["sql"] });
    expect(ada.balance).toBe("12.50");
    expect(ada.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(ada.createdAt).toBeInstanceOf(Date);
    const grace = await database.users
      .insert({ email: "grace@example.test", name: "Grace", active: false })
      .returning((users) => [users.id, users.active]);
    expect(grace).toEqual({ id: 2, active: false });
    expect(
      await database.posts.insert([
        { title: "Typed SQL", authorId: ada.id, views: 9007199254740993n },
        { title: "Draft", authorId: grace.id, editorId: ada.id, views: 3 },
        { title: "Defaults", authorId: ada.id, views: defaultValue },
      ]),
    ).toEqual({ affectedRows: 3 });
    await database.tags.insert([{ label: "sql" }, { label: "bun" }]);
    await database.postTags.insert([
      { postId: 1, tagId: 1 },
      { postId: 1, tagId: 2 },
    ]);
    expect(
      await database.posts((posts) => ({
        title: posts.title,
        views: posts.views,
        state: posts.state,
        $orderBy: posts.id.ascending,
      })),
    ).toEqual([
      { title: "Typed SQL", views: 9007199254740993n, state: "draft" },
      { title: "Draft", views: 3n, state: "draft" },
      { title: "Defaults", views: 0n, state: "draft" },
    ]);
  });

  test("predicates, joins, relation paths and collections compile to SQLite JSON functions", async () => {
    const rows = await database.users((users) => ({
      name: users.name,
      active: users.active,
      posts: users.posts((posts) => ({
        title: posts.title,
        views: posts.views,
        editor: posts.editor((editor) => ({ name: editor.name })),
        tags: posts.tags((tags) => ({
          label: tags.label,
          $orderBy: tags.label.ascending,
        })),
        $where: posts.views.atLeast(0),
        $orderBy: posts.id.ascending,
      })),
      total: users.posts.count(),
      hasDrafts: users
        .posts((posts) => ({ $where: posts.state.is.draft }))
        .exists(),
      $where: and(users.email.ilike("%EXAMPLE%"), users.settings.isNot(null)),
      $orderBy: users.id.ascending,
    }));
    expect(rows).toEqual([
      {
        name: "Ada",
        active: true,
        posts: [
          {
            title: "Typed SQL",
            views: 9007199254740993n,
            editor: null,
            tags: [{ label: "bun" }, { label: "sql" }],
          },
          { title: "Defaults", views: 0n, editor: null, tags: [] },
        ],
        total: 2,
        hasDrafts: true,
      },
    ]);
    expect(
      await database.posts((posts) => ({
        title: posts.title,
        author: posts.author.name,
        editor: posts.editor.name,
        theme: posts.author.settings.path("theme"),
        firstTag: posts.author.settings.path("tags", 0),
        $where: posts.editor.name.is("Ada"),
      })),
    ).toEqual([
      {
        title: "Draft",
        author: "Grace",
        editor: "Ada",
        theme: null,
        firstTag: null,
      },
    ]);
    expect(
      await database.users((users) => ({
        theme: users.settings.path("theme").as("theme"),
        $where: users.settings.path("theme").is("dark"),
      })),
    ).toEqual([{ theme: "dark" }]);
    expect(
      await database.posts((posts, { join }) => {
        const author = join(posts.author);

        return {
          title: posts.title,
          email: author.email,
          $where: posts.views.above(5),
        };
      }),
    ).toEqual([{ title: "Typed SQL", email: "ada@example.test" }]);
    expect(
      await database.posts((posts) => ({
        authorId: posts.authorId,
        count: count(),
        sum: sum(posts.views),
        $groupBy: [posts.authorId],
        $having: count().atLeast(2),
      })),
    ).toEqual([{ authorId: 1, count: 2, sum: "9007199254740993" }]);
    expect(
      await database.posts((posts) => ({
        id: posts.id,
        $where: posts.editorId.isDistinctFrom(null),
        $orderBy: posts.id.ascending,
      })),
    ).toEqual([{ id: 2 }]);
    expect(() =>
      database
        .users((users) => ({
          id: users.id,
          $where: users.settings.contains({ tags: ["sql"] }),
        }))
        .toSQL(),
    ).toThrow(/containment.*"sqlite"/);
  });

  test("updates, upserts, deletes and prepared queries use SQLite mutation syntax", async () => {
    expect(
      await database.posts
        .update((posts) => ({
          views: posts.views.plus(1),
          state: "published",
        }))
        .where((posts) => posts.id.is(2))
        .returning((posts) => [posts.views, posts.state]),
    ).toEqual([{ views: 4n, state: "published" }]);
    expect(
      await database.users
        .insert({ email: "ada@example.test", name: "Augusta" })
        .onConflict("email")
        .doUpdate("name")
        .returning((users) => [users.id, users.name]),
    ).toEqual({ id: 1, name: "Augusta" });
    expect(
      await database.tags
        .insert({ label: "sql" })
        .onConflict("label")
        .doNothing()
        .returning((tags) => [tags.id]),
    ).toBeNull();
    const byState = prepare(
      { state: oneOf("draft", "published") },
      (parameters) =>
        database.posts((posts) => ({
          title: posts.title,
          $where: posts.state.is(parameters.state),
          $orderBy: posts.title.ascending,
        })),
    );
    expect(await byState.execute({ state: "published" })).toEqual([
      { title: "Draft" },
    ]);
    expect(
      await database.posts.delete().where((posts) => posts.id.is(3)),
    ).toEqual({ affectedRows: 1 });
    expect(
      await database.posts
        .delete()
        .where((posts) => posts.title.is("missing"))
        .returning((posts) => [posts.id]),
    ).toEqual([]);
    expect(
      await database
        .posts((posts) => ({ id: posts.id, $where: posts.id.is(3) }))
        .first(),
    ).toBeNull();
  });

  test("transactions, savepoints and serialized access share the single connection", async () => {
    await expect(
      database.$transaction(async (transaction) => {
        await transaction.tags.insert({ label: "rollback" });
        await transaction.$transaction(async (savepoint) => {
          await savepoint.tags.insert({ label: "nested" });
        });
        await expect(
          transaction.$transaction(async (savepoint) => {
            await savepoint.tags.insert({ label: "undone" });
            throw new Error("undo nested");
          }),
        ).rejects.toThrow("undo nested");
        expect(
          await transaction.tags((tags) => ({
            label: tags.label,
            $where: tags.label.is("undone"),
          })),
        ).toEqual([]);
        expect(
          await transaction.tags((tags) => ({
            label: tags.label,
            $where: tags.label.is("nested"),
          })),
        ).toHaveLength(1);
        throw new Error("rollback outer");
      }),
    ).rejects.toThrow("rollback outer");
    expect(
      await database.tags((tags) => ({
        label: tags.label,
        $where: tags.label.in(["rollback", "nested"]),
      })),
    ).toEqual([]);
    const [inside, outside] = await Promise.all([
      database.$transaction(async (transaction) => {
        await transaction.tags.insert({ label: "committed" });

        return transaction
          .tags((tags) => ({
            label: tags.label,
            $where: tags.label.is("committed"),
          }))
          .one();
      }),
      database
        .tags((tags) => ({
          label: tags.label,
          $where: tags.label.is("committed"),
        }))
        .maybeOne(),
    ]);
    expect(inside).toEqual({ label: "committed" });
    expect(outside).toEqual({ label: "committed" });
    await expect(
      database.$transaction(
        async (transaction) => {
          await transaction.tags.insert({ label: "readonly" });
        },
        { readOnly: true },
      ),
    ).rejects.toThrow();
    expect(await database.tags.insert({ label: "writable" })).toEqual({
      affectedRows: 1,
    });
  });

  test("pagination, window functions, CTEs and inspection work on SQLite", async () => {
    const page = await database
      .posts((posts) => ({
        id: posts.id,
        title: posts.title,
        $orderBy: posts.id.ascending,
      }))
      .page({ size: 1 });
    expect(page.items).toEqual([{ id: 1, title: "Typed SQL" }]);
    expect(page.nextCursor).not.toBeNull();
    const next = await database
      .posts((posts) => ({
        id: posts.id,
        title: posts.title,
        $orderBy: posts.id.ascending,
      }))
      .page({ size: 1, after: page.nextCursor });
    expect(next.items).toEqual([{ id: 2, title: "Draft" }]);
    const ranked = database
      .posts((posts) => ({
        id: posts.id,
        position: rowNumber().over({ orderBy: posts.views.descending }),
      }))
      .cte("ranked");
    expect(
      await ranked((ranked) => ({
        id: ranked.id,
        position: ranked.position,
        $orderBy: ranked.position.ascending,
      })),
    ).toEqual([
      { id: 1, position: 1 },
      { id: 2, position: 2 },
    ]);
    const inspection = await database
      .posts((posts) => ({ id: posts.id }))
      .inspect({ interactive: false, explain: true, execute: true });
    expect(inspection.explanation?.plan.length).toBeGreaterThan(0);
    expect(inspection.results?.rows).toHaveLength(2);
    await expect(
      database
        .posts((posts) => ({ id: posts.id }))
        .inspect({ interactive: false, explain: "analyze" }),
    ).rejects.toThrow(/PostgreSQL only/);
  });

  test("scopes and relation paths compile for SQLite", async () => {
    const grace = database.$scope({ posts: (posts) => posts.authorId.is(2) });
    expect(await grace.posts((posts) => ({ id: posts.id }))).toEqual([
      { id: 2 },
    ]);
    expect(
      await grace.users((users) => ({
        name: users.name,
        total: users.posts.count(),
        $orderBy: users.id.ascending,
      })),
    ).toEqual([
      { name: "Augusta", total: 0 },
      { name: "Grace", total: 1 },
    ]);
    expect(
      await database.posts
        .update({ state: "draft" })
        .where((posts) => posts.author.email.is("grace@example.test"))
        .returning((posts) => [posts.id, posts.state]),
    ).toEqual([{ id: 2, state: "draft" }]);
    expect(
      await database.users
        .delete()
        .where((users) =>
          users.posts.some((posts) => posts.title.is("nothing")),
        ),
    ).toEqual({ affectedRows: 0 });
  });

  test("arrays and search fall back to JSON and LIKE in SQLite", async () => {
    const driver = sqlite(":memory:");
    const local = createDatabase({
      schema: schema({
        items: { id: int.auto, title: text, tags: text.array },
      }),
      driver,
    });
    driver.createTables(local);
    await local.items.insert([
      { title: "Bun loves SQL", tags: ["bun", "sql"] },
      { title: "Postgres only", tags: [] },
    ]);
    expect(
      await local.items((items) => ({
        id: items.id,
        tags: items.tags,
        count: items.tags.length().as("count"),
        $orderBy: items.id.ascending,
      })),
    ).toEqual([
      { id: 1, tags: ["bun", "sql"], count: 2 },
      { id: 2, tags: [], count: 0 },
    ]);
    expect(
      await local.items((items) => ({
        id: items.id,
        $where: items.tags.has("sql"),
      })),
    ).toEqual([{ id: 1 }]);
    expect(
      await local.items((items) => ({
        id: items.id,
        $where: items.title.search("SQL bun"),
      })),
    ).toEqual([{ id: 1 }]);
    expect(
      await local.items((items) => ({
        id: items.id,
        $where: items.title.search(""),
      })),
    ).toEqual([]);
    expect(() =>
      local
        .items((items) => ({
          id: items.id,
          $where: items.tags.contains(["sql"]),
        }))
        .toSQL(),
    ).toThrow(/containment.*"sqlite"/);
    expect(() =>
      local
        .items((items) => ({ searchRank: items.title.searchRank("sql") }))
        .toSQL(),
    ).toThrow(/searchRank.*"sqlite"/);
    await local.$close();
  });

  test("foreign key actions run through PRAGMA foreign_keys", async () => {
    expect(
      await database.postTags((postTags) => ({ postId: postTags.postId })),
    ).toHaveLength(2);
    expect(
      await database.users.delete().where((users) => users.id.is(1)),
    ).toEqual({
      affectedRows: 1,
    });
    expect(
      await database.posts((posts) => ({
        id: posts.id,
        editorId: posts.editorId,
      })),
    ).toEqual([{ id: 2, editorId: null }]);
    expect(
      await database.postTags((postTags) => ({ postId: postTags.postId })),
    ).toEqual([]);
    await expect(
      database.posts.insert({ title: "orphan", authorId: 42 }).execute(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
