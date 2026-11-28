import { expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  prepare,
  int,
  text,
  bigint,
  numeric,
  jsonb,
  timestamptz,
  customType,
  bool,
  and,
  or,
  not,
  exists,
  notExists,
  sql,
  type CompiledQuery,
  type Parameter,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

test("prepared factories run once and retain result inference, codecs and parameter order", async () => {
  let builds = 0;
  const calls: CompiledQuery[] = [];
  const database = schema(
    { records: { id: int, name: text, visits: bigint } },
    {
      executor: async (query) => {
        calls.push(query);

        return [
          { id: query.parameters[0], name: "Ada", visits: "9007199254740993" },
        ];
      },
    },
  );
  const lookup = prepare(
    { id: int, minimum: bigint, size: int },
    (parameters) => {
      builds++;

      return database.records(
        (records) => ({
          id: records.id,
          name: records.name,
          visits: records.visits,
        }),
        {
          where: (records) =>
            and(
              records.id.is(parameters.id),
              records.visits.above(parameters.minimum),
            ),
          limit: parameters.size,
        },
      );
    },
  );
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof lookup.execute>>,
      { id: number; name: string; visits: bigint }[]
    >
  >;
  expect(lookup.toSQL({ id: 1, minimum: 3n, size: 10 }).parameters).toEqual([
    1,
    "3",
    10,
  ]);
  expect(await lookup.execute({ id: 2, minimum: 4n, size: 20 })).toEqual([
    { id: 2, name: "Ada", visits: 9007199254740993n },
  ]);
  await lookup.execute({ id: 3, minimum: 5n, size: 30 });
  expect(calls[0]?.sql).toBe(calls[1]?.sql);
  expect(calls[1]?.parameters).toEqual([3, "5", 30]);
  expect(builds).toBe(1);
  expect(() => lookup.toSQL({ id: 1, minimum: 0n, size: -1 })).toThrow(
    /nonnegative/,
  );
  expect(() => lookup.toSQL({ id: 1, minimum: 0n } as never)).toThrow(
    /exactly/,
  );
  expect(() =>
    lookup.toSQL({ id: 1, minimum: 0n, size: 1, extra: 2 } as never),
  ).toThrow(/exactly/);
  expect(() =>
    lookup.toSQL({ id: undefined, minimum: 0n, size: 1 } as never),
  ).toThrow(/undefined/);
  expect(() =>
    lookup.toSQL({ id: null, minimum: 0n, size: 1 } as never),
  ).toThrow(/null/);
});

test("prepared mutations encode JSON, Dates and custom values without retaining caller objects", async () => {
  const amount = customType<{ cents: bigint }>("bigint", {
    encode: (value) => value.cents.toString(),
    decode: (value) => ({ cents: BigInt(String(value)) }),
  });
  const calls: CompiledQuery[] = [];
  const database = schema(
    {
      records: {
        id: int.auto,
        details: jsonb<{ tags: string[] }>(),
        createdAt: timestamptz,
        amount,
      },
    },
    {
      executor: async (query) => {
        calls.push(query);

        return { rows: [{ id: 1, amount: "123" }], affectedRows: 1 };
      },
    },
  );
  const insert = prepare(
    { details: jsonb<{ tags: string[] }>(), createdAt: timestamptz, amount },
    (parameters) =>
      database.records
        .insert(parameters)
        .returning((records) => [records.id, records.amount]),
  );
  const values = {
    details: { tags: ["sql"] },
    createdAt: new Date("2026-01-01"),
    amount: { cents: 123n },
  };
  const compiled = insert.toSQL(values);
  expect(compiled.sql).toContain("::text::jsonb");
  expect(compiled.parameters).toEqual([
    '{"tags":["sql"]}',
    "2026-01-01T00:00:00.000Z",
    "123",
  ]);
  values.details.tags.push("bun");
  values.createdAt.setUTCFullYear(2027);
  expect(compiled.parameters[0]).toBe('{"tags":["sql"]}');
  expect(compiled.parameters[1]).toBe("2026-01-01T00:00:00.000Z");
  expect(await insert.execute(values)).toEqual({
    id: 1,
    amount: { cents: 123n },
  });
  const remove = prepare({ id: int }, (parameters) =>
    database.records.delete().where((records) => records.id.is(parameters.id)),
  );
  type Removed = Assert<
    Equal<Awaited<ReturnType<typeof remove.execute>>, { affectedRows: number }>
  >;
  expect(await remove.execute({ id: 1 })).toEqual({ affectedRows: 1 });
});

test("static prepared queries return detached parameters and use their original executor", async () => {
  const database = schema(
    { records: { id: int, name: text } },
    { executor: async () => [{ id: 1 }] },
  );
  const prepared = database
    .records((records) => ({ id: records.id }), {
      where: (records) => records.name.is("Ada"),
    })
    .prepare();
  const compiled = prepared.toSQL();
  compiled.parameters[0] = "modified";
  expect(prepared.toSQL().parameters).toEqual(["Ada"]);
  expect(await prepared.execute()).toEqual([{ id: 1 }]);
});

test("prepared subqueries share parameter numbering and reject escaped scopes", () => {
  const database = schema({ records: { id: int, name: text.nullable } });
  const lookup = prepare({ minimum: int, name: text.nullable }, (parameters) =>
    database.records(
      (records) => ({
        id: records.id,
        label: sql<string | null>`${parameters.name}`.as("label"),
      }),
      {
        where: (records) =>
          records.id.in(
            database.records.as("nested")(
              (nested) => ({
                id: nested.id,
              }),
              { where: (nested) => nested.id.above(parameters.minimum) },
            ),
          ),
      },
    ),
  );
  expect(lookup.toSQL({ minimum: 5, name: null }).parameters).toEqual([
    null,
    5,
  ]);
  let escaped: Parameter<number>;
  prepare({ id: int }, (parameters) => {
    escaped = parameters.id;

    return database.records(
      (records) => ({
        id: records.id,
      }),
      { where: (records) => records.id.is(parameters.id) },
    );
  });
  expect(() =>
    prepare({ id: int }, () =>
      database.records(
        (records) => ({
          id: records.id,
        }),
        { where: (records) => records.id.is(escaped) },
      ),
    ),
  ).toThrow(/another prepare/);
  expect(() =>
    database
      .records(
        (records) => ({
          id: records.id,
        }),
        { where: (records) => records.id.is(escaped) },
      )
      .toSQL(),
  ).toThrow(/bind parameter/);
});

test("a prepared lookup by key refuses a parameter that may be null", () => {
  const database = schema({
    users: { id: int.auto, name: text, email: text.unique.nullable },
  });

  // Bound to null it would compare as IS NULL and reach every NULL key.
  expect(() =>
    prepare({ email: text.nullable }, (p) =>
      database.users.by.email(p.email as never).delete(),
    ),
  ).toThrow('unique key "email" cannot be a nullable parameter (email)');
  expect(() =>
    prepare({ id: int.nullable }, (p) =>
      database.users.byId(p.id as never).update({ name: "x" }),
    ),
  ).toThrow('primary key "id" cannot be a nullable parameter (id)');
  expect(() =>
    prepare({ email: text }, (p) => database.users.by.email(p.email).delete()),
  ).not.toThrow();
});

test("a prepared write refuses the values that make its filter hold for every row", async () => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    {
      users: { id: int.auto, name: text },
      posts: ({ users }) => ({
        id: int.auto,
        author: users,
        tags: text.array,
        editorId: int.nullable,
      }),
    },
    {
      executor: async (query) => {
        calls.push(query);

        return { rows: [], affectedRows: 0 };
      },
    },
  );
  const refusal = "where() leaves no condition";

  // Bound to null, isNot(p) of a NOT NULL column is isNot(null).
  const others = prepare({ author: int.nullable }, (p) =>
    database.posts.delete().where((post) => post.authorId.isNot(p.author)),
  );
  await expect(others({ author: null })).rejects.toThrow(refusal);
  expect(() => others.toSQL({ author: null })).toThrow(refusal);
  expect(await others({ author: 2 })).toEqual({ affectedRows: 0 });

  const distinct = prepare({ author: int.nullable }, (p) =>
    database.posts
      .update({ tags: [] })
      .where((post) => post.authorId.isDistinctFrom(p.author)),
  );
  await expect(distinct({ author: null })).rejects.toThrow(refusal);
  // A NULL column is a condition either way.
  const edited = prepare({ editor: int.nullable }, (p) =>
    database.posts.delete().where((post) => post.editorId.isNot(p.editor)),
  );
  expect(await edited({ editor: null })).toEqual({ affectedRows: 0 });

  // Values every count passes, a LIMIT of 0, an empty list to contain.
  for (const [write, refused, accepted] of [
    [
      prepare({ n: int }, (p) =>
        database.users
          .delete()
          .where((user) => user.posts.count().atLeast(p.n)),
      ),
      { n: 0 },
      { n: 1 },
    ],
    [
      prepare({ n: int }, (p) =>
        database.users.delete().where((user) => user.posts.count().isNot(p.n)),
      ),
      { n: -1 },
      { n: 0 },
    ],
    [
      prepare({ n: int }, (p) =>
        database.users.delete().where((user) =>
          user
            .posts({ where: (post) => post.id.in([]) })
            .count()
            .is(p.n),
        ),
      ),
      { n: 0 },
      { n: 1 },
    ],
    [
      prepare({ n: int }, (p) =>
        database.users.update({ name: "x" }).where((user) =>
          user.id.notIn(
            database.posts((post) => ({ id: post.authorId }), {
              limit: p.n,
            }),
          ),
        ),
      ),
      { n: 0 },
      { n: 1 },
    ],
    [
      prepare({ tags: text.array }, (p) =>
        database.posts.delete().where((post) => post.tags.contains(p.tags)),
      ),
      { tags: [] },
      { tags: ["a"] },
    ],
  ] as const) {
    const run = write as (values: object) => Promise<unknown>;

    await expect(run(refused)).rejects.toThrow(refusal);
    expect(await run(accepted)).toEqual({ affectedRows: 0 });
  }

  // Another condition or all() makes the same values a filter.
  const keyed = prepare({ author: int.nullable }, (p) =>
    database.posts
      .delete()
      .where((post) => post.id.is(1))
      .where((post) => post.authorId.isNot(p.author)),
  );
  const everything = prepare({ author: int.nullable }, (p) =>
    database.posts
      .delete()
      .where((post) => post.authorId.isNot(p.author))
      .all(),
  );
  expect(await keyed({ author: null })).toEqual({ affectedRows: 0 });
  expect(await everything({ author: null })).toEqual({ affectedRows: 0 });
  // Refused values never reach the executor.
  expect(calls.map((call) => call.sql)).toHaveLength(9);
  // An emptied contains() says what it would match, as the literal does.
  const tagged = prepare({ tags: text.array }, (p) =>
    database.posts.delete().where((post) => post.tags.contains(p.tags)),
  );
  await expect(tagged({ tags: [] })).rejects.toThrow(
    "contains() of an empty list or object matches every row that holds a value",
  );
});

