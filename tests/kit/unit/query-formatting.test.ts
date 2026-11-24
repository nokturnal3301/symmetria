import { expect, test } from "bun:test";
import {
  explainLines,
  inspectValue,
  wrapExplainLines,
} from "../../../packages/kit/src/cli/screens/query-inspector";
import {
  profilerEndpoint,
  profilerHttpError,
  requestLines,
} from "../../../packages/kit/src/cli/screens/profiler";
import {
  formatError,
  terminalOutput,
  terminalText,
  theme,
} from "../../../packages/kit/src/cli/ui/style";
import { formatStatus } from "../../../packages/kit/src/cli/ui/format";
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

test("text from the database reaches a terminal without escape sequences", () => {
  // OSC 0 (window title), clear screen, an 8-bit CSI and a bare C1 OSC.
  const stored =
    "a\u001b]0;PWNED\u0007b\u001b[2Jc\u009b31md\u009d8;;x\u0007e\r\nf\tg";

  expect(terminalText(stored)).toBe("abcde\nf\tg");
  // Colon parameters, bidirectional overrides and isolates go too.
  expect(terminalText("x\u001b[38:5:196my")).toBe("xy");
  expect(terminalText("report\u202eexe.txt\u2066a\u2069")).toBe(
    "reportexe.txta",
  );
  expect(
    formatError(`symmetria: invalid input syntax: "${stored}"`),
  ).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  expect(
    formatError(`symmetria: invalid input syntax: "${stored}"`, true),
  ).not.toContain("PWNED\u0007");
  // The CLI's own colours stay; everything else goes, conceal included.
  const { style } = theme(true);
  const own = `${style("✓", "success")} ${style("ok", "selected")}`;
  expect(terminalOutput(`${own} ${stored}`)).toBe(`${own} abcde\nf\tg`);
  expect(terminalOutput("shown\u001b[8mHIDDEN\u001b[1m!")).toBe("shownHIDDEN!");
  // A name read from the database brings no colour of its own.
  expect(
    formatStatus(
      [{ id: "000001_x\u001b[38;2;0;0;0mhidden", status: "pending" }],
      true,
    ),
  ).not.toContain("38;2;0;0;0");

  const [label] = requestLines(
    {
      id: 1,
      label: "GET /notes?q=\u001b]0;PWNED\u0007",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      buildMs: 1,
      queries: [],
    },
    0,
    { width: 80, height: 10, style: (text: string) => text },
  );
  expect(label).toBe("GET /notes?q= · build 1.000 ms · total 1.000 ms");
});

test("the profiler endpoint keeps the path of --profile-url", () => {
  expect(profilerEndpoint("http://127.0.0.1:7331", "requests").href).toBe(
    "http://127.0.0.1:7331/requests",
  );
  expect(profilerEndpoint("http://host/prefix/", "requests").href).toBe(
    "http://host/prefix/requests",
  );
  expect(
    profilerEndpoint("http://host/prefix", "explain?id=3&analyze=false").href,
  ).toBe("http://host/prefix/explain?id=3&analyze=false");
  // The endpoint itself, as before.
  expect(
    profilerEndpoint("http://127.0.0.1:7331/requests", "requests").href,
  ).toBe("http://127.0.0.1:7331/requests");
  expect(
    profilerEndpoint("http://host/prefix/requests/", "explain?id=1").href,
  ).toBe("http://host/prefix/explain?id=1");
  expect(() => profilerEndpoint("not a url", "requests")).toThrow(
    'symmetria: invalid --profile-url "not a url"',
  );
});
