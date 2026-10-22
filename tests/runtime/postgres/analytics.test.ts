import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  sql,
  sum,
  over,
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  prepare,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../../packages/kit/src/testing";

const model = schema({
  entries: { id: int, team: text, parentId: int.nullable, amount: bigint },
});

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("CTEs and windows on PostgreSQL", () => {
  // testDatabase() creates an isolated schema and drops it on close().
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl ?? "postgres://localhost/postgres",
      schema: model,
      prefix: "symmetria_analytics",
      max: 1,
    });
    database = isolated.database;

    await database.entries
      .insert([
        { id: 1, team: "A", parentId: null, amount: 9007199254740993n },
        { id: 2, team: "A", parentId: 1, amount: 5n },
        { id: 3, team: "A", parentId: 2, amount: 5n },
        { id: 4, team: "B", parentId: null, amount: 9n },
      ])
      .execute();
  });

  afterAll(async () => {
    await isolated.close();
  });

  test("ranking, lag/lead and running totals preserve bigint and numeric precision", async () => {
    const rows = await database
      .entries((entries) => ({
        id: entries.id,
        position: rowNumber().over({
          partitionBy: [entries.team],
          orderBy: entries.id.ascending,
        }),
        ranking: rank().over({
          partitionBy: [entries.team],
          orderBy: entries.amount.descending,
        }),
        dense: denseRank().over({
          partitionBy: [entries.team],
          orderBy: entries.amount.descending,
        }),
        previous: lag(entries.amount).over({
          partitionBy: [entries.team],
          orderBy: entries.id.ascending,
        }),
        next: lead(entries.amount).over({
          partitionBy: [entries.team],
          orderBy: entries.id.ascending,
        }),
        running: over(sum(entries.amount), {
          partitionBy: [entries.team],
          orderBy: entries.id.ascending,
          rows: ["unbounded preceding", "current row"],
        }),
        $orderBy: entries.id.ascending,
      }))
      .execute();
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 1]);
    expect(rows.map((row) => row.ranking)).toEqual([1, 2, 2, 1]);
    expect(rows.map((row) => row.previous)).toEqual([
      null,
      9007199254740993n,
      5n,
      null,
    ]);
    expect(rows.map((row) => row.next)).toEqual([5n, 5n, null, null]);
    expect(rows.map((row) => row.running)).toEqual([
      "9007199254740993",
      "9007199254740998",
      "9007199254741003",
      "9",
    ]);
  });

  test("materialized CTEs filter window results and keep codecs through derived projections", async () => {
    const ranked = database
      .entries((entries) => ({
        id: entries.id,
        amount: entries.amount,
        position: rowNumber().over({
          partitionBy: [entries.team],
          orderBy: entries.id.ascending,
        }),
      }))
      .cte("ranked", { materialized: true });
    const rows = await ranked((ranked) => ({
      id: ranked.id,
      amount: ranked.amount,
      position: ranked.position,
      $where: ranked.position.is(1),
      $orderBy: ranked.id.ascending,
    })).execute();
    expect(rows).toEqual([
      { id: 1, amount: 9007199254740993n, position: 1 },
      { id: 4, amount: 9n, position: 1 },
    ]);
    const derived = ranked((ranked) => ({
      nested: { amount: ranked.amount },
    })).as("nested");
    expect(
      (await derived((nested) => ({ nested: nested.nested })).execute())[0],
    ).toEqual({
      nested: { amount: 9007199254740993n },
    });
  });

  test("recursive CTEs traverse trees and support prepared anchors", async () => {
    const query = prepare({ rootId: int }, (parameters) =>
      database
        .entries((entries) => ({
          id: entries.id,
          amount: entries.amount,
          depth: sql<number>`0::integer`,
          $where: entries.id.is(parameters.rootId),
        }))
        .recursive("tree", (tree) =>
          database.entries((entries, { innerJoin }) => {
            const treeRow = innerJoin(tree, (treeRow) =>
              entries.parentId.is(treeRow.id),
            );

            return {
              id: entries.id,
              amount: entries.amount,
              depth: treeRow.depth.plus(1),
            };
          }),
        )((tree) => ({
        id: tree.id,
        amount: tree.amount,
        depth: tree.depth,
        $orderBy: tree.id.ascending,
      })),
    );
    expect(query.toSQL({ rootId: 1 }).sql).toStartWith("WITH RECURSIVE");
    expect(query.toSQL({ rootId: 1 }).parameters).toEqual([1, 1]);
    expect(await query.execute({ rootId: 1 })).toEqual([
      { id: 1, amount: 9007199254740993n, depth: 0 },
      { id: 2, amount: 5n, depth: 1 },
      { id: 3, amount: 5n, depth: 2 },
    ]);
    expect(await query.execute({ rootId: 4 })).toEqual([
      { id: 4, amount: 9n, depth: 0 },
    ]);
  });
});
