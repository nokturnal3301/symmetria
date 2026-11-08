import { describe, expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  oneOf,
  numeric,
  jsonb,
  prepare,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!url)("audit regressions on PostgreSQL", () => {
  test("enum CASE literals infer the physical type and nullable enum parameters bind", async () => {
    const model = schema({
      rows: {
        id: int,
        state: oneOf("open", "closed").nullable,
        doc: jsonb<unknown>().nullable.default(null),
      },
    });
    const fixture = await testDatabase({ url: url!, schema: model });
    const db = fixture.database;

    try {
      await db.rows.insert([
        { id: 1, state: "open" },
        { id: 2, state: "closed" },
        { id: 3, state: null },
      ]);
      expect(
        await db.rows(
          (r) => ({
            value: r.state.match({ open: r.state, closed: "closed" }),
          }),
          { orderBy: (r) => r.id.ascending },
        ),
      ).toEqual([{ value: "open" }, { value: "closed" }, { value: null }]);
      const query = prepare({ state: oneOf("open", "closed").nullable }, (p) =>
        db.rows((r) => ({ id: r.id }), { where: (r) => r.state.is(p.state) }),
      );
      expect(await query.execute({ state: "open" })).toEqual([{ id: 1 }]);
      expect(await query.execute({ state: null })).toEqual([{ id: 3 }]);
      expect(
        await db.rows(
          (r) => ({
            id: r.id,
          }),
          { where: (r) => r.doc.is(null), orderBy: (r) => r.id.ascending },
        ),
      ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } finally {
      await fixture.close();
    }
  });

  test("numeric cursors accept PostgreSQL's non-finite values", async () => {
    const model = schema({ rows: { id: int, n: numeric() } });
    const fixture = await testDatabase({ url: url!, schema: model });
    const db = fixture.database;

    try {
      await db.rows.insert(
        ["-Infinity", "0", "Infinity", "NaN", "NaN"].map((n, id) => ({
          id,
          n,
        })),
      );
      const query = db.rows(
        (r) => ({
          id: r.id,
          n: r.n,
        }),
        { orderBy: (r) => [r.n.ascending, r.id.ascending] },
      );
      const expected = await query;
      const rows: typeof expected = [];

      for await (const page of query.pages({ size: 1 })) {
        rows.push(...page.items);
      }

      expect(rows).toEqual(expected);
    } finally {
      await fixture.close();
    }
  });

  test("prepared scoped mutations preserve atomic rollback on PostgreSQL", async () => {
    const model = schema({ rows: { id: int, tenant: int, value: text } });
    const fixture = await testDatabase({ url: url!, schema: model });
    const db = fixture.database;

    try {
      await db.rows.insert({ id: 1, tenant: 2, value: "original" });
      const scoped = db.$scope({ rows: (r) => r.tenant.is(1) });
      const query = scoped.rows
        .insert([
          { id: 2, tenant: 1, value: "new" },
          { id: 1, tenant: 1, value: "changed" },
        ])
        .onConflict("id")
        .doUpdate("value")
        .prepare();
      await expect(query.execute()).rejects.toMatchObject({
        code: "SYMMETRIA_OUT_OF_SCOPE",
      });
      expect(await db.rows((r) => r)).toEqual([
        { id: 1, tenant: 2, value: "original" },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
