import { compilePlan, compileQuery, executePlan } from "./compiler";
import { executorProfiling } from "../observability/profiling";
import {
  PREPARE_QUERY,
  preparePlan,
  type PreparedQuery,
  type Preparable,
} from "./prepared";
import {
  and,
  readPredicate,
  valueNode,
  type Predicate,
  type PredicateDescription,
  type SelectedColumn,
  type ValueNode,
} from "./expressions";
import type { ColumnSnapshot } from "../schema/assembly";
import {
  createScope,
  initialPlan,
  readSelection,
  type Columns,
  type Projection,
  type ProjectionRow,
  type ProjectionObject,
  type RuntimeScope,
} from "./select";
import {
  DEFAULT_VALUE,
  type CompiledQuery,
  type MutationPlan,
  type QueryExecutor,
  type SelectPlan,
  type TableBinding,
} from "./state";

/** Optional write fields accept `undefined` as "omitted", even under exactOptionalPropertyTypes. */
type InputValues<Insert extends Record<string, unknown>> = {
  [ColumnName in keyof Insert]:
    | Insert[ColumnName]
    | SelectedColumn<Exclude<Insert[ColumnName], undefined>>
    | ({} extends Pick<Insert, ColumnName>
        ? typeof DEFAULT_VALUE | undefined
        : never);
};
type UpdateValues<Insert extends Record<string, unknown>> = {
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

/** Runs several statements atomically: a transaction, or a savepoint inside one. */
export type AtomicRunner = <Result>(
  run: (executor: QueryExecutor) => Promise<Result>,
) => Promise<Result>;

/** Wire-protocol bind-parameter limits; larger multi-row INSERTs are split into atomic chunks. */
const PARAMETER_LIMITS: Record<string, number> = {
  postgres: 65535,
  sqlite: 32766,
};

/** Hooks a table's query machinery hands to its mutations: $scope() filters and relation-path contexts. */
export type MutationOptions = {
  readonly atomic?: AtomicRunner;
  readonly scope?: readonly PredicateDescription[];
  readonly context?: (plan: SelectPlan) => {
    readonly plan: SelectPlan;
    readonly scope: () => RuntimeScope;
  };
};

type FlatInsert<
  Insert extends Record<string, unknown>,
  RelationNames extends string,
> = InputValues<Insert> & { [Name in RelationNames]?: undefined };

/** `insert(object)` resolves to one row, `insert(array)` to an array; DO NOTHING may skip the row. */
export type MutationResult<
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
  readonly returning: <const NextSelection extends Projection>(
    selector: (row: Columns<Row>) => NextSelection,
  ) => NestedInsertQuery<Row, TableName, Single, NextSelection>;
  readonly execute: () => Promise<MutationResult<Selection, Single>>;
  readonly then: PromiseLike<MutationResult<Selection, Single>>["then"];
};
type Mutation<
  Row extends Record<string, unknown>,
  Insert extends Record<string, unknown>,
  TableName extends string,
  Kind extends "insert" | "update" | "delete",
  Selection extends Projection | undefined = undefined,
  Single extends boolean = false,
  Optional extends boolean = false,
  WhereScope = Columns<Row>,
> = Preparable<MutationResult<Selection, Single, Optional>> & {
  readonly prepare: () => PreparedQuery<
    MutationResult<Selection, Single, Optional>
  >;
  readonly returning: <const NextSelection extends Projection>(
    selector: (row: Columns<Row>) => NextSelection,
  ) => Mutation<
    Row,
    Insert,
    TableName,
    Kind,
    NextSelection,
    Single,
    Optional,
    WhereScope
  >;
  readonly toSQL: () => CompiledQuery;
  readonly execute: () => Promise<MutationResult<Selection, Single, Optional>>;
  readonly then: PromiseLike<
    MutationResult<Selection, Single, Optional>
  >["then"];
} & (Kind extends "insert"
    ? {
        readonly onConflict: (...columns: (keyof Row & string)[]) => {
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
          predicate: (scope: WhereScope) => Predicate | readonly Predicate[],
        ) => Mutation<
          Row,
          Insert,
          TableName,
          Kind,
          Selection,
          Single,
          Optional,
          WhereScope
        >;
      });

