import { cloneParameter } from "../query/codecs";
import { planStrategy } from "../query/dialects/registry";
import { compileQuery, executeCompiled } from "../query/compiler";
import {
  normalizeResult,
  type QueryExecutor,
  type SelectPlan,
} from "../query/state";

export type InspectQueryOptions = {
  readonly interactive?: boolean;
  readonly color?: boolean;
  readonly execute?: boolean;
  readonly explain?: boolean | "analyze";
};
export type QueryInspection<
  Row extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly compileMs: number;
  results?: { rows: Row[]; durationMs: number };
  explanation?: {
    plan: Record<string, unknown>[];
    analyzed: boolean;
    durationMs: number;
  };
};

/** UI and scripted inspection share execution, decoding, and EXPLAIN semantics. */
export const createQueryInspection = (
  plan: SelectPlan,
  executor?: QueryExecutor,
) => {
  const started = performance.now();
  const compiled = compileQuery(plan);
  const compileMs = performance.now() - started;
  const report: QueryInspection = {
    sql: compiled.sql,
    parameters: compiled.parameters.map(cloneParameter),
    compileMs,
  };

  const boundQuery = () => ({
    sql: compiled.sql,
    parameters: compiled.parameters.map(cloneParameter),
  });

  return {
    report,
    connected: !!executor,
    execute: async () => {
      const started = performance.now();
      const result = await executeCompiled(plan, boundQuery(), executor);
      report.results = {
        rows: result.rows,
        durationMs: performance.now() - started,
      };
    },
    explain: async (analyze = false) => {
      if (!executor) {
        throw new Error(
          "symmetria: configure a query executor or driver before requesting EXPLAIN",
        );
      }

      const query = boundQuery();
      const started = performance.now();
      const statement = planStrategy(plan).explain(query.sql, analyze);
      const result = normalizeResult(
        await executor({ ...query, sql: statement.sql }),
      );

      report.explanation = {
        plan: statement.plan(result.rows),
        analyzed: statement.analyzed,
        durationMs: performance.now() - started,
      };
    },
  };
};

export type QueryInspectionController = ReturnType<
  typeof createQueryInspection
>;

export const inspectQuery = async (
  plan: SelectPlan,
  executor?: QueryExecutor,
  options: InspectQueryOptions = {},
): Promise<QueryInspection> => {
  const inspection = createQueryInspection(plan, executor);

  if (options.execute) {
    await inspection.execute();
  }

  if (options.explain) {
    await inspection.explain(options.explain === "analyze");
  }

  const interactive =
    options.interactive ??
    (!!process.stdin.isTTY &&
      !!process.stdout.isTTY &&
      process.env.TERM !== "dumb");

  if (interactive) {
    const { inspectQueryScreen } = await import("symmetria-kit/inspect").catch(
      (cause: unknown) => {
        throw new Error(
          "symmetria: interactive inspection requires symmetria-kit; install it with bun add -d symmetria-kit",
          { cause },
        );
      },
    );
    await inspectQueryScreen(inspection, options.color);
  }

  return inspection.report;
};
