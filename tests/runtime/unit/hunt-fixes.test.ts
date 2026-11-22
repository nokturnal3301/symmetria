import { expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  many,
  one,
  count,
  QueryError,
  operatorClass,
  timestamptz,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";
import { postgresArrayLiteral } from "../../../packages/runtime/src/entries/internal";
import { queryError } from "../../../packages/runtime/src/driver/errors";

const users = table({ id: int.auto, name: text, posts: many });
const posts = table({ id: int.auto, author: one(users.posts), views: int });
const documents = table({
  id: int.auto,
  owner: text,
  embedding: vector(3),
});
const stamps = table({ id: int.auto, at: timestamptz(0).unique, n: int });
const handles = table({ id: int.auto, down: text }).indexes((handle) => ({
  down: index(handle.down.desc).unique,
}));

const recording = (rows: Record<string, unknown>[] = []) => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    { users, posts, documents, stamps, handles },
    {
      executor: async (query) => {
        calls.push(query);

        return rows;
      },
    },
  );

  return { database, calls, last: () => calls.at(-1)! };
};

test("a bare parameter is never shared between clauses", () => {
  const { database } = recording();
  const query = database
    .posts(
      (post, { sql }) => ({
        id: post.id,
        marker: sql<number>`${1}`,
        doubled: post.views.multiply(2),
      }),
      {
        where: (post, { sql }) => post.id.above(sql<number>`${1}`),
        orderBy: (post) => [post.views.multiply(2).desc, post.id.asc],
        limit: 3,
      },
    )
    .toSQL();

  // The select list would type $1 as text and the filter as integer.
  expect(query.sql).toContain('$1 AS "marker"');
  expect(query.sql).toContain('WHERE "posts"."id" > ($3)');
  // The ordering still reuses the selected expression, cast and all.
  expect(query.sql).toContain('("posts"."views" * $2) AS "doubled"');
  expect(query.sql).toContain('ORDER BY ("posts"."views" * $2) DESC');
  expect(query.parameters).toEqual([1, 2, 1]);
});

