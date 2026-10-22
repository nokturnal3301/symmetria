import type { QueryColumn, SelectedColumn } from "../query/expressions";
import type { TableSnapshot } from "./assembly";

export type ComputedCallback = (
  columns: Record<string, QueryColumn<unknown, string>>,
) => Record<string, SelectedColumn>;
/** Query-only expressions stay outside serializable migration snapshots. */
export const computedFields = new WeakMap<
  TableSnapshot,
  readonly ComputedCallback[]
>();
