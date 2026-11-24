import { expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  and,
  int,
  text,
  uuid,
  numeric,
  customType,
  real,
  bytea,
  sql,
} from "../../../packages/runtime/src";
import {
  createSchemaSQL,
  diffSchemas,
  migrationSnapshot,
  parseMigrationSnapshot,
  emptySnapshot,
} from "../../../packages/kit/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

test("index shorthand follows modifiers, links and immutable declarations", () => {
  const indexedText = text.index;
  const database = schema({
    users: {
      id: uuid.v4,
      name: indexedText.nullable,
      email: text.index.unique,
    },
    posts: ({ users }) => ({
      id: int.auto,
      author: users.index.nullable,
      title: text.default("new").index,
    }),
  });
  expect(text.definition.index).toBeUndefined();
  expect(
    database
      .$createIndexes()
      .toSQL()
      .map((query) => query.sql),
  ).toEqual([
    'CREATE INDEX "posts_title_idx" ON "posts" USING btree ("title")',
    'CREATE INDEX "posts_author_id_idx" ON "posts" USING btree ("author_id")',
    'CREATE INDEX "users_name_idx" ON "users" USING btree ("name")',
  ]);
  expect(() =>
    schema({
      users: table({ id: int, name: text.index }).indexes((users) => ({
        name: index(users.name),
      })),
    }),
  ).toThrow(/duplicate SQL index/);
});

test("checks compile to DDL and diff reversibly with renamed and changed columns", () => {
  const products = table({
    id: int.auto,
    price: numeric(12, 2),
    stock: int.default(0),
  });
  const initial = schema({ products });
  const checked = schema({
    products: products.checks((products) => ({
      positivePrice: products.price.above("0"),
      nonnegativeStock: products.stock.atLeast(0),
    })),
  });
  const plan = diffSchemas(initial.$snapshot(), checked.$snapshot());
  expect(plan.up).toContain(
    'ALTER TABLE "products" ADD CONSTRAINT "products_nonnegative_stock_check" CHECK ("stock" >= 0)',
  );
  // The saved SQL says that dropping a check no longer declared loses no data.
  expect(plan.down).toContain(
    '-- symmetria: caution: CHECK constraint "products_positive_price_check" is no longer declared; dropping it loses no data.\nALTER TABLE "products" DROP CONSTRAINT "products_positive_price_check"',
  );
  expect(createSchemaSQL(checked.$snapshot())[0]?.sql).toContain(
    'CONSTRAINT "products_positive_price_check" CHECK ("price" > E\'0\')',
  );
  expect(
    parseMigrationSnapshot(
      JSON.parse(JSON.stringify(migrationSnapshot(checked.$snapshot()))),
    ),
  ).toEqual(migrationSnapshot(checked.$snapshot()));
  const renamed = schema({
    products: table({
      id: int.auto,
      price: numeric(12, 2),
      quantity: int.default(0),
    }).checks((products) => ({
      positivePrice: products.price.above("0"),
      nonnegativeStock: products.quantity.atLeast(0),
    })),
  });
  const renamedPlan = diffSchemas(checked.$snapshot(), renamed.$snapshot(), {
    renames: { columns: { products: { stock: "quantity" } } },
  });
  // PostgreSQL renames the column inside its checks; nothing is rebuilt.
  expect(renamedPlan.up).toEqual([
    'ALTER TABLE "products" RENAME COLUMN "stock" TO "quantity"',
  ]);
  expect(renamedPlan.down).toEqual([
    'ALTER TABLE "products" RENAME COLUMN "quantity" TO "stock"',
  ]);
  expect(diffSchemas(initial.$snapshot(), emptySnapshot()).down).toEqual(
    diffSchemas(emptySnapshot(), initial.$snapshot()).up,
  );
  expect(() =>
    schema({
      products: products
        .checks((products) => ({ same: products.stock.above(0) }))
        .checks((products) => ({ same: products.stock.below(10) })),
    }),
  ).toThrow(/duplicate check/);
});

