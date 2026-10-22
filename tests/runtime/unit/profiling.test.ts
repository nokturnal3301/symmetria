import { expect, test } from "bun:test";
import {
  createProfiler,
  schema,
  int,
  bigint,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import type { Driver } from "../../../packages/runtime/src/driver";

test("profiler isolates overlapping requests, captures phases and preserves decoded results", async () => {
  const profiler = createProfiler();
  const gate = Promise.withResolvers<void>();
  const driver: Driver = {
    execute: async (query) => {
      if (query.parameters[0] === 1) {
        await gate.promise;
      }

      return [{ id: query.parameters[0], amount: "9007199254740993" }];
    },
    close: async () => {},
  };
  const database = schema(
    { records: { id: int, amount: bigint } },
    { driver: profiler.driver(driver) },
  );
  const first = profiler.trace("first", () =>
    database.records
      .byId(1)((records) => ({ id: records.id, amount: records.amount }))
      .one(),
  );
  const second = await profiler.trace("second", () =>
    database.records
      .byId(2)((records) => ({ id: records.id, amount: records.amount }))
      .one(),
  );
  gate.resolve();
  expect(await first).toEqual({ id: 1, amount: 9007199254740993n });
  expect(second).toEqual({ id: 2, amount: 9007199254740993n });
  const requests = profiler.snapshot();
  expect(requests.map((entry) => entry.label)).toEqual(["second", "first"]);
  expect(requests[0]!.queries[0]!.parameters).toEqual([2]);
  expect(requests[1]!.queries[0]!.parameters).toEqual([1]);
  expect(
    requests.every(
      (entry) =>
        entry.buildMs > 0 &&
        entry.queries.length === 1 &&
        entry.queries[0]!.compileMs > 0 &&
        entry.queries[0]!.decodeMs >= 0,
    ),
  ).toBe(true);
  requests[0]!.queries.length = 0;
  expect(profiler.snapshot()[0]!.queries).toHaveLength(1);
});

test("profiler bounds history, records errors and never analyzes a query implicitly", async () => {
  const calls: CompiledQuery[] = [];
  const profiler = createProfiler({ capacity: 2 });
  const database = schema(
    { records: { id: int } },
    {
      driver: profiler.driver({
        execute: async (query) => {
          calls.push(query);

          if (query.sql.startsWith("EXPLAIN")) {
            return [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }];
          }

          if (query.parameters[0] === 3) {
            throw new Error("database failure");
          }

          return [{ id: query.parameters[0] }];
        },
        close: async () => {},
      }),
    },
  );
  await profiler.trace("one", () => database.records.byId(1).one());
  const expired = profiler.snapshot()[0]!.queries[0]!.id;
  await profiler.trace("two", () => database.records.byId(2).one());
  await expect(
    profiler.trace("three", () => database.records.byId(3).one()),
  ).rejects.toThrow("database failure");
  expect(profiler.snapshot().map((entry) => entry.label)).toEqual([
    "two",
    "three",
  ]);
  expect(profiler.snapshot()[1]!.queries[0]!.error).toBe("database failure");
  expect(calls).toHaveLength(3);
  await expect(profiler.explain(expired)).rejects.toThrow(/retained/);
  const queryId = profiler.snapshot()[0]!.queries[0]!.id;
  await profiler.explain(queryId);
  expect(calls.at(-1)!.sql).toStartWith("EXPLAIN (FORMAT JSON)");
  await profiler.explain(queryId, true);
  expect(calls.at(-1)!.sql).toStartWith(
    "EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)",
  );
});

test("profiler fetch wrapper and loopback endpoint expose request SQL", async () => {
  const profiler = createProfiler();
  const database = schema(
    { records: { id: int } },
    {
      driver: profiler.driver({
        execute: async () => [{ id: 1 }],
        close: async () => {},
      }),
    },
  );
  const handler = profiler.fetch(async () =>
    Response.json(
      await database.records((records) => ({ id: records.id })).execute(),
    ),
  );
  const response = await handler(
    new Request("http://localhost/records?limit=1"),
  );
  expect(await response.json()).toEqual([{ id: 1 }]);
  const server = profiler.serve({ port: 0 });

  try {
    const result = await fetch(new URL("/requests", server.url));
    const requests = (await result.json()) as ReturnType<
      typeof profiler.snapshot
    >;
    expect(requests[0]!.label).toBe("GET /records");
    expect(requests[0]!.queries[0]!.sql).toContain('FROM "records"');
  } finally {
    await server.stop(true);
  }
});
