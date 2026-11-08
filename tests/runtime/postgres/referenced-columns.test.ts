import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  junction,
  int,
  text,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const users = table({ id: int.auto, name: text, email: text.unique });
const tags = table({ id: int.auto, slug: text.unique });
const posts = table({
  id: int.auto,
  title: text,
  author: users.by("email").column("author_email"),
  owner: users.column("created_by").nullable.inverse("owned"),
});
const postTags = junction({
  post: posts,
  tag: tags.by("slug").column("tag_slug"),
});
const model = schema({ users, tags, posts, postTags });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "by() and column() references on PostgreSQL",
  () => {
    let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
    let database: typeof isolated.database;

    beforeAll(async () => {
      isolated = await testDatabase({
        url: databaseUrl!,
        schema: model,
        prefix: "symmetria_referenced",
        max: 1,
      });
      database = isolated.database;
    });

    afterAll(async () => {
      await isolated?.close();
    });

    test("the database enforces the foreign key on the referenced column", async () => {
      await database.users.insert({ name: "Ada", email: "ada@example.com" });
      await database.posts.insert({
        title: "Typed",
        authorId: "ada@example.com",
        ownerId: 1,
      });

      await expect(
        database.posts
          .insert({ title: "Orphan", authorId: "nobody@example.com" })
          .execute(),
      ).rejects.toThrow(/posts_author_email_fkey/);
      expect(
        await database.posts((post) => ({
          title: post.title,
          author: post.author.name,
          owner: post.owner.email,
        })),
      ).toEqual([{ title: "Typed", author: "Ada", owner: "ada@example.com" }]);
    });

    test("nested inserts connect and create through the referenced column", async () => {
      const created = await database.posts
        .insert({
          title: "Connected",
          author: { connect: "ada@example.com" },
          owner: { connect: { id: 1 } },
        })
        .returning((post) => ({
          authorId: post.authorId,
          ownerId: post.ownerId,
        }));
      expect(created).toEqual({ authorId: "ada@example.com", ownerId: 1 });

      const fresh = await database.posts
        .insert({
          title: "Fresh author",
          author: { create: { name: "Grace", email: "grace@example.com" } },
        })
        .returning((post) => ({ authorId: post.authorId }));
      expect(fresh).toEqual({ authorId: "grace@example.com" });

      const reverse = await database.users
        .insert({
          name: "Linus",
          email: "linus@example.com",
          posts: { create: [{ title: "Reverse" }] },
          owned: { create: [{ title: "Owned", authorId: "ada@example.com" }] },
        })
        .returning((user) => ({ id: user.id }));
      expect(
        await database.posts(
          (post) => ({
            title: post.title,
            authorId: post.authorId,
            ownerId: post.ownerId,
          }),
          {
            where: (post) => post.title.in(["Reverse", "Owned"]),
            orderBy: (post) => post.title.ascending,
          },
        ),
      ).toEqual([
        { title: "Owned", authorId: "ada@example.com", ownerId: reverse.id },
        { title: "Reverse", authorId: "linus@example.com", ownerId: null },
      ]);

      await expect(
        database.posts
          .insert({
            title: "Missing",
            author: { connect: "missing@example.com" },
          })
          .execute(),
      ).rejects.toThrow(/expected one existing row/);
    });

    test("junction references through by() columns connect by the referenced value", async () => {
      await database.tags.insert([{ slug: "sql" }, { slug: "types" }]);
      const post = await database.posts
        .insert({
          title: "Tagged",
          authorId: "ada@example.com",
          tags: { connect: ["sql"], create: [{ slug: "bun" }] },
        })
        .returning((post) => ({ id: post.id }));

      expect(
        await database.postTags(
          (link) => ({ post: link.postId, tag: link.tagId }),
          {
            where: (link) => link.postId.is(post.id),
            orderBy: (link) => link.tagId.ascending,
          },
        ),
      ).toEqual([
        { post: post.id, tag: "bun" },
        { post: post.id, tag: "sql" },
      ]);
      expect(
        await database.tags(
          (tag) => ({ slug: tag.slug, posts: tag.posts.count() }),
          {
            orderBy: (tag) => tag.slug.ascending,
          },
        ),
      ).toEqual([
        { slug: "bun", posts: 1 },
        { slug: "sql", posts: 1 },
        { slug: "types", posts: 0 },
      ]);
    });
  },
);
