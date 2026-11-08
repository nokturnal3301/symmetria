/**
 * Expression nodes and their fluent API: columns, predicates, orderings, parameters, window functions and raw SQL.
 */
import { freeze } from "../plan/freeze";
import {
  bigintCodec,
  countCodec,
  booleanCodec,
  codecFor,
  decodeValue,
  numericCodec,
  encodeValue,
  cloneParameter,
  type RuntimeCodec,
} from "../codecs";
import {
  QUERY_PLAN,
  type ColumnDescription,
  type OrderingDescription,
  type QueryReference,
  type SelectPlan,
} from "../plan/types";
import { expressionSource, expressionSqlType } from "../plan/metadata";
import {
  jsonPathDescription,
  jsonPathTarget,
  jsonValueCodec,
} from "./json-path";
import {
  COLUMN_CODEC,
  type Column,
  type TsVector,
  type Vector,
} from "../../schema/column";

export const COLUMN_EXPRESSION = Symbol("symmetria.query.expression");
const PREDICATE_EXPRESSION = Symbol("symmetria.query.predicate");
export const ORDERING_EXPRESSION = Symbol("symmetria.query.ordering");
export const NAMED_PARAMETER = Symbol("symmetria.query.parameter");

export type PlaceholderNode = {
  readonly kind: "placeholder";
  readonly name: string;
  readonly scope: object;
  readonly nullable: boolean;
  readonly sqlType: string;
  readonly codec?: RuntimeCodec;
  readonly count?: boolean;
};

export type Parameter<Value, Name extends string = string> = QueryColumn<
  Value,
  Name
> & { readonly [NAMED_PARAMETER]: true };

declare const COLUMN_VALUE: unique symbol;
declare const SCALAR_VALUE: unique symbol;

export type ValueNode =
  | PlaceholderNode
  | { readonly kind: "column"; readonly description: ColumnDescription }
  | {
      readonly kind: "parameter";
      readonly value: unknown;
      readonly cast?: string;
      readonly sqlType?: string;
    }
  | {
      readonly kind: "raw";
      readonly parts: readonly (string | ValueNode)[];
      readonly sqlType?: string;
    }
  | {
      readonly kind: "binary";
      readonly left: ValueNode;
      readonly operator: "+" | "-" | "*" | "/" | VectorOperator;
      readonly right: ValueNode;
      /** Result type when it differs from the left operand (distances are double precision). */
      readonly sqlType?: string;
    }
  | {
      readonly kind: "aggregate";
      readonly name: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
      readonly value?: ValueNode;
      readonly numeric?: boolean;
    }
  | { readonly kind: "coalesce"; readonly values: readonly ValueNode[] }
  | {
      readonly kind: "case";
      readonly value: ValueNode;
      readonly branches: readonly {
        readonly when: ValueNode;
        readonly then: ValueNode;
      }[];
      readonly sqlType: string;
    }
  | { readonly kind: "tuple"; readonly values: readonly ValueNode[] }
  | {
      readonly kind: "relativeWindow";
      readonly name: "lag" | "lead";
      readonly value: ValueNode;
      readonly offset: ValueNode;
      readonly fallback?: ValueNode;
    }
  | {
      readonly kind: "window";
      readonly expression: ValueNode;
      readonly partitionBy: readonly ValueNode[];
      readonly orderBy: readonly import("../plan/types").OrderingDescription[];
      readonly rows?: readonly [WindowBoundary, WindowBoundary];
    }
  | { readonly kind: "subquery"; readonly query: SelectPlan }
  | { readonly kind: "rowCount"; readonly query: SelectPlan }
  | {
      readonly kind: "jsonObject";
      readonly selection: readonly ExpressionDescription[];
    }
  | {
      readonly kind: "jsonPath";
      readonly value: ValueNode;
      readonly path: readonly (string | number)[];
      readonly target?: ExpressionDescription;
      readonly scalarType?: string;
    }
  | {
      readonly kind: "jsonRows";
      readonly query: SelectPlan;
      readonly many: boolean;
    }
  | {
      readonly kind: "searchRank";
      readonly value: ValueNode;
      readonly query: ValueNode;
      readonly language: string;
      readonly mode: SearchMode;
      readonly normalization?: number;
      readonly weights?: readonly [number, number, number, number];
      readonly coverDensity?: true;
    }
  | {
      readonly kind: "searchHeadline";
      readonly value: ValueNode;
      readonly query: ValueNode;
      readonly language: string;
      readonly mode: SearchMode;
      readonly options: SearchHeadlineText;
    }
  | {
      readonly kind: "tsvector";
      readonly parts: readonly {
        readonly value: ValueNode;
        readonly weight?: SearchWeight;
      }[];
      readonly language: string;
    }
  | {
      readonly kind: "arrayLength";
      readonly value: ValueNode;
      readonly json?: true;
    }
  | {
      readonly kind: "arrayIndex";
      readonly value: ValueNode;
      readonly position: number;
      readonly elementType: string;
    };

export type ExpressionDescription<OutputName extends string = string> = {
  readonly node: ValueNode;
  readonly outputName: OutputName;
  readonly codec?: RuntimeCodec;
};

export interface SelectedColumn<
  Value = unknown,
  OutputName extends string = string,
> {
  readonly [COLUMN_VALUE]: Value;
  readonly [COLUMN_EXPRESSION]: ExpressionDescription<OutputName>;
}

export type ExpressionValue<Expression> =
  Expression extends SelectedColumn<infer Value> ? Value : never;

export type WindowBoundary =
  | "unbounded preceding"
  | "current row"
  | "unbounded following"
  | { readonly preceding: number }
  | { readonly following: number };

export type WindowOptions = {
  readonly partitionBy?: readonly SelectedColumn[];
  readonly orderBy?: Ordering | readonly Ordering[];
  readonly rows?: readonly [WindowBoundary, WindowBoundary];
};

export type WindowExpression<Value, Name extends string> = QueryColumn<
  Value,
  Name
> & {
  readonly over: (options?: WindowOptions) => QueryColumn<Value, Name>;
};

