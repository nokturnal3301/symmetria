/**
 * Terminal plans shared by query handles and prepared queries: `count()` and
 * `exists()` over any SELECT plan, selected or not. Derived plans are cached per
 * source plan so compiled SQL and row decoders stay cached too.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { currentFrame, currentHolders, runHolding } from "../../driver/serial";
import { NotFoundError, TooManyRowsError } from "../../errors";
import { freeze } from "../plan/freeze";
import {
  count,
  readColumn,
  type PredicateDescription,
  type ValueNode,
} from "../expressions";
import { derivedBinding } from "../plan/derived";
import { batchCollectors } from "../plan/batching";
import { containsNode } from "../plan/traverse";
import type { QueryExecutor, SelectPlan } from "../plan/types";
import {
  EMPTY,
  createScope,
  initialPlan,
  presentSelection,
  readSelection,
} from "./scope";

const countPlans = new WeakMap<SelectPlan, SelectPlan>();
const existsPlans = new WeakMap<SelectPlan, (SelectPlan | undefined)[]>();

/**
 * Aggregates can collapse rows, and raw SQL can also expand or eliminate
 * them (unnest, including a user-defined set-returning function). Keep the
 * actual projection rather than guessing its cardinality from SQL text.
 */
const needsProjection = (plan: SelectPlan): boolean => {
  const mayChangeRows = (node: ValueNode) =>
    (node.kind === "aggregate" && !plan.grouping.length) ||
    (node.kind === "raw" && !node.composed);
  return (
    plan.selection.some(({ node }) => containsNode(node, mayChangeRows)) ||
    plan.ordering.some(({ expression }) =>
      containsNode(expression.node, mayChangeRows),
    )
  );
};

/** The selection a wrapped plan keeps so its row count matches the user's query. */
const innerSelection = (
  plan: SelectPlan,
  keepProjection: boolean,
): SelectPlan["selection"] => {
  if (keepProjection && plan.selection.length) {
    return plan.selection;
  }

  if (!plan.distinct) {
    return presentSelection;
  }

  if (plan.selection.length) {
    return plan.selection;
  }

  // DISTINCT over nothing: distinct root rows.
  return plan.grouping.length
    ? plan.grouping
    : readSelection(
        createScope({ [plan.root.alias]: plan.root })[plan.root.alias]!,
        plan.bindings,
      );
};

/**
 * A plan whose single row carries `count`, decoded as a number. A source with
 * `forUpdate`/`forShare` locks the rows it counts: they stay a derived table
 * with the lock (`SELECT count(*) FROM (SELECT 1 … FOR UPDATE)`), so with
 * `skipLocked` the count is of the rows it could lock; its ordering stays,
 * as the order the rows are locked in.
 */
export const countPlan = (plan: SelectPlan): SelectPlan => {
  let derived = countPlans.get(plan);

  if (derived) {
    return derived;
  }

  const keepProjection = needsProjection(plan);
  const counted =
    plan.locking !== undefined ||
    plan.limit !== undefined ||
    plan.offset !== undefined ||
    plan.grouping.length > 0 ||
    plan.having.length > 0 ||
    plan.distinct ||
    keepProjection;

  derived = counted
    ? freeze({
        ...initialPlan(
          derivedBinding(
            freeze({
              ...plan,
              selection: innerSelection(plan, keepProjection),
            }),
            "__symmetria_count",
          ),
        ),
        selection: freeze([readColumn(count())]),
      })
    : freeze({
        ...plan,
        selection: freeze([readColumn(count())]),
        ordering: EMPTY,
      });
  countPlans.set(plan, derived);

  return derived;
};

/** `count(*) > 0`: as HAVING without GROUP BY, one row when there are rows. */
const anyRows = (): readonly PredicateDescription[] =>
  freeze([
    freeze({
      kind: "comparison" as const,
      left: readColumn(count()).node,
      operator: ">" as const,
      right: freeze({ kind: "raw" as const, parts: freeze(["0"]) }),
    }),
  ]);

/**
 * A plan returning at most one `present` row. A parameterized LIMIT is refused
 * unless `allowPlaceholderLimit` (prepared queries), which wraps the plan instead.
 * A source with `forUpdate`/`forShare` locks every row it selects, as reading
 * or counting it does: LIMIT 1 over it would lock only the first, so its rows
 * are counted instead.
 */