test("negative numbers in schema expressions are parenthesized; other literals are written as before", () => {
  const offset = -5;
  const build = (shifted: boolean) =>
    schema({
      items: table({ id: int.auto, n: int, r: real, code: text, data: bytea })
        .checks((t) => ({
          // After a minus sign, -5 would start a comment: "n"--5.
          ...(shifted ? { shifted: sql<boolean>`${t.n}-${offset} > 0` } : {}),
          // -5::text would cast 5 and negate the text.
          cast: sql<boolean>`${offset}::text <> ${t.code}`,
          real: t.r.above(-1.5),
          plus: t.n.plus(-2).above(0),
          between: t.n.between(-10, 10),
          positive: t.n.above(5),
          // Escape strings read the same with standard_conforming_strings off.
          bytes: t.data.isNot(new Uint8Array([0x41, 0x42])),
          slash: t.code.isNot("a\\b"),
        }))
        .indexes((t) => ({ low: index(t.n).where(t.n.below(-1)) })),
    }).$snapshot();
  const declared = build(true);

  expect(
    Object.fromEntries(
      declared.tables[0]!.checks!.map((check) => [
        check.name,
        check.expression,
      ]),
    ),
  ).toEqual({
    shifted: '"n"-(-5) > 0',
    cast: '(-5)::text <> "code"',
    real: '"r" > (-1.5)::text::real',
    plus: '("n" + (-2)) > 0',
    between: '"n" BETWEEN (-10) AND 10',
    positive: '"n" > 5',
    bytes: `"data" <> E'\\\\x4142'::bytea`,
    slash: `"code" <> E'a\\\\b'`,
  });
  expect(declared.tables[0]!.indexes![0]!.where).toBe('"n" < (-1)');

  // Snapshots saved before, with the numbers written -5, need no migration,
  // except where -5 meant another thing: PostgreSQL refused -5::text (it
  // negates text), so that check is written again.
  const saved = parseMigrationSnapshot(
    JSON.parse(
      JSON.stringify(migrationSnapshot(build(false))).replaceAll(
        /\((-[0-9.]+)\)/g,
        "$1",
      ),
    ),
  );

  expect(saved.tables[0]!.checks!.map((check) => check.expression)).toContain(
    '("n" + -2) > 0',
  );
  expect(diffSchemas(saved, build(false)).up).toEqual([
    'ALTER TABLE "items" DROP CONSTRAINT "items_cast_check"',
    'ALTER TABLE "items" ADD CONSTRAINT "items_cast_check" CHECK ((-5)::text <> "code")',
  ]);
});

test("explicit primary keys retain ordering and support single non-id reference targets", () => {
  const database = schema({
    tenants: table({ code: text, title: text }).primaryKey((tenants) => [
      tenants.code,
    ]),
    records: ({ tenants }) =>
      table({ tenant: tenants, externalId: text, title: text }).primaryKey(
        (records) => [records.externalId, records.tenantId],
      ),
  });
  type RecordRow = Assert<
    Equal<
      typeof database.records.$row,
      { tenantId: string; externalId: string; title: string }
    >
  >;
  expect(
    migrationSnapshot(database.$snapshot()).tables.find(
      (table) => table.name === "records",
    )?.primaryKey,
  ).toEqual(["external_id", "tenant_id"]);
  expect(
    createSchemaSQL(database.$snapshot())
      .map((query) => query.sql)
      .join("\n"),
  ).toContain('REFERENCES "tenants" ("code")');
  expect(
    database
      .records((records, { innerJoin }) => {
        const tenant = innerJoin(records.tenant);

        return { title: tenant.title };
      })
      .toSQL().sql,
  ).toContain('"records"."tenant_id" = "tenant"."code"');
  expect(() =>
    schema({
      records: table({ id: int, value: text.nullable }).primaryKey(
        (records) => [records.value],
      ),
    }),
  ).toThrow(/nullable/);
  expect(() =>
    table({ id: int }).primaryKey((records) => [records.id, records.id]),
  ).toThrow(/duplicate/);
  expect(() =>
    table({ id: int }).primaryKey((records) => [records.id.plus(1)]),
  ).toThrow(/plain columns/);
  expect(() =>
    schema({
      records: table({ code: text.primaryKey, other: int }).primaryKey(
        (records) => [records.other],
      ),
    }),
  ).toThrow(/conflicting/);
  expect(() =>
    schema({
      parents: table({ first: int, second: int }).primaryKey((parents) => [
        parents.first,
        parents.second,
      ]),
      children: ({ parents }) => ({ id: int, parent: parents }),
    }),
  ).toThrow(/single scalar primary key/);
});

