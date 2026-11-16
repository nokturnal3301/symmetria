/** Type-level API of queries: scopes, projections, relations, options and the query handle. */
import type {
  COLUMN_EXPRESSION,
  ExpressionValue,
  Ordering,
  Decimal,
  SkippedPredicate,
  Predicate,
  QueryColumn,
  RowColumnTraits,
  ScalarQuery,
  SelectedColumn,
  Summable,
  SummableValue,
  TraitedRow,
  TraitsOf,
  Parameter,
} from "../expressions";
import type {
  CompiledQuery,
  QueryReference,
  RowLockOptions,
  TableBinding,
  TableSource,
} from "../plan/types";
import type { TableMutations } from "../write/types";
import type { PreparedQuery, Preparable } from "./prepared";
import type { Page, PageCursor, PageOptions } from "./pagination";
import type {
  InspectQueryOptions,
  QueryInspection,
} from "../../observability/inspection";
import type { ReusableShape } from "./projections";
import type { PartialSearch } from "../search";
import type { shapeExpressions } from "./projections";

type SchemaRows = Record<string, Record<string, unknown>>;
type SchemaRelations = Record<
  string,
  Record<string, { target: string; many?: boolean }>
>;
type StringKeys<Value> = keyof Value & string;
type ScopeEntry = {
  row: Record<string, unknown>;
  table: string;
  nullable: boolean;
};
type QueryScope = Record<string, ScopeEntry>;
declare const COLUMN_ORIGIN: unique symbol;
export type ScopedColumn = SelectedColumn & {
  readonly [COLUMN_ORIGIN]: { readonly alias: string; readonly name: string };
};
export type RootScope<Rows extends SchemaRows, RootTable extends string> = {
  [TableName in RootTable]: {
    row: Rows[RootTable];
    table: RootTable;
    nullable: false;
    root: true;
  };
};
/** Query columns of a row: values a read returns, computed and compared as the row's traits say. */
export type Columns<
  Row extends Record<string, unknown>,
  Nullable extends boolean = false,
  Alias extends string = string,
> = {
  readonly [ColumnName in StringKeys<Row>]: QueryColumn<
    Row[ColumnName] | (Nullable extends true ? null : never),
    ColumnName,
    RowColumnTraits<Row, ColumnName>
  > & {
    readonly [COLUMN_ORIGIN]: {
      readonly alias: Alias;
      readonly name: ColumnName;
    };
  };
};
export const RELATION_SOURCE = Symbol("symmetria.query.relation");
declare const FOREIGN_KEY_SOURCE: unique symbol;
type ForeignKeyReference<
  Target extends string = string,
  Alias extends string = string,
  Nullable extends boolean = boolean,
> = SelectedColumn & {
  readonly [FOREIGN_KEY_SOURCE]: {
    readonly target: Target;
    readonly alias: Alias;
    readonly nullable: Nullable;
  };
};
export type JoinReference<
  Target extends string = string,
  Alias extends string = string,
  Nullable extends boolean = boolean,
> =
  | RelationReference<Target, Alias, Nullable>
  | ForeignKeyReference<Target, Alias, Nullable>;
export type RelationReference<
  Target extends string = string,
  Alias extends string = string,
  Nullable extends boolean = boolean,
> = {
  readonly [RELATION_SOURCE]: {
    readonly target: Target;
    readonly alias: Alias;
    readonly from: string;
    readonly relation: string;
    readonly owner: TableBinding;
    readonly nullable: Nullable;
    readonly explicitAlias?: boolean;
  };
};
type SmartNullable<Entry, Relation> = Entry extends { optionalSource: true }
  ? true
  : Relation extends { origin: `forward:${string}`; nullable: false }
    ? false
    : true;
type AggregateFields<
  Row,
  Name extends "sum" | "average" | "minimum" | "maximum",
> = {
  readonly [Key in keyof Row & string as Name extends "sum" | "average"
    ? false extends SummableValue<Row[Key]>
      ? never
      : Key
    : Key]: Name extends "sum" | "average"
    ? QueryColumn<Decimal | null, Name>
    : QueryColumn<Row[Key] | null, Name, RowColumnTraits<Row, Key>>;
};
type RelationQuery<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  Target extends string,
  Alias extends string,
  Many extends boolean,
  Paginated extends boolean = false,
