import { freeze } from "./freeze";
import type {
  ExpressionDescription,
  PredicateDescription,
  ValueNode,
} from "../expressions";
import type { OrderingDescription, SelectPlan, TableBinding } from "./types";

const remap = <Value>(
  values: readonly Value[],
  visit: (value: Value) => Value,
): readonly Value[] => (values.length ? freeze(values.map(visit)) : values);

/** Give a reusable query new local sources, retaining its correlated ancestors. */
export const queryOccurrence = (source: SelectPlan): SelectPlan => {
  const replacements = new Map<TableBinding, TableBinding>(
    [source.root, ...source.joins.map((join) => join.binding)].map(
      (binding) => [binding, freeze({ ...binding })],
    ),
  );

  const derivedBindings = new Map<TableBinding, TableBinding>();

  const binding = (original: TableBinding): TableBinding => {
    if (!original.derived) {
      return replacements.get(original) ?? original;
    }

    const existing = derivedBindings.get(original);

    if (existing) {
      return existing;
    }

    const rebound = freeze({
      ...original,
      derived: query(original.derived),
      ...(original.projection
        ? {
            projection: freeze(
              Object.fromEntries(
                Object.entries(original.projection).map(([name, selected]) => [
                  name,
                  expression(selected),
                ]),
              ),
            ),
          }
        : {}),
    });
    derivedBindings.set(original, rebound);

    return rebound;
  };

  const expression = (
    original: ExpressionDescription,
  ): ExpressionDescription => {
    const node = value(original.node);

    return node === original.node ? original : freeze({ ...original, node });
  };

  const ordering = (original: OrderingDescription): OrderingDescription =>
    freeze({ ...original, expression: expression(original.expression) });

  const value = (original: ValueNode): ValueNode => {
    switch (original.kind) {
      case "column": {
        const rebound = binding(original.description.binding);

        if (rebound === original.description.binding) {
          return original;
        }

        return freeze({
          ...original,
          description: freeze({
            ...original.description,
            binding: rebound,
          }),
        });
      }
      case "parameter":
      case "placeholder":
        return original;
      case "raw":
        return freeze({
          ...original,
          parts: freeze(
            original.parts.map((part) =>
              typeof part === "string" ? part : value(part),
            ),
          ),
        });
      case "binary":
        return freeze({
          ...original,
          left: value(original.left),
          right: value(original.right),
        });
      case "aggregate":
        return original.value
          ? freeze({ ...original, value: value(original.value) })
          : original;
      case "case":
        return freeze({
          ...original,
          value: value(original.value),
          branches: freeze(
            original.branches.map((branch) =>
              freeze({
                when: value(branch.when),
                then: value(branch.then),
              }),
            ),
          ),
        });
      case "coalesce":
      case "tuple":
        return freeze({
          ...original,
          values: freeze(original.values.map(value)),
        });
      case "relativeWindow":
        return freeze({
          ...original,
          value: value(original.value),
          offset: value(original.offset),
          ...(original.fallback ? { fallback: value(original.fallback) } : {}),
        });
      case "window":
        return freeze({
          ...original,
          expression: value(original.expression),
          partitionBy: freeze(original.partitionBy.map(value)),
          orderBy: freeze(original.orderBy.map(ordering)),
        });
      case "subquery":
      case "rowCount":
      case "jsonRows":
        return freeze({ ...original, query: query(original.query) });
      case "jsonObject":
        return freeze({
          ...original,
          selection: freeze(original.selection.map(expression)),
        });
      case "jsonPath":
      case "arrayLength":
      case "arrayIndex":
        return freeze({ ...original, value: value(original.value) });
      case "searchRank":
      case "searchHeadline":
        return freeze({
          ...original,
          value: value(original.value),
          query: value(original.query),
        });
      case "tsvector":
        return freeze({
          ...original,
          parts: freeze(
            original.parts.map((part) =>
              freeze({ ...part, value: value(part.value) }),
            ),
          ),
        });
    }
  };

  const predicate = (original: PredicateDescription): PredicateDescription => {
    switch (original.kind) {
      case "comparison":
        return freeze({
          ...original,
          left: value(original.left),
          right: value(original.right),
        });
      case "search":
        return freeze({
          ...original,
          value: value(original.value),
          query: value(original.query),
        });
      case "has":
        return freeze({
          ...original,
          value: value(original.value),
          element: value(original.element),
        });
      case "nullCheck":
        return freeze({ ...original, value: value(original.value) });
      case "group":
        return freeze({
          ...original,
          predicates: freeze(original.predicates.map(predicate)),
        });
      case "not":
      case "notTrue":
        return freeze({
          ...original,
          predicate: predicate(original.predicate),
        });
      case "membership":
        return freeze({
          ...original,
          value: value(original.value),
          values: Array.isArray(original.values)
            ? freeze(original.values.map(value))
            : query(original.values as SelectPlan),
        });
      case "between":
        return freeze({
          ...original,
          value: value(original.value),
          lower: value(original.lower),
          upper: value(original.upper),
        });
      case "exists":
        return freeze({ ...original, query: query(original.query) });
      case "scope":
        // The callback runs again against the new occurrence at execution.
        return freeze({
          ...original,
          binding: binding(original.binding),
          predicate: predicate(original.predicate),
        });
    }
  };

  const query = (original: SelectPlan): SelectPlan =>
    freeze({
      ...original,
      root: binding(original.root),
      bindings: freeze(
        Object.fromEntries(
          Object.entries(original.bindings).map(([name, original]) => [
            name,
            binding(original),
          ]),
        ),
      ),
      joins: remap(original.joins, (join) =>
        freeze({
          ...join,
          binding: binding(join.binding),
          ...(join.condition ? { condition: predicate(join.condition) } : {}),
          ...(join.relation
            ? {
                relation: freeze({
                  ...join.relation,
                  from: binding(join.relation.from),
                }),
              }
            : {}),
        }),
      ),
      selection: remap(original.selection, expression),
      predicates: remap(original.predicates, predicate),
      grouping: remap(original.grouping, expression),
      having: remap(original.having, predicate),
      ordering: remap(original.ordering, ordering),
    });

  return query(source);
};
