import { expect, test } from "bun:test";
import { articles, model } from "../../fixtures/keyed-schema";
import { schema } from "../../../packages/runtime/src";
import {
  and,
  or,
  type CompiledQuery,
  type SelectedColumn,
} from "../../../packages/runtime/src";
import { text, uuid } from "../../../packages/runtime/src";

test("callback query emits explicit projections and distinct joins to the same table", () => {
  expect(articles.toSQL()).toEqual({
    sql: [
      'SELECT "posts"."title" AS "title", "author"."name" AS "authorName", "editor"."name" AS "editorName"',
      'FROM "posts" AS "posts"',
      'LEFT JOIN "users" AS "author" ON "posts"."author_id" = "author"."id"',
      'LEFT JOIN "users" AS "editor" ON "posts"."editor_id" = "editor"."id"',
      'WHERE "posts"."title" = $1',
      'ORDER BY "posts"."title" ASC',
      "LIMIT 20",
    ].join("\n"),
    parameters: ["Typesafe SQL"],
  });
});

test("inner join, null checks and column comparisons keep parameters in SQL order", () => {
  const compiled = model
    .posts((posts, { innerJoin }) => {
      const editor = innerJoin(posts.editor);

      return {
        title: posts.title,
        editorName: editor.name,
        $where: [
          and(posts.authorId.is(editor.id), posts.editorId.isNot(null)),
          posts.title.isNot("draft"),
        ],
        $orderBy: [editor.name.descending, posts.title.ascending],
        $limit: 0,
        $offset: 5,
      };
    })
    .toSQL();
  expect(compiled.sql).toContain(
    'INNER JOIN "users" AS "editor" ON "posts"."editor_id" = "editor"."id"',
  );
  expect(compiled.sql).toContain(
    'WHERE ("posts"."author_id" = "editor"."id" AND "posts"."editor_id" IS NOT NULL) AND "posts"."title" <> $1',
  );
  expect(compiled.sql).toContain(
    'ORDER BY "editor"."name" DESC, "posts"."title" ASC\nLIMIT 0\nOFFSET 5',
  );
  expect(compiled.parameters).toEqual(["draft"]);
});

test("reverse one-to-one and one-to-many joins use the target foreign keys", () => {
  const compiled = model
    .users((users, { leftJoin, innerJoin }) => {
      const profile = leftJoin(users.profile);
      const authored = innerJoin(users.authored);

      return { id: users.id, bio: profile.bio, title: authored.title };
    })
    .toSQL();
  expect(compiled.sql).toContain(
    'LEFT JOIN "profiles" AS "profile" ON "users"."id" = "profile"."user_id"',
  );
  expect(compiled.sql).toContain(
    'INNER JOIN "posts" AS "authored" ON "users"."id" = "authored"."author_id"',
  );
});

test("many-to-many left join expands into two left joins through the junction", () => {
  const compiled = model
    .posts((posts, { leftJoin }) => {
      const tags = leftJoin(posts.tags);

      return { title: posts.title, tagName: tags.name };
    })
    .toSQL();
  expect(compiled.sql).toBe(
    [
      'SELECT "posts"."title" AS "title", "tags"."name" AS "tagName"',
      'FROM "posts" AS "posts"',
      'LEFT JOIN "post_tags" AS "__symmetria_junction_0" ON "posts"."id" = "__symmetria_junction_0"."post_id"',
      'LEFT JOIN "tags" AS "tags" ON "__symmetria_junction_0"."tag_id" = "tags"."id"',
    ].join("\n"),
  );
  const reversed = model
    .tags((tags, { innerJoin }) => {
      const posts = innerJoin(tags.posts);

      return { title: posts.title };
    })
    .toSQL();
  expect(reversed.sql).toContain(
    'INNER JOIN "post_tags" AS "__symmetria_junction_0" ON "tags"."id" = "__symmetria_junction_0"."tag_id"',
  );
  expect(reversed.sql).toContain(
    'INNER JOIN "posts" AS "posts" ON "__symmetria_junction_0"."post_id" = "posts"."id"',
  );
});

test("self joins preserve parent and child direction", () => {
  const compiled = model
    .categories((categories, { leftJoin }) => {
      const parent = leftJoin(categories.parent);
      const children = leftJoin(categories.children);

      return {
        name: categories.name,
        parentName: parent.name,
        childName: children.name,
      };
    })
    .toSQL();
  expect(compiled.sql).toContain(
    'LEFT JOIN "categories" AS "parent" ON "categories"."parent_id" = "parent"."id"',
  );
  expect(compiled.sql).toContain(
    'LEFT JOIN "categories" AS "children" ON "categories"."id" = "children"."parent_id"',
  );
});

test("identifiers are quoted, camel case is mapped, and values stay in parameters", () => {
  const localModel = schema({ userAccounts: { id: uuid, displayName: text } });
  const suppliedValue = "'; DROP TABLE users; --";
  const compiled = localModel
    .userAccounts((userAccounts) => ({
      'public"Name': userAccounts.displayName,
      $where: userAccounts.displayName.is(suppliedValue),
    }))
    .toSQL();
  expect(compiled.sql).toBe(
    [
      'SELECT "userAccounts"."display_name" AS "public""Name"',
      'FROM "user_accounts" AS "userAccounts"',
      'WHERE "userAccounts"."display_name" = $1',
    ].join("\n"),
  );
  expect(compiled.parameters).toEqual([suppliedValue]);
  const unicodeName = "я".repeat(31);
  expect(
    localModel
      .userAccounts((userAccounts) => ({
        [unicodeName]: userAccounts.id.as(unicodeName),
      }))
      .toSQL().sql,
  ).toContain(`AS "${unicodeName}"`);

  for (const name of ["x".repeat(64), "я".repeat(32)]) {
    expect(() =>
      localModel.userAccounts((userAccounts) => ({
        [name]: userAccounts.id.as(name),
      })),
    ).toThrow(/63 bytes/);
  }

  expect(() =>
    localModel.userAccounts((userAccounts) => ({
      "bad\u0000name": userAccounts.id,
    })),
  ).toThrow(/null bytes/);
});

