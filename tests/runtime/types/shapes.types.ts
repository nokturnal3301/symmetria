import {
  schema,
  int,
  text,
  bool,
  count,
  rowNumber,
  prepare,
} from "../../../packages/runtime/src";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const database = schema({
  users: { id: int, name: text, active: bool },
  posts: ({ users }) => ({
    id: int,
    author: users,
    editor: users.nullable.inverse("edited"),
    title: text,
  }),
});

const feed = database.users((user) => ({
  name: user.name,
  posts: user.posts((post, { leftJoin, innerJoin }) => {
    const editor = leftJoin(post.editor);
    const author = innerJoin(post.author);

    return {
      title: post.title,
      authorName: author.name,
      editorName: editor.name,
      editor: post.editor((editor) => ({ name: editor.name })),
      $where: [post.id.above(0)],
      $orderBy: post.id.ascending,
      $limit: 3,
    };
  }),
  peers: database.users.as("peer")((peer) => ({
    name: peer.name,
    $where: peer.id.isNot(user.id),
  })),
  $where: user.active.is(true),
}));
type FeedMatches = Expect<
  AreEqual<
    Awaited<typeof feed>,
    {
      name: string;
      posts: {
        title: string;
        authorName: string;
        editorName: string | null;
        editor: { name: string } | null;
      }[];
      peers: { name: string }[];
    }[]
  >
>;

const totals = database
  .posts((post) => ({
    authorId: post.authorId,
    total: count(),
    $groupBy: [post.authorId],
    $having: [count().above(0)],
  }))
  .cte("totals");
const ranked = totals((total) => ({
  authorId: total.authorId,
  total: total.total,
  position: rowNumber().over({ orderBy: [total.total.descending] }),
})).cte("ranked");
const query = prepare({ size: int }, (parameters) =>
  database.users((user, { leftJoin }) => {
    const total = leftJoin(ranked, (total) => [total.authorId.is(user.id)]);

    return {
      name: user.name,
      total: total.total,
      position: total.position,
      $limit: parameters.size,
    };
  }),
);
type TotalsMatch = Expect<
  AreEqual<
    Awaited<ReturnType<typeof query.execute>>,
    {
      name: string;
      total: number | null;
      position: number | null;
    }[]
  >
>;

const filtered = database.users((users) => ({ $where: users.active.is(true) }))(
  (user) => ({ name: user.name }),
);
type FilteredMatches = Expect<
  AreEqual<Awaited<typeof filtered>, { name: string }[]>
>;

// @ts-expect-error controls are reserved and spelling is checked
database.users((user) => ({ name: user.name, $wher: user.active.is(true) }));
// @ts-expect-error predicates cannot be JavaScript booleans
database.users((user) => ({ name: user.name, $where: true }));
// @ts-expect-error output fields must be expressions
database.users(() => ({ name: "literal" }));
// @ts-expect-error ordering requires direction
database.users((user) => ({ name: user.name, $orderBy: user.id }));
// @ts-expect-error group by requires nonempty expressions
database.users((user) => ({ name: user.name, $groupBy: [] }));
// @ts-expect-error callbacks are synchronous
database.users(async (user) => ({ name: user.name }));
// @ts-expect-error unselected sources cannot be nested results
database.users((user) => ({ name: user.name, posts: database.posts }));
database.users((user, { leftJoin }) => {
  // @ts-expect-error explicit sources need an ON callback
  leftJoin(database.posts);
  // @ts-expect-error filtered relations cannot be JOIN sources
  leftJoin(user.posts((posts) => ({ $where: posts.id.above(1) })));

  return { name: user.name };
});

const smart = database.posts((post, { join, crossJoin, whereNotNull, sql }) => {
  const author = join(post.author);
  const editor = join(post.editor);
  const peer = crossJoin(database.users.as("peer"));

  return {
    author: author.name,
    editor: editor.name,
    peer: peer.name,
    editorId: whereNotNull(post.editorId),
    constant: sql<number>`1`,
    $distinct: true,
  };
});
type SmartMatches = Expect<
  AreEqual<
    Awaited<typeof smart>,
    {
      author: string;
      editor: string | null;
      peer: string;
      editorId: number;
      constant: number;
    }[]
  >
>;
const single = database.users((user) => ({ name: user.name })).scalar();
const scalarProjection = database.posts((post) => ({
  title: post.title,
  single,
}));
type ScalarMatches = Expect<
  AreEqual<
    Awaited<typeof scalarProjection>,
    { title: string; single: string | null }[]
  >
>;
// @ts-expect-error multiple output columns are not scalar subqueries
database.users((user) => ({ id: user.id, name: user.name })).scalar();
// @ts-expect-error distinct takes a boolean
database.users((user) => ({ id: user.id, $distinct: "yes" }));
database.posts((post, { join, crossJoin }) => {
  // @ts-expect-error smart JOIN needs relation metadata
  join(database.users);
  // @ts-expect-error CROSS JOIN requires source metadata
  crossJoin(post.id);

  return { id: post.id };
});

export type ShapeContracts =
  | FeedMatches
  | TotalsMatch
  | FilteredMatches
  | SmartMatches
  | ScalarMatches;
