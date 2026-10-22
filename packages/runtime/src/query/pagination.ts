import { createHash } from "node:crypto";
import { compileQuery, executePlan } from "./compiler";
import { type PredicateDescription, type ValueNode } from "./expressions";
import type { QueryExecutor, SelectPlan } from "./state";
import { derivedBinding } from "./derived";
import { resolveDialect } from "./dialects/registry";

const containsWindow = (node: ValueNode): boolean => {
  switch (node.kind) {
    case "window":
      return true;
    case "jsonObject":
      return node.selection.some((expression) =>
        containsWindow(expression.node),
      );
    case "case":
      return (
        containsWindow(node.value) ||
        node.branches.some(
          (branch) =>
            containsWindow(branch.when) || containsWindow(branch.then),
        )
      );
    case "coalesce":
    case "tuple":
      return node.values.some(containsWindow);
    case "binary":
      return containsWindow(node.left) || containsWindow(node.right);
    case "raw":
      return node.parts.some(
        (part) => typeof part !== "string" && containsWindow(part),
      );
    case "jsonPath":
    case "arrayIndex":
    case "arrayLength":
      return containsWindow(node.value);
    default:
      return false;
  }
};

/** Apply keyset predicates after windows have seen the complete filtered input. */
const windowPagePlan = (plan: SelectPlan): SelectPlan => {
  const occupied = new Set(
    plan.selection.map((expression) => expression.outputName),
  );
  const keys = plan.ordering.map((ordering, position) => {
    let name = `__symmetria_order_${position}`;

    while (occupied.has(name)) {
      name += "_";
    }

    occupied.add(name);

    return { ...ordering.expression, outputName: name };
  });
  const root = derivedBinding(
    { ...plan, selection: [...plan.selection, ...keys], ordering: [] },
    "__symmetria_page",
  );

  const column = (name: string): ValueNode => ({
    kind: "column",
    description: {
      binding: root,
      column: root.table.columns.find((column) => column.name === name)!,
    },
  });

  return {
    ...plan,
    root,
    bindings: { [root.alias]: root },
    predicates: [],
    selection: plan.selection.map((expression) => ({
      ...expression,
      node: column(expression.outputName),
    })),
    ordering: plan.ordering.map((ordering, position) => ({
      ...ordering,
      expression: {
        ...ordering.expression,
        node: column(keys[position]!.outputName),
      },
    })),
  };
};

declare const CURSOR_RESULT: unique symbol;
export type PageCursor<Row> = string & { readonly [CURSOR_RESULT]: Row };
export type Page<Row> = { items: Row[]; nextCursor: PageCursor<Row> | null };

