import { appendFileSync } from "node:fs";
import { createRowDecoder, cloneParameter } from "../codecs";
import { executorProfiling } from "../../observability/profiling";
import { planDialect } from "../dialect";
import { planStrategy } from "../dialects/registry";
import type { PlaceholderNode } from "../expressions";
import {
  normalizeResult,
  type CompiledQuery,
  type ExecutionResult,
  type MutationPlan,
  type QueryExecutor,
  type SelectPlan,
} from "../state";
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
    planStrategy(plan),
    placeholder,
    (query, outerBindings, jsonValues, jsonOutput) =>
      selectSql(compilation, query, outerBindings, jsonValues, jsonOutput),
  );

  // CTEs are collected first so WITH bodies are rendered, and numbered, first.
  collectCommonTables(compilation);
  const prologue = compilation.commonTables.size ? withClause(compilation) : "";
  const statement = `${prologue}${
    compilation.plan.kind === "select"
      ? selectSql(compilation, compilation.plan, {}, false, true)
      : mutationSql(compilation, compilation.plan)
  }`;

  if (compileLog) {
    recordCompilation(compileLog, plan, statement, compilation.parameters);
  }

  return { sql: statement, parameters: compilation.parameters };
};

/** Development aid: SYMMETRIA_COMPILE_LOG=<file> appends every compilation as JSON lines. */
const compileLog = process.env.SYMMETRIA_COMPILE_LOG;

const serializeParameter = (value: unknown): unknown => {
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }

  if (value === undefined) {
    return { $undefined: true };
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }

  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }

  if (Array.isArray(value)) {
    return value.map(serializeParameter);
  }

  if ((value as { kind?: unknown }).kind === "placeholder") {
    const node = value as PlaceholderNode;

    return { $placeholder: node.name, sqlType: node.sqlType };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      serializeParameter(entry),
    ]),
  );
};

const recordCompilation = (
  file: string,
  plan: SelectPlan | MutationPlan,
  sql: string,
  parameters: unknown[],
): void => {
  appendFileSync(
    file,
    `${JSON.stringify({
      kind: plan.kind,
      dialect: planDialect(plan),
      sql,
      parameters: parameters.map(serializeParameter),
    })}\n`,
  );
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
    let decode = rowDecoders.get(plan);

    if (!decode) {
      const decodeValues = createRowDecoder(plan.selection);
      const convert = planStrategy(plan).rowConverter(plan.selection);
      decode = convert ? (row) => decodeValues(convert(row)) : decodeValues;
      rowDecoders.set(plan, decode);
    }

    const rows = result.rows.map(decode);
    decodeMs = profile ? performance.now() - started : 0;

    return { rows, affectedRows: result.affectedRows };
  } finally {
    profile?.annotate(compiled, { kind: plan.kind, compileMs, decodeMs });
  }
};

const rowDecoders = new WeakMap<
  SelectPlan | MutationPlan,
  ReturnType<typeof createRowDecoder>
>();
