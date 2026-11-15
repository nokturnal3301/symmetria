/**
 * Where an open `$batch()` collects its reads. Kept apart from the batch
 * itself so the compiler entry can look an executor up without importing it.
 */
import type { ExecutionResult, QueryExecutor, SelectPlan } from "./types";

export type BatchCollector = {
  /** The read's result once the batch has run, or undefined when it cannot join the batch. */
  readonly add: (plan: SelectPlan) => Promise<ExecutionResult> | undefined;
};

export const batchCollectors = new WeakMap<QueryExecutor, BatchCollector>();
