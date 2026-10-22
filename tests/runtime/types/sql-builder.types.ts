// Compile-only API contracts: bun run test:types.
import {
  schema,
  int,
  text,
  bigint,
  bool,
  numeric,
  jsonb,
  timestamptz,
} from "../../../packages/runtime/src";

const model = schema({
  users: {
    id: int.auto,
    name: text.unique,
    balance: numeric(20, 2).default("0"),
    visits: int.default(0),
    active: bool.default(true),
  },
  posts: ({ users }) => ({
    id: int.auto,
    title: text,
    author: users,
    editor: users.nullable.inverse("edited"),
    views: bigint.default(0n),
    metadata: jsonb<{ tags: string[] }>().nullable,
    createdAt: timestamptz.now,
  }),
});
{
  // @ts-expect-error numeric predicates require numeric values
  model.users((users) => ({ $where: users.visits.above("1") }));
  // @ts-expect-error LIKE is not available on integer columns
  model.users((users) => ({ $where: users.visits.like("%") }));
  model.users((users) => ({
    // @ts-expect-error IN checks the selected value type
    $where: users.id.in(model.posts((posts) => ({ title: posts.title }))),
  }));
  model.users((users) => ({
    $where: users.id.in(
      // @ts-expect-error IN requires exactly one selected field
      model.posts((posts) => ({ id: posts.id, authorId: posts.authorId })),
    ),
  }));
  // @ts-expect-error scalar requires a single selected column
  model.users((users) => ({ id: users.id, name: users.name })).scalar();
  model.posts((posts, { innerJoin }) => {
    // @ts-expect-error explicit joins require ON
    const writer = innerJoin(model.users.as("writer"));

    return {};
  });
  model.posts((posts, { innerJoin }) => {
    const joined0 = innerJoin(model.posts, (joined0) => joined0.id.is(1));

    return {};
  });
  model.posts((posts, { leftJoin }) => {
    const author = leftJoin(posts.author);
    // @ts-expect-error joined users do not have an editor relationship
    const invalid = leftJoin(author.editor.as("invalid"));

    return {};
  });
  // @ts-expect-error mutation value type is checked
  model.users.update({ visits: "many" });
  // @ts-expect-error generated identities cannot be assigned through UPDATE
  model.users.update({ id: 123 });
  // @ts-expect-error upsert cannot overwrite a generated identity
  model.users.insert({ name: "Ada" }).onConflict("name").doUpdate({ id: 123 });
  // @ts-expect-error INSERT has no WHERE
  model.users.insert({ name: "Ada" }).where(() => true);
}
