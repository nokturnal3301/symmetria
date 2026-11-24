/**
 * Child traversal shared by the plan walks that only read a tree: scope
 * validation, CTE collection, pagination and aggregate analysis.
 */
import type { PredicateDescription, ValueNode } from "../expressions";

/** Ends a switch that names every kind: a kind added later fails to compile there. */
export const unhandledKind = (node: never): never => {
  throw new Error(
    `symmetria: unhandled node kind "${(node as { kind: string }).kind}"`,
  );
};

/** Direct child value nodes, in the order they render; nested plans of subqueries are not entered. */
export const childNodes = (node: ValueNode): readonly ValueNode[] => {
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
    case "searchHeadline":
      return [node.value, node.query];
    case "tsvector":
      return node.parts.map((part) => part.value);
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
    case "condition":
      return predicateNodes(node.predicate);
    case "column":
    case "parameter":
    case "placeholder":
      return [];
    // A nested plan is a scope of its own: a walk that follows it says so.
    case "subquery":
    case "rowCount":
    case "jsonRows":
      return [];
    default:
      return unhandledKind(node);
  }
};

/** The value nodes a condition reads; nested plans are not entered. */
export const predicateNodes = (
  predicate: PredicateDescription,
): readonly ValueNode[] => {
  switch (predicate.kind) {
    case "comparison":
      return [predicate.left, predicate.right];
    case "search":
      return [predicate.value, predicate.query];
    case "has":
      return [predicate.value, predicate.element];
    case "nullCheck":
      return [predicate.value];
    case "between":
      return [predicate.value, predicate.lower, predicate.upper];
    case "membership":
      return Array.isArray(predicate.values)
        ? [predicate.value, ...predicate.values]
        : [predicate.value];
    case "group":
      return predicate.predicates.flatMap(predicateNodes);
    case "not":
    case "notTrue":
    case "scope":
      return predicateNodes(predicate.predicate);
    case "exists":
      return [];
  }
};

/** Whether the node or anything below it matches; nested plans are not entered. */
export const containsNode = (
  node: ValueNode,
  matches: (node: ValueNode) => boolean,
): boolean =>
  matches(node) ||
  childNodes(node).some((child) => containsNode(child, matches));
