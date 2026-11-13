import { expect, test } from "bun:test";
import {
  explainLines,
  inspectValue,
  wrapExplainLines,
} from "../../../packages/kit/src/cli/screens/query-inspector";
import { profilerHttpError } from "../../../packages/kit/src/cli/screens/profiler";

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
