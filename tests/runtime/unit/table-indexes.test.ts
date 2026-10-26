import { expect, test } from "bun:test";
import {
  junction,
  schema,
  table,
  index,
  int,
  text,
  uuid,
  bool,
  jsonb,
  customType,
  timestamptz,
  sql,
  createIndexesSQL,
  type QueryColumn,
} from "../../../packages/runtime/src";
import { diffSchemas, emptySnapshot } from "../../../packages/kit/src";

const model = schema({
  users: table({ id: uuid.v4, email: text }).indexes((users) => ({
    lowerEmail: index(sql<string>`lower(${users.email})`).unique,
  })),
  posts: ({ users }) =>
    table({
      id: int.auto,
      title: text,
      author: users,
      published: bool.default(false),
      createdAt: timestamptz.now,
    }).indexes((posts) => ({
      byAuthorDate: index(posts.authorId, posts.createdAt.descending).include(
        posts.title,
      ),
      feed: index(posts.createdAt.descending).where(posts.published.is(true)),
    })),
});

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;
type PostRow = Expect<
  AreEqual<
    typeof model.posts.$row,
    {
      id: number;
      title: string;
      authorId: string;
      published: boolean;
      createdAt: Date;
    }
  >
>;
type PostInsert = Expect<
  AreEqual<
    typeof model.posts.$insert,
    {
      id?: undefined;
      title: string;
      authorId: string;
      published?: boolean | undefined;
      createdAt?: Date | undefined;
    }
  >
>;
const query = model.posts((posts, { leftJoin }) => {
  const author = leftJoin(posts.author);

  return { title: posts.title, email: author.email };
});
type SelectedRow = Expect<
  AreEqual<
    Awaited<ReturnType<typeof query.execute>>,
    { title: string; email: string | null }[]
  >
>;

test("table-local indexes use resolved columns and table-prefixed names", () => {
  expect(
    model
      .$createIndexes()
      .toSQL()
      .map((query) => query.sql),
  ).toEqual([
    'CREATE INDEX "posts_by_author_date_idx" ON "posts" USING btree ("author_id", "created_at" DESC) INCLUDE ("title")',
    'CREATE INDEX "posts_feed_idx" ON "posts" USING btree ("created_at" DESC) WHERE "published" = TRUE',
    'CREATE UNIQUE INDEX "users_lower_email_idx" ON "users" USING btree ((lower("email")))',
  ]);
  expect(
    model
      .$snapshot()
      .tables.find((table) => table.name === "posts")
      ?.columns.map((column) => column.name),
  ).not.toContain("indexes");
  expect(query.toSQL().sql).toContain('LEFT JOIN "users" AS "author"');
  const plan = diffSchemas(emptySnapshot(), model.$snapshot());
  expect(plan.up).toContain(model.$createIndexes().toSQL()[0]!.sql);
  expect(plan.down).toContain('DROP TABLE "posts"');
  const withoutIndexes = model.$snapshot();

  for (const table of withoutIndexes.tables) {
    table.indexes = [];
  }

  expect(diffSchemas(model.$snapshot(), withoutIndexes).up).toContain(
    'DROP INDEX "posts_by_author_date_idx"',
  );
});

test("table builders and index chains are reusable, immutable and deferred", () => {
  let evaluations = 0;
  const columns = { id: int.auto, value: text };
  const base = table(columns);
  const indexed = base.indexes((records) => {
    evaluations++;

    return { byValue: index(records.value) };
  });
  const extended = indexed.indexes((records) => ({
    byIdentity: index(records.id),
  }));
  expect(evaluations).toBe(0);
  columns.value = text.unique;
  expect(schema({ records: base }).$createIndexes().toSQL()).toEqual([]);
  const first = schema({ records: indexed });
  expect(evaluations).toBe(1);
  expect(
    first
      .$snapshot()
      .tables[0]?.columns.find((column) => column.name === "value")?.unique,
  ).toBe(false);
  expect(schema({ records: indexed }).$snapshot()).toEqual(first.$snapshot());
  expect(schema({ records: extended }).$createIndexes().toSQL()).toHaveLength(
    2,
  );
  const reused = schema({ first: indexed, second: indexed });
  expect(
    reused
      .$snapshot()
      .tables.flatMap((table) => table.indexes?.map((index) => index.sqlName)),
  ).toEqual(["first_by_value_idx", "second_by_value_idx"]);
  const snapshot = first.$snapshot();
  snapshot.tables[0]!.indexes = [];
  expect(first.$createIndexes().toSQL()).toHaveLength(1);
});

