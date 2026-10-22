import type { PredicateDescription, ValueNode } from "./expressions";
import type { SelectPlan } from "./state";
import { sameExpression } from "./equivalence";

type AggregateQuery = Extract<ValueNode, { kind: "subquery" }>;
type SharedAggregate = {
  node: AggregateQuery;
  references: ValueNode[];
  filtered: boolean;
};

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

export const sharedAggregates = (query: SelectPlan): SharedAggregate[] => {
  if (
    !query.predicates.length ||
    query.joins.length ||
    query.grouping.length ||
    query.having.length ||
    query.distinct ||
    query.locking ||
    query.predicates.every(
      (predicate) =>
        predicate.kind === "comparison" &&
        atomicValue(predicate.left) &&
        atomicValue(predicate.right),
    )
  ) {
    return [];
  }

  const groups: SharedAggregate[] = [];

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

        const matching = groups.find((group) => {
          const first = group.node.query;
          const second = node.query;
          const bindings = new Map([[first.root, second.root]]);

          return (
            first.root.table === second.root.table &&
            sameExpression(
              first.selection[0]!.node,
              second.selection[0]!.node,
              bindings,
            ) &&
            sameExpression(first.predicates, second.predicates, bindings)
          );
        });

        if (matching) {
          matching.references.push(node);
          matching.filtered ||= filtered;
        } else {
          groups.push({ node, references: [node], filtered });
        }

        return;
      }

      // Keep subquery scopes independent and never traverse table/codec metadata.
      if (
        [
          "column",
          "parameter",
          "placeholder",
          "rowCount",
          "jsonRows",
          "exists",
          "raw",
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

  if (!groups.length) {
    return [];
  }

  visit(query.selection, false);
  visit(query.ordering, false);

  return groups.filter(
    (group) => group.filtered && group.references.length > 1,
  );
};

/** Direct child value nodes; nested plans of subqueries are not entered. */
const childNodes = (node: ValueNode): readonly ValueNode[] => {
  switch (node.kind) {
    case "binary":
      return [node.left, node.right];
    case "coalesce":
    case "tuple":
      return node.values;
    case "case":
      return [
        node.value,
        ...node.branches.flatMap((branch) => [branch.when, branch.then]),
      ];
    case "raw":
      return node.parts.filter(
        (part): part is ValueNode => typeof part !== "string",
      );
    case "jsonObject":
      return node.selection.map((expression) => expression.node);
    case "jsonPath":
    case "arrayIndex":
    case "arrayLength":
      return [node.value];
    case "searchRank":
      return [node.value, node.query];
    case "relativeWindow":
      return node.fallback
        ? [node.value, node.offset, node.fallback]
        : [node.value, node.offset];
    case "window":
      return [
        node.expression,
        ...node.partitionBy,
        ...node.orderBy.map((ordering) => ordering.expression.node),
      ];
    case "aggregate":
      return node.value ? [node.value] : [];
    default:
      return [];
  }
};

const containsNode = (
  node: ValueNode,
  matches: (node: ValueNode) => boolean,
): boolean =>
  matches(node) ||
  childNodes(node).some((child) => containsNode(child, matches));

/** Subqueries evaluated once per outer row: nested collections, aggregates, EXISTS. */
export const containsCorrelatedSubquery = (node: ValueNode): boolean =>
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
