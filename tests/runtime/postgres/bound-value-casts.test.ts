import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  customType,
  int,
  numeric,
  prepare,
  uuid,
  DuplicateConflictKeyError,
  oneOf,
  text,
  timestamp,
  timestamptz,
  date,
  varchar,
  inet,
  interval,
  jsonb,
  not,
  sql,
} from "../../../packages/runtime/src";
import { postgres as pg } from "../../../packages/runtime/src/entries/pg";
import { testDatabase as isolatedDatabase } from "../../../packages/kit/src/testing";
import { testDatabase } from "../../support/postgres";

const things = table({
  id: int.auto,
  code: varchar(5),
  price: numeric(10, 2),
  state: oneOf("draft", "published").default("draft"),
  codes: varchar(5).array.default([]),
  note: text.nullable,
});
const code = customType<string>("char(5)", {
  encode: (value: string) => value,
  decode: (value: unknown) => String(value),
});
const prices = table({ amount: numeric(10, 2).primaryKey, note: text });
const tokens = table({ id: uuid.primaryKey, code, note: text.nullable });
const stage = oneOf("draft", "published");
const entries = table({
  id: int.auto,
  stage: stage.nullable,
  meta: jsonb<{ size?: number | null }>(),
});
const hosts = table({ id: int.auto, address: inet.unique, label: text });
const spans = table({ id: int.auto, length: interval.unique, label: text });
const model = schema({ things, prices, tokens, entries, hosts, spans });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "bound values are never cut or rounded to a column's length or scale",
  () => {
    let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
    let database: typeof isolated.database;

    beforeAll(async () => {
      isolated = await testDatabase({
        url: databaseUrl!,
        schema: model,
        prefix: "symmetria_casts",
        max: 1,
      });
      database = isolated.database;
      await database.things.insert({ code: "abcde", price: "1.01" });
    });

    afterAll(async () => {
      await isolated?.close();
    });

    const filler = Array.from({ length: 1001 }, (_, i) => `zz${i}`);
    const prices = Array.from({ length: 1001 }, (_, i) => `${1000 + i}.5`);
    const ids = (where: Parameters<typeof database.things>[1]) =>
      database.things((thing) => ({ id: thing.id }), where);

    test("a list above 1,000 values matches the same rows as a short one", async () => {
      // 'abcdefgh' cut to varchar(5) would be 'abcde'; 1.014 rounded to two
      // places would be 1.01.
      expect(
        await ids({ where: (thing) => thing.code.in(["abcdefgh"]) }),
      ).toEqual([]);
      expect(
        await ids({ where: (thing) => thing.code.in(["abcdefgh", ...filler]) }),
      ).toEqual([]);
      expect(
        await ids({ where: (thing) => thing.price.in(["1.014", ...prices]) }),
      ).toEqual([]);
      expect(
        await ids({
          where: (thing) => thing.code.notIn(["abcdefgh", ...filler]),
        }),
      ).toEqual([{ id: 1 }]);
      expect(
        await ids({
          where: (thing) => thing.price.notIn(["1.014", ...prices]),
        }),
      ).toEqual([{ id: 1 }]);
      // The exact values still match.
      expect(
        await ids({ where: (thing) => thing.code.in(["abcde", ...filler]) }),
      ).toEqual([{ id: 1 }]);
      expect(
        await ids({ where: (thing) => thing.price.in(["1.01", ...prices]) }),
      ).toEqual([{ id: 1 }]);

      const removal = database.things
        .delete()
        .where((thing) => thing.code.in(["abcdefgh", ...filler]));

      expect(removal.toSQL().sql).toContain("::varchar[]");
      expect(await removal).toEqual({ affectedRows: 0 });
    });

    test("a list above 65,535 values of any typed column is one array parameter", async () => {
      const many = Array.from({ length: 70_000 }, () => "published" as const);

      // An enum, whose type name the statement need not name.
      for (const query of [
        ids({ where: (thing) => thing.state.in([...many, "draft"]) }),
        ids({ where: (thing) => thing.state.notIn(many) }),
      ]) {
        expect(query.toSQL().parameters).toHaveLength(1);
        expect(await query).toEqual([{ id: 1 }]);
      }

      // What cannot be one array fails before it is sent, and says why.
      await expect(
        Promise.resolve(
          ids({
            where: (thing, { sql }) =>
              thing.id.in(
                Array.from({ length: 70_000 }, (_, i) => sql<number>`${i}`),
              ),
          }),
        ),
      ).rejects.toThrow("PostgreSQL takes at most 65,535");
    });

    test("match() returns its literal branches whole", async () => {
      expect(
        await database.things((thing) => ({
          label: thing.state.match({
            draft: "Draft (unpublished)",
            published: thing.code,
          }),
          amount: thing.state.match({ draft: "1.005", published: thing.price }),
        })),
      ).toEqual([{ label: "Draft (unpublished)", amount: "1.005" }]);
    });

    test("an array element longer than the column's limit is refused, not cut", async () => {
      await expect(
        database.things
          .insert({ code: "x", price: "1", codes: ["toolong"] })
          .execute(),
      ).rejects.toThrow(/too long/);
      expect(
        await database.things
          .byId(1)
          .update({ codes: ["abcde"] })
          .returning((thing) => [thing.codes]),
      ).toEqual([{ codes: ["abcde"] }]);
    });

    test("a char(n) value keeps its characters", async () => {
      const id = "00000000-0000-4000-8000-000000000001";

      await database.tokens.insert({ id, code: "abcde" });

      // Plain `char` would be char(1).
      const echo = prepare({ value: code }, (parameters) =>
        database.tokens(() => ({ echo: parameters.value }), { limit: 1 }),
      );

      expect(await echo({ value: "abcde" })).toEqual([{ echo: "abcde" }]);
      expect(
        await database.tokens((token) => ({ id: token.id }), {
          where: (token) => token.code.is("abcde"),
        }),
      ).toEqual([{ id }]);
      // A literal next to a char(n) branch.
      const stated = schema({
        labels: table({
          id: int.auto,
          code,
          state: oneOf("a", "b").default("a"),
        }),
      });
      const labels = await testDatabase({
        url: databaseUrl!,
        schema: stated,
        prefix: "symmetria_char",
        max: 1,
      });

      try {
        await labels.database.labels.insert({ code: "abcde" });
        expect(
          await labels.database.labels((label) => ({
            text: label.state.match({ a: "long label", b: label.code }),
          })),
        ).toEqual([{ text: "long label" }]);
      } finally {
        await labels.close();
      }
    });

    test("an upsert sees two spellings of one key as the same key", async () => {
      const upsert = (rows: { amount: string; note: string }[]) =>
        database.prices.upsert(rows, { by: "amount" }).execute();

      // One number to PostgreSQL: with trailing zeros, a sign, an exponent,
      // or more digits than the column keeps.
      for (const [first, second] of [
        ["1", "1.0"],
        ["1", "+1.00"],
        ["100", "1e2"],
        ["0", "-0.0"],
        ["2.50", "2.5"],
        ["3.001", "3.004"],
        ["4.005", "4.01"],
      ] as const) {
        await expect(
          upsert([
            { amount: first, note: "a" },
            { amount: second, note: "b" },
          ]),
        ).rejects.toBeInstanceOf(DuplicateConflictKeyError);
      }

      // 5.014 is stored as 5.01, 5.015 as 5.02.
      expect(
        await upsert([
          { amount: "5.01", note: "a" },
          { amount: "5.014", note: "b" },
          { amount: "5.015", note: "c" },
        ]).catch((error: unknown) => error),
      ).toBeInstanceOf(DuplicateConflictKeyError);
      // Different numbers still go through.
      expect(
        await upsert([
          { amount: "6.01", note: "a" },
          { amount: "6.02", note: "b" },
          { amount: "-6.01", note: "c" },
        ]),
      ).toEqual({ affectedRows: 3 });

      // Split over several statements, the later row would win silently.
      const many = Array.from({ length: 33_000 }, (_, position) => ({
        amount: String(position + 10),
        note: "x",
      }));
      many[32_999] = { amount: "10.0", note: "last" };
      await expect(upsert(many)).rejects.toBeInstanceOf(
        DuplicateConflictKeyError,
      );
      expect(await database.prices.find("10")).toBeNull();

      // A UUID is one value in any letter case, and char(n) ignores its padding.
      const id = "AAAAAAAA-0000-4000-8000-000000000002";

      await expect(
        database.tokens
          .upsert(
            [
              { id, code: "x" },
              { id: id.toLowerCase(), code: "y" },
            ],
            { by: "id" },
          )
          .execute(),
      ).rejects.toBeInstanceOf(DuplicateConflictKeyError);
    });

    test("an upsert value that is a subquery of two rows is PostgreSQL's error, not a duplicate key", async () => {
      // Both are SQLSTATE 21000.
      const twoRows = sql.of(
        text,
      )`(SELECT v FROM (VALUES ('a'), ('b')) AS t(v))`;
      const failure = await database.hosts
        .upsert({ address: "10.9.9.9", label: twoRows }, { by: "address" })
        .execute()
        .catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(DuplicateConflictKeyError);
      expect(String(failure)).toContain("more than one row");
    });

    test("upsert keys of inet and interval equal in another spelling are one key, also when split", async () => {
      await expect(
        database.hosts
          .upsert(
            [
              { address: "10.0.0.1", label: "first" },
              { address: "10.0.0.1/32", label: "last" },
            ],
            { by: "address" },
          )
          .execute(),
      ).rejects.toBeInstanceOf(DuplicateConflictKeyError);

      // Above 65,535 parameters the upsert is several statements, where the
      // later row would overwrite the earlier one without an error.
      const rows = (first: string, last: string) =>
        Array.from({ length: 22_000 }, (_, index) => ({
          length:
            index === 0 ? first : index === 21_999 ? last : `${index + 2} days`,
          label: index === 21_999 ? "last" : "first",
        }));

      await expect(
        database.spans
          .upsert(rows("1 day", "24:00:00"), { by: "length" })
          .execute(),
      ).rejects.toBeInstanceOf(DuplicateConflictKeyError);
      expect(await database.spans.count()).toBe(0);
      expect(
        (
          await database.spans.upsert(rows("1 day", "25:00:00"), {
            by: "length",
          })
        ).affectedRows,
      ).toBe(22_000);
    });

    test("a nullable parameter compares like the literal it is bound to", async () => {
      await database.entries.insert([
        { stage: "draft", meta: {} },
        { stage: "published", meta: { size: null } },
        { stage: null, meta: { size: 3 } },
      ]);
      const ids = async (rows: PromiseLike<{ id: number }[]>) =>
        (await rows).map((row) => row.id).sort();
      const other = prepare({ stage: stage.nullable }, (p) =>
        database.entries((entry) => ({ id: entry.id }), {
          where: (entry) => entry.stage.isNot(p.stage),
        }),
      );
      const negated = prepare({ stage: stage.nullable }, (p) =>
        database.entries((entry) => ({ id: entry.id }), {
          where: (entry) => not(entry.stage.is(p.stage)),
        }),
      );
      const sized = prepare({ size: int.nullable }, (p) =>
        database.entries((entry) => ({ id: entry.id }), {
          where: (entry) => entry.meta.path("size").is(p.size as never),
        }),
      );

      // An enum: the NULL row is neither "draft" nor something else, as in SQL.
      expect(await ids(other({ stage: "draft" }))).toEqual([2]);
      expect(await ids(negated({ stage: "draft" }))).toEqual([2]);
      expect(await ids(other({ stage: null }))).toEqual([1, 2]);
      // Bound to null, not() turns the null check around: TRUE or FALSE for
      // every row, never NULL.
      const kept = prepare({ stage: stage.nullable }, (p) =>
        database.entries((entry) => ({ id: entry.id }), {
          where: (entry) => not(entry.stage.isNot(p.stage)),
        }),
      );
      expect(await ids(negated({ stage: null }))).toEqual([1, 2]);
      expect(await ids(kept({ stage: null }))).toEqual([3]);
      expect(await ids(kept({ stage: "draft" }))).toEqual([1]);
      expect(
        await ids(
          database.entries((entry) => ({ id: entry.id }), {
            where: (entry) => entry.stage.isNot("draft"),
          }),
        ),
      ).toEqual([2]);
      // A JSON path: null counts JSON null and a missing key, as is(null) does.
      expect(await ids(sized({ size: null }))).toEqual(
        await ids(
          database.entries((entry) => ({ id: entry.id }), {
            where: (entry) => entry.meta.path("size").is(null),
          }),
        ),
      );
      expect(await ids(sized({ size: null }))).toEqual([1, 2]);
      expect(await ids(sized({ size: 3 }))).toEqual([3]);
    });

    test("in() and notIn() refuse a null in the list", () => {
      expect(() =>
        ids({ where: (thing) => thing.note.notIn(["a", null as never]) }),
      ).toThrow(
        "symmetria: notIn() lists cannot contain null; combine the list with isNot(null)",
      );
      expect(() =>
        ids({ where: (thing) => thing.note.in([null as never]) }),
      ).toThrow(
        "symmetria: in() lists cannot contain null; combine the list with is(null)",
      );
    });
  },
);

