/** Query handles: the shared prototype of every query and the callable that extends it. */
import { AsyncLocalStorage } from "node:async_hooks";
import { whenCursorEnds } from "../../driver/transactions";
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
  CONNECTION_CLAIM,
  QUERY_PLAN,
  QUERY_TAG,
  TABLE_SOURCE,
  normalizeResult,
  type CommonTableExpression,
  type Driver,
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
  EMPTY,
  QUERY_STATE,
  limitedPlan,
  initialPlan,
  resultRows,
  shapeFrame,
  type QueryHandle,
  createScope,
  readSelection,
} from "./scope";
import {
  countPlan,
  deferredRead,
  existsPlan,
  readCount,
  readExists,
  rowCountError,
} from "./terminal";

/** Query handles share one prototype per database so methods stay cached. */
let streamOrdinal = 0;

const streams = new WeakMap<object, Set<() => Promise<void>>>();

/**
 * Ends the streams open on a driver, for `$close()`. A stream holds a
 * transaction until its loop ends, and a loop that awaits `$close()` would
 * wait for the close while the close waited for the loop. The loop's next
 * step fails instead, and one that stops there (`break`, `return`) just ends.
 */
export const endStreams = async (owner: object): Promise<void> => {
  await Promise.all([...(streams.get(owner) ?? [])].map((end) => end()));
};

const closedStream = () =>
  new Error("symmetria: the database was closed while this stream was open");

const endedStream = () =>
  new Error(
    "symmetria: the transaction of this stream ended while the stream was open and was rolled back; finish or break out of a stream() before its transaction callback returns",
  );

/** How a dropped stream gives its connection back: see `dropped`. */
type StreamLink = { release?: () => void };

/**
 * An iterator read partly and then dropped without `return()` never reaches
 * its `finally`; once it is garbage, its transaction ends and the connection
 * goes back to the pool.
 */
const dropped = new FinalizationRegistry<StreamLink>((link) =>
  link.release?.(),
);

/**
 * Rows through a server-side cursor on a reserved connection. The hold callback
 * publishes the connection's executor and stays open until iteration finishes,
 * so an early `break` or an error ends the transaction and frees the connection.
 */
