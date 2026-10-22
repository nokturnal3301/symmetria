import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalNested, exactInteger } from "./correctness";
import { timing, sequential, concurrent, digest } from "./measure";
import { validateRun } from "../report";
import { libraryOrder, operation, writeBudget } from "./workload";
import { LIBRARIES } from "../adapters";
import type { Bench, InsertRow } from "../adapters/types";
import { sourceFiles } from "./artifacts";
import { fileURLToPath } from "node:url";

describe("benchmark integrity", () => {
  test("source snapshot includes actual engine, adapter, schema and lockfile contents", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = await sourceFiles(root);

    for (const file of [
      "packages/runtime/src/query/compiler.ts",
      "packages/kit/src/index.ts",
      "benchmarks/src/adapters/symmetria.ts",
      "benchmarks/fixtures/schema.prisma",
      "benchmarks/bun.lock",
      "benchmarks/docker/compose.yaml",
    ]) {
      expect(files[file]).toBe(digest(await Bun.file(join(root, file)).text()));
    }

    expect(
      Object.keys(files).some((file) => file.includes("node_modules")),
    ).toBe(false);
    expect(Object.keys(files).some((file) => file.includes(".cache/"))).toBe(
      false,
    );
  });
  test("rejects already-rounded bigint values; canonicalizes only unspecified tag order", () => {
    expect(() => exactInteger(9007199254740993)).toThrow("unsafe integer");
    expect(exactInteger(9007199254740993n)).toBe("9007199254740993");
    const canonical = canonicalNested([
      {
        id: 2,
        name: "x",
        posts: [
          {
            title: "b",
            views: "9007199254740993",
            postTags: [{ tag: { label: "z" } }, { tag: { label: "a" } }],
          },
          { title: "a", views: 1n, tags: [] },
        ],
      },
    ]);
    expect(canonical[0]!.posts.map((post) => post.title)).toEqual(["b", "a"]);
    expect(canonical[0]!.posts[0]!.tags).toEqual(["a", "z"]);
    expect(() => canonicalNested([{ id: 1, posts: null }])).toThrow();
  });
  test("throughput uses wall time; sparse p99 is omitted", () => {
    expect(timing([1, 2, 3], 10).opsPerSecond).toBe(300);
    expect(timing([1, 2, 3], 10).p99Ms).toBeNull();
    expect(timing(Array(1000).fill(1), 1500).p99Ms).toBe(1);
  });
  test("fixed budgets are exact and worker errors propagate", async () => {
    let count = 0;
    const seq = await sequential(() => count++, 1000, 100, 7);
    expect(seq.iterations).toBe(7);
    const conc = await concurrent([() => count++, () => count++], 1000, 5);
    expect(conc.perWorker).toEqual([5, 5]);
    expect(count).toBe(17);
    await expect(
      concurrent(
        [
          () => {
            throw new Error("broken");
          },
        ],
        1,
      ),
    ).rejects.toThrow("broken");
  });
  test("write inputs are deterministic, disjoint across workers and exactly budgeted", async () => {
    const rows: InsertRow[] = [];
    const bench = {
      insertMany: async (batch: InsertRow[]) => {
        rows.push(...batch);
      },
    } as unknown as Bench;
    const count = writeBudget("insertMany500", true);

    for (let worker = 0; worker < 16; worker++) {
      const invoke = operation(bench, "insertMany500", worker, count);

      for (let i = 0; i < count; i++) {
        await invoke();
      }
    }

    expect(rows.length).toBe(32000);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(rows.length);
    expect(libraryOrder(LIBRARIES, 0, 10)).toEqual(
      libraryOrder(LIBRARIES, 0, 10),
    );
    expect(libraryOrder(LIBRARIES, 1, 10)).not.toEqual(
      libraryOrder(LIBRARIES, 0, 10),
    );
  });
  test("report rejects failed, missing and tampered artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symmetria-bench-test-"));

    try {
      const manifest = {
        version: 1,
        status: "failed",
        files: {},
        libraries: ["raw"],
        orders: [["raw"]],
        config: { passes: 1 },
      };
      await Bun.write(
        join(directory, "manifest.json"),
        JSON.stringify(manifest),
      );
      await expect(validateRun(directory)).rejects.toThrow("incomplete");
      manifest.status = "complete";
      await Bun.write(
        join(directory, "manifest.json"),
        JSON.stringify(manifest),
      );
      await expect(validateRun(directory)).rejects.toThrow(
        "missing correctness",
      );
      await Bun.write(join(directory, "artifact.json"), "changed");
      manifest.files = { "artifact.json": digest("original") };
      await Bun.write(
        join(directory, "manifest.json"),
        JSON.stringify(manifest),
      );
      await expect(validateRun(directory)).rejects.toThrow("artifact changed");
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
