import { expect, test } from "bun:test";
import { summarize } from "./summary";
import { timing } from "./measure";
import type { WorkerResult } from "./artifacts";
import { SCENARIOS } from "./workload";
import { assertPublishable } from "../publish";
import { LIBRARIES } from "../adapters";
import type { Manifest } from "./artifacts";

test("process medians have equal weight, sparse tails stay hidden and all passes survive", () => {
  const runs: WorkerResult[] = [
    { value: 1, samples: 1000 },
    { value: 3, samples: 32 },
    { value: 100, samples: 32 },
  ].map(({ value, samples }, pass) => ({
    library: "symmetria",
    name: "Symmetria",
    pass,
    importMs: 0,
    results: Object.fromEntries(
      SCENARIOS.map((scenario) => [
        scenario,
        {
          sequential: timing(Array(samples).fill(value), samples * value),
          statementsPerOperation: scenario === "buildNested" ? null : 1,
        },
      ]),
    ),
  }));
  const summary = summarize({ libraries: ["symmetria"] }, runs.reverse());
  const row = summary.insertMany500[0]!;
  expect(row.p50Ms).toBe(3);
  expect(row.p50MinMs).toBe(1);
  expect(row.p50MaxMs).toBe(100);
  expect(row.p50PassesMs).toEqual([1, 3, 100]);
  expect(row.p95Ms).toBeNull();
  expect(row.p99Ms).toBeNull();
  expect(row.samplesMin).toBe(32);
  expect(row.samplesMax).toBe(1000);
  expect(summary.buildNested[0]!.concurrentOps).toBeNull();
  expect(summary.buildNested[0]!.statements).toBeNull();
});

test("publication rejects shortened, subset and non-durable comparisons", () => {
  const manifest = {
    libraries: [...LIBRARIES],
    config: {
      passes: 3,
      sequentialMs: 2000,
      concurrentMs: 2000,
      minimumSamples: 100,
      concurrency: 16,
      orderSeed: 123,
    },
    environment: {
      platform: "linux",
      cgroup: { cpuMax: "200000 100000", memoryMax: "2147483648" },
      host: {
        images: { runner: "runner-digest", postgres: "postgres-digest" },
        databaseLimits: { cpuNano: 2_000_000_000, memoryBytes: 2_147_483_648 },
      },
      settings: ["fsync", "synchronous_commit", "full_page_writes"].map(
        (name) => ({ name, setting: "on", unit: null }),
      ),
    },
  } as Manifest;
  expect(() => assertPublishable(manifest)).not.toThrow();
  expect(() =>
    assertPublishable({ ...manifest, libraries: ["symmetria", "kysely"] }),
  ).toThrow("every adapter");
  expect(() =>
    assertPublishable({
      ...manifest,
      config: { ...manifest.config, passes: 1 },
    }),
  ).toThrow("not publishable");
  expect(() =>
    assertPublishable({
      ...manifest,
      config: { ...manifest.config, sequentialMs: 50 },
    }),
  ).toThrow("not publishable");
  manifest.environment.settings[0]!.setting = "off";
  expect(() => assertPublishable(manifest)).toThrow("fsync must be on");
});
