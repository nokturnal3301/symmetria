import { expect, expectTypeOf, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  int,
  text,
  bigint,
  numeric,
  real,
  doublePrecision,
  jsonb,
  customType,
  sum,
  average,
  coalesce,
  sql,
  rowNumber,
  lag,
  prepare,
} from "../../../packages/runtime/src";

const model = schema({
  entries: { id: int, team: text, parentId: int.nullable, amount: bigint },
});

const ranked = model
  .entries(
    (entries) => ({
      id: entries.id,
      amount: entries.amount,
      position: rowNumber().over({
        partitionBy: [entries.team],
        orderBy: [entries.amount.descending, entries.id.ascending],
      }),
    }),
    { where: (entries) => entries.team.is("A") },
  )
  .cte("ranked", { materialized: false });

test("CTEs retain types, parameter order and immutable query branches", () => {
  const query = ranked(
    (ranked) => ({
      id: ranked.id,
      amount: ranked.amount,
      position: ranked.position,
    }),
    { where: (ranked) => ranked.position.atMost(2) },
  );
  expectTypeOf<Awaited<ReturnType<typeof query.execute>>>().toEqualTypeOf<
    { id: number; amount: bigint; position: number }[]
  >();
  expect(query.toSQL().parameters).toEqual(["A", 2]);
  expect(query.toSQL().sql).toStartWith('WITH "ranked" AS NOT MATERIALIZED');
  expect(query.toSQL().sql).toContain(
    'ROW_NUMBER() OVER (PARTITION BY "entries"."team" ORDER BY "entries"."amount" DESC, "entries"."id" ASC)',
  );
  expect(ranked((ranked) => ({ id: ranked.id })).toSQL().parameters).toEqual([
    "A",
  ]);
});

