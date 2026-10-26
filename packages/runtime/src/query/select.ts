import type { ColumnSnapshot, SchemaSnapshot } from "../schema/assembly";
import { booleanCodec, codecFor, type SchemaCodecs } from "./codecs";
import { compilePlan, executePlan, quoteIdentifier } from "./compiler";
import { jsonRowCodec } from "./json-codecs";
import {
  COLUMN_EXPRESSION,
  ORDERING_EXPRESSION,
  createExpression,
  count,
  and,
  or,
  not,
  when,
  exists,
  notExists,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  sql,
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  over,
  predicate,
  readColumn,
  readPredicate,
  valueNode,
  type ExpressionDescription,
  type ExpressionValue,
  type Ordering,
  type Predicate,
  type QueryColumn,
  type ScalarQuery,
  type SelectedColumn,
  type ValueNode,
  type PredicateDescription,
} from "./expressions";
import {
  QUERY_PLAN,
  TABLE_SOURCE,
  mergeBindings,
  containsBinding,
  numberedAlias,
  type CompiledQuery,
  type ExecutionResult,
  type JoinDescription,
  type SourceDescription,
  type QueryExecutor,
  type QueryReference,
  type SelectPlan,
  type TableBinding,
  type TableSource,
  type RowLockOptions,
  type CommonTableExpression,
  type Dialect,
} from "./state";
import {
  createMutation,
  type TableMutations,
  type AtomicRunner,
  type MutationOptions,
} from "./mutations";
import {
  PREPARE_QUERY,
  preparePlan,
  type PreparedQuery,
  type Preparable,
} from "./prepared";
import type { Parameter, PlaceholderNode } from "./expressions";
import { computedFields } from "../schema/computed";
import { executePage, type Page, type PageCursor } from "./pagination";
import { derivedBinding } from "./derived";
import { queryOccurrence } from "./occurrence";
import type {
  InspectQueryOptions,
  QueryInspection,
} from "../observability/inspection";
import { executorProfiling } from "../observability/profiling";
import { boundMethodDescriptors, callable, extendBuilder } from "./callable";

export * from "./expressions";
export type {
  CompiledQuery,
  QueryExecutor,
  Driver,
  ExecutionResult,
} from "./state";
export { DEFAULT_VALUE as defaultValue } from "./state";

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
const RELATION_SOURCE = Symbol("symmetria.query.relation");
const SHAPE_SOURCE = Symbol("symmetria.query.shape");
type ReusableShape<TableName extends string, Shape> = {
  readonly [SHAPE_SOURCE]: {
    readonly table: TableName;
    readonly selection: Shape;
  };
};
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
type JoinReference<
  Target extends string = string,
  Alias extends string = string,
  Nullable extends boolean = boolean,
> =
  | RelationReference<Target, Alias, Nullable>
  | ForeignKeyReference<Target, Alias, Nullable>;
type RelationReference<
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
type RelationQuery<
  Rows extends SchemaRows,
  Relations extends SchemaRelations,
  Target extends string,
  Alias extends string,
  Many extends boolean,
  Paginated extends boolean = false,
> = {
  <Shape extends Record<string, unknown>>(
    shape: ReusableShape<Target, Shape>,
  ): QueryColumn<
    Many extends true
      ? ProjectionRow<ShapeSelection<Shape>>[]
      : ProjectionRow<ShapeSelection<Shape>> | null,
    Alias
  >;
  <const Shape extends Record<string, unknown>>(
    shape: (
      columns: RelatedColumns<Rows, Relations, Target>,
      tools: ShapeTools<Rows, Relations>,
    ) => Shape & ValidShape<Shape>,
  ): keyof ShapeSelection<Shape> extends never
    ? RelationQuery<
        Rows,
        Relations,
        Target,
        Alias,
        Many,
        Paginated extends true
          ? true
          : Shape extends { $limit: unknown } | { $offset: unknown }
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
  readonly sum: (
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<number | bigint | string | null>,
  ) => QueryColumn<string | null, "sum">;
  readonly average: (
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<number | bigint | string | null>,
  ) => QueryColumn<string | null, "average">;
  readonly minimum: <Value>(
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<Value>,
  ) => QueryColumn<Value | null, "minimum">;
  readonly maximum: <Value>(
    selector: (
      columns: RelatedColumns<Rows, Relations, Target>,
    ) => SelectedColumn<Value>,
  ) => QueryColumn<Value | null, "maximum">;
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
export type ShapeControls = {
  readonly $where?: Predicate | readonly Predicate[];
  readonly $orderBy?: Ordering | readonly [Ordering, ...Ordering[]];
  readonly $limit?: number | Parameter<number>;
  readonly $offset?: number | Parameter<number>;
  readonly $groupBy?: ColumnSelection;
  readonly $having?: Predicate | readonly Predicate[];
  readonly $distinct?: boolean;
  readonly $forUpdate?: boolean | RowLockOptions;
  readonly $forShare?: boolean | RowLockOptions;
};
type ValidShape<Shape> = {
  [Name in keyof Shape]: Name extends keyof ShapeControls
    ? ShapeControls[Name]
    : Name extends `$${string}`
      ? never
      : ProjectionObject[string];
};
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
    condition: (
      columns: Columns<Row, false, Alias>,
    ) => Predicate | readonly Predicate[],
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
const shapeExpressions = Object.freeze({
  and,
  or,
  not,
  when,
  exists,
  notExists,
  count,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  sql,
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  over,
});
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
  <Shape extends Record<string, unknown>>(
    shape: ReusableShape<RootTable, Shape>,
  ): Query<Rows, Relations, RootTable, Scope, ShapeSelection<Shape>>;
  <const Shape extends Record<string, unknown>>(
    shape: (
      columns: RootColumns<Scope, Rows, Relations>,
      tools: ShapeTools<Rows, Relations>,
    ) => Shape & ValidShape<Shape>,
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
        readonly page: (options: {
          size: number;
          after?: PageCursor<ProjectionRow<Selection>> | null | undefined;
        }) => Promise<Page<ProjectionRow<Selection>>>;
        /** Iterate keyset pages: `for await (const page of query.pages({ size: 100 }))`. */
        readonly pages: (options: {
          size: number;
          after?: PageCursor<ProjectionRow<Selection>> | null | undefined;
        }) => AsyncIterable<Page<ProjectionRow<Selection>>>;
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
      ) => Query<
        Rows,
        Relations,
        RootTable,
        RootScope<Rows, RootTable>,
        Columns<Rows[RootTable]>
      >;
    };
  } & ([KeyNames] extends [never]
    ? {}
    : {
        readonly byId: (
          value: LookupKey<Rows[RootTable], KeyNames>,
        ) => Query<
          Rows,
          Relations,
          RootTable,
          RootScope<Rows, RootTable>,
          Columns<Rows[RootTable]>
        >;
      });
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
const bindingColumns = new WeakMap<TableBinding, RuntimeScope[string]>();
const limitedPlans = new WeakMap<SelectPlan, (SelectPlan | undefined)[]>();
const QUERY_STATE = Symbol("symmetria.query.state");

type QueryState = {
  readonly plan: SelectPlan;
  readonly allowScopedAlias: boolean;
  readonly freshSource: boolean;
  source?: SourceDescription;
};
type QueryHandle = ((callback: never) => object) & {
  readonly [QUERY_STATE]: QueryState;
};

/** one()/first() reuse one derived plan per query so compiled SQL and decoders stay cached. */
const limitedPlan = (state: SelectPlan, limit: 1 | 2): SelectPlan => {
  let derived = limitedPlans.get(state);

  if (!derived) {
    derived = [];
    limitedPlans.set(state, derived);
  }

  return (derived[limit] ??= Object.freeze({
    ...state,
    limit:
      typeof state.limit === "number" ? Math.min(state.limit, limit) : limit,
  }));
};

