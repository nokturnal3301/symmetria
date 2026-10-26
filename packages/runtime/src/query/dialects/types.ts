import type { ColumnSnapshot } from "../../schema/assembly";
import type {
  ExpressionDescription,
  PredicateDescription,
} from "../expressions";

export type ComparisonOperator = Extract<
  PredicateDescription,
  { kind: "comparison" }
>["operator"];

/** Compiler services a dialect may need while rendering one expression. */
export type RenderContext = {
  /** Registers a parameter value and returns its placeholder text. */
  readonly parameter: (value: unknown) => string;
  /** A quoted alias that no binding in scope occupies. */
  readonly nestedAlias: (prefix: string) => string;
  readonly quote: (identifier: string) => string;
};

export type DialectCapabilities = {
  /** Repeated correlated aggregates share one LEFT JOIN LATERAL. */
  readonly lateralJoins: boolean;
  /** Paginated roots are restricted before correlated subqueries run. */
  readonly rootPagination: boolean;
  /** False rejects row-lock controls instead of silently omitting them. */
  readonly rowLocks: boolean;
  /** Mutation roots carry an alias; otherwise RETURNING resolves the table name. */
  readonly mutationRootAlias: boolean;
  /** `DEFAULT VALUES` may be combined with ON CONFLICT. */
  readonly defaultValuesOnConflict: boolean;
  /** Array columns are native arrays rather than JSON text. */
  readonly nativeArrays: boolean;
  /** JSON array elements are serialized individually before the container. */
  readonly serializedJsonArrayElements: boolean;
  /** Supports contains()/overlaps() comparison operators; has() is independent. */
  readonly containmentOperators: boolean;
  /** Supports search(), including emulation; ranking also requires searchRank. */
  readonly fullTextSearch: boolean;
  /** A text parameter compared with an expression takes that expression's type (PostgreSQL); SQLite compares by storage class. */
  readonly typedParameters: boolean;
  /** ORDER BY always spells out NULLS FIRST/LAST because the engine's own default differs from `nullsDefault`. */
  readonly explicitNulls: boolean;
};

/** What an ordering comparison or ORDER BY key compares: its SQL type and, for enums, the declared labels. */
export type OrderedType = {
  readonly sqlType: string;
  readonly enumerationValues: readonly string[] | undefined;
};

export type CastTarget =
  | { readonly kind: "parameter"; readonly type: string }
  | { readonly kind: "numeric" }
  | { readonly kind: "text"; readonly array: boolean }
  | { readonly kind: "typed"; readonly type: string };

export type JsonObjectEntry = {
  readonly key: string;
  readonly value: string;
  /** The value is JSON already and must not be quoted as text. */
  readonly json: boolean;
};
export type JsonRowsField = { readonly name: string; readonly json: boolean };
export type JsonPathOptions = {
  readonly scalarType: string | undefined;
  readonly serialized: boolean;
};
export type JsonHasOptions = {
  readonly overlap: boolean;
  /** The element is a bound parameter rather than an expression. */
  readonly encoded: boolean;
  readonly elementType: string;
  readonly elementArray: boolean;
  /** The element with precision casts applied, for array overlap operands. */
  readonly operand: string;
  readonly serializedElements: boolean;
  readonly serializedOperandElements: boolean;
};
export type ArrayHasOptions = { readonly serializedElements: boolean };
export type SearchOperand = {
  /** Renders the query expression; call at most once. */
  readonly render: () => string;
  /** A literal string query, when the query is a plain parameter. */
  readonly literal: string | undefined;
  /** Re-encodes a prepared placeholder through a transform, when the query is one. */
  readonly renderEncoded:
    | ((transform: (encoded: unknown) => unknown) => string)
    | undefined;
};
export type JsonMembershipOperand =
  | { readonly kind: "list"; readonly values: readonly string[] }
  | {
      readonly kind: "subquery";
      readonly sql: string;
      readonly column: string;
    };
