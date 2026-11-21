/**
 * The types of writes: what insert(), update(), delete() and upsert() accept
 * and what each builder resolves to.
 */
import type { DeferredError } from "../codecs/deferred";
import type {
  Predicate,
  PredicateDescription,
  SelectedColumn,
} from "../expressions";
import type {
  Awaitable,
  CompiledQuery,
  DEFAULT_VALUE,
  QueryExecutor,
  SelectPlan,
} from "../plan/types";
import type {
  Columns,
  Projection,
  ProjectionRow,
  RuntimeScope,
} from "../select";
import type { Preparable, PreparedQuery } from "../select/prepared";
import type { ReturningTools, ReusableShape } from "../select/projections";
import type { EqualityFilter, PredicateList } from "../select/types";

/** Optional write fields accept `undefined` as "omitted", even under exactOptionalPropertyTypes. */
type InputValues<Insert extends Record<string, unknown>> = {
  [ColumnName in keyof Insert]:
    | Insert[ColumnName]
    | SelectedColumn<Exclude<Insert[ColumnName], undefined>>
    | ({} extends Pick<Insert, ColumnName>
        ? typeof DEFAULT_VALUE | undefined
        : never);
};
/** The `update()` / `doUpdate()` input: every field optional, SQL expressions and `defaultValue` allowed. */
export type UpdateValues<Insert extends Record<string, unknown>> = {
  [ColumnName in keyof Insert]?:
    | Exclude<Insert[ColumnName], undefined>
    | SelectedColumn<Exclude<Insert[ColumnName], undefined>>
    | ({} extends Pick<Insert, ColumnName> ? typeof DEFAULT_VALUE : never)
    | undefined;
};
type WritableColumnNames<Insert> = {
  [Name in keyof Insert & string]: [Exclude<Insert[Name], undefined>] extends [
    never,
  ]
    ? never
    : Name;
}[keyof Insert & string];

/** The column names of a row type: its string keys. */
type ColumnNames<Row extends Record<string, unknown>> = keyof Columns<Row> &
  string;
/**
 * The options form of `.where()`: a callback, predicates, or an object of
 * equalities (`{ id: 1 }`), which must name at least one column.
 */
export type WriteOptions<WhereScope> = {
  readonly where?:
    | Predicate
    | PredicateList
    | EqualityFilter<WhereScope>
    | ((
        scope: WhereScope,
      ) => Predicate | PredicateList | EqualityFilter<WhereScope>)
    | undefined;
};
/** `upsert()`: the conflict key and, optionally, the columns an existing row takes. */
export type UpsertOptions<
  Row extends Record<string, unknown>,
  Insert,
  KeyNames extends string = never,
> = {
  /**
   * The primary key or a unique key: one column, all columns of a composite
   * key, or the key's name (`by.<name>`).
   */
  readonly by:
    | ColumnNames<Row>
    | KeyNames
    | readonly [ColumnNames<Row>, ...ColumnNames<Row>[]];
  /** Columns to overwrite on conflict; by default every column the rows carry except the key. */
  readonly update?: readonly WritableColumnNames<Insert>[] | undefined;
};

/** Runs several statements atomically: a transaction, or a savepoint inside one. */
export type AtomicRunner = <Result>(
  run: (executor: QueryExecutor) => Promise<Result>,
) => Promise<Result>;

/** Hooks a table's query machinery hands to its mutations: $scope() filters and relation-path contexts. */
export type MutationOptions = {
  readonly atomic?: AtomicRunner;
  /**
   * The rows an UPDATE or DELETE may reach, evaluated each time a write is
   * built: the `$scope()` predicates, plus a lookup's key. Its `$scope()`
   * predicates are also checked against every row an INSERT or UPDATE writes.
   */
  readonly scope?: () => readonly PredicateDescription[];
  readonly context?: (plan: SelectPlan) => {
    readonly plan: SelectPlan;
    readonly scope: () => RuntimeScope;
  };
  /** A data error of the lookup the write starts from. */
  readonly failure?: DeferredError;
};

type FlatInsert<
  Insert extends Record<string, unknown>,
  RelationNames extends string,
> = InputValues<Insert> & { [Name in RelationNames]?: undefined };

/** `insert(object)` resolves to one row, `insert(array)` to an array; DO NOTHING may skip the row. */
type MutationResult<
  Selection extends Projection | undefined,
  Single extends boolean,
  Optional extends boolean = false,
> = Selection extends Projection
  ? Single extends true
    ? ProjectionRow<Selection> | (Optional extends true ? null : never)
    : ProjectionRow<Selection>[]
  : { affectedRows: number };

export type NestedInsertQuery<
  Row extends Record<string, unknown>,
  TableName extends string,
  Single extends boolean,
  Selection extends Projection | undefined = undefined,
> = {
  readonly returning: {
    /** The whole inserted row. */
    (): NestedInsertQuery<Row, TableName, Single, Columns<Row>>;
    <const Names extends readonly [ColumnNames<Row>, ...ColumnNames<Row>[]]>(
      ...columns: Names
    ): NestedInsertQuery<
      Row,
      TableName,
      Single,
      Pick<Columns<Row>, Names[number]>
    >;
    <const NextSelection extends Projection>(
      selector:
        | ((row: Columns<Row>, tools: ReturningTools) => NextSelection)
        | ReusableShape<TableName, NextSelection>,
    ): NestedInsertQuery<Row, TableName, Single, NextSelection>;
  };
  readonly execute: () => Promise<MutationResult<Selection, Single>>;
} & Awaitable<MutationResult<Selection, Single>>;
type Mutation<
  Row extends Record<string, unknown>,
  Insert extends Record<string, unknown>,
  TableName extends string,
  Kind extends "insert" | "update" | "delete",
  Selection extends Projection | undefined = undefined,
  Single extends boolean = false,
  Optional extends boolean = false,
  WhereScope = Columns<Row>,
  /** Names of the table's unique keys, which onConflict() takes as well as columns. */
  KeyNames extends string = never,
