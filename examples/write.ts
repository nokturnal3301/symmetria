import { connect } from "./database";

const db = connect();

try {
  const post = await db.posts
    .insert({
      slug: `nested-${crypto.randomUUID()}`,
      title: "Atomic nested insert",
      author: { connect: { email: "ada@example.test" } },
      tags: { connectOrCreate: [{ label: "postgres" }] },
    })
    .returning("id", "title");

  console.log(post);

  if (post) {
    console.log(
      await db.posts
        .byId(post.id)
        .update((row) => ({ views: row.views.plus(1n) }))
        .returning("id", "views"),
    );

    await db.posts.byId(post.id).delete();
  }
} finally {
  await db.$close();
}
