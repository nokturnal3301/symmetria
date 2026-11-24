import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDatabase,
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
import { postgres, testDatabase } from "../../support/postgres";
import { hasExtension } from "../../support/extensions";

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

describe.skipIf(!databaseUrl)(
  "an upsert split into several statements compares keys as the unique index does",
  () => {
    test("keys equal under the column's nondeterministic collation are one key", async () => {
      const columns = {
        id: int,
        sku: text.unique,
        stage,
        qty: int,
      };
      const isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: schema({ items: table(columns) }),
        prefix: "symmetria_collated_keys",
        driver: postgres,
      });

      try {
        const run = (statement: string) =>
          isolated.driver.execute({ sql: statement, parameters: [] });
        await run(
          `CREATE COLLATION "${isolated.namespace}".case_blind (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
        );
        await run(
          `ALTER TABLE items ALTER COLUMN sku TYPE text COLLATE "${isolated.namespace}".case_blind`,
        );
        const database = createDatabase({
          schema: schema({
            items: table({
              ...columns,
              sku: text.collate("case_blind").unique,
            }),
          }),
          driver: isolated.driver,
        });
        // 20,000 rows of 4 values: two statements, the enum keeps VALUES.
        const rows = Array.from({ length: 20_000 }, (_, index) => ({
          id: index + 1,
          sku: `sku-${index}`,
          stage: "draft" as const,
          qty: 0,
        }));
        rows[0] = { ...rows[0]!, sku: "Alpha", qty: 1 };
        rows[19_999] = { ...rows[19_999]!, sku: "ALPHA", qty: 2 };

        for (const size of [2, 20_000]) {
          await expect(
            database.items
              .upsert(size === 2 ? [rows[0]!, rows[19_999]!] : rows, {
                by: "sku",
              })
              .execute(),
          ).rejects.toBeInstanceOf(DuplicateConflictKeyError);
        }

        expect(await database.items.count()).toBe(0);
        rows[19_999] = { ...rows[19_999]!, sku: "Beta" };
        expect(
          (await database.items.upsert(rows, { by: "sku" })).affectedRows,
        ).toBe(20_000);
      } finally {
        await isolated.close();
      }
    });

    test("an array key is sent in PostgreSQL's array form", async () => {
      const isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: schema({
          marks: table({
            id: int,
            tags: text.array.unique,
            at: timestamptz.array.unique.nullable,
            amounts: numeric(10, 2).array.unique.nullable,
            note: text,
          }),
        }),
        prefix: "symmetria_array_keys",
        driver: postgres,
      });

      try {
        const { marks } = isolated.database;
        // 17,000 rows of 5 values: arrays keep VALUES, so several statements.
        const rows = Array.from({ length: 17_000 }, (_, index) => ({
          id: index,
          tags: [`a${index}`, 'b,"c"\\', "{d}"],
          at: [new Date(Date.UTC(2000, 0, 1, 0, 0, index))],
          amounts: [`${index}.5`, "1"],
          note: "x",
        }));

        for (const by of ["tags", "at", "amounts"] as const) {
          expect((await marks.upsert(rows, { by })).affectedRows).toBe(17_000);
        }

        expect(await marks.find(5)).toEqual({
          id: 5,
          tags: ["a5", 'b,"c"\\', "{d}"],
          at: [new Date("2000-01-01T00:00:05.000Z")],
          amounts: ["5.50", "1.00"],
          note: "x",
        });
        // One key to PostgreSQL in another spelling, rows apart.
        await marks.delete().all();
        rows[16_999] = { ...rows[16_999]!, amounts: ["0.50", "1.0"] };
        await expect(
          marks.upsert(rows, { by: "amounts" }).execute(),
        ).rejects.toBeInstanceOf(DuplicateConflictKeyError);
        expect(await marks.count()).toBe(0);
      } finally {
        await isolated.close();
      }
    });
  },
);

describe.skipIf(!databaseUrl)(
  "a compared value keeps its precision for every modifier and domain",
  () => {
    const as = (sqlType: string) =>
      customType<string>(sqlType, {
        encode: (value) => value,
        decode: (value) => String(value),
      });
    const amount = customType<string>("amount", { base: "numeric(30,10)" });
    const code = customType<string>("code5", { base: "varchar(5)" });
    const events = table({
      id: int.auto,
      ats: timestamptz(0).array,
      local: timestamp(0).array,
      bits: as("bit(3)").array,
      spans: as("interval day").array,
      amount: amount.nullable,
      // The same domains declared without their base.
      plain: as("amount").nullable,
      code: code.nullable,
      plainCode: as("code5").nullable,
      positive: as("positive").nullable,
    });
    const model = schema({ events });
    const connect = (driver: ReturnType<typeof postgres>) =>
      createDatabase({ schema: model, driver });
    let isolated: Awaited<ReturnType<typeof isolatedDatabase>>;
    let database: ReturnType<typeof connect>;

    beforeAll(async () => {
      isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: schema({ placeholder: table({ id: int.auto }) }),
        prefix: "symmetria_modifiers",
        driver: postgres,
        max: 1,
      });

      for (const statement of [
        "CREATE DOMAIN amount AS numeric(30,10)",
        "CREATE DOMAIN code5 AS varchar(5)",
        "CREATE DOMAIN positive AS integer CHECK (VALUE > 0)",
        `CREATE TABLE events (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          ats timestamptz(0)[] NOT NULL, local timestamp(0)[] NOT NULL,
          bits bit(3)[] NOT NULL, spans interval day[] NOT NULL,
          amount amount, plain amount, code code5, plain_code code5,
          positive positive)`,
      ]) {
        await isolated.driver.execute({ sql: statement, parameters: [] });
      }

      database = connect(isolated.driver);
      const noon = new Date("2020-01-01T12:00:00Z");

      await database.events.insert({
        ats: [noon],
        local: [noon],
        bits: ["101"],
        spans: ["1 day"],
        amount: "1.5",
        plain: "1.5",
        code: "abcde",
        plainCode: "abcde",
        positive: "3",
      });
    });

    afterAll(async () => {
      await isolated?.close();
    });

    const ids = async (rows: PromiseLike<{ id: number }[]>) =>
      (await rows).map((row) => row.id);
    // Rows a write would touch, rolled back.
    const touched = async (
      write: (
        transaction: Parameters<Parameters<typeof database.$transaction>[0]>[0],
      ) => PromiseLike<{ id: number }[]>,
    ) => {
      let found: number[] = [];

      await database
        .$transaction(async (transaction) => {
          found = await ids(write(transaction));
          throw new Error("rolled back");
        })
        .catch((error: Error) => {
          if (error.message !== "rolled back") {
            throw error;
          }
        });

      return found;
    };

    test("an array of timestamps, bit strings or intervals is searched with the values asked", async () => {
      // 12:00:00.400 would round to the stored 12:00:00, '10111' cut to '101',
      // '1 day 02:00' to '1 day'.
      const asked = new Date("2020-01-01T12:00:00.400Z");
      const select = (where: Parameters<typeof database.events>[1]) =>
        ids(database.events((event) => ({ id: event.id }), where));

      for (const operator of ["contains", "overlaps"] as const) {
        expect(
          await select({ where: (event) => event.ats[operator]([asked]) }),
        ).toEqual([]);
        expect(
          await select({ where: (event) => event.local[operator]([asked]) }),
        ).toEqual([]);
        expect(
          await select({ where: (event) => event.bits[operator](["10111"]) }),
        ).toEqual([]);
        expect(
          await select({
            where: (event) => event.spans[operator](["1 day 02:00"]),
          }),
        ).toEqual([]);
        expect(
          await touched((transaction) =>
            transaction.events
              .delete({ where: (event) => event.ats[operator]([asked]) })
              .returning((event) => ({ id: event.id })),
          ),
        ).toEqual([]);
      }

      expect(
        await touched((transaction) =>
          transaction.events
            .update({ spans: [] }, { where: (event) => event.ats.is([asked]) })
            .returning((event) => ({ id: event.id })),
        ),
      ).toEqual([]);
      const contains = prepare({ at: timestamptz(0).array }, (parameters) =>
        database.events((event) => ({ id: event.id }), {
          where: (event) => event.ats.contains(parameters.at),
        }),
      );
      expect(await ids(contains({ at: [asked] }))).toEqual([]);
      expect(
        await ids(contains({ at: [new Date("2020-01-01T12:00:00Z")] })),
      ).toEqual([1]);
      // The values written still take the column's precision.
      expect(
        await touched(async (transaction) => {
          await transaction.events
            .byId(1)
            .update({ ats: [asked], bits: ["111"] });

          return transaction.events((event) => ({ id: event.id }), {
            where: (event) =>
              event.ats.contains([new Date("2020-01-01T12:00:00Z")]),
          });
        }),
      ).toEqual([1]);
    });

    test("a nullable parameter compared with a domain is not rounded, cut or checked by the domain", async () => {
      const find = <
        Column extends "amount" | "plain" | "code" | "plainCode" | "positive",
      >(
        column: Column,
        definition: Parameters<typeof prepare>[0][string],
      ) =>
        prepare({ value: definition }, (parameters) =>
          database.events((event) => ({ id: event.id }), {
            where: (event) => event[column].is(parameters.value as never),
          }),
        );
      const other = <Column extends "amount" | "plain">(column: Column) =>
        prepare({ value: amount.nullable }, (parameters) =>
          database.events((event) => ({ id: event.id }), {
            where: (event) => event[column].isNot(parameters.value),
          }),
        );

      for (const column of ["amount", "plain"] as const) {
        const query = find(column, amount.nullable);

        expect(await ids(query({ value: "1.50000000001" }))).toEqual([]);
        expect(await ids(query({ value: "1.5" }))).toEqual([1]);
        expect(await ids(query({ value: null }))).toEqual([]);
        expect(await ids(other(column)({ value: "1.50000000001" }))).toEqual([
          1,
        ]);
        expect(
          await touched((transaction) =>
            prepare({ value: amount.nullable }, (parameters) =>
              transaction.events
                .delete()
                .where((event) => event[column].is(parameters.value))
                .returning((event) => ({ id: event.id })),
            )({ value: "1.50000000001" }),
          ),
        ).toEqual([]);
      }

      for (const column of ["code", "plainCode"] as const) {
        const query = find(column, code.nullable);

        expect(await ids(query({ value: "abcdefgh" }))).toEqual([]);
        expect(await ids(query({ value: "abcde" }))).toEqual([1]);
      }

      // -5 would fail the domain's CHECK; it is a value no row holds.
      const positive = find("positive", as("positive").nullable);

      expect(await ids(positive({ value: "-5" }))).toEqual([]);
      expect(await ids(positive({ value: "3" }))).toEqual([1]);
      expect(await ids(positive({ value: null }))).toEqual([]);
      // A list long enough to bind as one array reads the base type as well.
      expect(
        await ids(
          database.events((event) => ({ id: event.id }), {
            where: (event) =>
              event.plain.in(
                Array.from({ length: 1001 }, (_, i) => `1.5000000000${i + 1}`),
              ),
          }),
        ),
      ).toEqual([]);
    });
  },
);

const withCitext = await hasExtension(databaseUrl, "citext");

describe.skipIf(!databaseUrl)(
  "a nullable parameter takes its type from a column that is not PostgreSQL's own",
  () => {
    // A type declared with a `base` is still compared as itself: an enum
    // has no `=` with text, and citext compared with text is case-sensitive.
    const isolate = async (statements: string[]) => {
      const isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: schema({ placeholder: table({ id: int.auto }) }),
        prefix: "symmetria_typed_parameters",
        driver: postgres,
        searchPath: ["public"],
        max: 1,
      });

      for (const statement of statements) {
        await isolated.driver.execute({ sql: statement, parameters: [] });
      }

      return isolated;
    };
    const ids = async (rows: PromiseLike<{ id: number }[]>) =>
      (await rows).map((row) => row.id).sort();

    test("an enum declared with a text base", async () => {
      const mood = customType<string>("mood", { base: "text" });
      const people = table({ id: int.auto, mood: mood.nullable });
      const isolated = await isolate([
        "CREATE TYPE mood AS ENUM ('sad', 'ok')",
        "CREATE TABLE people (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, mood mood)",
        "INSERT INTO people (mood) VALUES ('ok'), (NULL)",
      ]);
      const database = createDatabase({
        schema: schema({ people }),
        driver: isolated.driver,
      });

      try {
        const same = prepare({ value: mood.nullable }, (parameters) =>
          database.people((person) => ({ id: person.id }), {
            where: (person) => person.mood.is(parameters.value),
          }),
        );
        const other = prepare({ value: mood.nullable }, (parameters) =>
          database.people((person) => ({ id: person.id }), {
            where: (person) => person.mood.isNot(parameters.value),
          }),
        );

        expect(await ids(same({ value: "ok" }))).toEqual([1]);
        expect(await ids(same({ value: "sad" }))).toEqual([]);
        expect(await ids(same({ value: null }))).toEqual([2]);
        expect(await ids(other({ value: "sad" }))).toEqual([1]);
        expect(await ids(other({ value: null }))).toEqual([1]);
      } finally {
        await isolated.close();
      }
    });

    test.skipIf(!withCitext)("citext declared with a text base", async () => {
      const name = customType<string>("citext", { base: "text" });
      const people = table({ id: int.auto, name: name.nullable });
      const isolated = await isolate([
        "CREATE TABLE people (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name citext)",
        "INSERT INTO people (name) VALUES ('Hello'), (NULL)",
      ]);
      const database = createDatabase({
        schema: schema({ people }),
        driver: isolated.driver,
      });

      try {
        const select = (where: Parameters<typeof database.people>[1]) =>
          ids(database.people((person) => ({ id: person.id }), where));
        const same = prepare({ value: name.nullable }, (parameters) =>
          database.people((person) => ({ id: person.id }), {
            where: (person) => person.name.is(parameters.value),
          }),
        );
        const other = prepare({ value: name.nullable }, (parameters) =>
          database.people((person) => ({ id: person.id }), {
            where: (person) => person.name.isNot(parameters.value),
          }),
        );

        expect(
          await select({ where: (person) => person.name.is("HELLO") }),
        ).toEqual([1]);
        expect(await ids(same({ value: "HELLO" }))).toEqual([1]);
        expect(await ids(same({ value: null }))).toEqual([2]);
        expect(await ids(other({ value: "HELLO" }))).toEqual([]);
        expect(await ids(other({ value: "Bye" }))).toEqual([1]);
      } finally {
        await isolated.close();
      }
    });
  },
);
