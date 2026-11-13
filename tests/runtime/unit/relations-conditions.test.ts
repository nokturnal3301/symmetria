import { expect, test } from "bun:test";
import { schema, table, int, text, bool } from "../../../packages/runtime/src";

const users = table({
  id: int.auto,
  name: text.unique,
  active: bool.default(true),
});
const comments = table({ id: int.auto, body: text, postTitle: text });
const posts = table({
  id: int.auto,
  title: text,
  authorName: text,
  reviewerName: text.nullable,
}).relations((post, { to }) => ({
  author: to(users).one((user) => post.authorName.is(user.name)),
  mentions: to(() => comments).many((comment) =>
    comment.postTitle.is(post.title),
  ),
  reviewer: to(users)
    .one((user) => post.reviewerName.is(user.name))
    .inverse("reviewed"),
}));
const model = schema({ users, comments, posts });

test("a to-one condition relation joins LEFT on its first match by primary key", () => {
  const { sql } = model
    .posts((post) => ({ title: post.title, author: post.author.name }))
    .toSQL();

  expect(sql).toContain(
    'LEFT JOIN "users" AS "__symmetria_path_0" ON "__symmetria_path_0"."id" = (SELECT "__symmetria_path_0_2"."id" AS "id"\nFROM "users" AS "__symmetria_path_0_2"\nWHERE "posts"."author_name" = "__symmetria_path_0_2"."name"\nORDER BY "__symmetria_path_0_2"."id" ASC\nLIMIT 1)',
  );
  expect(
    model
      .posts((post, { innerJoin }) => {
        const author = innerJoin(post.author.as("author"));

        return { title: post.title, author: author.name };
      })
      .toSQL().sql,
  ).toContain(
    'INNER JOIN "users" AS "author" ON "author"."id" = (SELECT "author_2"."id" AS "id"\nFROM "users" AS "author_2"\nWHERE "posts"."author_name" = "author_2"."name"',
  );
  // Nested objects read the same first match instead of failing on a second row.
  expect(
    model
      .posts((post) => ({ author: post.author((user) => ({ id: user.id })) }))
      .toSQL().sql,
  ).toContain(
    'WHERE "__symmetria_aggregate_0"."id" = (SELECT "__symmetria_aggregate_0_2"."id" AS "id"',
  );
});

test("a to-one condition relation needs a primary key on its target", () => {
  const plain = table({ name: text, active: bool });
  const keyless = schema({
    people: plain,
    notes: table({ id: int.auto, owner: text }).relations((note, { to }) => ({
      person: to(plain).one((person) => note.owner.is(person.name)),
    })),
  });

  expect(() =>
    keyless.notes((note) => ({ person: note.person.name })).toSQL(),
  ).toThrow(
    /"notes\.person" is one\(\) and resolves to the first match by the primary key of "people", which has none/,
  );
});

test("to-many condition relations nest, aggregate and quantify through the predicate", () => {
  const nested = model
    .posts((post) => ({
      title: post.title,
      mentions: post.mentions((comment) => ({ body: comment.body })),
      total: post.mentions.count(),
    }))
    .toSQL().sql;

  expect(nested).toContain(
    'FROM "comments" AS "__symmetria_aggregate_0"\nWHERE "__symmetria_aggregate_0"."post_title" = "posts"."title"',
  );
  expect(nested).toContain("COUNT(*)");
  expect(
    model
      .posts((post) => ({ id: post.id }), {
        where: (post) => post.mentions.some((comment) => comment.body.is("x")),
      })
      .toSQL().sql,
  ).toContain("WHERE EXISTS (SELECT 1");
});

test("inverse() exposes the relation from the target table as a collection", () => {
  const { sql } = model
    .users((user) => ({
      name: user.name,
      reviewed: user.reviewed((post) => ({ title: post.title })),
    }))
    .toSQL();

  expect(sql).toContain(
    'FROM "posts" AS "__symmetria_aggregate_0"\nWHERE "__symmetria_aggregate_0"."reviewer_name" = "users"."name"',
  );
});

