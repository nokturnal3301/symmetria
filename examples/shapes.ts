import { connect } from "./database";
import { appSchema } from "./schema";

const db = process.env.DATABASE_URL ? connect() : appSchema;

try {
  const userCard = db.users.shape((user) => ({ name: user.name }));

  const feed = db.users(
    (user) => {
      const published = user.posts({
        where: (post) => post.state.is.published,
      });

      return {
        name: user.name,
        publications: published.count(),
        totalViews: published.sum.views,
        latestPost: published.maximum.createdAt,
        posts: published(
          (post) => ({
            title: post.title,
            views: post.views,
            status: post.state.match({
              draft: "Draft",
              published: "Published",
            }),
            author: post.author(userCard),
            editor: post.editor(userCard),
            tags: post.tags(({ label }) => ({ label })),
          }),
          {
            orderBy: (post) => [post.createdAt.descending, post.id.descending],
            limit: 3,
          },
        ),
      };
    },
    {
      where: (user) => user.posts.some((post) => post.state.is.published),
      orderBy: { id: "asc" },
      limit: 20,
    },
  );

  const joined = db.posts(
    (post, { join, leftJoin }) => {
      const author = join(post.authorId);
      const editor = leftJoin(db.users.as("reviewer"), (user) => [
        user.id.is(post.editorId),
        user.id.isNot(author.id),
      ]);

      return {
        title: post.title,
        author: author.name,
        editor: editor.name,
      };
    },
    {
      where: { state: "published" },
      orderBy: { id: "asc" },
    },
  );

  const repeated = db.posts(
    (post, { join }) => {
      const author = join(post.authorId);
      const editor = join(post.editorId);
      const sameAuthor = join(post.authorId);

      return {
        title: post.title,
        author: author.name,
        editor: editor.name,
        sameAuthor: sameAuthor.name,
      };
    },
    { orderBy: { id: "asc" }, limit: 3 },
  );

  const ranked = db
    .posts(
      (post, { rowNumber }) => ({
        authorId: post.authorId,
        title: post.title,
        views: post.views,
        position: rowNumber().over({
          partitionBy: [post.authorId],
          orderBy: [post.views.descending, post.id.ascending],
        }),
      }),
      { where: { state: "published" } },
    )
    .cte("ranked_posts");

  const topPosts = ranked(
    (post) => ({
      authorId: post.authorId,
      title: post.title,
      views: post.views,
      position: post.position,
    }),
    { where: (post) => post.position.atMost(2) },
  ).cte("top_posts");

  const totals = db
    .posts(
      (post, { count }) => ({
        authorId: post.authorId,
        publications: count(),
      }),
      {
        where: { state: "published" },
        groupBy: (post) => [post.authorId],
        having: (post, { selected }) => selected.publications.above(0),
      },
    )
    .cte("post_totals");

  const analytics = db.users(
    (user, { leftJoin, coalesce }) => {
      const total = leftJoin(totals, (total) => total.authorId.is(user.id));

      return {
        name: user.name,
        publications: coalesce(total.publications, 0),
        best: topPosts(
          (post) => ({
            title: post.title,
            views: post.views,
            position: post.position,
          }),
          {
            where: (post) => post.authorId.is(user.id),
            orderBy: (post) => post.position.ascending,
          },
        ),
      };
    },
    { orderBy: { id: "asc" } },
  );

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
  await db.$close();
}
