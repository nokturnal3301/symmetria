import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  timestamptz,
  jsonb,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import { createQueryInspection } from "../../../packages/runtime/src/observability/inspection";
import { QUERY_PLAN } from "../../../packages/runtime/src/query/state";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

test("offline inspection returns bound SQL without execution and preserves result types", async () => {
  let executions = 0;
  const database = schema(
    { users: { id: int, name: text } },
    {
      executor: async () => {
        executions++;

        return [{ id: 1, name: "Ada" }];
      },
    },
  );
  const query = database.users.byId(1)((users) => ({ name: users.name }));
  const report = await query.inspect({ interactive: false });
  type Rows = Assert<
    Equal<NonNullable<typeof report.results>["rows"], { name: string }[]>
  >;
  expect(executions).toBe(0);
  expect(report.sql).toBe(query.toSQL().sql);
  expect(report.parameters).toEqual([1]);
  expect(report.compileMs).toBeGreaterThanOrEqual(0);
  const executed = await query.inspect({ interactive: false, execute: true });
  expect(executed.results?.rows).toEqual([{ name: "Ada" }]);
  expect(executions).toBe(1);
});

test("inspection decodes nested results and EXPLAIN retains placeholders and immutable parameters", async () => {
  const calls: CompiledQuery[] = [];
  const plan = [
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "users",
        "Plan Rows": 1,
        "Total Cost": 10,
      },
    },
  ];
  const database = schema(
    {
      users: { id: int, metadata: jsonb<{ filter: string }>() },
      posts: ({ users }) => ({
        id: int,
        author: users,
        views: bigint,
        createdAt: timestamptz,
      }),
    },
    {
      executor: async (query) => {
        calls.push(query);

        return query.sql.startsWith("EXPLAIN")
          ? [{ "QUERY PLAN": JSON.stringify(plan) }]
          : [
              {
                posts: [
                  {
                    views: "9007199254740993",
                    createdAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
              },
            ];
      },
    },
  );
  const query = database.users((users) => ({
    posts: users.posts((posts) => ({
      views: posts.views,
      createdAt: posts.createdAt,
    })),
    $where: users.metadata.contains({ filter: "hello" }),
  }));
  const report = await query.inspect({
    interactive: false,
    execute: true,
    explain: true,
  });
  expect(report.results?.rows).toEqual([
    {
      posts: [{ views: 9007199254740993n, createdAt: new Date("2026-01-01") }],
    },
  ]);
  expect(report.explanation?.plan).toEqual(plan);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.sql).toBe(`EXPLAIN (FORMAT JSON) ${query.toSQL().sql}`);
  expect(calls[1]!.parameters).toEqual(query.toSQL().parameters);
  await query.inspect({ interactive: false, explain: "analyze" });
  expect(calls[2]!.sql).toStartWith("EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)");
  const dated = database.posts((posts) => ({
    id: posts.id,
    $where: posts.createdAt.is(new Date("2026-01-01")),
  }));
  const inspection = createQueryInspection(dated[QUERY_PLAN], async (query) => {
    expect((query.parameters[0] as Date).getUTCFullYear()).toBe(2026);

    return [{ id: 1 }];
  });
  (inspection.report.parameters[0] as Date).setUTCFullYear(1999);
  await inspection.execute();
  expect(dated.toSQL().parameters).toEqual([new Date("2026-01-01")]);
});

test("inspection propagates driver errors, rejects malformed plans and works offline", async () => {
  const offline = schema({ users: { id: int } }).users((users) => ({
    id: users.id,
  }));
  expect((await offline.inspect({ interactive: false })).sql).toContain(
    "SELECT",
  );
  await expect(
    offline.inspect({ interactive: false, execute: true }),
  ).rejects.toThrow(/executor/);
  await expect(
    offline.inspect({ interactive: false, explain: true }),
  ).rejects.toThrow(/executor/);
  const broken = schema(
    { users: { id: int } },
    {
      executor: async () => {
        throw new Error("connection closed");
      },
    },
  ).users((users) => ({ id: users.id }));
  await expect(
    broken.inspect({ interactive: false, execute: true }),
  ).rejects.toThrow("connection closed");
  const malformed = schema(
    { users: { id: int } },
    { executor: async () => [] },
  ).users((users) => ({ id: users.id }));
  await expect(
    malformed.inspect({ interactive: false, explain: true }),
  ).rejects.toThrow(/JSON plan/);
});
