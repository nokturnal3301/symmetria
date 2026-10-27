import {
  countCodec,
  booleanCodec,
  codecFor,
  decodeValue,
  numericCodec,
  encodeValue,
  cloneParameter,
  type RuntimeCodec,
} from "./codecs";
import {
  QUERY_PLAN,
  type ColumnDescription,
  type OrderingDescription,
  type QueryReference,
  type SelectPlan,
} from "./state";
import {
  expressionDialect,
  expressionSource,
  expressionSqlType,
} from "./metadata";
import {
  jsonPathDescription,
  jsonPathTarget,
  jsonValueCodec,
} from "./json-path";
import { COLUMN_CODEC, type Column } from "../schema/column";

export const COLUMN_EXPRESSION = Symbol("symmetria.query.expression");
export const PREDICATE_EXPRESSION = Symbol("symmetria.query.predicate");
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
    }
  | { readonly kind: "raw"; readonly parts: readonly (string | ValueNode)[] }
  | {
      readonly kind: "binary";
      readonly left: ValueNode;
      readonly operator: "+" | "-" | "*" | "/";
      readonly right: ValueNode;
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
      readonly orderBy: readonly import("./state").OrderingDescription[];
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
      readonly serialized?: true;
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

    return Object.freeze({ ...value });
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
    node: Object.freeze({
      kind: "window",
      expression: description.node,
      partitionBy: Object.freeze(
        (options.partitionBy ?? []).map((column) => readColumn(column).node),
      ),
      orderBy: Object.freeze(
        ordering.map((entry: Ordering) => {
          if (!entry || !(ORDERING_EXPRESSION in entry)) {
            throw new Error(
              "symmetria: window orderBy requires ordering expressions",
            );
          }

          return entry[ORDERING_EXPRESSION];
        }),
      ),
      ...(rows ? { rows: Object.freeze(rows) } : {}),
    }),
  });
};

const windowFunction = <Value, Name extends string>(
  expression: QueryColumn<Value, Name>,
): WindowExpression<Value, Name> =>
  Object.freeze(
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

type Comparable<Value> =
  | NonNullable<Value>
  | (bigint extends NonNullable<Value> ? number : never)
  | SelectedColumn<Value | null>;
export type SearchOptions = {
  /** PostgreSQL text search configuration (default "simple"; "english" adds stemming). */
  readonly language?: string;
};
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

export type QueryColumn<Value, OutputName extends string> = SelectedColumn<
  Value,
  OutputName
> & {
  readonly path: <
    const Path extends readonly [string | number, ...(string | number)[]],
  >(
    ...path: Path & ValidPath<Value, Path>
  ) => QueryColumn<
    Exclude<PathValue<Value, Path>, undefined> | null,
    OutputName
  >;
  readonly contains: NonNullable<Value> extends object
    ? (
        value: JsonSubset<NonNullable<Value>> | SelectedColumn<Value>,
      ) => Predicate
    : never;
  /** `$1 = ANY(column)` for array columns. */
  readonly has: NonNullable<Value> extends readonly (infer Element)[]
    ? (
        value:
          | Element
          | (bigint extends Element ? number : never)
          | SelectedColumn<Element | null>,
      ) => Predicate
    : never;
  /** `column && $1`: the arrays share at least one element. */
  readonly overlaps: NonNullable<Value> extends readonly unknown[]
    ? (values: NonNullable<Value> | SelectedColumn<Value>) => Predicate
    : never;
  /** `cardinality(column)` of an array column. */
  readonly length: NonNullable<Value> extends readonly unknown[]
    ? () => QueryColumn<
        number | (null extends Value ? null : never),
        OutputName
      >
    : never;
  /** Full-text match: `to_tsvector(language, column) @@ websearch_to_tsquery(language, query)`. */
  readonly search: NonNullable<Value> extends string
    ? (
        query: string | SelectedColumn<string | null>,
        options?: SearchOptions,
      ) => Predicate
    : never;
  /** `ts_rank(...)` for ordering full-text matches; PostgreSQL only. */
  readonly searchRank: NonNullable<Value> extends string
    ? (
        query: string | SelectedColumn<string | null>,
        options?: SearchOptions,
      ) => QueryColumn<number, "searchRank">
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
    : never;
  readonly ilike: NonNullable<Value> extends string
    ? (pattern: string | SelectedColumn<string | null>) => Predicate
    : never;
  readonly plus: NonNullable<Value> extends number | bigint
    ? (value: Comparable<Value>) => QueryColumn<Value, OutputName>
    : never;
  readonly minus: NonNullable<Value> extends number | bigint
    ? (value: Comparable<Value>) => QueryColumn<Value, OutputName>
    : never;
  readonly multiply: NonNullable<Value> extends number | bigint
    ? (value: Comparable<Value>) => QueryColumn<Value, OutputName>
    : never;
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
    }
  | {
      readonly kind: "has";
      readonly value: ValueNode;
      readonly element: ValueNode;
      readonly json?: true;
      readonly serializedElements?: true;
      readonly serializedOperandElements?: true;
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
  Object.freeze({ [PREDICATE_EXPRESSION]: Object.freeze(description) });

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
      ? Object.freeze({ ...node, codec })
      : node;
  }

  if (value === undefined) {
    throw new Error("symmetria: undefined is not a SQL value");
  }

  return Object.freeze({
    kind: "parameter",
    value: cloneParameter(encodeValue(value, codec)),
    ...(codec?.parameterCast ? { cast: codec.parameterCast } : {}),
  });
};

