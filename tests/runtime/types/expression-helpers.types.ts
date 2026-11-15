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
} from "../../../packages/runtime/src";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

type Settings = {
  theme: "dark" | "light";
  notifications: { email: boolean; sms?: boolean };
  tags: string[];
  note: string | null;
};

const db = schema({
  users: {
    id: int.auto,
    name: text,
    settings: jsonb<Settings>(),
    draft: jsonb<{ step: number }>().nullable,
    createdAt: timestamptz,
    seenAt: timestamp.nullable,
    born: date,
  },
});

// dateTrunc() reads a Date, nullable when its input is; a date becomes a timestamptz.
const buckets = db.users(
  (user, { dateTrunc, count }) => ({
    month: dateTrunc("month", user.createdAt, { timeZone: "Europe/Berlin" }),
    seen: dateTrunc("day", user.seenAt),
    year: dateTrunc("year", user.born),
    users: count(),
  }),
  {
    where: (user, { dateTrunc }) =>
      dateTrunc("day", user.createdAt).atLeast(new Date()),
    groupBy: (user, { dateTrunc }) => [
      dateTrunc("month", user.createdAt, { timeZone: "Europe/Berlin" }),
      dateTrunc("day", user.seenAt),
      dateTrunc("year", user.born),
    ],
    orderBy: (user) => dateTrunc("month", user.createdAt).descending,
  },
);
type Buckets = Expect<
  Equal<
    Awaited<typeof buckets>,
    { month: Date; seen: Date | null; year: Date; users: number }[]
  >
>;
const raw = db.users(() => ({
  hour: dateTrunc("hour", sql.of(timestamptz.nullable)`now()`),
}));
type Raw = Expect<Equal<Awaited<typeof raw>, { hour: Date | null }[]>>;

db.users((user) => {
  // @ts-expect-error not a PostgreSQL date_trunc unit
  dateTrunc("fortnight", user.createdAt);
  // @ts-expect-error numbers are not dates
  dateTrunc("day", user.id);
  // @ts-expect-error JSON is not a date
  dateTrunc("day", user.settings);
  // @ts-expect-error the zone is a name
  dateTrunc("day", user.createdAt, { timeZone: 2 });
  // @ts-expect-error unknown option
  dateTrunc("day", user.createdAt, { zone: "UTC" });

  return { id: user.id };
});
db.users.update({ name: "Ada" }).returning((user, { dateTrunc }) => ({
  day: dateTrunc("day", user.createdAt),
}));

// set() is typed from the column's JSON type: keys, paths and their values.
const updated = db.users
  .update(({ settings, draft, name }) => ({
    settings: settings
      .set("theme", "dark")
      .set(["notifications", "email"], true)
      .set(["notifications", "sms"], false)
      .set(["tags", 0], name)
      .set("tags", ["a", "b"])
      .set("note", null),
    draft: draft.set("step", 2),
  }))
  .where(({ id }) => id.is(1))
  .returning(({ settings, draft }) => ({ settings, draft }));
type Updated = Expect<
  Equal<
    Awaited<typeof updated>,
    { settings: Settings; draft: { step: number } | null }[]
  >
>;
const preview = db.users((user) => ({
  settings: user.settings.set("theme", "light"),
}));
type Preview = Expect<Equal<Awaited<typeof preview>, { settings: Settings }[]>>;
prepare({ id: int, note: text }, (parameters) =>
  db.users
    .update(({ settings }) => ({
      settings: settings.set("note", parameters.note),
    }))
    .where(({ id }) => id.is(parameters.id)),
);

db.users.update(({ settings, draft, name, id }) => {
  // @ts-expect-error unknown key
  settings.set("colour", "dark");
  // @ts-expect-error not a theme
  settings.set("theme", "blue");
  // @ts-expect-error the key holds a string
  settings.set("theme", 1);
  // @ts-expect-error theme is never null
  settings.set("theme", null);
  // @ts-expect-error unknown nested key
  settings.set(["notifications", "push"], true);
  // @ts-expect-error the path holds a boolean
  settings.set(["notifications", "email"], "yes");
  // @ts-expect-error a number column is not a string
  settings.set("note", id);
  // @ts-expect-error an empty path names no key
  settings.set([], "dark");
  // @ts-expect-error text has no keys
  name.set("theme", "dark");
  // @ts-expect-error numbers have no keys
  id.set("theme", "dark");

  return { draft: draft.set("step", 3) };
});

// The snippets of the reference.
const documented = schema({
  users: {
    id: int.auto,
    settings: jsonb<{
      theme: "dark" | "light";
      notifications: { email: boolean };
    }>(),
    draft: jsonb<{ step: number }>().nullable,
  },
});
documented.users
  .update(({ settings }) => ({
    settings: settings
      .set("theme", "dark")
      .set(["notifications", "email"], true),
  }))
  .where((user) => user.id.is(1));
documented.users
  .update(({ draft }) => ({
    draft: coalesce(draft, { step: 0 }).set("step", 1),
  }))
  .all();