export const over = <Value, Name extends string>(
  expression: SelectedColumn<Value, Name>,
  options: WindowOptions = {},
): QueryColumn<Value, Name> => {
  const description = readColumn(expression);
  const ordering = options.orderBy
    ? Array.isArray(options.orderBy)
      ? options.orderBy
      : [options.orderBy]
    : [];

  const boundary = (value: WindowBoundary): WindowBoundary => {
    if (typeof value === "string") {
      if (
        !["unbounded preceding", "current row", "unbounded following"].includes(
          value,
        )
      ) {
        throw new Error("symmetria: invalid window frame boundary");
      }

      return value;
    }

    const names = Object.keys(value);
    const offset = "preceding" in value ? value.preceding : value.following;

    if (
      names.length !== 1 ||
      !["preceding", "following"].includes(names[0]!) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new Error(
        "symmetria: window frame offsets must be nonnegative safe integers",
      );
    }

    return freeze({ ...value });
  };

  const rows = options.rows?.map(boundary) as
    | readonly [WindowBoundary, WindowBoundary]
    | undefined;

  if (
    rows &&
    (rows.length !== 2 ||
      rows[0] === "unbounded following" ||
      rows[1] === "unbounded preceding")
  ) {
    throw new Error("symmetria: invalid window frame bounds");
  }

  return createExpression<Value, Name>({
    ...description,
    outputName: expression[COLUMN_EXPRESSION].outputName,
    node: freeze({
      kind: "window",
      expression: description.node,
      partitionBy: freeze(
        (options.partitionBy ?? []).map((column) => readColumn(column).node),
      ),
      orderBy: freeze(
        ordering.map((entry: Ordering) => {
          if (!entry || !(ORDERING_EXPRESSION in entry)) {
            throw new Error(
              "symmetria: window orderBy requires ordering expressions",
            );
          }

          return entry[ORDERING_EXPRESSION];
        }),
      ),
      ...(rows ? { rows: freeze(rows) } : {}),
    }),
  });
};

const windowFunction = <Value, Name extends string>(
  expression: QueryColumn<Value, Name>,
): WindowExpression<Value, Name> =>
  freeze(
    Object.assign(Object.create(expression), {
      over: (options?: WindowOptions) => over(expression, options),
    }),
  ) as WindowExpression<Value, Name>;

export const rowNumber = (): WindowExpression<number, "rowNumber"> =>
  windowFunction(
    createExpression({
      node: { kind: "raw", parts: ["ROW_NUMBER()"] },
      outputName: "rowNumber",
      codec: countCodec,
    }),
  );

export const rank = (): WindowExpression<number, "rank"> =>
  windowFunction(
    createExpression({
      node: { kind: "raw", parts: ["RANK()"] },
      outputName: "rank",
      codec: countCodec,
    }),
  );

export const denseRank = (): WindowExpression<number, "denseRank"> =>
  windowFunction(
    createExpression({
      node: { kind: "raw", parts: ["DENSE_RANK()"] },
      outputName: "denseRank",
      codec: countCodec,
    }),
  );

const relativeWindow = <Value, Name extends "lag" | "lead">(
  name: Name,
  expression: SelectedColumn<Value>,
  offset: number,
  fallback?: Value,
): WindowExpression<Value | null, Name> => {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(
      "symmetria: lag/lead offset must be a nonnegative safe integer",
    );
  }

  const description = readColumn(expression);

  return windowFunction(
    createExpression({
      ...description,
      outputName: name,
      node: {
        kind: "relativeWindow",
        name,
        value: description.node,
        offset: valueNode(offset),
        ...(fallback === undefined
          ? {}
          : { fallback: valueNode(fallback, description.codec) }),
      },
    }),
  );
};

export const lag = <Value>(
  expression: SelectedColumn<Value>,
  offset = 1,
  fallback?: Value,
): WindowExpression<Value | null, "lag"> =>
  relativeWindow("lag", expression, offset, fallback);

export const lead = <Value>(
  expression: SelectedColumn<Value>,
  offset = 1,
  fallback?: Value,
): WindowExpression<Value | null, "lead"> =>
  relativeWindow("lead", expression, offset, fallback);

/**
 * A `numeric` value: decimal text such as `"202.10"`, kept exact. Plain strings
 * are accepted wherever a decimal is written or compared.
 */
export type Decimal = `${number}`;

type Comparable<Value> =
  | NonNullable<Value>
  | (bigint extends NonNullable<Value> ? number : never)
  | (NonNullable<Value> extends Decimal ? string : never)
  | SelectedColumn<Value | null>;

/** Values arithmetic works on: integers and floats, bigints and decimals. */
type ArithmeticValue = number | bigint | Decimal;
/** A number, bigint, decimal text or numeric column on the right of an operator. */
type ArithmeticOperand =
  | number
  | bigint
  | string
  | SelectedColumn<ArithmeticValue | null>;
type OperandValue<Operand> =
  Operand extends SelectedColumn<infer Value>
    ? Value
    : Operand extends string
      ? Decimal
      : Operand;
/** PostgreSQL's promotion: any decimal makes a decimal, then bigint, then number. */
type Promoted<Left, Right> =
  NonNullable<Left> extends Decimal
    ? Decimal
    : NonNullable<Right> extends Decimal
      ? Decimal
      : NonNullable<Left> extends bigint
        ? bigint
        : NonNullable<Right> extends bigint
          ? bigint
          : number;
type ArithmeticResult<Left, Operand> =
  | Promoted<Left, OperandValue<Operand>>
  | (null extends Left ? null : never)
  | (null extends OperandValue<Operand> ? null : never);
type Arithmetic<Value, OutputName extends string, Name extends string> =
  NonNullable<Value> extends ArithmeticValue
    ? <const Operand extends ArithmeticOperand>(
        value: Operand,
      ) => QueryColumn<ArithmeticResult<Value, Operand>, OutputName>
    : (requires: `${Name}() needs a number, bigint or numeric column`) => never;

/** How the query text is parsed: PostgreSQL's web search syntax, plain words, a phrase, or raw tsquery syntax. */
export type SearchMode = "websearch" | "plain" | "phrase" | "raw";
export type SearchWeight = "A" | "B" | "C" | "D";

export type SearchOptions = {
  /** Text search configuration (default: simple). */
  readonly language?: string;
  readonly mode?: SearchMode;
};

export type SearchRankOptions = SearchOptions & {
  /** PostgreSQL normalization bitmask (0-63): document length and unique-word corrections. */
  readonly normalization?: number;
  /** Weight multipliers in PostgreSQL's order: D, C, B, A. */
  readonly weights?: readonly [number, number, number, number];
  /** Use ts_rank_cd(), which rewards close matches. */
  readonly coverDensity?: boolean;
};

export type SearchHeadlineOptions = SearchOptions & {
  readonly startSel?: string;
  readonly stopSel?: string;
  readonly maxWords?: number;
  readonly minWords?: number;
  readonly shortWord?: number;
  readonly highlightAll?: boolean;
  readonly maxFragments?: number;
  readonly fragmentDelimiter?: string;
};

type SearchHeadlineText = Readonly<
  Omit<SearchHeadlineOptions, "language" | "mode">
>;

export type SearchDocumentOptions = {
  readonly language?: string;
};

type SearchPart = SelectedColumn<string | null>;

/** One expression, several, or expressions grouped by weight. */
export type SearchDocumentParts =
  | SearchPart
  | readonly SearchPart[]
  | { readonly [Weight in SearchWeight]?: SearchPart | readonly SearchPart[] };