export const executePage = async (
  plan: SelectPlan,
  options: { size: number; after?: string | null },
  executor?: QueryExecutor,
): Promise<Page<Record<string, unknown>>> => {
  if (
    !Number.isSafeInteger(options.size) ||
    options.size < 1 ||
    options.size >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("symmetria: page size must be a positive safe integer");
  }

  if (
    plan.joins.length ||
    plan.grouping.length ||
    plan.having.length ||
    plan.distinct ||
    plan.root.derived ||
    plan.offset !== undefined ||
    plan.limit !== undefined
  ) {
    throw new Error(
      "symmetria: page() requires an ungrouped root-table query without joins, LIMIT or OFFSET",
    );
  }

  const columns = plan.ordering.map((ordering) => {
    const node = ordering.expression.node;

    if (node.kind !== "column" || node.description.binding !== plan.root) {
      throw new Error(
        "symmetria: page() requires plain root columns in ORDER BY",
      );
    }

    return node.description.column;
  });
  const names = columns.map((column) => column.name);
  const keys = plan.root.table.columns.filter((column) => column.primaryKey);

  if (
    !names.length ||
    new Set(names).size !== names.length ||
    !(
      (keys.length && keys.every((column) => names.includes(column.name))) ||
      columns.some((column) => column.unique && column.notNull)
    )
  ) {
    throw new Error(
      "symmetria: page() ORDER BY must include a complete primary key or a non-null unique column",
    );
  }

  const compiled = compileQuery(plan);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(compiled, (_name, value) =>
        typeof value === "bigint" ? { bigint: String(value) } : value,
      ),
    )
    .digest("hex");
  const pagePlan = plan.selection.some((expression) =>
    containsWindow(expression.node),
  )
    ? windowPagePlan(plan)
    : plan;
  const predicates = [...pagePlan.predicates];

  const cursorValue = (value: unknown, position: number): ValueNode => ({
    kind: "parameter",
    value,
    ...(["json", "jsonb"].includes(columns[position]!.sqlType)
      ? { cast: columns[position]!.sqlType as "json" | "jsonb" }
      : {}),
  });

  if (options.after != null) {
    let values: unknown[];

    try {
      if (
        typeof options.after !== "string" ||
        options.after.length > 65536 ||
        !/^[A-Za-z0-9_-]+$/.test(options.after)
      ) {
        throw new Error();
      }

      const cursor = JSON.parse(
        Buffer.from(options.after, "base64url").toString(),
      );

      if (
        cursor.version !== 1 ||
        cursor.query !== fingerprint ||
        !Array.isArray(cursor.values) ||
        cursor.values.length !== columns.length ||
        cursor.values.some((value: unknown, position: number) =>
          value === null
            ? columns[position]!.notNull
            : typeof value !== "string",
        )
      ) {
        throw new Error();
      }

      values = cursor.values;
    } catch {
      throw new Error(
        "symmetria: invalid page cursor or cursor from another query",
      );
    }

    if (
      columns.every((column) => column.notNull) &&
      pagePlan.ordering.every(
        (ordering) => ordering.direction === pagePlan.ordering[0]!.direction,
      )
    ) {
      const tuple = (nodes: ValueNode[]): ValueNode =>
        nodes.length === 1 ? nodes[0]! : { kind: "tuple", values: nodes };

      predicates.push({
        kind: "comparison",
        left: tuple(
          pagePlan.ordering.map((ordering) => ordering.expression.node),
        ),
        operator: pagePlan.ordering[0]!.direction === "ASC" ? ">" : "<",
        right: tuple(values.map(cursorValue)),
      });
    } else {
      const branches: PredicateDescription[] = [];
      const prefix: PredicateDescription[] = [];
      pagePlan.ordering.forEach((ordering, position) => {
        const expression = ordering.expression;
        const value = values[position];
        const nullsFirst =
          (ordering.nulls ??
            resolveDialect(plan.root.dialect).nullsDefault(
              ordering.direction,
            )) === "FIRST";
        const following: PredicateDescription =
          value === null
            ? nullsFirst
              ? { kind: "nullCheck", value: expression.node, negated: true }
              : { kind: "group", operator: "OR", predicates: [] }
            : {
                kind: "group",
                operator: "OR",
                predicates: [
                  {
                    kind: "comparison",
                    left: expression.node,
                    operator: ordering.direction === "ASC" ? ">" : "<",
                    right: cursorValue(value, position),
                  },
                  ...(!nullsFirst && !columns[position]!.notNull
                    ? [
                        {
                          kind: "nullCheck" as const,
                          value: expression.node,
                          negated: false,
                        },
                      ]
                    : []),
                ],
              };
        branches.push({
          kind: "group",
          operator: "AND",
          predicates: [...prefix, following],
        });
        prefix.push({
          kind: "comparison",
          left: expression.node,
          operator: "IS NOT DISTINCT FROM",
          right: cursorValue(value, position),
        });
      });
      predicates.push({ kind: "group", operator: "OR", predicates: branches });
    }
  }

  const occupied = new Set(
    plan.selection.map((expression) => expression.outputName),
  );
  const textCast = resolveDialect(plan.root.dialect).textCast;
  const hidden = pagePlan.ordering.map((ordering, position) => {
    let name = `__symmetria_cursor_${position}`;

    while (occupied.has(name)) {
      name += "_";
    }

    occupied.add(name);

    // PostgreSQL text preserves timestamp microseconds and custom storage values,
    // independently of lossy application decoders (such as JavaScript Date).
    return {
      outputName: name,
      node: {
        kind: "raw" as const,
        parts: [
          ...(textCast.prefix ? [textCast.prefix] : []),
          ordering.expression.node,
          textCast.suffix,
        ],
      },
    };
  });
  const result = await executePlan(
    {
      ...pagePlan,
      selection: [...pagePlan.selection, ...hidden],
      predicates,
      limit: options.size + 1,
    },
    executor,
  );
  const rows = result.rows.slice(0, options.size);
  const last = rows.at(-1);
  const nextCursor =
    result.rows.length > options.size && last
      ? (Buffer.from(
          JSON.stringify({
            version: 1,
            query: fingerprint,
            values: hidden.map((expression) => last[expression.outputName]),
          }),
        ).toString("base64url") as PageCursor<Record<string, unknown>>)
      : null;

  return {
    items: rows.map((row) =>
      Object.fromEntries(
        plan.selection.map((expression) => [
          expression.outputName,
          row[expression.outputName],
        ]),
      ),
    ),
    nextCursor,
  };
};
