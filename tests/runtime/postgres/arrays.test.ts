import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  bool,
  timestamptz,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../../packages/kit/src/testing";

const model = schema({
  items: {
    id: int.auto,
    title: text,
    tags: text.array,
    scores: bigint.array.nullable,
    flags: bool.array,
    seen: timestamptz.array,
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
        await database.items((items) => ({
          id: items.id,
          tags: items.tags,
          scores: items.scores,
          flags: items.flags,
          seen: items.seen,
          $orderBy: items.id.ascending,
        })),
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
        await database.items((items) => ({
          id: items.id,
          count: items.tags.length().as("count"),
          $where: items.tags.has("sql"),
        })),
      ).toEqual([{ id: 1, count: 3 }]);
      expect(
        await database.items((items) => ({
          id: items.id,
          $where: items.tags.contains(["bun", "sql"]),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.items((items) => ({
          id: items.id,
          $where: items.tags.overlaps(["nothing", 'quo"te']),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.items((items) => ({
          id: items.id,
          $where: items.scores.has(2),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.items
          .update({ tags: ["replaced"] })
          .where((items) => items.id.is(2))
          .returning((items) => [items.tags]),
      ).toEqual([{ tags: ["replaced"] }]);
    });

    test("search() matches stemmed words and searchRank() orders results", async () => {
      expect(
        await database.items((items) => ({
          id: items.id,
          $where: items.title.search("running", { language: "english" }),
        })),
      ).toEqual([{ id: 2 }]);
      expect(
        await database.items((items) => ({
          id: items.id,
          $where: items.title.search("run", { language: "english" }),
        })),
      ).toEqual([{ id: 2 }]);
      expect(
        await database.items((items) => ({
          id: items.id,
          $where: items.title.search("sql -postgresql"),
        })),
      ).toEqual([{ id: 1 }]);
      const ranked = await database.items((items) => ({
        id: items.id,
        searchRank: items.title.searchRank("sql", { language: "english" }),
        $where: items.title.search("sql", { language: "english" }),
        $orderBy: items.title.searchRank("sql", { language: "english" })
          .descending,
      }));
      expect(ranked.map((row) => row.id)).toEqual([1]);
      expect(ranked[0]?.searchRank).toBeGreaterThan(0);
    });
  },
);