type EnumerationPredicates<Value> =
  string extends NonNullable<Value>
    ? {}
    : { readonly [Name in Extract<NonNullable<Value>, string>]: Predicate };

type Equality<Value> = ((value: Comparable<Value> | null) => Predicate) &
  EnumerationPredicates<Value>;

type MatchBranch =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | SelectedColumn;

type MatchValue<Branch> =
  Branch extends SelectedColumn<infer Value> ? Value : Branch;

type JsonKey<Value> =
  NonNullable<Value> extends readonly unknown[]
    ? number
    : NonNullable<Value> extends object
      ? keyof NonNullable<Value> & string
      : never;

type JsonSubset<Value> = Value extends readonly (infer Item)[]
  ? readonly JsonSubset<Item>[]
  : Value extends object
    ? { [Name in keyof Value]?: JsonSubset<Value[Name]> }
    : Value;

type PathValue<
  Value,
  Path extends readonly (string | number)[],
> = Path extends readonly [
  infer Key,
  ...infer Rest extends readonly (string | number)[],
]
  ? Key extends keyof NonNullable<Value>
    ? PathValue<NonNullable<Value>[Key], Rest>
    : never
  : Value;

type ValidPath<
  Value,
  Path extends readonly (string | number)[],
> = Path extends readonly [
  infer Key,
  ...infer Rest extends readonly (string | number)[],
]
  ? Key extends JsonKey<Value> & keyof NonNullable<Value>
    ? readonly [Key, ...ValidPath<NonNullable<Value>[Key], Rest>]
    : never
  : readonly [];

/** pgvector distance operators: Euclidean, cosine, negative inner product and taxicab. */
export type VectorOperator = "<->" | "<=>" | "<#>" | "<+>";

/** A vector operand: a plain embedding, a vector column or expression, or a prepared parameter. */
export type VectorQuery<Value> =
  | readonly number[]
  | Vector
  | SelectedColumn<Vector | null>
  | SelectedColumn<Value | null>;

type Distance<Value, Name extends string> =
  NonNullable<Value> extends Vector
    ? (query: VectorQuery<Value>) => QueryColumn<number, Name>
    : never;

export type QueryColumn<Value, OutputName extends string> = SelectedColumn<
  Value,
  OutputName
> & {
  readonly path: NonNullable<Value> extends Vector
    ? never
    : <const Path extends readonly [string | number, ...(string | number)[]]>(
        ...path: Path & ValidPath<Value, Path>
      ) => QueryColumn<
        Exclude<PathValue<Value, Path>, undefined> | null,
        OutputName
      >;
  readonly contains: NonNullable<Value> extends Vector
    ? never
    : NonNullable<Value> extends object
      ? (
          value: JsonSubset<NonNullable<Value>> | SelectedColumn<Value>,
        ) => Predicate
      : never;
  /** `$1 = ANY(column)` for array columns. */
  readonly has: NonNullable<Value> extends Vector
    ? never
    : NonNullable<Value> extends readonly (infer Element)[]
      ? (
          value:
            | Element
            | (bigint extends Element ? number : never)
            | SelectedColumn<Element | null>,
        ) => Predicate
      : never;
  /** `column && $1`: the arrays share at least one element. */
  readonly overlaps: NonNullable<Value> extends Vector
    ? never
    : NonNullable<Value> extends readonly unknown[]
      ? (values: NonNullable<Value> | SelectedColumn<Value>) => Predicate
      : never;
  /** `cardinality(column)` of an array column. */
  readonly length: NonNullable<Value> extends Vector
    ? never
    : NonNullable<Value> extends readonly unknown[]
      ? () => QueryColumn<
          number | (null extends Value ? null : never),
          OutputName
        >
      : never;
  /** `column <-> query`: Euclidean (L2) distance; pgvector. */
  readonly l2Distance: Distance<Value, "l2Distance">;
  /** `column <=> query`: cosine distance (0 = same direction, 2 = opposite); pgvector. */
  readonly cosineDistance: Distance<Value, "cosineDistance">;
  /** `column <#> query`: PostgreSQL's NEGATIVE inner product, so smaller is more similar; pgvector. */
  readonly innerProduct: Distance<Value, "innerProduct">;
  /** `column <+> query`: taxicab (L1) distance; pgvector 0.7+. */
  readonly l1Distance: Distance<Value, "l1Distance">;
  /** Full-text match: `to_tsvector(language, column) @@ websearch_to_tsquery(language, query)`; a tsvector is matched directly. */
  readonly search: NonNullable<Value> extends string
    ? (
        query: string | SelectedColumn<string | null>,
        options?: SearchOptions,
      ) => Predicate
    : never;
  /** `ts_rank(...)` (or `ts_rank_cd`) for ordering full-text matches. */
  readonly searchRank: NonNullable<Value> extends string
    ? (
        query: string | SelectedColumn<string | null>,
        options?: SearchRankOptions,
      ) => QueryColumn<number, "searchRank">
    : never;
  /** `ts_headline(...)`: the text with matches highlighted; text columns only. */
  readonly searchHeadline: NonNullable<Value> extends string
    ? NonNullable<Value> extends TsVector
      ? never
      : (
          query: string | SelectedColumn<string | null>,
          options?: SearchHeadlineOptions,
        ) => QueryColumn<
          string | (null extends Value ? null : never),
          "searchHeadline"
        >
    : never;
  /** `is(value)` compiles to `=`, `is(null)` to `IS NULL`; enum members are also properties. */
  readonly is: Equality<Value>;
  /** `isNot(value)` compiles to `<>`, `isNot(null)` to `IS NOT NULL`. */
  readonly isNot: Equality<Value>;
  /** Exhaustive enum mapping to a SQL CASE; a NULL input produces NULL. */
  readonly match: NonNullable<Value> extends string
    ? string extends NonNullable<Value>
      ? never
      : <
          const Branches extends Record<
            Extract<NonNullable<Value>, string>,
            MatchBranch
          >,
        >(
          branches: Branches &
            Record<Exclude<keyof Branches, NonNullable<Value>>, never>,
        ) => QueryColumn<
          | MatchValue<Branches[keyof Branches]>
          | (null extends Value ? null : never),
          OutputName
        >
    : never;
  readonly as: <const AliasName extends string>(
    name: AliasName,
  ) => QueryColumn<Value, AliasName>;
  readonly above: (value: Comparable<Value>) => Predicate;
  readonly atLeast: (value: Comparable<Value>) => Predicate;
  readonly below: (value: Comparable<Value>) => Predicate;
  readonly atMost: (value: Comparable<Value>) => Predicate;
  readonly isDistinctFrom: (
    value: Value | null | SelectedColumn<Value | null>,
  ) => Predicate;
  readonly in: (
    values: readonly Comparable<Value>[] | ScalarQuery<Value>,
  ) => Predicate;
  readonly notIn: (
    values: readonly Comparable<Value>[] | ScalarQuery<Value>,
  ) => Predicate;
  readonly between: (
    lower: Comparable<Value>,
    upper: Comparable<Value>,
  ) => Predicate;
  readonly like: NonNullable<Value> extends string
    ? (pattern: string | SelectedColumn<string | null>) => Predicate
    : (requires: "like() needs a text column") => never;
  readonly ilike: NonNullable<Value> extends string
    ? (pattern: string | SelectedColumn<string | null>) => Predicate
    : (requires: "ilike() needs a text column") => never;
  /** `a + b`. Any decimal operand makes a decimal, then bigint, then number. */
  readonly plus: Arithmetic<Value, OutputName, "plus">;
  /** `a - b`, with the same promotion as plus(). */
  readonly minus: Arithmetic<Value, OutputName, "minus">;
  /** `a * b`, such as `price.multiply(quantity)` for a decimal line total. */
  readonly multiply: Arithmetic<Value, OutputName, "multiply">;
  /**
   * `a / b`. Two integer operands divide as integers in PostgreSQL (`7 / 2` is
   * `3`); a decimal or float operand keeps the fraction. Dividing by zero fails.
   */
  readonly divide: Arithmetic<Value, OutputName, "divide">;
  readonly ascending: Ordering;
  readonly descending: Ordering;
};