test("index callbacks run after cyclic, self and junction references are resolved", () => {
  const cyclic = schema({
    users: ({ teams }) =>
      table({ id: uuid.v4, team: teams.nullable.inverse("members") }).indexes(
        (users) => ({ byTeam: index(users.teamId) }),
      ),
    teams: ({ users }) =>
      table({ id: int.auto, owner: users.inverse("ownedTeams") }).indexes(
        (teams) => ({ byOwner: index(teams.ownerId) }),
      ),
    categories: ({ categories }) =>
      table({
        id: int.auto,
        parent: categories.nullable.inverse("children"),
      }).indexes((categories) => ({
        byParent: index(categories.parentId).where(
          categories.parentId.isNot(null),
        ),
      })),
    memberships: ({ users, teams }) =>
      junction({ user: users, team: teams }).indexes((memberships) => ({
        byTeam: index(memberships.teamId, memberships.userId),
      })),
  });
  type TeamIdentifier = Expect<
    AreEqual<typeof cyclic.users.$row.teamId, number | null>
  >;
  type OwnerIdentifier = Expect<
    AreEqual<typeof cyclic.teams.$row.ownerId, string>
  >;
  type JunctionRow = Expect<
    AreEqual<typeof cyclic.memberships.$row, { userId: string; teamId: number }>
  >;
  expect(
    cyclic
      .$createIndexes()
      .toSQL()
      .map((query) => query.sql),
  ).toContain(
    'CREATE INDEX "memberships_by_team_idx" ON "memberships" USING btree ("team_id", "user_id")',
  );
  expect(
    cyclic.$snapshot().tables.find((table) => table.name === "memberships")
      ?.junction,
  ).toBe(true);
  expect(
    cyclic
      .users((users, { leftJoin }) => {
        const teams = leftJoin(users.teams);

        return { id: teams.id };
      })
      .toSQL().sql,
  ).toContain('JOIN "memberships"');
});

test("local and schema-level indexes share name validation and ownership rules", () => {
  const records = table({ id: int, value: text }).indexes((records) => ({
    byValue: index(records.value),
  }));
  expect(() =>
    schema({
      records: records.indexes((records) => ({ byValue: index(records.id) })),
    }),
  ).toThrow(/duplicate SQL index/);
  expect(() =>
    schema(
      { records },
      { indexes: ({ records }) => ({ recordsByValueIdx: index(records.id) }) },
    ),
  ).toThrow(/duplicate SQL index/);
  expect(() =>
    schema({
      records: table({ id: int }).indexes((records) => ({
        byId: index(records.id),
        by_id: index(records.id),
      })),
    }),
  ).toThrow(/duplicate SQL index/);
  expect(() => schema({ records, recordsByValueIdx: { id: int } })).toThrow(
    /duplicate SQL index/,
  );
  expect(
    schema(
      { records },
      { indexes: ({ records }) => ({ extraIndex: index(records.id) }) },
    )
      .$createIndexes()
      .toSQL(),
  ).toHaveLength(2);
  let captured: QueryColumn<number, "id">;
  const source = table({ id: int }).indexes((columns) => {
    captured = columns.id;

    return {};
  });
  const invalid = table({ id: int }).indexes(() => ({
    external: index(captured),
  }));
  expect(() => schema({ source, invalid })).toThrow(/columns must come from/);
});

test("a column named indexes is available in callbacks and query rows", () => {
  const local = schema({
    records: table({ id: int, indexes: text }).indexes((records) => ({
      byIndexes: index(records.indexes),
    })),
  });
  type RowMatches = Expect<
    AreEqual<typeof local.records.$row, { id: number; indexes: string }>
  >;
  expect(local.$createIndexes().toSQL()[0]?.sql).toBe(
    'CREATE INDEX "records_by_indexes_idx" ON "records" USING btree ("indexes")',
  );
  expect(
    local.records((records) => ({ indexes: records.indexes })).toSQL().sql,
  ).toContain('"indexes" AS "indexes"');
});

test("local index expressions use scalar and referenced custom codecs", () => {
  const identifier = customType<{ value: string }>("text", {
    encode: (value) => value.value.toUpperCase(),
    decode: (value) => ({ value: String(value) }),
  });
  const local = schema({
    users: table({ id: identifier }).indexes((users) => ({
      matching: index(users.id).where(users.id.is({ value: "hello" })),
    })),
    posts: ({ users }) =>
      table({ id: int, author: users, metadata: jsonb<unknown>() }).indexes(
        (posts) => ({
          matching: index(posts.authorId).where(
            posts.authorId.is({ value: "hello" }),
          ),
          metadata: index(posts.metadata).using("gin"),
        }),
      ),
  });
  expect(
    local
      .$createIndexes()
      .toSQL()
      .map((query) => query.sql),
  ).toEqual([
    'CREATE INDEX "posts_matching_idx" ON "posts" USING btree ("author_id") WHERE "author_id" = E\'HELLO\'',
    'CREATE INDEX "posts_metadata_idx" ON "posts" USING gin ("metadata")',
    'CREATE INDEX "users_matching_idx" ON "users" USING btree ("id") WHERE "id" = E\'HELLO\'',
  ]);
});

test("standalone tables also retain their local indexes and codecs", () => {
  const identifier = customType<{ value: string }>("text", {
    encode: (value) => value.value.toUpperCase(),
    decode: (value) => ({ value: String(value) }),
  });
  const users = table({ id: identifier });
  const posts = table({ id: int, author: users }).indexes((posts) => ({
    byAuthor: index(posts.authorId).where(
      posts.authorId.is({ value: "hello" }),
    ),
  }));
  expect(createIndexesSQL(schema({ users, posts }).$snapshot())[0]?.sql).toBe(
    'CREATE INDEX "posts_by_author_idx" ON "posts" USING btree ("author_id") WHERE "author_id" = E\'HELLO\'',
  );
});
