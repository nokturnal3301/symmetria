import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema, int, numeric, prepare } from "../../../packages/runtime/src";
import { expectDataError } from "../../support/data-errors";
import { testDatabase } from "../../support/postgres";

const model = schema({
  prices: {
    id: int.auto,
    price: numeric(12, 2),
    rates: numeric.array.default([]),
  },
});

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("numeric text on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_numeric_text",
      max: 1,
    });
    database = isolated.database;
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("every accepted form is one PostgreSQL reads", async () => {
    const accepted = [
      "1",
      "+1",
      "-1.5",
      ".5",
      "5.",
      "1e5",
      "1E-3",
      "1.e2",
      " 12 ",
      "\t1\n",
    ];

    await database.prices.insert(accepted.map((price) => ({ price })));
    expect(
      await database.prices((row) => ({ price: row.price }), {
        orderBy: (row) => row.id.ascending,
      }),
    ).toEqual([
      { price: "1.00" },
      { price: "1.00" },
      { price: "-1.50" },
      { price: "0.50" },
      { price: "5.00" },
      { price: "100000.00" },
      { price: "0.00" },
      { price: "100.00" },
      { price: "12.00" },
      { price: "1.00" },
    ]);

    // The special values need an unconstrained numeric.
    const special = await database.prices
      .insert({
        price: "0",
        rates: [
          "NaN",
          "nan",
          "Infinity",
          "+Infinity",
          "-Infinity",
          "inf",
          "-INF",
        ],
      })
      .returning((row) => ({ rates: row.rates }));
    expect<string[]>(special.rates).toEqual([
      "NaN",
      "NaN",
      "Infinity",
      "Infinity",
      "-Infinity",
      "Infinity",
      "-Infinity",
    ]);
    expect(
      await database.prices((row) => ({ id: row.id }), {
        where: (row) => row.price.is(" 12 "),
      }),
    ).toEqual([{ id: 9 }]);
  });

  test("text that is not a number rejects the query before it reaches PostgreSQL", async () => {
    const invalid = /numeric values are decimal text such as "12.50", received/;
    const before = await database.prices.count();

    await expectDataError(
      () => database.prices.insert({ price: "abc" }),
      invalid,
    );
    await expectDataError(
      () => database.prices.insert({ price: "1", rates: ["1", "1,5"] }),
      /received "1,5"/,
    );
    await expectDataError(
      () => database.prices.update({ price: "" }).where((row) => row.id.is(1)),
      invalid,
    );
    await expectDataError(
      () =>
        database.prices((row) => ({ id: row.id }), {
          where: (row) => row.price.above("ten"),
        }),
      /received "ten"/,
    );
    await expectDataError(
      () => database.prices((row) => ({ total: row.price.multiply("x") })),
      /received "x"/,
    );

    const cheaper = prepare({ limit: numeric }, (parameters) =>
      database.prices((row) => ({ id: row.id }), {
        where: (row) => row.price.below(parameters.limit),
        orderBy: (row) => row.id.ascending,
      }),
    );
    await expect(cheaper.execute({ limit: "1e" })).rejects.toThrow(
      /received "1e"/,
    );
    expect(await cheaper.execute({ limit: "0.75" })).toEqual([
      { id: 3 },
      { id: 4 },
      { id: 7 },
      { id: 11 },
    ]);

    expect(await database.prices.count()).toBe(before);
  });
});