> = {
  <
    const Options extends QueryOptions<
      RelatedColumns<Rows, Relations, Target>,
      ShapeTools<Rows, Relations>
    >,
  >(
    options: QueryOptions<
      RelatedColumns<Rows, Relations, Target>,
      ShapeTools<Rows, Relations>
    > &
      Options &
      ValidQueryOptions<Options> & { readonly call?: never },
  ): RelationQuery<
    Rows,
    Relations,
    Target,
    Alias,
    Many,
    Paginated extends true
      ? true
      : Options extends { limit: unknown } | { offset: unknown }
        ? true
        : false
  >;
  <Shape extends Record<string, unknown>>(
    shape: ReusableShape<Target, Shape>,
    options?: QueryOptions<
      RelatedColumns<Rows, Relations, Target>,
      ShapeTools<Rows, Relations>,
      SelectedFields<ShapeSelection<Shape>>
    >,
  ): QueryColumn<
    Many extends true
      ? ProjectionRow<ShapeSelection<Shape>>[]
      : ProjectionRow<ShapeSelection<Shape>> | null,
    Alias,
    ProjectionTraits<ShapeSelection<Shape>>
  > &
    NestedResult;
  <
    const Shape extends Record<string, unknown>,
    const Options extends QueryOptions<
      RelatedColumns<Rows, Relations, Target>,
      ShapeTools<Rows, Relations>,
      SelectedFields<ShapeSelection<Shape>>
    > = {},
  >(
    shape: (
      columns: RelatedColumns<Rows, Relations, Target>,
      tools: ProjectionTools<
        Rows,
        Relations,
        RelatedColumns<Rows, Relations, Target>
      >,
    ) => Shape & ValidShape<Shape>,
    options?: QueryOptions<
      RelatedColumns<Rows, Relations, Target>,
      ShapeTools<Rows, Relations>,
      SelectedFields<ShapeSelection<Shape>>
    > &
      Options &
      ValidQueryOptions<Options>,
  ): keyof ShapeSelection<Shape> extends never
    ? RelationQuery<
        Rows,
        Relations,
        Target,
        Alias,
        Many,
        Paginated extends true
          ? true
          : Options extends { limit: unknown } | { offset: unknown }
            ? true
            : false
      >
    : QueryColumn<
        Many extends true
          ? ProjectionRow<ShapeSelection<Shape>>[]
          : ProjectionRow<ShapeSelection<Shape>> | null,
        Alias,
        ProjectionTraits<ShapeSelection<Shape>>
      > &
        NestedResult;
  readonly count: () => QueryColumn<number, "count">;
  readonly sum: (<
    Expression extends SelectedColumn<number | bigint | Decimal | null>,
  >(
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => Expression & Summable<Expression>,
  ) => QueryColumn<Decimal | null, "sum">) &
    AggregateFields<Rows[Target], "sum">;
  readonly average: (<
    Expression extends SelectedColumn<number | bigint | Decimal | null>,
  >(
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => Expression & Summable<Expression>,
  ) => QueryColumn<Decimal | null, "average">) &
    AggregateFields<Rows[Target], "average">;
  readonly minimum: (<Expression extends SelectedColumn>(
    selector: (columns: RelatedColumns<Rows, Relations, Target>) => Expression,
  ) => QueryColumn<
    ExpressionValue<Expression> | null,
    "minimum",
    TraitsOf<Expression>
  >) &
    AggregateFields<Rows[Target], "minimum">;
  readonly maximum: (<Expression extends SelectedColumn>(
    selector: (columns: RelatedColumns<Rows, Relations, Target>) => Expression,
  ) => QueryColumn<
    ExpressionValue<Expression> | null,
    "maximum",
    TraitsOf<Expression>
  >) &
    AggregateFields<Rows[Target], "maximum">;
  readonly exists: () => QueryColumn<boolean, "exists">;
} & (Paginated extends true
  ? {}
  : {
      readonly some: (
        predicate?: (
          columns: RelatedColumns<Rows, Relations, Target>,
        ) => Predicate,
      ) => Predicate;
      readonly none: (
        predicate?: (
          columns: RelatedColumns<Rows, Relations, Target>,
        ) => Predicate,
      ) => Predicate;
      readonly every: (
        predicate: (
          columns: RelatedColumns<Rows, Relations, Target>,
        ) => Predicate,
      ) => Predicate;
    });
type RelationMethods =
  | "as"
  | "count"
  | "sum"
  | "average"
  | "minimum"
  | "maximum"
  | "exists"
  | "some"
  | "none"
  | "every";
type RelationExpressions<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  Target extends string,
  Alias extends string,
  Nullable extends boolean,
  Many extends boolean,
  Path extends string,
> = RelationReference<Target, Alias, Nullable> &
  RelationQuery<Rows, Relations, Target, Alias, Many> & {
    readonly as: <const Name extends string>(
      name: Name,
    ) => RelationExpressions<
      Rows,
      Relations,
      Target,
      Name,
      Nullable,
      Many,
      Path
    >;
  } & (Many extends true
    ? {}
    : Omit<Columns<Rows[Target], Nullable, Path>, RelationMethods> &
        RelationFields<
          Rows,
          Relations,
          Target,
          Nullable,
          Path,
          RelationMethods
        >);