export const readQuery = (query: QueryReference): SelectPlan => {
  if (!query || !(QUERY_PLAN in query) || !query[QUERY_PLAN].selection.length) {
    throw new Error("symmetria: a subquery requires selected fields");
  }

  return query[QUERY_PLAN];
};

class OrderingHandle {
  readonly [ORDERING_EXPRESSION]: OrderingDescription;

  constructor(description: OrderingDescription) {
    this[ORDERING_EXPRESSION] = Object.freeze(description);
  }

  get nullsFirst(): Ordering {
    return ordering({ ...this[ORDERING_EXPRESSION], nulls: "FIRST" });
  }

  get nullsLast(): Ordering {
    return ordering({ ...this[ORDERING_EXPRESSION], nulls: "LAST" });
  }
}

const ordering = (description: OrderingDescription): Ordering =>
  Object.freeze(new OrderingHandle(description)) as unknown as Ordering;

const searchLanguage = (language = "simple"): string => {
  if (!/^[a-z_]+$/.test(language)) {
    throw new Error(
      "symmetria: search language must be a PostgreSQL text search configuration name",
    );
  }

  return language;
};

const serializedJsonElements = (description: ExpressionDescription): boolean =>
  ["json[]", "jsonb[]"].includes(
    expressionSqlType(expressionSource(description)),
  );

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
    ...(sqlType === "derived" ? {} : { parameterCast: sqlType }),
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

    return Object.freeze({
      when: valueNode(name, description.codec),
      then:
        node.kind === "parameter" && sqlType !== "derived"
          ? Object.freeze({ ...node, cast: sqlType })
          : node,
    });
  });

  return createExpression({
    outputName: description.outputName,
    ...(codec ? { codec } : {}),
    node: Object.freeze({
      kind: "case",
      value: description.node,
      branches: Object.freeze(values),
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
    values: Object.freeze(
      values.map((value) => valueNode(value, description.codec)),
    ),
    negated,
  });
};

const arithmetic = (
  description: ExpressionDescription,
  operator: "+" | "-" | "*",
  value: unknown,
): QueryColumn<unknown, string> =>
  createExpression({
    ...description,
    node: Object.freeze({
      kind: "binary",
      left: description.node,
      operator,
      right: valueNode(value, description.codec),
    }),
  });

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
    this[COLUMN_EXPRESSION] = Object.freeze(description);
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

    const serializedElements = serializedJsonElements(description);
    const operand =
      value && typeof value === "object" && COLUMN_EXPRESSION in value
        ? readColumn(value as SelectedColumn)
        : undefined;
    const serializedOperandElements =
      operand && operand.node.kind !== "placeholder"
        ? serializedJsonElements(operand)
        : serializedElements;

    return predicate({
      kind: "has",
      value: description.node,
      element: valueNode(value, description.codec),
      json: true,
      overlap: true,
      ...(serializedElements ? { serializedElements: true } : {}),
      ...(serializedOperandElements ? { serializedOperandElements: true } : {}),
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
          ? jsonValueCodec(
              jsonPathTarget(description, 0),
              expressionDialect(description),
            )
          : description.codec?.element,
      ),
      ...(json ? { json: true } : {}),
      ...(serializedJsonElements(description)
        ? { serializedElements: true as const }
        : {}),
    });
  }

  length() {
    const description = this[COLUMN_EXPRESSION];

    return createExpression<number, string>({
      outputName: description.outputName,
      node: Object.freeze({
        kind: "arrayLength",
        value: description.node,
        ...(!expressionSqlType(description).endsWith("[]")
          ? { json: true as const }
          : {}),
      }),
    });
  }

  search(query: unknown, options: SearchOptions = {}) {
    return predicate({
      kind: "search",
      value: this[COLUMN_EXPRESSION].node,
      query: valueNode(query),
      language: searchLanguage(options.language),
    });
  }

  searchRank(query: unknown, options: SearchOptions = {}) {
    return createExpression<number, "searchRank">({
      outputName: "searchRank",
      node: Object.freeze({
        kind: "searchRank",
        value: this[COLUMN_EXPRESSION].node,
        query: valueNode(query),
        language: searchLanguage(options.language),
      }),
    });
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
}

