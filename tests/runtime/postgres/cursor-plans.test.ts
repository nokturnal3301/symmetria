import { describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  timestamptz,
  index,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import { SCHEMA_BIND } from "../../../packages/runtime/src/driver";
import { testDatabase } from "../../../packages/kit/src/testing";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "cursor index plans",
  () => {
    test("late single and compound cursor pages seek into indexes without discarding earlier rows", async () => {
      const model = schema({
        posts: table({ id: int, createdAt: timestamptz }).indexes((posts) => ({
          chronological: index(posts.createdAt, posts.id),
        })),
      });
      const fixture = await testDatabase({
        url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
        schema: model,
        max: 1,
      });
      let captured: CompiledQuery | undefined;
      const database = model[SCHEMA_BIND]({
        ...fixture.driver,
        execute: async (query) => {
          captured = query;

          return fixture.driver.execute(query);
        },
      });

      try {
        await fixture.driver.execute({
          sql: "INSERT INTO posts (id, created_at) SELECT position, '2026-01-01T00:00:00Z'::timestamptz + (position / 10) * interval '1 microsecond' FROM generate_series(1, 25000) position",
          parameters: [],
        });
        await fixture.driver.execute({
          sql: "VACUUM ANALYZE posts",
          parameters: [],
        });

        for (const ascending of [true, false]) {
          for (const composite of [false, true]) {
            const query = database.posts((posts) => ({
              id: posts.id,
              $orderBy: composite
                ? ascending
                  ? [posts.createdAt.ascending, posts.id.ascending]
                  : [posts.createdAt.descending, posts.id.descending]
                : ascending
                  ? posts.id.ascending
                  : posts.id.descending,
            }));
            const first = await query.page({ size: 24000 });
            expect(first.nextCursor).not.toBeNull();
            const second = await query.page({
              size: 20,
              after: first.nextCursor,
            });
            expect(second.items.map(({ id }) => id)).toEqual(
              Array.from({ length: 20 }, (_unused, position) =>
                ascending ? 24001 + position : 1000 - position,
              ),
            );
            const compiled = captured!;
            const result = await fixture.driver.execute({
              ...compiled,
              sql: `EXPLAIN (ANALYZE, FORMAT JSON) ${compiled.sql}`,
            });
            const rows = Array.isArray(result) ? result : result.rows;
            const scans: Record<string, unknown>[] = [];

            const visit = (node: Record<string, unknown>): void => {
              if (String(node["Node Type"]).includes("Scan")) {
                scans.push(node);
              }

              (node.Plans as Record<string, unknown>[] | undefined)?.forEach(
                visit,
              );
            };

            visit(
              (
                rows[0]!["QUERY PLAN"] as { Plan: Record<string, unknown> }[]
              )[0]!.Plan,
            );
            expect(scans).toHaveLength(1);
            expect(scans[0]!["Index Cond"]).toBeString();
            expect(scans[0]!["Rows Removed by Filter"] ?? 0).toBe(0);
            expect(scans[0]!["Actual Rows"]).toBe(21);
          }
        }
      } finally {
        await fixture.close();
      }
    });
  },
);
