import { connect } from "./database";

const db = connect();

try {
  await db.$transaction(async (transaction) => {
    await transaction.users
      .insert({ email: "ada@example.test", name: "Ada" })
      .onConflict("email")
      .doNothing();

    const author = await transaction.users.get({ email: "ada@example.test" });

    for (const slug of ["typed-sql", "relations", "transactions", "draft"]) {
      const existing = await transaction.posts.find({ slug });

      if (existing) {
        continue;
      }

      await transaction.posts.insert({
        slug,
        title: slug,
        state: slug === "draft" ? "draft" : "published",
        views: 9007199254740993n,
        author: { connect: author.id },
        tags: { connectOrCreate: [{ label: "postgres" }, { label: "bun" }] },
      });
    }
  });
  console.log("Seed ready: Ada, four posts and two tags.");
} finally {
  await db.$close();
}
