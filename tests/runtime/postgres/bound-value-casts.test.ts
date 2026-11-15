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
const model = schema({ things, prices, tokens });

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
