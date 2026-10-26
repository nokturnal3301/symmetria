// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  index,
  int,
  text,
  uuid,
  bool,
  timestamptz,
  sql,
  type QueryColumn,
} from "../../../packages/runtime/src";

const model = schema({
  users: table({ id: uuid.v4, email: text }).indexes((users) => ({
    lowerEmail: index(sql<string>`lower(${users.email})`).unique,
  })),
  posts: ({ users }) =>
    table({
      id: int.auto,
      title: text,
      author: users,
      published: bool.default(false),
      createdAt: timestamptz.now,
    }).indexes((posts) => ({
      byAuthorDate: index(posts.authorId, posts.createdAt.descending).include(
        posts.title,
      ),
      feed: index(posts.createdAt.descending).where(posts.published.is(true)),
    })),
});

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;
type PostRow = Expect<
  AreEqual<
    typeof model.posts.$row,
    {
      id: number;
      title: string;
      authorId: string;
      published: boolean;
      createdAt: Date;
    }
  >
>;
type PostInsert = Expect<
  AreEqual<
    typeof model.posts.$insert,
    {
      id?: undefined;
      title: string;
      authorId: string;
      published?: boolean | undefined;
      createdAt?: Date | undefined;
    }
  >
>;
const query = model.posts((posts, { leftJoin }) => {
  const author = leftJoin(posts.author);

  return { title: posts.title, email: author.email };
});
type SelectedRow = Expect<
  AreEqual<
    Awaited<ReturnType<typeof query.execute>>,
    { title: string; email: string | null }[]
  >
>;
{
  table({ id: int, title: text, published: bool }).indexes((posts) => {
    // @ts-expect-error scalar predicate values retain their column types
    posts.title.is(42);
    // @ts-expect-error missing columns are rejected
    index(posts.missing);

    return { byTitle: index(posts.title) };
  });
  schema({
    users: { id: uuid },
    posts: ({ users }) =>
      table({ id: int, author: users }).indexes((posts) => {
        // @ts-expect-error references expose the physical FK column, not a relationship
        index(posts.author);

        return { byAuthor: index(posts.authorId) };
      }),
  });
  // @ts-expect-error index callbacks must return index definitions
  table({ id: int }).indexes(() => ({ invalid: int }));
  // @ts-expect-error metadata does not leak into query rows
  model.posts((posts) => ({ indexes: posts.indexes }));
  // @ts-expect-error wrapping a table must not allow undefined keyed columns
  schema({ records: table({ id: int, invalid: undefined }) });
  // @ts-expect-error wrapped table definitions still validate ambiguous relations
  schema({
    users: table({ id: uuid }),
    posts: ({ users }) => table({ id: int, author: users, editor: users }),
  });
  schema({
    users: table({ id: uuid }),
    posts: (references) => {
      // @ts-expect-error wrapping a table must not widen the available reference names
      references.missing;

      return table({ id: int, author: references.users });
    },
  });
}
