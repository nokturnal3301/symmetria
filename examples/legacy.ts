// Adopting an existing database: foreign keys to unique columns with legacy
// column names, relations without any foreign key, PostgreSQL types beyond the
// basics, conditional upserts and paging in both directions. Creates its own
// isolated schema.
import assert from "node:assert/strict";
import {
  bytea,
  date,
  inet,
  int,
  schema,
  smallint,
  table,
  text,
  type InferUpdate,
} from "symmetria";
import { testDatabase } from "symmetria-kit/testing";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("Set DATABASE_URL to a PostgreSQL database for the demo.");
}

const accounts = table({
  id: smallint.auto,
  email: text.unique,
  name: text,
  joined: date,
  lastIp: inet.nullable,
  avatar: bytea.nullable,
});
// The legacy table keys posts by the author's email in a column called author_email.
const posts = table({
  id: int.auto,
  title: text.unique,
  author: accounts.by("email").column("author_email"),
  version: int.default(1),
});
// Comments mention a post by title; there is no foreign key, only a predicate.
const comments = table({
  id: int.auto,
  postTitle: text,
  body: text,
}).relations((comment, { to }) => ({
  post: to(posts)
    .one((post) => post.title.is(comment.postTitle))
    .inverse("comments"),
}));

const { database, close } = await testDatabase({
  url,
  schema: schema({ accounts, posts, comments }),
  prefix: "symmetria_legacy",
});

try {
  await database.accounts.insert([
    {
      email: "ada@example.test",
      name: "Ada",
      joined: "1991-12-10",
      lastIp: "10.0.0.1",
    },
    {
      email: "grace@example.test",
      name: "Grace",
      joined: "1992-01-01",
      avatar: new Uint8Array([0x89, 0x50]),
    },
  ]);
  // The foreign key stores the referenced email; nested connect uses it too.
  await database.posts.insert([
    { title: "Typed SQL", authorId: "ada@example.test" },
    { title: "Relations", author: { connect: "grace@example.test" } },
    { title: "Pull", authorId: "ada@example.test" },
  ]);
  await database.comments.insert([
    { postTitle: "Typed SQL", body: "first" },
    { postTitle: "Typed SQL", body: "second" },
    { postTitle: "Lost", body: "nothing matches" },
  ]);

  const feed = await database.posts(
    (post) => ({
      title: post.title,
      author: post.author.name,
      joined: post.author.joined,
      comments: post.comments.count(),
    }),
    { orderBy: (post) => post.id.ascending },
  );
  console.log(feed);
  assert.deepEqual(feed, [
    { title: "Typed SQL", author: "Ada", joined: "1991-12-10", comments: 2 },
    { title: "Relations", author: "Grace", joined: "1992-01-01", comments: 0 },
    { title: "Pull", author: "Ada", joined: "1991-12-10", comments: 0 },
  ]);

  // The condition relation is a LEFT JOIN: an unmatched comment keeps a null post.
  const mentions = await database.comments(
    (comment) => ({ body: comment.body, post: comment.post.title }),
    { orderBy: (comment) => comment.id.ascending },
  );
  assert.deepEqual(
    mentions.map((row) => row.post),
    ["Typed SQL", "Typed SQL", null],
  );

  const account = await database.accounts.by.email("grace@example.test").one();
  assert.ok(account.avatar instanceof Uint8Array);
  assert.equal(account.joined, "1992-01-01");

  // Only a newer version may replace a post; a stale import writes nothing.
  const upsert = (version: number) =>
    database.posts
      .insert({ title: "Typed SQL", authorId: "grace@example.test", version })
      .onConflict("title")
      .doUpdate(
        (_current, incoming) => ({
          authorId: incoming.authorId,
          version: incoming.version,
        }),
        {
          where: (current, incoming) => incoming.version.above(current.version),
        },
      )
      .returning((post) => ({ author: post.authorId, version: post.version }));
  assert.equal(await upsert(0), null);
  assert.deepEqual(await upsert(3), {
    author: "grace@example.test",
    version: 3,
  });

  // InferUpdate names the patch type for helpers and handlers.
  const patch: InferUpdate<typeof database.posts> = {
    title: "Typed SQL, 2nd edition",
  };
  await database.posts.byId(1).update(patch);

  // Pages move both ways and always arrive in the declared order.
  const pages = database.posts((post) => ({ id: post.id }), {
    orderBy: (post) => post.id.ascending,
  });
  const first = await pages.page({ size: 2 });
  const second = await pages.page({ size: 2, after: first.nextCursor });
  const back = await pages.page({ size: 2, before: second.previousCursor });
  assert.deepEqual(second.items, [{ id: 3 }]);
  assert.deepEqual(back.items, first.items);
  assert.equal(back.previousCursor, null);

  console.log("legacy verified");
} finally {
  await close();
}
