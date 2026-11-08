import { expect, test } from "bun:test";
import {
  schema,
  table,
  self,
  index,
  int,
  text,
  bool,
  timestamptz,
} from "../../../packages/runtime/src";
import { createSchemaSQL } from "../../../packages/kit/src";

const ddl = (model: {
  $snapshot: () => Parameters<typeof createSchemaSQL>[0];
}) =>
  createSchemaSQL(model.$snapshot())
    .map((statement) =>
      typeof statement === "string"
        ? statement
        : (statement as { sql: string }).sql,
    )
    .join("\n");

test('casing "preserve" produces the names a Prisma-created database uses', () => {
  const user = table({
    id: int.auto,
    email: text.unique,
    createdAt: timestamptz.now,
  }).named("User");
  const post = table({
    id: int.auto,
    title: text,
    author: user.index.onUpdate.cascade,
    viewCount: int.default(0),
  })
    .named("Post")
    .indexes((post) => ({ byTitle: index(post.title) }))
    .checks((post) => ({ positiveViews: post.viewCount.atLeast(0) }));
  const model = schema({ user, post }, { casing: "preserve" });
  const sql = ddl(model);

  expect(sql).toContain('CREATE TABLE "User"');
  expect(sql).toContain('"createdAt" timestamptz DEFAULT now() NOT NULL');
  expect(sql).toContain('CONSTRAINT "User_pkey" PRIMARY KEY ("id")');
  expect(sql).toContain('CONSTRAINT "User_email_key" UNIQUE ("email")');
  expect(sql).toContain('CONSTRAINT "Post_positiveViews_check" CHECK');
  expect(sql).toContain(
    'CREATE INDEX "Post_authorId_idx" ON "Post" USING btree ("authorId")',
  );
  expect(sql).toContain('CREATE INDEX "Post_byTitle_idx"');
  expect(sql).toContain(
    'ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE',
  );
  expect(model.$snapshot().casing).toBe("preserve");
  expect(
    model
      .post((post) => ({ title: post.title, author: post.author.email }), {
        where: (post) => post.viewCount.above(1),
      })
      .toSQL().sql,
  ).toBe(
    'SELECT "post"."title" AS "title", "__symmetria_path_0"."email" AS "author"\nFROM "Post" AS "post"\nINNER JOIN "User" AS "__symmetria_path_0" ON "post"."authorId" = "__symmetria_path_0"."id"\nWHERE "post"."viewCount" > $1',
  );
});

test(".named() and .column() set any SQL name under the default casing", () => {
  const users = table({ id: int.auto, name: text });
  const invoices = table({
    id: int.auto,
    label: text.named("CamelCol").nullable,
    tags: text.array.named("Tag List"),
    owner: users.column("ownerID"),
    parent: self.column("parent invoice").nullable,
  }).named("Invoices");
  const model = schema({ users, invoices });
  const table_ = model
    .$snapshot()
    .tables.find((entry) => entry.name === "invoices")!;

  expect(table_.sqlName).toBe("Invoices");
  expect(table_.columns.map((column) => column.sqlName)).toEqual([
    "id",
    "CamelCol",
    "Tag List",
    "ownerID",
    "parent invoice",
  ]);
  expect(
    table_.columns.find((column) => column.name === "label"),
  ).toMatchObject({ notNull: false });
  expect(
    model.invoices.insert({ label: "x", tags: ["a"], ownerId: 1 }).toSQL().sql,
  ).toBe(
    'INSERT INTO "Invoices" AS "invoices"\n("CamelCol", "Tag List", "ownerID") VALUES ($1, $2::text::text[], $3)',
  );
  // Keyed callbacks keep the SQL name too.
  expect(
    schema({
      users: { id: int.auto },
      posts: ({ users }) =>
        table({ id: int.auto, author: users.column("WrittenBy") }).named(
          "Posts",
        ),
    })
      .$snapshot()
      .tables.find((entry) => entry.name === "posts"),
  ).toMatchObject({ sqlName: "Posts" });
});

test("columns are created in declaration order, references included", () => {
  const users = table({ id: int.auto });
  const posts = table({
    id: int.auto,
    author: users,
    title: text,
    editor: users.nullable.inverse("edited"),
    published: bool,
  });

  expect(
    schema({ users, posts })
      .$snapshot()
      .tables.find((entry) => entry.name === "posts")!
      .columns.map((column) => column.sqlName),
  ).toEqual(["id", "author_id", "title", "editor_id", "published"]);
});

test("naming mistakes are reported before any SQL runs", () => {
  expect(() =>
    schema({
      users: table({ id: int.auto }),
      people: table({ id: int.auto }).named("users"),
    }),
  ).toThrow(/tables "users" and "people" both map to SQL name "users"/);
  expect(() =>
    schema({ users: { id: int.auto } }, { casing: "camel" as never }),
  ).toThrow(/casing must be "snake_case" or "preserve"/);
  expect(() => table({ id: int.auto }).named("")).toThrow(
    /named\(\) expects the table's SQL name/,
  );
  expect(() => text.named("")).toThrow(
    /named\(\) expects the column's SQL name/,
  );
  expect(() =>
    schema({
      users: table({ id: int.auto, name: text.named("x".repeat(64)) }),
    }),
  ).toThrow(/63 bytes/);
  expect(() =>
    schema({
      users: table({ id: int.auto, name: text, label: text.named("name") }),
    }),
  ).toThrow(/declares two columns named "name"/);
});

test("ON UPDATE is recorded only when it differs from NO ACTION", () => {
  const users = table({ id: int.auto });
  const model = schema({
    users,
    posts: table({
      id: int.auto,
      author: users.onUpdate.cascade,
      editor: users.nullable.onUpdate.noAction.inverse("edited"),
      reviewer: users.nullable.onUpdate.restrict.inverse("reviewed"),
    }),
    keyed: ({ users }) => ({
      id: int.auto,
      owner: users.onUpdate.cascade.inverse("owned"),
    }),
  });
  const references = (name: string) =>
    model
      .$snapshot()
      .tables.find((entry) => entry.name === name)!
      .columns.flatMap((column) =>
        column.references ? [column.references] : [],
      );

  expect(references("posts")).toEqual([
    { table: "users", column: "id", onDelete: "restrict", onUpdate: "cascade" },
    { table: "users", column: "id", onDelete: "restrict" },
    {
      table: "users",
      column: "id",
      onDelete: "restrict",
      onUpdate: "restrict",
    },
  ]);
  expect(references("keyed")).toEqual([
    { table: "users", column: "id", onDelete: "restrict", onUpdate: "cascade" },
  ]);
});
