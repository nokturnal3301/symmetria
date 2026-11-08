import { SQL } from "bun";
import { DATABASE_URL, type RunConfig } from "../config";
import { load, LIBRARIES, type Library } from "../adapters";
import { seed, assertDisposable } from "../seed";
import { sequential, concurrent, compileTiming } from "../harness/measure";
import {
  SCENARIOS,
  operation,
  writes,
  writeBudget,
  applicable,
} from "../harness/workload";
import { writeJson, type WorkerResult } from "../harness/artifacts";
import { statementCount } from "../harness/database";

const library = process.argv[2] as Library;

if (!LIBRARIES.includes(library)) {
  throw new Error("unknown library");
}

const pass = Number(process.argv[3]);
const destination = process.argv[4]!;
const config: RunConfig = JSON.parse(process.env.BENCH_CONFIG!);
const maintenance = new SQL(DATABASE_URL, { max: 1 });
const adminUrl = new URL(DATABASE_URL);
const databaseName = adminUrl.pathname.slice(1);
adminUrl.pathname = "/postgres";
const admin = new SQL(adminUrl.href, { max: 1 });
const started = performance.now();
const bench = await load(library);
const result: WorkerResult = {
  library,
  name: bench.name,
  pass,
  importMs: performance.now() - started,
  results: {},
};

try {
  await assertDisposable(maintenance);

  for (const scenario of SCENARIOS.filter((scenario) =>
    applicable(library, scenario),
  )) {
    if (scenario === "buildNested") {
      const invoke = operation(bench, scenario);

      for (let i = 0; i < 2000; i++) {
        invoke();
      }

      result.results[scenario] = {
        sequential: compileTiming(invoke, config.sequentialMs),
        statementsPerOperation: null,
      };
      continue;
    }

    // Warm both JIT and the full pool; warmup writes are discarded before timing.
    const warmup = writes(scenario) ? 2 : 8;
    await Promise.all(
      Array.from({ length: config.concurrency }, async (_, worker) => {
        const invoke = operation(bench, scenario, worker, warmup);

        for (let i = 0; i < warmup; i++) {
          await invoke();
        }
      }),
    );

    if (writes(scenario)) {
      await seed(maintenance);
    }

    const fixedSequential = writes(scenario)
      ? writeBudget(scenario, false)
      : undefined;
    const before = await statementCount(admin, databaseName);
    const seq = await sequential(
      operation(bench, scenario, 0, fixedSequential),
      config.sequentialMs,
      config.minimumSamples,
      fixedSequential,
    );
    const after = await statementCount(admin, databaseName);

    if (writes(scenario)) {
      await seed(maintenance);
    }

    const fixedConcurrent = writes(scenario)
      ? writeBudget(scenario, true)
      : undefined;
    const conc = await concurrent(
      Array.from({ length: config.concurrency }, (_, worker) =>
        operation(bench, scenario, worker, fixedConcurrent),
      ),
      config.concurrentMs,
      fixedConcurrent,
    );

    if (writes(scenario)) {
      await seed(maintenance);
    }

    result.results[scenario] = {
      sequential: seq,
      concurrent: conc,
      statementsPerOperation: (after - before) / seq.iterations,
    };
    console.log(
      `${library} pass ${pass + 1} ${scenario}: ${seq.p50Ms.toFixed(3)} ms; ${Math.round(conc.opsPerSecond)} ops/s`,
    );
  }

  await writeJson(destination, result);
} finally {
  await bench.close();
  await maintenance.close();
  await admin.close();
}