test("scoped predicates are ANDed into the condition JOIN", () => {
  const scoped = model.$scope({ users: (user) => user.active.is(true) });
  const { sql } = scoped
    .posts((post) => ({ author: post.author.name }))
    .toSQL();

  // The first match is picked among the rows the scope admits.
  expect(sql).toContain(
    'WHERE "posts"."author_name" = "__symmetria_path_0_2"."name" AND "__symmetria_path_0_2"."active" = $1\nORDER BY "__symmetria_path_0_2"."id" ASC\nLIMIT 1) AND "__symmetria_path_0"."active" = $2)',
  );
});

test("the snapshot records name, target and cardinality only", () => {
  const snapshot = model.$snapshot();
  const relations = snapshot.tables.find(
    (table) => table.name === "posts",
  )!.relations;

  expect(relations).toEqual([
    {
      name: "author",
      kind: "condition",
      target: "users",
      many: false,
      nullable: true,
    },
    {
      name: "mentions",
      kind: "condition",
      target: "comments",
      many: true,
      nullable: true,
    },
    {
      name: "reviewer",
      kind: "condition",
      target: "users",
      many: false,
      nullable: true,
    },
  ]);
  expect(
    snapshot.tables.find((table) => table.name === "users")!.relations,
  ).toEqual([
    {
      name: "reviewed",
      kind: "condition",
      target: "posts",
      many: true,
      nullable: true,
      reverse: true,
      inverseOf: "reviewer",
    },
  ]);
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  expect(
    snapshot.tables
      .find((table) => table.name === "posts")!
      .columns.map((column) => column.name),
  ).toEqual(["id", "title", "authorName", "reviewerName"]);
});

test("condition relations reject nested writes", () => {
  expect(() =>
    model.posts.insert({
      title: "x",
      authorName: "a",
      author: { connect: 1 },
    } as never),
  ).toThrow(
    /"posts\.author" is a condition relation; it has no foreign key to write/,
  );
});

test("keyed links, plain records and thunks all name their target", () => {
  const keyed = schema({
    users: { id: int.auto, name: text },
    posts: ({ users }) =>
      table({ id: int.auto, title: text, authorName: text }).relations(
        (post, { to }) => ({
          author: to(users).one((user) => post.authorName.is(user.name)),
        }),
      ),
  });

  expect(
    keyed.posts((post) => ({ author: post.author.name })).toSQL().sql,
  ).toContain('WHERE "posts"."author_name" = "__symmetria_path_0_2"."name"');

  const people = { id: int.auto, name: text };
  const notes = table({ id: int.auto, owner: text }).relations(
    (note, { to }) => ({
      person: to(people).one((person) => note.owner.is(person.name)),
    }),
  );
  const byRecord = schema({ people, notes });

  expect(
    byRecord.notes((note) => ({ name: note.person.name })).toSQL().sql,
  ).toContain('LEFT JOIN "people"');
});

test("declaration mistakes are reported with the table and relation", () => {
  const outside = table({ id: int.auto, name: text });

  expect(() =>
    schema({
      posts: table({ id: int.auto, authorName: text }).relations(
        (post, { to }) => ({
          author: to(outside).one((user) => post.authorName.is(user.name)),
        }),
      ),
    }),
  ).toThrow(/relation "posts\.author" points to a table outside this schema/);
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, title: text }).relations((post, { to }) => ({
        title: to(users).one((user) => post.title.is(user.name)),
      })),
    }),
  ).toThrow(/relation "posts\.title" clashes with a column of the same name/);
  // The type level reports both clashes as ambiguous relation names; the runtime explains them.
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, author: users, title: text }).relations(
        (post, { to }) => ({
          author: to(users).one((user) => post.title.is(user.name)),
        }),
      ),
    } as never),
  ).toThrow(/clashes with a column of the same name/);
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, author: users, title: text }).relations(
        (post, { to }) => ({
          byTitle: to(users)
            .one((user) => post.title.is(user.name))
            .inverse("posts"),
        }),
      ),
    } as never),
  ).toThrow(
    /relation name "posts" on "users" is ambiguous .*Rename the condition relation/,
  );
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, title: text }).relations(() => ({
        author: { kind: "nope" } as never,
      })),
    }),
  ).toThrow(/must be declared with to\(<table>\)\.one\(\.\.\.\)/);
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, title: text }).relations((post, { to }) => ({
        author: to(users).one((user) => post.title.is(user.name)),
        other: to(users).one(() => ({}) as never),
      })),
    }).posts((post) => ({ name: post.other.name })),
  ).toThrow(/expected a SQL predicate/);
  expect(() => posts.relations("nope" as never)).toThrow(
    /relations\(\) expects a callback/,
  );
});