> = Preparable<MutationResult<Selection, Single, Optional>, "mutation"> & {
  readonly prepare: () => PreparedQuery<
    MutationResult<Selection, Single, Optional>,
    Record<never, never>,
    "mutation"
  >;
  readonly returning: {
    /** The whole written row. */
    (): Mutation<
      Row,
      Insert,
      TableName,
      Kind,
      Columns<Row>,
      Single,
      Optional,
      WhereScope,
      KeyNames
    >;
    /** The named columns. */
    <const Names extends readonly [ColumnNames<Row>, ...ColumnNames<Row>[]]>(
      ...columns: Names
    ): Mutation<
      Row,
      Insert,
      TableName,
      Kind,
      Pick<Columns<Row>, Names[number]>,
      Single,
      Optional,
      WhereScope,
      KeyNames
    >;
    <const NextSelection extends Projection>(
      selector:
        | ((row: Columns<Row>, tools: ReturningTools) => NextSelection)
        | ReusableShape<TableName, NextSelection>,
    ): Mutation<
      Row,
      Insert,
      TableName,
      Kind,
      NextSelection,
      Single,
      Optional,
      WhereScope,
      KeyNames
    >;
  };
  readonly toSQL: () => CompiledQuery;
  readonly execute: () => Promise<MutationResult<Selection, Single, Optional>>;
} & Awaitable<MutationResult<Selection, Single, Optional>> &
  (Kind extends "insert"
    ? {
        /** The conflict target: its columns, or the name of a unique key (`by.<name>`). */
        readonly onConflict: (
          ...target: (keyof Row & string)[] | [KeyNames]
        ) => {
          readonly doNothing: () => Mutation<
            Row,
            Insert,
            TableName,
            Kind,
            Selection,
            Single,
            true
          >;
          readonly doUpdate: {
            /** Update only when `where` holds for the conflicting row; otherwise nothing is written and a single `returning()` is `null`. */
            (
              values:
                | UpdateValues<Insert>
                | ((
                    row: Columns<Row>,
                    excluded: Columns<Row>,
                  ) => UpdateValues<Insert>),
              options: {
                readonly where: (
                  row: Columns<Row>,
                  excluded: Columns<Row>,
                ) => Predicate | PredicateList;
              },
            ): Mutation<Row, Insert, TableName, Kind, Selection, Single, true>;
            (
              first: WritableColumnNames<Insert>,
              ...columns: WritableColumnNames<Insert>[]
            ): Mutation<
              Row,
              Insert,
              TableName,
              Kind,
              Selection,
              Single,
              Optional
            >;
            (
              values:
                | UpdateValues<Insert>
                | ((
                    row: Columns<Row>,
                    excluded: Columns<Row>,
                  ) => UpdateValues<Insert>),
            ): Mutation<
              Row,
              Insert,
              TableName,
              Kind,
              Selection,
              Single,
              Optional
            >;
          };
        };
      }
    : {
        /** Relation paths and quantifiers compile to a primary-key subquery. */
        readonly where: (
          predicate: (scope: WhereScope) => Predicate | PredicateList,
        ) => Mutation<
          Row,
          Insert,
          TableName,
          Kind,
          Selection,
          Single,
          Optional,
          WhereScope,
          KeyNames
        >;
        /** Confirms a whole-table UPDATE or DELETE; without where() or all() the statement is refused. */
        readonly all: () => Mutation<
          Row,
          Insert,
          TableName,
          Kind,
          Selection,
          Single,
          Optional,
          WhereScope,
          KeyNames
        >;
      });

export type TableMutations<
  Row extends Record<string, unknown>,
  Insert extends Record<string, unknown>,
  TableName extends string,
  RelationNames extends string = never,
  WhereScope = Columns<Row>,
  /** Names of the table's unique keys, as `by.<name>` lists them. */
  KeyNames extends string = never,
> = {
  readonly insert: {
    (
      values: readonly FlatInsert<Insert, RelationNames>[],
    ): Mutation<
      Row,
      Insert,
      TableName,
      "insert",
      undefined,
      false,
      false,
      Columns<Row>,
      KeyNames
    >;
    (
      values: FlatInsert<Insert, RelationNames>,
    ): Mutation<
      Row,
      Insert,
      TableName,
      "insert",
      undefined,
      true,
      false,
      Columns<Row>,
      KeyNames
    >;
  };
  /** Insert, or overwrite the row that has the same key: `upsert(row, { by: "sku" })`. */
  readonly upsert: {
    (
      values: readonly FlatInsert<Insert, RelationNames>[],
      options: UpsertOptions<Row, Insert, KeyNames>,
    ): Mutation<Row, Insert, TableName, "insert", undefined, false>;
    (
      values: FlatInsert<Insert, RelationNames>,
      options: UpsertOptions<Row, Insert, KeyNames>,
    ): Mutation<Row, Insert, TableName, "insert", undefined, true>;
  };
  readonly update: (
    values:
      | UpdateValues<Insert>
      | ((row: Columns<Row>) => UpdateValues<Insert>),
    options?: WriteOptions<WhereScope>,
  ) => Mutation<
    Row,
    Insert,
    TableName,
    "update",
    undefined,
    false,
    false,
    WhereScope
  >;
  readonly delete: (
    options?: WriteOptions<WhereScope>,
  ) => Mutation<
    Row,
    Insert,
    TableName,
    "delete",
    undefined,
    false,
    false,
    WhereScope
  >;
};
