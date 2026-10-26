import type {
  ColumnSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "../schema/assembly";
import type { RuntimeCodec } from "./codecs";
import type { DialectStrategy } from "./dialects/types";
import type {
  ExpressionDescription,
  PredicateDescription,
  ValueNode,
  PlaceholderNode,
} from "./expressions";

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
};
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
  /** Defaults to PostgreSQL; a strategy object registers itself by name. */
  readonly dialect?: Dialect | DialectStrategy;
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

/** SQL flavour a plan compiles to; bindings inherit it from their driver. Custom dialects use their registered name. */
export type Dialect = "postgres" | "sqlite" | (string & {});

export type TableBinding = {
  readonly table: TableSnapshot;
  readonly alias: string;
  /** Explicit aliases remain unique within a query's named scope. */
  readonly explicitAlias?: boolean;
  readonly codecs: Readonly<Record<string, RuntimeCodec>>;
  readonly dialect?: Dialect;
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
};

export type ConflictDescription = {
  readonly columns: readonly ColumnSnapshot[];
  readonly action: "nothing" | "update";
  readonly values: Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>>;
  readonly excluded?: TableBinding;
  /** `$scope()` predicates on the target row: a conflict outside the scope updates nothing. */
  readonly predicates?: readonly PredicateDescription[];
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
  /** A single-object INSERT returns one row instead of an array. */
  readonly single?: true;
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
