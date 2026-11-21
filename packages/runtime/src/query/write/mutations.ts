/**
 * Table mutation builders: insert, update, delete and upsert with RETURNING; whole-table UPDATE/DELETE
 * must be confirmed with all(). A scoped database's writes check every written row against the scope.
 */
import { freeze } from "../plan/freeze";
import { embeddingColumns } from "../../schema/search-columns";
import { scopeViolation } from "../../driver/errors";
import { collectDataErrors, dataError } from "../codecs/deferred";
import type { PredicateList } from "../select/types";
import { rejectDuplicateKeys } from "./conflict-keys";
import type { MutationOptions } from "./types";
import {
  compilePlan,
  compileQuery,
  executePlan,
  executeCompiled,
} from "../compile";
import { executorProfiling } from "../../observability/profiling";
import { returningProjection, returningSelector } from "../select/projections";
import { validatePredicate } from "../select/scope";
import { columnsOnly } from "../select/suggest";
import { PREPARE_QUERY, preparePlan } from "../select/prepared";
import {
  and,
  COLUMN_EXPRESSION,
  readPredicate,
  valueNode,
  jsonNullNode,
  type Predicate,
  type PredicateDescription,
  type ValueNode,
} from "../expressions";
import {
  primaryKeyColumns,
  uniqueColumnIndexes,
  type ColumnSnapshot,
} from "../../schema/assembly";
import {
  createScope,
  initialPlan,
  readSelection,
  type RuntimeScope,
} from "../select";
import {
  DEFAULT_VALUE,
  WRITE_TAG,
  type CompiledQuery,
  type MutationPlan,
  type QueryExecutor,
  type SelectPlan,
  type TableBinding,
} from "../plan/types";

/** PostgreSQL's wire-protocol bind-parameter limit; larger multi-row INSERTs are split into atomic chunks. */
const PARAMETER_LIMIT = 65535;

/** A JS null stored as JSON null; a jsonb(schema) that rejects null makes it a data error. */
const jsonNullValue = (
  codec: TableBinding["codecs"][string] | undefined,
  sqlType: string,
): ValueNode => {
  try {
    return jsonNullNode(codec, sqlType);
  } catch (error) {
    dataError(error);

    return valueNode(null);
  }
};

/**
 * A condition every row passes whatever the data: a list that filtered down to
 * nothing (`[userId && …]` without a user), `and()`, `not(or())`, `notIn([])`.
 */
const unconditional = (description: PredicateDescription): boolean => {
  switch (description.kind) {
    case "group":
      return description.operator === "AND"
        ? description.predicates.every(unconditional)
        : description.predicates.some(unconditional);
    case "not":
      return impossible(description.predicate);
    case "membership":
      return (
        description.negated &&
        Array.isArray(description.values) &&
        !description.values.length
      );
    default:
      return false;
  }
};

