import { expect, test } from "bun:test";
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
  sql,
  type SelectedColumn,
} from "../../../packages/runtime/src";
import { expectDataError } from "../../support/data-errors";

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
    draft: jsonb<{ step: number }>().nullable,
    createdAt: timestamptz,
    seenAt: timestamp(3).nullable,
    born: date,
  },
});

test("dateTrunc() compiles date_trunc with the unit as a checked literal and the zone as a parameter", () => {
  expect(
    model
      .users((user, { dateTrunc, count }) => ({
        month: dateTrunc("month", user.createdAt),
        seen: dateTrunc("day", user.seenAt),
        year: dateTrunc("year", user.born),
        users: count(),
      }))
      .toSQL(),
  ).toEqual({
    sql: `SELECT date_trunc('month', "users"."created_at") AS "month", date_trunc('day', "users"."seen_at") AS "seen", date_trunc('year', "users"."born") AS "year", COUNT(*) AS "users"\nFROM "users" AS "users"`,
    parameters: [],
  });

  // The same expression in every clause is one SQL text with one parameter.
  const local = (user: { createdAt: SelectedColumn<Date> }) =>
    dateTrunc("week", user.createdAt, { timeZone: "Europe/Berlin" });
  expect(
    model
      .users((user, { count }) => ({ week: local(user), users: count() }), {
        where: (user) => local(user).atLeast(new Date("2024-01-01T00:00:00Z")),
        groupBy: (user) => [local(user)],
        orderBy: (user) => local(user).descending,
      })
      .toSQL(),
  ).toEqual({
    sql: `SELECT date_trunc('week', "users"."created_at", $1::text) AS "week", COUNT(*) AS "users"\nFROM "users" AS "users"\nWHERE (date_trunc('week', "users"."created_at", $1::text)) >= $2\nGROUP BY date_trunc('week', "users"."created_at", $1::text)\nORDER BY date_trunc('week', "users"."created_at", $1::text) DESC`,
    parameters: ["Europe/Berlin", "2024-01-01T00:00:00.000Z"],
  });

  // Raw SQL of a declared type and prepared parameters truncate as well.
  expect(
    model
      .users(() => ({
        hour: dateTrunc("hour", sql.of(timestamptz)`now()`),
      }))
      .toSQL().sql,
  ).toBe(
    `SELECT date_trunc('hour', (now())) AS "hour"\nFROM "users" AS "users"`,
  );
  expect(
    prepare({ zone: text }, (parameters) =>
      model.users((user) => ({
        day: dateTrunc("day", user.createdAt, { timeZone: parameters.zone }),
      })),
    ).toSQL({ zone: "Asia/Tokyo" }),
  ).toEqual({
    sql: `SELECT date_trunc('day', "users"."created_at", $1::text) AS "day"\nFROM "users" AS "users"`,
    parameters: ["Asia/Tokyo"],
  });
});

test("dateTrunc() rejects unknown units, other types and zones a value has no use for", () => {
  const users = model.users;

  expect(() =>
    users((user) => ({
      value: dateTrunc(
        "month'); DROP TABLE users; --" as never,
        user.createdAt,
      ),
    })),
  ).toThrow(
    "symmetria: dateTrunc() units are microseconds, milliseconds, second, minute, hour, day, week, month, quarter, year, decade, century, millennium",
  );
  // Text shares its JavaScript type with date, so only the SQL type tells.
  expect(() =>
    users((user) => ({ value: dateTrunc("month", user.name) })),
  ).toThrow(
    "symmetria: dateTrunc() needs a timestamptz, timestamp or date value, not text",
  );
  expect(() =>
    users(() => ({ value: dateTrunc("month", sql<Date>`now()`) })),
  ).toThrow(
    /not raw SQL of an unknown type; write it as sql\.of\(timestamptz\)`…`/,
  );
  expect(() =>
    users((user) => ({
      value: dateTrunc("day", user.seenAt, { timeZone: "UTC" }),
    })),
  ).toThrow(
    "symmetria: dateTrunc() takes a timeZone for timestamptz values, not timestamp",
  );
  expect(() =>
    users((user) => ({
      value: dateTrunc("day", user.born, { timeZone: "UTC" }),
    })),
  ).toThrow(/not date/);
  expect(() =>
    users((user) => ({
      value: dateTrunc("day", user.createdAt, { timeZone: "" }),
    })),
  ).toThrow("symmetria: dateTrunc() timeZone must be a zone name");
});

