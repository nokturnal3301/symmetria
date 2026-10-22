import assert from "node:assert/strict";
import type { Transaction } from "symmetria";
import { testDatabase } from "symmetria-kit/testing";
import { appSchema } from "../schema";

type FeedPost = {
  slug: string;
  title: string;
  author: { email: string; name: string };
  views: string;
  tags: readonly string[];
};

const chunks = <Value>(values: readonly Value[]) =>
  Array.from({ length: Math.ceil(values.length / 200) }, (_, index) =>
    values.slice(index * 200, (index + 1) * 200),
  );

/** Resolve natural keys once, then write bounded batches in the caller's transaction. */
const importPosts = async (
  transaction: Transaction<typeof appSchema>,
  input: readonly FeedPost[],
) => {
  // A PostgreSQL upsert cannot update the same target row twice in one statement.
  const posts = [...new Map(input.map((post) => [post.slug, post])).values()];

  if (!posts.length) {
    return { posts: 0, linksAdded: 0 };
  }

  const authors = [
    ...new Map(posts.map((post) => [post.author.email, post.author])).values(),
  ];
  const authorIds = new Map<string, number>();

  for (const batch of chunks(authors)) {
    const rows = await transaction.users
      .insert(batch)
      .onConflict("email")
      .doUpdate("name")
      .returning((user) => ({ id: user.id, email: user.email }));

    for (const row of rows) {
      authorIds.set(row.email, row.id);
    }
  }

  const labels = [...new Set(posts.flatMap((post) => [...post.tags]))];
  const tagIds = new Map<string, number>();

  for (const batch of chunks(labels)) {
    await transaction.tags
      .insert(batch.map((label) => ({ label })))
      .onConflict("label")
      .doNothing();

    // DO NOTHING RETURNING omits existing tags; load all requested keys instead.
    const rows = await transaction.tags((tag) => ({
      id: tag.id,
      label: tag.label,
      $where: tag.label.in(batch),
    }));

    for (const row of rows) {
      tagIds.set(row.label, row.id);
    }
  }

  const postIds = new Map<string, number>();

  for (const batch of chunks(posts)) {
    const rows = await transaction.posts
      .insert(
        batch.map((post) => ({
          slug: post.slug,
          title: post.title,
          authorId: authorIds.get(post.author.email)!,
          views: BigInt(post.views),
          state: "published" as const,
        })),
      )
      .onConflict("slug")
      .doUpdate("title", "authorId", "views", "state")
      .returning((post) => ({ id: post.id, slug: post.slug }));

    for (const row of rows) {
      postIds.set(row.slug, row.id);
    }
  }

  const links = posts.flatMap((post) =>
    [...new Set(post.tags)].map((label) => ({
      postId: postIds.get(post.slug)!,
      tagId: tagIds.get(label)!,
    })),
  );
  let linksAdded = 0;

  for (const batch of chunks(links)) {
    const result = await transaction.postTags
      .insert(batch)
      .onConflict("postId", "tagId")
      .doNothing();
    linksAdded += result.affectedRows;
  }

  return { posts: postIds.size, linksAdded };
};

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("Set DATABASE_URL to run the isolated bulk import demo.");
}

const isolated = await testDatabase({
  url,
  schema: appSchema,
  prefix: "symmetria_import",
});
const database = isolated.database;

try {
  const feed: FeedPost[] = Array.from({ length: 500 }, (_, index) => ({
    slug: `source-${index}`,
    title: `Imported post ${index}`,
    author: {
      email: `author-${index % 2}@import.test`,
      name: `Author ${index % 2}`,
    },
    views: String(9007199254740993n + BigInt(index)),
    tags: ["postgres", index % 2 ? "bun" : "types"],
  }));
  feed.push({ ...feed[0]!, title: "Last source record wins" });

  const first = await database.$transaction((transaction) =>
    importPosts(transaction, feed),
  );
  const repeated = await database.$transaction((transaction) =>
    importPosts(transaction, feed),
  );
  assert.deepEqual(first, { posts: 500, linksAdded: 1000 });
  assert.deepEqual(repeated, { posts: 500, linksAdded: 0 });

  const cancel = new Error("demonstrate whole-import rollback");
  await assert.rejects(
    database.$transaction(async (transaction) => {
      await importPosts(transaction, [{ ...feed[0]!, slug: "rolled-back" }]);
      throw cancel;
    }),
    (error) => error === cancel,
  );
  assert.equal(await database.posts.by.slug("rolled-back").maybeOne(), null);

  const stored = await database.posts.by
    .slug("source-0")((post) => ({
      title: post.title,
      views: post.views,
      author: post.author.name,
      tags: post.tags((tag) => ({
        label: tag.label,
        $orderBy: tag.label.ascending,
      })),
    }))
    .one();
  assert.equal(stored.views, 9007199254740993n);
  assert.equal(stored.title, "Last source record wins");
  assert.deepEqual(stored.tags, [{ label: "postgres" }, { label: "types" }]);
  console.log("bulk import verified", { first, repeated, stored });
} finally {
  await isolated.close();
}