test("query branches, projection aliases and compiled parameter lists are independent", () => {
  const base = model.posts((posts) => ({ title: posts.title }));
  const first = base((posts) => ({
    $where: posts.title.is("first"),
    $limit: 1,
  }));
  const second = base((posts) => ({
    $where: posts.title.is("second"),
    $offset: 2,
  }));
  const renamed = first((posts) => ({ heading: posts.title }));
  expect(base.toSQL().parameters).toEqual([]);
  expect(first.toSQL().parameters).toEqual(["first"]);
  expect(second.toSQL().parameters).toEqual(["second"]);
  expect(renamed.toSQL().sql).toContain('AS "heading"');
  expect(first.toSQL().sql).toContain('AS "title"');
  first.toSQL().parameters.push("mutation");
  expect(first.toSQL().parameters).toEqual(["first"]);
});

test("OR groups preserve their parentheses when combined with successive WHERE clauses", () => {
  const compiled = model
    .posts((posts) => ({
      title: posts.title,
      $where: [
        or(posts.title.is("first"), posts.title.is("second")),
        posts.editorId.is(null),
      ],
    }))
    .toSQL();
  expect(compiled.sql).toContain(
    'WHERE ("posts"."title" = $1 OR "posts"."title" = $2) AND "posts"."editor_id" IS NULL',
  );
  expect(compiled.parameters).toEqual(["first", "second"]);
});

test("shape keys distinguish identically named columns", () => {
  expect(
    model
      .posts((posts, { leftJoin }) => {
        const author = leftJoin(posts.author);

        return { id: posts.id, authorId: author.id };
      })
      .toSQL().sql,
  ).toContain('"posts"."id" AS "id", "author"."id" AS "authorId"');
});

test("columns captured from a sibling join cannot bypass its scope or nullability", () => {
  let captured: SelectedColumn | undefined;
  model.posts((posts, { innerJoin }) => {
    const author = innerJoin(posts.author);

    return (() => {
      captured = author.name;

      return { name: author.name };
    })();
  });
  expect(() =>
    model.posts((posts, { leftJoin }) => {
      const author = leftJoin(posts.author);

      return { value: captured! };
    }),
  ).toThrow(/another query scope/);
  expect(() => model.users((users) => ({ value: captured! }))).toThrow(
    /another query scope/,
  );
});

test("invalid limits and offsets are rejected before compilation", () => {
  for (const count of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => model.posts((posts) => ({ $limit: count }))).toThrow(
      /nonnegative safe integer/,
    );
    expect(() => model.posts((posts) => ({ $offset: count }))).toThrow(
      /nonnegative safe integer/,
    );
  }
});

test("runtime rejects invalid predicates and duplicate joins even when types are bypassed", () => {
  // @ts-expect-error SQL predicates are not JavaScript booleans
  expect(() => model.posts((posts) => ({ $where: true }))).toThrow(
    /SQL predicate/,
  );
  expect(() =>
    // @ts-expect-error ordering comparisons against NULL need is(null)/isNot(null)
    model.posts((posts) => ({ $where: posts.editorId.above(null) })),
  ).toThrow(/is\(null\)/);
  expect(() =>
    model.posts((posts, { leftJoin }) => {
      const author = leftJoin(posts.author.as("author"));
      const repeated = leftJoin(posts.author.as("author"));

      return {};
    }),
  ).toThrow(/duplicate query alias/);
  expect(() =>
    model.posts((posts, { leftJoin }) => {
      // @ts-expect-error only real relations are accepted
      const nonexistent = leftJoin(posts.nonexistent);

      return {};
    }),
  ).toThrow(/expects/);
  // @ts-expect-error compilation requires a projection
  expect(() => model.posts.toSQL()).toThrow(/select/);
});

test("execution is explicit and passes the compiled query to the configured adapter", async () => {
  const calls: CompiledQuery[] = [];
  const localModel = schema(
    { users: { id: uuid, name: text } },
    {
      executor: async (query) => {
        calls.push(query);

        return [{ displayName: "Ada" }];
      },
    },
  );
  const query = localModel.users((users) => ({
    displayName: users.name,
    $where: users.name.is("Ada"),
  }));
  const compiled = query.toSQL();
  expect(calls).toHaveLength(0);
  expect(await query.execute()).toEqual([{ displayName: "Ada" }]);
  expect(calls).toEqual([compiled]);
});

test("missing adapters and adapter failures are surfaced", async () => {
  await expect(articles.execute()).rejects.toThrow(
    /configure a query executor/,
  );
  const failure = new Error("database unavailable");
  const localModel = schema(
    { users: { id: uuid } },
    {
      executor: async () => {
        throw failure;
      },
    },
  );
  await expect(
    localModel.users((users) => ({ id: users.id })).execute(),
  ).rejects.toBe(failure);
});
