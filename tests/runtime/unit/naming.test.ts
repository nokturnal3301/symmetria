import { expect, test } from "bun:test";
import {
  schema,
  table,
  junction,
  self,
  index,
  int,
  bigint,
  text,
  bool,
  oneOf,
  varchar,
  timestamptz,
} from "../../../packages/runtime/src";
import { objectName } from "../../../packages/runtime/src/schema/naming";
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

test("derived index and check names over 63 bytes are hashed like constraint names", () => {
  const longTable = "customer_subscription_billing_adjustments";
  const model = schema({
    [longTable]: table({
      id: int.auto,
      previousInvoiceReference: text.index,
      amountInMinorCurrencyUnits: int,
    })
      .indexes((rows) => ({
        byReferenceAndAmount: index(
          rows.previousInvoiceReference,
          rows.amountInMinorCurrencyUnits,
        ),
      }))
      .checks((rows) => ({
        amountInMinorCurrencyUnitsIsPositive:
          rows.amountInMinorCurrencyUnits.above(0),
      })),
  });
  const snapshot = model
    .$snapshot()
    .tables.find((entry) => entry.sqlName === longTable)!;
  const names = [
    ...snapshot.indexes!.map((entry) => entry.sqlName),
    ...snapshot.checks!.map((entry) => entry.sqlName),
  ];

  expect(names.toSorted()).toEqual(
    [
      objectName(longTable, "by_reference_and_amount", "idx"),
      objectName(longTable, "previous_invoice_reference", "idx"),
      objectName(
        longTable,
        "amount_in_minor_currency_units_is_positive",
        "check",
      ),
    ].toSorted(),
  );
  expect(names.every((name) => Buffer.byteLength(name) <= 63)).toBe(true);
  expect(names).toContainEqual(
    expect.stringMatching(
      /^customer_subscription_billing_adjustments_previous_[0-9a-f]{12}$/,
    ),
  );

  // A name written out in full is the user's choice and still has to fit.
  expect(() =>
    schema(
      { rows: { id: int.auto, label: text } },
      {
        indexes: ({ rows }) => ({ ["x".repeat(64)]: index(rows.label) }),
      },
    ),
  ).toThrow(/63 bytes/);
});

test("automatic indexes are named after the SQL column", () => {
  const model = schema({
    users: { id: int.auto },
    groups: { id: int.auto, title: text },
    posts: ({ users }) =>
      table({
        id: int.auto,
        label: text.named("Label").index,
        owner: users.column("OwnerRef").index,
      }),
    links: ({ users, groups }) =>
      junction({ left: users, right: groups.column("Right") }),
  });
  const indexes = (name: string) =>
    model
      .$snapshot()
      .tables.find((entry) => entry.name === name)!
      .indexes!.map((entry) => entry.sqlName);

  expect(indexes("posts")).toEqual(["posts_Label_idx", "posts_OwnerRef_idx"]);
  expect(indexes("links")).toEqual(["links_Right_idx"]);
});

test("enum types can be named and shared; mismatched labels are rejected", () => {
  const role = oneOf("USER", "ADMIN").typeName("Role");
  const model = schema({
    users: { id: int.auto, role: role.default("USER") },
    invites: { id: int.auto, role, previousRole: role.nullable },
  });
  const columns = model
    .$snapshot()
    .tables.flatMap((entry) => entry.columns)
    .filter((column) => column.sqlType === "enum");

  expect(columns.map((column) => column.enumerationName)).toEqual([
    "Role",
    "Role",
    "Role",
  ]);
  expect(ddl(model).match(/CREATE TYPE/g)).toHaveLength(1);
  expect(ddl(model)).toContain(
    `CREATE TYPE "Role" AS ENUM (E'USER', E'ADMIN')`,
  );
  expect(ddl(model)).toContain(`"role" "Role" DEFAULT E'USER' NOT NULL`);
  // Queries compare enum columns with untyped parameters, whatever the type's name.
  expect(
    model
      .invites((invite) => ({ id: invite.id }), {
        where: ({ role }) => role.is("ADMIN"),
      })
      .toSQL().sql,
  ).toContain('WHERE "invites"."role" = $1');

  expect(() =>
    schema({
      users: { id: int.auto, role },
      invites: { id: int.auto, role: oneOf("ADMIN", "USER").typeName("Role") },
    }),
  ).toThrow(
    /enum type "Role" has different labels on "users.role" \("USER", "ADMIN"\) and "invites.role" \("ADMIN", "USER"\)/,
  );
  expect(() => oneOf("a").typeName("")).toThrow(/typeName\(\) expects/);
  expect(() => oneOf("a").typeName("x".repeat(64))).toThrow(
    /typeName\(\) expects/,
  );
});

test("collations apply to text columns, arrays and the foreign keys that reference them", () => {
  const model = schema({
    codes: {
      id: int.auto,
      code: text.collate("C").unique,
      label: varchar(20).collate("en-x-icu").nullable,
      tags: text.collate("C").array,
    },
    uses: ({ codes }) => ({ id: int.auto, code: codes.by("code") }),
  });

  expect(ddl(model)).toContain(`"code" text COLLATE "C" NOT NULL`);
  expect(ddl(model)).toContain(`"label" varchar(20) COLLATE "en-x-icu"`);
  expect(ddl(model)).toContain(`"tags" text[] COLLATE "C" NOT NULL`);
  expect(ddl(model)).toContain(`"code_id" text COLLATE "C" NOT NULL`);
  expect(() => int.collate("C")).toThrow(/collate\(\) needs a text column/);
  expect(() => oneOf("a").collate("C")).toThrow(/needs a text column/);
  expect(() => text.collate("")).toThrow(/collate\(\) expects/);
});

test("identity columns are GENERATED ALWAYS, or BY DEFAULT to accept explicit ids", () => {
  const model = schema({
    always: { id: int.auto, label: text },
    byDefault: { id: bigint.auto.byDefault, label: text },
  });

  expect(ddl(model)).toContain(`"id" integer GENERATED ALWAYS AS IDENTITY`);
  expect(ddl(model)).toContain(`"id" bigint GENERATED BY DEFAULT AS IDENTITY`);
  expect(model.byDefault.insert({ id: 7n, label: "x" }).toSQL().sql).toBe(
    'INSERT INTO "by_default" AS "byDefault"\n("id", "label") VALUES ($1, $2)',
  );
  expect(() =>
    model.always.insert({ id: 7, label: "x" } as never).toSQL(),
  ).toThrow(/generated always/);
  expect(() => (int as unknown as { byDefault: unknown }).byDefault).toThrow(
    /byDefault follows auto/,
  );
});
