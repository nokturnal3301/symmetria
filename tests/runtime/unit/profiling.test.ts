import { expect, test } from "bun:test";
import {
  createProfiler,
  schema,
  int,
  text,
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

test.each(["127.0.0.1", "::1"] as const)(
  "profiler on %s rejects rebinding, cross-origin requests and unauthenticated EXPLAIN",
  async (hostname) => {
    const calls: CompiledQuery[] = [];
    const profiler = createProfiler();
    const database = schema(
      { records: { id: int, password: text } },
      {
        driver: profiler.driver({
          execute: async (query) => {
            calls.push(query);

            return query.sql.startsWith("EXPLAIN")
              ? [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }]
              : [{ id: 1 }];
          },
          close: async () => {},
        }),
      },
    );
    await database.records((record) => ({
      id: record.id,
      $where: record.password.is("test-secret"),
    }));
    const server = profiler.serve({ hostname, port: 0 });

    try {
      const requestsUrl = new URL("/requests", server.url);
      const response = await fetch(requestsUrl);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(profiler.snapshot());
      expect(response.headers.get("cache-control")).toBe("no-store");
      const token = response.headers.get("x-symmetria-token");
      expect(token).toBeString();
      expect(token!.length).toBeGreaterThanOrEqual(32);
      const queryId = profiler.snapshot()[0]!.queries[0]!.id;
      const explainUrl = new URL(`/explain?id=${queryId}`, server.url);

      for (const headers of [
        { host: "attacker.example" },
        { host: `localhost.attacker.example:${server.port}` },
        { host: "127.0.0.1:1" },
        { origin: "http://attacker.example" },
        { origin: "null" },
        { origin: "http://localhost:1" },
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
      ]) {
        const rejected = await fetch(requestsUrl, { headers });
        expect(rejected.status, JSON.stringify(headers)).toBe(403);
        expect(await rejected.text()).not.toContain("test-secret");
        expect(rejected.headers.get("x-symmetria-token")).toBeNull();
        expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
        const post = await fetch(explainUrl, {
          method: "POST",
          headers: { ...headers, "x-symmetria-token": token! },
        });
        expect(post.status).toBe(403);
        await post.text();
      }

      for (const headers of [{}, { "x-symmetria-token": "wrong" }]) {
        const rejected = await fetch(explainUrl, { method: "POST", headers });
        expect(rejected.status).toBe(403);
        await rejected.text();
      }

      expect(calls).toHaveLength(1);
      const localhost = await fetch(requestsUrl, {
        headers: { host: `localhost:${server.port}` },
      });
      expect(localhost.status).toBe(200);
      await localhost.text();

      for (const analyze of [false, true]) {
        explainUrl.searchParams.set("analyze", String(analyze));
        const explained = await fetch(explainUrl, {
          method: "POST",
          headers: {
            "x-symmetria-token": token!,
            origin: server.url.origin,
            "sec-fetch-site": "same-origin",
          },
        });
        expect(explained.status).toBe(200);
        expect(await explained.json()).toEqual([
          { Plan: { "Node Type": "Result" } },
        ]);
        expect(calls.at(-1)!.sql).toStartWith(
          analyze
            ? "EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)"
            : "EXPLAIN (FORMAT JSON)",
        );
        expect(calls.at(-1)!.parameters).toEqual(["test-secret"]);
      }

      expect(calls).toHaveLength(3);
    } finally {
      await server.stop(true);
    }
  },
);

test("profiler request tokens belong to one HTTP listener", async () => {
  const profiler = createProfiler();
  const first = profiler.serve({ port: 0 });
  const second = profiler.serve({ port: 0 });

  try {
    const firstResponse = await fetch(new URL("/requests", first.url));
    const secondResponse = await fetch(new URL("/requests", second.url));
    const firstToken = firstResponse.headers.get("x-symmetria-token")!;
    const secondToken = secondResponse.headers.get("x-symmetria-token")!;
    await firstResponse.text();
    await secondResponse.text();
    expect(firstToken).not.toBe(secondToken);
    const rejected = await fetch(new URL("/explain?id=1", first.url), {
      method: "POST",
      headers: { "x-symmetria-token": secondToken },
    });
    expect(rejected.status).toBe(403);
    await rejected.text();
  } finally {
    await Promise.all([first.stop(true), second.stop(true)]);
  }
});

test("profiler rejects a non-loopback bind address at runtime", async () => {
  const profiler = createProfiler();
  let server: ReturnType<typeof profiler.serve> | undefined;

  try {
    expect(() => {
      server = profiler.serve({ hostname: "0.0.0.0" as "127.0.0.1", port: 0 });
    }).toThrow(/loopback/);
  } finally {
    await server?.stop(true);
  }
});