export interface ScalarQuery<Value> extends QueryReference {
  readonly [SCALAR_VALUE]: Value;
}

export type PredicateDescription =
  | {
      readonly kind: "comparison";
      readonly left: ValueNode;
      readonly operator:
        | "="
        | "<>"
        | ">"
        | ">="
        | "<"
        | "<="
        | "LIKE"
        | "ILIKE"
        | "IS DISTINCT FROM"
        | "IS NOT DISTINCT FROM"
        | "@>"
        | "&&";
      readonly right: ValueNode;
      readonly nullableParameter?: true;
    }
  | {
      readonly kind: "search";
      readonly value: ValueNode;
      readonly query: ValueNode;
      readonly language: string;
      readonly mode: SearchMode;
    }
  | {
      readonly kind: "has";
      readonly value: ValueNode;
      readonly element: ValueNode;
      readonly json?: true;
      readonly overlap?: true;
    }
  | {
      readonly kind: "nullCheck";
      readonly value: ValueNode;
      readonly negated: boolean;
    }
  | {
      readonly kind: "group";
      readonly operator: "AND" | "OR";
      readonly predicates: readonly PredicateDescription[];
    }
  | { readonly kind: "not"; readonly predicate: PredicateDescription }
  | { readonly kind: "notTrue"; readonly predicate: PredicateDescription }
  | {
      readonly kind: "membership";
      readonly value: ValueNode;
      readonly values: readonly ValueNode[] | SelectPlan;
      readonly negated: boolean;
    }
  | {
      readonly kind: "between";
      readonly value: ValueNode;
      readonly lower: ValueNode;
      readonly upper: ValueNode;
    }
  | {
      readonly kind: "exists";
      readonly query: SelectPlan;
      readonly negated: boolean;
    };

export interface Predicate {
  readonly [PREDICATE_EXPRESSION]: PredicateDescription;
}

export interface Ordering {
  readonly [ORDERING_EXPRESSION]: OrderingDescription;
  readonly nullsFirst: Ordering;
  readonly nullsLast: Ordering;
}

export const predicate = (description: PredicateDescription): Predicate =>
  freeze({ [PREDICATE_EXPRESSION]: freeze(description) });

export const isPredicate = (value: unknown): value is Predicate =>
  typeof value === "object" && value !== null && PREDICATE_EXPRESSION in value;

export const readPredicate = (value: Predicate): PredicateDescription => {
  if (!value || typeof value !== "object" || !(PREDICATE_EXPRESSION in value)) {
    throw new Error(
      "symmetria: expected a SQL predicate, such as column.is(value)",
    );
  }

  return value[PREDICATE_EXPRESSION];
};

export const readColumn = (value: SelectedColumn): ExpressionDescription => {
  if (!value || typeof value !== "object" || !(COLUMN_EXPRESSION in value)) {
    throw new Error("symmetria: expected a column or SQL expression");
  }

  return value[COLUMN_EXPRESSION];
};

export const valueNode = (value: unknown, codec?: RuntimeCodec): ValueNode => {
  if (value && typeof value === "object" && COLUMN_EXPRESSION in value) {
    const node = (value as SelectedColumn)[COLUMN_EXPRESSION].node;

    return node.kind === "placeholder" && codec
      ? freeze({ ...node, codec })
      : node;
  }

  if (value === undefined) {
    throw new Error("symmetria: undefined is not a SQL value");
  }

  return freeze({
    kind: "parameter",
    value: cloneParameter(encodeValue(value, codec)),
    ...(codec?.parameterCast ? { cast: codec.parameterCast } : {}),
    ...(codec?.sqlType ? { sqlType: codec.sqlType } : {}),
  });
};

const readQuery = (query: QueryReference): SelectPlan => {
  if (!query || !(QUERY_PLAN in query) || !query[QUERY_PLAN].selection.length) {
    throw new Error("symmetria: a subquery requires selected fields");
  }

  return query[QUERY_PLAN];
};

class OrderingHandle {
  readonly [ORDERING_EXPRESSION]: OrderingDescription;

  constructor(description: OrderingDescription) {
    this[ORDERING_EXPRESSION] = freeze(description);
  }

  get nullsFirst(): Ordering {
    return ordering({ ...this[ORDERING_EXPRESSION], nulls: "FIRST" });
  }

  get nullsLast(): Ordering {
    return ordering({ ...this[ORDERING_EXPRESSION], nulls: "LAST" });
  }
}

const ordering = (description: OrderingDescription): Ordering =>
  freeze(new OrderingHandle(description)) as unknown as Ordering;

const searchLanguage = (language = "simple"): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(language)) {
    throw new Error(
      "symmetria: search language must be a PostgreSQL text search configuration name",
    );
  }

  return language;
};

const SEARCH_MODES: ReadonlySet<string> = new Set([
  "websearch",
  "plain",
  "phrase",
  "raw",
]);

const searchMode = (mode: SearchMode = "websearch"): SearchMode => {
  if (!SEARCH_MODES.has(mode)) {
    throw new Error(
      "symmetria: search mode must be websearch, plain, phrase or raw",
    );
  }

  return mode;
};