test("a prepared write compares parameters by the values they bind: a condition and its opposite in two parameters is refused", async () => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    { items: { id: int.auto, active: bool, status: text, name: text } },
    {
      executor: async (query) => {
        calls.push(query);

        return { rows: [], affectedRows: 0 };
      },
    },
  );
  const refusal = "where() leaves no condition";

  for (const [write, refused, accepted] of [
    [
      prepare({ a: bool, b: bool }, (p) =>
        database.items
          .delete()
          .where((item) => or(item.active.is(p.a), item.active.is(p.b))),
      ),
      { a: true, b: false },
      { a: true, b: true },
    ],
    [
      prepare({ a: text, b: text }, (p) =>
        database.items
          .delete()
          .where((item) => or(item.status.is(p.a), item.status.isNot(p.b))),
      ),
      { a: "open", b: "open" },
      { a: "open", b: "done" },
    ],
    [
      prepare({ a: int, b: int }, (p) =>
        database.items
          .update({ name: "x" })
          .where((item) => or(item.id.below(p.a), item.id.atLeast(p.b))),
      ),
      { a: 3, b: 2 },
      { a: 2, b: 3 },
    ],
    [
      prepare({ a: int, b: int }, (p) =>
        database.items
          .delete()
          .where((item) => not(and(item.id.is(p.a), item.id.isNot(p.b)))),
      ),
      { a: 1, b: 1 },
      { a: 1, b: 2 },
    ],
    // A pattern of only % matches every name.
    [
      prepare({ pattern: text }, (p) =>
        database.items.delete().where((item) => item.name.like(p.pattern)),
      ),
      { pattern: "%" },
      { pattern: "a%" },
    ],
  ] as const) {
    const run = write as (values: object) => Promise<unknown>;

    await expect(run(refused)).rejects.toThrow(refusal);
    expect(await run(accepted)).toEqual({ affectedRows: 0 });
  }

  expect(calls).toHaveLength(5);

  // JSON null bound to a parameter that may not be null is isDistinctFrom(null),
  // and so is SQL NULL bound to one that may; a range the values decide.
  const docs = schema(
    { docs: { id: int.auto, meta: jsonb<unknown>() } },
    {
      executor: async (query) => {
        calls.push(query);

        return { rows: [], affectedRows: 0 };
      },
    },
  ).docs;

  for (const [write, refused, accepted] of [
    [
      prepare({ p: jsonb<unknown>() }, (p) =>
        docs
          .delete()
          .where((doc) => or(doc.meta.isDistinctFrom(p.p), doc.meta.is(null))),
      ),
      { p: null },
      { p: 5 },
    ],
    [
      prepare({ p: jsonb<unknown>().nullable }, (p) =>
        docs
          .delete()
          .where((doc) => or(doc.meta.is(null), doc.meta.isDistinctFrom(p.p))),
      ),
      { p: null },
      { p: 5 },
    ],
    [
      prepare({ p: int }, (p) =>
        docs
          .delete()
          .where((doc) =>
            or(doc.id.below(5), and(doc.id.atLeast(p.p), doc.id.atLeast(4))),
          ),
      ),
      { p: 5 },
      { p: 6 },
    ],
    [
      prepare({ p: int }, (p) =>
        docs
          .delete()
          .where((doc) =>
            or(doc.id.below(3), doc.id.between(3, p.p), doc.id.above(5)),
          ),
      ),
      { p: 5 },
      { p: 4 },
    ],
  ] as const) {
    const run = write as (values: object) => Promise<unknown>;

    await expect(run(refused)).rejects.toThrow(refusal);
    expect(await run(accepted)).toEqual({ affectedRows: 0 });
  }

  const distinct = prepare({ p: jsonb<unknown>() }, (p) =>
    docs.delete().where((doc) => doc.meta.isDistinctFrom(p.p)),
  );

  expect(
    (distinct as unknown as { toSQL: (values: object) => CompiledQuery }).toSQL(
      { p: null },
    ).sql,
  ).toContain(
    `NULLIF("docs"."meta", 'null'::jsonb) IS DISTINCT FROM NULLIF($1::text::jsonb, 'null'::jsonb)`,
  );
  // A column compared with a parameter no other part tests is a condition
  // whatever it binds.
  const keyed = prepare({ id: int }, (p) =>
    database.items
      .delete()
      .where((item) => or(item.name.is("x"), item.id.is(p.id))),
  );
  expect(await keyed({ id: 1 })).toEqual({ affectedRows: 0 });
});