export const existsPlan = (
  plan: SelectPlan,
  allowPlaceholderLimit: boolean,
): SelectPlan => {
  const parameterized =
    typeof plan.limit === "object" || typeof plan.offset === "object";
  const locking = plan.locking !== undefined;
  // Wrapped in a derived table: a parameterized LIMIT or OFFSET, a row lock,
  // or a projection whose cardinality is decided by PostgreSQL.
  const keepProjection = needsProjection(plan);
  const wrapped = parameterized || keepProjection || locking;

  if (parameterized && !allowPlaceholderLimit) {
    throw new Error("symmetria: bind a parameterized LIMIT with prepare()");
  }

  let variants = existsPlans.get(plan);

  if (!variants) {
    variants = [];
    existsPlans.set(plan, variants);
  }

  return (variants[allowPlaceholderLimit ? 1 : 0] ??= freeze(
    wrapped
      ? {
          ...initialPlan(
            derivedBinding(
              freeze({
                ...plan,
                selection: innerSelection(plan, keepProjection),
              }),
              "__symmetria_exists",
            ),
          ),
          selection: presentSelection,
          ...(locking ? { having: anyRows() } : { limit: 1 }),
        }
      : {
          ...plan,
          selection: innerSelection(plan, keepProjection),
          ordering: EMPTY,
          limit: typeof plan.limit === "number" ? Math.min(plan.limit, 1) : 1,
        },
  ));
};

/**
 * The error of one() and maybeOne() when the row count is wrong; it names the
 * source and carries a code to branch on.
 */
export const rowCountError = (
  plan: SelectPlan,
  received: number,
  required: boolean,
): Error =>
  new (received === 0 ? NotFoundError : TooManyRowsError)(
    `symmetria: expected ${required ? "exactly one" : "at most one"} row from "${plan.root.table.name}", received ${received}`,
    plan.root.table.name,
  );

/**
 * A read that starts when it is awaited, as queries and writes do: the first
 * `then()` (also through `catch()`, `finally()`, `await`, `Promise.all()`)
 * runs it, and later calls share its result. Reads in an array therefore
 * start in the array's order, so in a transaction, whose statements run in
 * the order they start, `Promise.all([insert, count()])` counts the inserted
 * row. It is a real `Promise`, so test runners and `instanceof` treat it as
 * one; nothing reads its result without calling `then()`.
 *
 * It runs in the async context where it was made, not where it is awaited:
 * `$scope()` callbacks, a profiler's request and a tracer's span see that
 * context. What the code that starts it holds (the
 * savepoint it runs in, pool connections) comes from where it starts, so a
 * read awaited where it would wait for itself is refused, never left waiting.
 * A read made while a `$batch()` collects starts at once and joins it.
 */
class DeferredRead<Value> extends Promise<Value> {
  // Promises derived from it (then, catch, finally) are plain ones.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  #start: (() => PromiseLike<Value>) | undefined;
  #context: ((run: () => void) => void) | undefined;
  #frame: ReturnType<typeof currentFrame>;
  #held: ReturnType<typeof currentHolders>;
  readonly #resolve: (value: Value | PromiseLike<Value>) => void;
  readonly #reject: (reason: unknown) => void;

  constructor(start: () => PromiseLike<Value>, executor?: QueryExecutor) {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason: unknown) => void;

    super((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    this.#resolve = resolve;
    this.#reject = reject;

    if (executor && batchCollectors.has(executor)) {
      this.#begin(start);
    } else {
      this.#start = start;
      this.#context = AsyncLocalStorage.snapshot();
      this.#frame = currentFrame();
      this.#held = currentHolders();
    }
  }

  #begin(start: () => PromiseLike<Value>): void {
    try {
      const started = start();

      // A read built on another deferred read starts that one here and now
      // (resolving with it would wait a tick), in this read's context.
      if (started instanceof DeferredRead || !(started instanceof Promise)) {
        started.then(this.#resolve, this.#reject);
      } else {
        this.#resolve(started);
      }
    } catch (error) {
      this.#reject(error);
    }
  }

  override then<Fulfilled = Value, Rejected = never>(
    onFulfilled?: ((value: Value) => Fulfilled | PromiseLike<Fulfilled>) | null,
    onRejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ): Promise<Fulfilled | Rejected> {
    const start = this.#start;

    if (start) {
      const frame = currentFrame();
      const held = currentHolders();
      const context = this.#context!;

      this.#start = undefined;
      this.#context = undefined;
      context(() => {
        if (frame === this.#frame && held === this.#held) {
          this.#begin(start);
        } else {
          runHolding(frame, held, () => this.#begin(start));
        }
      });
    }

    return super.then(onFulfilled, onRejected);
  }
}

export const deferredRead = <Value>(
  start: () => PromiseLike<Value>,
  executor?: QueryExecutor,
): Promise<Value> => new DeferredRead(start, executor);

export const readCount = (rows: readonly Record<string, unknown>[]): number =>
  rows[0]!.count as number;

export const readExists = (rows: readonly Record<string, unknown>[]): boolean =>
  rows.length > 0;
