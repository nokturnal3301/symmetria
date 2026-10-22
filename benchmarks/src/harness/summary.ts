import type { Library } from "../adapters";
import type { Manifest, WorkerResult } from "./artifacts";
import { median } from "./measure";
import { SCENARIOS, applicable, type Scenario } from "./workload";

export type SummaryRow = {
  library: Library;
  name: string;
  p50Ms: number;
  p50MinMs: number;
  p50MaxMs: number;
  p50PassesMs: number[];
  p95Ms: number | null;
  p99Ms: number | null;
  samplesMin: number;
  samplesMax: number;
  sequentialOps: number;
  concurrentOps: number | null;
  concurrentMin: number | null;
  concurrentMax: number | null;
  concurrentPasses: number[];
  statements: number | null;
};
export type Summary = Record<Scenario, SummaryRow[]>;

/** Aggregate independent processes, never pool samples from different passes. */
export const summarize = (
  manifest: Pick<Manifest, "libraries">,
  runs: WorkerResult[],
): Summary =>
  Object.fromEntries(
    SCENARIOS.map((scenario) => [
      scenario,
      manifest.libraries
        .filter((library) => applicable(library, scenario))
        .map((library) => {
          const selected = runs
            .filter((run) => run.library === library)
            .sort((a, b) => a.pass - b.pass);
          const values = selected.map((run) => run.results[scenario]!);
          const p50 = values.map((value) => value.sequential.p50Ms);
          const samples = values.map(
            (value) => value.sequential.samplesMs.length,
          );
          const conc = values.flatMap((value) =>
            value.concurrent ? [value.concurrent.opsPerSecond] : [],
          );
          const p99 = values.map((value) => value.sequential.p99Ms);

          return {
            library,
            name: selected[0]!.name,
            p50Ms: median(p50),
            p50MinMs: Math.min(...p50),
            p50MaxMs: Math.max(...p50),
            p50PassesMs: p50,
            // With 32 bulk samples, p95 is effectively one of the two slowest calls.
            p95Ms:
              Math.min(...samples) >= 100
                ? median(values.map((value) => value.sequential.p95Ms))
                : null,
            p99Ms: p99.every((value) => value !== null)
              ? median(p99 as number[])
              : null,
            samplesMin: Math.min(...samples),
            samplesMax: Math.max(...samples),
            sequentialOps: median(
              values.map((value) => value.sequential.opsPerSecond),
            ),
            concurrentOps: conc.length ? median(conc) : null,
            concurrentMin: conc.length ? Math.min(...conc) : null,
            concurrentMax: conc.length ? Math.max(...conc) : null,
            concurrentPasses: conc,
            statements:
              scenario === "buildNested"
                ? null
                : median(values.map((value) => value.statementsPerOperation!)),
          } satisfies SummaryRow;
        }),
    ]),
  ) as Summary;
