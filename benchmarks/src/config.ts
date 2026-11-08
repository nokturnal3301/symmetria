export const DATABASE_URL =
  process.env.BENCH_DATABASE_URL ??
  "postgres://bench:bench@127.0.0.1:55992/bench";
export const POOL_SIZE = 16;
export const USERS = 2_000;
export const POSTS = 40_000;
export const TAGS = 100;
export const DATASET_VERSION = 2;

export type RunConfig = {
  passes: number;
  sequentialMs: number;
  concurrentMs: number;
  minimumSamples: number;
  concurrency: number;
  orderSeed: number;
};

export const integer = (name: string, value: unknown, minimum = 1): number => {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }

  return number;
};

export const defaultConfig = (): RunConfig => ({
  passes: integer("passes", process.env.BENCH_PASSES ?? 3),
  sequentialMs: integer("BENCH_SEQ_MS", process.env.BENCH_SEQ_MS ?? 2000),
  concurrentMs: integer("BENCH_CONC_MS", process.env.BENCH_CONC_MS ?? 2000),
  minimumSamples: integer(
    "BENCH_MIN_SAMPLES",
    process.env.BENCH_MIN_SAMPLES ?? 100,
  ),
  concurrency: POOL_SIZE,
  orderSeed: 20261021,
});