async function* streamRows(
  hold: ConnectionHold,
  plan: SelectPlan,
  size: number,
  claim: { open: boolean } | undefined,
  link: StreamLink,
): AsyncGenerator<Record<string, unknown>> {
  const compiled = compilePlan(plan);
  const decode = rowDecoder(plan);
  const cursor = quoteIdentifier(`__symmetria_stream_${++streamOrdinal}`);
  const ready = Promise.withResolvers<QueryExecutor>();
  const finished = Promise.withResolvers<void>();
  // A stream of the pool holds a transaction of its own; one of a
  // transaction or savepoint runs on that transaction's connection.
  const owner = (hold as { owner?: object }).owner;
  const held = hold(async (execute) => {
    if (!owner) {
      // Like the transaction's other statements, its statements are checked
      // where they are called: a fetch from inside one of its savepoints is
      // refused as a plain query there is, instead of waiting for the
      // savepoint that waits for it.
      ready.resolve(execute);
    } else {
      // The loop runs in its caller's context; its statements run in its
      // own transaction's, as that transaction's statements do (a tracer's
      // span, a profile).
      const inside = AsyncLocalStorage.snapshot();

      ready.resolve((query) => inside(() => execute(query)));
    }

    await finished.promise;
  });
  held.catch(() => {});
  let failure: unknown;
  let failed = false;
  let execute: QueryExecutor | undefined;
  let declared = false;
  // Between two rows the stream waits for its reader and owns no statement,
  // so it can be ended there at once; a fetch in flight ends when it returns.
  let waiting = false;
  let closing = false;
  let ended: Promise<void> | undefined;
  // The transaction or savepoint ended under the open stream and rolled back
  // with its cursor: rows fetched before must not be handed out.
  let rolledBack = false;
  const stopListening = whenCursorEnds(cursor, () => {
    rolledBack = true;
  });
  const end = async () => {
    closing = true;

    if (waiting && execute) {
      const run = execute;

      await (ended ??= (async () => {
        if (declared) {
          await run({ sql: `CLOSE ${cursor}`, parameters: [] }).catch(() => {});
        }

        finished.resolve();
        await held.catch(() => {});
      })());
    }
  };

  if (owner) {
    let open = streams.get(owner);

    if (!open) {
      streams.set(owner, (open = new Set()));
    }

    open.add(end);
  }

  try {
    execute = await Promise.race([
      ready.promise,
      held.then(() => {
        throw new Error("symmetria: the stream connection closed early");
      }),
    ]);

    if (claim) {
      claim.open = true;
    }

    link.release = () => {
      if (claim) {
        claim.open = false;
      }

      if (owner) {
        streams.get(owner)?.delete(end);
      }

      finished.resolve();
    };

    // A stream reads to the end, so its cursor is planned like the plain
    // query. PostgreSQL otherwise plans a cursor to start fast, and may pick
    // an approximate index (pgvector's) that returns only some of the rows.
    // The setting is read when the cursor is declared; inside the caller's
    // transaction it goes back to its value afterwards, so the rest of that
    // transaction plans its cursors as before.
    const previous = owner
      ? undefined
      : normalizeResult(
          await execute({
            sql: "SELECT current.setting, set_config('cursor_tuple_fraction', '1', true) FROM (SELECT current_setting('cursor_tuple_fraction') AS setting OFFSET 0) AS current",
            parameters: [],
          }),
        ).rows[0]?.setting;

    if (owner) {
      await execute({
        sql: "SET LOCAL cursor_tuple_fraction = 1",
        parameters: [],
      });
    }

    await execute({
      sql: `DECLARE ${cursor} NO SCROLL CURSOR FOR ${compiled.sql}`,
      parameters: compiled.parameters,
    });
    declared = true;

    if (typeof previous === "string") {
      await execute({
        sql: "SELECT set_config('cursor_tuple_fraction', $1, true)",
        parameters: [previous],
      });
    }

    while (true) {
      const { rows } = normalizeResult(
        await execute({
          sql: `FETCH FORWARD ${size} FROM ${cursor}`,
          parameters: [],
        }),
      );

      if (closing) {
        throw closedStream();
      }

      if (rolledBack) {
        throw endedStream();
      }

      for (const row of rows) {
        waiting = true;
        yield decode(row);
        waiting = false;

        if (closing) {
          throw closedStream();
        }

        if (rolledBack) {
          throw endedStream();
        }
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
    if (claim) {
      claim.open = false;
    }

    dropped.unregister(link);
    stopListening();

    if (owner) {
      streams.get(owner)?.delete(end);
    }

    // $close() has ended the transaction already; only the error, if the
    // reader went on, is left to report.
    if (ended) {
      await ended;

      if (failed) {
        throw failure;
      }

      return;
    }

    // Runs on completion, on an early `break` and on errors, also on a row
    // that failed to decode: inside $transaction an open cursor would roll
    // the whole transaction back. After a failed statement CLOSE fails too;
    // the first error is the one reported. A rollback closed it already, and
    // a reader that stops there (`break`, `return`) just ends.
    if (declared && execute && !rolledBack) {
      try {
        await execute({ sql: `CLOSE ${cursor}`, parameters: [] });
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
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

  /**
   * The plan a terminal runs. A query that was given options but no fields
   * (`users({ where })`) reads the root's own columns, computed fields
   * included. A bare table or alias is not such a query: awaiting `db.users`
   * by accident must not read a whole table.
   */
  const runnable = (state: QueryHandle[typeof QUERY_STATE]): SelectPlan => {
    const { plan } = state;

    if (plan.selection.length || state.freshSource || plan.grouping.length) {
      return plan;
    }

    return (state.whole ??= freeze({
      ...plan,
      selection: readSelection(
        createScope({ [plan.root.alias]: plan.root })[plan.root.alias]!,
        plan.bindings,
      ),
    }));
  };

  // Top-level queries share their table's root binding, so a query placed inside
  // another one gets its own occurrence; one per query object keeps repeated
  // embeds of the same query consistent.
  const embedded = (state: QueryHandle[typeof QUERY_STATE]): SelectPlan =>
    state.sharedRoot
      ? (state.embedded ??= queryOccurrence(state.plan))
      : state.plan;

  /**
   * The plan of `aggregate()`: its shape over the rows the source selects.
   * A grouped source keeps its groups (and its LIMIT, OFFSET and ordering of
   * them), so a shape over several groups yields several rows. Otherwise
   * LIMIT, OFFSET, DISTINCT and row locks pick the rows, which therefore stay
   * in a derived table with the source's columns under their own names and
   * the table's relations, so relation paths and relation aggregates still
   * work; an ordering only matters there with a LIMIT or OFFSET.
   */
  const aggregatePlan = (
    handle: QueryHandle,
    shape: ShapeCallback,
  ): SelectPlan => {
    type Shaped = (shape: ShapeCallback) => QueryHandle;
    const { plan } = handle[QUERY_STATE];

    if (plan.grouping.length || plan.having.length) {
      return (handle as unknown as Shaped)(shape)[QUERY_STATE].plan;
    }

    if (typeof plan.limit === "object" || typeof plan.offset === "object") {
      throw new Error("symmetria: bind a parameterized LIMIT with prepare()");
    }

    if (plan.distinct && plan.selection.length) {
      throw new Error(
        `symmetria: aggregate() reads rows of "${plan.root.table.name}", and a DISTINCT query returns distinct values of its fields instead; count them with count(), or aggregate the fields through a derived table: query.as("name").aggregate(…)`,
      );
    }

    const limited = plan.limit !== undefined || plan.offset !== undefined;

    if (!limited && !plan.distinct && !plan.locking) {
      const shaped = (handle as unknown as Shaped)(shape)[QUERY_STATE].plan;

      return shaped.ordering.length
        ? freeze({ ...shaped, ordering: EMPTY })
        : shaped;
    }

    const { root } = plan;
    const { cte: _cte, cteReference: _reference, ...binding } = root;
    const rows = freeze({
      ...plan,
      selection: freeze(
        root.table.columns.map((column) =>
          freeze({
            outputName: column.sqlName,
            node: freeze({
              kind: "column" as const,
              description: freeze({ binding: root, column }),
            }),
          }),
        ),
      ),
      ordering: limited ? plan.ordering : EMPTY,
    });
    const source = createQuery(
      initialPlan(freeze({ ...binding, derived: rows })),
      false,
      true,
    ) as unknown as Shaped;

    return source(shape)[QUERY_STATE].plan;
  };

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
          return compilePlan(runnable(this[QUERY_STATE]));
        },
        prepare(this: QueryHandle) {
          return preparePlan(runnable(this[QUERY_STATE]), executor);
        },
        [PREPARE_QUERY](
          this: QueryHandle,
          scope: object,
          names: readonly string[],
        ) {
          return preparePlan(
            runnable(this[QUERY_STATE]),
            executor,
            scope,
            names,
          );
        },
        async execute(this: QueryHandle) {
          return (await executePlan(runnable(this[QUERY_STATE]), executor))
            .rows;
        },
        [Symbol.toStringTag]: QUERY_TAG,
        then(
          this: QueryHandle,
          onFulfilled?: ((rows: Record<string, unknown>[]) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) {
          return executePlan(runnable(this[QUERY_STATE]), executor).then(
            onFulfilled ? (result) => onFulfilled(result.rows) : resultRows,
            onRejected,
          );
        },
        catch(
          this: QueryHandle,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) {
          return executePlan(runnable(this[QUERY_STATE]), executor).then(
            resultRows,
            onRejected,
          );
        },
        finally(this: QueryHandle, onFinally?: (() => void) | null) {
          return executePlan(runnable(this[QUERY_STATE]), executor)
            .then(resultRows)
            .finally(onFinally);
        },
        async inspect(this: QueryHandle, options?: InspectQueryOptions) {
          return (await import("../../observability/inspection")).inspectQuery(
            runnable(this[QUERY_STATE]),
            executor,
            options,
          );
        },
        // Reads start when they are awaited, as the query itself does; see
        // deferredRead. execute() and inspect() start when called.
        one(this: QueryHandle) {
          const plan = runnable(this[QUERY_STATE]);

          return deferredRead(() => single(plan, true), executor);
        },
        maybeOne(this: QueryHandle) {
          const plan = runnable(this[QUERY_STATE]);

          return deferredRead(() => single(plan, false), executor);
        },
        page(
          this: QueryHandle,
          options: {
            size: number;
            after?: string | null | undefined;
            before?: string | null | undefined;
          },
        ) {
          const plan = runnable(this[QUERY_STATE]);

          return deferredRead(
            () => executePage(plan, options, executor),
            executor,
          );
        },
        pages(
          this: QueryHandle,
          options: { size: number; after?: string | null | undefined },
        ) {
          const state = runnable(this[QUERY_STATE]);

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
          const plan = runnable(this[QUERY_STATE]);
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
            [Symbol.asyncIterator]: () => {
              // Called where the loop starts, so a query in the loop body
              // sees the connection this stream holds.
              const claim = (hold as { owner?: Driver }).owner?.[
                CONNECTION_CLAIM
              ]?.();
              const link: StreamLink = {};
              const iterator = streamRows(hold, plan, size, claim, link);

              dropped.register(iterator, link, link);

              return iterator;
            },
          };
        },
        /** The shape's single row: aggregates over the source, as one object. */
        aggregate(this: QueryHandle, shape: ShapeCallback) {
          let plan: SelectPlan;

          // Built now, as a query is; a callback that throws rejects.
          try {
            plan = aggregatePlan(this, shape);
          } catch (error) {
            return deferredRead(() => Promise.reject(error), executor);
          }

          return deferredRead(() => single(plan, true), executor);
        },
        first(this: QueryHandle) {
          const state = this[QUERY_STATE];

          return deferredRead(async () => {
            const plan = runnable(state);

            if (typeof plan.limit === "object") {
              throw new Error(
                "symmetria: bind a parameterized LIMIT with prepare()",
              );
            }

            return (
              (await executePlan(limitedPlan(plan, 1), executor)).rows[0] ??
              null
            );
          }, executor);
        },
        count(this: QueryHandle) {
          const { plan } = this[QUERY_STATE];

          return deferredRead(
            async () =>
              readCount((await executePlan(countPlan(plan), executor)).rows),
            executor,
          );
        },
        exists(this: QueryHandle) {
          const { plan } = this[QUERY_STATE];

          return deferredRead(
            async () =>
              readExists(
                (await executePlan(existsPlan(plan, false), executor)).rows,
              ),
            executor,
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
