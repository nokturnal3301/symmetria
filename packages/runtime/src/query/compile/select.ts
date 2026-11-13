/**
 * Renders SELECT plans: FROM/JOIN clauses, nested JSON projections, pagination and locking.
 */
import {
  paginatesRootFirst,
  sharedAggregates,
} from "../expressions/aggregates";
import type { ValueNode } from "../expressions";
import {
  containsBinding,
  mergeBindings,
  numberedAlias,
  type SelectPlan,
  type TableBinding,
} from "../plan/types";
import {
  aliasSql,
  quoteIdentifier,
  type Bindings,
  type Compilation,
} from "./state";
import { orderingSql, projectionSql, valueSql } from "./values";
import { predicateSql } from "./predicates";

export const tableSql = (
  compilation: Compilation,
  binding: TableBinding,
  ancestors: Bindings = {},
): string => {
  if (
    binding.cte &&
    compilation.commonTables.get(binding.cte.name) !== binding.cte
  ) {
    throw new Error(
      `symmetria: internal error, CTE "${binding.cte.name}" was not collected before rendering`,
    );
  }

  return `${binding.derived ? `(${selectSql(compilation, binding.derived, ancestors)})` : quoteIdentifier(binding.cteReference?.name ?? binding.table.sqlName)} AS ${aliasSql(compilation, binding)}`;
};

export const selectSql = (
  compilation: Compilation,
  query: SelectPlan,
  outerBindings: Bindings,
  jsonValues = false,
  jsonOutput = false,
): string => {
  // A data error found while building this query or one it embeds.
  if (query.failure) {
    throw query.failure.error;
  }

  if (
    !query.joins.length &&
    !Object.keys(outerBindings).length &&
    !compilation.aliasNames.has(query.root)
  ) {
    return renderSelect(
      compilation,
      query,
      outerBindings,
      jsonValues,
      jsonOutput,
    );
  }

  const occupied = new Set(
    Object.values(outerBindings).map(
      (binding) => compilation.aliasNames.get(binding) ?? binding.alias,
    ),
  );
  const previousAliases = new Map<TableBinding, string | undefined>();

  try {
    for (const binding of [
      query.root,
      ...query.joins.map((join) => join.binding),
    ]) {
      if (containsBinding(outerBindings, binding)) {
        if (
          compilation.plan.kind !== "select" &&
          binding === compilation.plan.root
        ) {
          continue;
        }

        throw new Error(
          "symmetria: nested queries require a distinct source occurrence",
        );
      }

      previousAliases.set(binding, compilation.aliasNames.get(binding));
      let alias = binding.alias;
      let ordinal = 2;

      while (occupied.has(alias)) {
        alias = numberedAlias(binding.alias, ordinal++);
      }

      occupied.add(alias);
      compilation.aliasNames.set(binding, alias);
    }

    return renderSelect(
      compilation,
      query,
      outerBindings,
      jsonValues,
      jsonOutput,
    );
  } finally {
    for (const [binding, alias] of previousAliases) {
      if (alias === undefined) {
        compilation.aliasNames.delete(binding);
      } else {
        compilation.aliasNames.set(binding, alias);
      }
    }
  }
};

