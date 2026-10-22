/** Public runtime API: typed PostgreSQL schemas and queries for Bun. */

export {
  uuid,
  text,
  int,
  bigint,
  bool,
  timestamptz,
  varchar,
  jsonb,
  oneOf,
  numeric,
  customType,
  isColumn,
  type StandardSchema,
  type StandardOutput,
  type Column,
  type ColumnMetadata,
  type ColumnDefinition,
  type Branded,
} from "./schema/column";

export {
  table,
  junction,
  self,
  isTable,
  TABLE,
  type Table,
  type TableHandle,
  type JunctionHandle,
  type TableIndexColumns,
  type ColumnInput,
  type ReferenceFlags,
  type OnDeleteAction,
} from "./schema/table";

export {
  snakeCase,
  type SchemaSnapshot,
  type TableSnapshot,
  type ColumnSnapshot,
  type RelationSnapshot,
} from "./schema/assembly";

export {
  schema,
  type Database,
  type TransactionDatabase,
  type Transaction,
  type SchemaOptions,
  type ScopeDefinitions,
  type Link,
  type Row,
  type Insert,
} from "./schema/model";

export {
  and,
  or,
  not,
  when,
  exists,
  notExists,
  count,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  sql,
  defaultValue,
} from "./query/select";

export type {
  Query,
  QueryColumn,
  SelectedColumn,
  Predicate,
  Ordering,
  ShapeControls,
  ShapeJoins,
  ShapeTools,
  CompiledQuery,
  QueryExecutor,
  ExecutionResult,
} from "./query/select";

export type { Codec } from "./query/codecs";

export { createDatabase, type DatabaseOptions } from "./schema/binding";

export {
  index,
  createIndexesSQL,
  type IndexDefinition,
  type IndexSnapshot,
  type IndexMethod,
  type IndexQuery,
  type CreateIndexesOptions,
} from "./schema/indexes";

export {
  IsolationLevel,
  type TransactionOptions,
  type RowLockOptions,
} from "./query/state";

export { prepare, type PreparedQuery } from "./query/prepared";

export type { Parameter, SearchOptions } from "./query/expressions";

export type { CheckSnapshot } from "./schema/checks";

export type { Page, PageCursor } from "./query/pagination";

export type {
  InspectQueryOptions,
  QueryInspection,
} from "./observability/inspection";

export {
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  over,
  type WindowOptions,
  type WindowBoundary,
  type WindowExpression,
} from "./query/expressions";

export {
  createProfiler,
  type QueryProfiler,
  type ProfiledRequest,
  type ProfiledQuery,
} from "./observability/profiling";