test("CTE dependencies are emitted once, conflicting names and escaped recursive references are rejected", () => {
  const first = model.entries((entries) => ({ id: entries.id })).cte("first");
  const second = first((first) => ({ id: first.id })).cte("second");
  const query = second((second, { innerJoin }) => {
    const _firstRow = innerJoin(first, (firstRow) => second.id.is(firstRow.id));

    return { id: second.id };
  });
  expect(query.toSQL().sql.match(/"first" AS \(/g)).toHaveLength(1);
  expect(query.toSQL().sql.indexOf('"first" AS (')).toBeLessThan(
    query.toSQL().sql.indexOf('"second" AS ('),
  );
  const conflict = model
    .entries((entries) => ({ id: entries.id }), {
      where: (entries) => entries.id.is(3),
    })
    .cte("first")
    .as("other");
  expect(() =>
    first((first, { innerJoin }) => {
      const _other = innerJoin(conflict, (other) => first.id.is(other.id));

      return { id: first.id };
    }).toSQL(),
  ).toThrow(/duplicate CTE/);
  let escaped: { toSQL: () => unknown } | undefined;
  model
    .entries((entries) => ({ id: entries.id }))
    .recursive("tree", (tree) => {
      escaped = tree((tree) => ({ id: tree.id }));

      return tree((tree) => ({ id: tree.id }));
    });
  expect(() => escaped!.toSQL()).toThrow(/escaped/);
});

test("window parameters are bound, frames are validated and foreign-scope columns are rejected", () => {
  const query = prepare({ team: text }, (parameters) =>
    model.entries(
      (entries) => ({
        previous: lag(entries.amount, 2, 0n).over({
          partitionBy: [entries.team],
          orderBy: entries.id.ascending,
          rows: [{ preceding: 3 }, "current row"],
        }),
      }),
      { where: (entries) => entries.team.is(parameters.team) },
    ),
  );
  expect(query.toSQL({ team: "A" }).parameters).toEqual([2, "0", 3, "A"]);
  expect(() =>
    rowNumber().over({ rows: ["unbounded following", "current row"] }),
  ).toThrow(/frame/);
  expect(() =>
    rowNumber().over({ rows: [{ preceding: -1 }, "current row"] }),
  ).toThrow(/offset/);
  const other = model.entries.as("other");
  let foreign: Parameters<typeof lag>[0] | undefined;
  other((other) =>
    (() => {
      foreign = other.id;

      return { id: other.id };
    })(),
  );
  expect(() =>
    model.entries((entries) => ({
      value: rowNumber().over({ partitionBy: [foreign!] }),
    })),
  ).toThrow(/scope/);
});

test("a CTE used only in an upsert's doUpdate condition is collected", () => {
  const leaders = model
    .entries((entries) => ({ id: entries.id }), {
      where: (entries) => entries.amount.above(100n),
    })
    .cte("leaders");
  const compiled = model.entries
    .insert({ id: 1, team: "A", amount: 5n })
    .onConflict("id")
    .doUpdate(
      { amount: 6n },
      {
        where: (current) =>
          current.id.in(leaders((leader) => ({ id: leader.id }))),
      },
    )
    .toSQL();

  expect(compiled.sql).toStartWith('WITH "leaders" AS (');
  expect(compiled.sql).toContain(
    'WHERE "entries"."id" IN (SELECT "leaders"."id" AS "id"',
  );
  expect(compiled.parameters).toEqual(["100", 1, "A", "5", "6"]);
});

test("sum() and average() of a float are read from its text; other numbers keep the numeric cast", async () => {
  // A domain over double precision, known by its base alone.
  const ratio = customType<number>("ratio", { base: "double precision" });
  const stations = table({ id: int.auto, readings: many });
  const readings = table({
    id: int.auto,
    station: one(stations.readings),
    level: doublePrecision,
    spare: doublePrecision.nullable,
    signal: real,
    share: ratio,
    shares: ratio.array,
    count: int,
    bytes: bigint,
    price: numeric(10, 2),
    meta: jsonb<{ level: number }>(),
  });
  const rows = [
    { id: 1, __symmetria_cursor_0: "1" },
    { id: 2, __symmetria_cursor_0: "2" },
    { id: 3, __symmetria_cursor_0: "3" },
  ];
  const floats = schema({ stations, readings }, { executor: async () => rows });
  type Reading = Parameters<Parameters<typeof floats.readings>[0]>[0];
  const selected = (expression: (reading: Reading) => unknown) =>
    floats
      .readings((reading) => ({ value: expression(reading) as never }))
      .toSQL()
      .sql.split("\n")[0];

  // `SUM(float)::numeric` keeps 15 digits of a double precision and 6 of a real.
  for (const [expression, rendered] of [
    [
      (reading: Reading) => sum(reading.level),
      '(SUM("readings"."level"))::text::numeric',
    ],
    [
      (reading: Reading) => average(reading.level),
      '(AVG("readings"."level"))::text::numeric',
    ],
    [
      (reading: Reading) => sum(reading.signal),
      '(SUM("readings"."signal"))::text::numeric',
    ],
    [
      (reading: Reading) => average(reading.signal),
      '(AVG("readings"."signal"))::text::numeric',
    ],
    [
      (reading: Reading) => sum(reading.level.multiply(2)),
      '(SUM(("readings"."level" * $1::text::double precision)))::text::numeric',
    ],
    [
      (reading: Reading) => average(reading.count.multiply(reading.signal)),
      '(AVG(((("readings"."count")::double precision) * (("readings"."signal")::double precision))))::text::numeric',
    ],
    [
      (reading: Reading) => sum(coalesce(reading.spare, 0)),
      '(SUM(COALESCE("readings"."spare", $1)))::text::numeric',
    ],
    [
      (reading: Reading) => sum(sql.of(doublePrecision)`abs(${reading.level})`),
      '(SUM(abs("readings"."level")))::text::numeric',
    ],
    // OVER stays inside the casts.
    [
      (reading: Reading) =>
        sum(reading.level).over({
          partitionBy: [reading.stationId],
          orderBy: reading.id.ascending,
        }),
      '(SUM("readings"."level") OVER (PARTITION BY "readings"."station_id" ORDER BY "readings"."id" ASC))::text::numeric',
    ],
    // A float by its base: the column's codec tells it, and behind
    // coalesce() or a path the SQL states it.
    [
      (reading: Reading) => sum(reading.share),
      '(SUM("readings"."share"))::text::numeric',
    ],
    [
      (reading: Reading) => sum(coalesce(reading.share, 0)),
      '(SUM((COALESCE("readings"."share", $1))::double precision))::text::numeric',
    ],
    // Integers, bigints, decimals and JSON numbers are exact as numeric.
    [
      (reading: Reading) => sum(reading.count),
      'SUM("readings"."count")::numeric',
    ],
    [
      (reading: Reading) => average(reading.count),
      'AVG("readings"."count")::numeric',
    ],
    [
      (reading: Reading) => sum(reading.bytes),
      'SUM("readings"."bytes")::numeric',
    ],
    [
      (reading: Reading) => sum(reading.price),
      'SUM("readings"."price")::numeric',
    ],
    [
      (reading: Reading) => sum(reading.count.multiply(2)),
      'SUM(("readings"."count" * $1))::numeric',
    ],
    [
      (reading: Reading) => sum(reading.meta.path("level")),
      `SUM((((("readings"."meta" #> ARRAY[$1::text]) #>> '{}')))::numeric)::numeric`,
    ],
    [
      (reading: Reading) =>
        sum(reading.count).over({ orderBy: reading.id.ascending }),
      'SUM("readings"."count") OVER (ORDER BY "readings"."id" ASC)::numeric',
    ],
  ] as const) {
    expect(selected(expression)).toBe(`SELECT ${rendered} AS "value"`);
  }

  // Relation aggregates, in their shared subquery and inside a nested object.
  const totals = floats
    .stations((station) => ({
      count: station.readings.count(),
      level: station.readings.sum.level,
      nested: { signal: station.readings.average.signal },
      bytes: station.readings.sum.bytes,
    }))
    .toSQL().sql;

  expect(totals).toContain(
    'LEFT JOIN LATERAL (SELECT COUNT(*) AS "count", (SUM("__symmetria_aggregate_0"."level"))::text::numeric AS "sum", (AVG("__symmetria_aggregate_0"."signal"))::text::numeric AS "average", SUM("__symmetria_aggregate_0"."bytes")::numeric AS "sum_3"',
  );
  expect(totals).toContain(
    `json_build_object('signal', ("__symmetria_shared_0"."average")::text) AS "nested"`,
  );

  // The cursor 3.6.0 issued for a page that selects float sums: its
  // fingerprint is the SQL of the query's shape, which keeps the plain cast.
  const page = await floats
    .readings(
      (reading) => ({
        id: reading.id,
        total: sum(reading.level).over({ orderBy: reading.id.ascending }),
        mean: average(reading.signal).over({ orderBy: reading.id.ascending }),
      }),
      { orderBy: (reading) => reading.id.ascending },
    )
    .page({ size: 2 });

  expect(String(page.nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6Ijg4MTU4YzU5ODZjNWQ4YjRiZWRlNzU0NjBjYTNiY2M1OGFhMGIxYzcwZGU5OWIxMDVhNzE2ZTEwOWE4NmNkMWEiLCJ2YWx1ZXMiOlsiMiJdfQ",
  );
});
