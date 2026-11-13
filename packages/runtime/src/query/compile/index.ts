/**
 * SQL compiler entry: turns a query plan into a compiled query (SQL, parameters, decoder) and executes it on a driver.
 */
import { createRowDecoder, cloneParameter } from "../codecs";
import { throwDataErrors } from "../codecs/deferred";
import { executorProfiling } from "../../observability/profiling";
import { postgresRenderer } from "./postgres/render";
import type {
  PlaceholderNode,
  PredicateDescription,
  ScopePredicate,
} from "../expressions";
import {
  normalizeResult,
  type CompiledQuery,
  type ExecutionResult,
  type MutationPlan,
  type QueryExecutor,
  type SelectPlan,
} from "../plan/types";
import { createCompilation, quoteIdentifier, type ScopeSlot } from "./state";
import { predicateSql } from "./predicates";
import { selectSql } from "./select";
import { mutationSql } from "./mutations";
import { collectCommonTables, withClause } from "./cte";

export { quoteIdentifier };

/** A compiled plan and where its $scope() filters landed; never handed to callers. */
export type CompiledStatement = CompiledQuery & {
  readonly scopes: readonly ScopeSlot[] | undefined;
};

type Placeholder = (node: PlaceholderNode) => unknown;

const compileStatement = (
  plan: SelectPlan | MutationPlan,
  placeholder?: Placeholder,
  scopeValues?: ReadonlyMap<ScopePredicate, PredicateDescription>,
): CompiledStatement => {
  const compilation = createCompilation(
    plan,
    postgresRenderer,
    placeholder,
    (query, outerBindings, jsonValues, jsonOutput) =>
      selectSql(compilation, query, outerBindings, jsonValues, jsonOutput),
    scopeValues,
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
    scopes: compilation.scopes,
  };
};

/** One $scope() result rendered where its slot sits, or undefined when it cannot be. */
const renderScope = (
  plan: SelectPlan | MutationPlan,
  slot: ScopeSlot,
  predicate: PredicateDescription,
  placeholder?: Placeholder,
): CompiledQuery | undefined => {
  const compilation = createCompilation(
    plan,
    postgresRenderer,
    placeholder,
    (query, outerBindings, jsonValues, jsonOutput) =>
      selectSql(compilation, query, outerBindings, jsonValues, jsonOutput),
  );

  // Numbering continues from the slot, so equal SQL means equal parameter positions.
  compilation.parameters.length = slot.start;

  for (const [binding, alias] of slot.aliases) {
    compilation.aliasNames.set(binding, alias);
  }

  try {
    return {
      sql: predicateSql(compilation, predicate, slot.bindings),
      parameters: compilation.parameters.slice(slot.start),
    };
  } catch {
    // Such as a CTE inside the filter: the full recompilation below handles it.
    return undefined;
  }
};

/**
 * `$scope()` callbacks may read a changing value (the current tenant), so a
 * compiled or prepared statement never reuses their values from build time:
 * every execution runs each callback again and binds its current values in
 * place. When a callback now produces different SQL, such as a longer IN list,
 * the statement is compiled again with the current results.
 */
export const currentScopes = (
  plan: SelectPlan | MutationPlan,
  statement: CompiledStatement,
  parameters: unknown[],
  placeholder?: Placeholder,
): CompiledQuery => {
  const values = new Map<ScopePredicate, PredicateDescription>();

  for (const slot of statement.scopes!) {
    const { description } = slot;

    if (!values.has(description)) {
      // A value the callback's codecs reject fails this execution.
      values.set(
        description,
        throwDataErrors(() => description.evaluate(description.binding)),
      );
    }
  }

  // Slots are recorded in rendering order; splice from the end so earlier
  // positions stay valid even if a nested filter is recorded before its parent.
  const slots = [...statement.scopes!].sort((a, b) => b.start - a.start);

  for (const slot of slots) {
    const rendered = renderScope(
      plan,
      slot,
      values.get(slot.description)!,
      placeholder,
    );

    if (!rendered || rendered.sql !== slot.sql) {
      const recompiled = compileStatement(plan, placeholder, values);

      return { sql: recompiled.sql, parameters: recompiled.parameters };
    }

    parameters.splice(
      slot.start,
      slot.end - slot.start,
      ...rendered.parameters,
    );
  }

  return { sql: statement.sql, parameters };
};

/** A plan compiled now, with the current values of its $scope() filters. */
export const compileQuery = (
  plan: SelectPlan | MutationPlan,
  placeholder?: Placeholder,
): CompiledQuery => {
  const statement = compileStatement(plan, placeholder);

  return statement.scopes
    ? currentScopes(plan, statement, statement.parameters.slice(), placeholder)
    : { sql: statement.sql, parameters: statement.parameters };
};

/** A plan compiled once with placeholders; bind it with currentScopes() per execution. */
export const compileTemplate = (
  plan: SelectPlan | MutationPlan,
  placeholder: Placeholder,
): CompiledStatement => compileStatement(plan, placeholder);

type CachedCompilation = CompiledStatement & {
  /** Object-backed parameters must be re-cloned for every caller. */
  readonly objects: boolean;
};

const compiledPlans = new WeakMap<
  SelectPlan | MutationPlan,
  CachedCompilation
>();

/**
 * Plans are frozen, so their SQL is compiled once; every call still receives a
 * detached parameters array, with $scope() values current at the call.
 */
export const compilePlan = (plan: SelectPlan | MutationPlan): CompiledQuery => {
  let cached = compiledPlans.get(plan);

  if (!cached) {
    const compiled = compileStatement(plan);

    cached = {
      ...compiled,
      objects: compiled.parameters.some(
        (value) => value !== null && typeof value === "object",
      ),
    };

    compiledPlans.set(plan, cached);
  }

  const parameters = cached.objects
    ? cached.parameters.map(cloneParameter)
    : cached.parameters.slice();

  return cached.scopes
    ? currentScopes(plan, cached, parameters)
    : { sql: cached.sql, parameters };
};

/** Compiles and runs a plan; a compilation error, such as a deferred data error, rejects. */
export const executePlan = (
  plan: SelectPlan | MutationPlan,
  executor?: QueryExecutor,
): Promise<ExecutionResult> => {
  const profile = executorProfiling(executor);
  const started = profile ? performance.now() : 0;
  let compiled: CompiledQuery;

  try {
    compiled = compilePlan(plan);
  } catch (error) {
    return Promise.reject(error);
  }

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