/** A condition no row passes: `or()`, `in([])`. */
const impossible = (description: PredicateDescription): boolean => {
  switch (description.kind) {
    case "group":
      return description.operator === "OR"
        ? description.predicates.every(impossible)
        : description.predicates.some(impossible);
    case "not":
      return unconditional(description.predicate);
    case "membership":
      return (
        !description.negated &&
        Array.isArray(description.values) &&
        !description.values.length
      );
    default:
      return false;
  }
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
  const bindings = freeze({ [root.alias]: root });
  const scope = createScope(bindings);

  const columnNode = (column: ColumnSnapshot): ValueNode =>
    freeze({
      kind: "column",
      description: freeze({ binding: root, column }),
    });

  /**
   * Predicates may follow relation paths; the resulting JOINs cannot live in an
   * UPDATE or DELETE, so they move into a primary-key subquery.
   */
  const wherePredicate = (
    callback: (row: RuntimeScope[string]) => Predicate | PredicateList,
  ): PredicateDescription => {
    // An array combines with AND, like the where option of a query.
    const evaluate = (row: RuntimeScope[string]): Predicate => {
      const result = callback(row);

      return Array.isArray(result) ? and(...result) : (result as Predicate);
    };

    // A filter that holds for every row is a missing filter: the write would
    // reach the whole table without saying so.
    const conditional = (
      description: PredicateDescription,
    ): PredicateDescription => {
      if (unconditional(description)) {
        throw new Error(
          `symmetria: ${kind}() where() leaves no condition (an empty list, and() or notIn([]) holds for every row); call .all() to ${kind} every row`,
        );
      }

      return description;
    };

    if (!options.context) {
      return conditional(readPredicate(evaluate(scope[root.alias]!)));
    }

    const context = options.context(initialPlan(root));
    const description = conditional(
      readPredicate(evaluate(context.scope()[root.alias]!)),
    );

    if (!context.plan.joins.length) {
      return description;
    }

    const keys = primaryKeyColumns(root.table);

    if (!keys.length) {
      throw new Error(
        `symmetria: relation paths in ${kind}().where() require a primary key on "${root.alias}"`,
      );
    }

    const subquery: SelectPlan = freeze({
      ...context.plan,
      selection: freeze(
        keys.map((column) =>
          freeze({ outputName: column.name, node: columnNode(column) }),
        ),
      ),
      predicates: freeze([...context.plan.predicates, description]),
    });
    const value: ValueNode =
      keys.length === 1
        ? columnNode(keys[0]!)
        : freeze({
            kind: "tuple",
            values: freeze(keys.map(columnNode)),
          });

    return freeze({
      kind: "membership",
      value,
      values: subquery,
      negated: false,
    });
  };

  // Captured by the initial immutable plan; conflict assignments are walked separately.
  let atomicValues = true;
  const columnsByName = new Map(
    root.table.columns.map((column) => [column.name, column]),
  );
  const requiredColumns = root.table.columns.filter(
    (column) => column.notNull && !column.default,
  );

  const readValues = (
    values: Record<string, unknown>,
    insert = false,
  ): Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>> => {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      dataError(new Error("symmetria: values must be an object"));

      return freeze(Object.create(null));
    }

    // undefined means omitted, as for query options; unknown keys still fail.
    const result: Record<string, ValueNode | typeof DEFAULT_VALUE> =
      Object.create(null);
    let assigned = 0;

    for (const name of Object.keys(values)) {
      const value = values[name];
      const column = columnsByName.get(name);

      if (!column) {
        throw new Error(`symmetria: unknown column "${root.alias}.${name}"`);
      }

      if (value === undefined) {
        continue;
      }

      // A non-nullable json/jsonb column stores null as the JSON value null.
      const jsonNull =
        value === null &&
        column.notNull &&
        (column.sqlType === "jsonb" || column.sqlType === "json");

      // Errors about the values themselves fail the write when it runs.
      if (value === null && column.notNull && !jsonNull) {
        dataError(
          new Error(`symmetria: "${root.alias}.${name}" cannot be null`),
        );
      }

      if (value === DEFAULT_VALUE && !column.default && column.notNull) {
        dataError(
          new Error(`symmetria: "${root.alias}.${name}" has no default`),
        );
      }

      if (
        column.default?.kind === "sql" &&
        column.default.sql === "identity" &&
        value !== DEFAULT_VALUE
      ) {
        dataError(
          new Error(
            `symmetria: "${root.alias}.${name}" is generated always; use defaultValue`,
          ),
        );
      }

      // A text column would store an object as its JSON text without a word.
      if (
        typeof value === "object" &&
        value !== null &&
        !root.codecs[name] &&
        !(COLUMN_EXPRESSION in value) &&
        /^(?:text|varchar|character varying|char|character|bpchar)\b/.test(
          column.sqlType,
        ) &&
        !column.sqlType.endsWith("[]")
      ) {
        dataError(
          new Error(
            `symmetria: "${root.alias}.${name}" is ${column.sqlType} and takes a string, received ${Array.isArray(value) ? "an array" : "an object"}`,
          ),
        );
      }

      const node =
        value === DEFAULT_VALUE
          ? DEFAULT_VALUE
          : jsonNull
            ? jsonNullValue(root.codecs[name], column.sqlType)
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
      for (const column of requiredColumns) {
        if (values[column.name] === undefined) {
          dataError(
            new Error(
              `symmetria: missing required column "${root.alias}.${column.name}"`,
            ),
          );
        }
      }
    }

    if (!insert && !assigned) {
      dataError(new Error("symmetria: update() requires at least one value"));
    }

    if (!insert) {
      // New text under an old embedding would be found by what it used to say.
      for (const { column, sources } of embeddingColumns.get(root.table) ??
        []) {
        if (
          result[column] === undefined &&
          sources.some((source) => result[source] !== undefined)
        ) {
          result[column] = valueNode(null, root.codecs[column]);
        }
      }
    }

    return freeze(result);
  };

  // A lookup's key and the $scope() restrict UPDATE and DELETE; the $scope()
  // predicates alone are checked against every row an INSERT or UPDATE writes.
  const restriction = options.scope?.() ?? [];
  const checks =
    kind !== "delete" && restriction.length
      ? restriction.filter((description) => description.kind === "scope")
      : [];

  const [initial, failure] = collectDataErrors((): MutationPlan => {
    const resolved =
      typeof input === "function"
        ? input(
            columnsOnly(
              root.table,
              scope[root.alias]!,
              `${kind === "insert" ? "insert" : "update"} values`,
            ),
          )
        : input;
    const rows = Array.isArray(resolved) ? resolved : [resolved];
    const single = kind === "insert" && !Array.isArray(resolved);

    if (kind === "update" && !rows.length) {
      dataError(new Error("symmetria: update() requires at least one value"));
    }

    const values = freeze(
      kind === "delete"
        ? []
        : rows.map((row) => readValues(row, kind === "insert")),
    );

    return freeze({
      kind,
      root,
      bindings,
      values,
      atomicValues,
      predicates: freeze(kind === "insert" ? [] : [...restriction]),
      selection: freeze([]),
      ...(checks.length ? { checks: freeze(checks) } : {}),
      ...(single ? { single: true as const } : {}),
    });
  });

  /** The next immutable state; data errors found while building it fail it when it runs. */
  const derive = (next: () => MutationPlan): MutationPlan => {
    const [plan, error] = collectDataErrors(next);

    return error && !plan.failure ? freeze({ ...plan, failure: error }) : plan;
  };

  const chunkPlans = new WeakMap<MutationPlan, readonly MutationPlan[]>();

  const executeChunked = async (
    state: MutationPlan,
    compile?: (plan: MutationPlan) => CompiledQuery,
  ) => {
    const limit = PARAMETER_LIMIT;
    const compiled = compile ?? compilePlan;
    let chunks = chunkPlans.get(state);

    const run = (plan: MutationPlan, execute: QueryExecutor | undefined) => {
      const result = compile
        ? executeCompiled(plan, compile(plan), execute)
        : executePlan(plan, execute);

      return plan.checks
        ? result.catch((error: unknown) => {
            throw scopeViolation(error);
          })
        : result;
    };

    if (
      state.kind !== "insert" ||
      state.values.length < 2 ||
      !options.atomic ||
      !limit ||
      // Atomic values bind at most one parameter each, so most inserts are
      // provably under the limit without compiling; compilePlan caches otherwise.
      (state.atomicValues &&
        state.values.length * root.table.columns.length + 1000 <= limit)
    ) {
      return run(state, executor);
    }

    if (!chunks && compiled(state).parameters.length <= limit) {
      // Rows sent as one array per column fit one statement however many
      // they are. An insert this large used to be several statements in a
      // savepoint, so a caught failure left the transaction usable: it still does.
      return state.values.length * Object.keys(state.values[0]!).length > limit
        ? options.atomic((atomicExecutor) => run(state, atomicExecutor))
        : run(state, executor);
    }

    // Halve until every chunk fits; rows may bind different numbers of parameters.
    if (!chunks) {
      const plans: MutationPlan[] = [];

      const split = (values: MutationPlan["values"]): void => {
        const chunk: MutationPlan = freeze({ ...state, values });

        if (values.length > 1 && compiled(chunk).parameters.length > limit) {
          const middle = Math.ceil(values.length / 2);
          split(values.slice(0, middle));
          split(values.slice(middle));
        } else {
          plans.push(chunk);
        }
      };

      split(state.values);
      chunks = plans;
      chunkPlans.set(state, chunks);
    }

    const runChunks = async (atomicExecutor: QueryExecutor | undefined) => {
      const rows: Record<string, unknown>[] = [];
      let affectedRows = 0;

      for (const chunk of chunks!) {
        const result = await run(chunk, atomicExecutor);
        rows.push(...result.rows);
        affectedRows += result.affectedRows;
      }

      return { rows, affectedRows };
    };

    return options.atomic(runChunks);
  };

  const build = (state: MutationPlan): object => {
    const executeUsing = async (
      compile?: (plan: MutationPlan) => CompiledQuery,
    ) => {
      // `insert([])` is a no-op: nothing to write, nothing returned. Scope
      // checks run inside each statement, which fails as a whole.
      const result =
        state.kind === "insert" && !state.values.length
          ? { rows: [], affectedRows: 0 }
          : await executeChunked(state, compile);

      if (!state.selection.length) {
        return { affectedRows: result.affectedRows };
      }

      return state.single ? (result.rows[0] ?? null) : result.rows;
    };

    const execute = () => executeUsing();

    const builder = freeze({
      returning: (selector?: unknown, ...names: unknown[]) =>
        build(
          derive(() =>
            freeze({
              ...state,
              selection: readSelection(
                returningProjection(
                  returningSelector(selector, names) as never,
                  columnsOnly(root.table, scope[root.alias]!, "RETURNING"),
                  root.table,
                ),
                bindings,
              ),
            }),
          ),
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
          derive(() =>
            freeze({
              ...state,
              predicates: freeze([
                ...state.predicates,
                wherePredicate(callback),
              ]),
            }),
          ),
        );
      },
      all: () => {
        if (kind === "insert") {
          throw new Error("symmetria: all() applies to UPDATE and DELETE");
        }

        return build(freeze({ ...state, unrestricted: true as const }));
      },
      onConflict: (...names: string[]) => {
        if (kind !== "insert") {
          throw new Error(
            "symmetria: ON CONFLICT is only available for INSERT",
          );
        }

        // A single name that is no column may be a unique index, as by.<name> names it.
        const index =
          names.length === 1 &&
          !root.table.columns.some((column) => column.name === names[0])
            ? uniqueColumnIndexes(root.table).find(
                (definition) => definition.name === names[0],
              )
            : undefined;
        const columns = index
          ? index.columns
          : names.map((name) => {
              const column = root.table.columns.find(
                (column) => column.name === name,
              );

              if (!column) {
                throw new Error(
                  `symmetria: unknown conflict column "${name}"; the target is columns or the name of a unique key`,
                );
              }

              return column;
            });

        if (new Set(names).size !== names.length) {
          throw new Error("symmetria: duplicate conflict columns");
        }

        return freeze({
          doNothing: () =>
            build(
              freeze({
                ...state,
                conflict: freeze({
                  columns: freeze(columns),
                  action: "nothing",
                  values: freeze({}),
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
            ...rest: unknown[]
          ) => {
            if (!columns.length) {
              throw new Error("symmetria: DO UPDATE requires conflict columns");
            }

            // `doUpdate(values, { where })` vs `doUpdate("name", "active")`.
            const conditional =
              typeof values !== "string" &&
              rest.length === 1 &&
              rest[0] !== null &&
              typeof rest[0] === "object";
            const names = conditional ? [] : (rest as string[]);
            const where = conditional
              ? (rest[0] as { where?: unknown }).where
              : undefined;

            if (
              conditional &&
              (typeof where !== "function" ||
                Object.keys(rest[0] as object).some((key) => key !== "where"))
            ) {
              throw new Error(
                "symmetria: doUpdate() options accept a where callback only",
              );
            }

            if (
              typeof values === "string"
                ? new Set([values, ...names]).size !== names.length + 1
                : names.some((name) => typeof name !== "string") ||
                  (names.length > 0 && !conditional)
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

            const excluded = freeze({ ...root, alias: "excluded" });
            const conflictScope = createScope({ ...bindings, excluded });

            // The plan's scope checks also guard the conflicting row.
            return build(
              derive(() => {
                rejectDuplicateKeys(root, columns, state.values);

                const condition = where
                  ? (() => {
                      const result = (
                        where as (
                          row: RuntimeScope[string],
                          excluded: RuntimeScope[string],
                        ) => Predicate | PredicateList
                      )(conflictScope[root.alias]!, conflictScope.excluded!);
                      const description = readPredicate(
                        Array.isArray(result)
                          ? and(...(result as PredicateList))
                          : (result as Predicate),
                      );
                      validatePredicate(description, {
                        ...bindings,
                        excluded,
                      });

                      return description;
                    })()
                  : undefined;

                return freeze({
                  ...state,
                  conflict: freeze({
                    columns: freeze(columns),
                    action: "update" as const,
                    excluded,
                    ...(condition ? { condition } : {}),
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
                });
              }),
            );
          },
        });
      },
      toSQL: () => compileQuery(state),
      prepare: () => preparePlan(state, executor, undefined, [], executeUsing),
      [PREPARE_QUERY]: (scope: object, names: readonly string[]) =>
        preparePlan(state, executor, scope, names, executeUsing),
      execute,
      [Symbol.toStringTag]: WRITE_TAG,
      then: (
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) => execute().then(onFulfilled, onRejected),
      catch: (onRejected?: ((reason: unknown) => unknown) | null) =>
        execute().catch(onRejected),
      finally: (onFinally?: (() => void) | null) =>
        execute().finally(onFinally),
    });

    return profile ? profile.trackBuilder(builder) : builder;
  };

  const error = options.failure ?? failure;

  return build(error ? freeze({ ...initial, failure: error }) : initial);
};