test("a page cursor does not depend on how the statement is optimized", async () => {
  const { database } = recording([
    { id: 1, n: 2, v: 3 },
    { id: 2, n: 2, v: 3 },
    { id: 3, n: 1, v: 1 },
  ]);
  const page = await database
    .users(
      (user) => ({
        id: user.id,
        n: user.posts.count(),
        v: user.posts.sum.views,
      }),
      { orderBy: (user) => user.id.asc },
    )
    .page({ size: 2 });

  // The cursor 2.3.0 issued for this query, before two aggregates of one
  // relation became one LATERAL join.
  expect(String(page.nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6ImVmNzhiOWQxYjFmYTZkMTIwOTY4YzE4NjRiZWZhMGQ2ZTYxMGIyMjQ2MDZiNzJhZmRmMTRlOGYxOTRhMDExNjUiLCJ2YWx1ZXMiOltudWxsXX0",
  );
});

test("an ordering takes one direction", () => {
  const { database } = recording();

  for (const second of ["asc", "desc", "ascending", "descending"]) {
    expect(() =>
      database.posts((post) => ({ id: post.id }), {
        orderBy: (post) =>
          (post.id.asc as unknown as Record<string, never>)[second]!,
      }),
    ).toThrow(
      `symmetria: this ordering already has a direction; remove the second one (.${second})`,
    );
  }

  expect(
    database
      .posts((post) => ({ id: post.id }), {
        orderBy: (post) => post.views.desc.nullsLast,
      })
      .toSQL().sql,
  ).toContain('ORDER BY "posts"."views" DESC NULLS LAST');
});

test("over() refuses options it does not know", () => {
  const { database } = recording();

  expect(() =>
    database.posts((post) => ({
      n: count().over({ partition: [post.authorId] } as never),
    })),
  ).toThrow(
    'symmetria: over() takes partitionBy, orderBy and rows, not "partition"',
  );
  expect(() =>
    database.posts((post) => ({
      n: count().over({ partitionBy: post.authorId } as never),
    })),
  ).toThrow("symmetria: over() partitionBy is a list, such as [post.authorId]");
});

test("a row lock on a CTE is refused: PostgreSQL would lock nothing", () => {
  const { database } = recording();
  const ranked = database.posts((post) => ({ id: post.id })).cte("ranked");

  expect(() => ranked({ where: { id: 1 }, forUpdate: true })).toThrow(
    'symmetria: a row lock does not reach the rows of CTE "ranked"; lock them in the query that reads the table',
  );
  expect(
    database.posts({ where: { id: 1 }, forUpdate: true }).toSQL().sql,
  ).toContain("FOR UPDATE");
});

test("conflict keys of an upsert are compared at the column's precision", () => {
  const { database } = recording();
  const base = Date.UTC(2024, 0, 1);

  // timestamptz(0) stores both instants as the same second.
  expect(() =>
    database.stamps
      .upsert(
        [
          { at: new Date(base), n: 1 },
          { at: new Date(base + 100), n: 2 },
        ],
        { by: "at" },
      )
      .toSQL(),
  ).toThrow(/rows 1 and 2 of the upsert on "stamps" share a conflict key/);
  expect(() =>
    database.stamps
      .upsert(
        [
          { at: new Date(base), n: 1 },
          { at: new Date(base + 600), n: 2 },
        ],
        { by: "at" },
      )
      .toSQL(),
  ).not.toThrow();
});

test("array literals print booleans and far dates as PostgreSQL reads them", () => {
  expect(
    postgresArrayLiteral([true, false, null, new Date("2024-01-31T23:30:00Z")]),
  ).toBe('{"true","false",NULL,"2024-01-31T23:30:00.000Z"}');

  const caesar = new Date(Date.UTC(2000, 2, 15, 1, 2, 3));
  caesar.setUTCFullYear(-43);
  expect(postgresArrayLiteral([caesar])).toBe(
    '{"0044-03-15T01:02:03.000Z BC"}',
  );
});

test("the nearest rows are asked of the index in full", () => {
  const { database } = recording();
  const nearest = (limit: number | undefined, offset?: number) =>
    database
      .documents((document) => ({ id: document.id }), {
        where: { owner: "u" },
        orderBy: (document) => document.embedding.cosineDistance([1, 0, 0]).asc,
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      })
      .toSQL().sql;
  const iterative =
    "CASE WHEN current_setting('hnsw.iterative_scan', true) IS NULL THEN '' ELSE set_config('hnsw.iterative_scan', 'strict_order', true) END || CASE WHEN current_setting('hnsw.max_scan_tuples', true) IS NULL THEN '' ELSE set_config('hnsw.max_scan_tuples', '2147483647', true) END || CASE WHEN current_setting('hnsw.scan_mem_multiplier', true) IS NULL THEN '' ELSE set_config('hnsw.scan_mem_multiplier', '1000', true) END";

  // The index filters after it has picked its rows; it keeps scanning.
  expect(nearest(10)).toContain(
    `WHERE (SELECT ${iterative}) IS NOT NULL AND "documents"."owner" = $1`,
  );
  // More rows than the index returns by default: it returns as many.
  expect(nearest(100, 20)).toContain(
    `WHERE (SELECT CASE WHEN current_setting('hnsw.ef_search', true) IS NULL THEN '' ELSE set_config('hnsw.ef_search', greatest(current_setting('hnsw.ef_search')::integer, 120)::text, true) END || ${iterative}) IS NOT NULL AND`,
  );
  expect(nearest(5000)).toContain("::integer, 1000)::text");
  // Every row is read anyway: nothing to widen.
  expect(nearest(undefined)).not.toContain("set_config");
  // The farthest rows are not what an index of neighbours serves.
  expect(
    database
      .documents((document) => ({ id: document.id }), {
        orderBy: (document) =>
          document.embedding.cosineDistance([1, 0, 0]).desc,
        limit: 5,
      })
      .toSQL().sql,
  ).not.toContain("set_config");
});

test("an IVFFlat index reads on past its lists, and its rows are sorted again", () => {
  const places = table({ id: int.auto, kind: text, at: vector(3) }).indexes(
    (place) => ({
      at: index(operatorClass(place.at, "vector_l2_ops")).using("ivfflat"),
    }),
  );
  const database = schema({ places });
  const { sql } = database
    .places((place) => ({ id: place.id }), {
      where: { kind: "cafe" },
      orderBy: (place) => [place.at.l2Distance([1, 0, 0]).asc, place.id.asc],
      limit: 5,
    })
    .toSQL();

  // Reading on returns rows only roughly in order (pgvector's relaxed_order).
  expect(sql).toContain(
    "set_config('ivfflat.iterative_scan', 'relaxed_order', true)",
  );
  expect(sql).toBe(
    [
      'SELECT "id"',
      `FROM (SELECT "places"."id" AS "id", ("places"."at" <-> $3::text::vector) AS "__symmetria_order_0", "places"."id" AS "__symmetria_order_1"`,
      'FROM "places" AS "places"',
      sql.split("\n")[3],
      'ORDER BY ("places"."at" <-> $2::text::vector) ASC, "places"."id" ASC',
      'LIMIT 5) AS "__symmetria_nearest"',
      'ORDER BY "__symmetria_order_0" + 0 ASC, "__symmetria_order_1" ASC',
    ].join("\n"),
  );
  // A row lock stays on the inner statement; the outer one sorts again.
  const locked = database
    .places((place) => ({ id: place.id }), {
      orderBy: (place) => place.at.l2Distance([1, 0, 0]).asc,
      limit: 5,
      forUpdate: true,
    })
    .toSQL().sql;

  expect(locked).toContain("'relaxed_order'");
  expect(locked).toContain('LIMIT 5\nFOR UPDATE) AS "__symmetria_nearest"');
  expect(locked).toEndWith('ORDER BY "__symmetria_order_0" + 0 ASC');
});

test("pages by distance compare rows exactly", async () => {
  const { database, last } = recording([{ id: 1 }]);

  await database
    .documents((document) => ({ id: document.id }), {
      orderBy: (document) => [
        document.embedding.l2Distance([1, 0, 0]).asc,
        document.id.asc,
      ],
    })
    .page({ size: 10 });

  // An approximate index may skip rows, and a page may not.
  expect(last().sql).toContain(
    'ORDER BY (("documents"."embedding" <-> $3::text::vector) + $4) ASC, "documents"."id" ASC',
  );
  expect(last().sql).not.toContain("set_config");
});

test("an object filter takes a vector as one value", () => {
  const { database } = recording();
  const query = database
    .documents({ where: { embedding: [1, 0, 0] } as never })
    .toSQL();

  expect(query.sql).toContain(
    'WHERE "documents"."embedding" = $1::text::vector',
  );
  expect(query.parameters).toEqual(["[1,0,0]"]);
});

test("a descending unique index is a key like any other", async () => {
  const { database, last } = recording([{ id: 1, down: "d" }]);

  await database.handles.find({ down: "d" });
  expect(last().sql).toContain('WHERE "handles"."down" = $1');
});

test("a query error has a column only when PostgreSQL names one", () => {
  const unique = queryError(
    Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "users_email_key",
    }),
  );

  expect(unique).toBeInstanceOf(QueryError);
  // JavaScriptCore puts a source position named `column` on every Error.
  expect((unique as QueryError).column).toBeUndefined();
  expect(
    (
      queryError(
        Object.assign(new Error("null value"), {
          code: "23502",
          column: "email",
        }),
      ) as QueryError
    ).column,
  ).toBe("email");
});
