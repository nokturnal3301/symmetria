/**
 * SQL compiler entry: turns a query plan into a compiled query (SQL, parameters, decoder) and executes it on a driver.
 */
import { createRowDecoder, cloneParameter } from "../codecs";
import { executorProfiling } from "../../observability/profiling";
import { postgresRenderer } from "./postgres/render";
import type { PlaceholderNode } from "../expressions";
import {
  normalizeResult,
  type CompiledQuery,
  type ExecutionResult,
  type MutationPlan,
  type QueryExecutor,
  type SelectPlan,
} from "../plan/types";
import { createCompilation, quoteIdentifier } from "./state";
import { selectSql } from "./select";
import { mutationSql } from "./mutations";
import { collectCommonTables, withClause } from "./cte";

export { quoteIdentifier };

export const compileQuery = (
  plan: SelectPlan | MutationPlan,
  placeholder?: (node: PlaceholderNode) => unknown,
): CompiledQuery => {
  const compilation = createCompilation(
    plan,
    postgresRenderer,
    placeholder,
    (query, outerBindings, jsonValues, jsonOutput) =>
      selectSql(compilation, query, outerBindings, jsonValues, jsonOutput),
  );

  collectCommonTables(compilation);

  const prologue = compilation.commonTables.size ? withClause(compilation) : "";
  const statement = `${prologue}${
    compilation.plan.kind === "select"
      ? selectSql(compilation, compilation.plan, {}, false, true)
      : mutationSql(compilation, compilation.plan)
  }`;

  return {
    sql: statement,
    parameters: compilation.parameters,
  };
};

type CachedCompilation = CompiledQuery & {
  /** Object-backed parameters must be re-cloned for every caller. */
  readonly objects: boolean;
};

const compiledPlans = new WeakMap<
  SelectPlan | MutationPlan,
  CachedCompilation
>();

/**
 * Plans are frozen, so their SQL is compiled once; every call still receives a
 * detached parameters array.
 */
export const compilePlan = (plan: SelectPlan | MutationPlan): CompiledQuery => {
  let cached = compiledPlans.get(plan);

  if (!cached) {
    const compiled = compileQuery(plan);

    cached = {
      sql: compiled.sql,
      parameters: compiled.parameters,
      objects: compiled.parameters.some(
        (value) => value !== null && typeof value === "object",
      ),
    };

    compiledPlans.set(plan, cached);
  }

  return {
    sql: cached.sql,
    parameters: cached.objects
      ? cached.parameters.map(cloneParameter)
      : cached.parameters.slice(),
  };
};

export const executePlan = (
  plan: SelectPlan | MutationPlan,
  executor?: QueryExecutor,
): Promise<ExecutionResult> => {
  const profile = executorProfiling(executor);
  const started = profile ? performance.now() : 0;
  const compiled = compilePlan(plan);

  return executeCompiled(
    plan,
    compiled,
    executor,
    profile ? performance.now() - started : 0,
  );
};

export const executeCompiled = async (
  plan: SelectPlan | MutationPlan,
  compiled: CompiledQuery,
  executor?: QueryExecutor,
  compileMs = 0,
): Promise<ExecutionResult> => {
  if (!executor) {
    throw new Error(
      "symmetria: configure a query executor or driver before calling execute()",
    );
  }

  const profile = executorProfiling(executor);
  let decodeMs = 0;

  try {
    const result = normalizeResult(await executor(compiled));
    const started = profile ? performance.now() : 0;
    const rows = result.rows.map(rowDecoder(plan));
    decodeMs = profile ? performance.now() - started : 0;

    return {
      rows,
      affectedRows: result.affectedRows,
    };
  } finally {
    profile?.annotate(compiled, { kind: plan.kind, compileMs, decodeMs });
  }
};

const rowDecoders = new WeakMap<
  SelectPlan | MutationPlan,
  ReturnType<typeof createRowDecoder>
>();

/** The cached row decoder of a plan, shared by execute() and stream(). */
export const rowDecoder = (
  plan: SelectPlan | MutationPlan,
): ReturnType<typeof createRowDecoder> => {
  let decode = rowDecoders.get(plan);

  if (!decode) {
    decode = createRowDecoder(plan.selection);
    rowDecoders.set(plan, decode);
  }

  return decode;
};
