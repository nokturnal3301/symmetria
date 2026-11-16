import { prepare, text } from "symmetria";
import { connect } from "./database";
import { authorFeed } from "./queries";

const db = connect();

try {
  console.log(await authorFeed(db));

  const feed = db.posts(
    (post) => ({
      id: post.id,
      title: post.title,
      views: post.views,
      createdAt: post.createdAt,
    }),
    {
      where: (post) => post.state.is.published,
      orderBy: (post) => [post.createdAt.descending, post.id.descending],
    },
  );

  const firstPage = await feed.page({ size: 2 });
  console.log(firstPage);

  if (firstPage.nextCursor) {
    console.log(
      await feed.page({
        size: 2,
        after: firstPage.nextCursor,
      }),
    );
  }

  const lookup = prepare({ slug: text }, ({ slug }) =>
    db.posts.by.slug(slug)((post) => ({
      title: post.title,
      views: post.views,
    })),
  );
  console.log(await lookup({ slug: "typed-sql" }));
} finally {
  await db.$close();
}
