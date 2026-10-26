import { paginatesRootFirst, sharedAggregates } from "../aggregates";
import type { ValueNode } from "../expressions";
import {
  containsBinding,
  mergeBindings,
  numberedAlias,
  type SelectPlan,
  type TableBinding,
} from "../state";
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
    !compilation.dialect.capabilities.mutationRootAlias &&
    compilation.plan.kind !== "select" &&
    binding === compilation.plan.root
  ) {
    return quoteIdentifier(binding.table.sqlName);
  }

  // Discovery happened in collectCommonTables; a miss here means the walker
  // and the renderer disagree on some node, which must fail loudly.
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
  // A standalone source cannot shadow another SQL alias. Keep the full scope
  // handling for JOINs, correlated queries and bindings with an active override.
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
        // Relation-based mutations intentionally reuse their target in an
        // uncorrelated primary-key subquery.
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

export const renderSelect = (
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

  const aggregates = compilation.dialect.capabilities.lateralJoins
    ? sharedAggregates(query)
    : [];
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

  // JSON avoids binary conversion for terminal output. Intermediate SQL values
  // and equality/grouping/sorting expressions retain JSONB semantics.
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
  // Parameter numbering follows SQL text order, including subqueries in SELECT/FROM.
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

  // Rendered once: a second rendering would number its compilation.parameters again.
  const orderBy = query.ordering.length
    ? `ORDER BY ${query.ordering.map((ordering) => orderingSql(compilation, ordering, bindings)).join(", ")}`
    : undefined;
  const body = fragments.splice(0);

  if (orderBy) {
    fragments.push(orderBy);
  }

  // Fixed, validated counts let PostgreSQL cost LIMIT correctly in generic plans.
  const count = (value: number | ValueNode | undefined) =>
    value === undefined
      ? undefined
      : typeof value === "number"
        ? String(value)
        : valueSql(compilation, value, bindings);

  fragments.push(
    ...compilation.dialect.limitOffset(count(query.limit), count(query.offset)),
  );

  if (query.locking) {
    const lock = compilation.dialect.capabilities.rowLocks
      ? compilation.dialect.rowLock({
          mode: query.locking.mode,
          of: query.locking.of?.map((alias) =>
            aliasSql(compilation, query.bindings[alias]!),
          ),
          noWait: !!query.locking.noWait,
          skipLocked: !!query.locking.skipLocked,
        })
      : undefined;

    if (!lock) {
      throw new Error(
        `symmetria: row locks are not available in dialect "${compilation.dialect.name}"`,
      );
    }

    fragments.push(lock);
  }

  if (
    !compilation.dialect.capabilities.rootPagination ||
    aggregates.length ||
    !paginatesRootFirst(query)
  ) {
    return [projection, source, ...body, ...fragments].join("\n");
  }

  // Restrict the root rows in a derived table that keeps the root's alias and
  // column names, so the projection's correlated subqueries run only for the
  // page that survives LIMIT/OFFSET. The outer ORDER BY restores the order.
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
