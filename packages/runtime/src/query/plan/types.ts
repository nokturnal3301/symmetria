/**
 * Driver-neutral plan and executor contracts shared by the query builder, compiler and adapters.
 */
import type {
  ColumnSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "../../schema/assembly";
import type { RuntimeCodec } from "../codecs";
import type { DeferredError } from "../codecs/deferred";
import type {
  ExpressionDescription,
  PredicateDescription,
  ValueNode,
  PlaceholderNode,
} from "../expressions";

export const QUERY_PLAN = Symbol("symmetria.query.plan");
export const TABLE_SOURCE = Symbol("symmetria.query.source");
export const DEFAULT_VALUE = Symbol("symmetria.query.default");

export type CompiledQuery = { sql: string; parameters: unknown[] };
export type ExecutionResult = {
  rows: Record<string, unknown>[];
  affectedRows: number;
};
export type QueryExecutor = (
  query: CompiledQuery,
) => Promise<ExecutionResult | Record<string, unknown>[]>;
export const IsolationLevel = Object.freeze({
  ReadCommitted: "read committed",
  RepeatableRead: "repeatable read",
  Serializable: "serializable",
} as const);
export type IsolationLevel =
  (typeof IsolationLevel)[keyof typeof IsolationLevel];

export type TransactionOptions = {
  readonly isolationLevel?: IsolationLevel | undefined;
  readonly readOnly?: boolean | undefined;
  readonly deferrable?: boolean | undefined;
  /**
   * Re-run the callback after a serialization failure or deadlock (SQLSTATE
   * 40001 / 40P01), up to this many times. The callback must be safe to repeat.
   */
  readonly retries?: number | undefined;
  /** Base delay before a retry in milliseconds; doubles per attempt with full jitter (default 10). */
  readonly retryDelayMs?: number | undefined;
};
/** Reserves a connection for a multi-statement operation such as a cursor stream. */
export type ConnectionHold = <Result>(
  run: (execute: QueryExecutor) => Promise<Result>,
) => Promise<Result>;
export type TransactionDriver = {
  readonly execute: QueryExecutor;
  /** Nested transactions are savepoints on the same connection. */
  readonly transaction: <Result>(
    callback: (driver: TransactionDriver) => Promise<Result>,
  ) => Promise<Result>;
};
export type Driver = {
  readonly execute: QueryExecutor;
  readonly close: () => Promise<void>;
  readonly transaction?: <Result>(
    callback: (driver: TransactionDriver) => Promise<Result>,
    options?: TransactionOptions,
  ) => Promise<Result>;
  /** Pin a connection across transaction boundaries. The callback owns its session state. */
  readonly session?: <Result>(
    callback: (driver: SessionDriver) => Promise<Result>,
  ) => Promise<Result>;
};

export type SessionDriver = {
  readonly execute: QueryExecutor;
  readonly transaction: NonNullable<Driver["transaction"]>;
  /** Cancel the active statement on this pinned connection, if supported. */
  readonly cancel?: () => Promise<void>;
};

export type TableBinding = {
  readonly table: TableSnapshot;
  readonly alias: string;
  /** Explicit aliases remain unique within a query's named scope. */
  readonly explicitAlias?: boolean;
  readonly codecs: Readonly<Record<string, RuntimeCodec>>;
  /** Original projections retain result conversion metadata across aliases and CTEs. */
  readonly projection?: Readonly<Record<string, ExpressionDescription>>;
  readonly derived?: SelectPlan;
  readonly cte?: CommonTableExpression;
  readonly cteReference?: { readonly name: string; readonly identity: object };
};

export type CommonTableExpression = {
  readonly name: string;
  readonly identity: object;
  readonly query: SelectPlan;
  readonly materialized?: boolean;
  readonly recursive?: SelectPlan;
  readonly unionAll?: boolean;
};
export type SourceDescription = {
  readonly binding: TableBinding;
  readonly schema: SchemaSnapshot;
};
export type ColumnDescription = {
  readonly binding: TableBinding;
  readonly column: ColumnSnapshot;
};
export type OrderingDescription = {
  readonly expression: ExpressionDescription;
  readonly direction: "ASC" | "DESC";
  readonly nulls?: "FIRST" | "LAST";
};
export type JoinDescription = {
  readonly kind: "LEFT" | "INNER" | "RIGHT" | "FULL" | "CROSS";
  readonly binding: TableBinding;
  readonly condition?: PredicateDescription;
  readonly relation?: { readonly from: TableBinding; readonly name: string };
};
export type RowLockOptions<AliasName extends string = string> = {
  readonly of?: readonly AliasName[];
  readonly noWait?: boolean;
  readonly skipLocked?: boolean;
};

export type SelectPlan = {
  readonly kind: "select";
  readonly root: TableBinding;
  readonly bindings: Readonly<Record<string, TableBinding>>;
  readonly joins: readonly JoinDescription[];
  readonly selection: readonly ExpressionDescription[];
  readonly predicates: readonly PredicateDescription[];
  readonly ordering: readonly OrderingDescription[];
  readonly grouping: readonly ExpressionDescription[];
  readonly having: readonly PredicateDescription[];
  readonly distinct: boolean;
  readonly limit?: number | PlaceholderNode;
  readonly offset?: number | PlaceholderNode;
  readonly locking?: RowLockOptions & { readonly mode: "UPDATE" | "SHARE" };
  /** A data error found while building; compiling the plan throws it. */
  readonly failure?: DeferredError;
};

type ConflictDescription = {
  /** `doUpdate(values, { where })`: the conflicting row is updated only when this holds; may read `excluded`. */
  readonly condition?: PredicateDescription;
  readonly columns: readonly ColumnSnapshot[];
  readonly action: "nothing" | "update";
  readonly values: Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>>;
  readonly excluded?: TableBinding;
};

export type MutationPlan = {
  readonly kind: "insert" | "update" | "delete";
  readonly root: TableBinding;
  readonly bindings: Readonly<Record<string, TableBinding>>;
  readonly values: readonly Readonly<
    Record<string, ValueNode | typeof DEFAULT_VALUE>
  >[];
  /** Certified while normalizing rows: only parameters, columns, placeholders or DEFAULT. */
  readonly atomicValues?: boolean;
  readonly predicates: readonly PredicateDescription[];
  readonly selection: readonly ExpressionDescription[];
  readonly conflict?: ConflictDescription;
  /**
   * `$scope()` predicates every written row must satisfy, checked in the
   * statement; an upsert also checks the conflicting row before updating it.
   * Absent on unscoped tables and on DELETE.
   */
  readonly checks?: readonly PredicateDescription[];
  /** A single-object INSERT returns one row instead of an array. */
  readonly single?: true;
  /** `all()` confirmed that an UPDATE or DELETE without predicates is intended. */
  readonly unrestricted?: true;
  /** A data error found while building; compiling the plan throws it. */
  readonly failure?: DeferredError;
};

export interface QueryReference {
  readonly [QUERY_PLAN]: SelectPlan;
}

export interface TableSource<
  Row extends Record<string, unknown>,
  AliasName extends string,
  TableName extends string = string,
> {
  readonly [TABLE_SOURCE]: SourceDescription & {
    readonly rowType?: Row;
    readonly aliasType?: AliasName;
    readonly tableType?: TableName;
  };
}

/** Preserve source identities when a nested scope shadows an outer SQL name. */
export const mergeBindings = (
  outer: SelectPlan["bindings"],
  local: SelectPlan["bindings"],
): SelectPlan["bindings"] => {
  const bindings = { ...local };

  for (const [name, binding] of Object.entries(outer)) {
    let key = name;

    while (Object.hasOwn(bindings, key) && bindings[key] !== binding) {
      key += "_";
    }

    bindings[key] = binding;
  }

  return bindings;
};

export const containsBinding = (
  bindings: SelectPlan["bindings"],
  binding: TableBinding,
): boolean =>
  bindings[binding.alias] === binding ||
  Object.values(bindings).includes(binding);

/** Keep generated names within PostgreSQL's UTF-8 identifier limit. */
export const numberedAlias = (preferred: string, ordinal: number): string => {
  const suffix = `_${ordinal}`;
  const characters = Array.from(preferred);

  while (Buffer.byteLength(characters.join("") + suffix) > 63) {
    characters.pop();
  }

  return characters.join("") + suffix;
};

export const normalizeResult = (
  result: ExecutionResult | Record<string, unknown>[],
): ExecutionResult =>
  Array.isArray(result)
    ? {
        rows: result,
        affectedRows: (result as { count?: number }).count ?? result.length,
      }
    : result;
