// Compile-only API contracts: bun run test:types.
import {
  junction,
  schema,
  table,
  int,
  text,
  bigint,
  timestamptz,
  customType,
  sql,
  prepare,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

const users = table({
  id: int.auto,
  name: text,
  nickname: text.nullable,
}).computed((users) => ({ upperName: sql<string>`upper(${users.name})` }));
const posts = table({
  id: int.auto,
  author: users,
  title: text,
  createdAt: timestamptz,
  views: bigint,
});
const database = schema({ users, posts });
{
  const query = database.users((users) => ({
    id: users.id,
    name: users.name,
    upperName: users.upperName,
  }));
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { id: number; name: string; upperName: string }[]
    >
  >;
  const aliased = database.posts.as("articles")((articles, { join }) => {
    const author = join(articles.author);

    return { title: articles.title, id: articles.id };
  });
  type Aliased = Assert<
    Equal<
      Awaited<ReturnType<typeof aliased.execute>>,
      { title: string; id: number }[]
    >
  >;
  const narrowed = database.users((users, { whereNotNull }) => {
    const nickname = whereNotNull(users.nickname);

    return { nickname };
  });
  type Narrowed = Assert<
    Equal<Awaited<ReturnType<typeof narrowed.execute>>, { nickname: string }[]>
  >;
  const derived = query.as("people")((people) => ({
    upperName: people.upperName,
  }));
  type Derived = Assert<
    Equal<Awaited<ReturnType<typeof derived.execute>>, { upperName: string }[]>
  >;
  const related = database.users((users) => ({
    posts: users.posts((posts) => ({
      title: posts.title,
      views: posts.views,
      $orderBy: posts.id.descending,
      $limit: 2,
    })),
  }));
  type Related = Assert<
    Equal<
      Awaited<ReturnType<typeof related.execute>>,
      { posts: { title: string; views: bigint }[] }[]
    >
  >;
  const tree = schema({
    nodes: ({ nodes }) => ({
      id: int,
      title: text,
      parent: nodes.nullable.inverse("children"),
    }),
  });
  const selfJoin = tree.nodes.as("root")((root, { join }) => {
    const parent = join(root.parent);

    return { title: root.title };
  });
  type SelfJoin = Assert<
    Equal<Awaited<ReturnType<typeof selfJoin.execute>>, { title: string }[]>
  >;
  // @ts-expect-error a controls-only query cannot execute without selected fields
  database.users((users) => ({ $where: users.id.above(0) })).execute();
  // @ts-expect-error no unknown column names
  database.users((users) => ({ missing: users.missing }));

  {
    database.posts((posts, { join }) => {
      const author = join(posts.author);

      // @ts-expect-error columns belong to their source, not a joined table
      return { name: posts.name };
    });
    database.users((users) => ({
      // @ts-expect-error related selection checks target column names
      posts: users.posts((posts) => ({ missing: posts.missing })),
    }));
    // @ts-expect-error relations themselves are not scalar column names
    database.posts((posts) => ({ author: posts.author }));
  }
}

{
  const query = database.users.byId(7);
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.one>>,
      { id: number; name: string; nickname: string | null; upperName: string }
    >
  >;
  const prepared = prepare({ identifier: int }, (parameters) =>
    database.users.byId(parameters.identifier)((users) => ({
      name: users.name,
    })),
  );
  type PreparedLookup = Assert<
    Equal<Awaited<ReturnType<typeof prepared.execute>>, { name: string }[]>
  >;

  {
    // @ts-expect-error primary key is numeric
    database.users.byId("7");
    // @ts-expect-error primary keys cannot be null
    database.users.byId(null);
  }
}

{
  const identifier = customType<string>("text", {
    encode: (value) => value.toLowerCase(),
    decode: (value) => String(value).toUpperCase(),
  });
  const keyed = schema({
    countries: { code: identifier.primaryKey, label: text },
    memberships: table({ tenantId: int, personId: int, role: text }).primaryKey(
      (membership) => [membership.tenantId, membership.personId],
    ),
    tags: { id: int },
    posts: { id: int },
    postTags: ({ tags, posts }) => junction({ tag: tags, post: posts }),
    events: { description: text },
  });
  keyed.countries.byId("FR");
  const query = keyed.memberships.byId({ tenantId: 2, personId: 4 })(
    (memberships) => ({ role: memberships.role }),
  );
  type CompositeLookup = Assert<
    Equal<Awaited<ReturnType<typeof query.execute>>, { role: string }[]>
  >;
  keyed.postTags.byId({ tagId: 2, postId: 4 });
  // @ts-expect-error keyless tables cannot use byId
  keyed.events.byId(1);
  // @ts-expect-error composite keys need every component
  keyed.memberships.byId({ tenantId: 2 });
  // @ts-expect-error extra components are rejected
  keyed.memberships.byId({ tenantId: 2, personId: 4, role: "admin" });

  {
    // @ts-expect-error named text primary key
    keyed.countries.byId(1);
    // @ts-expect-error composite key component types are checked
    keyed.memberships.byId({ tenantId: "2", personId: 4 });
  }
}
