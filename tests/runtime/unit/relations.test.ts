import { expect, test } from "bun:test";
import {
  junction,
  schema,
  table,
  int,
  text,
  bool,
  bigint,
  timestamptz,
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

const countries = table({ code: text.primaryKey, label: text });
const users = table({
  id: int.auto,
  name: text,
  country: countries.nullable,
}).computed((users) => ({ upperName: sql<string>`upper(${users.name})` }));
const posts = table({
  id: int.auto,
  title: text,
  author: users,
  editor: users.nullable.inverse("edited"),
  published: bool,
  visits: bigint,
  createdAt: timestamptz,
});
const profiles = table({ id: int.auto, user: users.unique, bio: text });
const tags = table({ id: int.auto, label: text });
const postTags = junction({ post: posts, tag: tags });
const model = schema({ countries, users, posts, profiles, tags, postTags });

test("automatic paths infer nullable ancestry and deduplicate joins across query clauses", () => {
  const query = model.posts((posts) => ({
    title: posts.title,
    author: posts.author.name,
    upper: posts.author.upperName,
    country: posts.author.country.label,
    editor: posts.editor.name,
    editorCountry: posts.editor.country.label,
    $where: posts.author.name.is("Ada"),
    $orderBy: posts.author.name.ascending,
  }));
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      {
        title: string;
        author: string;
        upper: string;
        country: string | null;
        editor: string | null;
        editorCountry: string | null;
      }[]
    >
  >;
  const compiled = query.toSQL();
  expect(compiled.sql.match(/INNER JOIN/g)).toHaveLength(1);
  expect(compiled.sql.match(/LEFT JOIN/g)).toHaveLength(3);
  expect(compiled.sql).toContain('"country_id" = "__symmetria_path_1"."code"');
  expect(compiled.sql).toContain('upper("__symmetria_path_0"."name")');
  expect(compiled.parameters).toEqual(["Ada"]);
  expect(
    model.posts((posts) => ({ title: posts.title })).toSQL().sql,
  ).not.toContain("JOIN");
  const explicit = model.posts((posts, { join }) => {
    const author = join(posts.author);

    return {
      first: posts.author.name,
      second: author.name,
    };
  });
  expect(explicit.toSQL().sql.match(/JOIN/g)).toHaveLength(1);
  expect(
    model
      .posts((posts, { join }) => {
        const country = join(posts.author.country);

        return { label: country.label };
      })
      .toSQL()
      .sql.match(/JOIN/g),
  ).toHaveLength(2);
});

test("nested collections preserve shape, codecs, per-parent limit and independent siblings", async () => {
  const database = schema(
    { countries, users, posts, profiles, tags, postTags },
    {
      executor: async () => [
        {
          name: "Ada",
          recent: [
            {
              title: "One",
              visits: "9007199254740993",
              createdAt: "2026-01-01T00:00:00.000Z",
              author: "Ada",
              tags: [{ label: "sql" }],
            },
          ],
          all: [],
        },
      ],
    },
  );
  const query = database.users((users) => ({
    name: users.name,
    recent: users.posts((posts) => ({
      title: posts.title,
      visits: posts.visits,
      createdAt: posts.createdAt,
      author: posts.author.name,
      tags: posts.tags((tags) => ({ label: tags.label })),
      $where: posts.published.is(true),
      $orderBy: posts.id.descending,
      $limit: 3,
    })),
    all: users.posts((posts) => ({ id: posts.id })),
  }));
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      {
        name: string;
        recent: {
          title: string;
          visits: bigint;
          createdAt: Date;
          author: string;
          tags: { label: string }[];
        }[];
        all: { id: number }[];
      }[]
    >
  >;
  const compiled = query.toSQL();
  expect(compiled.sql).toContain("json_agg");
  expect(compiled.sql).toContain("ORDER BY");
  expect(compiled.parameters).toEqual([true]);
  expect(await query.one()).toEqual({
    name: "Ada",
    recent: [
      {
        title: "One",
        visits: 9007199254740993n,
        createdAt: new Date("2026-01-01"),
        author: "Ada",
        tags: [{ label: "sql" }],
      },
    ],
    all: [],
  });
});

test("reverse one paths, self references and method-name columns are accessible", () => {
  const reverse = model.users((users) => ({
    bio: users.profiles.bio,
  }));
  type Reverse = Assert<
    Equal<Awaited<ReturnType<typeof reverse.execute>>, { bio: string | null }[]>
  >;
  expect(reverse.toSQL().sql).toContain('LEFT JOIN "profiles"');
  const tree = schema({
    nodes: ({ nodes }) => ({
      id: int.auto,
      name: text,
      parent: nodes.nullable.inverse("children"),
    }),
  });
  const query = tree.nodes((nodes) => ({
    grandparent: nodes.parent.parent.name,
    children: nodes.children((children) => ({
      name: children.name,
      grandchildren: children.children((children) => ({ name: children.name })),
    })),
  }));
  type Tree = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      {
        grandparent: string | null;
        children: { name: string; grandchildren: { name: string }[] }[];
      }[]
    >
  >;
  expect(query.toSQL().sql).toContain('"__symmetria_aggregate_1"');
  const reserved = schema({
    owners: { id: int, count: int },
    items: ({ owners }) => ({ id: int, owner: owners }),
  });
  expect(
    reserved
      .items((items) => ({
        owner: items.owner((owner) => ({ count: owner.count })),
      }))
      .toSQL().sql,
  ).toContain('"count"');
});

test("quantifiers use EXISTS and every treats SQL NULL as a counterexample", () => {
  const query = model.users((users) => ({
    id: users.id,
    $where: [
      users.posts.some((posts) =>
        posts.tags.none((tags) => tags.label.is("hidden")),
      ),
      users.posts.every((posts) => posts.editor.name.is("Ada")),
    ],
  }));
  expect(query.toSQL().sql).toContain("NOT EXISTS");
  expect(query.toSQL().sql).toContain("IS NOT TRUE");
  expect(query.toSQL().parameters).toEqual(["hidden", "Ada"]);
  const paged = model.users((users) => ({
    count: users.posts((posts) => ({ $limit: 2, $offset: 1 })).count(),
    present: users.posts((posts) => ({ $limit: 0 })).exists(),
  }));
  expect(paged.toSQL().sql).toContain('AS "__symmetria_count"');
  expect(paged.toSQL().parameters).toEqual([]);
  expect(paged.toSQL().sql).toContain("LIMIT 2\nOFFSET 1");
  expect(paged.toSQL().sql).toContain("LIMIT 0");
});

test("prepared relation projections keep parameters and query ownership", () => {
  const query = prepare({ name: text, size: int }, (parameters) =>
    model.users((users) => ({
      posts: users.posts((posts) => ({
        title: posts.title,
        $where: posts.author.name.is(parameters.name),
        $limit: parameters.size,
      })),
    })),
  );
  expect(query.toSQL({ name: "Ada", size: 2 }).parameters).toEqual(["Ada", 2]);
  expect(() => query.toSQL({ name: "Ada", size: -1 })).toThrow(/nonnegative/);
  let foreign!: SelectedColumn;
  model.posts((posts) =>
    (() => {
      foreign = posts.author.name;

      return { foreign: foreign };
    })(),
  );
  expect(() => model.posts((posts) => ({ foreign: foreign }))).toThrow(
    /another query scope/,
  );
  const branch = model.posts((posts) => ({ $where: posts.author.id.above(0) }));
  const expanded = branch((posts) => ({ label: posts.author.country.label }));
  expect(expanded.toSQL().sql.match(/JOIN/g)).toHaveLength(2);
  expect(
    branch((posts) => ({ title: posts.title }))
      .toSQL()
      .sql.match(/JOIN/g),
  ).toHaveLength(1);
});
