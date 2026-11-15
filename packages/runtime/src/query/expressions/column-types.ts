import type { QueryReference } from "../plan/types";
import type { IsDecimalText, TsVector, Vector } from "../../schema/column";
import type {
  COLUMN_TRAITS,
  SCALAR_VALUE,
  FloatTraits,
  TraitsOf,
  StoredValue,
  SelectedColumn,
  ExpressionValue,
  Predicate,
  Ordering,
} from "./nodes";

/**
 * A `numeric` value: decimal text such as `"202.10"`, kept exact. Plain strings
 * are accepted wherever a decimal is written or compared.
 */
export type Decimal = `${number}`;

/**
 * A value to compare with: the stored form, safe integers for bigint and any
 * string for decimals (as their codecs accept), or a column of either type.
 */
export type Comparable<Stored, Value = Stored> =
  | Literal<Stored>
  | SelectedColumn<Stored | null>
  | SelectedColumn<Value | null>;
/**
 * A literal a column's codec encodes: its stored form, safe integers for
 * bigint, any string for decimals (not for enum labels that look numeric).
 */
export type Literal<Stored> =
  | NonNullable<Stored>
  | (bigint extends NonNullable<Stored> ? number : never)
  | (IsDecimalText<NonNullable<Stored>> extends true ? string : never);
/** The stored form of an expression's value. */
export type StoredOf<Expression> = StoredValue<
  ExpressionValue<Expression>,
  TraitsOf<Expression>
>;

/** Values arithmetic works on: integers and floats, bigints and decimals. */
export type ArithmeticValue = number | bigint | Decimal;
/** Whether arithmetic works on a value: numbers, bigints and decimal text, not text that looks numeric. */
export type Computable<Value> =
  NonNullable<Value> extends number | bigint
    ? true
    : IsDecimalText<NonNullable<Value>>;
/** Whether each member of a value is summable: null, numbers, bigints and decimal text. */
export type SummableValue<Value> = Value extends null
  ? true
  : Value extends number | bigint
    ? true
    : IsDecimalText<Value>;
/** sum() and average() add numbers, bigints and decimals; enum labels such as "1" are text. */
export type Summable<Expression> =
  Expression extends SelectedColumn<infer Value>
    ? false extends SummableValue<Value>
      ? "sum() and average() need a number, bigint or numeric expression"
      : unknown
    : unknown;
/** A number, bigint, decimal text or numeric column on the right of an operator. */
export type ArithmeticOperand =
  | number
  | bigint
  | string
  | SelectedColumn<ArithmeticValue | null>;
/**
 * How a value computes in arithmetic: an exact decimal, a 64-bit integer, a
 * 32-bit integer or a double. JSON values and float columns compute as doubles.
 */
export type NumericKind<Value, Traits> = Traits extends {
  readonly numeric: "json";
}
  ? "float"
  : IsDecimalText<NonNullable<Value>> extends true
    ? "decimal"
    : NonNullable<Value> extends bigint
      ? "bigint"
      : Traits extends FloatTraits
        ? "float"
        : "integer";
/** A JavaScript number takes the other side's kind; decimal text is a decimal. */
export type OperandKind<Operand, Left> =
  Operand extends SelectedColumn<infer Value>
    ? NumericKind<Value, TraitsOf<Operand>>
    : Operand extends string
      ? "decimal"
      : Operand extends bigint
        ? "bigint"
        : Left;
/** PostgreSQL's promotion: a decimal makes a decimal, then floats, then bigint. */
export type Promoted<Kinds> = "decimal" extends Kinds
  ? "decimal"
  : "float" extends Kinds
    ? "float"
    : "bigint" extends Kinds
      ? "bigint"
      : "integer";
export type Operation = "plus" | "minus" | "multiply" | "divide" | "quotient";
/** divide() never truncates: integers and bigints divide as exact decimals. */
export type ResultKind<Kind, Name extends Operation> = Name extends "divide"
  ? Kind extends "float"
    ? "float"
    : "decimal"
  : Kind;
