import type {
  ExpressionDescription,
  PredicateDescription,
  ValueNode,
} from "./expressions";
import type { OrderingDescription, SelectPlan, TableBinding } from "./state";

const remap = <Value>(
  values: readonly Value[],
  visit: (value: Value) => Value,
): readonly Value[] =>
  values.length ? Object.freeze(values.map(visit)) : values;

/** Give a reusable query new local sources, retaining its correlated ancestors. */
export const queryOccurrence = (source: SelectPlan): SelectPlan => {
  const replacements = new Map<TableBinding, TableBinding>(
    [source.root, ...source.joins.map((join) => join.binding)].map(
      (binding) => [binding, Object.freeze({ ...binding })],
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

    const rebound = Object.freeze({
      ...original,
      derived: query(original.derived),
      ...(original.projection
        ? {
            projection: Object.freeze(
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

    return node === original.node
      ? original
      : Object.freeze({ ...original, node });
  };

  const ordering = (original: OrderingDescription): OrderingDescription =>
    Object.freeze({ ...original, expression: expression(original.expression) });

  const value = (original: ValueNode): ValueNode => {
    switch (original.kind) {
      case "column": {
        const rebound = binding(original.description.binding);

        if (rebound === original.description.binding) {
          return original;
        }

        return Object.freeze({
          ...original,
          description: Object.freeze({
            ...original.description,
            binding: rebound,
          }),
        });
      }
      case "parameter":
      case "placeholder":
        return original;
      case "raw":
        return Object.freeze({
          ...original,
          parts: Object.freeze(
            original.parts.map((part) =>
              typeof part === "string" ? part : value(part),
            ),
          ),
        });
      case "binary":
        return Object.freeze({
          ...original,
          left: value(original.left),
          right: value(original.right),
        });
      case "aggregate":
        return original.value
          ? Object.freeze({ ...original, value: value(original.value) })
          : original;
      case "case":
        return Object.freeze({
          ...original,
          value: value(original.value),
          branches: Object.freeze(
            original.branches.map((branch) =>
              Object.freeze({
                when: value(branch.when),
                then: value(branch.then),
              }),
            ),
          ),
        });
      case "coalesce":
      case "tuple":
        return Object.freeze({
          ...original,
          values: Object.freeze(original.values.map(value)),
        });
      case "relativeWindow":
        return Object.freeze({
          ...original,
          value: value(original.value),
          offset: value(original.offset),
          ...(original.fallback ? { fallback: value(original.fallback) } : {}),
        });
      case "window":
        return Object.freeze({
          ...original,
          expression: value(original.expression),
          partitionBy: Object.freeze(original.partitionBy.map(value)),
          orderBy: Object.freeze(original.orderBy.map(ordering)),
        });
      case "subquery":
      case "rowCount":
      case "jsonRows":
        return Object.freeze({ ...original, query: query(original.query) });
      case "jsonObject":
        return Object.freeze({
          ...original,
          selection: Object.freeze(original.selection.map(expression)),
        });
      case "jsonPath":
      case "arrayLength":
      case "arrayIndex":
        return Object.freeze({ ...original, value: value(original.value) });
      case "searchRank":
        return Object.freeze({
          ...original,
          value: value(original.value),
          query: value(original.query),
        });
    }
  };

  const predicate = (original: PredicateDescription): PredicateDescription => {
    switch (original.kind) {
      case "comparison":
        return Object.freeze({
          ...original,
          left: value(original.left),
          right: value(original.right),
        });
      case "search":
        return Object.freeze({
          ...original,
          value: value(original.value),
          query: value(original.query),
        });
      case "has":
        return Object.freeze({
          ...original,
          value: value(original.value),
          element: value(original.element),
        });
      case "nullCheck":
        return Object.freeze({ ...original, value: value(original.value) });
      case "group":
        return Object.freeze({
          ...original,
          predicates: Object.freeze(original.predicates.map(predicate)),
        });
      case "not":
      case "notTrue":
        return Object.freeze({
          ...original,
          predicate: predicate(original.predicate),
        });
      case "membership":
        return Object.freeze({
          ...original,
          value: value(original.value),
          values: Array.isArray(original.values)
            ? Object.freeze(original.values.map(value))
            : query(original.values as SelectPlan),
        });
      case "between":
        return Object.freeze({
          ...original,
          value: value(original.value),
          lower: value(original.lower),
          upper: value(original.upper),
        });
      case "exists":
        return Object.freeze({ ...original, query: query(original.query) });
    }
  };

  const query = (original: SelectPlan): SelectPlan =>
    Object.freeze({
      ...original,
      root: binding(original.root),
      bindings: Object.freeze(
        Object.fromEntries(
          Object.entries(original.bindings).map(([name, original]) => [
            name,
            binding(original),
          ]),
        ),
      ),
      joins: remap(original.joins, (join) =>
        Object.freeze({
          ...join,
          binding: binding(join.binding),
          ...(join.condition ? { condition: predicate(join.condition) } : {}),
          ...(join.relation
            ? {
                relation: Object.freeze({
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
