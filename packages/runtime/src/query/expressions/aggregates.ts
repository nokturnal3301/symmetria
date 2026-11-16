/**
 * Plan analysis for aggregates: shared aggregate detection, correlated-subquery checks and root-first pagination.
 */
import type { ExpressionDescription, PredicateDescription, ValueNode } from ".";
import { freeze } from "../plan/freeze";
import { reboundExpression } from "../plan/occurrence";
import type { SelectPlan } from "../plan/types";
import { sameExpression } from "../plan/equivalence";
import { containsNode } from "../plan/traverse";

type AggregateQuery = Extract<ValueNode, { kind: "subquery" }>;

/**
 * Aggregates over one relation with one filter: `orders.count()` and
 * `orders.sum.total` read the same rows, so one subquery computes both.
 */
export type SharedAggregate = {
  /** The subquery with every distinct aggregate of the group selected. */
  readonly query: SelectPlan;
  /** Each replaced node and the column of `query` it reads. */
  readonly references: ReadonlyMap<ValueNode, string>;
};

export type SharedAggregates = {
  /** Joined before WHERE: a filter reads them, or no LIMIT trims the rows. */
  readonly inner: readonly SharedAggregate[];
  /** Joined to the page a root-first pagination has already cut. */
  readonly outer: readonly SharedAggregate[];
};

type AggregateGroup = {
  first: AggregateQuery;
  columns: { expression: ExpressionDescription; name: string }[];
  references: Map<ValueNode, string>;
  filtered: boolean;
};

const NONE: SharedAggregates = Object.freeze({ inner: [], outer: [] });

const atomicValue = (node: ValueNode): boolean =>
  node.kind === "column" ||
  node.kind === "parameter" ||
  node.kind === "placeholder";

/** Only deterministic, single-row aggregates can be shared across query clauses. */
const shareable = (node: AggregateQuery): boolean => {
  const query = node.query;

  if (
    query.root.derived ||
    query.root.cte ||
    query.root.cteReference ||
    query.joins.length ||
    query.grouping.length ||
    query.having.length ||
    query.ordering.length ||
    query.limit !== undefined ||
    query.offset !== undefined ||
    query.locking ||
    query.distinct ||
    query.selection.length !== 1 ||
    query.selection[0]!.node.kind !== "aggregate"
  ) {
    return false;
  }

  const deterministic = (value: unknown): boolean => {
    if (!value || typeof value !== "object") {
      return true;
    }

    if (
      "kind" in value &&
      ["column", "parameter", "placeholder"].includes(String(value.kind))
    ) {
      return true;
    }

    if ("kind" in value && value.kind === "jsonPath") {
      return deterministic(
        (value as Extract<ValueNode, { kind: "jsonPath" }>).value,
      );
    }

    if ("kind" in value && value.kind === "scope") {
      return deterministic(
        (value as Extract<PredicateDescription, { kind: "scope" }>).predicate,
      );
    }

    if (
      "kind" in value &&
      [
        "raw",
        "window",
        "relativeWindow",
        "subquery",
        "rowCount",
        "jsonRows",
        "exists",
      ].includes(String(value.kind))
    ) {
      return false;
    }

    return Object.values(value).every(deterministic);
  };

  return (
    deterministic(query.selection[0]!.node) && deterministic(query.predicates)
  );
};

const subquery = (node: ValueNode): boolean => node.kind === "subquery";

