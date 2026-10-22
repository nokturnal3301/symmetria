import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bool,
  bigint,
  timestamptz,
  jsonb,
  customType,
  createDatabase,
  rowNumber,
  sum,
  over,
  coalesce,
  lag,
  lead,
  minimum,
  prepare,
} from "../../packages/runtime/src";
import { sqlite } from "../../packages/runtime/src/driver";
import { testDatabase } from "../../packages/kit/src/testing";

const precise = customType<{ value: bigint }>("numeric(30,0)", {
  encode: (value) => value.value.toString(),
  decode: (value) => ({ value: BigInt(String(value)) }),
});
const model = schema({
  records: {
    id: int,
    score: int.nullable,
    tag: text,
    active: bool,
    value: bigint,
    created: timestamptz,
    labels: jsonb<string[]>(),
    values: jsonb<unknown[]>(),
    numbers: int.array,
    booleans: bool.array,
    documents: jsonb<{ label: string }>().array,
    strings: jsonb<string>().array,
    precise,
    amounts: precise.array,
  },
  entries: ({ records }) => ({ id: int, record: records, value: bigint }),
});
const created = new Date("2026-10-01T00:00:00Z");
const large = 9007199254740993n;

export const queryValueTests = (dialect: "postgres" | "sqlite"): void => {
  const fixture = async () => {
    const postgresFixture =
      dialect === "postgres"
        ? await testDatabase({
            url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
            schema: model,
          })
        : undefined;
    const local = postgresFixture ? undefined : sqlite();
    local?.createTables(model);
    const driver = postgresFixture?.driver ?? local!;
    const database =
      postgresFixture?.database ?? createDatabase({ schema: model, driver });
    await database.records.insert(
      [1, 2, 3, 4].map((id) => ({
        id,
        score: id % 2 ? null : id,
        tag: "hello",
        active: true,
        value: large,
        created,
        labels: ["123", "hello"],
        values: ["123", true, null, { first: 1, nested: { last: [2, false] } }],
        numbers: [10, 20],
        booleans: [true, false],
        documents: [{ label: "hello" }],
        strings: ["123", "null", "true"],
        precise: { value: large },
        amounts: [{ value: large }],
      })),
    );
    await database.entries.insert([{ id: 1, recordId: 1, value: large }]);

    return {
      database,
      driver,
      close: postgresFixture ? postgresFixture.close : () => database.$close(),
    };
  };

  test("JSON paths preserve scalar codecs, nested collections and SQL-array element metadata", async () => {
    const { database, close } = await fixture();

    try {
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: {
            value: records.value,
            created: records.created,
            active: records.active,
            amounts: records.amounts,
            strings: records.strings,
            documents: records.documents,
          },
          entries: records.entries((entries) => ({ value: entries.value })),
        }))
        .cte("projected");
      const query = projected((projected) => ({
        id: projected.id,
        value: projected.payload.path("value"),
        created: projected.payload.path("created"),
        active: projected.payload.path("active"),
        amount: projected.payload.path("amounts", 0),
        string: projected.payload.path("strings", 0),
        label: projected.payload.path("documents", 0, "label"),
        first: projected.entries.path(0),
        entryValue: projected.entries.path(0, "value"),
        $orderBy: projected.id.ascending,
      }));
      const expected = [1, 2, 3, 4].map((id) => ({
        id,
        value: large,
        created,
        active: true,
        amount: { value: large },
        string: "123",
        label: "hello",
        first: id === 1 ? { value: large } : null,
        entryValue: id === 1 ? large : null,
      }));
      expect(await query).toEqual(expected);
      expect(
        await query.cte("extracted")((extracted) => ({
          id: extracted.id,
          value: extracted.value,
          created: extracted.created,
          active: extracted.active,
          amount: extracted.amount,
          string: extracted.string,
          label: extracted.label,
          first: extracted.first,
          entryValue: extracted.entryValue,
          $orderBy: extracted.id.ascending,
        })),
      ).toEqual(expected);
      expect(
        await query.as("extracted")((extracted) => ({
          nested: {
            value: extracted.value,
            first: extracted.first,
            string: extracted.string,
          },
          $orderBy: extracted.id.ascending,
        })),
      ).toEqual(
        expected.map(({ value, first, string }) => ({
          nested: { value, first, string },
        })),
      );
    } finally {
      await close();
    }
  });

  test("typed JSON scalar paths support prepared comparisons and arithmetic", async () => {
    const { database, close } = await fixture();

    try {
      const projected = database
        .records((records) => ({
          payload: {
            value: records.value,
            created: records.created,
            active: records.active,
          },
        }))
        .cte("projected");
      const query = prepare(
        { value: bigint, created: timestamptz },
        (parameters) =>
          projected((projected) => ({
            value: projected.payload.path("value").plus(1n),
            $where: [
              projected.payload.path("value").is(parameters.value),
              projected.payload.path("created").is(parameters.created),
              projected.payload.path("active").is(true),
            ],
          })),
      );
      expect(await query.execute({ value: large, created })).toEqual(
        Array.from({ length: 4 }, () => ({ value: large + 1n })),
      );
      expect(await query.execute({ value: large + 1n, created })).toEqual([]);
    } finally {
      await close();
    }
  });

  test("SQL-array paths are zero-based, nullable, codec-aware and compose with JSON paths", async () => {
    const { database, driver, close } = await fixture();

    try {
      const query = database.records((records) => ({
        id: records.id,
        number: records.numbers.path(1),
        missing: records.numbers.path(10),
        boolean: records.booleans.path(0),
        amount: records.amounts.path(0),
        label: records.documents.path(0, "label"),
        chained: records.documents.path(0).path("label"),
        string: records.strings.path(0),
        $orderBy: records.id.ascending,
      }));
      const expected = [1, 2, 3, 4].map((id) => ({
        id,
        number: 20,
        missing: null,
        boolean: true,
        amount: { value: large },
        label: "hello",
        chained: "hello",
        string: "123",
      }));
      expect(await query).toEqual(expected);
      expect(
        await query.as("elements")((elements) => ({
          nested: {
            number: elements.number,
            amount: elements.amount,
            string: elements.string,
          },
          $orderBy: elements.id.ascending,
        })),
      ).toEqual(
        expected.map(({ number, amount, string }) => ({
          nested: { number, amount, string },
        })),
      );

      if (dialect === "postgres") {
        await driver.execute({
          sql: "UPDATE records SET numbers = '[0:1]={10,20}'::integer[]",
          parameters: [],
        });
        expect(await query).toEqual(expected);
        await driver.execute({
          sql: "UPDATE records SET numbers = '[-2:-1]={10,20}'::integer[]",
          parameters: [],
        });
        expect(await query).toEqual(expected);
      }
    } finally {
      await close();
    }
  });

  test("JSON-array length and membership preserve JSON scalar types and object equality", async () => {
    const { database, close } = await fixture();

    try {
      expect(
        await database.records((records) => ({
          length: records.labels.length(),
        })),
      ).toEqual(Array.from({ length: 4 }, () => ({ length: 2 })));
      const query = prepare(
        { value: jsonb<unknown>().nullable },
        (parameters) =>
          database.records((records) => ({
            id: records.id,
            $where: records.values.has(parameters.value),
          })),
      );

      for (const value of [
        "123",
        true,
        null,
        { nested: { last: [2, false] }, first: 1 },
      ]) {
        expect(await query.execute({ value })).toHaveLength(4);
      }

      for (const value of [
        123,
        1,
        false,
        "null",
        { first: 1 },
        { first: 1, nested: { last: [false, 2] } },
      ]) {
        expect(await query.execute({ value })).toEqual([]);
      }

      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.labels.has("hello"),
        })),
      ).toHaveLength(4);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.labels.has(records.tag),
        })),
      ).toHaveLength(4);
      expect(
        await database.records.as("__symmetria_element")(
          (__symmetria_element) => ({
            id: __symmetria_element.id,
            $where: __symmetria_element.labels.has(__symmetria_element.tag),
          }),
        ),
      ).toHaveLength(4);
    } finally {
      await close();
    }
  });

  test("custom numeric scalar and array wrappers retain precision through nested JSON", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.records((records) => ({
        id: records.id,
        payload: {
          value: coalesce(records.precise, { value: 0n }),
          amounts: coalesce(records.amounts, []),
          previous: lag(records.precise).over({
            orderBy: records.id.ascending,
          }),
          minimum: over(minimum(records.precise), {
            orderBy: records.id.ascending,
          }),
        },
        $orderBy: records.id.ascending,
      }));
      const expected = [1, 2, 3, 4].map((id) => ({
        id,
        payload: {
          value: { value: large },
          amounts: [{ value: large }],
          previous: id === 1 ? null : { value: large },
          minimum: { value: large },
        },
      }));
      expect(await query).toEqual(expected);
      expect(
        await query.cte("precise")((precise) => ({
          id: precise.id,
          payload: precise.payload,
          $orderBy: precise.id.ascending,
        })),
      ).toEqual(expected);
    } finally {
      await close();
    }
  });

  test("cursor pages preserve global windows, nested ranks and moving aggregates", async () => {
    const { database, close } = await fixture();

    try {
      for (const nullable of [false, true]) {
        const query = database.records((records) => ({
          id: records.id,
          __symmetria_order_0: records.tag,
          __symmetria_cursor_0: records.value,
          nested: {
            position: rowNumber().over({ orderBy: records.id.ascending }),
          },
          running: over(sum(records.id), { orderBy: records.id.ascending }),
          previous: coalesce(
            lag(records.value).over({ orderBy: records.id.ascending }),
            0n,
          ),
          next: lead(records.id).over({ orderBy: records.id.ascending }),
          $where: records.id.above(1),
          $orderBy: nullable
            ? [records.score.ascending.nullsLast, records.id.descending]
            : records.id.ascending,
        }));
        const expected = await query;

        for (const size of [1, 2, 3]) {
          const rows: typeof expected = [];

          for await (const page of query.pages({ size })) {
            rows.push(...page.items);
          }

          expect(rows).toEqual(expected);
        }
      }
    } finally {
      await close();
    }
  });

  test("concurrent prepared executions keep independent parameter bindings", async () => {
    const { database, close } = await fixture();

    try {
      const query = prepare({ minimum: int, increment: int }, (parameters) =>
        database.records((records) => ({
          value: records.id.plus(parameters.increment),
          $where: records.id.is(parameters.minimum),
        })),
      );
      const rows = await Promise.all(
        Array.from({ length: 50 }, (_unused, position) =>
          query.execute({ minimum: (position % 4) + 1, increment: position }),
        ),
      );
      expect(rows).toEqual(
        Array.from({ length: 50 }, (_unused, position) => [
          { value: (position % 4) + 1 + position },
        ]),
      );
    } finally {
      await close();
    }
  });
};
