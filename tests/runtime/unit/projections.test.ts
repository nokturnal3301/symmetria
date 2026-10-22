import { expect, test } from "bun:test";
import {
  table,
  schema,
  int,
  uuid,
  text,
  bigint,
  jsonb,
  oneOf,
  timestamptz,
  sql,
  when,
  and,
  or,
  index,
  type QueryColumn,
  type Branded,
} from "../../../packages/runtime/src";
import { SCHEMA_BIND } from "../../../packages/runtime/src/schema/binding";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

test("modular references preserve names, codecs, inverse names and immutable reuse", () => {
  const users = table({ id: uuid.v4.brand("UserId"), name: text });
  const posts = table({
    id: int.auto,
    title: text,
    author: users.index,
    editor: users.nullable.inverse("edited"),
  });
  const model = schema({ users, posts });
  type Row = Assert<
    Equal<
      typeof model.posts.$row,
      {
        id: number;
        title: string;
        authorId: Branded<string, "UserId">;
        editorId: Branded<string, "UserId"> | null;
      }
    >
  >;
  expect(
    model
      .posts((posts, { innerJoin }) => {
        const author = innerJoin(posts.author);

        return { name: author.name };
      })
      .toSQL().sql,
  ).toContain('"posts"."author_id" = "author"."id"');
  expect(
    model
      .users((users, { innerJoin }) => {
        const edited = innerJoin(users.edited);

        return { title: edited.title };
      })
      .toSQL().sql,
  ).toContain('"edited"."editor_id"');
  expect(schema({ users, posts }).$snapshot()).toEqual(model.$snapshot());
  expect(
    model
      .$snapshot()
      .tables.find((table) => table.name === "posts")
      ?.columns.find((column) => column.name === "authorId")?.sqlType,
  ).toBe("uuid");
});

test("rebinding a schema retains compiled metadata and isolates executors", async () => {
  let declarations = 0;
  const model = schema({
    users: table({ id: int, name: text }).indexes((users) => {
      declarations++;

      return { name: index(users.name) };
    }),
  });
  let closes = 0;
  const first = model[SCHEMA_BIND]({
    execute: async () => [{ name: "first" }],
    close: async () => {
      closes++;
    },
  });
  const second = model[SCHEMA_BIND]({
    execute: async () => [{ name: "second" }],
    close: async () => {},
  });
  expect(await first.users((users) => ({ name: users.name })).one()).toEqual({
    name: "first",
  });
  expect(await second.users((users) => ({ name: users.name })).one()).toEqual({
    name: "second",
  });
  expect(declarations).toBe(1);
  await first.$close();
  expect(closes).toBe(1);
});

test("computed expressions rebind through aliases, joins and prepared queries", () => {
  const users = table({ id: int, firstName: text, lastName: text }).computed(
    (users) => ({
      fullName: sql<string>`concat_ws(' ', ${users.firstName}, ${users.lastName})`,
    }),
  );
  const posts = table({ id: int, title: text, author: users });
  const model = schema({ users, posts });
  const query = model.users
    .as("writers")((writers) => ({ fullName: writers.fullName }))
    .prepare();
  expect(query.toSQL().sql).toContain(
    'concat_ws(\' \', "writers"."first_name", "writers"."last_name")',
  );
  expect(
    model
      .posts((posts, { innerJoin }) => {
        const author = innerJoin(posts.author);

        return { fullName: author.fullName };
      })
      .toSQL().sql,
  ).toContain('"author"."first_name"');
  expect(
    model
      .$snapshot()
      .tables.find((table) => table.name === "users")
      ?.columns.map((column) => column.name),
  ).toEqual(["id", "firstName", "lastName"]);
});

