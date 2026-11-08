import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  self,
  index,
} from "../../../packages/runtime/src";
import { createSchemaSQL } from "../../../packages/kit/src";

const users = table({ id: int.auto, name: text, email: text.unique });
const posts = table({
  id: int.auto,
  title: text,
  author: users.by("email").column("author_email"),
  owner: users.column("created_by").nullable.inverse("owned"),
});
const model = schema({ users, posts });
const ddl = () =>
  createSchemaSQL(model.$snapshot())
    .map((statement) =>
      typeof statement === "string"
        ? statement
        : (statement as { sql: string }).sql,
    )
    .join("\n");
const column = (tableName: string, name: string) =>
  model
    .$snapshot()
    .tables.find((table) => table.name === tableName)!
    .columns.find((column) => column.name === name)!;

test("by() copies the referenced column's type and column() names the SQL column", () => {
  expect(column("posts", "authorId")).toEqual({
    name: "authorId",
    sqlName: "author_email",
    sqlType: "text",
    notNull: true,
    unique: false,
    primaryKey: false,
    references: { table: "users", column: "email", onDelete: "restrict" },
  });
  expect(column("posts", "ownerId")).toMatchObject({
    sqlName: "created_by",
    sqlType: "integer",
    notNull: false,
    references: { table: "users", column: "id" },
  });
  expect(ddl()).toContain('"author_email" text NOT NULL,');
  expect(ddl()).toContain(
    'ADD CONSTRAINT "posts_author_email_fkey" FOREIGN KEY ("author_email") REFERENCES "users" ("email") ON DELETE RESTRICT',
  );
  expect(ddl()).toContain(
    'ADD CONSTRAINT "posts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id")',
  );
});

test("joins, reverse collections and writes use the referenced column", () => {
  expect(
    model
      .posts((post) => ({ author: post.author.name, owner: post.owner.name }))
      .toSQL().sql,
  ).toContain(
    'INNER JOIN "users" AS "__symmetria_path_0" ON "posts"."author_email" = "__symmetria_path_0"."email"\nLEFT JOIN "users" AS "__symmetria_path_1" ON "posts"."created_by" = "__symmetria_path_1"."id"',
  );
  expect(
    model
      .users((user) => ({
        posts: user.posts((post) => ({ title: post.title })),
        owned: user.owned.count(),
      }))
      .toSQL().sql,
  ).toContain(
    'WHERE "users"."email" = "__symmetria_aggregate_0"."author_email"',
  );
  expect(
    model.posts
      .insert({ title: "x", authorId: "ada@example.com", ownerId: 1 })
      .toSQL(),
  ).toEqual({
    sql: 'INSERT INTO "posts" AS "posts"\n("title", "author_email", "created_by") VALUES ($1, $2, $3)',
    parameters: ["x", "ada@example.com", 1],
  });
  expect(
    model
      .posts((post, { join }) => ({ name: join(post.authorId).name }))
      .toSQL().sql,
  ).toContain('ON "posts"."author_email" = "author"."email"');
});

test("keyed links, self references and composite keys accept by() and column()", () => {
  const keyed = schema({
    users: { id: int.auto, email: text.unique, code: text.unique },
    posts: ({ users }) => ({
      id: int.auto,
      author: users.by("email").column("author_email"),
    }),
    nodes: ({ nodes }) => ({
      id: int.auto,
      code: text.unique,
      parent: nodes.by("code").column("parent_code").nullable.inverse("kids"),
    }),
    memberships: ({ users }) =>
      table({
        user: users.by("code").column("member_code"),
        role: text,
      }).primaryKey((membership) => [membership.userId, membership.role]),
  });
  const snapshot = keyed.$snapshot();
  const find = (name: string) => snapshot.tables.find((t) => t.name === name)!;

  expect(find("posts").columns.at(-1)).toMatchObject({
    name: "authorId",
    sqlName: "author_email",
    sqlType: "text",
    references: { table: "users", column: "email" },
  });
  expect(find("nodes").columns.at(-1)).toMatchObject({
    name: "parentId",
    sqlName: "parent_code",
    sqlType: "text",
    references: { table: "nodes", column: "code" },
  });
  expect(find("memberships").primaryKey).toEqual(["member_code", "role"]);
  expect(
    keyed
      .nodes((node) => ({ parent: node.parent.code, kids: node.kids.count() }))
      .toSQL().sql,
  ).toContain('ON "nodes"."parent_code" = "__symmetria_path_0"."code"');

  const standalone = table({
    id: int.auto,
    code: text.unique,
    parent: self.by("code").column("parent_code").nullable,
  });
  expect(
    schema({ standalone })
      .$snapshot()
      .tables[0]!.columns.find((column) => column.name === "parentId"),
  ).toMatchObject({ sqlName: "parent_code", sqlType: "text" });
});

test("invalid references are reported with both sides", () => {
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, author: users.by("name" as never) }),
    }),
  ).toThrow(
    /"posts\.author" references "users\.name", which must be a unique column or the primary key/,
  );
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, author: users.by("nope" as never) }),
    }),
  ).toThrow(/references "users\.nope"/);
  expect(() =>
    schema({
      users,
      posts: table({ id: int.auto, author: users.column("x".repeat(64)) }),
    }),
  ).toThrow(/column name "x{64}" is not a valid SQL identifier: .*63 bytes/);
  expect(() =>
    schema({
      users,
      posts: table({
        id: int.auto,
        title: text,
        author: users.column("title"),
      }),
    }),
  ).toThrow(/"posts" declares two columns named "title"/);
  // A unique index declared with .indexes() is not a referenceable column.
  const tenants = table({ id: int.auto, code: text }).indexes((tenant) => ({
    code: index(tenant.code).unique,
  }));
  expect(() =>
    schema({
      tenants,
      posts: table({ id: int.auto, tenant: tenants.by("code" as never) }),
    }),
  ).toThrow(/references "tenants\.code", which must be a unique column/);
});

test("automatic indexes on custom key columns are named after the SQL column", () => {
  const indexed = schema({
    users,
    posts: table({
      id: int.auto,
      author: users.by("email").column("author_email").index,
      editor: users.index.nullable.inverse("edited"),
    }),
  });
  const names = indexed
    .$snapshot()
    .tables.find((table) => table.name === "posts")!
    .indexes!.map((entry) => entry.sqlName);

  expect(names).toEqual(["posts_author_email_idx", "posts_editor_id_idx"]);
});
