import { expect } from "bun:test";
import { test, isolatedDriver } from "../../support/isolated-driver";
import { createProfiler, int, schema } from "../../../packages/runtime/src";

for (const profiled of [false, true]) {
  test(`detached execution methods work with ${profiled ? "profiled" : "plain"} query handles`, async () => {
    const driver = isolatedDriver();
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

        const ordered = database.records(
          (row) => ({
            id: row.id,
          }),
          { orderBy: (row) => row.id.ascending },
        );
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
