import { expect, test } from "bun:test";
import {
  junction,
  schema,
  table,
  int,
  smallint,
  text,
  bigint,
  numeric,
  real,
  doublePrecision,
  date,
  time,
  interval,
  timestamp,
  timestamptz,
  oneOf,
  customType,
  dateTrunc,
  prepare,
  rowNumber,
  over,
  count,
  sql,
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
    .users(
      (user) => ({
        id: user.id,
        posts: user.posts(
          (post) => ({
            title: post.title,
            tags: post.tags((tag) => ({ label: tag.label })),
          }),
          {
            orderBy: (post) => [post.createdAt.descending, post.id.descending],
            limit: 3,
          },
        ),
      }),
      {
        where: (user) => user.id.above(10),
        orderBy: (user) => user.id.ascending,
        limit: 50,
        offset: 1900,
      },
    )
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
    database.users(
      (user) => ({
        id: user.id,
        total: user.posts.count(),
      }),
      {
        where: (user) => user.id.above(parameters.after),
        orderBy: (user) => user.id.ascending,
        limit: parameters.size,
      },
    ),
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
      database.users(
        (user) => ({
          id: user.id,
        }),
        { orderBy: (user) => user.id.ascending, limit: 5 },
      ),
    ),
  ).toBe(
    'SELECT "users"."id" AS "id"\nFROM "users" AS "users"\nORDER BY "users"."id" ASC\nLIMIT 5',
  );
  // Ordering by a correlated aggregate needs every row scored first.
  expect(
    sqlOf(
      database.users(
        (user) => ({
          id: user.id,
          total: user.posts.count(),
        }),
        { orderBy: (user) => user.posts.count().descending, limit: 5 },
      ),
    ),
  ).not.toContain("FROM (SELECT");
  // Windows see the complete input.
  expect(
    sqlOf(
      database.users(
        (user) => ({
          id: user.id,
          position: over(rowNumber(), { orderBy: user.id.ascending }),
          total: user.posts.count(),
        }),
        { limit: 5 },
      ),
    ),
  ).not.toContain("FROM (SELECT");
  // Bare aggregates summarize the whole input.
  expect(
    sqlOf(
      database.users(
        (user) => ({
          total: count(),
          posts: user.posts.count(),
        }),
        { limit: 1 },
      ),
    ),
  ).not.toContain("FROM (SELECT");
  // DISTINCT, row locks and JOINs keep the original layout.
  expect(
    sqlOf(
      database.users(
        (user) => ({
          id: user.id,
          total: user.posts.count(),
        }),
        { distinct: true, limit: 5 },
      ),
    ),
  ).not.toContain("FROM (SELECT");
  expect(
    sqlOf(
      database.users(
        (user) => ({
          id: user.id,
          total: user.posts.count(),
        }),
        { forUpdate: true, limit: 5 },
      ),
    ),
  ).not.toContain("FROM (SELECT");
  expect(
    sqlOf(
      database.posts(
        (post) => ({
          id: post.id,
          author: post.author.name,
          tags: post.tags((tag) => ({ label: tag.label })),
        }),
        { limit: 5 },
      ),
    ),
  ).not.toContain('FROM (SELECT "posts"');
});

test("opaque projections and orderings keep their original evaluation scope", () => {
  for (const expression of [
    sql<bigint>`count(*) OVER ()`,
    sql<bigint>`count(*)`,
    sql<number>`random()`,
  ]) {
    const projected = database.users(
      (user) => ({
        value: { nested: expression },
        posts: user.posts.count(),
      }),
      { limit: 1 },
    );
    expect(projected.toSQL().sql).not.toContain('FROM (SELECT "users"');

    const ordered = database.users(
      (user) => ({
        posts: user.posts.count(),
      }),
      { orderBy: (user) => expression.descending, limit: 1 },
    );
    expect(ordered.toSQL().sql).not.toContain('FROM (SELECT "users"');
    expect(ordered.toSQL().sql.match(/ORDER BY/g)).toHaveLength(1);
  }
});