test("relation names never shadow columns and predicates see the two tables only", () => {
  const accounts = table({ id: int.auto, name: text.unique, posts: int });
  expect(() =>
    schema({
      accounts,
      articles: table({ id: int.auto, writer: text }).relations(
        (article, { to }) => ({
          author: to(accounts)
            .one((account) => account.name.is(article.writer))
            .inverse("posts"),
        }),
      ),
    }),
  ).toThrow(
    /relation "accounts\.posts" .* clashes with a column of the same name/,
  );
  // Automatic reverse names that a column shadows are left out instead.
  expect(
    schema({ accounts, posts: table({ id: int.auto, author: accounts }) })
      .$snapshot()
      .tables.find((table) => table.name === "accounts")!
      .relations.map((relation) => relation.name),
  ).toEqual([]);

  const sloppy = schema({
    users,
    notes: table({ id: int.auto, owner: text, author: users }).relations(
      (note, { to }) => ({
        byTypo: to(users).one((user) =>
          (note as never as { ownr: typeof note.owner }).ownr.is(user.name),
        ),
        byTargetTypo: to(users).one((user) =>
          note.owner.is((user as never as { nmae: typeof user.name }).nmae),
        ),
        byPath: to(users).one((user) =>
          (
            note as never as { author: { name: typeof note.owner } }
          ).author.name.is(user.name),
        ),
      }),
    ),
  });
  expect(() => sloppy.notes((note) => ({ name: note.byTypo.name }))).toThrow(
    /"notes\.ownr" is not a column of "notes" \(did you mean "owner"\?\); relations\(\) predicates use columns of "notes" only/,
  );
  expect(() =>
    sloppy.notes((note) => ({ name: note.byTargetTypo.name })),
  ).toThrow(
    /"users\.nmae" is not a column of "users" \(did you mean "name"\?\)/,
  );
  expect(() => sloppy.notes((note) => ({ name: note.byPath.name }))).toThrow(
    /"notes\.author" is a relation; relations\(\) predicates use columns of "notes" only/,
  );
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, title: text }).relations((post, { to }) => ({
        author: to(users.by("name") as never).one((user: typeof post) =>
          user.title.is(post.title),
        ),
      })),
    }),
  ).toThrow(/to\(\) expects a table, not a reference chain/);

  // A third table's column leaks into the predicate through a closure.
  let leaked: { body: never } | undefined;
  const leaky = schema({
    users,
    comments,
    posts: table({ id: int.auto, title: text }).relations((post, { to }) => ({
      author: to(users).one((user) => user.name.is(leaked!.body)),
    })),
  });
  leaky.comments((comment) => {
    leaked = comment as never;

    return { id: comment.id };
  });
  expect(() => leaky.posts((post) => ({ name: post.author.name }))).toThrow(
    /relation "posts\.author" may only compare columns of "posts" and "users"/,
  );
});

test("write callbacks and scopes report relation paths instead of failing on undefined", () => {
  const writes = schema({
    users,
    posts: table({ id: int.auto, title: text, author: users }),
  });
  const loose = (value: unknown) => value as Record<string, any>;

  expect(() =>
    writes.posts.update((post) => ({ title: loose(post).author.name })).all(),
  ).toThrow(
    /"posts\.author" is a relation; update values use columns of "posts" only/,
  );
  expect(() =>
    writes.posts
      .insert({ title: "x", authorId: 1 })
      .returning((post) => ({ name: loose(post).author.name })),
  ).toThrow(
    /"posts\.author" is a relation; RETURNING use columns of "posts" only/,
  );
  expect(() =>
    writes
      .$scope({ posts: (post) => loose(post).author.name.is("Ada") })
      .posts((post) => ({ id: post.id })),
  ).toThrow(
    /"posts\.author" is a relation; \$scope\(\) predicates use columns/,
  );
  expect(() =>
    writes.posts((post) => ({ flag: post.id.is(1) }) as never),
  ).toThrow(/"flag" is a predicate, not a value/);
});
