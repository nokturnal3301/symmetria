import { connect } from "./database";

const database = connect();

try {
  const post = await database.posts
    .insert({
      slug: `nested-${crypto.randomUUID()}`,
      title: "Atomic nested insert",
      author: { connect: { email: "ada@example.test" } },
      tags: { connectOrCreate: [{ label: "postgres" }] },
    })
    .returning((posts) => [posts.id, posts.title])
    .execute();

  console.log(post);

  if (post) {
    console.log(
      await database.posts
        .update((posts) => ({ views: posts.views.plus(1n) }))
        .where((posts) => posts.id.is(post.id))
        .returning((posts) => [posts.id, posts.views])
        .execute(),
    );

    await database.posts
      .delete()
      .where((posts) => posts.id.is(post.id))
      .execute();
  }
} finally {
  await database.$close();
}