test("raw SQL in a nested query only blocks pagination within that scope", () => {
  const compiled = database
    .users(
      (user) => ({
        id: user.id,
        posts: user.posts(
          (post) => ({
            total: sql<bigint>`count(*) OVER ()`,
            tags: post.tags((tag) => ({ label: tag.label })),
          }),
          { limit: 1 },
        ),
      }),
      { limit: 1 },
    )
    .toSQL();

  expect(compiled.sql).toContain('FROM (SELECT "users"');
  expect(compiled.sql).not.toContain('FROM (SELECT "__symmetria_aggregate_0"');
});

test("a page cursor identifies the query, not the $scope() values in force", async () => {
  let tenants = [1];
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const local = schema(
    { documents: { id: int.auto, tenantId: int, title: text } },
    {
      executor: async (statement) => {
        statements.push(statement);

        // The hidden column carries the ordering key a cursor is made of.
        return [
          { id: 1, __symmetria_cursor_0: "1" },
          { id: 2, __symmetria_cursor_0: "2" },
        ];
      },
    },
  );
  const scoped = local.$scope({
    documents: (document) => document.tenantId.in(tenants),
  });
  const build = (minimum = 0) =>
    scoped.documents((document) => ({ id: document.id }), {
      where: (document) => document.id.above(minimum),
      orderBy: (document) => document.id.ascending,
    });
  const reused = build();
  const { nextCursor } = await reused.page({ size: 1 });

  expect(nextCursor).not.toBeNull();

  // Another tenant, and a filter that now renders different SQL.
  tenants = [2, 3];
  await reused.page({ size: 1, after: nextCursor });
  await build().page({ size: 1, after: nextCursor });

  // Both ran under the current scope, after the cursor.
  for (const statement of statements.slice(-2)) {
    expect(statement.sql).toContain('"documents"."tenant_id" IN ($1, $2)');
    expect(statement.parameters).toEqual([2, 3, 0, "1"]);
  }

  // The same cursor on an unscoped or differently filtered query is refused.
  await expect(build(5).page({ size: 1, after: nextCursor })).rejects.toThrow(
    /another query/,
  );
  await expect(
    local
      .documents((document) => ({ id: document.id }), {
        where: (document) => document.id.above(0),
        orderBy: (document) => document.id.ascending,
      })
      .page({ size: 1, after: nextCursor }),
  ).rejects.toThrow(/another query/);
});

test("a page ordered by an array column accepts its own cursor", async () => {
  const local = schema(
    {
      items: {
        id: int.auto,
        amounts: numeric(10, 2).array,
        days: date.array,
      },
    },
    {
      executor: async () => [
        {
          id: 1,
          __symmetria_cursor_0: "{1.50,2.00}",
          __symmetria_cursor_1: "1",
        },
        { id: 2, __symmetria_cursor_0: "{3.00}", __symmetria_cursor_1: "2" },
      ],
    },
  );
  const list = local.items((item) => ({ id: item.id }), {
    orderBy: (item) => [item.amounts.asc, item.id.asc],
  });
  const { nextCursor } = await list.page({ size: 1 });

  // The array's text form is its cursor value; the type check is PostgreSQL's.
  expect(await list.page({ size: 1, after: nextCursor })).toMatchObject({
    items: [{ id: 1 }],
  });
});

