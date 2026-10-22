import { rowNumber } from "symmetria";
import { connect } from "./database";

const database = connect();

try {
  const ranked = database
    .posts((posts) => ({
      title: posts.title,
      authorId: posts.authorId,
      position: rowNumber().over({
        partitionBy: [posts.authorId],
        orderBy: [posts.views.descending, posts.id.ascending],
      }),
    }))
    .cte("ranked_posts");

  console.log(
    await ranked((post) => ({
      title: post.title,
      authorId: post.authorId,
      position: post.position,
      $where: post.position.atMost(2),
    })).execute(),
  );
} finally {
  await database.$close();
}