type ForeignKeyFields<
  Relations extends SchemaRelations,
  TableName extends string,
  Nullable extends boolean,
> = {
  readonly [Name in keyof Relations[TableName] &
    string as Relations[TableName][Name] extends { origin: `forward:${string}` }
    ? `${Name}Id`
    : never]: ForeignKeyReference<
    Relations[TableName][Name]["target"],
    Name,
    SmartNullable<{ optionalSource: Nullable }, Relations[TableName][Name]>
  >;
};
type RelationFields<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  TableName extends string,
  Nullable extends boolean,
  Path extends string,
  Excluded extends string = never,
> = ForeignKeyFields<Relations, TableName, Nullable> & {
  readonly [Name in Exclude<
    keyof Relations[TableName],
    keyof Rows[TableName] | Excluded
  > &
    string]: RelationExpressions<
    Rows,
    Relations,
    Relations[TableName][Name]["target"],
    Name,
    SmartNullable<{ optionalSource: Nullable }, Relations[TableName][Name]>,
    Relations[TableName][Name] extends { many: true } ? true : false,
    `${Path}.${Name}`
  >;
};
type RelatedColumns<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  TableName extends string,
> = Columns<Rows[TableName]> &
  RelationFields<Rows, Relations, TableName, false, TableName>;
export type CallbackScope<
  Scope extends QueryScope,
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
> = {
  readonly [AliasName in keyof Scope]: Columns<
    Scope[AliasName]["row"],
    Scope[AliasName]["nullable"],
    AliasName & string
  > &
    RelationFields<
      Rows,
      Relations,
      Scope[AliasName]["table"],
      Scope[AliasName] extends {
        optionalSource: infer Optional extends boolean;
      }
        ? Optional
        : Scope[AliasName]["nullable"],
      AliasName & string
    >;
};
export type ColumnSelection = readonly [SelectedColumn, ...SelectedColumn[]];
type RootRow<Scope extends QueryScope> = {
  [Alias in keyof Scope]: Scope[Alias] extends { root: true }
    ? Scope[Alias]["row"]
    : never;
}[keyof Scope];
declare const QUERY_RESULT: unique symbol;
declare const QUERY_TRAITS: unique symbol;
type NestedQuery = QueryReference & {
  readonly [QUERY_RESULT]: Record<string, unknown>;
};
export type ProjectionObject = {
  readonly [name: string]: SelectedColumn | ProjectionObject | NestedQuery;
};
export type Projection = ColumnSelection | ProjectionObject;
/**
 * The traits of a projection field: a column's, or a nested result's fields.
 * A projection known only by its index signature has none, which also ends
 * the recursion through `ProjectionObject`.
 */
type FieldTraits<Field> = Field extends SelectedColumn
  ? TraitsOf<Field>
  : Field extends { readonly [QUERY_TRAITS]: infer Traits }
    ? Traits
    : Field extends ProjectionObject
      ? string extends keyof Field
        ? {}
        : ProjectionTraits<Field>
      : {};
/**
 * The traits of a projection's fields that have any, so a derived table or CTE
 * built from it computes and compares its columns like their sources.
 */
type SelectionTraits<Selection extends Projection> =
  Selection extends readonly SelectedColumn[]
    ? {
        [Expression in Selection[number] as keyof TraitsOf<Expression> extends never
          ? never
          : Expression[typeof COLUMN_EXPRESSION]["outputName"]]: TraitsOf<Expression>;
      }
    : {
        [Name in keyof Selection as keyof FieldTraits<
          Selection[Name]
        > extends never
          ? never
          : Name]: FieldTraits<Selection[Name]>;
      };
/**
 * A nested result's traits (a relation, a selected query, a nested object in a
 * CTE): the JSON holds every field in its stored form, and a path reads each
 * field with its codec, so jsonb(schema) fields stay input-typed inside it.
 */
type ProjectionTraits<Selection extends Projection> =
  keyof SelectionTraits<Selection> extends never
    ? {}
    : { readonly fields: SelectionTraits<Selection> };
/** The row a derived table or CTE of a projection has. */
type DerivedRow<Selection extends Projection> = TraitedRow<
  ProjectionRow<Selection>,
  SelectionTraits<Selection>
>;
export type ProjectionRow<Selection extends Projection> =
  Selection extends readonly SelectedColumn[]
    ? {
        [Expression in Selection[number] as Expression[typeof COLUMN_EXPRESSION]["outputName"]]: ExpressionValue<Expression>;
      }
    : {
        -readonly [Name in keyof Selection]: Selection[Name] extends SelectedColumn
          ? ExpressionValue<Selection[Name]>
          : Selection[Name] extends NestedQuery
            ? Selection[Name][typeof QUERY_RESULT][]
            : Selection[Name] extends ProjectionObject
              ? ProjectionRow<Selection[Name]>
              : never;
      };