test("a prepared write compares parameters inside subqueries, relation quantifiers and groups by the values they bind", async () => {
  const calls: CompiledQuery[] = [];
  const database = schema(
    {
      users: { id: int.auto, name: text },
      posts: ({ users }) => ({
        id: int.auto,
        author: users,
        views: int.nullable,
      }),
    },
    {
      executor: async (query) => {
        calls.push(query);

        return { rows: [], affectedRows: 0 };
      },
    },
  );
  const refusal = "where() leaves no condition";
  const viewed = (views: never) =>
    database.posts((post) => ({ id: post.id }), {
      where: (post) => post.views.is(views),
    });
  // Each write, as a function of two values: the same filter written with
  // equal values holds for every row (a condition and its opposite), with
  // others it does not. Before, the prepared write rewrote every row.
  const writes: ((
    a: never,
    b: never,
  ) => {
    toSQL: () => CompiledQuery;
  })[] = [
    (a, b) =>
      database.users.update({ name: "x" }).where((user) =>
        or(
          user.posts.some((post) => post.views.is(a)),
          user.posts.none((post) => post.views.is(b)),
        ),
      ),
    (a, b) =>
      database.users.delete().where((user) =>
        or(
          user.posts.some((post) => post.views.is(a)),
          not(user.posts.some((post) => post.views.is(b))),
        ),
      ),
    (a, b) =>
      database.users
        .delete()
        .where(() => or(exists(viewed(a)), notExists(viewed(b)))),
    // Below a not(), and beside other conditions.
    (a, b) =>
      database.users.delete().where((user) =>
        not(
          and(
            user.name.isNot("x"),
            user.posts.none((post) => post.views.is(a)),
            user.posts.some((post) => post.views.is(b)),
          ),
        ),
      ),
    (a, b) =>
      database.users
        .delete()
        .where((user) =>
          or(user.posts.count().is(a), user.posts.count().isNot(b)),
        ),
    (a, b) =>
      database.users
        .delete()
        .where((user) =>
          or(
            and(user.id.is(a), user.name.is("x")),
            not(and(user.id.is(b), user.name.is("x"))),
          ),
        ),
  ];

  for (const write of writes) {
    const prepared = prepare(
      { a: int, b: int },
      (p) => write(p.a as never, p.b as never) as never,
    ) as unknown as (values: object) => Promise<unknown>;

    expect(() => write(1 as never, 1 as never).toSQL()).toThrow(refusal);
    await expect(prepared({ a: 1, b: 1 })).rejects.toThrow(refusal);
    expect(() => write(1 as never, 2 as never).toSQL()).not.toThrow();
    expect(await prepared({ a: 1, b: 2 })).toEqual({ affectedRows: 0 });
  }

  // Nullable parameters bound to null compare as is(null) written out.
  const nullable = prepare({ a: int.nullable, b: int.nullable }, (p) =>
    database.users.delete().where((user) =>
      or(
        user.posts.some((post) => post.views.isNot(p.a)),
        user.posts.none((post) => post.views.isNot(p.b)),
      ),
    ),
  );

  await expect(nullable({ a: null, b: null })).rejects.toThrow(refusal);
  expect(await nullable({ a: null, b: 2 })).toEqual({ affectedRows: 0 });
  // A group beside its own not(): bound to null, posts.editorId.isNot(p.a)
  // is isNot(null), never NULL, so the pair holds for every row.
  const paired = prepare({ a: int.nullable }, (p) =>
    database.posts.delete().where((post) => {
      const pair = and(post.views.isNot(p.a), post.id.is(1));

      return or(pair, not(pair));
    }),
  );

  expect(() =>
    database.posts
      .delete()
      .where((post) => {
        const pair = and(post.views.isNot(null), post.id.is(1));

        return or(pair, not(pair));
      })
      .toSQL(),
  ).toThrow(refusal);
  await expect(paired({ a: null })).rejects.toThrow(refusal);
  expect(await paired({ a: 2 })).toEqual({ affectedRows: 0 });
  expect(calls).toHaveLength(writes.length + 2);
});

