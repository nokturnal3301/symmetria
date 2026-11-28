import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  bool,
  numeric,
  real,
  date,
  jsonb,
  timestamp,
  timestamptz,
  customType,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const model = schema({
  items: {
    id: int.auto,
    title: text,
    tags: text.array,
    scores: bigint.array.nullable,
    flags: bool.array,
    seen: timestamptz.array,
    // PostgreSQL separates box elements with ";".
    boxes: customType<string>("box", {
      encode: (value: string) => value,
      decode: (value: unknown) => String(value),
    }).array.nullable,
  },
  grids: {
    id: int.auto,
    note: text.nullable,
    counts: int.array,
    amounts: numeric.array,
    ratios: real.array,
    tags: text.array,
    days: date.array,
    moments: timestamp.array,
    // One dimension of elements that are arrays in JavaScript.
    docs: jsonb<number[]>().array,
    spans: customType<[number, number]>("int4range", {
      encode: ([from, to]) => `[${from},${to})`,
      decode: (value: unknown) =>
        String(value).slice(1, -1).split(",").map(Number) as [number, number],
    }).array,
  },
});

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "arrays and full-text search on PostgreSQL",
  () => {
    let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
    let database: typeof isolated.database;

    beforeAll(async () => {
      isolated = await testDatabase({
        url: databaseUrl ?? "postgres://localhost/postgres",
        schema: model,
        prefix: "symmetria_arrays",
        max: 1,
      });
      database = isolated.database;
      await database.items.insert([
        {
          title: "Bun loves fast SQL",
          tags: ["bun", "sql", 'quo"te'],
          scores: [9007199254740993n, 2],
          flags: [true, false],
          seen: [new Date("2026-01-01T00:00:00Z")],
        },
        {
          title: "Running PostgreSQL",
          tags: [],
          scores: null,
          flags: [],
          seen: [],
        },
      ]);
    });

    afterAll(async () => {
      await isolated.close();
    });

    test("array columns round-trip every element type with exact values", async () => {
      expect(
        await database.items(
          (items) => ({
            id: items.id,
            tags: items.tags,
            scores: items.scores,
            flags: items.flags,
            seen: items.seen,
          }),
          { orderBy: (items) => items.id.ascending },
        ),
      ).toEqual([
        {
          id: 1,
          tags: ["bun", "sql", 'quo"te'],
          scores: [9007199254740993n, 2n],
          flags: [true, false],
          seen: [new Date("2026-01-01T00:00:00Z")],
        },
        { id: 2, tags: [], scores: null, flags: [], seen: [] },
      ]);
      expect(
        await database.items(
          (items) => ({
            id: items.id,
            count: items.tags.length().as("count"),
          }),
          { where: (items) => items.tags.has("sql") },
        ),
      ).toEqual([{ id: 1, count: 3 }]);
      expect(
        await database.items(
          (items) => ({
            id: items.id,
          }),
          { where: (items) => items.tags.contains(["bun", "sql"]) },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.items(
          (items) => ({
            id: items.id,
          }),
          { where: (items) => items.tags.overlaps(["nothing", 'quo"te']) },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.items(
          (items) => ({
            id: items.id,
          }),
          { where: (items) => items.scores.has(2) },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.items
          .update({ tags: ["replaced"] })
          .where((items) => items.id.is(2))
          .returning((items) => [items.tags]),
      ).toEqual([{ tags: ["replaced"] }]);
    });

    test("a box array round-trips", async () => {
      const boxes = ["(1,1),(0,0)", "(3,4),(2,2)"];

      expect(
        await database.items
          .update({ boxes })
          .where((items) => items.id.is(2))
          .returning("boxes"),
      ).toEqual([{ boxes }]);
      await isolated.driver.execute({
        sql: `UPDATE items SET boxes = '[-1:0]={(1,1),(0,0);(3,4),(2,2)}'::box[] WHERE id = 2`,
        parameters: [],
      });
      expect(
        await database.items((items) => ({ boxes: items.boxes }), {
          where: (items) => items.id.is(2),
        }),
      ).toEqual([{ boxes }]);
      await database.items
        .update({ boxes: null })
        .where((items) => items.id.is(2));
    });

    test("an array of two dimensions, which only SQL written outside Symmetria stores, is refused on every way out", async () => {
      await isolated.driver.execute({
        sql: `INSERT INTO grids (counts, amounts, ratios, tags, days, moments, docs, spans)
              VALUES ('{{1,2},{3,4}}', '{{1.5,2.5},{3.5,4.5}}', '{{1.5,2.5},{3.5,4.5}}', '{{a,b},{c,d}}',
                      '{{2024-01-01,2024-01-02},{2024-01-03,2024-01-04}}',
                      '{{"2024-01-01 00:00:00"},{"2024-06-01 12:00:00"}}', '{"[1,2]","[3]"}', '{"[1,5)","[2,3)"}')`,
        parameters: [],
      });

      // Read as one dimension, [1, 2] would be the number NaN, ["1.5", "2.5"]
      // the decimal "1.5,2.5", a text[] value arrays under the type string[],
      // and two rows of one timestamp each two Dates.
      for (const column of [
        "counts",
        "amounts",
        "ratios",
        "tags",
        "days",
        "moments",
      ] as const) {
        const query = database.grids((grid) => ({ value: grid[column] }));

        for (const read of [
          () => query.execute(),
          () =>
            database
              .grids((grid) => ({ nested: { value: grid[column] } }))
              .execute(),
          () =>
            database.$batch((database) => [
              database.grids((grid) => ({ value: grid[column] })),
            ]),
          async () => {
            for await (const row of query.stream()) {
              void row;
            }
          },
          async () =>
            await database.grids
              .update({ note: "seen" })
              .all()
              .returning(column),
        ]) {
          await expect(read()).rejects.toThrow(
            "symmetria: multidimensional arrays are not supported",
          );
        }
      }

      const flat = {
        docs: [[1, 2], [3]],
        spans: [
          [1, 5],
          [2, 3],
        ],
      };

      expect(
        await database.grids((grid) => ({
          docs: grid.docs,
          spans: grid.spans,
          nested: { docs: grid.docs, spans: grid.spans },
        })),
      ).toEqual([{ ...flat, nested: flat }] as never);
    });

    test("search() matches stemmed words and searchRank() orders results", async () => {
      expect(
        await database.items(
          (items) => ({
            id: items.id,
          }),
          {
            where: (items) =>
              items.title.search("running", { language: "english" }),
          },
        ),
      ).toEqual([{ id: 2 }]);
      expect(
        await database.items(
          (items) => ({
            id: items.id,
          }),
          {
            where: (items) =>
              items.title.search("run", { language: "english" }),
          },
        ),
      ).toEqual([{ id: 2 }]);
      expect(
        await database.items(
          (items) => ({
            id: items.id,
          }),
          { where: (items) => items.title.search("sql -postgresql") },
        ),
      ).toEqual([{ id: 1 }]);
      const ranked = await database.items(
        (items) => ({
          id: items.id,
          searchRank: items.title.searchRank("sql", { language: "english" }),
        }),
        {
          where: (items) => items.title.search("sql", { language: "english" }),
          orderBy: (items) =>
            items.title.searchRank("sql", { language: "english" }).descending,
        },
      );
      expect(ranked.map((row) => row.id)).toEqual([1]);
      expect(ranked[0]?.searchRank).toBeGreaterThan(0);
    });
  },
);