export type RowLock = {
  readonly mode: "UPDATE" | "SHARE";
  /** Already quoted aliases. */
  readonly of: readonly string[] | undefined;
  readonly noWait: boolean;
  readonly skipLocked: boolean;
};
export type ExplainStatement = {
  readonly sql: string;
  readonly analyzed: boolean;
  /** Turns the EXPLAIN result rows into the reported plan, validating them. */
  readonly plan: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
};
export type RowConverter = (
  row: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * PostgreSQL- and SQLite-compatible compiler, driver and codec strategies.
 * Methods must be deterministic and independent of mutable external state.
 * Built-ins use no `this` and support spread copies.
 */
export type DialectStrategy = {
  readonly name: string;
  readonly capabilities: DialectCapabilities;

  readonly placeholder: (position: number) => string;
  readonly cast: (value: string, target: CastTarget) => string;
  readonly comparisonOperator: (operator: ComparisonOperator) => string;
  readonly limitOffset: (
    limit: string | undefined,
    offset: string | undefined,
  ) => readonly string[];
  readonly rowLock: (lock: RowLock) => string;
  /** Wrapping that casts an expression to text in cursor columns. */
  readonly textCast: { readonly prefix: string; readonly suffix: string };
  /**
   * Wraps an operand of `<`/`>`/BETWEEN, a cursor tuple member or an ORDER BY
   * key so it sorts as PostgreSQL does: numeric by magnitude and enums in
   * declaration order. `equality` marks `=`-style comparisons. Absent when the
   * engine's own comparison already matches.
   */
  readonly orderedOperand?: (
    value: string,
    type: OrderedType,
    equality: boolean,
  ) => string | undefined;
  /**
   * `MIN(…)`/`MAX(…)` over a value whose storage sorts differently from
   * PostgreSQL (numeric text, enum labels). Returns SQL yielding the original
   * value, or `undefined` for the plain aggregate.
   */
  readonly orderedAggregate?: (
    name: "MIN" | "MAX",
    value: string,
    type: OrderedType,
  ) => string | undefined;
  /**
   * `LIKE`/`ILIKE` where the engine's pattern matching differs from
   * PostgreSQL's (case folding, escape character). Absent when
   * `comparisonOperator` suffices.
   */
  readonly patternMatch?: (
    left: string,
    right: string,
    caseInsensitive: boolean,
  ) => string;

  readonly jsonArray: (value: string) => string;
  readonly jsonObject: (
    entries: readonly JsonObjectEntry[],
    jsonOutput: boolean,
  ) => string;
  readonly jsonRows: (
    nested: string,
    fields: readonly JsonRowsField[],
    many: boolean,
    jsonOutput: boolean,
    context: RenderContext,
  ) => string;
  readonly jsonPath: (
    value: string,
    path: readonly (string | number)[],
    options: JsonPathOptions,
    context: RenderContext,
  ) => string;
  readonly arrayIndex: (
    value: string,
    position: number,
    context: RenderContext,
  ) => string;
  readonly arrayLength: (value: string, json: boolean) => string;

  readonly jsonComparison: (
    left: string,
    right: string,
    operator: "=" | "<>" | "IS" | "IS NOT",
  ) => string;
  readonly jsonMembership: (
    left: string,
    operand: JsonMembershipOperand,
    negated: boolean,
    context: RenderContext,
  ) => string;
  readonly jsonHas: (
    value: string,
    element: string,
    options: JsonHasOptions,
    context: RenderContext,
  ) => string;
  readonly arrayHas: (
    value: string,
    element: string,
    options: ArrayHasOptions,
    context: RenderContext,
  ) => string;
  readonly search: (
    value: string,
    query: SearchOperand,
    language: string,
    context: RenderContext,
  ) => string;
  readonly searchRank?: (
    value: string,
    query: string,
    language: string,
  ) => string;

  readonly defaultValue: (
    column: ColumnSnapshot,
    context: RenderContext,
  ) => string;
  readonly recursiveUnion: (
    anchor: string,
    recursive: string,
    options: {
      readonly unionAll: boolean;
      readonly anchorNeedsWrapper: boolean;
    },
  ) => string;

  readonly rowConverter: (
    selection: readonly ExpressionDescription[],
  ) => RowConverter | undefined;
  readonly jsonBoolean: (value: boolean) => unknown;
  readonly parameterValue: (value: unknown) => unknown;
  readonly explain: (sql: string, analyze: boolean) => ExplainStatement;
  readonly nullsDefault: (direction: "ASC" | "DESC") => "FIRST" | "LAST";
};
