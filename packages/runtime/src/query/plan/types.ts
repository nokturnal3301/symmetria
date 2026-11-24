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

/**
 * What `await` runs: queries and writes have a promise's `then`, `catch`,
 * `finally` and tag, so they fit where a `Promise` is expected, and run each
 * time one of the three is called.
 */
export type Awaitable<Value> = Pick<
  Promise<Value>,
  "then" | "catch" | "finally" | typeof Symbol.toStringTag
>;

/** The tags thenables carry: `Object.prototype.toString` names what they are. */
export const QUERY_TAG = "SymmetriaQuery";
export const WRITE_TAG = "SymmetriaWrite";

/**
 * A driver's way to count a connection a `stream()` reserves as held by the
 * code that iterates it. Called where the iterator is made, it marks that
 * code as having started the stream; the claim then enters the async context
 * of the code that reads the rows, so a query in the loop fails at once where
 * it would wait forever for that connection. `close()` ends the streams that
 * hold a connection.
 */
export const CONNECTION_CLAIM = Symbol("symmetria.driver.claim");
export type StreamClaim = {
  /** Counts the connection as held by the code running now; once per context. */
  readonly enter: () => void;
  /** Whether the code running now counts the connection as held. */
  readonly entered: () => boolean;
  /** Whether other work waits for one of the pool's connections. */
  readonly contended: () => boolean;
  /**
   * The stream holds its connection; `end` ends it, as `close()` does,
   * `progress` counts the rows its reader has asked for, and `busy` tells
   * whether it works on one now (a FETCH in flight, a row on its way) rather
   * than waiting for its reader to ask.
   */
  readonly hold: (
    end: () => Promise<void>,
    progress: () => number,
    busy: () => boolean,
  ) => void;
  /** The stream gave its connection back. */
  readonly release: () => void;
};
export type ConnectionClaim = () => StreamClaim;
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
  /** See `CONNECTION_CLAIM`. */
  readonly [CONNECTION_CLAIM]?: ConnectionClaim;
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
  /** A `$batch()` statement: its fields are subqueries and there is no FROM. */
  readonly rootless?: true;
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

  for (const name in outer) {
    const binding = outer[name]!;
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

/** The number of rows a result says its statement wrote or read, when it says one. */
const statedCount = (result: object): number | undefined => {
  const { affectedRows, count, rowCount } = result as {
    affectedRows?: unknown;
    count?: unknown;
    rowCount?: unknown;
  };

  return typeof affectedRows === "number"
    ? affectedRows
    : typeof count === "number"
      ? count
      : typeof rowCount === "number"
        ? rowCount
        : undefined;
};

/**
 * An executor's result as `{ rows, affectedRows }`. An array of rows says its
 * count with `count` (Bun.SQL, postgres.js), an object with `affectedRows` or
 * `rowCount` (a node-postgres result); otherwise the rows are counted. A write
 * without RETURNING returns no rows, so its count cannot be counted: with
 * `write`, a result that does not state one is refused.
 */
export const normalizeResult = (
  result: ExecutionResult | Record<string, unknown>[],
  write = false,
): ExecutionResult => {
  if (!Array.isArray(result) && typeof result.affectedRows === "number") {
    return result;
  }

  const rows = Array.isArray(result) ? result : result.rows;
  const affectedRows = statedCount(result);

  if (affectedRows === undefined && write) {
    throw new Error(
      "symmetria: the executor's result does not say how many rows the write changed (the statement ran); return { rows, affectedRows } from the executor, or a node-postgres result or Bun.SQL array as they are, instead of the array of rows alone",
    );
  }

  return { rows, affectedRows: affectedRows ?? rows.length };
};
