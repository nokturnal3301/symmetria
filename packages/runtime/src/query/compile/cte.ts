import type { PredicateDescription, ValueNode } from "../expressions";
import {
  DEFAULT_VALUE,
  type MutationPlan,
  type SelectPlan,
  type TableBinding,
} from "../plan/types";
import { quoteIdentifier, type Compilation } from "./state";
import { selectSql } from "./select";

/**
 * Collects common table expressions before rendering, visiting the plan in the
 * order the renderer emits text, so `commonTables` keeps the dependency
 * post-order that WITH requires and every CTE body is rendered exactly once.
 */
export const collectCommonTables = (compilation: Compilation): void => {
  const { plan, commonTables, visiting, references } = compilation;
  // SQL names of the real tables the statement reads or writes.
  const tables = new Set<string>();

  const walkValue = (node: ValueNode): void => {
    switch (node.kind) {
      case "jsonPath":
      case "arrayIndex":
      case "arrayLength":
        walkValue(node.value);

        return;
      case "jsonObject":
        node.selection.forEach((expression) => walkValue(expression.node));

        return;
      case "raw":
        node.parts.forEach((part) => {
          if (typeof part !== "string") {
            walkValue(part);
          }
        });

        return;
      case "binary":
        walkValue(node.left);
        walkValue(node.right);

        return;
      case "aggregate":
        if (node.value) {
          walkValue(node.value);
        }

        return;
      case "case":
        walkValue(node.value);
        node.branches.forEach((branch) => {
          walkValue(branch.when);
          walkValue(branch.then);
        });

        return;
      case "coalesce":
      case "tuple":
        node.values.forEach(walkValue);

        return;
      case "relativeWindow":
        walkValue(node.value);
        walkValue(node.offset);

        if (node.fallback) {
          walkValue(node.fallback);
        }

        return;
      case "window":
        walkValue(node.expression);
        node.partitionBy.forEach(walkValue);
        node.orderBy.forEach((ordering) => walkValue(ordering.expression.node));

        return;
      case "searchRank":
      case "searchHeadline":
        walkValue(node.value);
        walkValue(node.query);

        return;
      case "tsvector":
        node.parts.forEach((part) => walkValue(part.value));

        return;
      case "subquery":
      case "rowCount":
      case "jsonRows":
        walkSelect(node.query);

        return;
      default:
        return;
    }
  };

  const walkPredicate = (description: PredicateDescription): void => {
    switch (description.kind) {
      case "group":
        description.predicates.forEach(walkPredicate);

        return;
      case "not":
      case "notTrue":
        walkPredicate(description.predicate);

        return;
      case "scope":
        walkPredicate(
          compilation.scopeValues?.get(description) ?? description.predicate,
        );

        return;
      case "nullCheck":
        walkValue(description.value);

        return;
      case "comparison":
        walkValue(description.left);
        walkValue(description.right);

        return;
      case "between":
        walkValue(description.value);
        walkValue(description.lower);
        walkValue(description.upper);

        return;
      case "has":
        if (!description.json) {
          walkValue(description.element);
          walkValue(description.value);
        } else {
          walkValue(description.value);
          walkValue(description.element);
        }

        return;
      case "search":
        walkValue(description.value);
        walkValue(description.query);

        return;
      case "exists":
        walkSelect(description.query);

        return;
      case "membership":
        if (Array.isArray(description.values) && !description.values.length) {
          return;
        }

        walkValue(description.value);

        if (Array.isArray(description.values)) {
          description.values.forEach(walkValue);
        } else {
          walkSelect(description.values as SelectPlan);
        }

        return;
    }
  };

  const walkBinding = (binding: TableBinding): void => {
    if (binding.cteReference) {
      references.set(binding.cteReference.identity, binding.cteReference.name);
    } else if (!binding.derived) {
      tables.add(binding.table.sqlName);
    }

    if (binding.cte) {
      const definition = binding.cte;
      const existing = commonTables.get(definition.name);

      if (existing && existing.identity !== definition.identity) {
        throw new Error(`symmetria: duplicate CTE name "${definition.name}"`);
      }

      if (!existing) {
        if (visiting.has(definition.identity)) {
          throw new Error("symmetria: cyclic CTE dependency; use recursive()");
        }

        visiting.add(definition.identity);
        walkSelect(definition.query);

        if (definition.recursive) {
          walkSelect(definition.recursive);
        }

        visiting.delete(definition.identity);
        commonTables.set(definition.name, definition);
      }
    }

    if (binding.derived) {
      walkSelect(binding.derived);
    }
  };

  const walkSelect = (query: SelectPlan): void => {
    if (!query.selection.length) {
      throw new Error(
        "symmetria: select fields in a shape before compiling or executing a query",
      );
    }

    query.selection.forEach((expression) => walkValue(expression.node));
    walkBinding(query.root);

    for (const join of query.joins) {
      walkBinding(join.binding);

      if (join.condition) {
        walkPredicate(join.condition);
      }
    }

    query.predicates.forEach(walkPredicate);
    query.grouping.forEach((expression) => walkValue(expression.node));
    query.having.forEach(walkPredicate);
    query.ordering.forEach((ordering) => walkValue(ordering.expression.node));
  };

  const walkMutation = (query: MutationPlan): void => {
    walkBinding(query.root);

    const walkAssignments = (
      values: Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>>,
    ) => {
      for (const value of Object.values(values)) {
        if (value !== DEFAULT_VALUE) {
          walkValue(value);
        }
      }
    };

    if (query.kind === "insert") {
      if (!query.atomicValues) {
        for (const column of query.root.table.columns) {
          for (const values of query.values) {
            const value = values[column.name];

            if (value !== undefined && value !== DEFAULT_VALUE) {
              walkValue(value);
            }
          }
        }
      }

      if (query.conflict?.action === "update") {
        walkAssignments(query.conflict.values);
      }
    } else if (query.kind === "update") {
      walkAssignments(query.values[0]!);
    }

    query.predicates.forEach(walkPredicate);
    query.checks?.forEach(walkPredicate);
    query.selection.forEach((expression) => walkValue(expression.node));
  };

  if (plan.kind === "select") {
    walkSelect(plan);
  } else {
    walkMutation(plan);
  }

  for (const [identity, name] of references) {
    if (commonTables.get(name)?.identity !== identity) {
      throw new Error(
        `symmetria: recursive reference "${name}" escaped its CTE`,
      );
    }
  }

  // WITH names shadow tables everywhere in the statement.
  for (const name of commonTables.keys()) {
    if (tables.has(name)) {
      throw new Error(
        `symmetria: CTE "${name}" has the SQL name of a table in this statement and would hide it; choose another CTE name`,
      );
    }
  }
};

/** Renders `WITH …` for the collected CTEs; their parameters are numbered first. */
export const withClause = (compilation: Compilation): string => {
  const definitions = [...compilation.commonTables.values()];
  const rendered = definitions.map((definition) => {
    const anchor = selectSql(compilation, definition.query, {});
    const body = definition.recursive
      ? compilation.renderer.recursiveUnion(
          anchor,
          selectSql(compilation, definition.recursive, {}),
          { unionAll: !!definition.unionAll },
        )
      : anchor;

    return `${quoteIdentifier(definition.name)} AS ${definition.materialized === undefined ? "" : definition.materialized ? "MATERIALIZED " : "NOT MATERIALIZED "}(${body})`;
  });

  return `WITH ${definitions.some((definition) => definition.recursive) ? "RECURSIVE " : ""}${rendered.join(",\n")}\n`;
};
