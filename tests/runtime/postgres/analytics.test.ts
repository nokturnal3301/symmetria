import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  int,
  text,
  bigint,
  real,
  doublePrecision,
  sql,
  sum,
  average,
  over,
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  prepare,
  type Decimal,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const stations = table({ id: int, readings: many });
const readings = table({
  id: int,
  station: one(stations.readings),
  level: doublePrecision,
  signal: real,
  count: int,
});
const model = schema({
  entries: { id: int, team: text, parentId: int.nullable, amount: bigint },
  stations,
  readings,
});

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("CTEs and windows on PostgreSQL", () => {
  // testDatabase() creates an isolated schema and drops it on close().
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl ?? "postgres://localhost/postgres",
      schema: model,
      prefix: "symmetria_analytics",
      max: 1,
    });
    database = isolated.database;

    await database.entries
      .insert([
        { id: 1, team: "A", parentId: null, amount: 9007199254740993n },
        { id: 2, team: "A", parentId: 1, amount: 5n },
        { id: 3, team: "A", parentId: 2, amount: 5n },
        { id: 4, team: "B", parentId: null, amount: 9n },
      ])
      .execute();
  });

  afterAll(async () => {
    await isolated.close();
  });

  test("ranking, lag/lead and running totals preserve bigint and numeric precision", async () => {
    const rows = await database
      .entries(
        (entries) => ({
          id: entries.id,
          position: rowNumber().over({
            partitionBy: [entries.team],
            orderBy: entries.id.ascending,
          }),
          ranking: rank().over({
            partitionBy: [entries.team],
            orderBy: entries.amount.descending,
          }),
          dense: denseRank().over({
            partitionBy: [entries.team],
            orderBy: entries.amount.descending,
          }),
          previous: lag(entries.amount).over({
            partitionBy: [entries.team],
            orderBy: entries.id.ascending,
          }),
          next: lead(entries.amount).over({
            partitionBy: [entries.team],
            orderBy: entries.id.ascending,
          }),
          running: over(sum(entries.amount), {
            partitionBy: [entries.team],
            orderBy: entries.id.ascending,
            rows: ["unbounded preceding", "current row"],
          }),
        }),
        { orderBy: (entries) => entries.id.ascending },
      )
      .execute();
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 1]);
    expect(rows.map((row) => row.ranking)).toEqual([1, 2, 2, 1]);
    expect(rows.map((row) => row.previous)).toEqual([
      null,
      9007199254740993n,
      5n,
      null,
    ]);
    expect(rows.map((row) => row.next)).toEqual([5n, 5n, null, null]);
    expect(rows.map((row) => row.running)).toEqual([
      "9007199254740993",
      "9007199254740998",
      "9007199254741003",
      "9",
    ]);
  });

  test("materialized CTEs filter window results and keep codecs through derived projections", async () => {
    const ranked = database
      .entries((entries) => ({
        id: entries.id,
        amount: entries.amount,
        position: rowNumber().over({
          partitionBy: [entries.team],
          orderBy: entries.id.ascending,
        }),
      }))
      .cte("ranked", { materialized: true });
    const rows = await ranked(
      (ranked) => ({
        id: ranked.id,
        amount: ranked.amount,
        position: ranked.position,
      }),
      {
        where: (ranked) => ranked.position.is(1),
        orderBy: (ranked) => ranked.id.ascending,
      },
    ).execute();
    expect(rows).toEqual([
      { id: 1, amount: 9007199254740993n, position: 1 },
      { id: 4, amount: 9n, position: 1 },
    ]);
    const derived = ranked((ranked) => ({
      nested: { amount: ranked.amount },
    })).as("nested");
    expect(
      (await derived((nested) => ({ nested: nested.nested })).execute())[0],
    ).toEqual({
      nested: { amount: 9007199254740993n },
    });
  });

  test("recursive CTEs traverse trees and support prepared anchors", async () => {
    const query = prepare({ rootId: int }, (parameters) =>
      database
        .entries(
          (entries) => ({
            id: entries.id,
            amount: entries.amount,
            // Typed like an int column, so the recursive term can compute with it.
            depth: sql.of(int)`0`,
          }),
          { where: (entries) => entries.id.is(parameters.rootId) },
        )
        .recursive("tree", (tree) =>
          database.entries((entries, { innerJoin }) => {
            const treeRow = innerJoin(tree, (treeRow) =>
              entries.parentId.is(treeRow.id),
            );

            return {
              id: entries.id,
              amount: entries.amount,
              depth: treeRow.depth.plus(1),
            };
          }),
        )(
        (tree) => ({
          id: tree.id,
          amount: tree.amount,
          depth: tree.depth,
        }),
        { orderBy: (tree) => tree.id.ascending },
      ),
    );
    expect(query.toSQL({ rootId: 1 }).sql).toStartWith("WITH RECURSIVE");
    expect(query.toSQL({ rootId: 1 }).parameters).toEqual([1, 1]);
    expect(await query.execute({ rootId: 1 })).toEqual([
      { id: 1, amount: 9007199254740993n, depth: 0 },
      { id: 2, amount: 5n, depth: 1 },
      { id: 3, amount: 5n, depth: 2 },
    ]);
    expect(await query.execute({ rootId: 4 })).toEqual([
      { id: 4, amount: 9n, depth: 0 },
    ]);
  });

  test("sum() and average() of real and double precision are PostgreSQL's own floats, digit for digit", async () => {
    await database.stations.insert([{ id: 1 }, { id: 2 }]);
    await database.readings.insert([
      { id: 1, stationId: 1, level: 0.1, signal: 123456.78, count: 1 },
      { id: 2, stationId: 1, level: 0.2, signal: 0.1, count: 2 },
      { id: 3, stationId: 2, level: 1234567890.1234567, signal: 1.5, count: 3 },
    ]);
    // PostgreSQL's answers as it prints them: the shortest text of each float.
    const own = await database
      .readings(
        (reading) => ({
          station: reading.stationId,
          level: sql<Decimal>`sum(${reading.level})::text`,
          mean: sql<Decimal>`avg(${reading.level})::text`,
          signal: sql<Decimal>`sum(${reading.signal})::text`,
          signalMean: sql<Decimal>`avg(${reading.signal})::text`,
          scaled: sql<Decimal>`sum(${reading.count} * ${reading.level})::text`,
        }),
        {
          groupBy: (reading) => [reading.stationId],
          orderBy: (reading) => reading.stationId.ascending,
        },
      )
      .execute();

    // The float-to-numeric cast would read 0.3, 123457 and 1234567890.12346.
    expect(own).toEqual([
      {
        station: 1,
        level: "0.30000000000000004",
        mean: "0.15000000000000002",
        signal: "123456.88",
        signalMean: "61728.440625000745",
        scaled: "0.5",
      },
      {
        station: 2,
        level: "1234567890.1234567",
        mean: "1234567890.1234567",
        signal: "1.5",
        signalMean: "1.5",
        scaled: "3703703670.37037",
      },
    ]);

    const grouped = await database.readings(
      (reading) => ({
        station: reading.stationId,
        level: sum(reading.level),
        mean: average(reading.level),
        signal: sum(reading.signal),
        signalMean: average(reading.signal),
        scaled: sum(reading.count.multiply(reading.level)),
      }),
      {
        groupBy: (reading) => [reading.stationId],
        orderBy: (reading) => reading.stationId.ascending,
      },
    );

    expect(grouped).toEqual(own);
    // One aggregate over the table, and the same one through aggregate().
    const [ownWhole] = await database.readings((reading) => ({
      level: sql<Decimal>`sum(${reading.level})::text`,
      signalMean: sql<Decimal>`avg(${reading.signal})::text`,
    }));
    const whole = { level: "1234567890.4234567", count: "6" } as const;

    expect(ownWhole!.level).toBe(whole.level);
    expect(
      await database.readings((reading) => ({
        level: sum(reading.level),
        count: sum(reading.count),
      })),
    ).toEqual([whole]);
    expect(
      await database.readings.aggregate((reading) => ({
        level: sum(reading.level),
        count: sum(reading.count),
      })),
    ).toEqual(whole);

    // Relation aggregates: alone (a subquery each), sharing one subquery,
    // inside a nested object and in $batch().
    const [first, second] = own;
    const perStation = (
      station: Parameters<Parameters<typeof database.stations>[0]>[0],
    ) => ({
      id: station.id,
      level: station.readings.sum.level,
      nested: {
        mean: station.readings.average.level,
        signal: station.readings.sum.signal,
      },
      readings: station.readings.count(),
    });
    const stationTotals = [
      {
        id: 1,
        level: first!.level,
        nested: { mean: first!.mean, signal: first!.signal },
        readings: 2,
      },
      {
        id: 2,
        level: second!.level,
        nested: { mean: second!.mean, signal: second!.signal },
        readings: 1,
      },
    ];

    expect(
      await database.stations(
        (station) => ({ level: station.readings.sum.level }),
        { orderBy: (station) => station.id.ascending },
      ),
    ).toEqual([{ level: first!.level }, { level: second!.level }]);
    expect(
      await database.stations(perStation, {
        orderBy: (station) => station.id.ascending,
      }),
    ).toEqual(stationTotals);
    expect(
      await database.$batch((database) => [
        database.stations(perStation, {
          orderBy: (station) => station.id.ascending,
        }),
        database.readings.aggregate((reading) => ({
          mean: average(reading.signal),
        })),
      ]),
    ).toEqual([stationTotals, { mean: ownWhole!.signalMean }]);

    // Running totals, at the top level and inside a nested collection.
    expect(
      await database.readings(
        (reading) => ({
          id: reading.id,
          running: sum(reading.level).over({ orderBy: reading.id.ascending }),
          mean: average(reading.signal).over({
            partitionBy: [reading.stationId],
          }),
        }),
        { orderBy: (reading) => reading.id.ascending },
      ),
    ).toEqual([
      { id: 1, running: "0.1", mean: "61728.440625000745" },
      { id: 2, running: "0.30000000000000004", mean: "61728.440625000745" },
      { id: 3, running: "1234567890.4234567", mean: "1.5" },
    ]);
    expect(
      await database.stations(
        (station) => ({
          readings: station.readings(
            (reading) => ({
              running: sum(reading.level).over({
                orderBy: reading.id.ascending,
              }),
            }),
            { orderBy: (reading) => reading.id.ascending },
          ),
        }),
        { where: (station) => station.id.is(1) },
      ),
    ).toEqual([
      { readings: [{ running: "0.1" }, { running: "0.30000000000000004" }] },
    ]);

    // NaN and the infinities keep their names, nested too; no rows is null.
    await database.readings.delete().all();
    expect(
      await database.readings.aggregate((reading) => ({
        level: sum(reading.level),
        mean: average(reading.signal),
      })),
    ).toEqual({ level: null, mean: null });

    for (const special of [Number.NaN, Infinity, -Infinity]) {
      const name = String(special) as Decimal;

      await database.readings.insert({
        id: 1,
        stationId: 1,
        level: special,
        signal: special,
        count: 1,
      });
      expect(
        await database.stations(
          (station) => ({
            level: station.readings.sum.level,
            nested: { signal: station.readings.average.signal },
          }),
          { where: (station) => station.id.is(1) },
        ),
      ).toEqual([{ level: name, nested: { signal: name } }]);
      await database.readings.delete().all();
    }
  });
});