test("a prepared write whose filter no values can make hold for every row costs no check, with nullable parameters too", async () => {
  const database = schema(
    {
      items: { id: int.auto, age: int.nullable },
      posts: ({ items }) => ({
        id: int.auto,
        item: items,
        views: int.nullable,
      }),
    },
    { executor: async () => ({ rows: [], affectedRows: 0 }) },
  );
  const count = 50;
  const names = Array.from({ length: 2 * count }, (_, k) => `p${k}`);
  // The same filter with nullable parameters and with NOT NULL ones: no
  // values make it hold for every row (bound to null, age.isNot(q) is
  // age.isNot(null), still a condition). The nullable one was checked at
  // each execution, about 10 times its cost in 3.5.0.
  const write = (nullable: boolean) =>
    prepare(
      Object.fromEntries(
        names.map((name) => [name, nullable ? int.nullable : int]),
      ) as Record<string, typeof int>,
      (p) =>
        database.items
          .delete()
          .where((item) =>
            or(
              ...Array.from({ length: count }, (_, k) =>
                and(
                  item.id.is(p[`p${2 * k}`]!),
                  item.age.isNot(p[`p${2 * k + 1}`]!),
                ),
              ),
            ),
          ),
    ) as unknown as { toSQL: (values: object) => unknown };
  const nullable = write(true);
  const present = write(false);
  // Every other age parameter bound to null where it may be.
  const values = (run: number, nulls: boolean) =>
    Object.fromEntries(
      names.map((name, k) => [
        name,
        nulls && k % 2 && (k + run) % 4 === 1 ? null : k + run,
      ]),
    );
  const timed = (query: typeof nullable, run: object) => {
    const started = performance.now();

    query.toSQL(run);

    return performance.now() - started;
  };
  const times: [number[], number[]] = [[], []];

  for (let run = 0; run < 300; run += 1) {
    times[0].push(timed(nullable, values(run, true)));
    times[1].push(timed(present, values(run, false)));
  }

  const [checked, unchecked] = times.map(
    (list) => list.sort((first, second) => first - second)[150]!,
  );

  expect(checked!).toBeLessThan(unchecked! * 3);

  // One nullable parameter in an or(), and in a quantifier.
  const refusal = "where() leaves no condition";
  const either = prepare({ a: int, b: int.nullable }, (p) =>
    database.items
      .delete()
      .where((item) => or(item.id.is(p.a), item.age.is(p.b))),
  );
  const viewed = prepare({ b: int.nullable }, (p) =>
    database.items
      .delete()
      .where((item) => item.posts.some((post) => post.views.isNot(p.b))),
  );

  expect(await either({ a: 1, b: null })).toEqual({ affectedRows: 0 });
  expect(await viewed({ b: null })).toEqual({ affectedRows: 0 });
  // Values still decide where they can: id.isNot(null) of a NOT NULL column.
  const decided = prepare({ a: int, b: int.nullable }, (p) =>
    database.items
      .delete()
      .where((item) => or(item.age.is(p.a), item.id.isNot(p.b))),
  );

  await expect(decided({ a: 1, b: null })).rejects.toThrow(refusal);
  expect(await decided({ a: 1, b: 2 })).toEqual({ affectedRows: 0 });
});