const resultRows = (result: ExecutionResult): Record<string, unknown>[] =>
  result.rows;

let shapeBindings: (() => SelectPlan["bindings"]) | undefined;
let shapeDepth = 0;

/** Lazy column handles for one binding; computed fields are evaluated once per binding. */
const bindingScope = (
  binding: TableBinding,
  bindings: SelectPlan["bindings"],
): RuntimeScope[string] => {
  const existing = bindingColumns.get(binding);

  if (existing) {
    return existing;
  }

  // Aliases and nested scopes often use only a few of the table's columns.
  const columns = Object.defineProperties(
    {},
    Object.fromEntries(
      binding.table.columns.map((column) => {
        let expression: QueryColumn<unknown, string> | undefined;

        return [
          column.name,
          {
            enumerable: true,
            get: () =>
              (expression ??= createExpression({
                node: Object.freeze({
                  kind: "column",
                  description: Object.freeze({ binding, column }),
                }),
                outputName: column.name,
                ...(binding.codecs[column.name]
                  ? { codec: binding.codecs[column.name] }
                  : {}),
              })),
          },
        ];
      }),
    ),
  ) as RuntimeScope[string];

  for (const callback of computedFields.get(binding.table) ?? []) {
    for (const [name, selected] of Object.entries(
      callback(Object.freeze({ ...columns })),
    )) {
      quoteIdentifier(name);

      if (Object.hasOwn(columns, name)) {
        throw new Error(`symmetria: duplicate computed field "${name}"`);
      }

      const description = readColumn(selected);
      validateNode(description.node, bindings);
      columns[name] = createExpression({
        ...description,
        outputName: name,
      });
    }
  }

  const result = Object.freeze(columns);
  bindingColumns.set(binding, result);

  return result;
};

export const createScope = (bindings: SelectPlan["bindings"]): RuntimeScope =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(bindings).map(([aliasName, binding]) => [
        aliasName,
        bindingScope(binding, bindings),
      ]),
    ),
  );

export const validateNode = (
  node: ValueNode,
  bindings: SelectPlan["bindings"],
): void => {
  if (node.kind === "column") {
    const { binding, column } = node.description;

    if (!containsBinding(bindings, binding)) {
      throw new Error(
        `symmetria: column "${binding.alias}.${column.name}" belongs to another query scope`,
      );
    }
  } else if (node.kind === "raw") {
    node.parts.forEach((part) => {
      if (typeof part !== "string") {
        validateNode(part, bindings);
      }
    });
  } else if (node.kind === "binary") {
    validateNode(node.left, bindings);
    validateNode(node.right, bindings);
  } else if (node.kind === "aggregate" && node.value) {
    validateNode(node.value, bindings);
  } else if (node.kind === "case") {
    validateNode(node.value, bindings);
    node.branches.forEach((branch) => {
      validateNode(branch.when, bindings);
      validateNode(branch.then, bindings);
    });
  } else if (node.kind === "coalesce") {
    node.values.forEach((value) => validateNode(value, bindings));
  } else if (node.kind === "jsonObject") {
    node.selection.forEach((expression) =>
      validateNode(expression.node, bindings),
    );
  } else if (
    node.kind === "jsonPath" ||
    node.kind === "arrayIndex" ||
    node.kind === "arrayLength"
  ) {
    validateNode(node.value, bindings);
  } else if (node.kind === "window") {
    validateNode(node.expression, bindings);
    node.partitionBy.forEach((value) => validateNode(value, bindings));
    node.orderBy.forEach((ordering) =>
      validateNode(ordering.expression.node, bindings),
    );
  }
  // Subqueries validate both their local and correlated bindings during compilation.
};

export const readSelection = (
  expressions: readonly SelectedColumn[] | ProjectionObject,
  bindings: SelectPlan["bindings"],
): readonly ExpressionDescription[] => {
  if (
    expressions &&
    typeof expressions === "object" &&
    !Array.isArray(expressions)
  ) {
    const entries = Object.entries(expressions);

    if (!entries.length) {
      throw new Error("symmetria: a projection requires at least one field");
    }

    return Object.freeze(
      entries.map(([name, selected]) => {
        quoteIdentifier(name);

        if (
          !selected ||
          (typeof selected !== "object" && typeof selected !== "function")
        ) {
          throw new Error(
            "symmetria: selected fields must be SQL expressions, objects or selected queries",
          );
        }

        if (QUERY_PLAN in selected) {
          const query = selected[QUERY_PLAN];

          if (!query.selection.length) {
            throw new Error(
              "symmetria: nested queries require selected fields",
            );
          }

          if (
            Object.values(query.bindings).some((binding) =>
              containsBinding(bindings, binding),
            )
          ) {
            throw new Error(
              "symmetria: nested queries require a distinct source occurrence",
            );
          }

          return Object.freeze({
            outputName: name,
            node: Object.freeze({
              kind: "jsonRows" as const,
              query,
              many: true,
            }),
            codec: jsonRowCodec(
              query.selection,
              query.root.dialect ?? "postgres",
              true,
            ),
          });
        }

        if (COLUMN_EXPRESSION in selected) {
          const description = readColumn(selected as SelectedColumn);
          validateNode(description.node, bindings);

          return description.outputName === name && Object.isFrozen(description)
            ? description
            : Object.freeze({ ...description, outputName: name });
        }

        const selection = readSelection(selected as ProjectionObject, bindings);

        return Object.freeze({
          outputName: name,
          node: Object.freeze({ kind: "jsonObject" as const, selection }),
          codec: jsonRowCodec(
            selection,
            Object.values(bindings)[0]?.dialect ?? "postgres",
          ),
        });
      }),
    );
  }

  if (!Array.isArray(expressions) || !expressions.length) {
    throw new Error("symmetria: a projection requires at least one field");
  }

  const names = new Set<string>();

  return Object.freeze(
    (expressions as readonly SelectedColumn[]).map((expression) => {
      const description = readColumn(expression);
      quoteIdentifier(description.outputName);
      validateNode(description.node, bindings);

      if (names.has(description.outputName)) {
        throw new Error(
          `symmetria: duplicate selected name "${description.outputName}"; use .as()`,
        );
      }

      names.add(description.outputName);

      return description;
    }),
  );
};

export const countValue = (
  name: string,
  count: number | Parameter<number>,
): number | PlaceholderNode => {
  if (typeof count !== "number") {
    const node = readColumn(count).node;

    if (node.kind !== "placeholder") {
      throw new Error(
        `symmetria: ${name} requires a number or prepared parameter`,
      );
    }

    return Object.freeze({ ...node, count: true });
  }

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`symmetria: ${name} must be a nonnegative safe integer`);
  }

  return count;
};

const EMPTY: readonly never[] = Object.freeze([]);
const noBindings: SelectPlan["bindings"] = Object.freeze({});

const emptyBindings = () => noBindings;

export const initialPlan = (root: TableBinding): SelectPlan =>
  Object.freeze({
    kind: "select",
    root,
    bindings: Object.freeze({ [root.alias]: root }),
    joins: EMPTY,
    selection: EMPTY,
    predicates: EMPTY,
    ordering: EMPTY,
    grouping: EMPTY,
    having: EMPTY,
    distinct: false,
  });

export type TableScopes = Readonly<
  Record<string, (columns: RuntimeScope[string]) => Predicate>
>;

