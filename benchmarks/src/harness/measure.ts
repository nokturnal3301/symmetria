import { createHash } from "node:crypto";

export type Timing = {
  iterations: number;
  elapsedMs: number;
  opsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number | null;
  samplesMs: number[];
};

export const percentile = (
  sorted: readonly number[],
  fraction: number,
): number => {
  if (!sorted.length || fraction < 0 || fraction > 1) {
    throw new Error("percentile needs samples and a fraction in [0, 1]");
  }

  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
};

export const median = (values: readonly number[]): number => {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error("median needs finite samples");
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export const timing = (
  samplesMs: number[],
  elapsedMs: number,
  batch = 1,
): Timing => {
  if (
    !samplesMs.length ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    samplesMs.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error("invalid timing samples");
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);

  return {
    iterations: samplesMs.length * batch,
    elapsedMs,
    opsPerSecond: (samplesMs.length * batch * 1000) / elapsedMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    // Sparse tails are misleading; raw samples remain available for inspection.
    p99Ms: samplesMs.length >= 1000 ? percentile(sorted, 0.99) : null,
    samplesMs,
  };
};

export const sequential = async (
  invoke: () => unknown,
  milliseconds: number,
  minimumSamples: number,
  fixedCount?: number,
): Promise<Timing> => {
  const samples: number[] = [];
  const started = performance.now();

  while (
    fixedCount === undefined
      ? performance.now() - started < milliseconds ||
        samples.length < minimumSamples
      : samples.length < fixedCount
  ) {
    const began = performance.now();
    await invoke();
    samples.push(performance.now() - began);
  }

  return timing(samples, performance.now() - started);
};

export type Throughput = {
  iterations: number;
  elapsedMs: number;
  opsPerSecond: number;
  perWorker: number[];
};

export const concurrent = async (
  operations: (() => unknown)[],
  milliseconds: number,
  fixedCount?: number,
): Promise<Throughput> => {
  const started = performance.now();
  const deadline = started + milliseconds;
  const perWorker = await Promise.all(
    operations.map(async (invoke) => {
      let count = 0;

      while (
        fixedCount === undefined
          ? performance.now() < deadline
          : count < fixedCount
      ) {
        await invoke();
        count++;
      }

      return count;
    }),
  );
  const elapsedMs = performance.now() - started;
  const iterations = perWorker.reduce((sum, count) => sum + count, 0);

  return {
    iterations,
    elapsedMs,
    opsPerSecond: (iterations * 1000) / elapsedMs,
    perWorker,
  };
};

export const compileTiming = (
  invoke: () => unknown,
  milliseconds: number,
): Timing => {
  const samples: number[] = [];
  const batch = 100;
  let sink: unknown;
  const started = performance.now();

  while (performance.now() - started < milliseconds) {
    const began = performance.now();

    for (let index = 0; index < batch; index++) {
      sink = invoke();
    }

    samples.push((performance.now() - began) / batch);
  }

  if (!sink) {
    throw new Error("compiler returned no SQL");
  }

  return timing(samples, performance.now() - started, batch);
};

export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
