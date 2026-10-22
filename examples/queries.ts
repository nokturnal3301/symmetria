import { appSchema } from "./schema";

export const recentPosts = (database: typeof appSchema) =>
  database.posts((posts) => ({
    id: posts.id,
    title: posts.title,
    author: posts.author.name,
    editor: posts.editor.name,
    views: posts.views,

    $where: posts.state.is.published,
    $orderBy: [posts.createdAt.descending, posts.id.descending],
  }));

export const authorFeed = (database: typeof appSchema) =>
  database.users((users) => ({
    name: users.name,
    posts: users.posts((posts) => ({
      title: posts.title,
      tags: posts.tags((tags) => ({ label: tags.label })),

      $where: posts.state.is.published,
      $orderBy: posts.id.descending,
      $limit: 3,
    })),

    $where: users.posts.some((posts) => posts.state.is.published),
  }));

if (import.meta.main) {
  console.log(recentPosts(appSchema)(() => ({ $limit: 5 })).toSQL());
  console.log(authorFeed(appSchema).toSQL());
}
