import type { PredicateDescription, SearchMode } from "../../expressions";
import type {
  SearchDocumentPart,
  SearchHeadlineRendering,
  SearchRankRendering,
} from "./search";

export type ComparisonOperator = Extract<
  PredicateDescription,
  { kind: "comparison" }
>["operator"];

/** Compiler services used while rendering PostgreSQL expressions. */
export type RenderContext = {
  /** Registers a parameter value and returns its placeholder text. */
  readonly parameter: (value: unknown) => string;
  /** A quoted alias that no binding in scope occupies. */
  readonly nestedAlias: (prefix: string) => string;
  readonly quote: (identifier: string) => string;
};

type CastTarget =
  | { readonly kind: "parameter"; readonly type: string }
  | { readonly kind: "numeric" }
  | { readonly kind: "text"; readonly array: boolean }
  | { readonly kind: "typed"; readonly type: string };

export type JsonObjectEntry = {
  readonly key: string;
  readonly value: string;
};
type JsonPathOptions = {
  readonly scalarType: string | undefined;
};
type JsonHasOptions = {
  readonly overlap: boolean;
  /** The element is a bound parameter rather than an expression. */
  readonly encoded: boolean;
  readonly elementArray: boolean;
  /** The element with precision casts applied, for array overlap operands. */
  readonly operand: string;
};
type JsonMembershipOperand =
  | { readonly kind: "list"; readonly values: readonly string[] }
  | {
      readonly kind: "subquery";
      readonly sql: string;
      readonly column: string;
    };
type RowLock = {
  readonly mode: "UPDATE" | "SHARE";
  /** Already quoted aliases. */
  readonly of: readonly string[] | undefined;
  readonly noWait: boolean;
  readonly skipLocked: boolean;
};
type ExplainStatement = {
  readonly sql: string;
  readonly analyzed: boolean;
  /** Turns the EXPLAIN result rows into the reported plan, validating them. */
  readonly plan: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
};
/** Internal PostgreSQL rendering operations, independent of the transport. */
export type PostgresRenderer = {
  readonly name: "postgres";

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
  readonly jsonArray: (value: string) => string;
  readonly jsonObject: (
    entries: readonly JsonObjectEntry[],
    jsonOutput: boolean,
  ) => string;
  readonly jsonRows: (
    nested: string,
    many: boolean,
    jsonOutput: boolean,
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
  readonly arrayHas: (value: string, element: string) => string;
  /** The document side of a match: a tsvector as is, or text wrapped in to_tsvector(). */
  readonly searchVector: (
    value: string,
    language: string,
    isVector: boolean,
  ) => string;
  readonly searchQuery: (
    query: string,
    language: string,
    mode: SearchMode,
  ) => string;
  readonly search: (vector: string, query: string) => string;
  readonly searchRank: (
    vector: string,
    query: string,
    options: SearchRankRendering,
  ) => string;
  readonly searchHeadline: (
    language: string,
    text: string,
    query: string,
    options: SearchHeadlineRendering,
  ) => string;
  readonly searchDocument: (
    parts: readonly SearchDocumentPart[],
    language: string,
  ) => string;

  readonly recursiveUnion: (
    anchor: string,
    recursive: string,
    options: { readonly unionAll: boolean },
  ) => string;

  readonly parameterValue: (value: unknown) => unknown;
  readonly explain: (sql: string, analyze: boolean) => ExplainStatement;
  readonly nullsDefault: (direction: "ASC" | "DESC") => "FIRST" | "LAST";
};
