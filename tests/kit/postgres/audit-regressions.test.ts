import { describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  oneOf,
  index,
  sql,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";
import { diffSchemas } from "../../../packages/kit/src";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!url)("migration audit regressions on PostgreSQL", () => {
  test("rename plus literal change installs the new CHECK definition", async () => {
    const before = schema({
      rows: table({ id: int, old: text }).checks((r) => ({
        matches: r.old.is('"old"'),
      })),
    });
    const after = schema({
      rows: table({ id: int, newer: text }).checks((r) => ({
        matches: r.newer.is('"newer"'),
      })),
    });
    const fixture = await testDatabase({ url: url!, schema: before });

    try {
      const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
        renames: { columns: { rows: { old: "newer" } } },
      });
      await fixture.driver.transaction!(async (tx) => {
        for (const statement of plan.up) {
          await tx.execute({ sql: statement, parameters: [] });
        }
      });
      await fixture.driver.execute({
        sql: "INSERT INTO rows (id, newer) VALUES (1, $1)",
        parameters: ['"newer"'],
      });
      await expect(
        fixture.driver.execute({
          sql: "INSERT INTO rows (id, newer) VALUES (2, $1)",
          parameters: ['"old"'],
        }),
      ).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  test("enum additions with raw defaults and partial indexes apply in one transaction", async () => {
    const before = schema({ jobs: { id: int, state: oneOf("ready", "done") } });
    const after = schema({
      jobs: table({
        id: int,
        state: oneOf("ready", "done", "error").default(sql`'error'`),
      }).indexes((r) => ({ errors: index(r.id).where(r.state.is.error) })),
    });
    const fixture = await testDatabase({ url: url!, schema: before });

    try {
      const plan = diffSchemas(before.$snapshot(), after.$snapshot());
      await fixture.driver.transaction!(async (tx) => {
        for (const statement of plan.up) {
          await tx.execute({ sql: statement, parameters: [] });
        }
      });
      const result = await fixture.driver.execute({
        sql: "INSERT INTO jobs (id) VALUES (1) RETURNING state",
        parameters: [],
      });
      expect(Array.isArray(result) ? result : result.rows).toEqual([
        { state: "error" },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
