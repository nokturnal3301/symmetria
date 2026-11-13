/**
 * Results whose static types must match what PostgreSQL returns: jsonb(schema)
 * filters on the stored input, arithmetic checked against hand-written SQL,
 * MIN/MAX of JSON values and types without them, and JSON null where a result
 * is typed non-null.
 */
import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  smallint,
  bigint,
  numeric,
  real,
  doublePrecision,
  bool,
  uuid,
  jsonb,
  oneOf,
  prepare,
  sql,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  count,
  over,
  rowNumber,
  type Decimal,
} from "../../packages/runtime/src";
import { expectDataError } from "./data-errors";
import { testDatabase } from "./postgres";

/** Stored as `{ at: ISO text, level }`, read with `at` as a Date. */
const audit = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) =>
      value !== null &&
      typeof value === "object" &&
      typeof (value as { at?: unknown }).at === "string" &&
      typeof (value as { level?: unknown }).level === "number"
        ? {
            value: {
              at: new Date((value as { at: string }).at),
              level: (value as { level: number }).level,
            },
          }
        : { issues: [{ message: "expected { at: string, level: number }" }] },
    types: undefined as unknown as {
      input: { at: string; level: number };
      output: { at: Date; level: number };
    },
  },
};

const numbers = table({
  id: int.auto,
  quantity: int,
  small: smallint,
  views: bigint,
  price: numeric(10, 2),
  weight: real,
  ratio: doublePrecision,
  maybe: int.nullable,
  state: oneOf("open", "closed").default("open"),
  counts: int.array,
  notes: jsonb<{ price: Decimal }>().array,
});
const audits = table({
  id: int.auto,
  entry: jsonb(audit),
  previous: jsonb(audit).nullable,
});
const reviews = table({ id: int.auto, audit: audits, score: int });
const owners = table({
  id: int.auto,
  name: jsonb<string | null>(),
  bio: text.nullable,
});
const items = table({
  id: int.auto,
  owner: owners,
  meta: jsonb<{ size?: number | string | boolean | null }>(),
  flag: bool,
  key: uuid,
});
const model = schema({ numbers, audits, reviews, owners, items });

/** The JavaScript type a value decodes to. */
const kind = (value: unknown): string =>
  value === null ? "null" : typeof value;

