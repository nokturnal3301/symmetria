import { expect, test } from "bun:test";
import { createProfiler, int, schema } from "../../../packages/runtime/src";
import { sqlite } from "../../../packages/runtime/src/driver";
import { PREPARE_QUERY } from "../../../packages/runtime/src/query/prepared";

test("detached query construction methods retain their source", () => {
  const database = schema({ records: { id: int } });
  const query = database.records((record) => ({ id: record.id }));
  const { toSQL, as, cte, recursive, scalar, prepare } = query;
  const prepareQuery = query[PREPARE_QUERY];
  const expected = query.toSQL();

  expect(Object.isFrozen(query)).toBe(true);
  expect(toSQL).toBe(query.toSQL);
  expect(toSQL()).toEqual(expected);
  expect(prepare().toSQL()).toEqual(expected);
  expect(prepareQuery({}, []).toSQL({})).toEqual(expected);
  expect(as("derived")((row) => ({ id: row.id })).toSQL().sql).toContain(
    'AS "derived"',
  );
  expect(cte("selected")((row) => ({ id: row.id })).toSQL().sql).toStartWith(
    'WITH "selected"',
  );
  expect(
    recursive("walk", (self) => self((row) => ({ id: row.id })))((row) => ({
      id: row.id,
    })).toSQL().sql,
  ).toStartWith('WITH RECURSIVE "walk"');
  expect(database.records(() => ({ value: scalar() })).toSQL().sql).toContain(
    'AS "value"',
  );
  const { as: alias } = database.records;
  expect(alias("r")((row) => ({ id: row.id })).toSQL().sql).toContain(
    'FROM "records" AS "r"',
  );
});

for (const profiled of [false, true]) {
  test(`detached execution methods work with ${profiled ? "profiled" : "plain"} query handles`, async () => {
    const driver = sqlite(":memory:");
    const profiler = createProfiler();
    const database = schema(
      { records: { id: int } },
      {
        driver: profiled ? profiler.driver(driver) : driver,
      },
    );

    try {
      await driver.execute({
        sql: "CREATE TABLE records (id INTEGER PRIMARY KEY)",
        parameters: [],
      });
      await database.records.insert([{ id: 1 }, { id: 2 }]);
      await profiler.trace("detached", async () => {
        const query = database.records.byId(1);
        const { execute, then, one, maybeOne, first, inspect } = query;
        expect(await execute()).toEqual([{ id: 1 }]);
        expect(await then((rows) => rows)).toEqual([{ id: 1 }]);
        expect(await one()).toEqual({ id: 1 });
        expect(await maybeOne()).toEqual({ id: 1 });
        expect(await first()).toEqual({ id: 1 });
        expect((await inspect({ interactive: false })).sql).toBe(
          query.toSQL().sql,
        );
        expect(await Promise.resolve(query)).toEqual([{ id: 1 }]);

        const ordered = database.records((row) => ({
          id: row.id,
          $orderBy: row.id.ascending,
        }));
        const { page, pages } = ordered;
        expect((await page({ size: 1 })).items).toEqual([{ id: 1 }]);
        const ids: number[] = [];

        for await (const result of pages({ size: 1 })) {
          ids.push(...result.items.map((row) => row.id));
        }

        expect(ids).toEqual([1, 2]);
      });

      if (profiled) {
        expect(profiler.snapshot()[0]!.queries.length).toBeGreaterThan(0);
      }
    } finally {
      await driver.close();
    }
  });
}
