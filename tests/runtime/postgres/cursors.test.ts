import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  customType,
  createDatabase,
} from "../../../packages/runtime/src";
import { postgres } from "../../../packages/runtime/src/driver";
import { createSchemaSQL } from "../../../packages/kit/src";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("compound-key cursors with lossy codecs", () => {
  const driver = postgres({
    url: databaseUrl ?? "postgres://localhost/postgres",
    max: 1,
  });
  const namespace = `symmetria_cursors_${crypto.randomUUID().replaceAll("-", "")}`;
  const score = customType<number>("integer", {
    encode: (value) => value * 10,
    decode: (value) => Math.floor(Number(value) / 10),
  });
  const model = schema({
    records: table({
      tenantId: int,
      sequence: int,
      score: score.nullable,
    }).primaryKey((records) => [records.tenantId, records.sequence]),
  });
  const database = createDatabase({ schema: model, driver });

  const run = (sql: string) => driver.execute({ sql, parameters: [] });

  beforeAll(async () => {
    await run(`CREATE SCHEMA "${namespace}"`);
    await run(`SET search_path TO "${namespace}"`);

    for (const statement of createSchemaSQL(model.$snapshot())) {
      await driver.execute(statement);
    }

    // Distinct storage values deliberately decode to the same application value.
    await run(
      "INSERT INTO records (tenant_id, sequence, score) VALUES (1, 1, 11), (1, 2, 12), (2, 1, 12), (2, 2, 21), (3, 1, NULL), (3, 2, NULL)",
    );
  });

  afterAll(async () => {
    try {
      await run(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await driver.close();
    }
  });

  test("pages preserve storage ordering across nulls, decoded ties and compound keys", async () => {
    for (const ascending of [true, false]) {
      const query = database.records((records) => ({
        tenantId: records.tenantId,
        sequence: records.sequence,
        score: records.score,
        $orderBy: [
          ascending
            ? records.score.ascending.nullsFirst
            : records.score.descending.nullsLast,
          records.tenantId.ascending,
          records.sequence.descending,
        ],
      }));
      const items: {
        tenantId: number;
        sequence: number;
        score: number | null;
      }[] = [];
      let after: Awaited<ReturnType<typeof query.page>>["nextCursor"] = null;

      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const page = await query.page({ size: 2, after });
        items.push(...page.items);
        after = page.nextCursor;

        if (!after) {
          break;
        }
      }

      expect(after).toBeNull();
      expect(items.map((row) => `${row.tenantId}:${row.sequence}`)).toEqual(
        ascending
          ? ["3:2", "3:1", "1:1", "1:2", "2:1", "2:2"]
          : ["2:2", "1:2", "2:1", "1:1", "3:2", "3:1"],
      );
      expect(items.filter((row) => row.score === 1)).toHaveLength(3);
    }
  });

  test("a partial compound key cannot establish a unique cursor ordering", async () => {
    await expect(
      database
        .records((records) => ({
          tenantId: records.tenantId,
          sequence: records.sequence,
          $orderBy: records.tenantId.ascending,
        }))
        .page({ size: 2 }),
    ).rejects.toThrow(/complete primary key/);
  });
});