test("object projections preserve nested values and decode bigint and timestamps", async () => {
  const model = schema(
    {
      users: {
        id: int,
        visits: bigint,
        joinedAt: timestamptz,
        name: text.nullable,
      },
    },
    {
      executor: async () => [
        {
          label: null,
          statistics: {
            visits: "9007199254740993",
            joined: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    },
  );
  const query = model.users((users) => ({
    label: users.name,
    statistics: { visits: users.visits, joined: users.joinedAt },
  }));
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { label: string | null; statistics: { visits: bigint; joined: Date } }[]
    >
  >;
  expect(query.toSQL().sql).toContain(
    'json_build_object(\'visits\', ("users"."visits")::text',
  );
  expect(await query.one()).toEqual({
    label: null,
    statistics: { visits: 9007199254740993n, joined: new Date("2026-01-01") },
  });
});

test("decoding preserves special projection keys without mutating driver rows", async () => {
  const stored = JSON.parse(`{
    "__proto__": "9007199254740993",
    "constructor": null,
    "nested": { "__proto__": "9007199254740994" },
    "children": [{ "__proto__": "9007199254740995" }]
  }`);
  const model = schema(
    {
      parents: { id: int, visits: bigint, label: text.nullable },
      children: ({ parents }) => ({ id: int, parent: parents, visits: bigint }),
    },
    { executor: async () => [stored] },
  );
  const query = model.parents((parents) => ({
    ["__proto__"]: parents.visits,
    constructor: parents.label,
    nested: { ["__proto__"]: parents.visits },
    children: parents.children((children) => ({
      ["__proto__"]: children.visits,
    })),
  }));
  const first = await query.one();
  const second = await query.one();
  expect(first).toEqual({
    ["__proto__"]: 9007199254740993n,
    constructor: null,
    nested: { ["__proto__"]: 9007199254740994n },
    children: [{ ["__proto__"]: 9007199254740995n }],
  });

  for (const row of [first, first.nested, first.children[0]!]) {
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.hasOwn(row, "__proto__")).toBe(true);
  }

  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.children[0]).not.toBe(first.children[0]);
  expect(stored.__proto__).toBe("9007199254740993");
  expect(stored.nested.__proto__).toBe("9007199254740994");
  expect(stored.children[0].__proto__).toBe("9007199254740995");
});

test("conditional predicates preserve false and zero and enum properties are typed", () => {
  const model = schema({
    records: { id: int, state: oneOf("draft", "published") },
  });
  const query = model.records((records) => ({
    id: records.id,
    $where: and(
      records.state.is.published,
      when(0, (value) => records.id.is(value)),
      when(undefined, () => records.id.is(9)),
    ),
  }));
  expect(query.toSQL().parameters).toEqual(["published", 0]);
  expect(
    model.records((records) => ({ id: records.id, $where: or() })).toSQL().sql,
  ).toContain("WHERE FALSE");
});

test("JSON paths are parameterized and compared as JSON values", () => {
  const model = schema({
    records: {
      id: int,
      metadata: jsonb<{ settings?: { theme: string }; tags: string[] }>(),
    },
  });
  const query = model.records((records) => ({
    theme: records.metadata.path("settings", "theme").as("theme"),
    $where: records.metadata.path("tags").contains(["sql"]),
  }));
  expect(query.toSQL().parameters).toEqual([
    "settings",
    "theme",
    "tags",
    '["sql"]',
  ]);
  expect(query.toSQL().sql).toContain("@> $4::text::jsonb");
});

test("whereNotNull narrows only the selected column, including nullable joined rows", () => {
  const model = schema({
    users: { id: int, name: text },
    posts: ({ users }) => ({
      id: int,
      author: users.nullable,
      publishedAt: timestamptz.nullable,
    }),
  });
  const query = model.posts((posts, { leftJoin, whereNotNull }) => {
    const author = leftJoin(posts.author);
    const required1 = whereNotNull(author.id);
    const required2 = whereNotNull(posts.publishedAt);

    return { publishedAt: required2, id: required1, name: author.name };
  });
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { publishedAt: Date; id: number; name: string | null }[]
    >
  >;
  expect(query.toSQL().sql).toContain('"author"."id" IS NOT NULL');
});

test("relation aggregates correlate without multiplying root rows", () => {
  const model = schema({
    users: { id: int, name: text },
    posts: ({ users }) => ({
      id: int,
      author: users,
      state: oneOf("draft", "published"),
    }),
  });
  const query = model.users((users) => ({
    name: users.name,
    publishedCount: users
      .posts((posts) => ({ $where: posts.state.is.published }))
      .count()
      .as("publishedCount"),
    hasPosts: users.posts.exists().as("hasPosts"),
  }));
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { name: string; publishedCount: number; hasPosts: boolean }[]
    >
  >;
  expect(query.toSQL().sql).toContain(
    '"users"."id" = "__symmetria_aggregate_0"."author_id"',
  );
  expect(query.toSQL().parameters).toEqual(["published"]);
});

test("JOIN callbacks discover relations, multi-hop targets and explicit aliases", () => {
  const model = schema({
    countries: { id: int, label: text },
    users: ({ countries }) => ({
      id: int,
      name: text,
      country: countries.nullable,
    }),
    posts: ({ users }) => ({
      id: int,
      title: text,
      author: users,
      editor: users.nullable.inverse("edited"),
    }),
  });
  const query = model.posts((posts, { innerJoin, leftJoin }) => {
    const author = innerJoin(posts.author);
    const country = leftJoin(author.country);
    const reviewer = leftJoin(posts.editor.as("reviewer"));

    return {
      title: posts.title,
      author: author.name,
      country: country.label,
      reviewer: reviewer.name,
    };
  });
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      {
        title: string;
        author: string;
        country: string | null;
        reviewer: string | null;
      }[]
    >
  >;
  expect(query.toSQL().sql).toContain(
    'LEFT JOIN "countries" AS "country" ON "author"."country_id" = "country"."id"',
  );
  expect(query.toSQL().sql).toContain('LEFT JOIN "users" AS "reviewer"');
});

test("smart JOIN chooses INNER for required forward relations and preserves optional ancestry", () => {
  const model = schema({
    countries: { id: int, label: text },
    users: ({ countries }) => ({ id: int, name: text, country: countries }),
    posts: ({ users }) => ({
      id: int,
      title: text,
      author: users,
      editor: users.nullable.inverse("edited"),
    }),
  });
  const query = model.posts((posts, { join, whereNotNull }) => {
    const author = join(posts.author);
    const editor = join(posts.editor);
    const authorCountry = join(author.country.as("authorCountry"));
    const required3 = whereNotNull(editor.id);
    const editorCountry = join(editor.country.as("editorCountry"));

    return {
      author: author.name,
      editor: editor.name,
      authorCountry: authorCountry.label,
      editorCountry: editorCountry.label,
    };
  });
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      {
        author: string;
        editor: string | null;
        authorCountry: string;
        editorCountry: string | null;
      }[]
    >
  >;
  expect(query.toSQL().sql).toContain('INNER JOIN "users" AS "author"');
  expect(query.toSQL().sql).toContain('LEFT JOIN "users" AS "editor"');
  expect(query.toSQL().sql).toContain(
    'INNER JOIN "countries" AS "authorCountry"',
  );
  expect(query.toSQL().sql).toContain(
    'LEFT JOIN "countries" AS "editorCountry"',
  );
  const reverse = model.users((users, { join }) => {
    const posts = join(users.posts);

    return { title: posts.title };
  });
  type Reverse = Assert<
    Equal<
      Awaited<ReturnType<typeof reverse.execute>>,
      { title: string | null }[]
    >
  >;
  expect(reverse.toSQL().sql).toContain('LEFT JOIN "posts"');
});

test("upsert column shorthand emits excluded assignments and cardinality checks reject duplicates", async () => {
  const model = schema(
    { users: { id: int.auto, email: text.unique, name: text } },
    { executor: async () => [{ id: 1 }, { id: 2 }] },
  );
  expect(
    model.users
      .insert({ email: "a", name: "A" })
      .onConflict("email")
      .doUpdate("name")
      .toSQL().sql,
  ).toContain('DO UPDATE SET "name" = "excluded"."name"');
  const query = model.users((users) => ({ id: users.id }));
  await expect(query.one()).rejects.toThrow(/exactly one/);
  await expect(query.maybeOne()).rejects.toThrow(/at most one/);
});