export const createExpression = <
  Value = unknown,
  OutputName extends string = string,
>(
  description: ExpressionDescription<OutputName>,
): QueryColumn<Value, OutputName> =>
  Object.freeze(new ColumnHandle(description)) as unknown as QueryColumn<
    Value,
    OutputName
  >;

export const and = (...conditions: (Predicate | undefined)[]): Predicate =>
  predicate({
    kind: "group",
    operator: "AND",
    predicates: Object.freeze(
      conditions
        .filter((condition): condition is Predicate => condition !== undefined)
        .map(readPredicate),
    ),
  });

export const or = (...conditions: (Predicate | undefined)[]): Predicate =>
  predicate({
    kind: "group",
    operator: "OR",
    predicates: Object.freeze(
      conditions
        .filter((condition): condition is Predicate => condition !== undefined)
        .map(readPredicate),
    ),
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
    node: Object.freeze({
      kind: "aggregate",
      name: "COUNT",
      ...(expression ? { value: readColumn(expression).node } : {}),
    }),
    outputName: "count",
    codec: countCodec,
  });

export const sum = (
  expression: SelectedColumn<number | bigint | string | null>,
): QueryColumn<string | null, "sum"> =>
  createExpression({
    node: Object.freeze({
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
): QueryColumn<string | null, "average"> =>
  createExpression({
    node: Object.freeze({
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
    node: Object.freeze({
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
    node: Object.freeze({
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
    node: Object.freeze({
      kind: "coalesce",
      values: Object.freeze([
        description.node,
        valueNode(fallback, description.codec),
      ]),
    }),
    outputName: "coalesce",
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
): SqlTemplate<Value> => {
  const parts: (string | ValueNode)[] = [];
  strings.forEach((text, index) => {
    parts.push(text);

    if (index < values.length) {
      parts.push(valueNode(values[index]));
    }
  });

  return Object.freeze(
    new SqlHandle(
      {
        node: Object.freeze({ kind: "raw", parts: Object.freeze(parts) }),
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
        ),
  },
);
