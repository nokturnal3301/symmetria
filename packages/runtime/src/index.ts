/** Public runtime API: typed PostgreSQL schemas and queries for Node.js and Bun. */

export {
  uuid,
  text,
  int,
  bigint,
  bool,
  smallint,
  real,
  doublePrecision,
  date,
  time,
  timestamp,
  interval,
  bytea,
  inet,
  timestamptz,
  varchar,
  jsonb,
  oneOf,
  numeric,
  customType,
  tsvector,
  isColumn,
  type StandardSchema,
  type StandardOutput,
  type StandardInput,
  type Column,
  type ColumnMetadata,
  type ColumnDefinition,
  type Branded,
  type TsVector,
  type Vector,
  type NumericColumn,
  type VarcharColumn,
} from "./schema/column";

export type { Infer, InferInsert, InferUpdate } from "./schema/infer";
export {
  sqlState,
  databaseError,
  type DatabaseError,
  type DatabaseErrorKind,
} from "./driver/errors";

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
  type OnUpdateAction,
  type ConditionRelation,
  type RelationTools,
} from "./schema/table";

export {
  snakeCase,
  sqlKey,
  type Casing,
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
  searchDocument,
  sql,
  defaultValue,
} from "./query/select";

export type {
  Query,
  QueryColumn,
  ColumnTraits,
  SelectedColumn,
  Predicate,
  PredicateList,
  InferShape,
  Ordering,
  ShapeControls,
  QueryOptions,
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
  operatorClass,
  createIndexesSQL,
  type OperatorClassKey,
  type IndexStorageOptions,
  type IndexDefinition,
  type IndexSnapshot,
  type IndexMethod,
  type IndexQuery,
  type CreateIndexesOptions,
  type SchemaCondition,
} from "./schema/indexes";

export {
  IsolationLevel,
  type TransactionOptions,
  type RowLockOptions,
} from "./query/plan/types";

export { prepare, type PreparedQuery } from "./query/select/prepared";

export type {
  Parameter,
  SearchOptions,
  SearchMode,
  SearchWeight,
  SearchRankOptions,
  SearchHeadlineOptions,
  SearchDocumentOptions,
  SearchDocumentParts,
} from "./query/expressions";

export type { CheckSnapshot } from "./schema/checks";

export type {
  Page,
  PageCursor,
  PageOptions,
} from "./query/select/pagination";
export type { ReturningTools } from "./query/select/projections";

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
  type Decimal,
  type SkippedPredicate,
} from "./query/expressions";

export {
  createProfiler,
  type QueryProfiler,
  type ProfiledRequest,
  type ProfiledQuery,
} from "./observability/profiling";
