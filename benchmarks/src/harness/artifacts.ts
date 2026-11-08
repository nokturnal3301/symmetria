import { mkdir, rename, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { cpus, totalmem, release } from "node:os";
import { Glob, SQL } from "bun";
import { DATASET_VERSION, type RunConfig } from "../config";
import { type Library } from "../adapters";
import { digest, type Timing, type Throughput } from "./measure";
import { type Scenario } from "./workload";

export type Result = {
  sequential: Timing;
  concurrent?: Throughput;
  statementsPerOperation: number | null;
};
export type WorkerResult = {
  library: Library;
  name: string;
  pass: number;
  importMs: number;
  results: Partial<Record<Scenario, Result>>;
};
export type Manifest = {
  version: 1;
  id: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  config: RunConfig;
  libraries: Library[];
  orders: Library[][];
  dataset?: Record<string, { rows: number; hash: string }>;
  environment: Awaited<ReturnType<typeof provenance>>;
  files: Record<string, string>;
};

export const json = (value: unknown): string =>
  JSON.stringify(
    value,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ) + "\n";

export const writeJson = async (
  path: string,
  value: unknown,
): Promise<void> => {
  await Bun.write(`${path}.tmp`, json(value));
  await rename(`${path}.tmp`, path);
};

export const hashFiles = async (
  directory: string,
  pattern = "**/*",
): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};

  for (const path of Array.from(
    new Glob(pattern).scanSync({ cwd: directory, onlyFiles: true }),
  ).sort()) {
    files[path] = digest(await Bun.file(join(directory, path)).text());
  }

  return files;
};

export const saveSource = async (
  directory: string,
  files: Record<string, string>,
): Promise<void> => {
  for (const [file, hash] of Object.entries(files)) {
    const content = await Bun.file(join("..", file)).text();

    if (digest(content) !== hash) {
      throw new Error(`source changed during setup: ${file}`);
    }

    const destination = join(directory, "source", file);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, content);
  }
};

export const sourceFiles = async (
  root: string,
): Promise<Record<string, string>> => {
  const source: Record<string, string> = {};

  // Bun.Glob does not expand brace alternatives. Keep patterns explicit.
  for (const pattern of [
    "packages/runtime/src/**/*",
    "packages/kit/src/**/*",
    "benchmarks/*.json",
    "benchmarks/bun.lock",
    "benchmarks/docker/**/*",
    "benchmarks/src/**/*",
    "benchmarks/fixtures/**/*",
    "tsconfig.json",
  ]) {
    Object.assign(source, await hashFiles(root, pattern));
  }

  for (const required of [
    "packages/runtime/src/index.ts",
    "packages/kit/src/index.ts",
    "benchmarks/src/workers/measure.ts",
    "benchmarks/bun.lock",
    "benchmarks/fixtures/schema.prisma",
    "tsconfig.json",
  ]) {
    assert.ok(source[required], `missing source provenance: ${required}`);
  }

  return Object.fromEntries(
    Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
  );
};

export const provenance = async (sql: SQL) => {
  const sorted = await sourceFiles("..");
  const versions: Record<string, string> = {};

  for (const name of [
    "drizzle-orm",
    "kysely",
    "@prisma/client",
    "@prisma/adapter-pg",
    "pg",
  ]) {
    versions[name] = (
      await Bun.file(`node_modules/${name}/package.json`).json()
    ).version;
  }

  const read = async (path: string) =>
    readFile(path, "utf8")
      .then((value) => value.trim())
      .catch(() => null);

  return {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    kernel: release(),
    cpu: cpus()[0]?.model,
    visibleCpus: cpus().length,
    visibleMemoryBytes: totalmem(),
    cgroup: {
      cpuMax: await read("/sys/fs/cgroup/cpu.max"),
      memoryMax: await read("/sys/fs/cgroup/memory.max"),
    },
    host: process.env.BENCH_HOST_PROVENANCE
      ? JSON.parse(process.env.BENCH_HOST_PROVENANCE)
      : null,
    postgres: (await sql.unsafe("SELECT version() AS version"))[0].version,
    settings: Array.from(
      await sql.unsafe<
        { name: string; setting: string; unit: string | null }[]
      >(
        "SELECT name, setting, unit FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes', 'shared_buffers', 'max_connections', 'max_parallel_workers_per_gather', 'jit', 'track_io_timing', 'shared_preload_libraries', 'random_page_cost', 'effective_cache_size', 'work_mem') ORDER BY name",
      ),
    ),
    systemPackages:
      process.platform === "linux"
        ? Bun.spawnSync(["dpkg-query", "-W", "-f=${Package}=${Version}\n"])
            .stdout.toString()
            .trim()
        : null,
    datasetVersion: DATASET_VERSION,
    versions,
    sourceHash: digest(json(sorted)),
    sourceFiles: sorted,
  };
};

export const createRun = async (
  root: string,
): Promise<{ id: string; directory: string }> => {
  await mkdir(root, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const directory = join(root, id);
  await mkdir(directory); // Never merge with an existing run.

  return { id, directory };
};
