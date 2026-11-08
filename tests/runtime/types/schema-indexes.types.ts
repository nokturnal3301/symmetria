// Compile-only API contracts: bun run test:types.
import {
  schema,
  index,
  int,
  text,
  bool,
  jsonb,
  timestamptz,
  sql,
} from "../../../packages/runtime/src";

const model = schema(
  {
    users: {
      id: int.auto,
      email: text,
      active: bool.default(true),
      metadata: jsonb<unknown>(),
    },
    posts: ({ users }) => ({
      id: int.auto,
      author: users,
      title: text,
      createdAt: timestamptz.now,
    }),
  },
  {
    indexes: ({ users, posts }) => ({
      activeEmail: index(users.email).unique.where(users.active.is(true)),
      postsByAuthor: index(
        posts.authorId,
        posts.createdAt.descending.nullsLast,
      ).include(posts.title),
      lowerEmail: index(sql<string>`lower(${users.email})`),
      usersMetadata: index(users.metadata).using("gin"),
    }),
  },
);
{
  schema(
    { records: { id: int } },
    {
      indexes: ({ records }) => ({
        // @ts-expect-error only schema columns are exposed
        invalid: index(records.missing),
      }),
    },
  );
  // @ts-expect-error an index needs at least one key
  index();
  schema(
    { records: { id: int } },
    {
      indexes: ({ records }) => ({
        // @ts-expect-error only supported methods are accepted
        invalid: index(records.id).using("unknown"),
      }),
    },
  );
}
