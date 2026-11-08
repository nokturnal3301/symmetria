/** Type-level API of queries: scopes, projections, relations, options and the query handle. */
import {
  COLUMN_EXPRESSION,
  type ExpressionValue,
  type Ordering,
  type Predicate,
  type QueryColumn,
  type ScalarQuery,
  type SelectedColumn,
  type Parameter,
} from "../expressions";
import type {
  CompiledQuery,
  QueryReference,
  RowLockOptions,
  TableBinding,
  TableSource,
} from "../plan/types";
import type { TableMutations } from "../write/mutations";
import type { PreparedQuery, Preparable } from "./prepared";
import type { Page, PageCursor, PageOptions } from "./pagination";
import type {
  InspectQueryOptions,
  QueryInspection,
} from "../../observability/inspection";
import type { ReusableShape } from "./projections";
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
export type Columns<
  Row extends Record<string, unknown>,
  Nullable extends boolean = false,
  Alias extends string = string,
> = {
  readonly [ColumnName in StringKeys<Row>]: QueryColumn<
    Row[ColumnName] | (Nullable extends true ? null : never),
    ColumnName
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
    ? NonNullable<Row[Key]> extends number | bigint | string
      ? Key
      : never
    : Key]: QueryColumn<
    Name extends "sum" | "average" ? string | null : Row[Key] | null,
    Name
  >;
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
      ShapeTools<Rows, Relations>
    >,
  ): QueryColumn<
    Many extends true
      ? ProjectionRow<ShapeSelection<Shape>>[]
      : ProjectionRow<ShapeSelection<Shape>> | null,
    Alias
  >;
  <
    const Shape extends Record<string, unknown>,
    const Options extends QueryOptions<
      RelatedColumns<Rows, Relations, Target>,
      ShapeTools<Rows, Relations>
    > = {},
  >(
    shape: (
      columns: RelatedColumns<Rows, Relations, Target>,
      tools: ShapeTools<Rows, Relations>,
    ) => Shape & ValidShape<Shape>,
    options?: QueryOptions<
      RelatedColumns<Rows, Relations, Target>,
      ShapeTools<Rows, Relations>
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
        Alias
      >;
  readonly count: () => QueryColumn<number, "count">;
  readonly sum: ((
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<number | bigint | string | null>,
  ) => QueryColumn<string | null, "sum">) &
    AggregateFields<Rows[Target], "sum">;
  readonly average: ((
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<number | bigint | string | null>,
  ) => QueryColumn<string | null, "average">) &
    AggregateFields<Rows[Target], "average">;
  readonly minimum: (<Value>(
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<Value>,
  ) => QueryColumn<Value | null, "minimum">) &
    AggregateFields<Rows[Target], "minimum">;
  readonly maximum: (<Value>(
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<Value>,
  ) => QueryColumn<Value | null, "maximum">) &
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
type NestedQuery = QueryReference & {
  readonly [QUERY_RESULT]: Record<string, unknown>;
};
export type ProjectionObject = {
  readonly [name: string]: SelectedColumn | ProjectionObject | NestedQuery;
};
export type Projection = ColumnSelection | ProjectionObject;
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
export type PredicateList = readonly (Predicate | undefined | null | false)[];
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
export type QueryOptions<Columns, Tools> = {
  readonly [Name in keyof ShapeControls]?:
    | undefined
    | ShapeControls[Name]
    | ((columns: Columns, tools: Tools) => ShapeControls[Name]);
};
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
    readonly whereNotNull: <Value, Name extends string>(
      column: QueryColumn<Value, Name>,
    ) => QueryColumn<NonNullable<Value>, Name>;
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
export type Query<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  RootTable extends string,
  Scope extends QueryScope = RootScope<Rows, RootTable>,
  Selection extends Projection | undefined = undefined,
> = {
  (
    options: QueryOptions<
      RootColumns<Scope, Rows, Relations>,
      ShapeTools<Rows, Relations>
    >,
  ): Query<Rows, Relations, RootTable, Scope, Selection>;
  <Shape extends Record<string, unknown>>(
    shape: ReusableShape<RootTable, Shape>,
    options?: QueryOptions<
      RootColumns<Scope, Rows, Relations>,
      ShapeTools<Rows, Relations>
    >,
  ): Query<Rows, Relations, RootTable, Scope, ShapeSelection<Shape>>;
  <const Shape extends Record<string, unknown>>(
    shape: (
      columns: RootColumns<Scope, Rows, Relations>,
      tools: ShapeTools<Rows, Relations>,
    ) => Shape & ValidShape<Shape>,
    options?: QueryOptions<
      RootColumns<Scope, Rows, Relations>,
      ShapeTools<Rows, Relations>
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
      Preparable<ProjectionRow<Selection>[]> & {
        readonly [QUERY_RESULT]: ProjectionRow<Selection>;
        readonly prepare: () => PreparedQuery<ProjectionRow<Selection>[]>;
        readonly toSQL: () => CompiledQuery;
        readonly execute: () => Promise<ProjectionRow<Selection>[]>;
        /** Queries are thenable: `await query` executes it like `execute()`. */
        readonly then: PromiseLike<ProjectionRow<Selection>[]>["then"];
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
        readonly as: <const AliasName extends string>(
          name: AliasName,
        ) => DerivedQuery<Rows, Relations, ProjectionRow<Selection>, AliasName>;
        readonly cte: <const Name extends string>(
          name: Name,
          options?: { materialized?: boolean },
        ) => DerivedQuery<Rows, Relations, ProjectionRow<Selection>, Name>;
        readonly recursive: <const Name extends string>(
          name: Name,
          step: (
            self: DerivedQuery<Rows, Relations, ProjectionRow<Selection>, Name>,
          ) => QueryReference & {
            execute: () => Promise<ProjectionRow<Selection>[]>;
          },
          options?: { unionAll?: boolean },
        ) => DerivedQuery<Rows, Relations, ProjectionRow<Selection>, Name>;
      } & ([SingleSelectedColumn<Selection>] extends [never]
        ? {}
        : ScalarQuery<ExpressionValue<SingleSelectedColumn<Selection>>> & {
            readonly scalar: () => QueryColumn<
              ExpressionValue<SingleSelectedColumn<Selection>> | null,
              "scalar"
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
        tools: ShapeTools<Rows, Relations>,
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
      });
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