test("set() compiles jsonb_set with bound keys and the value as JSON text", () => {
  expect(
    model.users
      .update(({ settings }) => ({ settings: settings.set("theme", "dark") }))
      .where((user) => user.id.is(1))
      .toSQL(),
  ).toEqual({
    sql: `UPDATE "users" AS "users" SET "settings" = jsonb_set("users"."settings", ARRAY[$1::text], $2::text::jsonb, true)\nWHERE "users"."id" = $3`,
    parameters: ["theme", '"dark"', 1],
  });

  // Paths, array positions, chained calls, JSON null and objects.
  expect(
    model.users
      .update(({ settings }) => ({
        settings: settings
          .set(["notifications", "email"], true)
          .set(["tags", 0], "first")
          .set("note", null)
          .set("notifications", { email: false, sms: true }),
      }))
      .where((user) => user.id.is(1))
      .returning((user) => ({ settings: user.settings }))
      .toSQL(),
  ).toEqual({
    sql: `UPDATE "users" AS "users" SET "settings" = jsonb_set((jsonb_set((jsonb_set((jsonb_set("users"."settings", ARRAY[$1::text, $2::text], $3::text::jsonb, true)), ARRAY[$4::text, $5::text], $6::text::jsonb, true)), ARRAY[$7::text], ('null'::jsonb), true)), ARRAY[$8::text], $9::text::jsonb, true)\nWHERE "users"."id" = $10\nRETURNING "users"."settings" AS "settings"`,
    parameters: [
      "notifications",
      "email",
      "true",
      "tags",
      "0",
      '"first"',
      "note",
      "notifications",
      '{"email":false,"sms":true}',
      1,
    ],
  });

  // A column or expression is stored as its JSON form; SQL NULL as JSON null.
  expect(
    model.users
      .update(({ settings, name, draft }) => ({
        settings: settings.set("note", name),
        draft: draft.set("step", coalesce(draft.path("step"), 0).plus(1)),
      }))
      .all()
      .toSQL(),
  ).toEqual({
    sql: `UPDATE "users" AS "users" SET "settings" = jsonb_set("users"."settings", ARRAY[$1::text], COALESCE(to_jsonb("users"."name"), 'null'::jsonb), true), "draft" = jsonb_set("users"."draft", ARRAY[$2::text], COALESCE(to_jsonb((((((COALESCE(NULLIF(("users"."draft" #> ARRAY[$3::text]), 'null'::jsonb), $4::text::jsonb) #>> '{}')))::double precision) + $5::text::double precision)), 'null'::jsonb), true)`,
    parameters: ["note", "step", "step", "0", 1],
  });

  // A prepared parameter binds JSON text, too.
  const rename = prepare({ id: int, note: text }, (parameters) =>
    model.users
      .update(({ settings }) => ({
        settings: settings.set("note", parameters.note),
      }))
      .where((user) => user.id.is(parameters.id)),
  );
  expect(rename.toSQL({ id: 7, note: 'say "hi"' })).toEqual({
    sql: `UPDATE "users" AS "users" SET "settings" = jsonb_set("users"."settings", ARRAY[$1::text], COALESCE($2::text::jsonb, 'null'::jsonb), true)\nWHERE "users"."id" = $3`,
    parameters: ["note", '"say \\"hi\\""', 7],
  });

  // In a projection the result reads like the column.
  expect(
    model
      .users((user) => ({ preview: user.settings.set("theme", "light") }))
      .toSQL().sql,
  ).toBe(
    `SELECT jsonb_set("users"."settings", ARRAY[$1::text], $2::text::jsonb, true) AS "preview"\nFROM "users" AS "users"`,
  );
});

test("set() rejects other column types, invalid paths and values without a JSON form", async () => {
  const loose = (column: unknown) =>
    column as { set: (path: unknown, value: unknown) => never };

  expect(() =>
    model.users.update(({ name }) => ({
      settings: loose(name).set("theme", "dark"),
    })),
  ).toThrow(
    "symmetria: set() replaces a key inside a jsonb column or expression",
  );

  for (const path of [[], -1, 1.5, [null], ["tags", "0", {}]]) {
    expect(() =>
      model.users.update(({ settings }) => ({
        settings: loose(settings).set(path, "x"),
      })),
    ).toThrow(
      "symmetria: JSON paths require string keys or nonnegative integer positions",
    );
  }

  expect(() =>
    model.users.update(({ settings }) => ({
      settings: loose(settings).set("theme", undefined),
    })),
  ).toThrow("symmetria: undefined is not a SQL value");
  // A value JSON cannot hold would bind NULL and erase the column.
  await expectDataError(
    () =>
      model.users
        .update(({ settings }) => ({
          settings: loose(settings).set("theme", () => "dark"),
        }))
        .all(),
    /set\(\) needs a JSON value/,
  );
});
