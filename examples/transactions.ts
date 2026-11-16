import type { Transaction } from "symmetria";
import { connect } from "./database";

const db = connect();

const lockPost = (transaction: Transaction<typeof db>, slug: string) =>
  transaction.posts.by.slug(slug)({ forUpdate: true }).one();

try {
  const result = await db.$transaction(async (transaction) => {
    const post = await lockPost(transaction, "typed-sql");

    try {
      await transaction.$transaction(async (savepoint) => {
        await savepoint.posts
          .byId(post.id)
          .update({ title: "Discard this change" });
        throw new Error("Cancel the nested operation");
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Cancel the nested operation"
      ) {
        throw error;
      }

      // The savepoint has rolled back; the outer transaction remains usable.
    }

    return transaction.posts.get(post.id, ({ title, views }) => ({
      title,
      views,
    }));
  });
  console.log(result);
} finally {
  await db.$close();
}