test("a page with a row lock reads the table itself, whatever its projection holds", async () => {
  const statements: string[] = [];
  const local = schema(
    { jobs: { id: int.auto, name: text, createdAt: timestamptz.now } },
    {
      executor: async (statement) => {
        statements.push(statement.sql);

        return [];
      },
    },
  );
  const locks = [
    [true, "FOR UPDATE"],
    [{ of: ["jobs"] }, 'FOR UPDATE OF "jobs"'],
    [{ skipLocked: true }, "FOR UPDATE SKIP LOCKED"],
    [{ noWait: true }, "FOR UPDATE NOWAIT"],
  ] as const;

  for (const [forUpdate, clause] of locks) {
    await local
      .jobs((job) => ({ id: job.id, day: dateTrunc("day", job.createdAt) }), {
        orderBy: (job) => job.id.asc,
        forUpdate,
      })
      .page({ size: 2 });
    await local
      .jobs((job) => ({ id: job.id, upper: sql<string>`upper(${job.name})` }), {
        orderBy: (job) => job.id.asc,
        forUpdate,
      })
      .page({ size: 2 });
    await local
      .jobs(
        (job) => ({
          id: job.id,
          position: rowNumber().over({ orderBy: job.id.asc }),
        }),
        { orderBy: (job) => job.id.asc, forUpdate },
      )
      .page({ size: 2 });

    // One lock, on the query that reads the page and the row after it.
    for (const statement of statements.splice(0)) {
      expect(statement).not.toContain("__symmetria_page");
      expect(statement).toContain('FROM "jobs" AS "jobs"\nORDER BY');
      expect(statement).toEndWith(`LIMIT 3\n${clause}`);
      expect(statement.match(/FOR UPDATE/g)).toHaveLength(1);
    }
  }

  // Without a lock the same projection is still read through a derived
  // table, where raw SQL may return several rows or hold a window.
  await local
    .jobs((job) => ({ id: job.id, upper: sql<string>`upper(${job.name})` }), {
      orderBy: (job) => job.id.asc,
    })
    .page({ size: 2 });
  expect(statements[0]).toContain('AS "__symmetria_page"');
  expect(statements[0]).not.toContain("FOR UPDATE");
});

