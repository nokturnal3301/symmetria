/**
 * Terminal plans shared by query handles and prepared queries: `count()` and
 * `exists()` over any SELECT plan, selected or not. Derived plans are cached per
 * source plan so compiled SQL and row decoders stay cached too.
 */
import { NotFoundError, TooManyRowsError } from "../../errors";
import { freeze } from "../plan/freeze";
import { count, readColumn } from "../expressions";
import { derivedBinding } from "../plan/derived";
import { containsNode } from "../plan/traverse";
import type { SelectPlan } from "../plan/types";
import {
  EMPTY,
  createScope,
  initialPlan,
  presentSelection,
  readSelection,
} from "./scope";

const countPlans = new WeakMap<SelectPlan, SelectPlan>();
const existsPlans = new WeakMap<SelectPlan, (SelectPlan | undefined)[]>();

const withoutLocking = (plan: SelectPlan): SelectPlan => {
  const { locking: _locking, ...rest } = plan;

  return rest;
};

/**
 * A projection of aggregates without GROUP BY (`{ n: count() }`): the query
 * returns one row whatever the source holds, so that is what counts.
 */
const aggregatesAll = (plan: SelectPlan): boolean =>
  !plan.grouping.length &&
  plan.selection.some(
    (expression) =>
      containsNode(expression.node, (node) => node.kind === "aggregate") &&
      !containsNode(
        expression.node,
        (node) => node.kind === "window" || node.kind === "relativeWindow",
      ),
  );

/** The selection a wrapped plan keeps so its row count matches the user's query. */
const innerSelection = (plan: SelectPlan): SelectPlan["selection"] => {
  if (aggregatesAll(plan)) {
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

/** A plan whose single row carries `count`, decoded as a number. */
export const countPlan = (plan: SelectPlan): SelectPlan => {
  let derived = countPlans.get(plan);

  if (derived) {
    return derived;
  }

  const counted =
    plan.limit !== undefined ||
    plan.offset !== undefined ||
    plan.grouping.length > 0 ||
    plan.having.length > 0 ||
    plan.distinct ||
    aggregatesAll(plan);

  derived = counted
    ? freeze({
        ...initialPlan(
          derivedBinding(
            freeze({ ...plan, selection: innerSelection(plan) }),
            "__symmetria_count",
          ),
        ),
        selection: freeze([readColumn(count())]),
      })
    : freeze({
        ...withoutLocking(plan),
        selection: freeze([readColumn(count())]),
        ordering: EMPTY,
      });
  countPlans.set(plan, derived);

  return derived;
};

/**
 * A plan returning at most one `present` row. A parameterized LIMIT is refused
 * unless `allowPlaceholderLimit` (prepared queries), which wraps the plan instead.
 */
export const existsPlan = (
  plan: SelectPlan,
  allowPlaceholderLimit: boolean,
): SelectPlan => {
  const parameterized =
    typeof plan.limit === "object" || typeof plan.offset === "object";
  // Its one row exists whatever the source holds; it is read as it is.
  const wrapped = parameterized || aggregatesAll(plan);

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
                ...withoutLocking(plan),
                selection: innerSelection(plan),
              }),
              "__symmetria_exists",
            ),
          ),
          selection: presentSelection,
          limit: 1,
        }
      : {
          ...withoutLocking(plan),
          selection: innerSelection(plan),
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

export const readCount = (rows: readonly Record<string, unknown>[]): number =>
  rows[0]!.count as number;

export const readExists = (rows: readonly Record<string, unknown>[]): boolean =>
  rows.length > 0;