export const queryConsistencyTests = (): void => {
  const fixture = async () => {
    const isolated = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: model,
      prefix: "symmetria_consistency",
      max: 2,
    });
    const { database } = isolated;
    await database.numbers.insert([
      {
        quantity: 7,
        small: 32000,
        views: 9007199254740993n,
        price: "19.99",
        weight: 0.5,
        ratio: 2.5,
        counts: [7, 2],
        notes: [{ price: "1.5" }],
      },
      {
        quantity: -7,
        small: -3,
        views: -5n,
        price: "-0.01",
        weight: 1.25,
        ratio: -1.5,
        maybe: 4,
        counts: [-7],
        notes: [],
      },
    ]);

    return { database, close: isolated.close };
  };

  test("jsonb(schema) filters, contains() and paths compare the stored input", async () => {
    const { database, close } = await fixture();

    try {
      const first = { at: "2026-11-09T10:00:00.000Z", level: 1 };
      const second = { at: "2026-11-10T10:00:00.000Z", level: 2 };
      await database.audits.insert([
        { entry: first, previous: null },
        { entry: second, previous: first },
      ]);
      const ids = (rows: readonly { id: number }[]) =>
        rows.map((row) => row.id);

      expect(
        ids(
          await database.audits((row) => ({ id: row.id }), {
            where: (row) => row.entry.is(first),
          }),
        ),
      ).toEqual([1]);
      expect(
        ids(
          await database.audits((row) => ({ id: row.id }), {
            where: (row) => [
              row.entry.in([first, second]),
              row.entry.isNot(first),
              row.entry.contains({ level: 2 }),
              row.entry.path("at").is(second.at),
              row.entry.path("level").above(1),
              row.previous.is(first),
            ],
          }),
        ),
      ).toEqual([2]);
      // The output form is not a stored value: filtering with it fails clearly.
      await expectDataError(
        () =>
          database.audits((row) => ({ id: row.id }), {
            where: (row) =>
              row.entry.is({ at: new Date(first.at), level: 1 } as never),
          }),
        /invalid jsonb value/,
      );

      // Reads return the output, paths the stored JSON.
      const read = await database
        .audits(
          (row) => ({
            entry: row.entry,
            at: row.entry.path("at"),
            latest: maximum(row.entry),
            fallback: coalesce(row.previous, second),
          }),
          { where: (row) => row.id.is(1), groupBy: (row) => [row.id] },
        )
        .one();
      expect(read).toEqual({
        entry: { at: new Date(first.at), level: 1 },
        at: first.at,
        latest: { at: new Date(first.at), level: 1 },
        fallback: { at: new Date(second.at), level: 2 },
      });

      // A CTE column and a prepared parameter compare the input as well.
      const recent = database
        .audits((row) => ({ id: row.id, entry: row.entry }))
        .cte("recent");
      expect(
        await recent((row) => ({ id: row.id }), {
          where: (row) => row.entry.is(second),
        }),
      ).toEqual([{ id: 2 }]);
      const byEntry = prepare({ entry: jsonb(audit) }, (parameters) =>
        database.audits((row) => ({ id: row.id }), {
          where: (row) => row.entry.is(parameters.entry),
        }),
      );
      expect(await byEntry({ entry: first })).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("paths into nested results read a jsonb(schema) field like the column", async () => {
    const { database, close } = await fixture();

    try {
      const first = { at: "2026-11-09T10:00:00.000Z", level: 1 };
      const second = { at: "2026-11-10T10:00:00.000Z", level: 2 };
      await database.audits.insert([{ entry: first }, { entry: second }]);
      await database.reviews.insert([
        { auditId: 1, score: 5 },
        { auditId: 2, score: 3 },
      ]);

      // A relation result: the field reads its output, inside it the stored JSON.
      const related = await database.reviews(
        (review) => {
          const audit = review.audit((audit) => ({ entry: audit.entry }));

          return {
            entry: audit.path("entry"),
            at: audit.path("entry", "at"),
          };
        },
        {
          where: (review) =>
            review
              .audit((audit) => ({ entry: audit.entry }))
              .path("entry")
              .is(second),
        },
      );
      expect(related).toEqual([
        { entry: { at: new Date(second.at), level: 2 }, at: second.at },
      ]);

      // A CTE's nested object and a selected query field alike.
      const nested = database
        .audits((audit) => ({
          id: audit.id,
          payload: { entry: audit.entry },
          listed: database.reviews((review) => ({ score: review.score }), {
            where: (review) => review.auditId.is(audit.id),
          }),
        }))
        .cte("nested");
      expect(
        await nested(
          (row) => ({
            entry: row.payload.path("entry"),
            at: row.payload.path("entry", "at"),
            score: row.listed.path(0, "score"),
          }),
          {
            where: (row) => [
              row.payload.path("entry").is(first),
              row.payload.path("entry", "level").is(1),
            ],
          },
        ),
      ).toEqual([
        { entry: { at: new Date(first.at), level: 1 }, at: first.at, score: 5 },
      ]);
      // The output form is not stored, so filtering with it fails clearly.
      await expectDataError(
        () =>
          nested((row) => ({ id: row.id }), {
            where: (row) =>
              row.payload
                .path("entry")
                .is({ at: new Date(first.at), level: 1 } as never),
          }),
        /invalid jsonb value/,
      );
    } finally {
      await close();
    }
  });

  test("arithmetic returns what hand-written SQL returns, typed as it decodes", async () => {
    const { database, close } = await fixture();

    try {
      const rows = await database.numbers(
        (row) => ({
          divide: row.quantity.divide(2),
          divideSql: sql.of(numeric)`${row.quantity}::numeric / 2::numeric`,
          quotient: row.quantity.quotient(2),
          quotientSql: sql.of(int)`${row.quantity} / 2`,
          bigDivide: row.views.divide(2),
          bigDivideSql: sql.of(numeric)`${row.views}::numeric / 2`,
          bigQuotient: row.views.quotient(2),
          bigQuotientSql: sql.of(bigint)`${row.views} / 2`,
          decimalQuotient: row.price.quotient("0.03"),
          decimalQuotientSql: sql.of(numeric)`div(${row.price}, 0.03)`,
          floatDivide: row.weight.divide(2),
          floatDivideSql: sql.of(doublePrecision)`${row.weight}::float8 / 2`,
          floatQuotient: row.ratio.quotient(2),
          floatQuotientSql: sql.of(doublePrecision)`trunc(${row.ratio} / 2)`,
          intTimesDecimal: row.quantity.multiply(row.price),
          intTimesDecimalSql: sql.of(numeric)`${row.quantity} * ${row.price}`,
          intTimesText: row.quantity.multiply("1.5"),
          intTimesTextSql: sql.of(numeric)`${row.quantity} * 1.5`,
          intPlusBigint: row.quantity.plus(row.views),
          intPlusBigintSql: sql.of(bigint)`${row.quantity} + ${row.views}`,
          intTimesFloat: row.quantity.multiply(row.weight),
          intTimesFloatSql: sql.of(
            doublePrecision,
          )`${row.quantity} * ${row.weight}::float8`,
          bigintTimesFloat: row.views.multiply(row.ratio),
          bigintTimesFloatSql: sql.of(
            doublePrecision,
          )`${row.views} * ${row.ratio}`,
          floatTimesBigint: row.weight.multiply(10n),
          floatTimesBigintSql: sql.of(
            doublePrecision,
          )`${row.weight}::float8 * 10`,
          // A number next to a smallint is an integer: no smallint overflow.
          smallPlus: row.small.plus(1000),
          smallPlusSql: sql.of(int)`${row.small} + 1000`,
          nullable: row.maybe.divide(2),
          nullableSql: sql.of(numeric.nullable)`${row.maybe}::numeric / 2`,
        }),
        { orderBy: (row) => row.id.ascending },
      );

      for (const row of rows) {
        const divide: Decimal = row.divide;
        const quotient: number = row.quotient;
        const bigQuotient: bigint = row.bigQuotient;
        const floatDivide: number = row.floatDivide;
        const intPlusBigint: bigint = row.intPlusBigint;
        const nullable: Decimal | null = row.nullable;
        expect([
          kind(divide),
          kind(quotient),
          kind(row.bigDivide),
          kind(bigQuotient),
          kind(row.decimalQuotient),
          kind(floatDivide),
          kind(row.floatQuotient),
          kind(row.intTimesDecimal),
          kind(row.intTimesText),
          kind(intPlusBigint),
          kind(row.intTimesFloat),
          kind(row.bigintTimesFloat),
          kind(row.floatTimesBigint),
          kind(row.smallPlus),
        ]).toEqual([
          "string",
          "number",
          "string",
          "bigint",
          "string",
          "number",
          "number",
          "string",
          "string",
          "bigint",
          "number",
          "number",
          "number",
          "number",
        ]);

        for (const [name, value] of Object.entries(row)) {
          if (!name.endsWith("Sql")) {
            expect([name, value]).toEqual([
              name,
              row[`${name}Sql` as keyof typeof row],
            ]);
          }
        }

        void nullable;
      }

      expect(rows.map((row) => [row.divide, row.quotient])).toEqual([
        ["3.5000000000000000", 3],
        ["-3.5000000000000000", -3],
      ]);
      // PostgreSQL keeps at least 16 significant digits in a numeric quotient.
      expect(rows[0]!.bigDivide).toBe("4503599627370496.5000");
      expect(rows[0]!.smallPlus).toBe(33000);
      expect(rows.map((row) => row.nullable)).toEqual([
        null,
        "2.0000000000000000",
      ]);

      // Aggregates and windows over expressions keep the same types.
      const totals = await database
        .numbers((row) => ({
          rows: count().plus(1),
          half: count().divide(2),
          total: sum(row.quantity.multiply(row.price)),
          mean: average(row.weight.divide(2)),
          heaviest: maximum(row.weight).divide(2),
        }))
        .one();
      expect(totals).toEqual({
        rows: 3,
        half: "1.00000000000000000000",
        total: "140.00",
        // The average of doubles is a double, read as exact decimal text.
        mean: "0.4375",
        heaviest: 0.625,
      });
      // A number reached with path(), in an array or a nested result, is a double.
      const nested = database
        .numbers((row) => ({
          id: row.id,
          payload: { views: row.views, quantity: row.quantity },
        }))
        .cte("nested");
      const reached = await database.numbers(
        (row, { innerJoin }) => {
          const other = innerJoin(nested, (other) => other.id.is(row.id));

          return {
            first: row.counts.path(0).divide(2),
            firstSql: sql.of(
              doublePrecision.nullable,
            )`${row.counts}[1]::float8 / 2`,
            quantity: other.payload.path("quantity").divide(2),
            views: other.payload.path("views").plus(1n),
            // Decimal text inside JSON is still JSON: it computes as a double.
            note: row.notes.path(0, "price").plus(1),
          };
        },
        { orderBy: (row) => row.id.ascending },
      );
      const first: number | null = reached[0]!.first;
      const views: bigint | null = reached[0]!.views;
      const note: number | null = reached[0]!.note;
      expect(reached).toEqual([
        {
          first: 3.5,
          firstSql: 3.5,
          quantity: 3.5,
          views: 9007199254740994n,
          note: 2.5,
        },
        { first: -3.5, firstSql: -3.5, quantity: -3.5, views: -4n, note: null },
      ]);
      void note;
      void [first, views];

      expect(
        await database.numbers(
          (row) => ({
            position: rowNumber()
              .over({ orderBy: row.id.ascending })
              .quotient(2),
          }),
          { orderBy: (row) => row.id.ascending },
        ),
      ).toEqual([{ position: 0 }, { position: 1 }]);
    } finally {
      await close();
    }
  });

  test("match() literals next to a column branch read as that column", async () => {
    const { database, close } = await fixture();

    try {
      await database.numbers.byId(2).update({ state: "closed" });
      const rows = await database.numbers(
        (row) => ({
          views: row.state.match({ open: row.views, closed: 0 }),
          labels: row.state.match({ open: "Open", closed: null }),
        }),
        { orderBy: (row) => row.id.ascending },
      );
      const views: bigint[] = rows.map((row) => row.views);

      expect(views).toEqual([9007199254740993n, 0n]);
      expect(rows.map((row) => row.labels)).toEqual(["Open", null]);
      // Literals alone need one type: the CASE has one.
      expect(() =>
        database.numbers((row) => ({
          label: row.state.match({ open: "Open", closed: 1 } as never),
        })),
      ).toThrow(/compatible scalar values/);
    } finally {
      await close();
    }
  });

  test("numbers next to integer columns must be integers in range; zero divisors fail", async () => {
    const { database, close } = await fixture();

    try {
      for (const [build, message] of [
        [
          () =>
            database.numbers((row) => ({ value: row.quantity.multiply(1.5) })),
          /integer values are integers from -2147483648 to 2147483647, received 1.5/,
        ],
        [
          () => database.numbers((row) => ({ value: row.small.plus(2 ** 31) })),
          /received 2147483648/,
        ],
        [
          () => database.numbers((row) => ({ value: row.views.plus(0.5) })),
          /bigint values or safe integers/,
        ],
      ] as const) {
        await expectDataError(build, message);
      }

      // A fraction is written as decimal text, and stays exact.
      expect(
        await database.numbers(
          (row) => ({ value: row.quantity.multiply("1.5") }),
          {
            orderBy: (row) => row.id.ascending,
          },
        ),
      ).toEqual([{ value: "10.5" }, { value: "-10.5" }]);

      await expect(
        database
          .numbers((row) => ({ value: row.quantity.divide(0) }))
          .execute(),
      ).rejects.toThrow(/division by zero/);
      await expect(
        database
          .numbers((row) => ({ value: row.quantity.quotient(0) }))
          .execute(),
      ).rejects.toThrow(/division by zero/);
      await expect(
        database.numbers((row) => ({ value: row.ratio.quotient(0) })).execute(),
      ).rejects.toThrow(/division by zero/);
      // Raw SQL has no SQL type to compute with: a shape error, thrown where built.
      expect(() =>
        database.numbers(() => ({
          value: (
            sql<number>`1` as never as { plus: (value: number) => never }
          ).plus(1),
        })),
      ).toThrow(/known SQL type; write raw SQL as sql.of\(column\)/);
    } finally {
      await close();
    }
  });

  test("minimum() and maximum() order JSON values as jsonb, in every context", async () => {
    const { database, close } = await fixture();

    try {
      await database.owners.insert([
        { name: "first" },
        { name: "second" },
        { name: null },
      ]);
      const keys = [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
      ];
      // Numbers order numerically (10 above 9), strings textually, numbers
      // above strings; JSON null and missing keys are skipped like NULL.
      await database.items.insert([
        { ownerId: 1, meta: { size: 9 }, flag: true, key: keys[0]! },
        { ownerId: 1, meta: { size: 10 }, flag: false, key: keys[1]! },
        { ownerId: 1, meta: { size: null }, flag: true, key: keys[0]! },
        { ownerId: 2, meta: { size: "b" }, flag: true, key: keys[0]! },
        { ownerId: 2, meta: { size: "a" }, flag: true, key: keys[0]! },
        { ownerId: 2, meta: { size: 1 }, flag: true, key: keys[1]! },
        { ownerId: 3, meta: {}, flag: false, key: keys[0]! },
      ]);

      expect(
        await database
          .items((item) => ({
            smallest: minimum(item.meta.path("size")),
            largest: maximum(item.meta.path("size")),
            lowest: minimum(item.key),
            all: minimum(item.flag),
            any: maximum(item.flag),
          }))
          .one(),
      ).toEqual({
        smallest: "a",
        largest: 10,
        lowest: keys[1]!,
        all: false,
        any: true,
      });
      // Grouped, as relation aggregates and in a window.
      expect(
        await database.items(
          (item) => ({
            owner: item.ownerId,
            largest: maximum(item.meta.path("size")),
          }),
          {
            groupBy: (item) => [item.ownerId],
            orderBy: (item) => item.ownerId.ascending,
          },
        ),
      ).toEqual([
        { owner: 1, largest: 10 },
        { owner: 2, largest: 1 },
        { owner: 3, largest: null },
      ]);
      expect(
        await database.owners(
          (owner) => ({
            largest: owner.items.maximum((item) => item.meta.path("size")),
            smallest: owner
              .items({ limit: 2, orderBy: (item) => item.id.ascending })
              .minimum((item) => item.meta.path("size")),
            fewest: owner.items.minimum.flag,
          }),
          { orderBy: (owner) => owner.id.ascending },
        ),
      ).toEqual([
        { largest: 10, smallest: 9, fewest: false },
        { largest: 1, smallest: "a", fewest: true },
        { largest: null, smallest: null, fewest: false },
      ]);
      expect(
        await database.items(
          (item) => ({
            running: over(maximum(item.meta.path("size")), {
              partitionBy: [item.ownerId],
              orderBy: item.id.ascending,
            }),
          }),
          { orderBy: (item) => item.id.ascending },
        ),
      ).toEqual([
        { running: 9 },
        { running: 10 },
        { running: 10 },
        { running: "b" },
        { running: "b" },
        { running: 1 },
        { running: null },
      ]);
      // A JSON column orders as jsonb too; no rows give null.
      expect(
        await database
          .owners(
            (owner) => ({
              first: minimum(owner.name),
              last: maximum(owner.name),
            }),
            { where: (owner) => owner.id.above(10) },
          )
          .one(),
      ).toEqual({ first: null, last: null });
      expect(
        await database
          .owners((owner) => ({
            first: minimum(owner.name),
            last: maximum(owner.name),
          }))
          .one(),
      ).toEqual({ first: "first", last: "second" });
    } finally {
      await close();
    }
  });

  test("ranking and highlighting NULL text give NULL, as typed", async () => {
    const { database, close } = await fixture();

    try {
      await database.owners.insert([
        { name: "a", bio: "red fox" },
        { name: "b", bio: null },
      ]);
      const rows = await database.owners(
        (owner) => ({
          rank: owner.bio.searchRank("fox"),
          snippet: owner.bio.searchHeadline("fox"),
        }),
        { orderBy: (owner) => owner.id.ascending },
      );
      const rank: number | null = rows[1]!.rank;

      expect(typeof rows[0]!.rank).toBe("number");
      expect(rank).toBeNull();
      expect(rows[1]!.snippet).toBeNull();
    } finally {
      await close();
    }
  });

  test("coalesce() and whereNotNull() treat JSON null as null", async () => {
    const { database, close } = await fixture();

    try {
      await database.owners.insert([{ name: "named" }, { name: null }]);
      await database.items.insert([
        {
          ownerId: 1,
          meta: { size: null },
          flag: true,
          key: crypto.randomUUID(),
        },
        { ownerId: 1, meta: {}, flag: true, key: crypto.randomUUID() },
        { ownerId: 1, meta: { size: 3 }, flag: true, key: crypto.randomUUID() },
      ]);

      expect(
        await database.items(
          (item) => ({ size: coalesce(item.meta.path("size"), 0) }),
          { orderBy: (item) => item.id.ascending },
        ),
      ).toEqual([{ size: 0 }, { size: 0 }, { size: 3 }]);
      expect(
        await database.owners(
          (owner) => ({ name: coalesce(owner.name, "anonymous") }),
          { orderBy: (owner) => owner.id.ascending },
        ),
      ).toEqual([{ name: "named" }, { name: "anonymous" }]);
      expect(
        await database.items((item, { whereNotNull }) => ({
          size: whereNotNull(item.meta.path("size")),
        })),
      ).toEqual([{ size: 3 }]);
      expect(
        await database.owners((owner, { whereNotNull }) => ({
          name: whereNotNull(owner.name),
        })),
      ).toEqual([{ name: "named" }]);
    } finally {
      await close();
    }
  });
};