/** Query options; every value may also be a callback over the projection's source and tools. */
/** A predicate list; `undefined`, `null` and `false` entries are skipped, so optional filters need no branching. */
/** Predicates combined with AND; falsy entries (`q && …` with an empty `q`) are skipped. */
export type PredicateList = readonly (Predicate | SkippedPredicate)[];
export type ShapeControls = {
  readonly where?: Predicate | PredicateList;
  readonly orderBy?: Ordering | readonly [Ordering, ...Ordering[]];
  readonly limit?: number | Parameter<number>;
  readonly offset?: number | Parameter<number>;
  readonly groupBy?: ColumnSelection;
  readonly having?: Predicate | PredicateList;
  readonly distinct?: boolean;
  readonly forUpdate?: boolean | RowLockOptions;
  readonly forShare?: boolean | RowLockOptions;
};
/**
 * `orderBy`, `groupBy` and `having` callbacks also receive the projection's
 * fields, so a computed field is not written twice. `where` does not: it runs
 * before aggregates and windows exist.
 */
export type QueryOptions<Columns, Tools, Selected = {}> = {
  readonly [Name in keyof ShapeControls]?:
    | undefined
    | OptionValue<Name, Columns>
    | (Name extends "orderBy" | "groupBy" | "having"
        ? (
            columns: Columns,
            tools: Tools & { readonly selected: Selected },
            selected: Selected,
          ) => OptionValue<Name, Columns>
        : (columns: Columns, tools: Tools) => OptionValue<Name, Columns>);
};
/** What an option accepts: `where` and `orderBy` also take an object keyed by field. */
type OptionValue<Name extends keyof ShapeControls, Columns> =
  | ShapeControls[Name]
  | (Name extends "where" ? EqualityFilter<Columns> : never)
  | (Name extends "orderBy"
      ?
          | FieldOrder<Columns>
          | readonly [
              Ordering | FieldOrder<Columns>,
              ...(Ordering | FieldOrder<Columns>)[],
            ]
      : never);
/** The source's own columns, without its relations. */
export type RowColumns<Source> = {
  readonly [Name in keyof Source as Source[Name] extends SelectedColumn
    ? Name
    : never]: Source[Name];
};
/**
 * `where: { state: "draft", editorId: null }`: every listed column equals its
 * value, `null` is IS NULL, and an `undefined` value leaves the column out.
 */
export type EqualityFilter<Columns> = {
  readonly [Name in keyof RowColumns<Columns>]?:
    | (Columns[Name] extends {
        readonly is: (value: infer Value) => unknown;
      }
        ? Value
        : never)
    | undefined;
};
/**
 * `orderBy: { spent: "desc" }` over the source's columns and the selected
 * fields. Column names are offered and checked; a selected field is any other
 * name, checked when the query is built: typing those keys from the
 * projection would make TypeScript settle the projection's type too early.
 */
export type FieldOrder<Columns> = {
  readonly [Name in keyof RowColumns<Columns> & string]?:
    | OrderDirection
    | undefined;
} & { readonly [field: string]: OrderDirection | undefined };
/** A direction of an `orderBy` object, short or spelled out like the column property. */
export type OrderDirection = "asc" | "desc" | "ascending" | "descending";
/** A projection callback's tools: the shared ones and the source's own columns as `row`. */
type ProjectionTools<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  Source,
> = ShapeTools<Rows, Relations> & {
  /** Every column of the source, for `{ ...row, extra }`. */
  readonly row: RowColumns<Source>;
};
declare const NESTED_RESULT: unique symbol;
/** Marks a relation selected with a shape: rows or an object, not a value to sort or group by. */
type NestedResult = { readonly [NESTED_RESULT]: true };
/** The scalar fields of a projection, as its option callbacks receive them. */
export type SelectedFields<Selection> = Selection extends ProjectionObject
  ? {
      readonly [Name in keyof Selection as Selection[Name] extends SelectedColumn
        ? Selection[Name] extends NestedResult
          ? never
          : Name
        : never]: Selection[Name];
    }
  : {};
type ValidQueryOptions<Options> = {
  [Name in Exclude<keyof Options, keyof QueryOptions<never, never>>]: never;
};
/** A projection holds fields only; controls belong to the options object. */
type ValidShape<Shape> = {
  [Name in keyof Shape]: Name extends `$${string}`
    ? never
    : ProjectionObject[string];
};
/** The row type of a reusable shape, a built query or a prepared query result. */
export type InferShape<Source> =
  Source extends ReusableShape<string, infer Selection>
    ? ProjectionRow<ShapeSelection<Selection>>
    : Source extends { readonly execute: () => Promise<infer Result> }
      ? Result extends readonly (infer Row)[]
        ? Row
        : Result
      : never;

