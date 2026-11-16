import { appSchema } from "./schema";

export const recentPosts = (db: typeof appSchema) =>
  db.posts(
    (post) => ({
      id: post.id,
      title: post.title,
      author: post.author.name,
      editor: post.editor.name,
      views: post.views,
    }),
    {
      where: (post) => post.state.is.published,
      orderBy: (post) => [post.createdAt.descending, post.id.descending],
    },
  );

export const authorFeed = (db: typeof appSchema) =>
  db.users(
    (user) => ({
      name: user.name,
      posts: user.posts(
        (post) => ({
          title: post.title,
          tags: post.tags((tag) => ({ label: tag.label })),
        }),
        {
          where: (post) => post.state.is.published,
          orderBy: (post) => post.id.descending,
          limit: 3,
        },
      ),
    }),
    { where: (user) => user.posts.some((post) => post.state.is.published) },
  );

if (import.meta.main) {
  console.log(recentPosts(appSchema)({ limit: 5 }).toSQL());
  console.log(authorFeed(appSchema).toSQL());
}
