import {
  schema,
  int,
  text,
  bigint,
  oneOf,
  timestamptz,
} from "../../../packages/runtime/src";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const database = schema({
  users: { id: int, name: text },
  posts: ({ users }) => ({
    id: int,
    author: users,
    editor: users.nullable.inverse("edited"),
    state: oneOf("draft", "published"),
    optionalState: oneOf("draft", "published").nullable,
    views: bigint,
    createdAt: timestamptz,
  }),
});
const card = database.users.shape((user) => ({
  name: user.name,
  total: user.posts.sum((post) => post.views),
}));
const query = database.posts((post) => ({
  author: post.author(card),
  editor: post.editor(card),
  label: post.state.match({ draft: "Draft", published: "Published" }),
  optionalLabel: post.optionalState.match({
    draft: "Draft",
    published: "Published",
  }),
  views: post.state.match({ draft: post.views, published: 0n }),
}));
type Result = Expect<
  AreEqual<
    Awaited<typeof query>,
    {
      author: { name: string; total: string | null } | null;
      editor: { name: string; total: string | null } | null;
      label: "Draft" | "Published";
      optionalLabel: "Draft" | "Published" | null;
      views: bigint;
    }[]
  >
>;
const alias = database.users.as("member")(card);
type Alias = Expect<
  AreEqual<Awaited<typeof alias>, { name: string; total: string | null }[]>
>;
const aggregates = database.users((user) => ({
  latest: user.posts.maximum((post) => post.createdAt),
  smallest: user.posts.minimum((post) => post.views),
  average: user.posts.average((post) => post.views),
}));
type Aggregates = Expect<
  AreEqual<
    Awaited<typeof aggregates>,
    { latest: Date | null; smallest: bigint | null; average: string | null }[]
  >
>;

// @ts-expect-error shapes retain their table identity
database.posts(card);
// @ts-expect-error reusable projections contain fields, not controls
database.users.shape((user) => ({ name: user.name, $limit: 1 }));
// @ts-expect-error reusable shapes need a projection
database.users.shape(() => ({}));
database.posts((post) => {
  // @ts-expect-error exhaustive enum mapping
  post.state.match({ draft: "Draft" });
  post.state.match({
    draft: "Draft",
    published: "Published",
    // @ts-expect-error extra branches are rejected
    archived: "Archived",
  });
  // @ts-expect-error ordinary strings are not finite enums
  post.author.name.match({ draft: "Draft" });

  return { id: post.id };
});
// @ts-expect-error write callbacks receive the row directly
database.users.update(({ users }) => ({ name: users.name }));
database.posts
  .insert({
    authorId: 1,
    editorId: null,
    state: "draft",
    optionalState: null,
    views: 0n,
    createdAt: new Date(),
    id: 1,
  })
  .onConflict("id")
  .doUpdate((post, excluded) => ({ views: post.views.plus(excluded.views) }));

export type ReusableContracts = Result | Alias | Aggregates;
