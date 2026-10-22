import { expect, test } from "bun:test";
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
  type SelectedColumn,
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

test("column scopes remain enumerable, immutable and specific to their alias binding", () => {
  let captured: SelectedColumn | undefined;
  const first = database.users.as("writers")((writers) =>
    (() => {
      expect(Object.isFrozen(writers)).toBe(true);

      expect(Object.keys(writers)).toEqual([
        "id",
        "name",
        "nickname",
        "upperName",
      ]);

      const copied = { ...writers };

      expect(copied.id).toBe(writers.id);

      expect(copied.upperName).toBe(writers.upperName);

      captured = copied.id;

      expect(Reflect.set(writers, "id", copied.name)).toBe(false);

      return {
        id: copied.id,
        name: copied.name,
        nickname: copied.nickname,
        upperName: copied.upperName,
      };
    })(),
  );
  const compiled = first.toSQL();
  expect(compiled.sql).toContain('upper("writers"."name")');
  expect(() =>
    database.users.as("writers")((writers) => ({ value: captured! })),
  ).toThrow(/another query scope/);
  expect(first.toSQL()).toEqual(compiled);
});

test("shape projections preserve exact inference, computed fields and root aliases", () => {
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
  expect(query.toSQL().sql).toStartWith(
    'SELECT "users"."id" AS "id", "users"."name" AS "name", upper("users"."name") AS "upperName"',
  );
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
  expect(aliased.toSQL().sql).toStartWith(
    'SELECT "articles"."title" AS "title", "articles"."id" AS "id"',
  );
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
  expect(derived.scalar()).toBeDefined();
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
  expect(related.toSQL().parameters).toEqual([]);
  expect(related.toSQL().sql).toContain("LIMIT 2");
  const tree = schema({
    nodes: ({ nodes }) => ({
      id: int,
      title: text,
      parent: nodes.nullable.inverse("children"),
    }),
  });
  expect(
    tree.nodes
      .as("root")((root, { join }) => {
        const parent = join(root.parent);

        return { title: root.title };
      })
      .toSQL().sql,
  ).toStartWith('SELECT "root"."title"');
  expect(() => database.users((users) => ({}))).toThrow(/at least one/);
  // @ts-expect-error no unknown column names
  expect(() => database.users((users) => ({ missing: users.missing }))).toThrow(
    /selected fields/,
  );
});

test("byId selects the full row and composes with projections, relations and prepared parameters", async () => {
  const connected = schema(
    { users, posts },
    {
      executor: async () => [
        { id: 7, name: "Ada", nickname: null, upperName: "ADA" },
      ],
    },
  );
  const query = connected.users.byId(7);
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.one>>,
      { id: number; name: string; nickname: string | null; upperName: string }
    >
  >;
  expect(await query.one()).toEqual({
    id: 7,
    name: "Ada",
    nickname: null,
    upperName: "ADA",
  });
  expect(query.toSQL().parameters).toEqual([7]);
  expect(query((users) => ({ name: users.name })).toSQL().sql).toStartWith(
    'SELECT "users"."name"',
  );
  expect(
    database.posts
      .byId(2)((posts) => ({ author: posts.author.name }))
      .toSQL().sql,
  ).toContain('INNER JOIN "users"');
  const prepared = prepare({ identifier: int }, (parameters) =>
    database.users.byId(parameters.identifier)((users) => ({
      name: users.name,
    })),
  );
  expect(prepared.toSQL({ identifier: 7 }).parameters).toEqual([7]);
  expect(
    database.users((users) => ({ id: users.id })).toSQL().sql,
  ).not.toContain("WHERE");
});

test("byId follows non-id, composite and inferred junction primary keys and encodes custom values", () => {
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
  expect(keyed.countries.byId("FR").toSQL().parameters).toEqual(["fr"]);
  expect(keyed.countries.byId("FR").toSQL().sql).toContain(
    '"countries"."code" = $1',
  );
  const query = keyed.memberships.byId({ tenantId: 2, personId: 4 })(
    (memberships) => ({ role: memberships.role }),
  );
  expect(query.toSQL().parameters).toEqual([2, 4]);
  expect(query.toSQL().sql).toContain(
    '"tenant_id" = $1 AND "memberships"."person_id" = $2',
  );
  expect(
    keyed.postTags.byId({ tagId: 2, postId: 4 }).toSQL().parameters,
  ).toEqual([2, 4]);
  // @ts-expect-error keyless tables cannot use byId
  expect(() => keyed.events.byId(1)).toThrow(/primary key/);
  // @ts-expect-error composite keys need every component
  expect(() => keyed.memberships.byId({ tenantId: 2 })).toThrow(/exactly/);
  expect(() =>
    // @ts-expect-error extra components are rejected
    keyed.memberships.byId({ tenantId: 2, personId: 4, role: "admin" }),
  ).toThrow(/exactly/);
});
