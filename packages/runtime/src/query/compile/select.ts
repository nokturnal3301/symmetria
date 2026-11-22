/**
 * Renders SELECT plans: FROM/JOIN clauses, nested JSON projections, pagination and locking.
 */
import {
  paginatesRootFirst,
  sharedAggregates,
  type SharedAggregates,
} from "../expressions/aggregates";
import type { ValueNode } from "../expressions";
import { sameExpression } from "../plan/equivalence";
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
import {
  jsonPrecisionSql,
  orderingSql,
  projectionSql,
  valueSql,
} from "./values";
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

const DISTANCES = new Set(["<->", "<=>", "<#>", "<+>"]);

/**
 * A condition for "the nearest N rows": true, and it reads no column, so
 * PostgreSQL evaluates it once, before the scan it guards. pgvector's HNSW
 * index hands back `hnsw.ef_search` rows (40 unless set) and meets the other
 * filters only afterwards, so a filtered or a long LIMIT would come up short
 * without an error. For this statement the index returns as many rows as are
 * asked for (1000 is its ceiling) and, from pgvector 0.8, keeps scanning until
 * enough rows pass the filters, with as much memory as that takes (up to
 * pgvector's limit of 1000 × work_mem). `set_config(…, true)` lasts for the
 * transaction, which outside `$transaction()` is this one statement.
 */
const nearestScanSql = (
  query: SelectPlan,
  relaxed: boolean,
): string | undefined => {
  const first = query.ordering[0];
  const node = first?.expression.node;

  if (
    query.limit === undefined ||
    first?.direction !== "ASC" ||
    node?.kind !== "binary" ||
    !DISTANCES.has(node.operator)
  ) {
    return undefined;
  }

  const rows =
    typeof query.limit === "number"
      ? query.limit + (typeof query.offset === "number" ? query.offset : 0)
      : 0;
  const setting = (name: string, value: string) =>
    `CASE WHEN current_setting('${name}', true) IS NULL THEN '' ELSE set_config('${name}', ${value}, true) END`;

  return `(SELECT ${[
    ...(rows > 40
      ? [
          setting(
            "hnsw.ef_search",
            `greatest(current_setting('hnsw.ef_search')::integer, ${Math.min(rows, 1000)})::text`,
          ),
        ]
      : []),
    setting("hnsw.iterative_scan", "'strict_order'"),
    setting("hnsw.max_scan_tuples", "'2147483647'"),
    // The scan also stops at work_mem × this multiplier (1 unless set):
    // about 23,000 index tuples at 4MB, after which rows that pass the
    // filters further away were lost without an error.
    setting("hnsw.scan_mem_multiplier", "'1000'"),
    ...(relaxed ? [setting("ivfflat.iterative_scan", "'relaxed_order'")] : []),
  ].join(" || ")}) IS NOT NULL`;
};

/**
 * Whether the schema declares an IVFFlat index on the column the query takes
 * its nearest rows by. Such an index reads the lists nearest to the question
 * and stops, so a filter can leave it short of rows; it can read on (pgvector
 * 0.8), but then returns rows only roughly in order. The statement lets it,
 * and sorts the rows it returned once more, exactly.
 */
const ordersThroughIvfflat = (query: SelectPlan): boolean => {
  const node = query.ordering[0]?.expression.node;
  const column =
    node?.kind === "binary" && node.left.kind === "column"
      ? node.left.description
      : undefined;

  // A row lock stays on the inner statement, which may lock rows in a
  // subquery; the outer one only sorts them again.
  return (
    !!column &&
    !query.distinct &&
    !query.grouping.length &&
    (column.binding.table.indexes ?? []).some(
      (definition) =>
        definition.method === "ivfflat" &&
        definition.keys[0]?.startsWith(quoteIdentifier(column.column.sqlName)),
    )
  );
};

const carriedLists = new WeakMap<TableBinding["table"], Map<string, string>>();

/** Every column of the root under its own name, for a page taken before its nested rows. */
const carriedColumns = (root: TableBinding, alias: string): string => {
  let lists = carriedLists.get(root.table);

  if (!lists) {
    carriedLists.set(root.table, (lists = new Map()));
  }

  let list = lists.get(alias);

  if (list === undefined) {
    list = root.table.columns
      .map(
        (column) =>
          `${alias}.${quoteIdentifier(column.sqlName)} AS ${quoteIdentifier(column.sqlName)}`,
      )
      .join(", ");

    // A table is read under a handful of aliases; generated ones stay bounded.
    if (lists.size < 64) {
      lists.set(alias, list);
    }
  }

  return list;
};

