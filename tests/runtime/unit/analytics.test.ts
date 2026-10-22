import { expect, expectTypeOf, test } from "bun:test";
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

const model = schema({
  entries: { id: int, team: text, parentId: int.nullable, amount: bigint },
});

const ranked = model
  .entries((entries) => ({
    id: entries.id,
    amount: entries.amount,
    position: rowNumber().over({
      partitionBy: [entries.team],
      orderBy: [entries.amount.descending, entries.id.ascending],
    }),
    $where: entries.team.is("A"),
  }))
  .cte("ranked", { materialized: false });

test("CTEs retain types, parameter order and immutable query branches", () => {
  const query = ranked((ranked) => ({
    id: ranked.id,
    amount: ranked.amount,
    position: ranked.position,
    $where: ranked.position.atMost(2),
  }));
  expectTypeOf<Awaited<ReturnType<typeof query.execute>>>().toEqualTypeOf<
    { id: number; amount: bigint; position: number }[]
  >();
  expect(query.toSQL().parameters).toEqual(["A", 2]);
  expect(query.toSQL().sql).toStartWith('WITH "ranked" AS NOT MATERIALIZED');
  expect(query.toSQL().sql).toContain(
    'ROW_NUMBER() OVER (PARTITION BY "entries"."team" ORDER BY "entries"."amount" DESC, "entries"."id" ASC)',
  );
  expect(ranked((ranked) => ({ id: ranked.id })).toSQL().parameters).toEqual([
    "A",
  ]);
});

test("CTE dependencies are emitted once, conflicting names and escaped recursive references are rejected", () => {
  const first = model.entries((entries) => ({ id: entries.id })).cte("first");
  const second = first((first) => ({ id: first.id })).cte("second");
  const query = second((second, { innerJoin }) => {
    const firstRow = innerJoin(first, (firstRow) => second.id.is(firstRow.id));

    return { id: second.id };
  });
  expect(query.toSQL().sql.match(/"first" AS \(/g)).toHaveLength(1);
  expect(query.toSQL().sql.indexOf('"first" AS (')).toBeLessThan(
    query.toSQL().sql.indexOf('"second" AS ('),
  );
  const conflict = model
    .entries((entries) => ({ id: entries.id, $where: entries.id.is(3) }))
    .cte("first")
    .as("other");
  expect(() =>
    first((first, { innerJoin }) => {
      const other = innerJoin(conflict, (other) => first.id.is(other.id));

      return { id: first.id };
    }).toSQL(),
  ).toThrow(/duplicate CTE/);
  let escaped: { toSQL: () => unknown } | undefined;
  model
    .entries((entries) => ({ id: entries.id }))
    .recursive("tree", (tree) => {
      escaped = tree((tree) => ({ id: tree.id }));

      return tree((tree) => ({ id: tree.id }));
    });
  expect(() => escaped!.toSQL()).toThrow(/escaped/);
});

test("window parameters are bound, frames are validated and foreign-scope columns are rejected", () => {
  const query = prepare({ team: text }, (parameters) =>
    model.entries((entries) => ({
      previous: lag(entries.amount, 2, 0n).over({
        partitionBy: [entries.team],
        orderBy: entries.id.ascending,
        rows: [{ preceding: 3 }, "current row"],
      }),
      $where: entries.team.is(parameters.team),
    })),
  );
  expect(query.toSQL({ team: "A" }).parameters).toEqual([2, "0", 3, "A"]);
  expect(() =>
    rowNumber().over({ rows: ["unbounded following", "current row"] }),
  ).toThrow(/frame/);
  expect(() =>
    rowNumber().over({ rows: [{ preceding: -1 }, "current row"] }),
  ).toThrow(/offset/);
  const other = model.entries.as("other");
  let foreign: Parameters<typeof lag>[0] | undefined;
  other((other) =>
    (() => {
      foreign = other.id;

      return { id: other.id };
    })(),
  );
  expect(() =>
    model.entries((entries) => ({
      value: rowNumber().over({ partitionBy: [foreign!] }),
    })),
  ).toThrow(/scope/);
});
