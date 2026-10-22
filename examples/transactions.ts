import type { Transaction } from "symmetria";
import { connect } from "./database";

const database = connect();

const lockPost = (transaction: Transaction<typeof database>, slug: string) =>
  transaction.posts.by
    .slug(slug)(() => ({ $forUpdate: true }))
    .one();

try {
  const result = await database.$transaction(async (transaction) => {
    const post = await lockPost(transaction, "typed-sql");

    try {
      await transaction.$transaction(async (savepoint) => {
        await savepoint.posts
          .update({ title: "Discard this change" })
          .where((posts) => posts.id.is(post.id))
          .execute();
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

    return transaction.posts
      .byId(post.id)((posts) => ({ title: posts.title, views: posts.views }))
      .one();
  });
  console.log(result);
} finally {
  await database.$close();
}
