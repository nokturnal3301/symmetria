import { connect } from "./database";
import { appSchema } from "./schema";

const database = process.env.DATABASE_URL ? connect() : appSchema;

try {
  const userCard = database.users.shape((user) => ({ name: user.name }));

  const feed = database.users((user) => {
    const published = user.posts((posts) => ({
      $where: posts.state.is.published,
    }));

    return {
      name: user.name,
      publications: published.count(),
      totalViews: published.sum((post) => post.views),
      latestPost: published.maximum((post) => post.createdAt),
      posts: published((post) => ({
        title: post.title,
        views: post.views,
        status: post.state.match({ draft: "Draft", published: "Published" }),
        author: post.author(userCard),
        editor: post.editor(userCard),
        tags: post.tags(({ label }) => ({ label })),

        $orderBy: [post.createdAt.descending, post.id.descending],
        $limit: 3,
      })),

      $where: published.some(),
      $orderBy: user.id.ascending,
      $limit: 20,
    };
  });

  const joined = database.posts((post, { join, leftJoin }) => {
    const author = join(post.authorId);
    const editor = leftJoin(database.users.as("reviewer"), (user) => [
      user.id.is(post.editorId),
      user.id.isNot(author.id),
    ]);

    return {
      title: post.title,
      author: author.name,
      editor: editor.name,

      $where: post.state.is.published,
      $orderBy: post.id.ascending,
    };
  });

  const repeated = database.posts((post, { join }) => {
    const author = join(post.authorId);
    const editor = join(post.editorId);
    const sameAuthor = join(post.authorId);

    return {
      title: post.title,
      author: author.name,
      editor: editor.name,
      sameAuthor: sameAuthor.name,
      $orderBy: post.id.ascending,
      $limit: 3,
    };
  });

  const ranked = database
    .posts((post, { rowNumber }) => ({
      authorId: post.authorId,
      title: post.title,
      views: post.views,
      position: rowNumber().over({
        partitionBy: [post.authorId],
        orderBy: [post.views.descending, post.id.ascending],
      }),

      $where: post.state.is.published,
    }))
    .cte("ranked_posts");

  const topPosts = ranked((post) => ({
    authorId: post.authorId,
    title: post.title,
    views: post.views,
    position: post.position,

    $where: post.position.atMost(2),
  })).cte("top_posts");

  const totals = database
    .posts((post, { count }) => ({
      authorId: post.authorId,
      publications: count(),

      $where: post.state.is.published,
      $groupBy: [post.authorId],
      $having: count().above(0),
    }))
    .cte("post_totals");

  const analytics = database.users((user, { leftJoin, coalesce }) => {
    const total = leftJoin(totals, (total) => total.authorId.is(user.id));

    return {
      name: user.name,
      publications: coalesce(total.publications, 0),
      best: topPosts((post) => ({
        title: post.title,
        views: post.views,
        position: post.position,

        $where: post.authorId.is(user.id),
        $orderBy: post.position.ascending,
      })),

      $orderBy: user.id.ascending,
    };
  });

  for (const [name, query] of Object.entries({
    feed,
    joined,
    repeated,
    analytics,
  })) {
    console.log(name, query.toSQL());

    if (process.env.DATABASE_URL) {
      console.log(await query);
    }
  }
} finally {
  await database.$close();
}
