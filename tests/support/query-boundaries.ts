import { expect, test } from "bun:test";
import {
  schema,
  int,
  jsonb,
  createDatabase,
  sql,
  count,
  not,
  prepare,
  coalesce,
  maximum,
} from "../../packages/runtime/src";
import { sqlite } from "../../packages/runtime/src/driver";
import { testDatabase } from "../../packages/kit/src/testing";

const metadata = {
  'a"b': "quoted",
  'a".b': { label: "nested" },
  'array"key': [1, 2],
  'boolean"key': true,
  'null"key': null,
  'number"key': 42,
  "a.b": "dotted",
  "a\\b": "backslash",
};
const model = schema({
  users: {
    id: int,
    numbers: int.array.nullable,
    metadata: jsonb<typeof metadata & { 'absent"key'?: string }>(),
  },
  posts: ({ users }) => ({ id: int, author: users }),
});

export const queryBoundaryTests = (dialect: "postgres" | "sqlite"): void => {
  const fixture = async () => {
    const postgresFixture =
      dialect === "postgres"
        ? await testDatabase({
            url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
            schema: model,
          })
        : undefined;
    const local = postgresFixture ? undefined : sqlite();
    local?.createTables(model);
    const driver = postgresFixture?.driver ?? local!;
    const database =
      postgresFixture?.database ?? createDatabase({ schema: model, driver });
    await database.users.insert(
      [null, [], [1], [2], [2], []].map((numbers, position) => ({
        id: position + 1,
        numbers,
        metadata,
      })),
    );
    await database.posts.insert([
      { id: 1, authorId: 1 },
      { id: 2, authorId: 2 },
      { id: 3, authorId: 2 },
    ]);

    return {
      database,
      driver,
      close: postgresFixture ? postgresFixture.close : () => database.$close(),
    };
  };

  test("aggregate sharing ignores source metadata carried through CTE JSON paths", async () => {
    const { database, close } = await fixture();

    try {
      const totals = database
        .users((users) => ({
          id: users.id,
          payload: { total: users.posts.count() },
        }))
        .cte("totals");
      const query = totals((totals) => ({
        id: totals.id,
        total: totals.payload.path("total"),
        $where: totals.payload.path("total").above(0),
        $orderBy: totals.id.ascending,
      }));
      expect(await query).toEqual([
        { id: 1, total: 1 },
        { id: 2, total: 2 },
      ]);
      expect(query.toSQL().sql).not.toContain("LATERAL");
      expect(
        await query.as("filtered")((filtered) => ({
          id: filtered.id,
          total: filtered.total,
          $orderBy: filtered.id.ascending,
        })),
      ).toEqual([
        { id: 1, total: 1 },
        { id: 2, total: 2 },
      ]);
    } finally {
      await close();
    }
  });

  test("CTEs inside shared aggregate filters retain dependencies and parameter order", async () => {
    const { database, close } = await fixture();

    try {
      const early = database
        .posts((post) => ({ id: post.id, $where: post.id.atLeast(1) }))
        .cte("early");
      const allowed = database
        .posts((post) => ({ id: post.id, $where: post.id.atMost(2) }))
        .cte("allowed");
      const query = database.users((user) => {
        const total = user
          .posts((post) => ({
            $where: post.id.in(allowed((row) => ({ id: row.id }))),
          }))
          .count();

        return {
          id: user.id,
          $where: [
            user.id.in(early((row) => ({ id: row.id }))),
            total.above(0),
          ],
          $orderBy: [total.descending, user.id.ascending],
        };
      });
      const compiled = query.toSQL();
      expect(compiled.sql.match(/"early" AS \(/g)).toHaveLength(1);
      expect(compiled.sql.match(/"allowed" AS \(/g)).toHaveLength(1);

      if (dialect === "postgres") {
        expect(compiled.sql).toContain("JOIN LATERAL");
      }

      expect(await query).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      await close();
    }
  });

  test("literal INSERT fast paths retain CTEs in later rows, conflict updates and RETURNING", async () => {
    const { database, close } = await fixture();

    try {
      const source = database
        .users((user) => ({ id: user.id, $where: user.id.is(2) }))
        .cte("chosen_author");
      const author = source((row) => ({ id: row.id })).scalar();
      const mixed = database.posts
        .insert([
          { id: 4, authorId: 1 },
          { id: 5, authorId: sql<number>`(${author} + ${0})` },
        ])
        .returning((row) => ({ id: row.id, authorId: row.authorId }));
      expect(mixed.toSQL().parameters).toEqual([2, 4, 1, 5, 0]);
      expect(await mixed).toEqual([
        { id: 4, authorId: 1 },
        { id: 5, authorId: 2 },
      ]);

      const literal = database.posts.insert({ id: 4, authorId: 1 });
      const original = literal.toSQL();
      const conflict = literal
        .onConflict("id")
        .doUpdate({ authorId: coalesce(author, 1) })
        .returning((row) => ({ id: row.id, authorId: row.authorId }));
      expect(conflict.toSQL().parameters).toEqual([2, 4, 1, 1]);
      expect(await conflict).toEqual({ id: 4, authorId: 2 });
      expect(literal.toSQL()).toEqual(original);
      expect(original.sql).not.toContain("WITH");

      const returning = database.posts
        .insert({ id: 6, authorId: 1 })
        .returning((row) => ({ id: row.id, chosen: author }));
      expect(returning.toSQL().parameters).toEqual([2, 6, 1]);
      expect(await returning).toEqual({ id: 6, chosen: 2 });

      const prepared = prepare({ id: int, authorId: int }, (parameters) =>
        database.posts
          .insert(parameters)
          .returning((row) => ({ id: row.id, authorId: row.authorId })),
      );
      expect(await prepared.execute({ id: 7, authorId: 1 })).toEqual({
        id: 7,
        authorId: 1,
      });
    } finally {
      await close();
    }
  });

  test("expression equivalence treats AST-shaped parameter contents as application data", async () => {
    const { database, driver, close } = await fixture();

    const rendered = async (value: unknown): Promise<string> => {
      const result = await driver.execute({
        sql: `SELECT CAST(${dialect === "postgres" ? "$1" : "?1"} AS TEXT) AS bucket`,
        parameters: [value],
      });

      return (Array.isArray(result) ? result : result.rows)[0]!
        .bucket as string;
    };

    try {
      for (const kind of ["select", "parameter", "column", "placeholder"]) {
        const payload = {
          kind,
          binding: "user data",
          value: { kind: "select", label: "nested" },
        };

        const bucket = () => sql<string>`CAST(${payload} AS TEXT)`;

        expect(
          await database.users((users) => ({
            bucket: bucket(),
            total: count(),
            $groupBy: [bucket()],
          })),
        ).toEqual([{ bucket: await rendered(payload), total: 6 }]);
        expect(
          await database.users((users) => ({
            bucket: bucket(),
            $distinct: true,
            $orderBy: bucket().ascending,
          })),
        ).toEqual([{ bucket: await rendered(payload) }]);
      }

      const first = { kind: "select", label: "first" };
      const second = { kind: "select", label: "second" };
      expect(
        await database.users((users) => ({
          first: sql<string>`CAST(${first} AS TEXT)`,
          second: sql<string>`CAST(${second} AS TEXT)`,
          $distinct: true,
          $orderBy: sql<string>`CAST(${second} AS TEXT)`.ascending,
        })),
      ).toEqual([
        { first: await rendered(first), second: await rendered(second) },
      ]);
      const ordered = { first: 1, second: 2 };
      const reordered = { second: 2, first: 1 };

      for (const [first, second] of [
        [ordered, reordered],
        [[ordered], [reordered]],
        [{ nested: ordered }, { nested: reordered }],
      ]) {
        expect(
          await database.users((users) => ({
            first: sql<string>`CAST(${first} AS TEXT)`,
            second: sql<string>`CAST(${second} AS TEXT)`,
            $distinct: true,
          })),
        ).toEqual([
          { first: await rendered(first), second: await rendered(second) },
        ]);
      }

      for (const payload of [
        9007199254740993n,
        new Date("2026-01-02T03:04:05.000Z"),
        new Uint8Array([65, 66]),
        [1, 2],
      ]) {
        const bucket = () => sql<string>`CAST(${payload} AS TEXT)`;

        expect(
          await database.users((users) => ({
            bucket: bucket(),
            total: count(),
            $groupBy: [bucket()],
          })),
        ).toEqual([{ bucket: await rendered(payload), total: 6 }]);
      }
    } finally {
      await close();
    }
  });

  test("SQL-array access returns null for oversized positions and extreme storage bounds", async () => {
    const { database, driver, close } = await fixture();

    try {
      const query = database.users((users) => ({
        id: users.id,
        first: users.numbers.path(0),
        second: users.numbers.path(1),
        missing: users.numbers.path(100),
        wide: users.numbers.path(2147483646),
        huge: users.numbers.path(Number.MAX_SAFE_INTEGER),
        fallback: coalesce(users.numbers, [5]).path(Number.MAX_SAFE_INTEGER),
        length: users.numbers.length(),
        $orderBy: users.id.ascending,
      }));
      const result = await query;
      expect(result.map(({ first }) => first)).toEqual([
        null,
        null,
        1,
        2,
        2,
        null,
      ]);
      expect(result.map(({ length }) => length)).toEqual([null, 0, 1, 1, 1, 0]);
      expect(
        result.every(
          ({ second, missing, wide, huge, fallback }) =>
            second === null &&
            missing === null &&
            wide === null &&
            huge === null &&
            fallback === null,
        ),
      ).toBe(true);
      expect(
        await database.users((users) => ({
          value: maximum(users.numbers).path(Number.MAX_SAFE_INTEGER),
        })),
      ).toEqual([{ value: null }]);
      expect(
        await database.users((users) => ({
          value: maximum(users.numbers).path(Number.MAX_SAFE_INTEGER),
          $where: users.id.below(0),
        })),
      ).toEqual([{ value: null }]);

      if (dialect === "postgres") {
        await driver.execute({
          sql: "UPDATE users SET numbers = '[2147483644:2147483645]={10,20}'::integer[] WHERE id = 3",
          parameters: [],
        });
        expect((await query)[2]).toEqual({
          id: 3,
          first: 10,
          second: 20,
          missing: null,
          wide: null,
          huge: null,
          fallback: null,
          length: 2,
        });
      }
    } finally {
      await close();
    }
  });

  test("native array membership preserves SQL unknown for NULL containers, elements and operands", async () => {
    const { database, driver, close } = await fixture();

    try {
      for (const [id, numbers] of [
        [5, [2, null]],
        [6, [null]],
      ] as const) {
        await driver.execute({
          sql: `UPDATE users SET numbers = ${dialect === "postgres" ? "$1::integer[]" : "?1"} WHERE id = ${id}`,
          parameters: [numbers],
        });
      }

      const matching = prepare({ member: int.nullable }, (parameters) =>
        database.users((users) => ({
          id: users.id,
          $where: users.numbers.has(parameters.member),
          $orderBy: users.id.ascending,
        })),
      );
      const missing = prepare({ member: int.nullable }, (parameters) =>
        database.users((users) => ({
          id: users.id,
          $where: not(users.numbers.has(parameters.member)),
          $orderBy: users.id.ascending,
        })),
      );
      expect(await matching.execute({ member: 1 })).toEqual([{ id: 3 }]);
      expect(await missing.execute({ member: 1 })).toEqual([
        { id: 2 },
        { id: 4 },
      ]);
      expect(await matching.execute({ member: 2 })).toEqual([
        { id: 4 },
        { id: 5 },
      ]);
      expect(await missing.execute({ member: 2 })).toEqual([
        { id: 2 },
        { id: 3 },
      ]);
      expect(await matching.execute({ member: null })).toEqual([]);
      expect(await missing.execute({ member: null })).toEqual([{ id: 2 }]);
      expect(
        await database.users.as("__symmetria_array")((__symmetria_array) => ({
          id: __symmetria_array.id,
          $where: not(__symmetria_array.numbers.has(__symmetria_array.id)),
          $orderBy: __symmetria_array.id.ascending,
        })),
      ).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
    } finally {
      await close();
    }
  });

  test("quoted JSON keys preserve objects, scalars, nulls and typed projections", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.users.as("__symmetria_json_path")(
        (__symmetria_json_path) => ({
          quoted: __symmetria_json_path.metadata.path('a"b'),
          dotted: __symmetria_json_path.metadata.path("a.b"),
          backslash: __symmetria_json_path.metadata.path("a\\b"),
          nested: __symmetria_json_path.metadata.path('a".b', "label"),
          array: __symmetria_json_path.metadata.path('array"key'),
          boolean: __symmetria_json_path.metadata.path('boolean"key'),
          null: __symmetria_json_path.metadata.path('null"key'),
          number: __symmetria_json_path.metadata.path('number"key'),
          absent: __symmetria_json_path.metadata.path('absent"key'),
          $where: __symmetria_json_path.id.is(1),
        }),
      );
      const expected = [
        {
          quoted: "quoted",
          dotted: "dotted",
          backslash: "backslash",
          nested: "nested",
          array: [1, 2],
          boolean: true,
          null: null,
          number: 42,
          absent: null,
        },
      ];
      expect(await query).toEqual(expected);
      expect(
        await query.as("keys")((keys) => ({
          payload: {
            quoted: keys.quoted,
            nested: keys.nested,
            array: keys.array,
            boolean: keys.boolean,
            null: keys.null,
            number: keys.number,
            absent: keys.absent,
          },
        })),
      ).toEqual(
        expected.map(
          ({ dotted: _dotted, backslash: _backslash, ...payload }) => ({
            payload,
          }),
        ),
      );
      const projected = database
        .users((users) => ({
          payload: { 'number"field': users.id, 'array"field': users.numbers },
          $where: users.id.is(3),
        }))
        .cte("projected");
      expect(
        await projected((projected) => ({
          number: projected.payload.path('number"field'),
          array: projected.payload.path('array"field'),
        })),
      ).toEqual([{ number: 3, array: [1] }]);
    } finally {
      await close();
    }
  });
};