const rankOptions = (options: SearchRankOptions) => {
  const { weights, normalization, coverDensity } = options;

  if (
    weights !== undefined &&
    (!Array.isArray(weights) ||
      weights.length !== 4 ||
      weights.some(
        (weight) =>
          typeof weight !== "number" || !Number.isFinite(weight) || weight < 0,
      ))
  ) {
    throw new Error(
      "symmetria: search weights must be four non-negative numbers in PostgreSQL's order (D, C, B, A)",
    );
  }

  if (
    normalization !== undefined &&
    (!Number.isSafeInteger(normalization) ||
      normalization < 0 ||
      normalization > 63)
  ) {
    throw new Error(
      "symmetria: search normalization must be an integer between 0 and 63",
    );
  }

  return {
    ...(weights
      ? {
          weights: freeze([...weights]) as unknown as readonly [
            number,
            number,
            number,
            number,
          ],
        }
      : {}),
    ...(normalization === undefined ? {} : { normalization }),
    ...(coverDensity ? { coverDensity: true as const } : {}),
  };
};

const HEADLINE_OPTIONS = {
  startSel: "string",
  stopSel: "string",
  fragmentDelimiter: "string",
  maxWords: "integer",
  minWords: "integer",
  shortWord: "integer",
  maxFragments: "integer",
  highlightAll: "boolean",
} as const;

const headlineOptions = (
  options: SearchHeadlineOptions,
): SearchHeadlineText => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(options)) {
    if (key === "language" || key === "mode" || value === undefined) {
      continue;
    }

    const expected = HEADLINE_OPTIONS[key as keyof typeof HEADLINE_OPTIONS];

    if (!expected) {
      throw new Error(`symmetria: unknown headline option "${key}"`);
    }

    const valid =
      expected === "string"
        ? typeof value === "string" && !value.includes("\0")
        : expected === "integer"
          ? Number.isSafeInteger(value) && (value as number) >= 0
          : typeof value === "boolean";

    if (!valid) {
      throw new Error(
        `symmetria: headline option "${key}" must be a ${expected === "integer" ? "non-negative integer" : expected}`,
      );
    }

    result[key] = value;
  }

  return freeze(result) as SearchHeadlineText;
};

const matchExpression = (
  description: ExpressionDescription,
  branches: Record<string, unknown>,
): QueryColumn<unknown, string> => {
  const source = expressionSource(description).node;
  const enumeration =
    source.kind === "column"
      ? source.description.column.enumerationValues
      : undefined;
  const entries =
    branches && typeof branches === "object" && !Array.isArray(branches)
      ? Object.entries(branches)
      : [];

  if (
    !entries.length ||
    (enumeration &&
      (entries.length !== enumeration.length ||
        enumeration.some((name) => !Object.hasOwn(branches, name))))
  ) {
    throw new Error(
      "symmetria: match() requires exactly one branch for every enum value",
    );
  }

  const selected = entries
    .map(([, value]) => value)
    .filter(
      (value): value is SelectedColumn =>
        !!value && typeof value === "object" && COLUMN_EXPRESSION in value,
    )
    .map(readColumn);

  const selectedDescription =
    selected.find(
      (expression) => expressionSqlType(expression) !== "derived",
    ) ?? selected[0];

  const literal = entries.find(
    ([, value]) =>
      value !== null &&
      !(value && typeof value === "object" && COLUMN_EXPRESSION in value),
  )?.[1];

  const literalType =
    literal instanceof Date
      ? "timestamptz"
      : typeof literal === "bigint"
        ? "bigint"
        : typeof literal === "number"
          ? "double precision"
          : typeof literal === "boolean"
            ? "boolean"
            : "text";

  const selectedType = selectedDescription
    ? expressionSqlType(selectedDescription)
    : "derived";

  const sqlType =
    selectedType !== "derived"
      ? selectedType
      : literal !== undefined || !selectedDescription
        ? literalType
        : "derived";

  const codec =
    selectedDescription?.codec ??
    (sqlType === "boolean" ? booleanCodec : codecFor(sqlType));

  const parameterCodec: RuntimeCodec = {
    encode: (value) => {
      const encoded = encodeValue(value, codec);

      return encoded instanceof Date ? encoded.toISOString() : encoded;
    },
    decode: (value) => decodeValue(value, codec),
    ...(sqlType === "derived" || sqlType === "enum"
      ? {}
      : { parameterCast: sqlType }),
  };

  const values = entries.map(([name, result]) => {
    const expression =
      result && typeof result === "object" && COLUMN_EXPRESSION in result
        ? readColumn(result as SelectedColumn)
        : undefined;

    if (
      expression &&
      expressionSqlType(expression) !== "derived" &&
      expressionSqlType(expression) !== sqlType
    ) {
      throw new Error("symmetria: match() branches require the same SQL type");
    }

    if (
      !expression &&
      result !== null &&
      ((!selectedDescription && typeof result !== typeof literal) ||
        result === undefined)
    ) {
      throw new Error(
        "symmetria: match() branches require compatible scalar values",
      );
    }

    const node = valueNode(result, parameterCodec);

    return freeze({
      when: valueNode(name, description.codec),
      then:
        node.kind === "parameter" && sqlType !== "derived" && sqlType !== "enum"
          ? freeze({ ...node, cast: sqlType })
          : node,
    });
  });

  return createExpression({
    outputName: description.outputName,
    ...(codec ? { codec } : {}),
    node: freeze({
      kind: "case",
      value: description.node,
      branches: freeze(values),
      sqlType,
    }),
  });
};

type ComparisonOperator = Extract<
  PredicateDescription,
  { kind: "comparison" }
>["operator"];

const compare = (
  description: ExpressionDescription,
  operator: ComparisonOperator,
  value: unknown,
): Predicate => {
  if (
    (value === null && operator !== "IS DISTINCT FROM") ||
    value === undefined
  ) {
    throw new Error(
      "symmetria: use is(null) or isNot(null) for NULL comparisons",
    );
  }

  const right = valueNode(value, description.codec);

  return predicate({
    kind: "comparison",
    left: description.node,
    operator,
    right,
    ...(right.kind === "placeholder" &&
    right.nullable &&
    (operator === "=" || operator === "<>")
      ? { nullableParameter: true as const }
      : {}),
  });
};

const membership = (
  description: ExpressionDescription,
  values: readonly unknown[] | QueryReference,
  negated: boolean,
): Predicate => {
  if (!Array.isArray(values)) {
    const query = readQuery(values as QueryReference);

    if (query.selection.length !== 1) {
      throw new Error("symmetria: IN requires a single-column subquery");
    }

    return predicate({
      kind: "membership",
      value: description.node,
      values: query,
      negated,
    });
  }

  return predicate({
    kind: "membership",
    value: description.node,
    values: freeze(values.map((value) => valueNode(value, description.codec))),
    negated,
  });
};

type NumericClass = "decimal" | "bigint" | "float" | "integer";

