import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  maybe,
  many,
  self,
  int,
  text,
  timestamptz,
  ForeignKeyViolation,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const users = table({
  id: int.auto,
  name: text,
  posts: many,
  edited: many.setNull,
  profile: one.cascade,
  comments: many.cascade,
});
const tags = table({ id: int.auto, label: text.unique, posts: many });
const posts = table({
  id: int.auto,
  title: text,
  author: one(users.posts),
  editor: maybe(users.edited),
  tags: many(tags.posts).with({ addedAt: timestamptz.now }),
});
const profiles = table({ id: int.auto, bio: text, user: one(users.profile) });
const comments = table({
  id: int.auto,
  body: text,
  post: one(posts).cascade,
  author: one(users.comments),
  parent: maybe(self.children).cascade,
  children: many,
});
const model = schema({ users, tags, posts, profiles, comments });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("slot relations on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_slots",
      max: 2,
    });
    database = isolated.database;
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("the tables, keys and indexes exist as declared", async () => {
    const result = await isolated.driver.execute({
      sql: `SELECT c.relname AS name
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'i')
            ORDER BY 1`,
      parameters: [],
    });
    const names = (Array.isArray(result) ? result : result.rows).map(
      (row) => row.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "posts_tags",
        "posts_tags_pkey",
        "posts_tags_tags_id_idx",
        "posts_author_id_idx",
        "posts_editor_id_idx",
        "comments_parent_id_idx",
        "profiles_user_id_key",
      ]),
    );
  });

  test("nested writes and reads in both directions", async () => {
    const ada = await database.users
      .insert({
        name: "Ada",
        profile: { create: { bio: "Countess" } },
        posts: {
          create: [
            {
              title: "Notes",
              tags: { connectOrCreate: [{ label: "math" }, { label: "sql" }] },
            },
            { title: "Engine", tags: { connectOrCreate: [{ label: "math" }] } },
          ],
        },
      })
      .returning("id");
    const bob = await database.users.insert({ name: "Bob" }).returning("id");

    await database.posts.byId(1).update({ editorId: bob.id });
    await database.comments.insert({
      body: "First",
      post: { connect: 1 },
      author: { connect: bob.id },
      children: {
        create: [{ body: "Reply", postId: 1, authorId: ada.id }],
      },
    });

    expect(
      await database.users(
        (user) => ({
          name: user.name,
          profile: user.profile((profile) => ({ bio: profile.bio })),
          posts: user.posts(
            (post) => ({
              title: post.title,
              editor: post.editor.name,
              tags: post.tags((tag) => ({ label: tag.label }), {
                orderBy: { label: "asc" },
              }),
            }),
            { orderBy: { id: "asc" } },
          ),
          edited: user.edited.count(),
          comments: user.comments.count(),
        }),
        { orderBy: { id: "asc" } },
      ),
    ).toEqual([
      {
        name: "Ada",
        profile: { bio: "Countess" },
        posts: [
          {
            title: "Notes",
            editor: "Bob",
            tags: [{ label: "math" }, { label: "sql" }],
          },
          { title: "Engine", editor: null, tags: [{ label: "math" }] },
        ],
        edited: 0,
        comments: 1,
      },
      { name: "Bob", profile: null, posts: [], edited: 1, comments: 1 },
    ]);
    expect(
      await database.tags(
        (tag) => ({
          label: tag.label,
          posts: tag.posts((post) => ({ title: post.title }), {
            orderBy: { id: "asc" },
          }),
        }),
        { orderBy: { label: "asc" } },
      ),
    ).toEqual([
      { label: "math", posts: [{ title: "Notes" }, { title: "Engine" }] },
      { label: "sql", posts: [{ title: "Notes" }] },
    ]);
    expect(
      await database.comments(
        (comment) => ({
          body: comment.body,
          parent: comment.parent.body,
          replies: comment.children.count(),
        }),
        { orderBy: { id: "asc" } },
      ),
    ).toEqual([
      { body: "First", parent: null, replies: 1 },
      { body: "Reply", parent: "First", replies: 0 },
    ]);
    // The junction is a table of its own, with its columns.
    expect(
      (await database.postsTags((row) => ({ at: row.addedAt }))).every(
        (row) => row.at instanceof Date,
      ),
    ).toBe(true);
  });

  test("the parent's slot decides what a delete does", async () => {
    // posts: many (restrict): Ada still has posts.
    await expect(
      database.users.byId(1).delete().execute(),
    ).rejects.toBeInstanceOf(ForeignKeyViolation);

    // edited: many.setNull and comments: many.cascade for Bob.
    await database.users.byId(2).delete();
    expect(
      await database.posts.get(1, (post) => ({ e: post.editorId })),
    ).toEqual({ e: null });
    // Bob's comment went, and its reply with it (parent: maybe(self.children).cascade).
    expect(await database.comments.count()).toBe(0);

    // Deleting a post removes its links, not the tags.
    await database.posts.delete({ where: { id: 2 } });
    expect(await database.postsTags.count()).toBe(2);
    expect(await database.tags.count()).toBe(2);
    // profile: one.cascade.
    await database.posts.delete().all();
    await database.users.byId(1).delete();
    expect(await database.profiles.count()).toBe(0);
  });
});