test("a key declared out of column order keeps its declared order in lookups, first matches and key subqueries", () => {
  const tenants = table({ code: text, title: text }).primaryKey((tenants) => [
    tenants.code,
  ]);
  const records = table({
    tenant: tenants,
    externalId: text,
    title: text,
  }).primaryKey((records) => [records.externalId, records.tenantId]);
  const notes = table({
    id: int.auto,
    tenantCode: text,
    recordId: text,
  }).relations((note, { to }) => ({
    record: to(records).one((record) =>
      and(
        note.tenantCode.is(record.tenantId),
        note.recordId.is(record.externalId),
      ),
    ),
  }));
  const database = schema({ tenants, records, notes });

  expect(
    database.records.byId({ tenantId: "acme", externalId: "r1" }).toSQL(),
  ).toEqual({
    sql: [
      'SELECT "records"."tenant_id" AS "tenantId", "records"."external_id" AS "externalId", "records"."title" AS "title"',
      'FROM "records" AS "records"',
      'WHERE "records"."external_id" = $1 AND "records"."tenant_id" = $2',
    ].join("\n"),
    parameters: ["r1", "acme"],
  });

  const firstMatch = (column: string, name: string) =>
    [
      `(SELECT "__symmetria_path_0_2"."${column}" AS "${name}"`,
      'FROM "records" AS "__symmetria_path_0_2"',
      'WHERE ("notes"."tenant_code" = "__symmetria_path_0_2"."tenant_id" AND "notes"."record_id" = "__symmetria_path_0_2"."external_id")',
      'ORDER BY "__symmetria_path_0_2"."external_id" ASC, "__symmetria_path_0_2"."tenant_id" ASC',
      "LIMIT 1)",
    ].join("\n");

  expect(
    database.notes((note) => ({ title: note.record.title })).toSQL().sql,
  ).toBe(
    [
      'SELECT "__symmetria_path_0"."title" AS "title"',
      'FROM "notes" AS "notes"',
      `LEFT JOIN "records" AS "__symmetria_path_0" ON ("__symmetria_path_0"."external_id" = ${firstMatch("external_id", "externalId")} AND "__symmetria_path_0"."tenant_id" = ${firstMatch("tenant_id", "tenantId")})`,
    ].join("\n"),
  );

  // Both sides of the row comparison list the key in the same, declared order.
  expect(
    database.records
      .update({ title: "x" })
      .where((record) => record.tenant.title.is("Acme"))
      .toSQL(),
  ).toEqual({
    sql: [
      'UPDATE "records" AS "records" SET "title" = $1',
      'WHERE ("records"."external_id", "records"."tenant_id") IN (SELECT "records"."external_id" AS "externalId", "records"."tenant_id" AS "tenantId"',
      'FROM "records" AS "records"',
      'INNER JOIN "tenants" AS "__symmetria_path_0" ON "records"."tenant_id" = "__symmetria_path_0"."code"',
      'WHERE "__symmetria_path_0"."title" = $2)',
    ].join("\n"),
    parameters: ["x", "Acme"],
  });
});

test("a partial FK primary key does not introduce junction relations", () => {
  const database = schema({
    users: { id: int },
    groups: { id: int },
    membership: ({ users, groups }) =>
      table({ user: users.inverse("memberships"), group: groups }).primaryKey(
        (membership) => [membership.userId],
      ),
  });
  expect(
    database.$snapshot().tables.find((table) => table.name === "membership")
      ?.junction,
  ).toBe(false);
  expect(
    database
      .$snapshot()
      .tables.find((table) => table.name === "users")
      ?.relations.map((relation) => relation.name),
  ).toEqual(["memberships"]);
});

test("cyclic local callbacks can anchor key types and validate the declarations", () => {
  const database = schema.keys({ users: uuid, teams: int })({
    users: ({ teams }) =>
      table({ id: uuid, team: teams.nullable.inverse("members") }).indexes(
        (users) => ({ byTeam: index(users.teamId) }),
      ),
    teams: ({ users }) =>
      table({ id: int, owner: users.inverse("ownedTeams") }).checks(
        (teams) => ({ owner: teams.ownerId.isNot(null) }),
      ),
  });
  expect(
    database.$snapshot().tables.find((table) => table.name === "teams")
      ?.checks?.[0]?.expression,
  ).toBe('"owner_id" IS NOT NULL');
  expect(() => schema.keys({ users: uuid })({ users: { id: int } })).toThrow(
    /does not match/,
  );
  const identifier = customType<{ value: string }>("text", {
    encode: (value) => value.value,
    decode: (value) => ({ value: String(value) }),
  });
  expect(() =>
    schema.keys({ users: identifier })({ users: { id: text } }),
  ).toThrow(/does not match/);
});
