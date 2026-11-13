/** Query handles: the shared prototype of every query and the callable that extends it. */
import { freeze } from "../plan/freeze";
import { collectDataErrors } from "../codecs/deferred";
import { createExpression } from "../expressions";
import {
  compilePlan,
  executePlan,
  quoteIdentifier,
  rowDecoder,
} from "../compile";
import { derivedBinding } from "../plan/derived";
import { queryOccurrence } from "../plan/occurrence";
import { executePage } from "./pagination";
import { PREPARE_QUERY, preparePlan } from "./prepared";
import {
  QUERY_PLAN,
  TABLE_SOURCE,
  normalizeResult,
  type CommonTableExpression,
  type QueryExecutor,
  type QueryReference,
  type SelectPlan,
  type SourceDescription,
  type ConnectionHold,
} from "../plan/types";
import type { InspectQueryOptions } from "../../observability/inspection";
import type { executorProfiling } from "../../observability/profiling";
import { boundMethodDescriptors } from "../expressions/callable";
import { createContext } from "./context";
import type { ShapeCallback } from "./joins";
import type { TableRegistry } from "./registry";
import { applyShape } from "./shape";
import {
  QUERY_STATE,
  limitedPlan,
  initialPlan,
  resultRows,
  shapeFrame,
  type QueryHandle,
} from "./scope";
import {
  countPlan,
  existsPlan,
  readCount,
  readExists,
  rowCountError,
} from "./terminal";

/** Query handles share one prototype per database so methods stay cached. */
let streamOrdinal = 0;

/**
 * Rows through a server-side cursor on a reserved connection. The hold callback
 * publishes the connection's executor and stays open until iteration finishes,
 * so an early `break` or an error ends the transaction and frees the connection.
 */
async function* streamRows(
  hold: ConnectionHold,
  plan: SelectPlan,
  size: number,
): AsyncGenerator<Record<string, unknown>> {
  const compiled = compilePlan(plan);
  const decode = rowDecoder(plan);
  const cursor = quoteIdentifier(`__symmetria_stream_${++streamOrdinal}`);
  const ready = Promise.withResolvers<QueryExecutor>();
  const finished = Promise.withResolvers<void>();
  const held = hold(async (execute) => {
    ready.resolve(execute);
    await finished.promise;
  });
  held.catch(() => {});
  let failure: unknown;
  let failed = false;
  let execute: QueryExecutor | undefined;
  let declared = false;

  try {
    execute = await Promise.race([
      ready.promise,
      held.then(() => {
        throw new Error("symmetria: the stream connection closed early");
      }),
    ]);

    await execute({
      sql: `DECLARE ${cursor} NO SCROLL CURSOR FOR ${compiled.sql}`,
      parameters: compiled.parameters,
    });
    declared = true;

    while (true) {
      const { rows } = normalizeResult(
        await execute({
          sql: `FETCH FORWARD ${size} FROM ${cursor}`,
          parameters: [],
        }),
      );

      for (const row of rows) {
        yield decode(row);
      }

      if (rows.length < size) {
        break;
      }
    }
  } catch (error) {
    failure = error;
    failed = true;
    throw error;
  } finally {
    // Runs on completion, on an early `break` and on errors.
    if (!failed && declared && execute) {
      try {
        await execute({ sql: `CLOSE ${cursor}`, parameters: [] });
      } catch (error) {
        failure = error;
        failed = true;
      }
    }

    if (failed) {
      // Acquisition can fail before the hold callback starts waiting on finished.
      if (execute) {
        finished.reject(failure);
      } else {
        finished.resolve();
      }

      await held.catch(() => {});
      throw failure;
    }

    finished.resolve();
    // A failed CLOSE or COMMIT must not look like successful iteration.
    await held;
  }
}