export const createQueryTables = (
  snapshot: SchemaSnapshot,
  executor?: QueryExecutor,
  codecs: SchemaCodecs = {},
  dialect?: Dialect,
  scopes: TableScopes = {},
  atomic?: AtomicRunner,
): Record<string, object> => {
  const profile = executorProfiling(executor);
  const tablesByName = new Map(
    snapshot.tables.map((table) => [table.name, table]),
  );
  const tableCodecs = new Map<string, TableBinding["codecs"]>();

  /** $scope() predicates apply wherever a scoped table enters a plan. */
  const scopePredicates = (
    binding: TableBinding,
  ): readonly PredicateDescription[] => {
    const scope = scopes[binding.table.name];

    if (!scope) {
      return EMPTY;
    }

    const columns = createScope({ [binding.alias]: binding })[binding.alias]!;

    return [readPredicate(scope(columns))];
  };

  const scopedPlan = (binding: TableBinding): SelectPlan => {
    const plan = initialPlan(binding);
    const predicates = scopePredicates(binding);

    return predicates.length
      ? Object.freeze({ ...plan, predicates: Object.freeze(predicates) })
      : plan;
  };

  const bindingFor = (tableName: string, alias: string): TableBinding => {
    quoteIdentifier(alias);
    const table = tablesByName.get(tableName);

    if (!table) {
      throw new Error(`symmetria: unknown table "${tableName}"`);
    }

    let resolvedCodecs = tableCodecs.get(tableName);

    if (!resolvedCodecs) {
      resolvedCodecs = Object.freeze(
        Object.fromEntries(
          table.columns.flatMap((column) => {
            const codec =
              codecs[tableName]?.[column.name] ?? codecFor(column.sqlType);

            return codec ? [[column.name, codec]] : [];
          }),
        ),
      );
      tableCodecs.set(tableName, resolvedCodecs);
    }

    return Object.freeze({
      table,
      alias,
      codecs: resolvedCodecs,
      ...(dialect ? { dialect } : {}),
    });
  };

  const columnNode = (
    binding: TableBinding,
    name: string,
    sqlName = false,
  ): ValueNode => {
    const column = binding.table.columns.find(
      (candidate) => (sqlName ? candidate.sqlName : candidate.name) === name,
    );

    if (!column) {
      throw new Error(
        `symmetria: unknown join column "${binding.alias}.${name}"`,
      );
    }

    return Object.freeze({
      kind: "column",
      description: Object.freeze({ binding, column }),
    });
  };

  const joinRelation = (
    state: SelectPlan,
    kind: "LEFT" | "INNER",
    from: string,
    relationName: string,
    alias: string,
    outerAliases: readonly string[] = [],
  ): SelectPlan => {
    if (
      state.joins.some((join) => join.binding.alias === alias) ||
      Object.hasOwn(state.bindings, alias)
    ) {
      throw new Error(`symmetria: duplicate query alias "${alias}"`);
    }

    const source = state.bindings[from];

    if (!source) {
      throw new Error(`symmetria: unknown query alias "${from}"`);
    }

    const relation = source.table.relations.find(
      (candidate) => candidate.name === relationName,
    );

    if (!relation) {
      throw new Error(
        `symmetria: unknown relation "${source.alias}.${relationName}"`,
      );
    }

    const target = bindingFor(relation.target, alias);
    const joins = [...state.joins];

    const addJoin = (
      binding: TableBinding,
      left: ValueNode,
      right: ValueNode,
    ): void => {
      const comparison: PredicateDescription = Object.freeze({
        kind: "comparison",
        left,
        operator: "=",
        right,
      });
      const scope = scopePredicates(binding);

      joins.push(
        Object.freeze({
          kind,
          binding,
          ...(binding === target
            ? { relation: Object.freeze({ from: source, name: relationName }) }
            : {}),
          condition: scope.length
            ? Object.freeze({
                kind: "group",
                operator: "AND",
                predicates: Object.freeze([comparison, ...scope]),
              })
            : comparison,
        }),
      );
    };

    const reference = (
      foreignKey: ValueNode,
      binding: TableBinding,
    ): ValueNode => {
      if (
        foreignKey.kind !== "column" ||
        !foreignKey.description.column.references
      ) {
        throw new Error("symmetria: missing foreign key metadata");
      }

      return columnNode(
        binding,
        foreignKey.description.column.references.column,
        true,
      );
    };

    if (relation.kind === "through") {
      const reservedAliases = new Set([
        ...outerAliases,
        ...Object.keys(state.bindings),
        ...joins.map((join) => join.binding.alias),
        alias,
        ...snapshot.tables.flatMap((table) =>
          table.relations.map((relation) => relation.name),
        ),
      ]);
      let junctionNumber = 0;

      while (reservedAliases.has(`__symmetria_junction_${junctionNumber}`)) {
        junctionNumber += 1;
      }

      const junction = bindingFor(
        relation.junction,
        `__symmetria_junction_${junctionNumber}`,
      );
      const sourceForeignKey = columnNode(junction, relation.sourceForeignKey);
      const targetForeignKey = columnNode(junction, relation.targetForeignKey);
      addJoin(junction, reference(sourceForeignKey, source), sourceForeignKey);
      addJoin(target, targetForeignKey, reference(targetForeignKey, target));
    } else if (relation.reverse === true) {
      const foreignKey = columnNode(target, relation.foreignKey);
      addJoin(target, reference(foreignKey, source), foreignKey);
    } else {
      const foreignKey = columnNode(source, relation.foreignKey);
      addJoin(target, foreignKey, reference(foreignKey, target));
    }

    return Object.freeze({
      ...state,
      joins: Object.freeze(joins),
      bindings: Object.freeze({ ...state.bindings, [alias]: target }),
    });
  };

  type QueryContext = {
    plan: SelectPlan;
    scope: () => RuntimeScope;
    columns: (binding: TableBinding) => RuntimeScope[string];
    bindings: () => SelectPlan["bindings"];
    reservedAliases: Set<string>;
  };

  const evaluateContext = <Result>(
    context: QueryContext,
    callback: () => Result,
  ): Result => {
    const previousBindings = shapeBindings;
    shapeBindings = context.bindings;
    shapeDepth += 1;

    try {
      return callback();
    } finally {
      shapeBindings = previousBindings;
      shapeDepth -= 1;
    }
  };

  const joinSource = (
    state: SelectPlan,
    kind: "LEFT" | "INNER" | "CROSS",
    input: TableSource<Record<string, unknown>, string>,
    condition?: (scope: RuntimeScope) => Predicate,
    context?: QueryContext,
    occurrence?: TableBinding,
  ): SelectPlan => {
    if (input[TABLE_SOURCE].schema !== snapshot) {
      throw new Error("symmetria: cannot join a table from another schema");
    }

    const source = occurrence ?? input[TABLE_SOURCE].binding;

    if (
      Object.hasOwn(state.bindings, source.alias) ||
      state.joins.some((join) => join.binding.alias === source.alias)
    ) {
      throw new Error(`symmetria: duplicate query alias "${source.alias}"`);
    }

    if (kind !== "CROSS" && !condition) {
      throw new Error("symmetria: an explicit join requires an ON callback");
    }

    const binding = Object.freeze({ ...source });
    const scope = scopePredicates(binding);
    const joinCondition = condition
      ? readPredicate(
          condition(
            createScope({ ...state.bindings, [binding.alias]: binding }),
          ),
        )
      : undefined;
    // Reading an outer relation path inside ON can add dependency joins.
    const current = context?.plan ?? state;

    if (
      Object.hasOwn(current.bindings, source.alias) ||
      current.joins.some((join) => join.binding.alias === source.alias)
    ) {
      throw new Error(`symmetria: duplicate query alias "${source.alias}"`);
    }

    const bindings = Object.freeze({
      ...current.bindings,
      [binding.alias]: binding,
    });
    const description: JoinDescription = Object.freeze({
      kind,
      binding,
      ...(joinCondition
        ? {
            condition: scope.length
              ? Object.freeze({
                  kind: "group" as const,
                  operator: "AND" as const,
                  predicates: Object.freeze([joinCondition, ...scope]),
                })
              : joinCondition,
          }
        : {}),
    });

    return Object.freeze({
      ...current,
      bindings,
      joins: Object.freeze([...current.joins, description]),
      predicates:
        joinCondition || !scope.length
          ? current.predicates
          : Object.freeze([...current.predicates, ...scope]),
    });
  };

  type ShapeCallback = (
    columns: RuntimeScope[string],
    tools: typeof shapeExpressions & {
      join: LocalJoin;
      innerJoin: LocalJoin;
      leftJoin: LocalJoin;
      crossJoin: LocalJoin;
      whereNotNull: (column: SelectedColumn) => SelectedColumn;
    },
  ) => Record<string, unknown>;

  type LocalJoinInput =
    | JoinReference
    | TableSource<Record<string, unknown>, string>;
  type ShapePredicate = Predicate | readonly Predicate[];
  type LocalJoin = (
    input: LocalJoinInput,
    condition?: (columns: RuntimeScope[string]) => ShapePredicate,
  ) => RuntimeScope[string];

  const readShapePredicates = (
    value: ShapePredicate,
  ): readonly PredicateDescription[] =>
    Object.freeze((Array.isArray(value) ? value : [value]).map(readPredicate));

  const joinReference = (
    context: QueryContext,
    input: JoinReference,
  ): RelationReference[typeof RELATION_SOURCE] => {
    if (!input || (typeof input !== "object" && typeof input !== "function")) {
      throw new Error(
        "symmetria: JOIN requires a foreign-key column or an unfiltered relation",
      );
    }

    if (COLUMN_EXPRESSION in input) {
      const node = readColumn(input).node;

      if (node.kind !== "column" || !node.description.column.references) {
        throw new Error(
          "symmetria: JOIN requires a foreign-key column or an unfiltered relation",
        );
      }

      const { binding, column } = node.description;
      const relation = binding.table.relations.find(
        (relation) =>
          relation.kind === "one" &&
          !relation.reverse &&
          relation.foreignKey === column.name,
      );

      if (context.plan.bindings[binding.alias] !== binding || !relation) {
        throw new Error(
          "symmetria: JOIN foreign-key column belongs to another query scope",
        );
      }

      return {
        from: binding.alias,
        relation: relation.name,
        target: relation.target,
        alias: relation.name,
        owner: binding,
        nullable:
          !column.notNull ||
          context.plan.joins.some(
            (join) => join.binding === binding && join.kind === "LEFT",
          ),
      };
    }

    const relation = input?.[RELATION_SOURCE];

    if (!relation || context.plan.bindings[relation.from] !== relation.owner) {
      throw new Error(
        "symmetria: JOIN expects an unfiltered relation from its query scope",
      );
    }

    return relation;
  };

  const joinAlias = (
    context: QueryContext,
    preferred: string,
    explicit = false,
  ): string => {
    let alias = preferred;
    let ordinal = 2;

    while (
      Object.hasOwn(context.plan.bindings, alias) ||
      context.plan.joins.some((join) => join.binding.alias === alias) ||
      context.reservedAliases.has(alias)
    ) {
      if (explicit) {
        throw new Error(`symmetria: duplicate query alias "${preferred}"`);
      }

      alias = numberedAlias(preferred, ordinal++);
    }

    return alias;
  };

  const localJoin = (
    context: QueryContext,
    kind: "LEFT" | "INNER" | "AUTO" | "CROSS",
    input: LocalJoinInput,
    condition?: (columns: RuntimeScope[string]) => ShapePredicate,
  ): RuntimeScope[string] => {
    if (!input || (typeof input !== "object" && typeof input !== "function")) {
      throw new Error(
        "symmetria: local JOIN expects a foreign-key column, relation or table source",
      );
    }

    if (TABLE_SOURCE in input) {
      if (kind === "AUTO" || (kind === "CROSS" && condition)) {
        throw new Error(
          "symmetria: join() requires a relation; crossJoin() accepts a source without ON",
        );
      }

      const source = input[TABLE_SOURCE].binding;
      const alias = joinAlias(context, source.alias, source.explicitAlias);
      context.reservedAliases.add(alias);

      try {
        context.plan = joinSource(
          context.plan,
          kind,
          input,
          condition
            ? (scope) =>
                predicate({
                  kind: "group",
                  operator: "AND",
                  predicates: readShapePredicates(condition(scope[alias]!)),
                })
            : undefined,
          context,
          Object.freeze({ ...source, alias }),
        );
      } finally {
        context.reservedAliases.delete(alias);
      }

      return context.columns(context.plan.bindings[alias]!);
    }

    const relation = joinReference(context, input);

    if (condition) {
      throw new Error(
        "symmetria: inferred JOIN sources do not take an ON callback",
      );
    }

    const alias = joinAlias(context, relation.alias, relation.explicitAlias);

    if (kind === "CROSS") {
      context.plan = joinSource(context.plan, kind, {
        [TABLE_SOURCE]: {
          binding: bindingFor(relation.target, alias),
          schema: snapshot,
        },
      });

      return context.columns(context.plan.bindings[alias]!);
    }

    context.plan = joinRelation(
      context.plan,
      kind === "AUTO" ? (relation.nullable ? "LEFT" : "INNER") : kind,
      relation.from,
      relation.relation,
      alias,
      Object.keys(context.bindings()),
    );

    return context.columns(context.plan.bindings[alias]!);
  };

  const lockPlan = (
    state: SelectPlan,
    mode: "UPDATE" | "SHARE",
    options: RowLockOptions = {},
  ): SelectPlan => {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (name) => !["of", "noWait", "skipLocked"].includes(name),
      ) ||
      (options.noWait !== undefined && typeof options.noWait !== "boolean") ||
      (options.skipLocked !== undefined &&
        typeof options.skipLocked !== "boolean")
    ) {
      throw new Error("symmetria: invalid row lock options");
    }

    if (options.noWait && options.skipLocked) {
      throw new Error("symmetria: choose either NOWAIT or SKIP LOCKED");
    }

    if (
      options.of !== undefined &&
      (!Array.isArray(options.of) ||
        !options.of.length ||
        options.of.some(
          (alias) =>
            typeof alias !== "string" || !Object.hasOwn(state.bindings, alias),
        ))
    ) {
      throw new Error("symmetria: row locks require existing query aliases");
    }

    return Object.freeze({
      ...state,
      locking: Object.freeze({
        ...options,
        mode,
        ...(options.of ? { of: Object.freeze([...options.of]) } : {}),
      }),
    });
  };

  const applyShape = (
    context: QueryContext,
    binding: TableBinding,
    callback: ShapeCallback,
  ): SelectPlan => {
    if (typeof callback !== "function") {
      throw new Error("symmetria: a shape requires a synchronous callback");
    }

    if (SHAPE_SOURCE in callback && callback[SHAPE_SOURCE] !== binding.table) {
      throw new Error("symmetria: reusable shape belongs to another table");
    }

    const initialJoinCount = context.plan.joins.length;
    const ancestors = shapeBindings?.();

    if (
      ancestors &&
      Object.values(context.plan.bindings).some((binding) =>
        containsBinding(ancestors, binding),
      )
    ) {
      throw new Error(
        "symmetria: nested queries require a distinct source occurrence",
      );
    }

    let active = true;

    const assertActive = () => {
      if (!active || shapeBindings !== context.bindings) {
        throw new Error(
          "symmetria: local JOIN helpers and whereNotNull can only be used inside their shape callback",
        );
      }
    };

    const join =
      (kind: "LEFT" | "INNER" | "AUTO" | "CROSS") =>
      (
        input: LocalJoinInput,
        condition?: (columns: RuntimeScope[string]) => ShapePredicate,
      ) => {
        assertActive();

        return localJoin(context, kind, input, condition);
      };

    const whereNotNull = (column: SelectedColumn): SelectedColumn => {
      assertActive();
      const expression = readColumn(column);
      validateNode(expression.node, context.bindings());
      context.plan = Object.freeze({
        ...context.plan,
        predicates: Object.freeze([
          ...context.plan.predicates,
          Object.freeze({
            kind: "nullCheck" as const,
            value: expression.node,
            negated: true,
          }),
        ]),
      });

      return column;
    };

    let result: Record<string, unknown>;

    try {
      result = evaluateContext(context, () =>
        callback(
          context.columns(binding),
          // Tools live only for this callback; freezing them is pure overhead.
          Object.assign(Object.create(shapeExpressions), {
            join: join("AUTO"),
            innerJoin: join("INNER"),
            leftJoin: join("LEFT"),
            crossJoin: join("CROSS"),
            whereNotNull,
          }),
        ),
      );
    } finally {
      active = false;
    }

    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (typeof result.then === "function" && !(QUERY_PLAN in result.then))
    ) {
      throw new Error(
        "symmetria: a shape callback must synchronously return an object",
      );
    }

    const fields: Record<string, ProjectionObject[string]> =
      Object.create(null);
    const entries = Object.entries(result);

    if (
      SHAPE_SOURCE in callback &&
      (!entries.length || entries.some(([name]) => name.startsWith("$")))
    ) {
      throw new Error(
        "symmetria: shape() requires projected fields without query controls",
      );
    }

    // This draft stays private until all controls and projections are validated.
    // Copy once, then freeze the completed plan rather than copying per control.
    let plan = { ...context.plan };

    if (result.$forUpdate && result.$forShare) {
      throw new Error("symmetria: choose either $forUpdate or $forShare");
    }

    for (const [name, value] of entries) {
      switch (name) {
        case "$distinct": {
          if (value !== undefined) {
            if (typeof value !== "boolean") {
              throw new Error("symmetria: $distinct requires a boolean");
            }

            plan.distinct = value;
          }

          break;
        }
        case "$forUpdate":
        case "$forShare": {
          if (value !== undefined && value !== false) {
            plan = {
              ...lockPlan(
                plan,
                name === "$forUpdate" ? "UPDATE" : "SHARE",
                value === true ? {} : (value as RowLockOptions),
              ),
            };
          }

          break;
        }
        case "$where":
        case "$having": {
          const clause = name === "$where" ? "predicates" : "having";

          if (value !== undefined) {
            plan[clause] = Object.freeze([
              ...plan[clause],
              ...readShapePredicates(value as ShapePredicate),
            ]);
          }

          break;
        }
        case "$orderBy": {
          if (value !== undefined) {
            plan.ordering = Object.freeze([
              ...plan.ordering,
              ...readOrdering(value as Ordering, context.bindings()),
            ]);
          }

          break;
        }
        case "$groupBy": {
          if (value !== undefined) {
            if (!Array.isArray(value) || !value.length) {
              throw new Error("symmetria: $groupBy requires expressions");
            }

            const grouping = value.map(readColumn);
            grouping.forEach((expression) =>
              validateNode(expression.node, context.bindings()),
            );
            plan.grouping = Object.freeze([...plan.grouping, ...grouping]);
          }

          break;
        }
        case "$limit":
        case "$offset": {
          if (value !== undefined) {
            plan[name === "$limit" ? "limit" : "offset"] = countValue(
              name,
              value as number | Parameter<number>,
            );
          }

          break;
        }
        default: {
          if (name.startsWith("$")) {
            throw new Error(`symmetria: unknown shape control "${name}"`);
          }

          fields[name] = value as ProjectionObject[string];
        }
      }
    }

    if (
      !Object.keys(result).length &&
      context.plan.joins.length === initialJoinCount
    ) {
      throw new Error(
        "symmetria: a shape requires at least one field or query control",
      );
    }

    if (Object.keys(fields).length) {
      plan.selection = readSelection(fields, context.bindings());
    }

    return Object.freeze(plan);
  };

  const readOrdering = (
    ordering: Ordering | readonly Ordering[],
    bindings: SelectPlan["bindings"],
  ) => {
    const descriptions = (Array.isArray(ordering) ? ordering : [ordering]).map(
      (entry: Ordering) => {
        if (!entry || !(ORDERING_EXPRESSION in entry)) {
          throw new Error(
            "symmetria: orderBy() expects ascending or descending expressions",
          );
        }

        validateNode(entry[ORDERING_EXPRESSION].expression.node, bindings);

        return entry[ORDERING_EXPRESSION];
      },
    );

    if (!descriptions.length) {
      throw new Error("symmetria: orderBy() requires expressions");
    }

    return descriptions;
  };

  const presentSelection: readonly ExpressionDescription[] = Object.freeze([
    {
      outputName: "present",
      node: Object.freeze({ kind: "raw", parts: Object.freeze(["1"]) }),
    },
  ]);

  const createContext = (
    state: SelectPlan,
    ancestors: () => SelectPlan["bindings"] = shapeBindings ?? emptyBindings,
    depth = shapeDepth,
  ): QueryContext => {
    let previousOuter: SelectPlan["bindings"] | undefined;
    let previousLocal: SelectPlan["bindings"] | undefined;
    let merged: SelectPlan["bindings"];
    const context: QueryContext = {
      plan: state,
      scope: () => {
        const bindings = Object.entries(state.bindings);

        if (bindings.length === 1) {
          const [name, binding] = bindings[0]!;

          return Object.freeze({ [name]: columnsFor(binding) });
        }

        return Object.freeze(
          Object.defineProperties(
            {},
            Object.fromEntries(
              bindings.map(([name, binding]) => [
                name,
                {
                  enumerable: true,
                  get: () => columnsFor(binding),
                },
              ]),
            ),
          ),
        ) as RuntimeScope;
      },
      columns: (binding) => columnsFor(binding),
      bindings: () => {
        const outer = ancestors();
        const local = context.plan.bindings;

        // Frozen binding maps change identity when a JOIN is added. Reuse the
        // merged scope until either this callback or an ancestor adds a source.
        if (outer !== previousOuter || local !== previousLocal) {
          previousOuter = outer;
          previousLocal = local;
          merged = Object.keys(outer).length
            ? Object.freeze(mergeBindings(outer, local))
            : local;
        }

        return merged;
      },
      reservedAliases: new Set(),
    };
    const views = new Map<TableBinding, RuntimeScope[string]>();

    const uniqueAlias = (prefix: string): string => {
      const bindings = context.bindings();
      let ordinal = 0;
      let alias: string;
      do {
        alias = `${prefix}${ordinal++}`;
      } while (
        Object.hasOwn(bindings, alias) ||
        context.reservedAliases.has(alias) ||
        context.plan.joins.some((join) => join.binding.alias === alias)
      );

      return alias;
    };

    const columnsFor = (binding: TableBinding): RuntimeScope[string] => {
      const existing = views.get(binding);

      if (existing) {
        return existing;
      }

      const columns = bindingScope(binding, { [binding.alias]: binding });
      const relationships = new Map<string, object>();
      const view = new Proxy(columns, {
        get: (target, property) => {
          if (typeof property !== "string" || Object.hasOwn(target, property)) {
            return Reflect.get(target, property);
          }

          if (relationships.has(property)) {
            return relationships.get(property);
          }

          const relation = binding.table.relations.find(
            (relation) => relation.name === property,
          );

          if (!relation) {
            return undefined;
          }

          const many = relation.kind === "many" || relation.kind === "through";
          const nullable =
            context.plan.joins.some(
              (join) => join.binding === binding && join.kind === "LEFT",
            ) ||
            relation.kind !== "one" ||
            relation.reverse === true ||
            relation.nullable;
          let base: SelectPlan | undefined;
          let related: TableBinding;

          const nestedPlan = (): SelectPlan => {
            if (base) {
              return base;
            }

            const alias = uniqueAlias("__symmetria_aggregate_");
            const joined = joinRelation(
              initialPlan(binding),
              "INNER",
              binding.alias,
              property,
              alias,
              Object.keys(context.bindings()),
            );
            const first = joined.joins[0]!;
            related = joined.bindings[alias]!;
            base = Object.freeze({
              ...initialPlan(first.binding),
              bindings: Object.freeze(
                Object.fromEntries(
                  joined.joins.map((join) => [
                    join.binding.alias,
                    join.binding,
                  ]),
                ),
              ),
              joins: Object.freeze(joined.joins.slice(1)),
              // first.condition already carries the related table's scope from addJoin.
              predicates: Object.freeze([first.condition!]),
            });

            return base;
          };

          const pathColumns = (
            selectedAlias: string,
            customAlias: boolean,
          ): RuntimeScope[string] => {
            const previous = context.plan.joins.find(
              (join) =>
                join.relation?.from === binding &&
                join.relation.name === property &&
                (!customAlias || join.binding.alias === selectedAlias),
            );

            if (previous) {
              return columnsFor(previous.binding);
            }

            // A later outer callback may add paths after this subquery has been built.
            const alias = customAlias
              ? selectedAlias
              : uniqueAlias(
                  depth ? `__symmetria_path_${depth}_` : "__symmetria_path_",
                );
            context.plan = joinRelation(
              context.plan,
              nullable ? "LEFT" : "INNER",
              binding.alias,
              property,
              alias,
            );

            return columnsFor(context.plan.bindings[alias]!);
          };

          const build = (
            plan?: SelectPlan,
            selectedAlias = property,
            filtered = false,
            customAlias = false,
          ): object => {
            const current = () => plan ?? nestedPlan();

            const evaluate = <Result>(
              callback: (columns: RuntimeScope[string]) => Result,
            ) => {
              const nested = createContext(
                current(),
                context.bindings,
                depth + 1,
              );
              const result = evaluateContext(nested, () =>
                callback(nested.columns(nested.plan.bindings[related.alias]!)),
              );

              return { nested, result };
            };

            const quantified = (
              mode: "some" | "none" | "every",
              callback?: (columns: RuntimeScope[string]) => Predicate,
            ): Predicate => {
              let query = current();

              if (query.limit !== undefined || query.offset !== undefined) {
                throw new Error(
                  "symmetria: relation quantifiers must precede limit()/offset()",
                );
              }

              if (mode === "every" && !callback) {
                throw new Error("symmetria: every() requires a predicate");
              }

              if (callback) {
                const { nested, result } = evaluate(callback);
                const description = readPredicate(result);
                query = Object.freeze({
                  ...nested.plan,
                  predicates: Object.freeze([
                    ...nested.plan.predicates,
                    mode === "every"
                      ? { kind: "notTrue" as const, predicate: description }
                      : description,
                  ]),
                });
              }

              return predicate({
                kind: "exists",
                query: Object.freeze({
                  ...query,
                  ordering: Object.freeze([]),
                  selection: presentSelection,
                }),
                negated: mode !== "some",
              });
            };

            const aggregate = (
              operation: (
                column: SelectedColumn<number | bigint | string | null>,
              ) => SelectedColumn,
              callback: (columns: RuntimeScope[string]) => SelectedColumn,
            ) => {
              const { nested, result } = evaluate(callback);
              const expression = readColumn(result);
              const query = nested.plan;
              const wrapped =
                query.limit !== undefined ||
                query.offset !== undefined ||
                query.grouping.length > 0 ||
                query.distinct;
              const source = wrapped
                ? derivedBinding(
                    Object.freeze({
                      ...query,
                      selection: Object.freeze([
                        { ...expression, outputName: "value" },
                      ]),
                    }),
                    "__symmetria_aggregate",
                  )
                : undefined;
              const selected = readColumn(
                operation(
                  (source
                    ? createScope({ [source.alias]: source })[source.alias]!
                        .value!
                    : result) as SelectedColumn<
                    number | bigint | string | null
                  >,
                ),
              );

              return createExpression({
                ...selected,
                node: Object.freeze({
                  kind: "subquery",
                  query: Object.freeze({
                    ...(source ? initialPlan(source) : query),
                    ordering: Object.freeze([]),
                    selection: Object.freeze([selected]),
                  }),
                }),
              });
            };

            const methods = callable(
              (callback: ShapeCallback) => {
                const occurrence = queryOccurrence(current());
                const nested = createContext(
                  occurrence,
                  context.bindings,
                  depth + 1,
                );
                const query = applyShape(
                  nested,
                  occurrence.bindings[related.alias]!,
                  callback,
                );

                if (!query.selection.length) {
                  return build(query, selectedAlias, true);
                }

                return createExpression({
                  outputName: selectedAlias,
                  node: Object.freeze({ kind: "jsonRows", query, many }),
                  codec: jsonRowCodec(
                    query.selection,
                    related.dialect ?? "postgres",
                    many,
                  ),
                });
              },
              {
                ...(!filtered
                  ? {
                      [RELATION_SOURCE]: Object.freeze({
                        from: binding.alias,
                        relation: property,
                        target: relation.target,
                        alias: selectedAlias,
                        owner: binding,
                        nullable,
                        explicitAlias: customAlias,
                      }),
                      as: (alias: string) => {
                        quoteIdentifier(alias);

                        return build(plan, alias, false, true);
                      },
                    }
                  : {}),
                count: () => {
                  const query = current();
                  const counted =
                    query.limit !== undefined ||
                    query.offset !== undefined ||
                    query.grouping.length > 0 ||
                    query.having.length > 0 ||
                    query.distinct;

                  return createExpression({
                    ...readColumn(count()),
                    node: Object.freeze({
                      kind: counted ? "rowCount" : "subquery",
                      query: Object.freeze({
                        ...query,
                        ...(counted ? {} : { ordering: Object.freeze([]) }),
                        selection: counted
                          ? query.distinct
                            ? query.grouping.length
                              ? query.grouping
                              : readSelection(
                                  createScope({
                                    [query.root.alias]: query.root,
                                  })[query.root.alias]!,
                                  query.bindings,
                                )
                            : presentSelection
                          : Object.freeze([readColumn(count())]),
                      }),
                    }),
                  });
                },
                sum: (
                  callback: (columns: RuntimeScope[string]) => SelectedColumn,
                ) => aggregate(sum, callback),
                average: (
                  callback: (columns: RuntimeScope[string]) => SelectedColumn,
                ) => aggregate(average, callback),
                minimum: (
                  callback: (columns: RuntimeScope[string]) => SelectedColumn,
                ) => aggregate(minimum, callback),
                maximum: (
                  callback: (columns: RuntimeScope[string]) => SelectedColumn,
                ) => aggregate(maximum, callback),
                exists: () =>
                  createExpression({
                    outputName: "exists",
                    codec: booleanCodec,
                    node: Object.freeze({
                      kind: "raw",
                      parts: Object.freeze([
                        "EXISTS ",
                        {
                          kind: "subquery" as const,
                          query: Object.freeze({
                            ...current(),
                            selection: presentSelection,
                          }),
                        },
                      ]),
                    }),
                  }),
                some: (
                  callback?: (columns: RuntimeScope[string]) => Predicate,
                ) => quantified("some", callback),
                none: (
                  callback?: (columns: RuntimeScope[string]) => Predicate,
                ) => quantified("none", callback),
                every: (
                  callback: (columns: RuntimeScope[string]) => Predicate,
                ) => quantified("every", callback),
              },
              true,
            );

            if (filtered || many) {
              return methods;
            }

            return new Proxy(methods, {
              get: (target, name) => {
                if (
                  typeof name !== "string" ||
                  (name !== "name" &&
                    name !== "length" &&
                    Object.hasOwn(target, name))
                ) {
                  return Reflect.get(target, name);
                }

                const table = tablesByName.get(relation.target)!;

                if (
                  !table.columns.some((column) => column.name === name) &&
                  !table.relations.some((relation) => relation.name === name) &&
                  !computedFields.has(table)
                ) {
                  return undefined;
                }

                return pathColumns(selectedAlias, customAlias)[name];
              },
            });
          };

          const result = build();
          relationships.set(property, result);

          return result;
        },
      });
      views.set(binding, view);

      return view;
    };

    return context;
  };

  const startPlan = (
    state: SelectPlan,
    allowScopedAlias: boolean,
    freshSource: boolean,
  ): SelectPlan => {
    if (!freshSource) {
      return state;
    }

    const root = Object.freeze({ ...state.root });

    return allowScopedAlias ? scopedPlan(root) : initialPlan(root);
  };

  const single = async (
    state: SelectPlan,
    required: boolean,
  ): Promise<Record<string, unknown> | null> => {
    if (typeof state.limit === "object") {
      throw new Error("symmetria: bind a parameterized LIMIT with prepare()");
    }

    const rows = (await executePlan(limitedPlan(state, 2), executor)).rows;

    if (rows.length > 1 || (required && !rows.length)) {
      throw new Error(
        `symmetria: expected ${required ? "exactly one" : "at most one"} row, received ${rows.length}`,
      );
    }

    return rows[0] ?? null;
  };

  /** Every query is a callable whose methods live on one shared prototype. */
  const queryPrototype: object = Object.freeze(
    Object.create(
      Function.prototype,
      boundMethodDescriptors({
        get [QUERY_PLAN](): SelectPlan {
          return (this as unknown as QueryHandle)[QUERY_STATE].plan;
        },
        get [TABLE_SOURCE](): SourceDescription {
          const state = (this as unknown as QueryHandle)[QUERY_STATE];

          return (state.source ??= Object.freeze({
            binding: state.plan.root,
            schema: snapshot,
          }));
        },
        cte(
          this: QueryHandle,
          name: string,
          options: { materialized?: boolean } = {},
        ) {
          const state = this[QUERY_STATE].plan;

          if (!state.selection.length) {
            throw new Error("symmetria: a CTE requires selected fields");
          }

          if (
            options.materialized !== undefined &&
            typeof options.materialized !== "boolean"
          ) {
            throw new Error("symmetria: materialized must be a boolean");
          }

          const derived = derivedBinding(state, name);
          const { derived: _query, ...binding } = derived;
          const identity = Object.freeze({});
          const definition: CommonTableExpression = Object.freeze({
            name,
            identity,
            query: state,
            ...(options.materialized === undefined
              ? {}
              : { materialized: options.materialized }),
          });

          return createQuery(
            initialPlan(
              Object.freeze({
                ...binding,
                cte: definition,
                cteReference: { name, identity },
              }),
            ),
            false,
            true,
          );
        },
        recursive(
          this: QueryHandle,
          name: string,
          step: (self: object) => QueryReference,
          options: { unionAll?: boolean } = {},
        ) {
          const state = this[QUERY_STATE].plan;

          if (!state.selection.length) {
            throw new Error(
              "symmetria: a recursive CTE requires a selected anchor",
            );
          }

          if (
            options.unionAll !== undefined &&
            typeof options.unionAll !== "boolean"
          ) {
            throw new Error("symmetria: unionAll must be a boolean");
          }

          const derived = derivedBinding(state, name);
          const { derived: _query, ...binding } = derived;
          const identity = Object.freeze({});
          const reference = Object.freeze({
            ...binding,
            cteReference: { name, identity },
          });
          const selected = step(
            createQuery(initialPlan(reference), false, true),
          );
          const recursive = selected?.[QUERY_PLAN];

          if (
            !recursive ||
            recursive.selection.length !== state.selection.length ||
            recursive.selection.some(
              (expression, position) =>
                expression.outputName !== state.selection[position]!.outputName,
            )
          ) {
            throw new Error(
              "symmetria: recursive term must select the same fields in the same order as its anchor",
            );
          }

          const definition: CommonTableExpression = Object.freeze({
            name,
            identity,
            query: state,
            recursive,
            unionAll: options.unionAll ?? true,
          });

          return createQuery(
            initialPlan(Object.freeze({ ...reference, cte: definition })),
            false,
            true,
          );
        },
        as(this: QueryHandle, name: string) {
          const { plan: state, allowScopedAlias } = this[QUERY_STATE];
          quoteIdentifier(name);

          if (state.selection.length) {
            return createQuery(
              initialPlan(derivedBinding(state, name)),
              false,
              true,
            );
          }

          if (
            state.joins.length ||
            (state.predicates.length && !allowScopedAlias) ||
            state.grouping.length ||
            state.ordering.length ||
            state.having.length ||
            state.limit !== undefined ||
            state.offset !== undefined ||
            state.distinct ||
            state.locking
          ) {
            throw new Error(
              "symmetria: alias the table before building the query, or select fields before creating a derived table",
            );
          }

          const binding = Object.freeze({
            ...state.root,
            alias: name,
            explicitAlias: true,
          });

          // Bare table aliases re-evaluate implicit scopes against the new binding.
          return createQuery(
            allowScopedAlias ? scopedPlan(binding) : initialPlan(binding),
            allowScopedAlias,
            true,
          );
        },
        scalar(this: QueryHandle) {
          const state = this[QUERY_STATE].plan;

          if (state.selection.length !== 1) {
            throw new Error("symmetria: scalar() requires one selected column");
          }

          return createExpression({
            ...state.selection[0]!,
            node: Object.freeze({ kind: "subquery", query: state }),
            outputName: "scalar",
          });
        },
        toSQL(this: QueryHandle) {
          return compilePlan(this[QUERY_STATE].plan);
        },
        prepare(this: QueryHandle) {
          return preparePlan(this[QUERY_STATE].plan, executor);
        },
        [PREPARE_QUERY](
          this: QueryHandle,
          scope: object,
          names: readonly string[],
        ) {
          return preparePlan(this[QUERY_STATE].plan, executor, scope, names);
        },
        async execute(this: QueryHandle) {
          return (await executePlan(this[QUERY_STATE].plan, executor)).rows;
        },
        then(
          this: QueryHandle,
          onFulfilled?: ((rows: Record<string, unknown>[]) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) {
          return executePlan(this[QUERY_STATE].plan, executor).then(
            onFulfilled ? (result) => onFulfilled(result.rows) : resultRows,
            onRejected,
          );
        },
        async inspect(this: QueryHandle, options?: InspectQueryOptions) {
          return (await import("../observability/inspection")).inspectQuery(
            this[QUERY_STATE].plan,
            executor,
            options,
          );
        },
        one(this: QueryHandle) {
          return single(this[QUERY_STATE].plan, true);
        },
        maybeOne(this: QueryHandle) {
          return single(this[QUERY_STATE].plan, false);
        },
        page(
          this: QueryHandle,
          options: { size: number; after?: string | null | undefined },
        ) {
          return executePage(this[QUERY_STATE].plan, options, executor);
        },
        pages(
          this: QueryHandle,
          options: { size: number; after?: string | null | undefined },
        ) {
          const state = this[QUERY_STATE].plan;

          return {
            [Symbol.asyncIterator]: () => {
              let after: string | null | undefined = options.after ?? null;

              return {
                next: async () => {
                  if (after === undefined) {
                    return { done: true as const, value: undefined };
                  }

                  const page = await executePage(
                    state,
                    { size: options.size, after },
                    executor,
                  );
                  after = page.nextCursor ?? undefined;

                  return { done: false as const, value: page };
                },
              };
            },
          };
        },
        async first(this: QueryHandle) {
          const state = this[QUERY_STATE].plan;

          if (typeof state.limit === "object") {
            throw new Error(
              "symmetria: bind a parameterized LIMIT with prepare()",
            );
          }

          return (
            (await executePlan(limitedPlan(state, 1), executor)).rows[0] ?? null
          );
        },
      }),
    ),
  );

  const createQuery = (
    state: SelectPlan,
    allowScopedAlias = false,
    freshSource = false,
  ): object => {
    const query = ((callback: ShapeCallback) => {
      const current = freshSource
        ? startPlan(state, allowScopedAlias, freshSource)
        : queryOccurrence(state);

      return createQuery(
        applyShape(createContext(current), current.root, callback),
      );
    }) as unknown as QueryHandle;
    Object.setPrototypeOf(query, queryPrototype);
    Object.defineProperty(query, QUERY_STATE, {
      value: { plan: state, allowScopedAlias, freshSource },
    });
    Object.freeze(query);

    return profile ? profile.trackBuilder(query) : query;
  };

  return Object.fromEntries(
    snapshot.tables.map((table) => {
      const root = bindingFor(table.name, table.name);
      const mutationOptions: MutationOptions = Object.freeze({
        ...(atomic ? { atomic } : {}),
        scope: scopePredicates(root),
        context: (plan: SelectPlan) => createContext(plan),
      });

      /**
       * Key lookups build their plan directly instead of materializing a column
       * scope; scoped tables and computed fields still need the full scope.
       */
      const keyLookup = (
        keys: readonly ColumnSnapshot[],
        values: readonly unknown[],
      ): object => {
        const binding = Object.freeze({ ...root });

        if (scopes[table.name] || computedFields.get(table)?.length) {
          const columns = createScope({ [binding.alias]: binding })[
            binding.alias
          ]!;

          return createQuery(
            Object.freeze({
              ...initialPlan(binding),
              predicates: Object.freeze([
                ...scopePredicates(binding),
                ...keys.map((column, position) =>
                  readPredicate(
                    columns[column.name]!.is(values[position] as never),
                  ),
                ),
              ]),
              selection: Object.freeze(Object.values(columns).map(readColumn)),
            }),
          );
        }

        const columnNode = (column: ColumnSnapshot): ValueNode =>
          Object.freeze({
            kind: "column",
            description: Object.freeze({ binding, column }),
          });

        const predicates = keys.map(
          (column, position): PredicateDescription => {
            const right = valueNode(
              values[position],
              binding.codecs[column.name],
            );

            return Object.freeze({
              kind: "comparison",
              left: columnNode(column),
              operator: "=",
              right,
              ...(right.kind === "placeholder" && right.nullable
                ? { nullableParameter: true as const }
                : {}),
            });
          },
        );
        const selection = table.columns.map((column): ExpressionDescription => {
          const codec = binding.codecs[column.name];

          return Object.freeze({
            node: columnNode(column),
            outputName: column.name,
            ...(codec ? { codec } : {}),
          });
        });

        return createQuery(
          Object.freeze({
            ...initialPlan(binding),
            predicates: Object.freeze(predicates),
            selection: Object.freeze(selection),
          }),
        );
      };

      const uniqueLookup = (names: readonly string[], value: unknown) => {
        if (
          !names.length ||
          (names.length > 1 &&
            (!value ||
              typeof value !== "object" ||
              Object.keys(value).length !== names.length ||
              names.some((name) => !Object.hasOwn(value, name))))
        ) {
          throw new Error(
            `symmetria: unique lookup requires exactly these key fields: ${names.join(", ")}`,
          );
        }

        const values = names.map((name) => {
          const selected =
            names.length === 1
              ? value
              : (value as Record<string, unknown>)[name];

          if (selected === null || selected === undefined) {
            throw new Error(
              `symmetria: unique key "${name}" cannot be null or undefined`,
            );
          }

          return selected;
        });

        return keyLookup(
          names.map(
            (name) => table.columns.find((column) => column.name === name)!,
          ),
          values,
        );
      };

      const uniqueKeys = new Map(
        table.columns
          .filter((column) => column.unique)
          .map((column) => [column.name, [column.name]]),
      );

      for (const definition of table.indexes ?? []) {
        if (!definition.unique || definition.where) {
          continue;
        }

        const columns = definition.keys.map(
          (key) =>
            table.columns.find(
              (column) => quoteIdentifier(column.sqlName) === key,
            )?.name,
        );

        if (columns.every((name) => name !== undefined)) {
          if (uniqueKeys.has(definition.name)) {
            throw new Error(
              `symmetria: duplicate unique lookup "${table.name}.${definition.name}"`,
            );
          }

          uniqueKeys.set(definition.name, columns);
        }
      }

      return [
        table.name,
        extendBuilder(createQuery(scopedPlan(root), true, true), {
          shape: (callback: ShapeCallback) => {
            if (typeof callback !== "function") {
              throw new Error(
                "symmetria: shape() requires a synchronous callback",
              );
            }

            return Object.freeze(
              Object.assign(
                (columns: RuntimeScope[string], tools: unknown) =>
                  callback(columns, tools as Parameters<ShapeCallback>[1]),
                { [SHAPE_SOURCE]: table },
              ),
            );
          },
          by: Object.freeze(
            Object.fromEntries(
              [...uniqueKeys].map(([name, columns]) => [
                name,
                (value: unknown) => uniqueLookup(columns, value),
              ]),
            ),
          ),
          byId: (value: unknown) => {
            const keys = table.primaryKey
              ? table.primaryKey.map(
                  (name) =>
                    table.columns.find((column) => column.sqlName === name)!,
                )
              : table.columns.filter((column) => column.primaryKey);

            if (!keys.length) {
              throw new Error(
                `symmetria: byId() requires a primary key on "${table.name}"`,
              );
            }

            if (
              keys.length > 1 &&
              (!value ||
                typeof value !== "object" ||
                Object.keys(value).length !== keys.length ||
                keys.some((column) => !Object.hasOwn(value, column.name)))
            ) {
              throw new Error(
                `symmetria: byId() requires exactly these key fields: ${keys.map((column) => column.name).join(", ")}`,
              );
            }

            const values = keys.map((column) => {
              const selected =
                keys.length === 1
                  ? value
                  : (value as Record<string, unknown>)[column.name];

              if (selected === null || selected === undefined) {
                throw new Error(
                  `symmetria: primary key "${column.name}" cannot be null or undefined`,
                );
              }

              return selected;
            });

            return keyLookup(keys, values);
          },
          insert: (
            values:
              | Record<string, unknown>
              | readonly Record<string, unknown>[],
          ) =>
            createMutation("insert", root, values, executor, mutationOptions),
          update: (
            values:
              | Record<string, unknown>
              | ((row: RuntimeScope[string]) => Record<string, unknown>),
          ) =>
            createMutation("update", root, values, executor, mutationOptions),
          delete: () =>
            createMutation("delete", root, {}, executor, mutationOptions),
        }),
      ];
    }),
  );
};
