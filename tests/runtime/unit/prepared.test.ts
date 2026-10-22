import { expect, test } from "bun:test";
import {
  schema,
  prepare,
  int,
  text,
  bigint,
  jsonb,
  timestamptz,
  customType,
  and,
  sql,
  type CompiledQuery,
  type Parameter,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

test("prepared factories run once and retain result inference, codecs and parameter order", async () => {
  let builds = 0;
  const calls: CompiledQuery[] = [];
  const database = schema(
    { records: { id: int, name: text, visits: bigint } },
    {
      executor: async (query) => {
        calls.push(query);

        return [
          { id: query.parameters[0], name: "Ada", visits: "9007199254740993" },
        ];
      },
    },
  );
  const lookup = prepare(
    { id: int, minimum: bigint, size: int },
    (parameters) => {
      builds++;

      return database.records((records) => ({
        id: records.id,
        name: records.name,
        visits: records.visits,
        $where: and(
          records.id.is(parameters.id),
          records.visits.above(parameters.minimum),
        ),
        $limit: parameters.size,
      }));
    },
  );
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof lookup.execute>>,
      { id: number; name: string; visits: bigint }[]
    >
  >;
  expect(lookup.toSQL({ id: 1, minimum: 3n, size: 10 }).parameters).toEqual([
    1,
    "3",
    10,
  ]);
  expect(await lookup.execute({ id: 2, minimum: 4n, size: 20 })).toEqual([
    { id: 2, name: "Ada", visits: 9007199254740993n },
  ]);
  await lookup.execute({ id: 3, minimum: 5n, size: 30 });
  expect(calls[0]?.sql).toBe(calls[1]?.sql);
  expect(calls[1]?.parameters).toEqual([3, "5", 30]);
  expect(builds).toBe(1);
  expect(() => lookup.toSQL({ id: 1, minimum: 0n, size: -1 })).toThrow(
    /nonnegative/,
  );
  expect(() => lookup.toSQL({ id: 1, minimum: 0n } as never)).toThrow(
    /exactly/,
  );
  expect(() =>
    lookup.toSQL({ id: 1, minimum: 0n, size: 1, extra: 2 } as never),
  ).toThrow(/exactly/);
  expect(() =>
    lookup.toSQL({ id: undefined, minimum: 0n, size: 1 } as never),
  ).toThrow(/undefined/);
  expect(() =>
    lookup.toSQL({ id: null, minimum: 0n, size: 1 } as never),
  ).toThrow(/null/);
});

test("prepared mutations encode JSON, Dates and custom values without retaining caller objects", async () => {
  const amount = customType<{ cents: bigint }>("bigint", {
    encode: (value) => value.cents.toString(),
    decode: (value) => ({ cents: BigInt(String(value)) }),
  });
  const calls: CompiledQuery[] = [];
  const database = schema(
    {
      records: {
        id: int.auto,
        details: jsonb<{ tags: string[] }>(),
        createdAt: timestamptz,
        amount,
      },
    },
    {
      executor: async (query) => {
        calls.push(query);

        return { rows: [{ id: 1, amount: "123" }], affectedRows: 1 };
      },
    },
  );
  const insert = prepare(
    { details: jsonb<{ tags: string[] }>(), createdAt: timestamptz, amount },
    (parameters) =>
      database.records
        .insert(parameters)
        .returning((records) => [records.id, records.amount]),
  );
  const values = {
    details: { tags: ["sql"] },
    createdAt: new Date("2026-01-01"),
    amount: { cents: 123n },
  };
  const compiled = insert.toSQL(values);
  expect(compiled.sql).toContain("::text::jsonb");
  expect(compiled.parameters).toEqual([
    '{"tags":["sql"]}',
    new Date("2026-01-01"),
    "123",
  ]);
  values.details.tags.push("bun");
  values.createdAt.setUTCFullYear(2027);
  expect(compiled.parameters[0]).toBe('{"tags":["sql"]}');
  expect(compiled.parameters[1]).toEqual(new Date("2026-01-01"));
  expect(await insert.execute(values)).toEqual({
    id: 1,
    amount: { cents: 123n },
  });
  const remove = prepare({ id: int }, (parameters) =>
    database.records.delete().where((records) => records.id.is(parameters.id)),
  );
  type Removed = Assert<
    Equal<Awaited<ReturnType<typeof remove.execute>>, { affectedRows: number }>
  >;
  expect(await remove.execute({ id: 1 })).toEqual({ affectedRows: 1 });
});

test("static prepared queries return detached parameters and use their original executor", async () => {
  const database = schema(
    { records: { id: int, name: text } },
    { executor: async () => [{ id: 1 }] },
  );
  const prepared = database
    .records((records) => ({ id: records.id, $where: records.name.is("Ada") }))
    .prepare();
  const compiled = prepared.toSQL();
  compiled.parameters[0] = "modified";
  expect(prepared.toSQL().parameters).toEqual(["Ada"]);
  expect(await prepared.execute()).toEqual([{ id: 1 }]);
});

test("prepared subqueries share parameter numbering and reject escaped scopes", () => {
  const database = schema({ records: { id: int, name: text.nullable } });
  const lookup = prepare({ minimum: int, name: text.nullable }, (parameters) =>
    database.records((records) => ({
      id: records.id,
      label: sql<string | null>`${parameters.name}`.as("label"),
      $where: records.id.in(
        database.records.as("nested")((nested) => ({
          id: nested.id,
          $where: nested.id.above(parameters.minimum),
        })),
      ),
    })),
  );
  expect(lookup.toSQL({ minimum: 5, name: null }).parameters).toEqual([
    null,
    5,
  ]);
  let escaped: Parameter<number>;
  prepare({ id: int }, (parameters) => {
    escaped = parameters.id;

    return database.records((records) => ({
      id: records.id,
      $where: records.id.is(parameters.id),
    }));
  });
  expect(() =>
    prepare({ id: int }, () =>
      database.records((records) => ({
        id: records.id,
        $where: records.id.is(escaped),
      })),
    ),
  ).toThrow(/another prepare/);
  expect(() =>
    database
      .records((records) => ({
        id: records.id,
        $where: records.id.is(escaped),
      }))
      .toSQL(),
  ).toThrow(/bind parameter/);
});