type ShapeSelection<Shape> = {
  [Name in keyof Shape as Name extends `$${string}` ? never : Name]: Extract<
    Shape[Name],
    ProjectionObject[string]
  >;
};
type ShapeJoin<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  Nullable extends boolean,
> = {
  <Target extends keyof Rows & string, Alias extends string>(
    relation: JoinReference<Target, Alias>,
  ): Columns<Rows[Target], Nullable, Alias> &
    RelationFields<Rows, Relations, Target, Nullable, Alias>;
  <
    Row extends Record<string, unknown>,
    Alias extends string,
    TableName extends string,
  >(
    source: TableSource<Row, Alias, TableName>,
    /** Required for a new JOIN; omitted to refer to an existing JOIN with the same explicit alias. */
    condition?: (
      columns: Columns<Row, false, Alias>,
    ) => Predicate | PredicateList,
  ): Columns<Row, Nullable, Alias> &
    RelationFields<Rows, Relations, TableName, Nullable, Alias>;
};
export type ShapeJoins<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
> = {
  readonly join: <
    Target extends keyof Rows & string,
    Alias extends string,
    Nullable extends boolean,
  >(
    relation: JoinReference<Target, Alias, Nullable>,
  ) => Columns<Rows[Target], Nullable, Alias> &
    RelationFields<Rows, Relations, Target, Nullable, Alias>;
  readonly innerJoin: ShapeJoin<Rows, Relations, false>;
  readonly leftJoin: ShapeJoin<Rows, Relations, true>;
  readonly crossJoin: {
    <Target extends keyof Rows & string, Alias extends string>(
      source: JoinReference<Target, Alias>,
    ): Columns<Rows[Target], false, Alias> &
      RelationFields<Rows, Relations, Target, false, Alias>;
    <
      Row extends Record<string, unknown>,
      Alias extends string,
      TableName extends string,
    >(
      source: TableSource<Row, Alias, TableName>,
    ): Columns<Row, false, Alias> &
      RelationFields<Rows, Relations, TableName, false, Alias>;
  };
};
export type ShapeTools<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
> = ShapeJoins<Rows, Relations> &
  typeof shapeExpressions & {
    /** Adds `IS NOT NULL` (for JSON, not JSON null either) and returns the column typed non-null. */
    readonly whereNotNull: <Expression extends SelectedColumn>(
      column: Expression,
    ) => QueryColumn<
      NonNullable<ExpressionValue<Expression>>,
      Expression[typeof COLUMN_EXPRESSION]["outputName"],
      TraitsOf<Expression>
    >;
  };
type SingleSelectedColumn<Selection> = Selection extends readonly [
  SelectedColumn,
]
  ? Selection[0]
  : Selection extends ProjectionObject
    ? {
        [Name in keyof Selection]: Exclude<keyof Selection, Name> extends never
          ? Selection[Name] extends SelectedColumn
            ? Selection[Name]
            : never
          : never;
      }[keyof Selection]
    : never;
type RootColumns<
  Scope extends QueryScope,
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
> = {
  [Alias in keyof Scope]: Scope[Alias] extends { root: true }
    ? Columns<Scope[Alias]["row"], Scope[Alias]["nullable"], Alias & string> &
        RelationFields<
          Rows,
          Relations,
          Scope[Alias]["table"],
          Scope[Alias]["nullable"],
          Alias & string
        >
    : never;
}[keyof Scope];
/** What runs a query that has fields: `await`, `execute()`, the row-count terminals, pages and streams. */
type Terminals<Selection extends Projection> = Preparable<
  ProjectionRow<Selection>[]