test("a prepared write checks a group used in two places at each, and a deep filter no values can make hold for every row costs no check", async () => {
  const database = schema(
    { items: { id: int.auto, at: int, name: text } },
    { executor: async () => ({ rows: [], affectedRows: 0 }) },
  );
  const refusal = "where() leaves no condition";
  // One group object in two places: not(or(pair, pair)) holds for every row
  // where the pair is a condition and its opposite (p bound to 2).
  const shared = prepare({ p: int }, (p) =>
    database.items.delete().where((item) => {
      const pair = and(item.id.isNot(2), item.id.is(p.p));

      return not(or(pair, pair));
    }),
  );

  await expect(shared({ p: 2 })).rejects.toThrow(refusal);
  expect(await shared({ p: 3 })).toEqual({ affectedRows: 0 });

  // Windows of `at` and a chain of 100 not()s, each comparison with its own
  // parameter: no values make them hold for every row. Each execution cost
  // about 0.3 ms and 20 ms in 3.6.0 candidates before this, 0.01 ms in 3.5.0.
  const count = 100;
  const names = Array.from({ length: 2 * count }, (_, k) => `p${k}`);
  const definitions = Object.fromEntries(
    names.map((name) => [name, int]),
  ) as Record<string, typeof int>;
  const values = Object.fromEntries(names.map((name, k) => [name, k * 10]));
  const windows = prepare(definitions, (p) =>
    database.items
      .delete()
      .where((item) =>
        or(
          ...Array.from({ length: count }, (_, k) =>
            and(
              item.at.above(p[`p${2 * k}`]!),
              item.at.below(p[`p${2 * k + 1}`]!),
            ),
          ),
        ),
      ),
  );
  const chain = prepare(definitions, (p) =>
    database.items.delete().where((item) => {
      let where = item.id.is(p.p0!);

      for (let k = 1; k <= count; k += 1) {
        where =
          k % 2
            ? not(or(item.id.below(p[`p${k}`]!), where))
            : not(and(item.id.above(p[`p${k}`]!), where));
      }

      return where;
    }),
  );
  const started = performance.now();

  for (let run = 0; run < 100; run += 1) {
    for (const write of [windows, chain]) {
      (write as unknown as { toSQL: (values: object) => unknown }).toSQL(
        values,
      );
    }
  }

  expect(performance.now() - started).toBeLessThan(500);

  // With a range the values decide below the not()s, they are checked.
  const decided = prepare({ a: int, b: int }, (p) =>
    database.items
      .delete()
      .where((item) =>
        not(
          and(
            item.name.is("x"),
            not(or(item.id.below(p.a), item.id.atLeast(p.b))),
          ),
        ),
      ),
  );

  await expect(decided({ a: 3, b: 2 })).rejects.toThrow(refusal);
  expect(await decided({ a: 2, b: 3 })).toEqual({ affectedRows: 0 });
});