/** How PostgreSQL types an arithmetic operand, from its SQL type or codec. */
const numericClass = (expression: ExpressionDescription): NumericClass => {
  const sqlType = expressionSqlType(expression);

  if (expression.codec === numericCodec || sqlType.startsWith("numeric")) {
    return "decimal";
  }

  if (expression.codec === bigintCodec || sqlType === "bigint") {
    return "bigint";
  }

  return /^(real|double precision)$/.test(sqlType) ? "float" : "integer";
};

const castNode = (node: ValueNode, sqlType: string): ValueNode =>
  freeze({ kind: "raw", parts: freeze(["(", node, `)::${sqlType}`]), sqlType });

const decimalCodec: RuntimeCodec = freeze({
  ...numericCodec,
  sqlType: "numeric",
});

/**
 * `left <operator> right` with PostgreSQL's numeric promotion made explicit: a
 * decimal operand turns the other side into numeric, a bigint operand keeps
 * bigint, and a fractional JavaScript number is sent as double precision, so
 * `quantity.multiply("19.99")` and `quantity.multiply(1.5)` neither truncate
 * nor fail to parse as integers.
 */
const arithmetic = (
  description: ExpressionDescription,
  operator: "+" | "-" | "*" | "/",
  value: unknown,
): QueryColumn<unknown, string> => {
  if (value === undefined || value === null) {
    throw new Error(
      "symmetria: arithmetic needs a value; use coalesce() for NULL operands",
    );
  }

  const left = numericClass(description);
  const operand =
    typeof value === "object" && COLUMN_EXPRESSION in value
      ? readColumn(value as SelectedColumn)
      : undefined;
  const right: NumericClass = operand
    ? numericClass(operand)
    : typeof value === "string"
      ? "decimal"
      : typeof value === "bigint"
        ? "bigint"
        : typeof value === "number" && !Number.isInteger(value)
          ? "float"
          : left === "bigint" || left === "decimal"
            ? left
            : "integer";

  if (
    !operand &&
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    typeof value !== "string"
  ) {
    throw new Error(
      "symmetria: arithmetic operands are numbers, bigints, decimal strings or numeric columns",
    );
  }

  const result: NumericClass =
    left === "decimal" || right === "decimal"
      ? "decimal"
      : left === "float" || right === "float"
        ? "float"
        : left === "bigint" || right === "bigint"
          ? "bigint"
          : "integer";
  const leftNode =
    result === "decimal" && left !== "decimal"
      ? castNode(description.node, "numeric")
      : description.node;
  const rightNode = operand
    ? result === "decimal" && right !== "decimal"
      ? castNode(operand.node, "numeric")
      : operand.node
    : freeze({
        kind: "parameter" as const,
        value: cloneParameter(
          right === "bigint"
            ? bigintCodec.encode(value as bigint)
            : typeof value === "number" && result === "decimal"
              ? String(value)
              : value,
        ),
        ...(right === "decimal" || result === "decimal"
          ? { cast: "numeric" }
          : right === "float"
            ? { cast: "double precision" }
            : right === "bigint" && left !== "bigint"
              ? { cast: "bigint" }
              : {}),
      });
  const sqlType =
    result === "decimal"
      ? "numeric"
      : result === "float"
        ? "double precision"
        : result === "bigint"
          ? "bigint"
          : "integer";
  const codec =
    result === "decimal"
      ? decimalCodec
      : result === "bigint"
        ? bigintCodec
        : result === "float"
          ? codecFor("double precision")
          : left === "integer" && right === "integer"
            ? description.codec
            : undefined;

  return createExpression({
    outputName: description.outputName,
    node: freeze({
      kind: "binary",
      left: leftNode,
      operator,
      right: rightNode,
      sqlType,
    }),
    ...(codec ? { codec } : {}),
  });
};

/** Callable equality whose string properties are enum-member predicates. */
const equality = (description: ExpressionDescription, negated: boolean) =>
  new Proxy(
    (value: unknown) =>
      value === null
        ? predicate({ kind: "nullCheck", value: description.node, negated })
        : compare(description, negated ? "<>" : "=", value),
    {
      get: (target, name) =>
        typeof name === "string"
          ? compare(description, negated ? "<>" : "=", name)
          : Reflect.get(target, name),
    },
  );

const HANDLE_MEMO = Symbol("symmetria.query.memo");

type HandleMemo = {
  is?: unknown;
  isNot?: unknown;
  ascending?: Ordering;
  descending?: Ordering;
};

/**
 * Column handles share one prototype; an instance owns only its description and
 * a memo for the accessor results. Objects created from a handle inherit both.
 */
class ColumnHandle {
  readonly [COLUMN_EXPRESSION]: ExpressionDescription;
  readonly [HANDLE_MEMO]: HandleMemo;

  constructor(description: ExpressionDescription) {
    this[COLUMN_EXPRESSION] = freeze(description);
    this[HANDLE_MEMO] = {};
  }

  get is(): unknown {
    return (this[HANDLE_MEMO].is ??= equality(this[COLUMN_EXPRESSION], false));
  }

  get isNot(): unknown {
    return (this[HANDLE_MEMO].isNot ??= equality(
      this[COLUMN_EXPRESSION],
      true,
    ));
  }

  get ascending(): Ordering {
    return (this[HANDLE_MEMO].ascending ??= ordering({
      expression: this[COLUMN_EXPRESSION],
      direction: "ASC",
    }));
  }

  get descending(): Ordering {
    return (this[HANDLE_MEMO].descending ??= ordering({
      expression: this[COLUMN_EXPRESSION],
      direction: "DESC",
    }));
  }

  match(branches: Record<string, unknown>) {
    return matchExpression(this[COLUMN_EXPRESSION], branches);
  }

  path(...path: (string | number)[]) {
    if (
      !path.length ||
      path.some(
        (part) =>
          typeof part !== "string" &&
          !(
            typeof part === "number" &&
            Number.isSafeInteger(part) &&
            part >= 0
          ),
      )
    ) {
      throw new Error(
        "symmetria: JSON paths require string keys or nonnegative integer positions",
      );
    }

    return createExpression(jsonPathDescription(this[COLUMN_EXPRESSION], path));
  }

  contains(value: unknown) {
    const description = this[COLUMN_EXPRESSION];
    const sqlType = expressionSqlType(description);
    const json = sqlType === "json" || sqlType === "jsonb";

    // A containment operand is a partial JSON value: serialize it without the column's schema validation.
    return compare(
      json ? { ...description, codec: codecFor(sqlType)! } : description,
      "@>",
      value,
    );
  }

  overlaps(value: unknown) {
    const description = this[COLUMN_EXPRESSION];

    if (expressionSqlType(description).endsWith("[]")) {
      return compare(description, "&&", value);
    }

    return predicate({
      kind: "has",
      value: description.node,
      element: valueNode(value, description.codec),
      json: true,
      overlap: true,
    });
  }