export const sharedAggregates = (query: SelectPlan): SharedAggregates => {
  if (
    query.rootless ||
    query.joins.length ||
    query.grouping.length ||
    query.having.length ||
    query.distinct ||
    query.locking
  ) {
    return NONE;
  }

  // Most queries stop here: sharing needs two aggregates, or one that a filter repeats.
  const filters = !query.predicates.every(
    (predicate) =>
      predicate.kind === "scope" ||
      (predicate.kind === "comparison" &&
        atomicValue(predicate.left) &&
        atomicValue(predicate.right)),
  );

  if (
    !filters &&
    query.selection.reduce(
      (count, expression) =>
        count + (containsNode(expression.node, subquery) ? 1 : 0),
      0,
    ) +
      (query.ordering.some((ordering) =>
        containsNode(ordering.expression.node, subquery),
      )
        ? 1
        : 0) <
      2
  ) {
    return NONE;
  }

  const groups: AggregateGroup[] = [];

  const visit = (value: unknown, filtered: boolean): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, filtered);
      }

      return;
    }

    if ("kind" in value) {
      const node = value as ValueNode | PredicateDescription;

      if (node.kind === "comparison" || node.kind === "binary") {
        visit(node.left, filtered);
        visit(node.right, filtered);

        return;
      }

      if (node.kind === "jsonPath") {
        visit(node.value, filtered);

        return;
      }

      if (node.kind === "subquery") {
        if (!shareable(node)) {
          return;
        }

        let group = groups.find(({ first }) => {
          const one = first.query;
          const other = node.query;

          return (
            one.root.table === other.root.table &&
            sameExpression(
              one.predicates,
              other.predicates,
              new Map([[one.root, other.root]]),
            )
          );
        });

        if (!group) {
          group = { first: node, columns: [], references: new Map(), filtered };
          groups.push(group);
        }

        // Read from the group's own source, so equal aggregates compare equal.
        const expression =
          group.first === node
            ? node.query.selection[0]!
            : reboundExpression(
                node.query.selection[0]!,
                new Map([[node.query.root, group.first.query.root]]),
              );
        let column = group.columns.find((existing) =>
          sameExpression(existing.expression.node, expression.node),
        );

        if (!column) {
          const taken = group.columns.some(
            (existing) => existing.name === expression.outputName,
          );

          column = {
            expression,
            name: taken
              ? `${expression.outputName}_${group.columns.length}`
              : expression.outputName,
          };
          group.columns.push(column);
        }

        group.references.set(node, column.name);
        group.filtered ||= filtered;

        return;
      }

      // $scope() filters are re-rendered per execution, so nothing inside
      // them may be shared with another clause.
      if (
        [
          "column",
          "parameter",
          "placeholder",
          "rowCount",
          "jsonRows",
          "exists",
          "raw",
          "scope",
        ].includes(node.kind)
      ) {
        return;
      }

      if (node.kind === "membership") {
        visit(node.value, filtered);

        if (Array.isArray(node.values)) {
          visit(node.values, filtered);
        }

        return;
      }
    }

    for (const [field, child] of Object.entries(value)) {
      if (field !== "codec") {
        visit(child, filtered);
      }
    }
  };

  visit(query.predicates, true);
  visit(query.selection, false);
  visit(query.ordering, false);

  const repeated = groups.filter((group) => group.references.size > 1);

  if (!repeated.length) {
    return NONE;
  }

  const shared = (group: AggregateGroup): SharedAggregate => ({
    query: freeze({
      ...group.first.query,
      selection: freeze(
        group.columns.map(({ expression, name }) =>
          freeze({ ...expression, outputName: name }),
        ),
      ),
    }),
    references: group.references,
  });

  // Without LIMIT every row is returned, so each of its aggregates runs anyway.
  if (query.limit === undefined && query.offset === undefined) {
    return { inner: repeated.map(shared), outer: [] };
  }

  const filtered = repeated.filter((group) => group.filtered);

  // A filter needs its aggregate before LIMIT, for every candidate row.
  if (filtered.length) {
    return { inner: filtered.map(shared), outer: [] };
  }

  // Otherwise only the rows of the page may pay for a subquery.
  return paginatesRootFirst(query)
    ? { inner: [], outer: repeated.map(shared) }
    : NONE;
};

/** Subqueries evaluated once per outer row: nested collections, aggregates, EXISTS. */
const containsCorrelatedSubquery = (node: ValueNode): boolean =>
  containsNode(
    node,
    (candidate) =>
      candidate.kind === "subquery" ||
      candidate.kind === "rowCount" ||
      candidate.kind === "jsonRows",
  );

/** Raw SQL may hide windows, aggregates or volatile ordering; keep its scope intact. */
const blocksRootPagination = (node: ValueNode): boolean =>
  containsNode(
    node,
    (candidate) =>
      candidate.kind === "window" ||
      candidate.kind === "relativeWindow" ||
      candidate.kind === "aggregate" ||
      candidate.kind === "raw",
  );

/**
 * A paginated SELECT whose projection runs correlated subqueries can restrict
 * its root rows first, so PostgreSQL evaluates those subqueries only for the
 * rows that survive LIMIT/OFFSET instead of for every scanned row.
 */
export const paginatesRootFirst = (query: SelectPlan): boolean =>
  (query.limit !== undefined || query.offset !== undefined) &&
  !query.distinct &&
  !query.grouping.length &&
  !query.having.length &&
  !query.locking &&
  !query.joins.length &&
  query.selection.some((expression) =>
    containsCorrelatedSubquery(expression.node),
  ) &&
  !query.selection.some((expression) =>
    blocksRootPagination(expression.node),
  ) &&
  !query.ordering.some(
    (ordering) =>
      blocksRootPagination(ordering.expression.node) ||
      containsCorrelatedSubquery(ordering.expression.node),
  );
