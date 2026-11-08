/**
 * Query construction. The implementation lives in ./select/:
 * types (type-level API), scope (column views and plan helpers), registry
 * (tables and $scope), joins, shape (projection callbacks), context (relation
 * navigation and aggregates), query (handles), tables (per-table API),
 * projections (reusable RETURNING shapes), pagination and prepared queries.
 */
export * from "../expressions";
export type {
  CompiledQuery,
  QueryExecutor,
  Driver,
  ExecutionResult,
} from "../plan/types";
export { DEFAULT_VALUE as defaultValue } from "../plan/types";
export type {
  CallbackScope,
  Columns,
  ColumnSelection,
  Projection,
  ProjectionObject,
  ProjectionRow,
  PredicateList,
  InferShape,
  Query,
  QueryOptions,
  QueryTable,
  RootScope,
  RuntimeScope,
  ScopedColumn,
  ShapeControls,
  ShapeJoins,
  ShapeTools,
} from "./types";
export {
  countValue,
  createScope,
  initialPlan,
  readSelection,
  validateNode,
} from "./scope";
export { createQueryTables, type TableScopes } from "./tables";
