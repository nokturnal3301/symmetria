import { describe, expect, test } from "bun:test";
import {
  schema,
  int,
  numeric,
  minimum,
  maximum,
  sum,
  over,
  sql,
  prepare,
} from "../../../packages/runtime/src";
import { postgres as bun } from "../../../packages/runtime/src/entries/bun";
import { postgres as pg } from "../../../packages/runtime/src/entries/pg";
import { testDatabase } from "../../../packages/kit/src/testing";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!url)("PostgreSQL numeric parity across adapters", () => {
  test("exact ordering, pages, membership, aggregate windows and normalized writes", async () => {
    const model = schema({
      rows: { id: int, n: numeric(60, 8).nullable },
      defaults: { id: int, n: numeric(6, 2).unique.default(sql`'0.005'`) },
    });
    const fixture = await testDatabase({
      url: url!,
      schema: model,
      driver: bun,
    });
    const other = await testDatabase({ url: url!, schema: model, driver: pg });
    const local = other.database;
    let seed = 42;

    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);

    const values: (string | null)[] = [
      null,
      "0",
      "-0.0",
      ".000000005",
      "-.000000005",
      "9.999999999",
      "1e20",
      "-1e20",
      "9007199254740992",
      "9007199254740993",
      "NaN",
    ];

    for (let i = 0; i < 160; i++) {
      values.push(
        `${random() % 2 ? "-" : ""}${random()}${random()}.${random()}e${(random() % 15) - 7}`,
      );
    }

    try {
      const collect = async (db: typeof local) => {
        await db.rows.insert(values.map((n, id) => ({ id, n })));
        const stored = await db.rows(
          (r) => ({
            id: r.id,
            n: r.n,
          }),
          { orderBy: (r) => r.id.ascending },
        );
        const ascending = db.rows(
          (r) => ({
            id: r.id,
          }),
          { orderBy: (r) => [r.n.ascending, r.id.ascending] },
        );
        const ordered = await ascending;
        const pages: typeof ordered = [];

        for await (const page of ascending.pages({ size: 11 })) {
          pages.push(...page.items);
        }

        expect(pages).toEqual(ordered);
        const descending = await db.rows(
          (r) => ({
            id: r.id,
          }),
          { orderBy: (r) => [r.n.descending, r.id.ascending] },
        );
        const member = db.rows((r) => ({ n: r.n }), {
          where: (r) => r.id.below(10),
        });
        const membership = await db.rows(
          (r) => ({
            id: r.id,
          }),
          { where: (r) => r.n.in(member), orderBy: (r) => r.id.ascending },
        );
        const literalMembership = await db.rows(
          (r) => ({
            id: r.id,
          }),
          {
            where: (r) => r.n.in(["0.00", "9.007199254740993e15", "NaN"]),
            orderBy: (r) => r.id.ascending,
          },
        );
        const bounds = prepare({ n: numeric(60, 8).nullable }, (p) =>
          db.rows(
            (r) => ({
              id: r.id,
            }),
            { where: (r) => r.n.is(p.n), orderBy: (r) => r.id.ascending },
          ),
        );
        const equal = await Promise.all(
          [null, "0", "9007199254740993", "NaN"].map((n) =>
            bounds.execute({ n }),
          ),
        );
        const aggregate = await db.rows(
          (r) => ({
            min: minimum(r.n),
            max: maximum(r.n),
            total: sum(r.n),
          }),
          { where: (r) => r.n.isNot("NaN") },
        );
        const windows = await db.rows(
          (r) => ({
            id: r.id,
            min: over(minimum(r.n), {
              orderBy: r.id.ascending,
              rows: [{ preceding: 2 }, "current row"],
            }),
            max: over(maximum(r.n), {
              orderBy: r.id.ascending,
              rows: [{ preceding: 2 }, "current row"],
            }),
            total: over(sum(r.n), {
              orderBy: r.id.ascending,
              rows: [{ preceding: 2 }, "current row"],
            }),
          }),
          { orderBy: (r) => r.id.ascending },
        );
        await db.defaults.insert({ id: 1 });
        await expect(
          db.defaults.insert({ id: 2, n: "0.0100" }).execute(),
        ).rejects.toThrow();
        await db.defaults.update({ n: "-0.005" }).all();
        const defaults = await db.defaults((r) => r);
        await expect(
          db.defaults.update({ n: "9999.999" }).all().execute(),
        ).rejects.toThrow();

        return {
          stored,
          ordered,
          descending,
          membership,
          literalMembership,
          equal,
          aggregate,
          windows,
          defaults,
        };
      };

      expect(await collect(local)).toEqual(await collect(fixture.database));
    } finally {
      await other.close();
      await fixture.close();
    }
  });

  test("unbounded decimal keys and moving sums handle exponents, infinities and NaN", async () => {
    const model = schema({ rows: { id: int, n: numeric().nullable } });
    const fixture = await testDatabase({
      url: url!,
      schema: model,
      driver: bun,
    });
    const other = await testDatabase({ url: url!, schema: model, driver: pg });
    const local = other.database;
    const values = [
      null,
      "-Infinity",
      "-1e50",
      "-1.01",
      "-1",
      "-.00001",
      "0",
      "1e-20",
      "1",
      "1.01",
      "1e50",
      "Infinity",
      "NaN",
      "1",
      "2",
      null,
    ];

    try {
      const collect = async (db: typeof local) => {
        await db.rows.insert(values.map((n, id) => ({ id, n })));
        const order = await db.rows(
          (r) => ({
            id: r.id,
          }),
          { orderBy: (r) => [r.n.ascending, r.id.ascending] },
        );
        const windows = await db.rows(
          (r) => ({
            id: r.id,
            total: over(sum(r.n), {
              orderBy: r.id.ascending,
              rows: [{ preceding: 1 }, "current row"],
            }),
          }),
          { orderBy: (r) => r.id.ascending },
        );

        return {
          order,
          windows: windows.map((row) => ({
            ...row,
            total: row.total?.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""),
          })),
        };
      };

      expect(await collect(local)).toEqual(await collect(fixture.database));
    } finally {
      await other.close();
      await fixture.close();
    }
  });
});
