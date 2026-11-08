/**
 * Terminal plans shared by query handles and prepared queries: `count()` and
 * `exists()` over any SELECT plan, selected or not. Derived plans are cached per
 * source plan so compiled SQL and row decoders stay cached too.
 */
import { freeze } from "../plan/freeze";
import { count, readColumn } from "../expressions";
import { derivedBinding } from "../plan/derived";
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

/** The selection a wrapped plan keeps so its row count matches the user's query. */
const innerSelection = (plan: SelectPlan): SelectPlan["selection"] => {
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
    plan.distinct;

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

  if (parameterized && !allowPlaceholderLimit) {
    throw new Error("symmetria: bind a parameterized LIMIT with prepare()");
  }

  let variants = existsPlans.get(plan);

  if (!variants) {
    variants = [];
    existsPlans.set(plan, variants);
  }

  return (variants[allowPlaceholderLimit ? 1 : 0] ??= freeze(
    parameterized
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
  Object.assign(
    new Error(
      `symmetria: expected ${required ? "exactly one" : "at most one"} row from "${plan.root.table.name}", received ${received}`,
    ),
    {
      code:
        received === 0
          ? "SYMMETRIA_RECORD_NOT_FOUND"
          : "SYMMETRIA_TOO_MANY_ROWS",
      table: plan.root.table.name,
    },
  );

export const readCount = (rows: readonly Record<string, unknown>[]): number =>
  rows[0]!.count as number;

export const readExists = (rows: readonly Record<string, unknown>[]): boolean =>
  rows.length > 0;