export const createQueryFactory = (
  registry: TableRegistry,
  executor: QueryExecutor | undefined,
  profile: ReturnType<typeof executorProfiling>,
  hold?: ConnectionHold,
) => {
  const startPlan = (
    state: SelectPlan,
    allowScopedAlias: boolean,
    freshSource: boolean,
  ): SelectPlan => {
    if (!freshSource) {
      return state;
    }

    // Inside a shape callback the same table needs its own occurrence; at the top
    // level the table's root binding (and its cached column handles) is reused.
    if (shapeFrame.bindings) {
      const root = freeze({ ...state.root });

      return allowScopedAlias ? registry.scopedPlan(root) : initialPlan(root);
    }

    return allowScopedAlias
      ? registry.scopedPlan(state.root)
      : initialPlan(state.root);
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
      throw rowCountError(state, rows.length, required);
    }

    return rows[0] ?? null;
  };

  /**
   * A CTE named like a table would hide that table everywhere in the
   * statement, so `FROM "products"` would silently read the CTE instead.
   */
  const commonTableName = (name: string): string => {
    quoteIdentifier(name);
    const hidden = registry.snapshot.tables.find(
      (table) => table.sqlName === name,
    );

    if (hidden) {
      throw new Error(
        `symmetria: CTE "${name}" has the SQL name of table "${hidden.name}" and would hide it; choose another CTE name`,
      );
    }

    return name;
  };

  // Top-level queries share their table's root binding, so a query placed inside
  // another one gets its own occurrence; one per query object keeps repeated
  // embeds of the same query consistent.
  const embedded = (state: QueryHandle[typeof QUERY_STATE]): SelectPlan =>
    state.sharedRoot
      ? (state.embedded ??= queryOccurrence(state.plan))
      : state.plan;

  /** Every query is a callable whose methods live on one shared prototype. */
  const queryPrototype: object = Object.freeze(
    Object.create(
      Function.prototype,
      boundMethodDescriptors({
        get [QUERY_PLAN](): SelectPlan {
          return embedded((this as unknown as QueryHandle)[QUERY_STATE]);
        },
        get [TABLE_SOURCE](): SourceDescription {
          const state = (this as unknown as QueryHandle)[QUERY_STATE];

          return (state.source ??= freeze({
            binding: state.plan.root,
            schema: registry.snapshot,
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

          const derived = derivedBinding(
            embedded(this[QUERY_STATE]),
            commonTableName(name),
          );
          const { derived: _query, ...binding } = derived;
          const identity = freeze({});
          const definition: CommonTableExpression = freeze({
            name,
            identity,
            query: embedded(this[QUERY_STATE]),
            ...(options.materialized === undefined
              ? {}
              : { materialized: options.materialized }),
          });

          return createQuery(
            initialPlan(
              freeze({
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

          const derived = derivedBinding(
            embedded(this[QUERY_STATE]),
            commonTableName(name),
          );
          const { derived: _query, ...binding } = derived;
          const identity = freeze({});
          const reference = freeze({
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

          const definition: CommonTableExpression = freeze({
            name,
            identity,
            query: embedded(this[QUERY_STATE]),
            recursive,
            unionAll: options.unionAll ?? true,
          });

          return createQuery(
            initialPlan(freeze({ ...reference, cte: definition })),
            false,
            true,
          );
        },
        as(this: QueryHandle, name: string) {
          const { plan: state, allowScopedAlias } = this[QUERY_STATE];
          quoteIdentifier(name);

          if (state.selection.length) {
            return createQuery(
              initialPlan(derivedBinding(embedded(this[QUERY_STATE]), name)),
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

          const binding = freeze({
            ...state.root,
            alias: name,
            explicitAlias: true,
          });

          // Bare table aliases re-evaluate implicit scopes against the new binding.
          return createQuery(
            allowScopedAlias
              ? registry.scopedPlan(binding)
              : initialPlan(binding),
            allowScopedAlias,
            true,
          );
        },
        scalar(this: QueryHandle) {
          const state = this[QUERY_STATE].plan;

          if (state.selection.length !== 1) {
            throw new Error("symmetria: scalar() requires one selected column");
          }

          const query = embedded(this[QUERY_STATE]);

          return createExpression({
            ...query.selection[0]!,
            node: freeze({ kind: "subquery", query }),
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
          return (await import("../../observability/inspection")).inspectQuery(
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
          options: {
            size: number;
            after?: string | null | undefined;
            before?: string | null | undefined;
          },
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
        stream(this: QueryHandle, options: { size?: number } = {}) {
          const plan = this[QUERY_STATE].plan;
          const size = options.size ?? 1000;

          if (!Number.isSafeInteger(size) || size < 1) {
            throw new Error(
              "symmetria: stream size must be a positive integer",
            );
          }

          if (!hold) {
            throw new Error(
              "symmetria: stream() requires a driver with transaction support",
            );
          }

          return {
            [Symbol.asyncIterator]: () => streamRows(hold, plan, size),
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
        async count(this: QueryHandle) {
          return readCount(
            (await executePlan(countPlan(this[QUERY_STATE].plan), executor))
              .rows,
          );
        },
        async exists(this: QueryHandle) {
          return readExists(
            (
              await executePlan(
                existsPlan(this[QUERY_STATE].plan, false),
                executor,
              )
            ).rows,
          );
        },
      }),
    ),
  );

  const createQuery = (
    state: SelectPlan,
    allowScopedAlias = false,
    freshSource = false,
    prototype = queryPrototype,
    sharedRoot = false,
  ): object => {
    const query = ((
      callback: ShapeCallback | Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      const shared = freshSource && !shapeFrame.bindings;
      // Data errors in the callbacks fail the query when it runs.
      const [plan, failure] = collectDataErrors(() => {
        const current = freshSource
          ? startPlan(state, allowScopedAlias, freshSource)
          : queryOccurrence(state);

        return applyShape(
          createContext(registry, current),
          current.root,
          callback,
          options,
        );
      });

      return createQuery(
        failure && !plan.failure ? freeze({ ...plan, failure }) : plan,
        false,
        false,
        queryPrototype,
        shared,
      );
    }) as unknown as QueryHandle;
    Object.setPrototypeOf(query, prototype);
    Object.defineProperty(query, QUERY_STATE, {
      value: { plan: state, allowScopedAlias, freshSource, sharedRoot },
    });
    Object.freeze(query);

    return profile ? profile.trackBuilder(query) : query;
  };

  return { createQuery, queryPrototype };
};