test("a cursor value no type of its ordering column's family could hold is refused before any SQL is sent", async () => {
  // A value is held to the widest type of the family, since the database's
  // column may already be wider than the one this process declares.
  const cases = [
    {
      column: smallint,
      accepted: ["-32768", "32767", "0", "32768", "-9223372036854775808"],
      refused: ["9223372036854775808", "+1", "1.0", "1e2", ""],
    },
    {
      column: int,
      accepted: ["-2147483648", "2147483647", "2147483648", "99999999999"],
      refused: ["9223372036854775808", "-9223372036854775809"],
    },
    {
      column: bigint,
      accepted: ["-9223372036854775808", "9223372036854775807"],
      refused: ["9223372036854775808", "-9223372036854775809"],
    },
    {
      column: numeric,
      accepted: [
        "NaN",
        "Infinity",
        "-Infinity",
        "-0.000",
        // As many digits as a numeric holds on each side of the point.
        `${"9".repeat(131072)}.${"9".repeat(16383)}`,
        "1e131071",
        "1e-16383",
        "0e999999",
      ],
      refused: [
        "1e400000",
        "1e131072",
        "1e-16384",
        `1${"0".repeat(131072)}`,
        `0.${"0".repeat(16383)}1`,
        "1e1000000",
        "0x10",
      ],
    },
    {
      column: real,
      accepted: [
        "NaN",
        "-Infinity",
        "-0",
        "3.4028235e+38",
        "1e-45",
        "0e-99",
        // Beyond a real, within a double precision.
        "1e39",
        "7e-46",
      ],
      refused: ["1e309", "2e-324", "1e400000"],
    },
    {
      column: doublePrecision,
      accepted: ["1.7976931348623157e+308", "5e-324", "1e+15", "0.0001", "-0"],
      refused: ["1e309", "1.7976931348623159e+308", "2e-324", "1e-400000"],
    },
    {
      column: date,
      accepted: [
        "infinity",
        "-infinity",
        "2024-02-29",
        "2000-02-29",
        "0001-01-01",
        // 1 BC, 5 BC and 401 BC are leap years.
        "0001-02-29 BC",
        "0005-02-29 BC",
        "0401-02-29 BC",
        "4714-11-24 BC",
        "10000-01-01",
        "5874897-12-31",
      ],
      refused: [
        "2024-02-31",
        "2023-02-29",
        "1900-02-29",
        "0002-02-29 BC",
        "0101-02-29 BC",
        "0000-01-01",
        "2024-13-01",
        "2024-00-10",
        "2024-01-00",
        "2024-04-31",
        "2024-1-1",
        "today",
      ],
    },
    {
      column: timestamp,
      accepted: [
        "infinity",
        "2024-02-29 12:34:56.789",
        "0001-12-31 23:59:59.999999 BC",
        "4714-11-24 00:00:00 BC",
        "294276-12-31 23:59:59.999999",
        // PostgreSQL reads a leap second and the end of the day.
        "2024-01-01 23:59:60",
        "2024-01-01 24:00:00",
      ],
      refused: [
        "2024-02-31 00:00:00",
        "0000-01-01 00:00:00",
        "2024-01-01 23:59:60.5",
        "2024-01-01 24:00:00.000001",
        "2024-01-01 25:00:00",
        "2024-01-01 00:60:00",
        "2024-01-01 00:00:00+99",
        "now",
      ],
    },
    {
      column: timestamptz(3),
      accepted: [
        "-infinity",
        "2024-02-29 12:34:56.789+00",
        "2024-02-29 18:04:56.789+05:30",
        // An offset with seconds, as zones had before standard time.
        "1799-12-31 19:03:58-04:56:02",
        "2024-01-01 00:00:00+15:59:59",
        "0044-03-15 12:00:00+00 BC",
        // The first and the last moment, as zones far from UTC print them.
        "4714-11-23 12:00:00-12 BC",
        "294277-01-01 13:59:59.999999+14",
      ],
      refused: [
        "2024-02-31 00:00:00+00",
        "0000-01-01 00:00:00+00",
        "2024-01-01 00:00:00+99",
        "2024-01-01 00:00:00+16",
        "2024-01-01 00:00:00+05:60",
        "2024-01-01 00:00:00+053015",
      ],
    },
    {
      column: time,
      accepted: ["00:00:00", "23:59:59.999999", "24:00:00", "23:59:60"],
      refused: ["25:99", "24:00:00.000001", "23:60:00", "10:00", "garbage"],
    },
    {
      column: customType<string>("time with time zone", {
        encode: (value) => value,
        decode: String,
      }),
      accepted: ["12:34:56.7-04:56:02", "24:00:00+15:59:59", "01:02:03+00"],
      refused: ["12:34:56+16", "12:34:56+05:60", "25:00:00+00"],
    },
    {
      column: interval,
      accepted: [
        "00:00:00",
        "1 year 2 mons -3 days +04:05:06.789",
        "-00:00:00.5",
        "178956970 years 7 mons 2147483647 days 2562047788:00:54.775807",
        "-178956970 years -8 mons -2147483648 days -2562047788:00:54.775807",
        "infinity",
        // The same values under the other three IntervalStyle settings.
        "@ 1 year 2 mons -3 days 4 hours 5 mins 6.789 secs",
        "@ 178956970 years 8 mons 2147483648 days ago",
        "@ 0",
        "P1Y2M-3DT4H5M6.789S",
        "PT-0.5S",
        "PT0S",
        "1-2",
        "-3 4:05:06",
        "+1-2 -3 +4:05:06.789",
        "0",
      ],
      refused: [
        "garbage",
        "",
        "@",
        "P",
        "1",
        "1 week",
        "12 mons",
        "00:60:00",
        "178956970 years 8 mons",
        "2147483648 days",
        "2562047788:00:54.775808",
        "P99999999999Y",
        "@ 2147483649 days ago",
      ],
    },
    {
      // Labels are left to PostgreSQL: the database may hold one the schema
      // of this process does not list yet.
      column: oneOf("draft", "published"),
      accepted: ["draft", "published", "archived"],
      refused: ["a\u0000b"],
    },
    {
      column: text,
      accepted: ["", "a\u{1F600}b", "0000-00-00"],
      refused: ["a\u0000b"],
    },
  ];

  for (const { column, accepted, refused } of cases) {
    let sent = 0;
    const local = schema(
      { rows: { id: int.auto, value: column } },
      {
        executor: async () => {
          sent++;

          return [
            {
              id: 1,
              __symmetria_cursor_0: accepted[0],
              __symmetria_cursor_1: "1",
            },
            {
              id: 2,
              __symmetria_cursor_0: accepted[0],
              __symmetria_cursor_1: "2",
            },
          ];
        },
      },
    );
    const list = local.rows((row) => ({ id: row.id }), {
      orderBy: (row) => [row.value.asc, row.id.asc],
    });
    const { nextCursor } = await list.page({ size: 1 });
    const issued = JSON.parse(Buffer.from(nextCursor!, "base64url").toString());
    const cursor = (value: string) =>
      Buffer.from(JSON.stringify({ ...issued, values: [value, "1"] })).toString(
        "base64url",
      ) as NonNullable<typeof nextCursor>;

    for (const value of accepted) {
      expect(
        await list.page({ size: 1, after: cursor(value) }).then(
          () => value,
          (error) => `${value}: ${error.message}`,
        ),
      ).toBe(value);
    }

    const before = sent;

    for (const value of refused) {
      expect(
        await list.page({ size: 1, after: cursor(value) }).then(
          () => `${value}: accepted`,
          (error) => error.message,
        ),
      ).toBe("symmetria: invalid page cursor or cursor from another query");
    }

    expect(sent).toBe(before);
  }
});

