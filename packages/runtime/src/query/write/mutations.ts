/**
 * Table mutation builders: insert, update, delete and upsert with RETURNING; whole-table UPDATE/DELETE
 * must be confirmed with all(). A scoped database's writes check every written row against the scope.
 */
import { freeze } from "../plan/freeze";
import { childNodes } from "../plan/traverse";
import { embeddingColumns } from "../../schema/search-columns";
import { scopeViolation, sqlState } from "../../driver/errors";
import { collectDataErrors, dataError } from "../codecs/deferred";
import type { PredicateList } from "../select/types";
import {
  duplicateKeyError,
  duplicateKeyProbe,
  rejectDuplicateKeys,
} from "./conflict-keys";
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
  normalizeResult,
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

/** TRUE, FALSE or NULL for every row whatever the data; undefined when it depends on the data. */
type Truth = boolean | null | undefined;

/** Kleene AND: FALSE wins, then an unknown, then NULL. */
const allOf = (values: readonly Truth[]): Truth =>
  values.includes(false)
    ? false
    : values.includes(undefined)
      ? undefined
      : values.includes(null)
        ? null
        : true;

/** Kleene OR: TRUE wins, then an unknown, then NULL. */
const anyOf = (values: readonly Truth[]): Truth =>
  values.includes(true)
    ? true
    : values.includes(undefined)
      ? undefined
      : values.includes(null)
        ? null
        : false;

const negated = (value: Truth): Truth =>
  value === undefined || value === null ? value : !value;

/** No row passes: FALSE and NULL both filter every row out. */
const never = (
  description: PredicateDescription,
  root: TableBinding,
): boolean => {
  const value = truth(description, root);

  return value === false || value === null;
};

/** An aggregate that collapses the rows into one, not one under a window. */
const aggregates = (node: ValueNode): boolean =>
  node.kind === "aggregate" ||
  (node.kind !== "window" && childNodes(node).some(aggregates));

/** Aggregates without grouping: one row even over no rows. */
const collapsed = (query: SelectPlan): boolean =>
  !query.grouping.length &&
  query.selection.some((expression) => aggregates(expression.node));

/**
 * A subquery that returns no row whatever the data: `EXISTS` of it is false
 * and `IN` it is false. A filter no row passes still leaves the one row of an
 * aggregate without grouping (`count()` is 0).
 */
const empty = (query: SelectPlan, root: TableBinding): boolean =>
  query.limit === 0 ||
  query.having.some((description) => never(description, root)) ||
  (query.predicates.some((description) => never(description, root)) &&
    !collapsed(query));

/** A subquery that returns exactly one row whatever the data: an aggregate without grouping. */
const single = (query: SelectPlan): boolean =>
  collapsed(query) &&
  !query.having.length &&
  (query.limit === undefined ||
    (typeof query.limit === "number" && query.limit > 0)) &&
  (query.offset === undefined || query.offset === 0);

/**
 * What a node is for every row: a known value; a count, an integer of at
 * least 0 that is never NULL; or present, never NULL.
 */
type Known =
  | { readonly value: unknown }
  | { readonly count: true }
  | { readonly present: true };

const known = (node: ValueNode, root: TableBinding): Known | undefined => {
  switch (node.kind) {
    case "parameter":
      return { value: node.value };
    case "column":
      // A NOT NULL column of the written table: its rows are never outer-joined.
      return node.description.binding === root &&
        !node.description.binding.projection &&
        node.description.column.notNull
        ? { present: true }
        : undefined;
    case "rowCount":
      return empty(node.query, root) ? { value: 0 } : { count: true };
    case "subquery": {
      const { query } = node;

      // A scalar subquery without a row is NULL.
      if (empty(query, root)) {
        return { value: null };
      }

      const selected = query.selection[0]?.node;

      if (
        query.selection.length !== 1 ||
        selected?.kind !== "aggregate" ||
        query.grouping.length
      ) {
        return undefined;
      }

      // One row over no rows: COUNT is 0, every other aggregate NULL.
      if (query.predicates.some((description) => never(description, root))) {
        return { value: selected.name === "COUNT" ? 0 : null };
      }

      return selected.name === "COUNT" && single(query)
        ? { count: true }
        : undefined;
    }
    case "raw": {
      // A relation's exists(): `EXISTS (subquery)`.
      const [text, subquery] = node.parts;

      if (
        !node.composed ||
        node.parts.length !== 2 ||
        text !== "EXISTS " ||
        typeof subquery !== "object" ||
        subquery.kind !== "subquery"
      ) {
        return undefined;
      }

      return empty(subquery.query, root)
        ? { value: false }
        : single(subquery.query)
          ? { value: true }
          : undefined;
    }
    case "coalesce": {
      for (const value of node.values) {
        const entry = known(value, root);

        if (!entry || !("value" in entry) || entry.value !== null) {
          return entry;
        }
      }

      return { value: null };
    }
    default:
      return undefined;
  }
};

const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && !Number.isNaN(value)
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && NUMBER_TEXT.test(value)
        ? Number(value)
        : undefined;