> & {
  readonly prepare: () => PreparedQuery<ProjectionRow<Selection>[]>;
  readonly toSQL: () => CompiledQuery;
  readonly execute: () => Promise<ProjectionRow<Selection>[]>;
  /** Queries are thenable: `await query` executes it like `execute()`. */
  readonly then: PromiseLike<ProjectionRow<Selection>[]>["then"];
  readonly catch: Promise<ProjectionRow<Selection>[]>["catch"];
  readonly finally: Promise<ProjectionRow<Selection>[]>["finally"];
  readonly inspect: (
    options?: InspectQueryOptions,
  ) => Promise<QueryInspection<ProjectionRow<Selection>>>;
  readonly first: () => Promise<ProjectionRow<Selection> | null>;
  readonly one: () => Promise<ProjectionRow<Selection>>;
  readonly maybeOne: () => Promise<ProjectionRow<Selection> | null>;
  /** `SELECT COUNT(*)` with the same filters; LIMIT, OFFSET, GROUP BY and DISTINCT count result rows. */
  readonly count: () => Promise<number>;
  /** `SELECT 1 … LIMIT 1`: whether at least one row matches. */
  readonly exists: () => Promise<boolean>;
  /** One keyset page; `after` moves forward, `before` backward (never both). */
  readonly page: (
    options: PageOptions<ProjectionRow<Selection>>,
  ) => Promise<Page<ProjectionRow<Selection>>>;
  /** Iterate keyset pages: `for await (const page of query.pages({ size: 100 }))`. */
  readonly pages: (options: {
    size: number;
    after?: PageCursor<ProjectionRow<Selection>> | null | undefined;
  }) => AsyncIterable<Page<ProjectionRow<Selection>>>;
  /**
   * Rows through a server-side cursor: `for await (const row of query.stream({ size: 1000 }))`.
   * Works for any SELECT; a connection stays reserved until iteration ends.
   */
  readonly stream: (options?: {
    size?: number;
  }) => AsyncIterable<ProjectionRow<Selection>>;
};
export type Query<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  RootTable extends string,
  Scope extends QueryScope = RootScope<Rows, RootTable>,
  Selection extends Projection | undefined = undefined,
> = {
  /**
   * Aggregates over the source as one object instead of an array of one row:
   * `orders.aggregate((order, { sum }) => ({ total: sum(order.amount) }))`.
   */
  readonly aggregate: <const Shape extends Record<string, unknown>>(
    shape: (
      columns: RootColumns<Scope, Rows, Relations>,
      tools: ProjectionTools<
        Rows,
        Relations,
        RootColumns<Scope, Rows, Relations>
      >,
    ) => Shape & ValidShape<Shape>,
  ) => Promise<ProjectionRow<ShapeSelection<Shape>>>;
  (
    options: QueryOptions<
      RootColumns<Scope, Rows, Relations>,
      ShapeTools<Rows, Relations>,
      SelectedFields<Selection>
    >,
  ): Query<Rows, Relations, RootTable, Scope, Selection> &
    // Options without fields read the root's own columns.
    ([Selection] extends [undefined]
      ? Terminals<RowColumns<RootColumns<Scope, Rows, Relations>>>
      : unknown);
  <Shape extends Record<string, unknown>>(
    shape: ReusableShape<RootTable, Shape>,
    options?: QueryOptions<
      RootColumns<Scope, Rows, Relations>,
      ShapeTools<Rows, Relations>,
      SelectedFields<ShapeSelection<Shape>>
    >,
  ): Query<Rows, Relations, RootTable, Scope, ShapeSelection<Shape>>;
  <const Shape extends Record<string, unknown>>(
    shape: (
      columns: RootColumns<Scope, Rows, Relations>,
      tools: ProjectionTools<
        Rows,
        Relations,
        RootColumns<Scope, Rows, Relations>
      >,
    ) => Shape & ValidShape<Shape>,
    options?: QueryOptions<
      RootColumns<Scope, Rows, Relations>,
      ShapeTools<Rows, Relations>,
      SelectedFields<
        keyof ShapeSelection<Shape> extends never
          ? Selection
          : ShapeSelection<Shape>
      >
    >,
  ): Query<
    Rows,
    Relations,
    RootTable,
    Scope,
    keyof ShapeSelection<Shape> extends never
      ? Selection
      : ShapeSelection<Shape>
  >;
} & (Selection extends Projection
  ? QueryReference &
      Terminals<Selection> & {
        readonly [QUERY_RESULT]: ProjectionRow<Selection>;
        readonly [QUERY_TRAITS]: ProjectionTraits<Selection>;
        readonly as: <const AliasName extends string>(
          name: AliasName,
        ) => DerivedQuery<Rows, Relations, DerivedRow<Selection>, AliasName>;
        readonly cte: <const Name extends string>(
          name: Name,
          options?: { materialized?: boolean },
        ) => DerivedQuery<Rows, Relations, DerivedRow<Selection>, Name>;
        readonly recursive: <const Name extends string>(
          name: Name,
          step: (
            self: DerivedQuery<Rows, Relations, DerivedRow<Selection>, Name>,
          ) => QueryReference & {
            execute: () => Promise<ProjectionRow<Selection>[]>;
          },
          options?: { unionAll?: boolean },
        ) => DerivedQuery<Rows, Relations, DerivedRow<Selection>, Name>;
      } & ([SingleSelectedColumn<Selection>] extends [never]
        ? {}
        : ScalarQuery<ExpressionValue<SingleSelectedColumn<Selection>>> & {
            readonly scalar: () => QueryColumn<
              ExpressionValue<SingleSelectedColumn<Selection>> | null,
              "scalar",
              TraitsOf<SingleSelectedColumn<Selection>>
            >;
          })
  : {
      /** `SELECT COUNT(*)` over the source and its filters. */
      readonly count: () => Promise<number>;
      /** Whether at least one row matches the source and its filters. */
      readonly exists: () => Promise<boolean>;
      readonly as: <const AliasName extends string>(
        name: AliasName,
      ) => Query<
        Rows,
        Relations,
        RootTable,
        {
          [Alias in AliasName]: {
            row: RootRow<Scope>;
            table: RootTable;
            nullable: false;
            root: true;
          };
        }
      > &
        TableSource<RootRow<Scope>, AliasName, RootTable>;
    });

