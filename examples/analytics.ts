import { rowNumber } from "symmetria";
import { connect } from "./database";

const db = connect();

try {
  const ranked = db
    .posts((post) => ({
      title: post.title,
      authorId: post.authorId,
      position: rowNumber().over({
        partitionBy: [post.authorId],
        orderBy: [post.views.descending, post.id.ascending],
      }),
    }))
    .cte("ranked_posts");

  console.log(await ranked({ where: (post) => post.position.atMost(2) }));
} finally {
  await db.$close();
}
