import { expect, test } from "bun:test";
import {
  explainLines,
  inspectValue,
  wrapExplainLines,
} from "../../../packages/kit/src/cli/screens/query-inspector";
import {
  profilerHttpError,
  requestLines,
} from "../../../packages/kit/src/cli/screens/profiler";
import type { ProfiledRequest } from "../../../packages/runtime/src";

test("inspector formatting preserves bigint, nested values and plan tree diagnostics", () => {
  expect(
    inspectValue(
      {
        counter: 9007199254740993n,
        nested: [{ value: null }],
        date: new Date("2026-01-01"),
      },
      true,
    ),
  ).toContain("9007199254740993n");
  expect(inspectValue("\u001b[2Jhello")).not.toContain("\u001b");
  expect(
    explainLines([
      {
        Plan: {
          "Node Type": "Nested Loop",
          "Plan Rows": 3,
          "Total Cost": 8,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Relation Name": "users",
              "Index Name": "users_pkey",
              "Index Cond": "(id = 1)",
              "Actual Total Time": 0.02,
              "Actual Loops": 1,
            },
            { "Node Type": "Seq Scan", "Relation Name": "posts" },
          ],
        },
        "Execution Time": 0.4,
      },
    ]).join("\n"),
  ).toContain("├─ Index Scan users using users_pkey");
});

test("long plan lines wrap under their tree gutter", () => {
  const lines = explainLines([
    {
      Plan: {
        "Node Type": "Limit",
        "Plan Rows": 3,
        "Total Cost": 11.31,
        Plans: [
          {
            "Node Type": "Bitmap Heap Scan",
            "Relation Name":
              "customer_subscription_billing_adjustments_for_long_names",
            "Plan Rows": 4,
            "Total Cost": 12.66,
          },
          { "Node Type": "Seq Scan", "Relation Name": "users" },
        ],
      },
    },
  ]);

  expect(wrapExplainLines(lines, 48)).toEqual([
    "Limit · rows 3 · cost 11.31",
    "├─ Bitmap Heap Scan customer_subscription_bill",
    "│    ing_adjustments_for_long_names · rows 4 · c",
    "│    ost 12.66",
    "╰─ Seq Scan users · rows ? · cost ?",
  ]);
});

test("a rejected profiler token names the fix", () => {
  expect(profilerHttpError(403)).toContain("--profile-token");
  expect(profilerHttpError(500)).toBe("symmetria: profiler returned HTTP 500");
});

test("the profiler's request view shows why the request failed", () => {
  const view = {
    width: 80,
    height: 12,
    style: (text: string, tone: string) =>
      tone === "selected" || tone === "danger" ? `<${tone}>${text}` : text,
  };
  const request = (overrides: Partial<ProfiledRequest>): ProfiledRequest => ({
    id: 1,
    label: "POST /orders",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 12.5,
    buildMs: 0.25,
    queries: [],
    ...overrides,
  });
  const query = (id: number, error?: string) => ({
    id,
    kind: "select" as const,
    sql: "SELECT 1",
    parameters: [],
    compileMs: 0.1,
    databaseMs: 1.5,
    decodeMs: 0.2,
    rows: 3,
    ...(error ? { error } : {}),
  });

  // A request that failed before any query: the message, not an empty list.
  expect(
    requestLines(
      request({ error: "insufficient stock\u001b[2J for item 7" }),
      0,
      view,
    ),
  ).toEqual([
    "POST /orders · build 0.250 ms · total 12.500 ms",
    "<danger>Error: insufficient stock for item 7",
    "The request ran no queries before it failed.",
  ]);
  expect(requestLines(request({}), 0, view)).toEqual([
    "POST /orders · build 0.250 ms · total 12.500 ms",
    "The request ran no queries.",
  ]);

  // With queries the message sits between the timings and the list.
  const failed = requestLines(
    request({
      error: "duplicate key value violates unique constraint",
      queries: [query(1), query(2, "duplicate key")],
    }),
    1,
    view,
  );
  expect(failed.slice(0, 3)).toEqual([
    "POST /orders · build 0.250 ms · total 12.500 ms",
    "<danger>Error: duplicate key value violates unique constraint",
    "Query                       Compile       Database       Decode    Rows",
  ]);
  expect(failed[3]).toStartWith("  select    #1");
  expect(failed[4]).toStartWith("<selected>› select    #2");
  expect(failed[4]).toEndWith(" ERROR");

  // A long message wraps, and leaves room for the queries.
  const long = requestLines(
    request({ error: "x".repeat(400), queries: [query(1)] }),
    0,
    { ...view, width: 40, style: (text: string) => text },
  );
  expect(long.slice(1, 7)).toEqual([
    `Error: ${"x".repeat(33)}`,
    "x".repeat(40),
    "x".repeat(40),
    "x".repeat(40),
    "x".repeat(40),
    "…",
  ]);
  expect(long.at(-1)).toContain("#1");

  // The selected query stays in view when the list is longer than the screen.
  const scrolled = requestLines(
    request({ queries: Array.from({ length: 30 }, (_, id) => query(id + 1)) }),
    29,
    view,
  );
  expect(scrolled).toHaveLength(12);
  expect(scrolled.at(-1)).toStartWith("<selected>› select    #30");
});