type DerivedQuery<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  Row extends Record<string, unknown>,
  AliasName extends string,
> = Query<
  Rows,
  Relations,
  // A projected source has no base-table identity, even if its alias matches one.
  string,
  {
    [Alias in AliasName]: {
      row: Row;
      table: string;
      nullable: false;
      root: true;
    };
  }
> &
  TableSource<Row, AliasName>;
/** What one declared search accepts: a question, and an embedding where it matches meaning. */
type SearchInput<Declared> = Declared extends { readonly meaning: true }
  ?
      | string
      | readonly number[]
      | { readonly text?: string; readonly vector?: readonly number[] }
  : string | { readonly text: string };

/** Rows of a search, best first. `partial` is set when a search asked for could not be used. */
export type SearchRows<Row> = Row[] & { readonly partial?: PartialSearch };

export type SearchQuery<Row> = PromiseLike<SearchRows<Row>> & {
  readonly execute: () => Promise<SearchRows<Row>>;
  /** The statement, once the question's embedding is known. */
  readonly toSQL: () => Promise<{ sql: string; parameters: unknown[] }>;
  readonly catch: Promise<SearchRows<Row>>["catch"];
  readonly finally: Promise<SearchRows<Row>>["finally"];
};

type SearchOptions<Columns, Tools, Searches> = {
  readonly where?: QueryOptions<Columns, Tools>["where"];
  /** How many rows to return; 10 unless given. */
  readonly limit?: number;
  /** How many rows each way of searching contributes before they are merged. */
  readonly candidates?: number;
} & { readonly [Name in keyof Searches]?: SearchInput<Searches[Name]> };

/**
 * `table.search()`: rows ranked by the searches the table declares, by words
 * and meaning at once where both are declared, in one statement.
 */
export type TableSearch<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  RootTable extends string,
  Searches,
> = {
  (
    options: SearchOptions<
      RootColumns<RootScope<Rows, RootTable>, Rows, Relations>,
      ShapeTools<Rows, Relations>,
      Searches
    >,
  ): SearchQuery<
    ProjectionRow<
      RowColumns<RootColumns<RootScope<Rows, RootTable>, Rows, Relations>>
    >
  >;
  <Shape extends Record<string, unknown>>(
    shape: ReusableShape<RootTable, Shape>,
    options: SearchOptions<
      RootColumns<RootScope<Rows, RootTable>, Rows, Relations>,
      ShapeTools<Rows, Relations>,
      Searches
    >,
  ): SearchQuery<ProjectionRow<ShapeSelection<Shape>>>;
  <const Shape extends Record<string, unknown>>(
    shape: (
      columns: RootColumns<RootScope<Rows, RootTable>, Rows, Relations>,
      tools: ProjectionTools<
        Rows,
        Relations,
        RootColumns<RootScope<Rows, RootTable>, Rows, Relations>
      >,
    ) => Shape & ValidShape<Shape>,
    options: SearchOptions<
      RootColumns<RootScope<Rows, RootTable>, Rows, Relations>,
      ShapeTools<Rows, Relations>,
      Searches
    >,
  ): SearchQuery<ProjectionRow<ShapeSelection<Shape>>>;
  /**
   * Computes the embeddings that are missing: rows written before the search
   * was declared, or whose text an UPDATE changed. Resolves to their number.
   */
  readonly reindex: (options?: {
    readonly where?: QueryOptions<
      RootColumns<RootScope<Rows, RootTable>, Rows, Relations>,
      ShapeTools<Rows, Relations>
    >["where"];
    readonly batch?: number;
  }) => Promise<number>;
};

export type QueryTable<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  RootTable extends string,
  Insert extends Record<string, unknown>,
  KeyNames extends StringKeys<Rows[RootTable]> = "id" &
    StringKeys<Rows[RootTable]>,
  UniqueKeys = {},
