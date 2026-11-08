import { connect } from "./database";

const database = connect();

try {
  await database.$transaction(async (transaction) => {
    await transaction.users
      .insert({ email: "ada@example.test", name: "Ada" })
      .onConflict("email")
      .doNothing()
      .execute();

    const author = await transaction.users.by.email("ada@example.test").one();

    for (const slug of ["typed-sql", "relations", "transactions", "draft"]) {
      const existing = await transaction.posts.by.slug(slug).maybeOne();

      if (existing) {
        continue;
      }

      await transaction.posts
        .insert({
          slug,
          title: slug,
          state: slug === "draft" ? "draft" : "published",
          views: 9007199254740993n,
          author: { connect: author.id },
          tags: { connectOrCreate: [{ label: "postgres" }, { label: "bun" }] },
        })
        .execute();
    }
  });
  console.log("Seed ready: Ada, four posts and two tags.");
} finally {
  await database.$close();
}
