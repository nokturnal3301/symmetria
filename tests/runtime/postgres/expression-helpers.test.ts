import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  jsonb,
  date,
  timestamp,
  timestamptz,
  dateTrunc,
  coalesce,
  prepare,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

type Settings = {
  theme: "dark" | "light";
  notifications: { email: boolean; sms?: boolean };
  tags: string[];
  note: string | null;
};

const model = schema({
  users: {
    id: int.auto,
    name: text,
    settings: jsonb<Settings>(),
    draft: jsonb<{ step: number; label?: string }>().nullable,
    createdAt: timestamptz,
    seenAt: timestamp(3).nullable,
    born: date,
  },
});

const settings: Settings = {
  theme: "light",
  notifications: { email: false },
  tags: ["a", "b"],
  note: null,
};

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("dateTrunc() and set() on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_helpers",
      max: 1,
    });
    database = isolated.database;
    // Truncation of timestamptz and date follows the session's time zone.
    await isolated.driver.execute({
      sql: "SET TIME ZONE 'America/New_York'",
      parameters: [],
    });
    await database.users.insert([
      {
        name: "Ada",
        settings,
        draft: { step: 1 },
        // 23:30 on January 31st in New York, already February in UTC and Tokyo.
        createdAt: new Date("2024-02-01T04:30:00.000Z"),
        seenAt: new Date("2024-03-15T13:45:10.123Z"),
        born: "1990-06-15",
      },
      {
        name: "Bob",
        settings,
        draft: null,
        createdAt: new Date("2024-02-10T12:00:00.000Z"),
        seenAt: null,
        born: "1985-12-31",
      },
      {
        name: "Cy",
        settings,
        draft: { step: 5 },
        createdAt: new Date("2024-02-20T12:00:00.000Z"),
        seenAt: new Date("2024-03-15T23:59:59.999Z"),
        born: "1990-01-01",
      },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("timestamps keep their type, a date becomes a timestamptz, zones move the boundary", async () => {
    expect(
      await database.users(
        (user) => ({
          name: user.name,
          session: dateTrunc("month", user.createdAt),
          tokyo: dateTrunc("month", user.createdAt, { timeZone: "Asia/Tokyo" }),
          seen: dateTrunc("hour", user.seenAt),
          year: dateTrunc("year", user.born),
        }),
        { orderBy: (user) => user.id.ascending, limit: 2 },
      ),
    ).toEqual([
      {
        name: "Ada",
        // Midnight of January 1st in New York; of February 1st in Tokyo.
        session: new Date("2024-01-01T05:00:00.000Z"),
        tokyo: new Date("2024-01-31T15:00:00.000Z"),
        // A timestamp without time zone is read as UTC, like its column.
        seen: new Date("2024-03-15T13:00:00.000Z"),
        // A date is truncated as the timestamptz of its midnight in the session's zone.
        year: new Date("1990-01-01T05:00:00.000Z"),
      },
      {
        name: "Bob",
        session: new Date("2024-02-01T05:00:00.000Z"),
        tokyo: new Date("2024-01-31T15:00:00.000Z"),
        seen: null,
        year: new Date("1985-01-01T05:00:00.000Z"),
      },
    ]);
  });

  test("the same bucket groups, filters and orders", async () => {
    const zone = { timeZone: "Asia/Tokyo" };
    const perMonth = database.users(
      (user, { dateTrunc, count }) => ({
        month: dateTrunc("month", user.createdAt, zone),
        users: count(),
      }),
      {
        where: (user, { dateTrunc }) =>
          dateTrunc("year", user.born).atLeast(
            new Date("1990-01-01T05:00:00Z"),
          ),
        groupBy: (user, { dateTrunc }) => [
          dateTrunc("month", user.createdAt, zone),
        ],
        orderBy: (user, { dateTrunc }) =>
          dateTrunc("month", user.createdAt, zone).descending,
      },
    );

    expect(await perMonth).toEqual([
      { month: new Date("2024-01-31T15:00:00.000Z"), users: 2 },
    ]);
    expect(
      await database.users(
        (user, { count }) => ({
          month: dateTrunc("month", user.createdAt),
          users: count(),
        }),
        {
          groupBy: (user) => [dateTrunc("month", user.createdAt)],
          orderBy: (user) => dateTrunc("month", user.createdAt).ascending,
        },
      ),
    ).toEqual([
      { month: new Date("2024-01-01T05:00:00.000Z"), users: 1 },
      { month: new Date("2024-02-01T05:00:00.000Z"), users: 2 },
    ]);

    const daily = prepare({ zone: text }, (parameters) =>
      database.users(
        (user) => ({
          day: dateTrunc("day", user.createdAt, { timeZone: parameters.zone }),
        }),
        { where: (user) => user.id.is(1) },
      ),
    );
    expect(await daily.execute({ zone: "UTC" })).toEqual([
      { day: new Date("2024-02-01T00:00:00.000Z") },
    ]);
    expect(await daily.execute({ zone: "America/New_York" })).toEqual([
      { day: new Date("2024-01-31T05:00:00.000Z") },
    ]);
    // An unknown zone is PostgreSQL's error, not a silent UTC.
    await expect(daily.execute({ zone: "Mars/Olympus" })).rejects.toThrow(
      /time zone "Mars\/Olympus" not recognized/,
    );
  });

  test("set() replaces one key and leaves the rest, on both drivers alike", async () => {
    const [ada] = await database.users
      .update(({ settings }) => ({ settings: settings.set("theme", "dark") }))
      .where((user) => user.id.is(1))
      .returning((user) => ({ settings: user.settings }));
    // An object, not a JSON string of the text: the value was bound as JSON.
    expect(ada).toEqual({ settings: { ...settings, theme: "dark" } });

    const [chained] = await database.users
      .update(({ settings, name }) => ({
        settings: settings
          .set(["notifications", "email"], true)
          .set(["notifications", "sms"], false)
          .set(["tags", 0], name)
          .set("note", 'say "hi" \\ {}'),
      }))
      .where((user) => user.id.is(1))
      .returning((user) => ({ settings: user.settings }));
    expect(chained).toEqual({
      settings: {
        theme: "dark",
        notifications: { email: true, sms: false },
        tags: ["Ada", "b"],
        note: 'say "hi" \\ {}',
      },
    });

    // JSON null is a value; the key stays.
    await database.users
      .update(({ settings }) => ({
        settings: settings.set("note", null).set("tags", []),
      }))
      .where((user) => user.id.is(1));
    expect(
      await database.users(
        (user) => ({
          settings: user.settings,
          typeOfNote: user.settings.path("note"),
        }),
        { where: (user) => user.settings.path("theme").is("dark") },
      ),
    ).toEqual([
      {
        settings: {
          theme: "dark",
          notifications: { email: true, sms: false },
          tags: [],
          note: null,
        },
        typeOfNote: null,
      },
    ]);
    // The other rows were not touched.
    expect(
      await database.users((user) => ({ id: user.id }), {
        where: (user) => user.settings.path("theme").is("light"),
        orderBy: (user) => user.id.ascending,
      }),
    ).toEqual([{ id: 2 }, { id: 3 }]);
  });

  test("a NULL column stays NULL, a missing parent leaves the JSON unchanged, expressions compute", async () => {
    const rows = await database.users
      .update(({ draft }) => ({
        draft: draft
          .set("step", coalesce(draft.path("step"), 0).plus(10))
          .set("label", "next"),
      }))
      .all()
      .returning((user) => ({ id: user.id, draft: user.draft }));
    expect(rows.sort((left, right) => left.id - right.id)).toEqual([
      { id: 1, draft: { step: 11, label: "next" } },
      // jsonb_set() of NULL is NULL: there is no JSON to set a key in.
      { id: 2, draft: null },
      { id: 3, draft: { step: 15, label: "next" } },
    ]);

    // coalesce() gives a NULL column a JSON value to set the key in.
    const [bob] = await database.users
      .update(({ draft }) => ({
        draft: coalesce(draft, { step: 0 }).set("step", 1),
      }))
      .where((user) => user.id.is(2))
      .returning((user) => ({ draft: user.draft }));
    expect(bob).toEqual({ draft: { step: 1 } });

    // Only the last key of a path is created.
    await database.users
      .update(({ settings }) => ({ settings: settings.set(["tags", 5], "z") }))
      .where((user) => user.id.is(2));
    const loose = database.users.update(({ settings }) => ({
      settings: (
        settings as unknown as {
          set: (path: string[], value: boolean) => typeof settings;
        }
      ).set(["missing", "deep"], true),
    }));
    await loose.where((user) => user.id.is(2));
    expect(
      await database.users((user) => ({ settings: user.settings }), {
        where: (user) => user.id.is(2),
      }),
    ).toEqual([{ settings: { ...settings, tags: ["a", "b", "z"] } }]);

    const rename = prepare({ id: int, note: text }, (parameters) =>
      database.users
        .update(({ settings }) => ({
          settings: settings.set("note", parameters.note),
        }))
        .where((user) => user.id.is(parameters.id))
        .returning((user) => ({ note: user.settings.path("note") })),
    );
    expect(await rename.execute({ id: 3, note: "prepared" })).toEqual([
      { note: "prepared" },
    ]);
  });
});