export type KindValue<Kind> = Kind extends "decimal"
  ? Decimal
  : Kind extends "bigint"
    ? bigint
    : number;
export type ArithmeticColumn<
  Stored,
  Traits,
  Operand,
  OutputName extends string,
  Name extends Operation,
> =
  ResultKind<
    Promoted<
      | NumericKind<Stored, Traits>
      | OperandKind<Operand, NumericKind<Stored, Traits>>
    >,
    Name
  > extends infer Kind
    ? QueryColumn<
        KindValue<Kind> | NullWhen<Stored> | NullWhen<OperandOf<Operand>>,
        OutputName,
        Kind extends "float" ? FloatTraits : {}
      >
    : never;
/**
 * A `sql<Value>` template's SQL type is unknown, so arithmetic cannot type it;
 * a text column (an enum labelled "1") is no number.
 */
export type TypedOperand<Operand> = Operand extends {
  readonly [COLUMN_TRAITS]: { readonly numeric: "raw" };
}
  ? "a raw sql template needs a SQL type: write it as sql.of(column)"
  : Operand extends SelectedColumn<infer Value>
    ? Computable<Value> extends true
      ? unknown
      : "an operand needs a number, bigint or numeric column"
    : unknown;
export type Arithmetic<
  Stored,
  Traits,
  OutputName extends string,
  Name extends Operation,
> = Traits extends { readonly numeric: "raw" }
  ? (
      requires: `${Name}() needs a SQL type: write raw SQL as sql.of(column)`,
    ) => never
  : Computable<Stored> extends true
    ? <const Operand extends ArithmeticOperand>(
        value: Operand & TypedOperand<Operand>,
      ) => ArithmeticColumn<Stored, Traits, Operand, OutputName, Name>
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

export type SearchHeadlineText = Readonly<
  Omit<SearchHeadlineOptions, "language" | "mode">
>;

export type SearchDocumentOptions = {
  readonly language?: string;
};

export type SearchPart = SelectedColumn<string | null>;

/** One expression, several, or expressions grouped by weight. */
export type SearchDocumentParts =
  | SearchPart
  | readonly SearchPart[]
  | { readonly [Weight in SearchWeight]?: SearchPart | readonly SearchPart[] };

export type EnumerationPredicates<Value> =
  string extends NonNullable<Value>
    ? {}
    : { readonly [Name in Extract<NonNullable<Value>, string>]: Predicate };

export type Equality<Stored, Value> = ((
  value: Comparable<Stored, Value> | null,
) => Predicate) &
  EnumerationPredicates<Stored>;

export type MatchBranch =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | SelectedColumn;

/**
 * Literal branches take the SQL type of the column branches and decode as
 * those columns do (`0` next to a bigint column reads `0n`); literals alone
 * keep their own type.
 */
export type MatchValue<Branch> = [Extract<Branch, SelectedColumn>] extends [
  never,
]
  ? Branch
  : ExpressionValue<Extract<Branch, SelectedColumn>> | Extract<Branch, null>;
export type LiteralKind<Branch> = Branch extends string
  ? "string"
  : Branch extends number
    ? "number"
    : Branch extends bigint
      ? "bigint"
      : Branch extends boolean
        ? "boolean"
        : Branch extends Date
          ? "Date"
          : never;
export type IsUnion<Member, All = Member> = Member extends All
  ? [All] extends [Member]
    ? false
    : true
  : never;
/** Without a column branch, the literals must share one JavaScript type (null aside). */
export type MatchLiterals<Branch> = [Extract<Branch, SelectedColumn>] extends [
  never,
]
  ? true extends IsUnion<LiteralKind<Branch>>
    ? { readonly "match() literal branches need one type": never }
    : unknown
  : unknown;

/**
 * A CASE takes the SQL type of its column branches; number literals alone are
 * double precision.
 */
export type MatchTraits<Branch> = [Extract<Branch, SelectedColumn>] extends [
  never,
]
  ? [Extract<Branch, number>] extends [never]
    ? {}
    : FloatTraits
  : TraitsOf<Extract<Branch, SelectedColumn>>;