  has(value: unknown) {
    const description = this[COLUMN_EXPRESSION];
    const type = expressionSqlType(description);
    const json = !type.endsWith("[]");

    return predicate({
      kind: "has",
      value: description.node,
      element: valueNode(
        value,
        json
          ? jsonValueCodec(jsonPathTarget(description, 0))
          : description.codec?.element,
      ),
      ...(json ? { json: true } : {}),
    });
  }

  length() {
    const description = this[COLUMN_EXPRESSION];

    return createExpression<number, string>({
      outputName: description.outputName,
      node: freeze({
        kind: "arrayLength",
        value: description.node,
        ...(!expressionSqlType(description).endsWith("[]")
          ? { json: true as const }
          : {}),
      }),
    });
  }

  /** A searchDocument() carries its own configuration; queries against it default to the same one. */
  private searchConfiguration(language: string | undefined): string {
    const node = this[COLUMN_EXPRESSION].node;

    return searchLanguage(
      language ?? (node.kind === "tsvector" ? node.language : undefined),
    );
  }

  search(query: unknown, options: SearchOptions = {}) {
    return predicate({
      kind: "search",
      value: this[COLUMN_EXPRESSION].node,
      query: valueNode(query),
      language: this.searchConfiguration(options.language),
      mode: searchMode(options.mode),
    });
  }

  searchRank(query: unknown, options: SearchRankOptions = {}) {
    return createExpression<number, "searchRank">({
      outputName: "searchRank",
      node: freeze({
        kind: "searchRank",
        value: this[COLUMN_EXPRESSION].node,
        query: valueNode(query),
        language: this.searchConfiguration(options.language),
        mode: searchMode(options.mode),
        ...rankOptions(options),
      }),
    });
  }

  searchHeadline(query: unknown, options: SearchHeadlineOptions = {}) {
    const description = this[COLUMN_EXPRESSION];

    if (expressionSqlType(description) === "tsvector") {
      throw new Error(
        "symmetria: searchHeadline() highlights text; call it on the text column, not on a tsvector",
      );
    }

    return createExpression<string | null, "searchHeadline">({
      outputName: "searchHeadline",
      node: freeze({
        kind: "searchHeadline",
        value: description.node,
        query: valueNode(query),
        language: searchLanguage(options.language),
        mode: searchMode(options.mode),
        options: headlineOptions(options),
      }),
    });
  }

  private distance(operator: VectorOperator, name: string, query: unknown) {
    const description = this[COLUMN_EXPRESSION];

    if (!/^vector(\(|$)/.test(expressionSqlType(description))) {
      throw new Error(
        "symmetria: distance operators require a vector column or expression",
      );
    }

    return createExpression<number, string>({
      outputName: name,
      node: freeze({
        kind: "binary",
        left: description.node,
        operator,
        right: valueNode(query, description.codec),
        sqlType: "double precision",
      }),
    });
  }

  l2Distance(query: unknown) {
    return this.distance("<->", "l2Distance", query);
  }

  cosineDistance(query: unknown) {
    return this.distance("<=>", "cosineDistance", query);
  }

  innerProduct(query: unknown) {
    return this.distance("<#>", "innerProduct", query);
  }

  l1Distance(query: unknown) {
    return this.distance("<+>", "l1Distance", query);
  }

  as(name: string) {
    if (!name.length) {
      throw new Error("symmetria: column aliases must be nonempty strings");
    }

    return createExpression({ ...this[COLUMN_EXPRESSION], outputName: name });
  }

  above(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], ">", value);
  }

  atLeast(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], ">=", value);
  }

  below(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], "<", value);
  }

  atMost(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], "<=", value);
  }

  isDistinctFrom(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], "IS DISTINCT FROM", value);
  }

  in(values: readonly unknown[] | QueryReference) {
    return membership(this[COLUMN_EXPRESSION], values, false);
  }

  notIn(values: readonly unknown[] | QueryReference) {
    return membership(this[COLUMN_EXPRESSION], values, true);
  }

  between(lower: unknown, upper: unknown) {
    const description = this[COLUMN_EXPRESSION];

    return predicate({
      kind: "between",
      value: description.node,
      lower: valueNode(lower, description.codec),
      upper: valueNode(upper, description.codec),
    });
  }

  like(pattern: string) {
    return compare(this[COLUMN_EXPRESSION], "LIKE", pattern);
  }

  ilike(pattern: string) {
    return compare(this[COLUMN_EXPRESSION], "ILIKE", pattern);
  }

  plus(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "+", value);
  }

  minus(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "-", value);
  }

  multiply(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "*", value);
  }

  divide(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "/", value);
  }
}

export const createExpression = <
  Value = unknown,
  OutputName extends string = string,
>(
  description: ExpressionDescription<OutputName>,
): QueryColumn<Value, OutputName> =>
  freeze(new ColumnHandle(description)) as unknown as QueryColumn<
    Value,
    OutputName
  >;

/**
 * Entries a predicate list skips: every value `cond && predicate` can produce
 * when `cond` is falsy, so `[q && title.ilike(q)]` compiles for
 * `q: string | undefined` and an empty string adds no filter.
 */
export type SkippedPredicate = undefined | null | false | "" | 0 | 0n;
export type OptionalPredicate = Predicate | SkippedPredicate;

/** Falsy entries are skipped; anything else must be a predicate. */
export const presentPredicates = (
  conditions: readonly unknown[],
): readonly PredicateDescription[] =>
  freeze(
    conditions
      .filter((condition) => !!condition)
      .map((condition) => readPredicate(condition as Predicate)),
  );

/** AND of the given predicates; falsy entries (`undefined`, `null`, `false`, `""`, `0`) are skipped. Empty is TRUE. */
export const and = (...conditions: OptionalPredicate[]): Predicate =>
  predicate({
    kind: "group",
    operator: "AND",
    predicates: presentPredicates(conditions),
  });

/** OR of the given predicates; falsy entries are skipped like in and(). Empty is FALSE. */
export const or = (...conditions: OptionalPredicate[]): Predicate =>
  predicate({
    kind: "group",
    operator: "OR",
    predicates: presentPredicates(conditions),
  });

export const when = <Value>(
  value: Value,
  callback: (value: NonNullable<Value>) => Predicate,
): Predicate | undefined =>
  value === null || value === undefined
    ? undefined
    : callback(value as NonNullable<Value>);

export const not = (value: Predicate): Predicate =>
  predicate({ kind: "not", predicate: readPredicate(value) });

export const exists = (query: QueryReference): Predicate =>
  predicate({ kind: "exists", query: readQuery(query), negated: false });

export const notExists = (query: QueryReference): Predicate =>
  predicate({ kind: "exists", query: readQuery(query), negated: true });

export const count = (
  expression?: SelectedColumn,
): QueryColumn<number, "count"> =>
  createExpression({
    node: freeze({
      kind: "aggregate",
      name: "COUNT",
      ...(expression ? { value: readColumn(expression).node } : {}),
    }),
    outputName: "count",
    codec: countCodec,
  });