test("a prepared JSON parameter that may hold null binds JSON null", async () => {
  const calls: CompiledQuery[] = [];
  const body = jsonb<{ a: number } | null>();
  const database = schema(
    { docs: { id: int, body } },
    {
      executor: async (query) => {
        calls.push(query);

        return [];
      },
    },
  );
  const find = prepare({ body }, (p) =>
    database.docs((doc) => ({ id: doc.id }), {
      where: (doc) => doc.body.is(p.body),
    }),
  );

  await find({ body: null });
  expect(calls[0]!.sql).toContain('"docs"."body" = $1::text::jsonb');
  expect(calls[0]!.parameters).toEqual(["null"]);
  // A parameter of another type still refuses null.
  const named = prepare({ id: int }, (p) =>
    database.docs((doc) => ({ id: doc.id }), {
      where: (doc) => doc.id.is(p.id),
    }),
  );

  await expect(named({ id: null as never })).rejects.toThrow(
    'parameter "id" cannot be null',
  );
});

test("a numeric or bigint parameter inside a nested result is a value of its type before it is text", () => {
  const amount = customType<string>("amount", { base: "numeric(30,10)" });
  const owners = table({ id: int.auto, items: many });
  const items = table({ id: int.auto, owner: one(owners.items) });
  const database = schema({ owners, items });
  const echo = prepare(
    {
      price: numeric,
      scaled: numeric(10, 2),
      maybe: numeric.nullable,
      views: bigint,
      amount,
      prices: numeric.array,
      counts: bigint.array,
      name: text,
      at: timestamptz,
      size: int,
    },
    (p) =>
      database.owners((owner) => ({
        price: p.price,
        views: p.views,
        nested: {
          price: p.price,
          scaled: p.scaled,
          maybe: p.maybe,
          views: p.views,
          amount: p.amount,
          prices: p.prices,
          counts: p.counts,
          name: p.name,
          at: p.at,
          size: p.size,
        },
        items: owner.items(() => ({ price: p.price, views: p.views })),
      })),
  );
  const { sql } = echo.toSQL({
    price: "1e3",
    scaled: "1",
    maybe: null,
    views: 1n,
    amount: "1",
    prices: ["1"],
    counts: [1n],
    name: "a",
    at: new Date(0),
    size: 1,
  });

  expect(sql).toStartWith(
    'SELECT ($1)::numeric AS "price", ($2)::bigint AS "views", ',
  );
  // `($3)::text` alone would make the parameter text: "1e3" would come back
  // as "1e3" where the top level reads "1000", and a bigint out of range
  // would come back instead of failing.
  expect(sql).toContain(
    "json_build_object('price', (($3)::numeric)::text, 'scaled', (($4)::numeric)::text, 'maybe', (($5)::numeric)::text, 'views', (($6)::bigint)::text, 'amount', (($7)::amount)::text, ",
  );
  // An array is cast to its type where it is bound; other types as before.
  expect(sql).toContain(
    "'prices', ($8::text::numeric[])::text[], 'counts', ($9::text::bigint[])::text[], 'name', ($10)::text, 'at', ($11)::timestamptz, 'size', ($12)::integer) AS \"nested\"",
  );
  expect(sql).toContain(
    'FROM (SELECT (($13)::numeric)::text AS "price", (($14)::bigint)::text AS "views"',
  );
});

