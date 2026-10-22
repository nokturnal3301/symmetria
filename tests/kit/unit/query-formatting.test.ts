import { expect, test } from "bun:test";
import {
  explainLines,
  inspectValue,
} from "../../../packages/kit/src/cli/query-inspect";

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