const renderSelect = (
  compilation: Compilation,
  query: SelectPlan,
  outerBindings: Bindings,
  jsonValues: boolean,
  jsonOutput: boolean,
): string => {
  if (!query.selection.length) {
    throw new Error(
      "symmetria: select fields in a shape before compiling or executing a query",
    );
  }

  const bindings =
    query.joins.length || Object.keys(outerBindings).length
      ? mergeBindings(outerBindings, {
          ...Object.fromEntries(
            query.joins.map((join) => [join.binding.alias, join.binding]),
          ),
          ...query.bindings,
        })
      : query.bindings;

  if (query.grouping.length || query.distinct) {
    (compilation.expressionCaches ??= new Map()).set(bindings, []);
  }

  const aggregates = sharedAggregates(query);
  const lateral: { alias: string; query: SelectPlan }[] = [];

  if (aggregates.length) {
    const sharedReferences = new Map<ValueNode, string>();
    const occupied = new Set(
      Object.values(bindings).map(
        (binding) => compilation.aliasNames.get(binding) ?? binding.alias,
      ),
    );
    aggregates.forEach((group, position) => {
      let alias = `__symmetria_shared_${position}`;

      while (occupied.has(alias)) {
        alias += "_";
      }

      occupied.add(alias);

      for (const node of group.references) {
        sharedReferences.set(
          node,
          `${quoteIdentifier(alias)}.${quoteIdentifier(group.node.query.selection[0]!.outputName)}`,
        );
      }

      lateral.push({ alias, query: group.node.query });
    });

    (compilation.aggregateReferences ??= new Map()).set(
      bindings,
      sharedReferences,
    );
  }

  const terminalJSON =
    jsonOutput &&
    !query.distinct &&
    !query.grouping.length &&
    !query.having.length &&
    !query.ordering.some(
      (ordering) =>
        ordering.expression.node.kind === "jsonRows" ||
        ordering.expression.node.kind === "jsonObject",
    );

  const projection = `SELECT ${query.distinct ? "DISTINCT " : ""}${projectionSql(compilation, query.selection, bindings, jsonValues, terminalJSON)}`;
  const source = `FROM ${tableSql(compilation, query.root, outerBindings)}`;
  const fragments: string[] = [];

  if (query.joins.length) {
    let joinedBindings: Bindings = mergeBindings(outerBindings, {
      [query.root.alias]: query.root,
    });

    for (const join of query.joins) {
      joinedBindings = mergeBindings(joinedBindings, {
        [join.binding.alias]: join.binding,
      });
      fragments.push(
        `${join.kind} JOIN ${tableSql(compilation, join.binding)}${join.condition ? ` ON ${predicateSql(compilation, join.condition, joinedBindings)}` : ""}`,
      );
    }
  }

  if (query.predicates.length) {
    for (const aggregate of lateral) {
      fragments.push(
        `LEFT JOIN LATERAL (${selectSql(compilation, aggregate.query, bindings)}) AS ${quoteIdentifier(aggregate.alias)} ON TRUE`,
      );
    }

    fragments.push(
      `WHERE ${query.predicates.map((description) => predicateSql(compilation, description, bindings)).join(" AND ")}`,
    );
  }

  if (query.grouping.length) {
    fragments.push(
      `GROUP BY ${query.grouping.map((expression) => valueSql(compilation, expression.node, bindings)).join(", ")}`,
    );
  }

  if (query.having.length) {
    fragments.push(
      `HAVING ${query.having.map((description) => predicateSql(compilation, description, bindings)).join(" AND ")}`,
    );
  }

  const orderBy = query.ordering.length
    ? `ORDER BY ${query.ordering.map((ordering) => orderingSql(compilation, ordering, bindings)).join(", ")}`
    : undefined;
  const body = fragments.splice(0);

  if (orderBy) {
    fragments.push(orderBy);
  }

  const count = (value: number | ValueNode | undefined) =>
    value === undefined
      ? undefined
      : typeof value === "number"
        ? String(value)
        : valueSql(compilation, value, bindings);

  fragments.push(
    ...compilation.renderer.limitOffset(
      count(query.limit),
      count(query.offset),
    ),
  );

  if (query.locking) {
    const lock = compilation.renderer.rowLock({
      mode: query.locking.mode,
      of: query.locking.of?.map((alias) =>
        aliasSql(compilation, query.bindings[alias]!),
      ),
      noWait: !!query.locking.noWait,
      skipLocked: !!query.locking.skipLocked,
    });

    fragments.push(lock);
  }

  if (aggregates.length || !paginatesRootFirst(query)) {
    return [projection, source, ...body, ...fragments].join("\n");
  }

  const carried = query.root.table.columns
    .map(
      (column) =>
        `${aliasSql(compilation, query.root)}.${quoteIdentifier(column.sqlName)} AS ${quoteIdentifier(column.sqlName)}`,
    )
    .join(", ");
  const inner = [`SELECT ${carried}`, source, ...body, ...fragments].join("\n");

  return [
    projection,
    `FROM (${inner}) AS ${aliasSql(compilation, query.root)}`,
    ...(orderBy ? [orderBy] : []),
  ].join("\n");
};