const moments = schema({
  moments: table({
    id: int.auto,
    zoned: timestamptz,
    local: timestamp,
    day: date,
  }),
});

describe.skipIf(!databaseUrl)(
  "node-postgres reads dates whatever DateStyle the server sets",
  () => {
    test("a session that starts with DateStyle SQL, DMY reads ISO values", async () => {
      // The style a database or role setting would impose on new connections.
      const isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: moments,
        prefix: "symmetria_datestyle",
        driver: ({ url, max }) => {
          const styled = new URL(url);
          styled.searchParams.set(
            "options",
            `${styled.searchParams.get("options") ?? ""} -c DateStyle=SQL,DMY`.trim(),
          );

          return pg({ url: styled.toString(), max });
        },
      });

      try {
        const at = new Date("2024-03-05T10:20:30.000Z");
        const written = { zoned: at, local: at, day: "2024-03-05" };
        const query = isolated.database.moments(
          ({ zoned, local, day }) => ({ zoned, local, day }),
          { orderBy: ({ zoned, id }) => [zoned.ascending, id.ascending] },
        );

        await isolated.database.moments.insert([written, written]);
        expect(await query).toEqual([written, written]);

        const first = await query.page({ size: 1 });
        const second = await query.page({ size: 1, after: first.nextCursor! });

        expect(second.items).toEqual([written]);
      } finally {
        await isolated.close();
      }
    });
  },
);