export type TableMutations<
  Row extends Record<string, unknown>,
  Insert extends Record<string, unknown>,
  TableName extends string,
  RelationNames extends string = never,
  WhereScope = Columns<Row>,
> = {
  readonly insert: {
    (
      values: readonly FlatInsert<Insert, RelationNames>[],
    ): Mutation<Row, Insert, TableName, "insert", undefined, false>;
    (
      values: FlatInsert<Insert, RelationNames>,
    ): Mutation<Row, Insert, TableName, "insert", undefined, true>;
  };
  readonly update: (
    values:
      | UpdateValues<Insert>
      | ((row: Columns<Row>) => UpdateValues<Insert>),
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
  readonly delete: () => Mutation<
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

export const createMutation = (
  kind: MutationPlan["kind"],
  root: TableBinding,
  input:
    | Record<string, unknown>
    | readonly Record<string, unknown>[]
    | ((row: RuntimeScope[string]) => Record<string, unknown>),
  executor?: QueryExecutor,
  options: MutationOptions = {},
): object => {
  const profile = executorProfiling(executor);
  const bindings = Object.freeze({ [root.alias]: root });
  const scope = createScope(bindings);

  const columnNode = (column: ColumnSnapshot): ValueNode =>
    Object.freeze({
      kind: "column",
      description: Object.freeze({ binding: root, column }),
    });

  /**
   * Predicates may follow relation paths; the resulting JOINs cannot live in an
   * UPDATE or DELETE, so they move into a primary-key subquery.
   */
  const wherePredicate = (
    callback: (row: RuntimeScope[string]) => Predicate | readonly Predicate[],
  ): PredicateDescription => {
    // An array combines with AND, like $where in shapes.
    const evaluate = (row: RuntimeScope[string]): Predicate => {
      const result = callback(row);

      return Array.isArray(result) ? and(...result) : (result as Predicate);
    };

    if (!options.context) {
      return readPredicate(evaluate(scope[root.alias]!));
    }

    const context = options.context(initialPlan(root));
    const description = readPredicate(evaluate(context.scope()[root.alias]!));

    if (!context.plan.joins.length) {
      return description;
    }

    const keys = root.table.columns.filter((column) => column.primaryKey);

    if (!keys.length) {
      throw new Error(
        `symmetria: relation paths in ${kind}().where() require a primary key on "${root.alias}"`,
      );
    }

    const subquery: SelectPlan = Object.freeze({
      ...context.plan,
      selection: Object.freeze(
        keys.map((column) =>
          Object.freeze({ outputName: column.name, node: columnNode(column) }),
        ),
      ),
      predicates: Object.freeze([...context.plan.predicates, description]),
    });
    const value: ValueNode =
      keys.length === 1
        ? columnNode(keys[0]!)
        : Object.freeze({
            kind: "tuple",
            values: Object.freeze(keys.map(columnNode)),
          });

    return Object.freeze({
      kind: "membership",
      value,
      values: subquery,
      negated: false,
    });
  };

  // Captured by the initial immutable plan; conflict assignments are walked separately.
  let atomicValues = true;

  const readValues = (
    values: Record<string, unknown>,
    insert = false,
  ): Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>> => {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("symmetria: values must be an object");
    }

    // undefined means omitted, as for query controls; unknown keys still fail.
    const result: Record<string, ValueNode | typeof DEFAULT_VALUE> = {};
    let assigned = 0;

    for (const name of Object.keys(values)) {
      const value = values[name];
      const column = root.table.columns.find((column) => column.name === name);

      if (!column) {
        throw new Error(`symmetria: unknown column "${root.alias}.${name}"`);
      }

      if (value === undefined) {
        continue;
      }

      if (value === null && column.notNull) {
        throw new Error(`symmetria: "${root.alias}.${name}" cannot be null`);
      }

      if (value === DEFAULT_VALUE && !column.default && column.notNull) {
        throw new Error(`symmetria: "${root.alias}.${name}" has no default`);
      }

      if (
        column.default?.kind === "sql" &&
        column.default.sql === "identity" &&
        value !== DEFAULT_VALUE
      ) {
        throw new Error(
          `symmetria: "${root.alias}.${name}" is generated always; use defaultValue`,
        );
      }

      const node =
        value === DEFAULT_VALUE
          ? DEFAULT_VALUE
          : valueNode(value, root.codecs[name]);

      if (
        node !== DEFAULT_VALUE &&
        node.kind !== "parameter" &&
        node.kind !== "placeholder" &&
        node.kind !== "column"
      ) {
        atomicValues = false;
      }

      result[name] = node;
      assigned += 1;
    }

    if (insert) {
      for (const column of root.table.columns) {
        if (
          column.notNull &&
          !column.default &&
          values[column.name] === undefined
        ) {
          throw new Error(
            `symmetria: missing required column "${root.alias}.${column.name}"`,
          );
        }
      }
    }

    if (!insert && !assigned) {
      throw new Error("symmetria: update() requires at least one value");
    }

    return Object.freeze(result);
  };

  const resolved =
    typeof input === "function" ? input(scope[root.alias]!) : input;
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const single = kind === "insert" && !Array.isArray(resolved);

  if (kind === "update" && !rows.length) {
    throw new Error("symmetria: update() requires at least one value");
  }

  const initial: MutationPlan = Object.freeze({
    kind,
    root,
    bindings,
    values: Object.freeze(
      kind === "delete"
        ? []
        : rows.map((row) => readValues(row, kind === "insert")),
    ),
    atomicValues,
    predicates: Object.freeze(
      kind === "insert" ? [] : [...(options.scope ?? [])],
    ),
    selection: Object.freeze([]),
    ...(single ? { single: true as const } : {}),
  });

  const executeChunked = async (
    state: MutationPlan,
    runner: QueryExecutor | undefined = executor,
  ) => {
    const limit = PARAMETER_LIMITS[root.dialect ?? "postgres"];

    if (
      state.kind !== "insert" ||
      state.values.length < 2 ||
      !options.atomic ||
      !limit ||
      // Atomic values bind at most one parameter each, so most inserts are
      // provably under the limit without compiling; compilePlan caches otherwise.
      (state.atomicValues &&
        state.values.length * root.table.columns.length + 1000 <= limit) ||
      compilePlan(state).parameters.length <= limit
    ) {
      return executePlan(state, runner);
    }

    // Halve until every chunk fits; rows may bind different numbers of parameters.
    const chunks: MutationPlan[] = [];

    const split = (values: MutationPlan["values"]): void => {
      const chunk: MutationPlan = Object.freeze({ ...state, values });

      if (values.length > 1 && compileQuery(chunk).parameters.length > limit) {
        const middle = Math.ceil(values.length / 2);
        split(values.slice(0, middle));
        split(values.slice(middle));
      } else {
        chunks.push(chunk);
      }
    };

    split(state.values);

    return options.atomic(async (atomicExecutor) => {
      const rows: Record<string, unknown>[] = [];
      let affectedRows = 0;

      for (const chunk of chunks) {
        const result = await executePlan(chunk, atomicExecutor);
        rows.push(...result.rows);
        affectedRows += result.affectedRows;
      }

      return { rows, affectedRows };
    });
  };

  const build = (state: MutationPlan): object => {
    const execute = async () => {
      // `insert([])` is a no-op: nothing to write, nothing returned.
      // A scoped upsert's DO UPDATE is filtered by the scope: a conflict with a
      // row outside it writes nothing, which must not pass as success.
      const inScope = <Result extends { affectedRows: number }>(
        result: Result,
      ): Result => {
        if (
          state.conflict?.predicates?.length &&
          result.affectedRows < state.values.length
        ) {
          throw Object.assign(
            new Error(
              `symmetria: upsert on "${root.table.name}" conflicted with a row outside the database scope`,
            ),
            { code: "SYMMETRIA_OUT_OF_SCOPE" },
          );
        }

        return result;
      };

      const result =
        state.kind === "insert" && !state.values.length
          ? { rows: [], affectedRows: 0 }
          : state.conflict?.predicates?.length &&
              state.values.length > 1 &&
              options.atomic
            ? // Several rows: the rows the scope admits must not stay written.
              await options.atomic((atomicExecutor) =>
                executeChunked(state, atomicExecutor).then(inScope),
              )
            : inScope(await executeChunked(state));

      if (!state.selection.length) {
        return { affectedRows: result.affectedRows };
      }

      return state.single ? (result.rows[0] ?? null) : result.rows;
    };

    const builder = Object.freeze({
      returning: (
        selector: (
          row: RuntimeScope[string],
        ) => readonly SelectedColumn[] | ProjectionObject,
      ) =>
        build(
          Object.freeze({
            ...state,
            selection: readSelection(selector(scope[root.alias]!), bindings),
          }),
        ),
      where: (
        callback: (
          row: RuntimeScope[string],
        ) => Predicate | readonly Predicate[],
      ) => {
        if (kind === "insert") {
          throw new Error("symmetria: INSERT has no WHERE clause");
        }

        return build(
          Object.freeze({
            ...state,
            predicates: Object.freeze([
              ...state.predicates,
              wherePredicate(callback),
            ]),
          }),
        );
      },
      onConflict: (...names: string[]) => {
        if (kind !== "insert") {
          throw new Error(
            "symmetria: ON CONFLICT is only available for INSERT",
          );
        }

        const columns = names.map((name) => {
          const column = root.table.columns.find(
            (column) => column.name === name,
          );

          if (!column) {
            throw new Error(`symmetria: unknown conflict column "${name}"`);
          }

          return column;
        });

        if (new Set(names).size !== names.length) {
          throw new Error("symmetria: duplicate conflict columns");
        }

        return Object.freeze({
          doNothing: () =>
            build(
              Object.freeze({
                ...state,
                conflict: Object.freeze({
                  columns: Object.freeze(columns),
                  action: "nothing",
                  values: Object.freeze({}),
                }),
              }),
            ),
          doUpdate: (
            values:
              | string
              | Record<string, unknown>
              | ((
                  row: RuntimeScope[string],
                  excluded: RuntimeScope[string],
                ) => Record<string, unknown>),
            ...names: string[]
          ) => {
            if (!columns.length) {
              throw new Error("symmetria: DO UPDATE requires conflict columns");
            }

            if (
              typeof values === "string"
                ? new Set([values, ...names]).size !== names.length + 1
                : names.length > 0
            ) {
              throw new Error(
                "symmetria: doUpdate() requires distinct column names or a single values object/callback",
              );
            }

            if (root.alias === "excluded") {
              throw new Error(
                "symmetria: the table alias 'excluded' conflicts with PostgreSQL's upsert row",
              );
            }

            const excluded = Object.freeze({ ...root, alias: "excluded" });
            const conflictScope = createScope({ ...bindings, excluded });

            return build(
              Object.freeze({
                ...state,
                conflict: Object.freeze({
                  columns: Object.freeze(columns),
                  action: "update",
                  excluded,
                  ...(options.scope?.length
                    ? { predicates: Object.freeze([...options.scope]) }
                    : {}),
                  values: readValues(
                    typeof values === "string"
                      ? Object.fromEntries(
                          [values, ...names].map((name) => [
                            name,
                            conflictScope.excluded![name],
                          ]),
                        )
                      : typeof values === "function"
                        ? values(
                            conflictScope[root.alias]!,
                            conflictScope.excluded!,
                          )
                        : values,
                  ),
                }),
              }),
            );
          },
        });
      },
      toSQL: () => compileQuery(state),
      prepare: () => preparePlan(state, executor),
      [PREPARE_QUERY]: (scope: object, names: readonly string[]) =>
        preparePlan(state, executor, scope, names),
      execute,
      then: (
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) => execute().then(onFulfilled, onRejected),
    });

    return profile ? profile.trackBuilder(builder) : builder;
  };

  return build(initial);
};
