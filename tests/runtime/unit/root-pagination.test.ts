import { expect, test } from "bun:test";
import {
  junction,
  schema,
  table,
  int,
  text,
  bigint,
  timestamptz,
  prepare,
  rowNumber,
  over,
  count,
  sql,
  createDatabase,
} from "../../../packages/runtime/src";

const users = table({ id: int.auto, email: text.unique, name: text });
const posts = table({
  id: int.auto,
  title: text,
  author: users.index,
  views: bigint.default(0n),
  createdAt: timestamptz.now,
});
const tags = table({ id: int.auto, label: text });
const postTags = junction({ post: posts, tag: tags });
const database = schema({ users, posts, tags, postTags });

test("paginated roots with nested collections restrict their rows before correlated subqueries", () => {
  const compiled = database
    .users((user) => ({
      id: user.id,
      posts: user.posts((post) => ({
        title: post.title,
        tags: post.tags((tag) => ({ label: tag.label })),
        $orderBy: [post.createdAt.descending, post.id.descending],
        $limit: 3,
      })),
      $where: user.id.above(10),
      $orderBy: user.id.ascending,
      $limit: 50,
      $offset: 1900,
    }))
    .toSQL();

  expect(compiled.parameters).toEqual([10]);
  expect(compiled.sql).toStartWith('SELECT "users"."id" AS "id", (SELECT');
  expect(compiled.sql).toEndWith(
    [
      'FROM (SELECT "users"."id" AS "id", "users"."email" AS "email", "users"."name" AS "name"',
      'FROM "users" AS "users"',
      'WHERE "users"."id" > $1',
      'ORDER BY "users"."id" ASC',
      "LIMIT 50",
      'OFFSET 1900) AS "users"',
      'ORDER BY "users"."id" ASC',
    ].join("\n"),
  );
  // The nested collection is paginated the same way, inside the JSON subquery.
  expect(compiled.sql).toContain(
    'FROM (SELECT "__symmetria_aggregate_0"."id" AS "id"',
  );
  expect(compiled.sql).toContain(
    'LIMIT 3) AS "__symmetria_aggregate_0"\nORDER BY "__symmetria_aggregate_0"."created_at" DESC, "__symmetria_aggregate_0"."id" DESC',
  );
});

test("prepared counts keep one placeholder per parameter in the rewritten layout", () => {
  const paged = prepare({ after: int, size: int }, (parameters) =>
    database.users((user) => ({
      id: user.id,
      total: user.posts.count(),
      $where: user.id.above(parameters.after),
      $orderBy: user.id.ascending,
      $limit: parameters.size,
    })),
  );
  const compiled = paged.toSQL({ after: 5, size: 20 });

  expect(compiled.parameters).toEqual([5, 20]);
  expect(compiled.sql).toContain(
    'WHERE "users"."id" > $1\nORDER BY "users"."id" ASC\nLIMIT $2) AS "users"',
  );
});

test("the rewrite is skipped when a page cannot be isolated from the full input", () => {
  const sqlOf = (query: { toSQL: () => { sql: string } }) => query.toSQL().sql;

  // No correlated subquery in the projection: plain pagination stays as it was.
  expect(
    sqlOf(
      database.users((user) => ({
        id: user.id,
        $orderBy: user.id.ascending,
        $limit: 5,
      })),
    ),
  ).toBe(
    'SELECT "users"."id" AS "id"\nFROM "users" AS "users"\nORDER BY "users"."id" ASC\nLIMIT 5',
  );
  // Ordering by a correlated aggregate needs every row scored first.
  expect(
    sqlOf(
      database.users((user) => ({
        id: user.id,
        total: user.posts.count(),
        $orderBy: user.posts.count().descending,
        $limit: 5,
      })),
    ),
  ).not.toContain("FROM (SELECT");
  // Windows see the complete input.
  expect(
    sqlOf(
      database.users((user) => ({
        id: user.id,
        position: over(rowNumber(), { orderBy: user.id.ascending }),
        total: user.posts.count(),
        $limit: 5,
      })),
    ),
  ).not.toContain("FROM (SELECT");
  // Bare aggregates summarize the whole input.
  expect(
    sqlOf(
      database.users((user) => ({
        total: count(),
        posts: user.posts.count(),
        $limit: 1,
      })),
    ),
  ).not.toContain("FROM (SELECT");
  // DISTINCT, row locks and JOINs keep the original layout.
  expect(
    sqlOf(
      database.users((user) => ({
        id: user.id,
        total: user.posts.count(),
        $distinct: true,
        $limit: 5,
      })),
    ),
  ).not.toContain("FROM (SELECT");
  expect(
    sqlOf(
      database.users((user) => ({
        id: user.id,
        total: user.posts.count(),
        $forUpdate: true,
        $limit: 5,
      })),
    ),
  ).not.toContain("FROM (SELECT");
  expect(
    sqlOf(
      database.posts((post) => ({
        id: post.id,
        author: post.author.name,
        tags: post.tags((tag) => ({ label: tag.label })),
        $limit: 5,
      })),
    ),
  ).not.toContain('FROM (SELECT "posts"');
});

test("the SQLite dialect keeps the original layout", async () => {
  const { sqlite } = await import("../../../packages/runtime/src/driver");
  const driver = sqlite(":memory:");
  const local = createDatabase({ schema: database, driver });
  const compiled = local
    .users((user) => ({
      id: user.id,
      posts: user.posts((post) => ({ title: post.title })),
      $limit: 5,
    }))
    .toSQL();

  expect(compiled.sql).toEndWith('FROM "users" AS "users"\nLIMIT 5');
  await driver.close();
});

test("opaque projections and orderings keep their original evaluation scope", () => {
  for (const expression of [
    sql<bigint>`count(*) OVER ()`,
    sql<bigint>`count(*)`,
    sql<number>`random()`,
  ]) {
    const projected = database.users((user) => ({
      value: { nested: expression },
      posts: user.posts.count(),
      $limit: 1,
    }));
    expect(projected.toSQL().sql).not.toContain('FROM (SELECT "users"');

    const ordered = database.users((user) => ({
      posts: user.posts.count(),
      $orderBy: expression.descending,
      $limit: 1,
    }));
    expect(ordered.toSQL().sql).not.toContain('FROM (SELECT "users"');
    expect(ordered.toSQL().sql.match(/ORDER BY/g)).toHaveLength(1);
  }
});

test("raw SQL in a nested query only blocks pagination within that scope", () => {
  const compiled = database
    .users((user) => ({
      id: user.id,
      posts: user.posts((post) => ({
        total: sql<bigint>`count(*) OVER ()`,
        tags: post.tags((tag) => ({ label: tag.label })),
        $limit: 1,
      })),
      $limit: 1,
    }))
    .toSQL();

  expect(compiled.sql).toContain('FROM (SELECT "users"');
  expect(compiled.sql).not.toContain('FROM (SELECT "__symmetria_aggregate_0"');
});