test("in() of a prepared parameter, a column or a number says it takes a list or a subquery", () => {
  const database = schema({ users: { id: int, name: text } });
  // It said "a subquery requires selected fields".
  const message =
    /in\(\) takes an array of values or a single-column subquery, not a column, expression or prepared parameter; a prepared query's list has a fixed length/;

  expect(() =>
    prepare({ ids: int.array }, (parameters) =>
      database.users((user) => ({ id: user.id }), {
        where: (user) => user.id.in(parameters.ids as never),
      }),
    ),
  ).toThrow(message);
  expect(() =>
    database.users((user) => ({ id: user.id }), {
      where: (user) => user.id.notIn(user.id as never),
    }),
  ).toThrow(/^symmetria: notIn\(\) takes an array of values/);
  expect(() =>
    database.users((user) => ({ id: user.id }), {
      where: (user) => user.id.in(5 as never),
    }),
  ).toThrow("not a number");

  // One parameter per item binds as a list of that length.
  const listed = prepare({ first: int, second: int }, (parameters) =>
    database.users((user) => ({ id: user.id }), {
      where: (user) => user.id.in([parameters.first, parameters.second]),
    }),
  );
  expect(listed.toSQL({ first: 1, second: 2 })).toMatchObject({
    sql: expect.stringContaining('"users"."id" IN ($1, $2)'),
    parameters: [1, 2],
  });
});