/** The operator with its sides swapped: `a < b` is `b > a`. */
const MIRRORED: Readonly<Record<string, string>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

/** A comparison of two known values; only numbers and booleans are compared. */
const comparedValues = (
  left: unknown,
  operator: string,
  right: unknown,
): Truth => {
  if (left === null || right === null) {
    return operator === "IS DISTINCT FROM"
      ? left !== right
      : operator === "IS NOT DISTINCT FROM"
        ? left === right
        : null;
  }

  if (typeof left === "boolean" || typeof right === "boolean") {
    if (typeof left !== typeof right) {
      return undefined;
    }

    return operator === "=" || operator === "IS NOT DISTINCT FROM"
      ? left === right
      : operator === "<>" || operator === "IS DISTINCT FROM"
        ? left !== right
        : undefined;
  }

  const first = numberOf(left);
  const second = numberOf(right);

  if (first === undefined || second === undefined) {
    return undefined;
  }

  switch (operator) {
    case "=":
    case "IS NOT DISTINCT FROM":
      return first === second;
    case "<>":
    case "IS DISTINCT FROM":
      return first !== second;
    case "<":
      return first < second;
    case "<=":
      return first <= second;
    case ">":
      return first > second;
    case ">=":
      return first >= second;
    default:
      return undefined;
  }
};

/** `left operator right`, where the left side is never NULL and may be a count. */
const comparedPresent = (
  left: Known,
  operator: string,
  right: unknown,
): Truth => {
  if (right === null) {
    return operator === "IS DISTINCT FROM"
      ? true
      : operator === "IS NOT DISTINCT FROM"
        ? false
        : null;
  }

  const bound = numberOf(right);

  if (!("count" in left) || bound === undefined) {
    return undefined;
  }

  // A count is a whole number of at least 0.
  const outside = bound < 0 || !Number.isInteger(bound);

  switch (operator) {
    case "=":
    case "IS NOT DISTINCT FROM":
      return outside ? false : undefined;
    case "<>":
    case "IS DISTINCT FROM":
      return outside ? true : undefined;
    case ">=":
      return bound <= 0 ? true : undefined;
    case ">":
      return bound < 0 ? true : undefined;
    case "<=":
      return bound < 0 ? false : undefined;
    case "<":
      return bound <= 0 ? false : undefined;
    default:
      return undefined;
  }
};

const compared = (
  left: Known | undefined,
  operator: string,
  right: Known | undefined,
): Truth => {
  if (!left || !right) {
    return undefined;
  }

  if ("value" in left && "value" in right) {
    return comparedValues(left.value, operator, right.value);
  }

  if ("value" in right) {
    return comparedPresent(left, operator, right.value);
  }

  return "value" in left
    ? comparedPresent(right, MIRRORED[operator] ?? operator, left.value)
    : undefined;
};

/**
 * What a condition answers whatever the data, for the rows of the written
 * table `root`. A list that filtered down to nothing (`[userId && …]`
 * without a user), `and()`, `not(or())`, `notIn([])`, `notIn()` or
 * `notExists()` of a query that finds nothing (an emptied `in([])`,
 * `limit: 0`), `exists()` of an aggregate without grouping, a relation
 * quantifier over such a condition (`every(() => [skipped])`,
 * `none((post) => post.id.in([]))`), an aggregate of such a relation
 * (`count().is(0)`), a count compared with what every count passes
 * (`count().atLeast(0)`) and `isNot(null)` of a NOT NULL column hold for
 * every row.
 */
const truth = (
  description: PredicateDescription,
  root: TableBinding,
): Truth => {
  switch (description.kind) {
    case "group": {
      const values = description.predicates.map((child) => truth(child, root));

      return description.operator === "AND" ? allOf(values) : anyOf(values);
    }
    case "not":
      return negated(truth(description.predicate, root));
    case "notTrue": {
      const value = truth(description.predicate, root);

      return value === undefined ? undefined : value !== true;
    }
    case "membership": {
      if (!Array.isArray(description.values)) {
        // `x IN (no rows)` is FALSE even for a NULL x, `NOT IN` TRUE.
        return empty(description.values as SelectPlan, root)
          ? description.negated
          : undefined;
      }

      if (!description.values.length) {
        return description.negated;
      }

      const value = known(description.value, root);
      const found = anyOf(
        description.values.map((node: ValueNode) =>
          compared(value, "=", known(node, root)),
        ),
      );

      return description.negated ? negated(found) : found;
    }
    case "exists":
      return empty(description.query, root)
        ? description.negated
        : single(description.query)
          ? !description.negated
          : undefined;
    case "comparison":
      return compared(
        known(description.left, root),
        description.operator,
        known(description.right, root),
      );
    case "nullCheck": {
      const value = known(description.value, root);

      return !value
        ? undefined
        : "value" in value
          ? (value.value === null) !== description.negated
          : description.negated;
    }
    case "between": {
      const value = known(description.value, root);

      return allOf([
        compared(value, ">=", known(description.lower, root)),
        compared(value, "<=", known(description.upper, root)),
      ]);
    }
    default:
      return undefined;
  }
};

