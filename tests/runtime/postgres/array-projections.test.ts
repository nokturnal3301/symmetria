import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  numeric,
  coalesce,
  prepare,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../../packages/kit/src/testing";

const model = schema({
  parents: { id: int },
  items: ({ parents }) => ({
    id: int,
    parent: parents,
    scores: bigint.array.nullable,
    amounts: numeric(30, 10).array.nullable,
    labels: text.array,
  }),
});
const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
const preciseValues = {
  scores: [9007199254740993n, -9007199254740995n],
  amounts: ["123456789012345.1234567890", "-0.0000000001"],
  labels: ['quoted"', "back\\slash"],
};
const expected = [
  { id: 1, ...preciseValues },
  { id: 2, scores: [], amounts: [], labels: [] },
  { id: 3, scores: null, amounts: null, labels: [] },
  {
    id: 4,
    scores: [9007199254740997n, null],
    amounts: ["987654321098765.9876543210", null],
    labels: [],
  },
];

describe.skipIf(!databaseUrl)("precision-preserving array projections", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl ?? "postgres://localhost/postgres",
      schema: model,
      prefix: "symmetria_array_projection",
    });
    database = isolated.database;
    await database.parents.insert([{ id: 1 }, { id: 2 }]);
    await database.items.insert([
      {
        id: 1,
        parentId: 1,
        ...preciseValues,
      },
      { id: 2, parentId: 1, scores: [], amounts: [], labels: [] },
      { id: 3, parentId: 1, scores: null, amounts: null, labels: [] },
    ]);
    // Database-native NULL elements can also arrive from outside the typed API.
    await isolated.driver.execute({
      sql: `INSERT INTO items (id, parent_id, scores, amounts, labels)
        VALUES (4, 1, ARRAY[9007199254740997::bigint, NULL],
          ARRAY[987654321098765.9876543210::numeric, NULL], ARRAY[]::text[])`,
      parameters: [],
    });
  });

  afterAll(async () => {
    await isolated.close();
  });

  test("nested objects retain exact array elements, null arrays and empty arrays", async () => {
    const query = database.items((items) => ({
      payload: {
        id: items.id,
        scores: items.scores,
        amounts: items.amounts,
        labels: items.labels,
      },
    }));
    expect<unknown>(
      await query((items) => ({ $orderBy: items.id.ascending })),
    ).toEqual(expected.map((payload) => ({ payload })));
    expect<unknown>(
      (await query((items) => ({ $distinct: true }))).sort(
        (left, right) => left.payload.id - right.payload.id,
      ),
    ).toEqual(expected.map((payload) => ({ payload })));
  });

  test("relation collections retain exact arrays through terminal JSON and CTE JSONB", async () => {
    const query = database.parents((parents) => ({
      id: parents.id,
      items: parents.items((items) => ({
        id: items.id,
        scores: items.scores,
        amounts: items.amounts,
        labels: items.labels,
        $orderBy: items.id.ascending,
      })),
      $orderBy: parents.id.ascending,
    }));
    const rows = [
      { id: 1, items: expected },
      { id: 2, items: [] },
    ];
    expect<unknown>(await query).toEqual(rows);
    expect<unknown>(
      await query.cte("collections")((collections) => ({
        id: collections.id,
        items: collections.items,
        $orderBy: collections.id.ascending,
      })),
    ).toEqual(rows);
  });

  test("array codecs survive expressions, derived sources, preparation and RETURNING", async () => {
    const source = database
      .items((items) => ({
        id: items.id,
        scores: coalesce(items.scores, []),
        amounts: coalesce(items.amounts, []),
      }))
      .as("values");
    const query = prepare({ id: int }, (parameters) =>
      source((values) => ({
        payload: { scores: values.scores, amounts: values.amounts },
        $where: values.id.is(parameters.id),
      })),
    );
    expect(await query.execute({ id: 1 })).toEqual([
      {
        payload: {
          scores: preciseValues.scores,
          amounts: preciseValues.amounts,
        },
      },
    ]);
    expect(await query.execute({ id: 3 })).toEqual([
      { payload: { scores: [], amounts: [] } },
    ]);
    expect(
      await database.items
        .update((items) => ({ id: items.id }))
        .where((items) => items.id.is(1))
        .returning((items) => ({
          payload: { scores: items.scores, amounts: items.amounts },
        })),
    ).toEqual([
      {
        payload: {
          scores: preciseValues.scores,
          amounts: preciseValues.amounts,
        },
      },
    ]);
  });
});
