import {
  schema,
  int,
  text,
  self,
  junction,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const database = schema({
  users: { id: int, name: text, manager: self.nullable },
  posts: ({ users }) => ({
    id: int,
    author: users,
    editor: users.nullable.inverse("edited"),
    title: text,
  }),
  tags: { id: int, label: text },
  postTags: ({ posts, tags }) => junction({ post: posts, tag: tags }),
});

const hierarchy = database.users(
  (user, { join, innerJoin, leftJoin, crossJoin }) => {
    const manager = join(user.managerId);
    const director = join(manager.managerId);
    const required = innerJoin(user.managerId);
    const optional = leftJoin(required.managerId);
    const peer = crossJoin(manager.managerId);
    const post = join(user.posts);
    const author = join(post.authorId);

    return {
      manager: manager.name,
      director: director.name,
      required: required.name,
      optional: optional.name,
      peer: peer.name,
      author: author.name,
    };
  },
);
type Hierarchy = Expect<
  Equal<
    Awaited<typeof hierarchy>,
    {
      manager: string | null;
      director: string | null;
      required: string;
      optional: string | null;
      peer: string;
      author: string | null;
    }[]
  >
>;

const roles = database.posts(
  (post, { join, innerJoin, leftJoin, crossJoin }) => {
    const author = join(post.authorId);
    const editor = join(post.editorId);
    const secondAuthor = leftJoin(post.authorId);
    const requiredEditor = innerJoin(post.editorId);
    const tag = crossJoin(post.tags);
    const secondTag = crossJoin(post.tags);

    return {
      author: author.name,
      editor: editor.name,
      secondAuthor: secondAuthor.name,
      requiredEditor: requiredEditor.name,
      tag: tag.label,
      secondTag: secondTag.label,
    };
  },
);
type Roles = Expect<
  Equal<
    Awaited<typeof roles>,
    {
      author: string;
      editor: string | null;
      secondAuthor: string | null;
      requiredEditor: string;
      tag: string;
      secondTag: string;
    }[]
  >
>;

const joined = database.posts((posts, { join, leftJoin, crossJoin }) => {
  const author = join(posts.authorId);
  const editor = leftJoin(posts.editorId);
  const tags = crossJoin(posts.tags);

  return {
    author: author.name,
    editor: editor.name,
    tag: tags.label,
  };
});
type Fluent = Expect<
  Equal<
    Awaited<typeof joined>,
    { author: string; editor: string | null; tag: string }[]
  >
>;

const countries = schema({
  countries: { code: text.primaryKey, label: text },
  cities: ({ countries }) => ({ id: int, country: countries, name: text }),
});
const city = countries.cities((city, { join }) => {
  const country = join(city.countryId);

  return { code: country.code, label: country.label };
});
type Country = Expect<
  Equal<Awaited<typeof city>, { code: string; label: string }[]>
>;

database.posts((post, { join, innerJoin, leftJoin, crossJoin, sql }) => {
  // @ts-expect-error a scalar column is not a foreign key
  join(post.id);
  // @ts-expect-error a name ending in Id is not enough: expression metadata is required
  leftJoin(sql<number>`1`.as("authorId"));
  // @ts-expect-error arithmetic loses foreign-key provenance
  innerJoin(post.authorId.plus(1));
  // @ts-expect-error a filtered relation is a query, not a JOIN reference
  crossJoin(post.tags((tags) => ({ $where: tags.id.above(0) })));
  // @ts-expect-error inferred relationships supply their own ON condition
  leftJoin(post.authorId, () => post.id.is(1));

  return { id: post.id };
});

const projected = database
  .posts((post) => ({ authorId: post.authorId }))
  .cte("projected");
projected((row, { join }) => {
  // @ts-expect-error projected scalar fields do not declare base-table relationships
  join(row.authorId);

  return { id: row.authorId };
});

export type InferredJoinContracts = Hierarchy | Roles | Fluent | Country;