const NO_SHARED_AGGREGATES: SharedAggregates = { inner: [], outer: [] };

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

  // In JSON, bigint and numeric values travel as text; a DISTINCT query
  // ordered by such a value would then order by an expression its select
  // list does not have. It runs as it would at the top level, and the text
  // casts and the order are applied around it.
  if (
    jsonValues &&
    query.distinct &&
    query.ordering.length &&
    query.selection.some(
      (expression) => jsonPrecisionSql(compilation, expression, "") !== "",
    )
  ) {
    const fields = query.ordering.map((ordering) =>
      query.selection.find((expression) =>
        sameExpression(expression.node, ordering.expression.node),
      ),
    );

    if (fields.every(Boolean)) {
      const field = (name: string) =>
        `"__symmetria_distinct".${quoteIdentifier(name)}`;

      return [
        `SELECT ${query.selection
          .map(
            (expression) =>
              `${jsonPrecisionSql(compilation, expression, field(expression.outputName))} AS ${quoteIdentifier(expression.outputName)}`,
          )
          .join(", ")}`,
        `FROM (${renderSelect(compilation, query, outerBindings, false, false)}) AS "__symmetria_distinct"`,
        `ORDER BY ${query.ordering
          .map(
            (ordering, position) =>
              `${field(fields[position]!.outputName)} ${ordering.direction}${ordering.nulls ? ` NULLS ${ordering.nulls}` : ""}`,
          )
          .join(", ")}`,
      ].join("\n");
    }
  }

  // A grouped or distinct query must repeat an expression as the same text.
  // An ordering by a selected field repeats it too: with the same text and
  // parameters PostgreSQL computes the expression once, not once per clause.
  const repeatsText = !!query.grouping.length || query.distinct;
  // A shape identifies the query across releases (page cursors), so it is
  // rendered plainly, without the rewrites that only make a statement faster.
  const ordersBySelected =
    !repeatsText &&
    !compilation.shapeOnly &&
    query.ordering.some(
      ({ expression }) =>
        expression.node.kind !== "column" &&
        query.selection.some((selected) =>
          sameExpression(selected.node, expression.node),
        ),
    );

  if (repeatsText || ordersBySelected) {
    (compilation.expressionCaches ??= new Map()).set(bindings, []);
  }

  const aggregates = compilation.shapeOnly
    ? NO_SHARED_AGGREGATES
    : sharedAggregates(query);
  const shared = {
    inner: [] as { alias: string; query: SelectPlan }[],
    outer: [] as { alias: string; query: SelectPlan }[],
  };
  const lateral = (placement: "inner" | "outer") =>
    shared[placement].map(
      ({ alias, query: aggregate }) =>
        `LEFT JOIN LATERAL (${selectSql(compilation, aggregate, bindings)}) AS ${quoteIdentifier(alias)} ON TRUE`,
    );

  if (aggregates.inner.length || aggregates.outer.length) {
    const sharedReferences = new Map<ValueNode, string>();
    const occupied = new Set(
      Object.values(bindings).map(
        (binding) => compilation.aliasNames.get(binding) ?? binding.alias,
      ),
    );
    let position = 0;

    for (const placement of ["inner", "outer"] as const) {
      for (const group of aggregates[placement]) {
        let alias = `__symmetria_shared_${position++}`;

        while (occupied.has(alias)) {
          alias += "_";
        }

        occupied.add(alias);

        for (const [node, column] of group.references) {
          sharedReferences.set(
            node,
            `${quoteIdentifier(alias)}.${quoteIdentifier(column)}`,
          );
        }

        shared[placement].push({ alias, query: group.query });
      }
    }

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
  if (query.rootless) {
    return projection;
  }

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

  fragments.push(...lateral("inner"));

  const relaxed = !compilation.shapeOnly && ordersThroughIvfflat(query);
  const nearest = compilation.shapeOnly
    ? undefined
    : nearestScanSql(query, relaxed);

  if (query.predicates.length || nearest) {
    fragments.push(
      `WHERE ${[...(nearest ? [nearest] : []), ...query.predicates.map((description) => predicateSql(compilation, description, bindings))].join(" AND ")}`,
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
    // PostgreSQL cannot lock the nullable side of an outer join and refuses a
    // lock that names no tables there. A relation path adds such a JOIN by
    // itself (`post.editor.name`), so the lock then names the tables it can
    // reach: the root and the inner-joined ones.
    const outer = query.joins.some((join) => join.kind === "LEFT");
    const reachable =
      !query.locking.of &&
      outer &&
      query.joins.every((join) => join.kind !== "RIGHT" && join.kind !== "FULL")
        ? [
            query.root,
            ...query.joins
              .filter(
                (join) =>
                  join.kind !== "LEFT" &&
                  !join.binding.cte &&
                  !join.binding.cteReference,
              )
              .map((join) => join.binding),
          ].map((binding) => aliasSql(compilation, binding))
        : undefined;
    const lock = compilation.renderer.rowLock({
      mode: query.locking.mode,
      of:
        reachable ??
        query.locking.of?.map((alias) =>
          aliasSql(compilation, query.bindings[alias]!),
        ),
      noWait: !!query.locking.noWait,
      skipLocked: !!query.locking.skipLocked,
    });

    fragments.push(lock);
  }

  if (aggregates.inner.length || !paginatesRootFirst(query)) {
    if (!nearest || !relaxed) {
      return [projection, source, ...body, ...fragments].join("\n");
    }

    // The ordering keys travel as extra columns. PostgreSQL trusts the inner
    // ORDER BY, so the first key is sorted as `key + 0`, an order it has to
    // establish itself.
    const keys = query.ordering.map(
      (ordering, position) =>
        `${valueSql(compilation, ordering.expression.node, bindings)} AS ${quoteIdentifier(`__symmetria_order_${position}`)}`,
    );
    const inner = [
      `${projection}, ${keys.join(", ")}`,
      source,
      ...body,
      ...fragments,
    ].join("\n");

    return [
      `SELECT ${query.selection.map((expression) => quoteIdentifier(expression.outputName)).join(", ")}`,
      `FROM (${inner}) AS "__symmetria_nearest"`,
      `ORDER BY ${query.ordering
        .map(
          (ordering, position) =>
            `${quoteIdentifier(`__symmetria_order_${position}`)}${position ? "" : " + 0"} ${ordering.direction}${ordering.nulls ? ` NULLS ${ordering.nulls}` : ""}`,
        )
        .join(", ")}`,
    ].join("\n");
  }

  const carried = carriedColumns(query.root, aliasSql(compilation, query.root));
  const inner = [`SELECT ${carried}`, source, ...body, ...fragments].join("\n");

  return [
    projection,
    `FROM (${inner}) AS ${aliasSql(compilation, query.root)}`,
    ...lateral("outer"),
    ...(orderBy ? [orderBy] : []),
  ].join("\n");
};