/**
 * PostgreSQL's "ON CONFLICT DO UPDATE command cannot affect row a second
 * time". Its SQLSTATE 21000 also reports a subquery that returned more than
 * one row; the routine that raised it (or, without one, the untranslated
 * command name in the message) tells them apart.
 */
const conflictedTwice = (error: unknown): boolean => {
  if (sqlState(error) !== "21000") {
    return false;
  }

  const { routine, message } = error as {
    routine?: unknown;
    message?: unknown;
  };

  return typeof routine === "string"
    ? routine === "ExecOnConflictUpdate"
    : typeof message === "string" && message.includes("ON CONFLICT DO UPDATE");
};

/** Refusals of a filter that holds for every row; a later where() that adds a condition lifts them. */
const everyRowErrors = new WeakSet<object>();

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
   * UPDATE or DELETE, so they move into a primary-key subquery. `everyRow`
   * says whether the filter holds for every row whatever the data.
   */
  const wherePredicate = (
    callback: (row: RuntimeScope[string]) => Predicate | PredicateList,
  ): { description: PredicateDescription; everyRow: boolean } => {
    // An array combines with AND, like the where option of a query.
    const evaluate = (row: RuntimeScope[string]): Predicate => {
      const result = callback(row);

      return Array.isArray(result) ? and(...result) : (result as Predicate);
    };

    if (!options.context) {
      const description = readPredicate(evaluate(scope[root.alias]!));

      return { description, everyRow: truth(description, root) === true };
    }

    const context = options.context(initialPlan(root));
    const description = readPredicate(evaluate(context.scope()[root.alias]!));
    const everyRow = truth(description, root) === true;

    if (!context.plan.joins.length) {
      return { description, everyRow };
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

    return {
      description: freeze({
        kind: "membership",
        value,
        values: subquery,
        negated: false,
      }),
      everyRow,
    };
  };

  /** where() filters that hold for every row, also once moved into a primary-key subquery. */
  const everyRowFilters = new WeakSet<PredicateDescription>();

  /**
   * Whether the plan's filter has a condition that depends on the data: a
   * lookup's key or a where() that does not hold for every row. A $scope()
   * bounds the write but is no filter.
   */
  const conditioned = (plan: MutationPlan): boolean =>
    plan.predicates.some(
      (description) =>
        description.kind !== "scope" &&
        !everyRowFilters.has(description) &&
        truth(description, root) !== true,
    );

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
        // Own keys only: a column named "constructor" is not Object's.
        if (
          !Object.hasOwn(values, column.name) ||
          values[column.name] === undefined
        ) {
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
      const upsert = plan.conflict?.action === "update" && plan.conflict;

      return plan.checks || upsert
        ? result.catch((error: unknown) => {
            // PostgreSQL found two rows with one key ("cannot affect row a
            // second time"): the documented refusal, whatever the spelling.
            if (upsert && conflictedTwice(error)) {
              throw duplicateKeyError(root, upsert.columns, error);
            }

            throw plan.checks ? scopeViolation(error) : error;
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

      // Split over several statements, a later row with an earlier row's key
      // would overwrite it without an error. Keys this code cannot compare
      // as their type does (inet, interval, jsonb …) are compared by
      // PostgreSQL first, in the same transaction.
      if (state.conflict?.action === "update") {
        const probe = duplicateKeyProbe(state.conflict.columns, state.values);
        const execute = atomicExecutor ?? executor;

        if (
          probe &&
          execute &&
          normalizeResult(await execute(probe)).rows.length
        ) {
          throw duplicateKeyError(root, state.conflict.columns);
        }
      }

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

        const next = derive(() => {
          const { description, everyRow } = wherePredicate(callback);
          const filtered =
            !everyRow || !!state.unrestricted || conditioned(state);

          if (everyRow) {
            everyRowFilters.add(description);
          }

          // A filter that holds for every row is a missing filter: the write
          // would reach the whole table without saying so. Request values
          // often empty it (`[userId && …]`), so it is refused when the write
          // runs, like a missing where(), and reaches the write's catch(). A
          // condition from another where() or the lookup makes it a filter;
          // all(), before or after, confirms every row.
          if (!filtered) {
            const refusal = new Error(
              `symmetria: ${kind}() where() leaves no condition (an empty list, and() or notIn([]) holds for every row); call .all() to ${kind} every row`,
            );
            everyRowErrors.add(refusal);
            dataError(refusal);
          }

          const { failure: earlier, ...rest } = state;

          return freeze({
            ...(earlier &&
            !(filtered && everyRowErrors.has(earlier.error as object))
              ? state
              : rest),
            predicates: freeze([...state.predicates, description]),
          });
        });

        return build(next);
      },
      all: () => {
        if (kind === "insert") {
          throw new Error("symmetria: all() applies to UPDATE and DELETE");
        }

        // Every row is what all() asks for: a where() that holds for every
        // row is no longer refused.
        const { failure, ...rest } = state;

        return build(
          freeze({
            ...(failure && everyRowErrors.has(failure.error as object)
              ? rest
              : state),
            unrestricted: true as const,
          }),
        );
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
