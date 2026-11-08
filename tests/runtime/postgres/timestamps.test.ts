import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  timestamp,
  timestamptz,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const authors = table({ id: int.auto, name: text });
const events = table({
  id: int.auto,
  author: authors,
  at: timestamp(3),
  local: timestamp.nullable,
  zoned: timestamptz(3).now,
  history: timestamp(3).array.default([]),
});
const model = schema({ authors, events });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "timestamps without time zone on PostgreSQL",
  () => {
    let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
    let database: typeof isolated.database;
    const instant = new Date("2024-01-31T12:00:00.123Z");

    beforeAll(async () => {
      isolated = await testDatabase({
        url: databaseUrl!,
        schema: model,
        prefix: "symmetria_timestamps",
        max: 1,
      });
      database = isolated.database;
      // A session time zone far from UTC proves values do not shift with it.
      await isolated.driver.execute({
        sql: "SET TIME ZONE 'Pacific/Kiritimati'",
        parameters: [],
      });
      await database.authors.insert({ name: "Ada" });
      await database.events.insert({
        authorId: 1,
        at: instant,
        local: new Date("1999-12-31T23:59:59.000Z"),
        history: [instant, new Date("2000-01-01T00:00:00.000Z")],
      });
    });

    afterAll(async () => {
      await isolated?.close();
    });

    test("values are stored as their UTC wall-clock time and read back unchanged", async () => {
      const raw = (
        (await isolated.driver.execute({
          sql: `SELECT "at"::text AS "at", "local"::text AS "local" FROM "events"`,
          parameters: [],
        })) as unknown as { rows: { at: string; local: string }[] }
      ).rows[0];

      expect(raw).toEqual({
        at: "2024-01-31 12:00:00.123",
        local: "1999-12-31 23:59:59",
      });
      expect(
        await database.events
          .byId(1)((event) => ({
            at: event.at,
            local: event.local,
            history: event.history,
          }))
          .one(),
      ).toEqual({
        at: instant,
        local: new Date("1999-12-31T23:59:59.000Z"),
        history: [instant, new Date("2000-01-01T00:00:00.000Z")],
      });
    });

    test("nested JSON, filters and keyset pages agree with flat reads", async () => {
      expect(
        await database.authors((author) => ({
          events: author.events((event) => ({ at: event.at })),
        })),
      ).toEqual([{ events: [{ at: instant }] }]);
      expect(
        await database.events((event) => ({ id: event.id }), {
          where: (event) =>
            event.at.above(new Date("2024-01-31T11:59:59.000Z")),
        }),
      ).toEqual([{ id: 1 }]);
      const page = await database
        .events((event) => ({ id: event.id, at: event.at }), {
          orderBy: (event) => [event.at.descending, event.id.ascending],
        })
        .page({ size: 1 });
      expect(page.items).toEqual([{ id: 1, at: instant }]);
    });
  },
);
