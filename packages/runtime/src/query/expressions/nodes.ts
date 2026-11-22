import type { RuntimeCodec } from "../codecs";
import type {
  ColumnDescription,
  OrderingDescription,
  SelectPlan,
  TableBinding,
} from "../plan/types";
import type {
  SearchMode,
  SearchWeight,
  SearchHeadlineText,
  VectorOperator,
  QueryColumn,
} from "./column-types";
import type { WindowBoundary } from "./windows";
import type { OptionalPredicate } from "./functions";

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
  /** A prepared root LIMIT under first()/one(): binds the smaller of the value and this cap. */
  readonly cap?: number;
};

export type Parameter<
  Value,
  Name extends string = string,
  Traits = {},
> = QueryColumn<Value, Name, Traits> & { readonly [NAMED_PARAMETER]: true };

export declare const COLUMN_VALUE: unique symbol;
export declare const COLUMN_TRAITS: unique symbol;
export declare const ROW_TRAITS: unique symbol;
export declare const SCALAR_VALUE: unique symbol;

/**
 * What a query column knows about its SQL side beyond the value a read returns.
 * `stored` is what a jsonb(schema) column keeps and compares: the schema's
 * input (without null; nullability follows the value). `numeric` says how the
 * value computes: `"float"` in double precision (real and double precision
 * columns, numbers inside nested results), `"json"` as a JSON value (numbers in
 * double precision, paths stay JSON) and `"raw"` for a `sql<Value>` template,
 * whose SQL type is unknown. Other numbers compute as integers. `fields` holds
 * the traits of a nested result's fields (a relation, a nested object in a CTE),
 * so paths into it and comparisons with it use each field's stored form.
 */
export type ColumnTraits = {
  readonly stored?: unknown;
  readonly numeric?: "float" | "json" | "raw";
  readonly fields?: { readonly [name: string]: ColumnTraits };
};
export type FloatTraits = { readonly numeric: "float" };

/** The traits of a column or expression; `{}` when it has none. */
export type TraitsOf<Expression> = Expression extends {
  readonly [COLUMN_TRAITS]: infer Traits;
}
  ? Traits
  : {};

/** What the SQL side holds and compares: a jsonb(schema)'s input, otherwise the value a read returns. */
export type StoredValue<Value, Traits> = Traits extends {
  readonly stored: infer Stored;
}
  ? Stored | (null extends Value ? null : never)
  : Traits extends { readonly fields: infer Fields }
    ? StoredFields<Value, Fields>
    : Value;
/** A nested result as its JSON holds it: each field in its stored form. */
export type StoredFields<Value, Fields> = Value extends readonly (infer Row)[]
  ? StoredFields<Row, Fields>[]
  : Value extends object
    ? {
        [Name in keyof Value]: Name extends keyof Fields
          ? StoredValue<Value[Name], Fields[Name]>
          : Value[Name];
      }
    : Value;

/**
 * A row type with the traits of its columns under a symbol, so query columns
 * built from it compute and compare like the SQL columns while the row's own
 * fields stay the values a read returns. Rows without traits are unchanged.
 */
export type TraitedRow<Row, Traits> = keyof Traits extends never
  ? Row
  : Row & { readonly [ROW_TRAITS]?: Traits };

/** The traits a traited row records for one of its columns. */
export type RowColumnTraits<Row, Name> = Row extends {
  readonly [ROW_TRAITS]?: infer Traits;
}
  ? Name extends keyof NonNullable<Traits>
    ? NonNullable<Traits>[Name]
    : {}
  : {};

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
      /** Built by Symmetria from the nodes in its parts, not written by hand. */
      readonly composed?: true;
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
      readonly name:
        | "COUNT"
        | "SUM"
        | "AVG"
        | "MIN"
        | "MAX"
        | "BOOL_AND"
        | "BOOL_OR";
      readonly value?: ValueNode;
      readonly numeric?: boolean;
      /**
       * MIN/MAX of a type without them: the first element of `MIN(ARRAY[value])`,
       * skipping NULL, and for `"json"` JSON null as well.
       */
      readonly element?: "value" | "json";
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
      /**
       * What `is(null)` means for the left side, used when a nullable
       * parameter is bound to null: a JSON path also counts JSON null.
       */
      readonly nullCheck?: PredicateDescription;
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
    }
  | ScopePredicate;

/**
 * A `$scope()` filter on one table occurrence. `predicate` is the callback's
 * result when the query was built and decides the compiled SQL; `evaluate`
 * runs the callback again, so every execution binds its current values.
 */
export type ScopePredicate = {
  readonly kind: "scope";
  readonly binding: TableBinding;
  readonly evaluate: (binding: TableBinding) => PredicateDescription;
  readonly predicate: PredicateDescription;
};

export interface Predicate {
  readonly [PREDICATE_EXPRESSION]: PredicateDescription;
  /** This predicate AND the given ones; falsy entries are skipped as in `and()`. */
  readonly and: (...conditions: OptionalPredicate[]) => Predicate;
  /** This predicate OR the given ones; falsy entries are skipped as in `or()`. */
  readonly or: (...conditions: OptionalPredicate[]) => Predicate;
}

declare const ORDERED_COLUMN: unique symbol;

export interface Ordering<Column extends string = string> {
  readonly [ORDERING_EXPRESSION]: OrderingDescription;
  /** In the types only: the table column sorted by, when the ordering is of one. */
  readonly [ORDERED_COLUMN]?: Column;
  readonly nullsFirst: Ordering<Column>;
  readonly nullsLast: Ordering<Column>;
}
