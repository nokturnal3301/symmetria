import { expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  uuid,
  numeric,
  customType,
  type QueryColumn,
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
  expect(plan.down).toContain(
    'ALTER TABLE "products" DROP CONSTRAINT "products_positive_price_check"',
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