export type JsonKey<Value> =
  NonNullable<Value> extends readonly unknown[]
    ? number
    : NonNullable<Value> extends object
      ? keyof NonNullable<Value> & string
      : never;

export type JsonSubset<Value> = Value extends readonly (infer Item)[]
  ? readonly JsonSubset<Item>[]
  : Value extends object
    ? { [Name in keyof Value]?: JsonSubset<Value[Name]> }
    : Value;

export type PathValue<
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

export type ValidPath<
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

/** What `set()` writes at a path: the JSON value there, or a column or expression of it. */
export type JsonSetValue<Value> =
  | Exclude<Value, undefined>
  | SelectedColumn<Exclude<Value, undefined>>;

/** A path into JSON: the stored JSON value at the path. */
export type JsonPathColumn<
  Stored,
  Traits,
  Path extends readonly (string | number)[],
  OutputName extends string,
> = QueryColumn<
  Exclude<PathValue<Stored, Path>, undefined> | null,
  OutputName,
  PathTraits<Traits, PathValue<Stored, Path>>
>;
/** One step into a nested result: a row of a collection, or a field. */
export type StepValue<Value, Key> =
  NonNullable<Value> extends readonly (infer Row)[]
    ? Key extends number
      ? Row
      : never
    : Key extends keyof NonNullable<Value>
      ? NonNullable<Value>[Key]
      : never;
export type StepTraits<Value, Traits, Fields, Key> =
  NonNullable<Value> extends readonly unknown[]
    ? Traits
    : Key extends keyof Fields
      ? Fields[Key]
      : {};
/**
 * A path into a nested result reads each field with its codec and traits: a
 * jsonb(schema) field reads its output and compares its input, like the
 * column; inside the field, the path reads the stored JSON.
 */
export type PathColumn<
  Value,
  Traits,
  Path extends readonly (string | number)[],
  OutputName extends string,
> = Path extends readonly [
  infer Key,
  ...infer Rest extends readonly (string | number)[],
]
  ? Traits extends { readonly fields: infer Fields }
    ? PathColumn<
        StepValue<Value, Key>,
        StepTraits<Value, Traits, Fields, Key>,
        Rest,
        OutputName
      >
    : JsonPathColumn<StoredValue<Value, Traits>, Traits, Path, OutputName>
  : QueryColumn<
      Exclude<Value, undefined> | null,
      OutputName,
      NonNullable<Value> extends number
        ? Traits extends { readonly numeric: "json" }
          ? Traits
          : FloatTraits
        : Traits
    >;

/**
 * A number reached with a path computes as double precision. Inside JSON (a
 * jsonb column or raw SQL) every number does, and deeper paths stay JSON; a
 * nested result's bigint and decimal fields keep their SQL types.
 */
export type PathTraits<Traits, Value> =
  NonNullable<Value> extends number
    ? FloatTraits
    : Traits extends { readonly numeric: "json" | "raw" }
      ? NonNullable<Value> extends object | bigint
        ? { readonly numeric: "json" }
        : IsDecimalText<NonNullable<Value>> extends true
          ? { readonly numeric: "json" }
          : {}
      : {};

/** pgvector distance operators: Euclidean, cosine, negative inner product and taxicab. */
export type VectorOperator = "<->" | "<=>" | "<#>" | "<+>";

/** A vector operand: a plain embedding, a vector column or expression, or a prepared parameter. */
export type VectorQuery<Value> =
  | readonly number[]
  | Vector
  | SelectedColumn<Vector | null>
  | SelectedColumn<Value | null>;

/** `null` when a value can be null: strict SQL functions and operators return NULL then. */
export type NullWhen<Value> = null extends Value ? null : never;
/** The value a column, expression or literal operand stands for. */
export type OperandOf<Operand> =
  Operand extends SelectedColumn<infer Value> ? Value : Operand;

