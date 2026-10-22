import { prepare, text } from "symmetria";
import { connect } from "./database";
import { authorFeed } from "./queries";

const database = connect();

try {
  console.log(await authorFeed(database).execute());

  const feed = database.posts((posts) => ({
    id: posts.id,
    title: posts.title,
    views: posts.views,
    createdAt: posts.createdAt,
    $where: posts.state.is.published,
    $orderBy: [posts.createdAt.descending, posts.id.descending],
  }));

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
    database.posts.by.slug(slug)((posts) => ({
      title: posts.title,
      views: posts.views,
    })),
  );
  console.log(await lookup.execute({ slug: "typed-sql" }));
} finally {
  await database.$close();
}