> = Query<Rows, Relations, RootTable> &
  TableSource<Rows[RootTable], RootTable, RootTable> &
  TableMutations<
    Rows[RootTable],
    Insert,
    RootTable,
    keyof Relations[RootTable] & string,
    RelatedColumns<Rows, Relations, RootTable>
  > & {
    readonly shape: <const Shape extends ProjectionObject>(
      callback: (
        columns: RelatedColumns<Rows, Relations, RootTable>,
        tools: ProjectionTools<
          Rows,
          Relations,
          RelatedColumns<Rows, Relations, RootTable>
        >,
      ) => Shape &
        (keyof Shape extends never ? never : unknown) & {
          [Name in keyof Shape]: Name extends `$${string}`
            ? never
            : Shape[Name];
        },
    ) => ReusableShape<RootTable, Shape>;
    readonly by: {
      readonly [Name in keyof UniqueKeys & string]: (
        value: LookupKey<
          Rows[RootTable],
          UniqueKeys[Name] & keyof Rows[RootTable]
        >,
      ) => KeyLookup<Rows, Relations, RootTable, Insert>;
    };
  } & ([KeyNames] extends [never]
    ? {}
    : {
        readonly byId: (
          value: LookupKey<Rows[RootTable], KeyNames>,
        ) => KeyLookup<Rows, Relations, RootTable, Insert>;
      }) &
  ([KeyNames] extends [never]
    ? [keyof UniqueKeys] extends [never]
      ? {}
      : KeyReads<Rows, Relations, RootTable, never, UniqueKeys>
    : KeyReads<Rows, Relations, RootTable, KeyNames, UniqueKeys>);
type KeyReads<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  RootTable extends string,
  KeyNames extends StringKeys<Rows[RootTable]>,
  UniqueKeys,
> = {
  /**
   * The row with this primary key, or with a unique key given by its columns
   * (`get({ email })`); rejects with `NotFoundError` when there is none.
   */
  readonly get: KeyRead<
    Rows,
    Relations,
    RootTable,
    KeyNames,
    UniqueKeys,
    never
  >;
  /** The row with this primary key or unique key (`find({ email })`), or `null`. */
  readonly find: KeyRead<
    Rows,
    Relations,
    RootTable,
    KeyNames,
    UniqueKeys,
    null
  >;
};
/** A key as an object of its columns: the primary key or any unique key. */
type KeyObject<Row, KeyNames extends keyof Row, UniqueKeys> =
  | ([KeyNames] extends [never] ? never : KeyColumns<Row, KeyNames>)
  | {
      [Name in keyof UniqueKeys]: KeyColumns<Row, UniqueKeys[Name] & keyof Row>;
    }[keyof UniqueKeys];
type KeyColumns<Row, Names extends keyof Row> = {
  readonly [Name in Names]:
    | NonNullable<Row[Name]>
    | Parameter<NonNullable<Row[Name]>>;
};
/** `get()` / `find()`: the whole row, or the fields a shape selects. */
type KeyRead<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  RootTable extends string,
  KeyNames extends StringKeys<Rows[RootTable]>,
  UniqueKeys,
  Missing,
> = {
  (
    value:
      | LookupKey<Rows[RootTable], KeyNames>
      | KeyObject<Rows[RootTable], KeyNames, UniqueKeys>,
  ): Promise<ProjectionRow<Columns<Rows[RootTable]>> | Missing>;
  <const Shape extends Record<string, unknown>>(
    value:
      | LookupKey<Rows[RootTable], KeyNames>
      | KeyObject<Rows[RootTable], KeyNames, UniqueKeys>,
    shape: (
      columns: RelatedColumns<Rows, Relations, RootTable>,
      tools: ProjectionTools<
        Rows,
        Relations,
        RelatedColumns<Rows, Relations, RootTable>
      >,
    ) => Shape & ValidShape<Shape>,
  ): Promise<ProjectionRow<ShapeSelection<Shape>> | Missing>;
};
type KeyLookup<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  TableName extends string,
  Insert extends Record<string, unknown>,
> = Query<
  Rows,
  Relations,
  TableName,
  RootScope<Rows, TableName>,
  Columns<Rows[TableName]>
> &
  Pick<
    TableMutations<
      Rows[TableName],
      Insert,
      TableName,
      keyof Relations[TableName] & string,
      RelatedColumns<Rows, Relations, TableName>
    >,
    "update" | "delete"
  >;
type LookupKey<Row, KeyNames extends keyof Row> = {
  [Name in KeyNames]: [Exclude<KeyNames, Name>] extends [never]
    ? NonNullable<Row[Name]> | Parameter<NonNullable<Row[Name]>>
    : {
        [Key in KeyNames]:
          | NonNullable<Row[Key]>
          | Parameter<NonNullable<Row[Key]>>;
      };
}[KeyNames];

export type RuntimeScope = Record<
  string,
  Record<string, QueryColumn<unknown, string>>
>;
