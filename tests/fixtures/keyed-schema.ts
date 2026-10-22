import {
  junction,
  schema,
  uuid,
  text,
  int,
  timestamptz,
} from "../../packages/runtime/src";

// Equal table shapes deliberately exercise key-based identity resolution.
export const model = schema({
  users: {
    id: uuid.v7,
    name: text,
  },
  teams: {
    id: uuid.v7,
    name: text,
  },
  profiles: ({ users }) => ({
    id: int.auto,
    bio: text.nullable,
    user: users.unique.inverse("profile"),
  }),
  posts: ({ users, teams }) => ({
    id: uuid.v7,
    title: text,
    author: users.inverse("authored"),
    editor: users.nullable.inverse("edited").onDelete.setNull,
    team: teams,
  }),
  tags: { id: uuid.v7, name: text.unique },
  postTags: ({ posts, tags }) =>
    junction({
      post: posts,
      tag: tags,
      addedAt: timestamptz.now,
    }),
  categories: ({ categories }) => ({
    id: uuid.v7,
    name: text,
    parent: categories.nullable.inverse("children"),
  }),
});

export const articles = model.posts((posts, { leftJoin }) => {
  const author = leftJoin(posts.author);
  const editor = leftJoin(posts.editor);

  return {
    title: posts.title,
    authorName: author.name,
    editorName: editor.name,
    $where: posts.title.is("Typesafe SQL"),
    $orderBy: posts.title.ascending,
    $limit: 20,
  };
});

export type Article = Awaited<ReturnType<typeof articles.execute>>[number];
