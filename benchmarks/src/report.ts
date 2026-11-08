import assert from "node:assert/strict";
import { join } from "node:path";
import { digest, timing } from "./harness/measure";
import { LIBRARIES } from "./adapters";
import {
  SCENARIOS,
  applicable,
  writes,
  writeBudget,
  type Scenario,
} from "./harness/workload";
import { summarize } from "./harness/summary";
import { markdown, chart } from "./render/report";
import {
  writeJson,
  json,
  type Manifest,
  type WorkerResult,
  type Result,
} from "./harness/artifacts";

export const validateRun = async (
  directory: string,
): Promise<{ manifest: Manifest; runs: WorkerResult[] }> => {
  const manifest: Manifest = await Bun.file(
    join(directory, "manifest.json"),
  ).json();
  assert.equal(manifest.version, 1);
  assert.equal(
    manifest.status,
    "complete",
    "refusing to report an incomplete run",
  );
  assert.ok(
    Number.isSafeInteger(manifest.config.passes) && manifest.config.passes > 0,
  );
  assert.ok(
    manifest.libraries.length > 0 &&
      new Set(manifest.libraries).size === manifest.libraries.length,
  );
  assert.ok(manifest.libraries.every((library) => LIBRARIES.includes(library)));
  assert.equal(manifest.orders.length, manifest.config.passes);

  for (const order of manifest.orders) {
    assert.deepEqual([...order].sort(), [...manifest.libraries].sort());
  }

  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.ok(!file.includes("..") && !file.startsWith("/"));
    assert.equal(
      digest(await Bun.file(join(directory, file)).text()),
      hash,
      `artifact changed: ${file}`,
    );
  }

  const runs: WorkerResult[] = [];

  for (const library of manifest.libraries) {
    for (const prefix of ["correctness", "plans"]) {
      assert.ok(
        manifest.files[`${prefix}-${library}.json`],
        `missing ${prefix} for ${library}`,
      );
    }

    const gate = await Bun.file(
      join(directory, `correctness-${library}.json`),
    ).json();
    assert.equal(gate.library, library);
    assert.ok(gate.assertions >= 25);
    const plans = await Bun.file(
      join(directory, `plans-${library}.json`),
    ).json();

    for (const scenario of SCENARIOS.filter(
      (scenario) => applicable(library, scenario) && scenario !== "buildNested",
    )) {
      assert.ok(
        Array.isArray(plans[scenario]) && plans[scenario].length > 0,
        `missing SQL capture: ${library}/${scenario}`,
      );

      for (const statement of plans[scenario]) {
        assert.ok(
          typeof statement.sql === "string" &&
            statement.sql.length > 0 &&
            Array.isArray(statement.parameters),
        );

        if (!writes(scenario)) {
          assert.ok(
            statement.plan?.length,
            `missing read plan: ${library}/${scenario}`,
          );
        }
      }
    }

    for (let pass = 0; pass < manifest.config.passes; pass++) {
      const file = `pass-${pass}-${library}.json`;
      assert.ok(manifest.files[file], `missing ${file}`);
      const run: WorkerResult = await Bun.file(join(directory, file)).json();
      assert.equal(run.library, library);
      assert.equal(run.pass, pass);
      assert.deepEqual(
        Object.keys(run.results).sort(),
        SCENARIOS.filter((scenario) => applicable(library, scenario)).sort(),
      );

      for (const [scenario, result] of Object.entries(run.results) as [
        Scenario,
        Result,
      ][]) {
        const seq = result.sequential;
        assert.ok(
          seq.samplesMs.length > 0 &&
            seq.samplesMs.every((n) => Number.isFinite(n) && n >= 0),
        );
        assert.ok(
          Number.isFinite(seq.opsPerSecond) &&
            seq.opsPerSecond > 0 &&
            seq.elapsedMs > 0,
        );
        assert.equal(
          seq.iterations,
          seq.samplesMs.length * (scenario === "buildNested" ? 100 : 1),
        );
        assert.deepEqual(
          seq,
          timing(
            seq.samplesMs,
            seq.elapsedMs,
            scenario === "buildNested" ? 100 : 1,
          ),
          "timing summaries must match raw samples",
        );

        if (writes(scenario)) {
          assert.equal(
            seq.iterations,
            writeBudget(scenario, false),
            "wrong write budget",
          );
        } else {
          assert.ok(
            seq.elapsedMs >= manifest.config.sequentialMs,
            "read/build phase shorter than configured",
          );

          if (scenario !== "buildNested") {
            assert.ok(
              seq.iterations >= manifest.config.minimumSamples,
              "too few read samples",
            );
          }
        }

        if (scenario !== "buildNested") {
          assert.ok(
            result.concurrent &&
              result.concurrent.perWorker.length ===
                manifest.config.concurrency,
          );
          assert.ok(
            Number.isFinite(result.concurrent.opsPerSecond) &&
              result.concurrent.opsPerSecond > 0,
          );
          assert.equal(
            result.concurrent.iterations,
            result.concurrent.perWorker.reduce((sum, count) => sum + count, 0),
          );
          assert.equal(
            result.concurrent.opsPerSecond,
            (result.concurrent.iterations * 1000) / result.concurrent.elapsedMs,
          );
          assert.ok(
            result.concurrent.perWorker.every(
              (count) => Number.isSafeInteger(count) && count >= 0,
            ),
          );

          if (writes(scenario)) {
            assert.ok(
              result.concurrent.perWorker.every(
                (count) => count === writeBudget(scenario, true),
              ),
              "wrong concurrent write budget",
            );
          } else {
            assert.ok(
              result.concurrent.elapsedMs >= manifest.config.concurrentMs,
              "concurrent phase shorter than configured",
            );
          }

          assert.ok(
            result.statementsPerOperation !== null &&
              result.statementsPerOperation >= 1,
          );
        }
      }

      runs.push(run);
    }
  }

  const source = manifest.environment.sourceFiles;
  assert.ok(
    source["packages/runtime/src/index.ts"] &&
      (source["benchmarks/src/workers/measure.ts"] ||
        source["benchmarks/bench.ts"]),
    "missing measured source",
  );
  assert.equal(manifest.environment.sourceHash, digest(json(source)));

  for (const [file, hash] of Object.entries(source)) {
    assert.equal(
      manifest.files[`source/${file}`],
      hash,
      `missing source snapshot: ${file}`,
    );
  }

  return { manifest, runs };
};

export const report = async (directory: string): Promise<void> => {
  const { manifest, runs } = await validateRun(directory);
  const summary = summarize(manifest, runs);
  await Bun.write(
    join(directory, "REPORT.md"),
    markdown(manifest, summary, { standalone: true }),
  );
  await Bun.write(join(directory, "chart.svg"), chart(manifest, summary));
  await writeJson(join(directory, "summary.json"), summary);
};

if (import.meta.main) {
  if (!process.argv[2]) {
    throw new Error("usage: bun run report .cache/runs/<run-id>");
  }

  await report(process.argv[2]);
}