test("a cursor value of an ORDER BY expression is held to the widest type of its family", async () => {
  let sent = 0;
  const local = schema(
    { rows: { id: int.auto, small: smallint, seenAt: timestamptz } },
    {
      executor: async () => {
        sent++;

        return [
          { id: 1, __symmetria_cursor_0: "1", __symmetria_cursor_1: "1" },
          { id: 2, __symmetria_cursor_0: "1", __symmetria_cursor_1: "2" },
        ];
      },
    },
  );
  // The declared type is the caller's word for the SQL: the product of an
  // integer column may well be a bigint.
  const scaled = local.rows((row) => ({ id: row.id }), {
    orderBy: (row) => [
      sql.of(int)`${row.small} * 1000000000000`.asc,
      row.id.asc,
    ],
  });
  const truncated = local.rows((row) => ({ id: row.id }), {
    orderBy: (row) => [dateTrunc("day", row.seenAt).asc, row.id.asc],
  });

  for (const [list, accepted, refused] of [
    [
      scaled,
      ["32767000000000000", "-9223372036854775808"],
      ["9223372036854775808", "1.5"],
    ],
    [
      truncated,
      ["2024-02-29 00:00:00+00", "294277-01-01 00:00:00+14"],
      ["2024-02-31 00:00:00+00", "2024-02-29 00:00:00+99"],
    ],
  ] as const) {
    const { nextCursor } = await list.page({ size: 1 });
    const issued = JSON.parse(Buffer.from(nextCursor!, "base64url").toString());
    const cursor = (value: string) =>
      Buffer.from(JSON.stringify({ ...issued, values: [value, "1"] })).toString(
        "base64url",
      ) as NonNullable<typeof nextCursor>;

    for (const value of accepted) {
      await list.page({ size: 1, after: cursor(value) });
    }

    const before = sent;

    for (const value of refused) {
      await expect(
        list.page({ size: 1, after: cursor(value) }),
      ).rejects.toThrow(/invalid page cursor/);
    }

    expect(sent).toBe(before);
  }
});

test("exists() in a paginated projection keeps the root rows paged first", () => {
  const { sql } = database
    .users(
      (user) => ({
        name: user.name,
        posts: user.posts.count(),
        has: user.posts.exists(),
      }),
      { orderBy: (user) => user.id.asc, limit: 3 },
    )
    .toSQL();

  // The subqueries run for the page's rows, not for every user.
  expect(sql).toContain('FROM (SELECT "users"."id" AS "id"');
  expect(sql).toContain("EXISTS (SELECT");
});
