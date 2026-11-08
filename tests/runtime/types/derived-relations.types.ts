import { schema, int, text } from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

const model = schema({
  users: { id: int, name: text },
  posts: ({ users }) => ({ id: int, author: users, title: text }),
});
const eligible = model
  .posts((posts) => ({ authorId: posts.authorId }))
  .cte("eligible");
const query = eligible((eligible, { innerJoin }) => {
  const owner = innerJoin(model.users.as("owner"), (owner) =>
    eligible.authorId.is(owner.id),
  );

  return {
    name: owner.name,
    posts: owner.posts((posts) => ({ title: posts.title })),
  };
});
type Result = Assert<
  Equal<
    Awaited<ReturnType<typeof query.execute>>,
    { name: string; posts: { title: string }[] }[]
  >
>;
const renamed = eligible.as("renamed")((renamed) => ({
  authorId: renamed.authorId,
}));
type RenamedResult = Assert<
  Equal<Awaited<ReturnType<typeof renamed.execute>>, { authorId: number }[]>
>;
const collision = model
  .posts((posts) => ({ authorId: posts.authorId }))
  .as("users")((users, { innerJoin }) => {
  const owner = innerJoin(model.users.as("owner"), (owner) =>
    users.authorId.is(owner.id),
  );
  const posts = innerJoin(owner.posts);

  return { title: posts.title };
});
type CollisionResult = Assert<
  Equal<Awaited<ReturnType<typeof collision.execute>>, { title: string }[]>
>;

eligible((eligible) =>
  (() => {
    // @ts-expect-error derived sources expose projected fields, not base-table relations
    eligible.author;

    // @ts-expect-error unselected base columns are absent
    eligible.title;

    return { authorId: eligible.authorId };
  })(),
);
model.posts((posts) => ({ authorId: posts.authorId })).as("users")((users) =>
  (() => {
    // @ts-expect-error matching a table name does not attach that table's relations
    users.posts;

    return { authorId: users.authorId };
  })(),
);