export const sum = (
  expression: SelectedColumn<number | bigint | string | null>,
): QueryColumn<Decimal | null, "sum"> =>
  createExpression({
    node: freeze({
      kind: "aggregate",
      name: "SUM",
      value: readColumn(expression).node,
      numeric: true,
    }),
    outputName: "sum",
    codec: numericCodec,
  });

export const average = (
  expression: SelectedColumn<number | bigint | string | null>,
): QueryColumn<Decimal | null, "average"> =>
  createExpression({
    node: freeze({
      kind: "aggregate",
      name: "AVG",
      value: readColumn(expression).node,
      numeric: true,
    }),
    outputName: "average",
    codec: numericCodec,
  });

export const minimum = <Value>(
  expression: SelectedColumn<Value>,
): QueryColumn<Value | null, "minimum"> => {
  const description = readColumn(expression);

  return createExpression({
    ...description,
    node: freeze({
      kind: "aggregate",
      name: "MIN",
      value: description.node,
    }),
    outputName: "minimum",
  });
};

export const maximum = <Value>(
  expression: SelectedColumn<Value>,
): QueryColumn<Value | null, "maximum"> => {
  const description = readColumn(expression);

  return createExpression({
    ...description,
    node: freeze({
      kind: "aggregate",
      name: "MAX",
      value: description.node,
    }),
    outputName: "maximum",
  });
};

export const coalesce = <Value>(
  expression: SelectedColumn<Value>,
  fallback: NonNullable<Value> | SelectedColumn<NonNullable<Value>>,
): QueryColumn<NonNullable<Value>, "coalesce"> => {
  const description = readColumn(expression);

  return createExpression({
    ...description,
    node: freeze({
      kind: "coalesce",
      values: freeze([
        description.node,
        valueNode(fallback, description.codec),
      ]),
    }),
    outputName: "coalesce",
  });
};

const SEARCH_WEIGHTS: ReadonlySet<string> = new Set(["A", "B", "C", "D"]);

/**
 * A full-text document built from one or more text expressions, optionally grouped by
 * weight: `searchDocument({ A: post.title, B: [post.body] }, { language: "english" })`.
 * Compiles to `setweight(to_tsvector(language, coalesce(expr, '')), 'A') || ...`; the
 * same expression declares a GIN index in `.indexes()`, so the planner can use it.
 */
export const searchDocument = (
  parts: SearchDocumentParts,
  options: SearchDocumentOptions = {},
): QueryColumn<TsVector, "searchDocument"> => {
  const collected: {
    readonly value: ValueNode;
    readonly weight?: SearchWeight;
  }[] = [];
  const add = (part: unknown, weight?: SearchWeight) => {
    for (const entry of Array.isArray(part) ? part : [part]) {
      collected.push(
        freeze({
          value: readColumn(entry as SelectedColumn).node,
          ...(weight ? { weight } : {}),
        }),
      );
    }
  };

  if (parts && typeof parts === "object" && COLUMN_EXPRESSION in parts) {
    add(parts);
  } else if (Array.isArray(parts)) {
    add(parts);
  } else if (parts && typeof parts === "object") {
    for (const [weight, part] of Object.entries(parts)) {
      if (!SEARCH_WEIGHTS.has(weight)) {
        throw new Error(
          `symmetria: search weights are A, B, C or D, not "${weight}"`,
        );
      }

      if (part !== undefined) {
        add(part, weight as SearchWeight);
      }
    }
  }

  if (!collected.length) {
    throw new Error(
      "symmetria: searchDocument() requires at least one text expression",
    );
  }

  return createExpression<TsVector, "searchDocument">({
    outputName: "searchDocument",
    node: freeze({
      kind: "tsvector",
      parts: freeze(collected),
      language: searchLanguage(options.language),
    }),
  });
};

const SQL_TEMPLATE = Symbol("symmetria.query.sql");

class SqlHandle extends ColumnHandle {
  readonly kind = "sql" as const;
  readonly [SQL_TEMPLATE]: {
    readonly strings: TemplateStringsArray;
    readonly interpolated: boolean;
  };

  constructor(
    description: ExpressionDescription,
    strings: TemplateStringsArray,
    interpolated: boolean,
  ) {
    super(description);
    this[SQL_TEMPLATE] = { strings, interpolated };
  }

  get sql(): string {
    if (this[SQL_TEMPLATE].interpolated) {
      throw new Error("symmetria: SQL defaults cannot contain interpolations");
    }

    return this[SQL_TEMPLATE].strings.join("");
  }
}

type SqlTemplate<Value> = QueryColumn<Value, "expression"> & {
  kind: "sql";
  sql: string;
};

const sqlTemplate = <Value>(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  codec?: RuntimeCodec,
  sqlType?: string,
): SqlTemplate<Value> => {
  const parts: (string | ValueNode)[] = [];
  strings.forEach((text, index) => {
    parts.push(text);

    if (index < values.length) {
      parts.push(valueNode(values[index]));
    }
  });

  return freeze(
    new SqlHandle(
      {
        node: freeze({
          kind: "raw",
          parts: freeze(parts),
          ...(sqlType ? { sqlType } : {}),
        }),
        outputName: "expression",
        ...(codec ? { codec } : {}),
      },
      strings,
      values.length > 0,
    ),
  ) as unknown as SqlTemplate<Value>;
};

type ColumnResult<Definition> =
  Definition extends Column<infer Metadata>
    ? Metadata["notNull"] extends false
      ? Metadata["valueType"] | null
      : Metadata["valueType"]
    : never;

// Keep recursive column types named when this callable is included in ShapeTools.
export interface SqlTag {
  <Value = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlTemplate<Value>;
  /** A template typed and decoded like a column, including driver-specific codecs. */
  of: <Definition extends Column>(
    column: Definition,
  ) => (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => SqlTemplate<ColumnResult<Definition>>;
}

/** Interpolations are parameters or expression nodes; only the template's literal text is SQL. */
export const sql: SqlTag = Object.assign(
  <Value = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlTemplate<Value> => sqlTemplate<Value>(strings, values),
  {
    /**
     * A template typed and decoded like a column: `sql.of(bool)` returns booleans on every
     * driver, `sql.of(timestamptz)` returns Dates and `sql.of(bigint)` bigints.
     */
    of:
      <Definition extends Column>(column: Definition) =>
      (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): SqlTemplate<ColumnResult<Definition>> =>
        sqlTemplate<ColumnResult<Definition>>(
          strings,
          values,
          column[COLUMN_CODEC] ??
            (column.definition.sqlType === "boolean"
              ? booleanCodec
              : codecFor(column.definition.sqlType)),
          column.definition.sqlType,
        ),
  },
);