export type Distance<Value, Name extends string> =
  NonNullable<Value> extends Vector
    ? <const Query extends VectorQuery<Value>>(
        query: Query,
      ) => QueryColumn<
        number | NullWhen<Value> | NullWhen<OperandOf<Query>>,
        Name,
        FloatTraits
      >
    : never;

/** A full-text query: text, or a text column or expression. */
export type SearchQuery = string | SelectedColumn<string | null>;

/**
 * A column or SQL expression: selected for a `Value`, compared, filtered and
 * computed in its stored SQL form (see `ColumnTraits`).
 */
export type QueryColumn<
  Value,
  OutputName extends string,
  Traits = {},
> = SelectedColumn<Value, OutputName> & {
  readonly [COLUMN_TRAITS]: Traits;
} & ColumnMethods<Value, OutputName, Traits, StoredValue<Value, Traits>>;

export type ColumnMethods<Value, OutputName extends string, Traits, Stored> = {
  readonly path: NonNullable<Stored> extends Vector
    ? never
    : <const Path extends readonly [string | number, ...(string | number)[]]>(
        ...path: Path & ValidPath<Stored, Path>
      ) => PathColumn<Value, Traits, Path, OutputName>;
  /**
   * `jsonb_set(column, path, value)`: the JSON with one key replaced, or added
   * when its parent exists; the other keys stay. A NULL column stays NULL.
   */
  readonly set: NonNullable<Stored> extends Vector
    ? never
    : NonNullable<Stored> extends object
      ? {
          <const Key extends JsonKey<Stored> & keyof NonNullable<Stored>>(
            key: Key,
            value: JsonSetValue<NonNullable<Stored>[Key]>,
          ): QueryColumn<Value, OutputName, Traits>;
          <
            const Path extends readonly [
              string | number,
              ...(string | number)[],
            ],
          >(
            path: Path & ValidPath<Stored, Path>,
            value: JsonSetValue<PathValue<Stored, Path>>,
          ): QueryColumn<Value, OutputName, Traits>;
        }
      : never;
  readonly contains: NonNullable<Stored> extends Vector
    ? never
    : NonNullable<Stored> extends object
      ? (
          value:
            | JsonSubset<NonNullable<Stored>>
            | SelectedColumn<Stored>
            | SelectedColumn<Value>,
        ) => Predicate
      : never;
  /** `$1 = ANY(column)` for array columns. */
  readonly has: NonNullable<Stored> extends Vector
    ? never
    : NonNullable<Stored> extends readonly (infer Element)[]
      ? (value: Literal<Element> | SelectedColumn<Element | null>) => Predicate
      : never;
  /** `column && $1`: the arrays share at least one element. */
  readonly overlaps: NonNullable<Stored> extends Vector
    ? never
    : NonNullable<Stored> extends readonly unknown[]
      ? (
          values:
            | NonNullable<Stored>
            | SelectedColumn<Stored>
            | SelectedColumn<Value>,
        ) => Predicate
      : never;
  /** `cardinality(column)` of an array column. */
  readonly length: NonNullable<Stored> extends Vector
    ? never
    : NonNullable<Stored> extends readonly unknown[]
      ? () => QueryColumn<
          number | (null extends Stored ? null : never),
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
  readonly search: NonNullable<Stored> extends string
    ? (query: SearchQuery, options?: SearchOptions) => Predicate
    : never;
  /** `ts_rank(...)` (or `ts_rank_cd`) for ordering full-text matches; NULL text or query ranks NULL. */
  readonly searchRank: NonNullable<Stored> extends string
    ? <const Query extends SearchQuery>(
        query: Query,
        options?: SearchRankOptions,
      ) => QueryColumn<
        number | NullWhen<Stored> | NullWhen<OperandOf<Query>>,
        "searchRank",
        FloatTraits
      >
    : never;
  /** `ts_headline(...)`: the text with matches highlighted; text columns only. */
  readonly searchHeadline: NonNullable<Stored> extends string
    ? NonNullable<Stored> extends TsVector
      ? never
      : <const Query extends SearchQuery>(
          query: Query,
          options?: SearchHeadlineOptions,
        ) => QueryColumn<
          string | NullWhen<Stored> | NullWhen<OperandOf<Query>>,
          "searchHeadline"
        >
    : never;
  /** `is(value)` compiles to `=`, `is(null)` to `IS NULL`; enum members are also properties. */
  readonly is: Equality<Stored, Value>;
  /** `isNot(value)` compiles to `<>`, `isNot(null)` to `IS NOT NULL`. */
  readonly isNot: Equality<Stored, Value>;
  /** Exhaustive enum mapping to a SQL CASE; a NULL input produces NULL. */
  readonly match: NonNullable<Stored> extends string
    ? string extends NonNullable<Stored>
      ? never
      : <
          const Branches extends Record<
            Extract<NonNullable<Stored>, string>,
            MatchBranch
          >,
        >(
          branches: Branches &
            Record<Exclude<keyof Branches, NonNullable<Stored>>, never> &
            MatchLiterals<Branches[keyof Branches]>,
        ) => QueryColumn<
          MatchValue<Branches[keyof Branches]> | NullWhen<Stored>,
          OutputName,
          MatchTraits<Branches[keyof Branches]>
        >
    : never;
  readonly as: <const AliasName extends string>(
    name: AliasName,
  ) => QueryColumn<Value, AliasName, Traits>;
  readonly above: (value: Comparable<Stored, Value>) => Predicate;
  readonly atLeast: (value: Comparable<Stored, Value>) => Predicate;
  readonly below: (value: Comparable<Stored, Value>) => Predicate;
  readonly atMost: (value: Comparable<Stored, Value>) => Predicate;
  readonly isDistinctFrom: (
    value: Comparable<Stored, Value> | null,
  ) => Predicate;
  /** A subquery may select a nullable column; its NULLs never match. */
  readonly in: (
    values:
      | readonly Comparable<Stored, Value>[]
      | ScalarQuery<Stored | null>
      | ScalarQuery<Value | null>,
  ) => Predicate;
  /** As in SQL, `NOT IN` a subquery that returns a NULL matches no row. */
  readonly notIn: (
    values:
      | readonly Comparable<Stored, Value>[]
      | ScalarQuery<Stored | null>
      | ScalarQuery<Value | null>,
  ) => Predicate;
  readonly between: (
    lower: Comparable<Stored, Value>,
    upper: Comparable<Stored, Value>,
  ) => Predicate;
  readonly like: NonNullable<Stored> extends string
    ? (pattern: string | SelectedColumn<string | null>) => Predicate
    : (requires: "like() needs a text column") => never;
  readonly ilike: NonNullable<Stored> extends string
    ? (pattern: string | SelectedColumn<string | null>) => Predicate
    : (requires: "ilike() needs a text column") => never;
  /** `a + b`. A decimal operand makes a decimal, then a float, then a bigint. */
  readonly plus: Arithmetic<Stored, Traits, OutputName, "plus">;
  /** `a - b`, with the same promotion as plus(). */
  readonly minus: Arithmetic<Stored, Traits, OutputName, "minus">;
  /** `a * b`, such as `price.multiply(quantity)` for a decimal line total. */
  readonly multiply: Arithmetic<Stored, Traits, OutputName, "multiply">;
  /**
   * `a / b`, never truncated: integers, bigints and decimals divide as exact
   * decimals (`7 / 2` is `"3.5000000000000000"`), floats as floats. Dividing by
   * zero fails the query.
   */
  readonly divide: Arithmetic<Stored, Traits, OutputName, "divide">;
  /**
   * Integer division, truncated toward zero: `7 / 2` is `3` in the integer
   * type (number, bigint, or `div()` for a decimal), and a float's quotient is
   * truncated too. Dividing by zero fails the query.
   */
  readonly quotient: Arithmetic<Stored, Traits, OutputName, "quotient">;
  readonly ascending: Ordering;
  readonly descending: Ordering;
};

export interface ScalarQuery<Value> extends QueryReference {
  readonly [SCALAR_VALUE]: Value;
}
