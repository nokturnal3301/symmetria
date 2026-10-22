import {
  schema,
  table,
  junction,
  createDatabase,
  int,
  text,
  bigint,
  timestamptz,
  prepare,
} from "symmetria";
import { postgres } from "symmetria/driver";
import { DATABASE_URL, POOL_SIZE } from "../config";
import type { Bench, Observer } from "./types";

const users = table({ id: int.auto, email: text.unique, name: text });
const posts = table({
  id: int.auto,
  slug: text.unique,
  title: text,
  author: users.index,
  editor: users.nullable.inverse("edited"),
  state: text.default("draft"),
  views: bigint.default(0n),
  createdAt: timestamptz.now,
});
const tags = table({ id: int.auto, label: text.unique });
const postTags = junction({
  post: posts.onDelete.cascade,
  tag: tags.onDelete.cascade,
});
export const appSchema = schema({ users, posts, tags, postTags });

const nestedQuery = (database: typeof appSchema, offset: number) =>
  database.users((user) => ({
    id: user.id,
    name: user.name,
    posts: user.posts((post) => ({
      title: post.title,
      views: post.views,
      tags: post.tags((tag) => ({ label: tag.label })),
      $orderBy: [post.createdAt.descending, post.id.descending],
      $limit: 3,
    })),
    $orderBy: user.id.ascending,
    $offset: offset,
    $limit: 50,
  }));

export const create = (prepared = false, observe?: Observer): Bench => {
  const base = postgres({ url: DATABASE_URL, max: POOL_SIZE });
  const database = createDatabase({
    schema: appSchema,
    driver: observe
      ? {
          ...base,
          execute: (query) => {
            observe(query);

            return base.execute(query);
          },
        }
      : base,
  });
  /** Parameterized OFFSET keeps one SQL text, so the driver can reuse its prepared statement. */
  const nestedPrepared = prepare({ offset: int }, (parameters) =>
    database.users((user) => ({
      id: user.id,
      name: user.name,
      posts: user.posts((post) => ({
        title: post.title,
        views: post.views,
        tags: post.tags((tag) => ({ label: tag.label })),
        $orderBy: [post.createdAt.descending, post.id.descending],
        $limit: 3,
      })),
      $orderBy: user.id.ascending,
      $offset: parameters.offset,
      $limit: 50,
    })),
  );

  return {
    name: prepared ? "Symmetria (prepared)" : "Symmetria",
    pointLookup: (id) => database.users.byId(id).maybeOne(),
    listJoin: () =>
      database.posts((post) => ({
        id: post.id,
        title: post.title,
        author: post.author.name,
        $where: post.state.is("published"),
        $orderBy: [post.createdAt.descending, post.id.descending],
        $limit: 20,
      })),
    nestedKeyset: (afterId) =>
      database.users((user) => ({
        id: user.id,
        name: user.name,
        posts: user.posts((post) => ({
          title: post.title,
          views: post.views,
          tags: post.tags((tag) => ({ label: tag.label })),
          $orderBy: [post.createdAt.descending, post.id.descending],
          $limit: 3,
        })),
        $where: user.id.above(afterId),
        $orderBy: user.id.ascending,
        $limit: 50,
      })),
    nested: (offset) =>
      prepared
        ? nestedPrepared.execute({ offset })
        : nestedQuery(database, offset),
    insertOne: (row) =>
      database.posts
        .insert({ slug: row.slug, title: row.title, authorId: row.authorId })
        .returning((post) => [post.id]),
    insertMany: (rows) =>
      database.posts.insert(
        rows.map((row) => ({
          slug: row.slug,
          title: row.title,
          authorId: row.authorId,
        })),
      ),
    updateViews: (id) =>
      database.posts
        .update((post) => ({ views: post.views.plus(1n) }))
        .where((post) => post.id.is(id))
        .returning((post) => [post.views]),
    buildNested: (offset) => nestedQuery(appSchema, offset).toSQL(),
    close: () => database.$close(),
  };
};
