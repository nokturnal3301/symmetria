import { expect, test } from "bun:test";
import {
  schema,
  index,
  createIndexesSQL,
  int,
  text,
  bool,
  jsonb,
  timestamptz,
  sql,
  count,
  type CompiledQuery,
} from "../../../packages/runtime/src";

const model = schema(
  {
    users: {
      id: int.auto,
      email: text,
      active: bool.default(true),
      metadata: jsonb<unknown>(),
    },
    posts: ({ users }) => ({
      id: int.auto,
      author: users,
      title: text,
      createdAt: timestamptz.now,
    }),
  },
  {
    indexes: ({ users, posts }) => ({
      activeEmail: index(users.email).unique.where(users.active.is(true)),
      postsByAuthor: index(
        posts.authorId,
        posts.createdAt.descending.nullsLast,
      ).include(posts.title),
      lowerEmail: index(sql<string>`lower(${users.email})`),
      usersMetadata: index(users.metadata).using("gin"),
    }),
  },
);

test("index names, compound keys, FK columns, predicates and INCLUDE compile to PostgreSQL DDL", () => {
  expect(model.$createIndexes().toSQL()).toEqual([
    {
      sql: 'CREATE INDEX "posts_by_author" ON "posts" USING btree ("author_id", "created_at" DESC NULLS LAST) INCLUDE ("title")',
      parameters: [],
    },
    {
      sql: 'CREATE UNIQUE INDEX "active_email" ON "users" USING btree ("email") WHERE "active" = TRUE',
      parameters: [],
    },
    {
      sql: 'CREATE INDEX "lower_email" ON "users" USING btree ((lower("email")))',
      parameters: [],
    },
    {
      sql: 'CREATE INDEX "users_metadata" ON "users" USING gin ("metadata")',
      parameters: [],
    },
  ]);
  expect(
    model
      .$createIndexes({ concurrently: true, ifNotExists: true })
      .toSQL()
      .find((query) => query.sql.includes('"active_email"'))?.sql,
  ).toStartWith(
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "active_email"',
  );
});

test("index snapshots are serializable, detached and usable by the standalone DDL compiler", () => {
  const snapshot = model.$snapshot();
  expect(createIndexesSQL(JSON.parse(JSON.stringify(snapshot)))).toEqual(
    model.$createIndexes().toSQL(),
  );
  snapshot.tables.find((table) => table.name === "users")!.indexes = [];
  expect(model.$createIndexes().toSQL()).toHaveLength(4);
});

test("DDL literals escape quotes and backslashes without placeholder substitution", () => {
  const local = schema(
    { records: { id: int.auto, value: text } },
    {
      indexes: ({ records }) => ({
        literalIndex: index(records.value).where(
          records.value.is("$1'; DROP TABLE records; --\\tail"),
        ),
      }),
    },
  );
  const compiled = local.$createIndexes().toSQL()[0]!;
  expect(compiled.parameters).toEqual([]);
  expect(compiled.sql).toContain(
    "WHERE \"value\" = E'$1''; DROP TABLE records; --\\\\tail'",
  );
});

test("index modifiers are immutable and definitions are scoped to one schema table", () => {
  const local = schema(
    { records: { id: int.auto, value: text } },
    {
      indexes: ({ records }) => {
        const base = index(records.value);

        return {
          plain: base,
          unique: base.unique,
          partial: base.where(records.id.above(0)),
        };
      },
    },
  );
  expect(
    local
      .$snapshot()
      .tables[0]?.indexes?.map((definition) => definition.unique),
  ).toEqual([false, true, false]);
  expect(() =>
    schema(
      { first: { id: int }, second: { id: int } },
      {
        indexes: ({ first, second }) => ({
          invalid: index(first.id, second.id),
        }),
      },
    ),
  ).toThrow(/one table/);
});

test("invalid index methods, payloads, names and unsupported expressions fail early", () => {
  const definitions = {
    records: { id: int.auto, title: text, metadata: jsonb<unknown>() },
  };
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({
        invalid: index(records.title).using("gin").unique,
      }),
    }),
  ).toThrow(/btree/);
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({
        invalid: index(records.metadata).using("gin").include(records.title),
      }),
    }),
  ).toThrow(/INCLUDE/);
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({
        invalid: index(records.title.descending).using("hash"),
      }),
    }),
  ).toThrow(/ordered/);
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({
        invalid: index(records.title).include(records.title),
      }),
    }),
  ).toThrow(/duplicate INCLUDE/);
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({ invalid: index(count(records.id)) }),
    }),
  ).toThrow(/aggregates/);
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({
        someName: index(records.id),
        some_name: index(records.title),
      }),
    }),
  ).toThrow(/duplicate SQL index/);
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({ records: index(records.id) }),
    }),
  ).toThrow(/duplicate SQL index/);
  expect(() =>
    schema(definitions, {
      indexes: ({ records }) => ({ ["x".repeat(64)]: index(records.id) }),
    }),
  ).toThrow(/63 bytes/);
});

test("index execution is explicit, ordered and surfaces database errors", async () => {
  const calls: CompiledQuery[] = [];
  const local = schema(
    { records: { id: int.auto, value: text } },
    {
      indexes: ({ records }) => ({
        byValue: index(records.value),
        byIdentity: index(records.id),
      }),
      executor: async (query) => {
        calls.push(query);

        return [];
      },
    },
  );
  const query = local.$createIndexes();
  expect(calls).toHaveLength(0);
  await query.execute();
  expect(calls).toEqual(query.toSQL());
  await expect(model.$createIndexes().execute()).rejects.toThrow(
    /driver or executor/,
  );
});
