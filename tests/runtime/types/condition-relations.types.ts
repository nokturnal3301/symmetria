// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  int,
  text,
  type Infer,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

const users = table({ id: int.auto, name: text.unique });
const comments = table({ id: int.auto, body: text, postTitle: text });
const posts = table({
  id: int.auto,
  title: text,
  authorName: text,
  reviewerName: text.nullable,
}).relations((post, { to }) => ({
  author: to(users).one((user) => post.authorName.is(user.name)),
  mentions: to(() => comments).many((comment) =>
    comment.postTitle.is(post.title),
  ),
  reviewer: to(users)
    .one((user) => post.reviewerName.is(user.name))
    .inverse("reviewed"),
}));
const model = schema({ users, comments, posts });

{
  // A to-one condition relation is always optional; to-many ones nest as collections.
  const query = model.posts((post) => ({
    title: post.title,
    author: post.author.name,
    mentions: post.mentions((comment) => ({ body: comment.body })),
  }));
  type Rows = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { title: string; author: string | null; mentions: { body: string }[] }[]
    >
  >;
}
{
  // inverse() exposes the relation from the target as a collection.
  const query = model.users((user) => ({
    reviewed: user.reviewed((post) => ({ title: post.title })),
  }));
  type Reviewed = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { reviewed: { title: string }[] }[]
    >
  >;
}
{
  // No foreign-key column exists and nested writes do not offer the relation.
  type Row = Infer<typeof model.posts>;
  type NoKey = Assert<
    Equal<"authorId" extends keyof Row ? true : false, false>
  >;
  type Input = Parameters<typeof model.posts.insert>[0];
  type NoNested = Assert<
    Equal<"author" extends keyof Input ? true : false, false>
  >;
  // @ts-expect-error a condition relation has no foreign key to write
  model.posts.insert({ title: "x", authorName: "a", author: { connect: 1 } });
  // @ts-expect-error a to-many relation exposes the collection API, not columns
  model.posts((post) => ({ body: post.mentions.body }));
}
{
  // Keyed links resolve by name and carry the columns of tables declared without a callback.
  const keyed = schema({
    users: { id: int.auto, name: text },
    posts: ({ users }) =>
      table({ id: int.auto, title: text, authorName: text }).relations(
        (post, { to }) => ({
          author: to(users).one((user) => post.authorName.is(user.name)),
          // @ts-expect-error the target's columns are known
          typo: to(users).one((user) => post.authorName.is(user.nmae)),
        }),
      ),
  });
  const query = keyed.posts((post) => ({ author: post.author.name }));
  type Keyed = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { author: string | null }[]
    >
  >;
}
{
  // A target declared through a callback has no column types yet: its scope is loose.
  const cyclic = schema({
    users: ({ posts }) => ({
      id: int.auto,
      name: text,
      favorite: posts.nullable,
    }),
    posts: ({ users }) =>
      table({ id: int.auto, title: text, authorName: text }).relations(
        (post, { to }) => ({
          author: to(users).one((user) => post.authorName.is(user.name)),
        }),
      ),
  });
  const query = cyclic.posts((post) => ({ author: post.author.name }));
  type Loose = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { author: string | null }[]
    >
  >;
}
