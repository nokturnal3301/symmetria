// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  int,
  text,
  type Infer,
  type InferInsert,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

const users = table({ id: int.auto, name: text, email: text.unique });
const posts = table({
  id: int.auto,
  title: text,
  author: users.by("email").column("author_email"),
  owner: users.column("created_by").nullable.inverse("owned"),
});
const model = schema({ users, posts });

{
  // The foreign-key value takes the referenced column's type.
  type Row = Infer<typeof model.posts>;
  type AuthorId = Assert<Equal<Row["authorId"], string>>;
  type OwnerId = Assert<Equal<Row["ownerId"], number | null>>;
  type Standalone = Assert<Equal<Infer<typeof posts>["authorId"], string>>;
  type Insert = InferInsert<typeof model.posts>;
  type InsertAuthor = Assert<Equal<Insert["authorId"], string>>;
  // @ts-expect-error the author key is the email, not a number
  model.posts.insert({ title: "x", authorId: 1 });
  // @ts-expect-error only unique columns and the primary key can be referenced
  users.by("name");
}
{
  // Nested connects accept the referenced column's value or a key object.
  model.posts.insert({
    title: "x",
    author: { connect: "ada@example.com" },
    owner: { connect: { id: 1 } },
  });
  model.posts.insert({ title: "x", author: { connect: { id: 7 } } });
  // @ts-expect-error a number is not an email
  model.posts.insert({ title: "x", author: { connect: 7 } });
  const query = model.posts((post) => ({
    author: post.author.name,
    owner: post.owner.name,
    key: post.authorId,
  }));
  type Rows = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { author: string; owner: string | null; key: string }[]
    >
  >;
}
{
  // Keyed links know the target's columns when it is declared without a callback.
  const keyed = schema({
    users: { id: int.auto, email: text.unique },
    posts: ({ users }) => ({
      id: int.auto,
      author: users.by("email").column("author_email"),
    }),
  });
  type Row = Infer<typeof keyed.posts>;
  type AuthorId = Assert<Equal<Row["authorId"], string>>;
  schema({
    users: { id: int.auto, email: text.unique, name: text },
    // @ts-expect-error name is not unique
    posts: ({ users }) => ({ id: int.auto, author: users.by("name") }),
  });
}
