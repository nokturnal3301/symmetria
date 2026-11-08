/** Runtime scopes and plan helpers shared by every query module. */
import { computedFields } from "../../schema/computed";
import { quoteIdentifier } from "../compile";
import { jsonRowCodec } from "../codecs/json";
import {
  COLUMN_EXPRESSION,
  ORDERING_EXPRESSION,
  createExpression,
  readColumn,
  type ExpressionDescription,
  type Ordering,
  type Parameter,
  type PlaceholderNode,
  type PredicateDescription,
  type QueryColumn,
  type SelectedColumn,
  type ValueNode,
} from "../expressions";
import {
  QUERY_PLAN,
  containsBinding,
  type ExecutionResult,
  type RowLockOptions,
  type SelectPlan,
  type SourceDescription,
  type TableBinding,
} from "../plan/types";
import type { ProjectionObject, RuntimeScope } from "./types";
import type { QueryContext } from "./registry";

const bindingColumns = new WeakMap<TableBinding, RuntimeScope[string]>();
const limitedPlans = new WeakMap<SelectPlan, (SelectPlan | undefined)[]>();
export const QUERY_STATE = Symbol("symmetria.query.state");

type QueryState = {
  readonly plan: SelectPlan;
  readonly allowScopedAlias: boolean;
  readonly freshSource: boolean;
  source?: SourceDescription;
};
export type QueryHandle = ((callback: never) => object) & {
  readonly [QUERY_STATE]: QueryState;
};

/** one()/first() reuse one derived plan per query so compiled SQL and decoders stay cached. */
export const limitedPlan = (state: SelectPlan, limit: 1 | 2): SelectPlan => {
  let derived = limitedPlans.get(state);

  if (!derived) {
    derived = [];
    limitedPlans.set(state, derived);
  }

  return (derived[limit] ??= Object.freeze({
    ...state,
    limit:
      typeof state.limit === "number" ? Math.min(state.limit, limit) : limit,
  }));
};

export const resultRows = (
  result: ExecutionResult,
): Record<string, unknown>[] => result.rows;

/** The shape callback currently being evaluated: its merged bindings and nesting depth. */
export const shapeFrame: {
  bindings: (() => SelectPlan["bindings"]) | undefined;
  depth: number;
} = { bindings: undefined, depth: 0 };

/** Lazy column handles for one binding; computed fields are evaluated once per binding. */
export const bindingScope = (
  binding: TableBinding,
  bindings: SelectPlan["bindings"],
): RuntimeScope[string] => {
  const existing = bindingColumns.get(binding);

  if (existing) {
    return existing;
  }

  // Aliases and nested scopes often use only a few of the table's columns.
  const columns = Object.defineProperties(
    {},
    Object.fromEntries(
      binding.table.columns.map((column) => {
        let expression: QueryColumn<unknown, string> | undefined;

        return [
          column.name,
          {
            enumerable: true,
            get: () =>
              (expression ??= createExpression({
                node: Object.freeze({
                  kind: "column",
                  description: Object.freeze({ binding, column }),
                }),
                outputName: column.name,
                ...(binding.codecs[column.name]
                  ? { codec: binding.codecs[column.name] }
                  : {}),
              })),
          },
        ];
      }),
    ),
  ) as RuntimeScope[string];

  for (const callback of computedFields.get(binding.table) ?? []) {
    for (const [name, selected] of Object.entries(
      callback(Object.freeze({ ...columns })),
    )) {
      quoteIdentifier(name);

      if (Object.hasOwn(columns, name)) {
        throw new Error(`symmetria: duplicate computed field "${name}"`);
      }

      const description = readColumn(selected);
      validateNode(description.node, bindings);
      columns[name] = createExpression({
        ...description,
        outputName: name,
      });
    }
  }

  const result = Object.freeze(columns);
  bindingColumns.set(binding, result);

  return result;
};

export const createScope = (bindings: SelectPlan["bindings"]): RuntimeScope =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(bindings).map(([aliasName, binding]) => [
        aliasName,
        bindingScope(binding, bindings),
      ]),
    ),
  );

/** Every column inside a predicate must belong to the given bindings (subqueries are checked when built). */
export const validatePredicate = (
  description: PredicateDescription,
  bindings: SelectPlan["bindings"],
): void => {
  switch (description.kind) {
    case "comparison":
      validateNode(description.left, bindings);
      validateNode(description.right, bindings);
      break;
    case "search":
      validateNode(description.value, bindings);
      validateNode(description.query, bindings);
      break;
    case "has":
      validateNode(description.value, bindings);
      validateNode(description.element, bindings);
      break;
    case "nullCheck":
      validateNode(description.value, bindings);
      break;
    case "group":
      description.predicates.forEach((predicate) =>
        validatePredicate(predicate, bindings),
      );
      break;
    case "not":
    case "notTrue":
      validatePredicate(description.predicate, bindings);
      break;
    case "membership":
      validateNode(description.value, bindings);

      if (Array.isArray(description.values)) {
        description.values.forEach((value) => validateNode(value, bindings));
      }

      break;
    case "between":
      validateNode(description.value, bindings);
      validateNode(description.lower, bindings);
      validateNode(description.upper, bindings);
      break;
    case "exists":
      break;
  }
};

export const validateNode = (
  node: ValueNode,
  bindings: SelectPlan["bindings"],
): void => {
  if (node.kind === "column") {
    const { binding, column } = node.description;

    if (!containsBinding(bindings, binding)) {
      throw new Error(
        `symmetria: column "${binding.alias}.${column.name}" belongs to another query scope`,
      );
    }
  } else if (node.kind === "raw") {
    node.parts.forEach((part) => {
      if (typeof part !== "string") {
        validateNode(part, bindings);
      }
    });
  } else if (node.kind === "binary") {
    validateNode(node.left, bindings);
    validateNode(node.right, bindings);
  } else if (node.kind === "aggregate" && node.value) {
    validateNode(node.value, bindings);
  } else if (node.kind === "case") {
    validateNode(node.value, bindings);
    node.branches.forEach((branch) => {
      validateNode(branch.when, bindings);
      validateNode(branch.then, bindings);
    });
  } else if (node.kind === "coalesce") {
    node.values.forEach((value) => validateNode(value, bindings));
  } else if (node.kind === "jsonObject") {
    node.selection.forEach((expression) =>
      validateNode(expression.node, bindings),
    );
  } else if (
    node.kind === "jsonPath" ||
    node.kind === "arrayIndex" ||
    node.kind === "arrayLength"
  ) {
    validateNode(node.value, bindings);
  } else if (node.kind === "window") {
    validateNode(node.expression, bindings);
    node.partitionBy.forEach((value) => validateNode(value, bindings));
    node.orderBy.forEach((ordering) =>
      validateNode(ordering.expression.node, bindings),
    );
  } else if (node.kind === "searchRank" || node.kind === "searchHeadline") {
    validateNode(node.value, bindings);
    validateNode(node.query, bindings);
  } else if (node.kind === "tsvector") {
    node.parts.forEach((part) => validateNode(part.value, bindings));
  }
  // Subqueries validate both their local and correlated bindings during compilation.
};

export const readSelection = (
  expressions: readonly SelectedColumn[] | ProjectionObject,
  bindings: SelectPlan["bindings"],
): readonly ExpressionDescription[] => {
  if (
    expressions &&
    typeof expressions === "object" &&
    !Array.isArray(expressions)
  ) {
    const entries = Object.entries(expressions);

    if (!entries.length) {
      throw new Error("symmetria: a projection requires at least one field");
    }

    return Object.freeze(
      entries.map(([name, selected]) => {
        quoteIdentifier(name);

        if (
          !selected ||
          (typeof selected !== "object" && typeof selected !== "function")
        ) {
          throw new Error(
            "symmetria: selected fields must be SQL expressions, objects or selected queries",
          );
        }

        if (QUERY_PLAN in selected) {
          const query = selected[QUERY_PLAN];

          if (!query.selection.length) {
            throw new Error(
              "symmetria: nested queries require selected fields",
            );
          }

          if (
            Object.values(query.bindings).some((binding) =>
              containsBinding(bindings, binding),
            )
          ) {
            throw new Error(
              "symmetria: nested queries require a distinct source occurrence",
            );
          }

          return Object.freeze({
            outputName: name,
            node: Object.freeze({
              kind: "jsonRows" as const,
              query,
              many: true,
            }),
            codec: jsonRowCodec(query.selection, true),
          });
        }

        if (COLUMN_EXPRESSION in selected) {
          const description = readColumn(selected as SelectedColumn);
          validateNode(description.node, bindings);

          return description.outputName === name && Object.isFrozen(description)
            ? description
            : Object.freeze({ ...description, outputName: name });
        }

        const selection = readSelection(selected as ProjectionObject, bindings);

        return Object.freeze({
          outputName: name,
          node: Object.freeze({ kind: "jsonObject" as const, selection }),
          codec: jsonRowCodec(selection),
        });
      }),
    );
  }

  if (!Array.isArray(expressions) || !expressions.length) {
    throw new Error("symmetria: a projection requires at least one field");
  }

  const names = new Set<string>();

  return Object.freeze(
    (expressions as readonly SelectedColumn[]).map((expression) => {
      const description = readColumn(expression);
      quoteIdentifier(description.outputName);
      validateNode(description.node, bindings);

      if (names.has(description.outputName)) {
        throw new Error(
          `symmetria: duplicate selected name "${description.outputName}"; use .as()`,
        );
      }

      names.add(description.outputName);

      return description;
    }),
  );
};

export const countValue = (
  name: string,
  count: number | Parameter<number>,
): number | PlaceholderNode => {
  if (typeof count !== "number") {
    const node = readColumn(count).node;

    if (node.kind !== "placeholder") {
      throw new Error(
        `symmetria: ${name} requires a number or prepared parameter`,
      );
    }

    return Object.freeze({ ...node, count: true });
  }

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`symmetria: ${name} must be a nonnegative safe integer`);
  }

  return count;
};

export const EMPTY: readonly never[] = Object.freeze([]);
const noBindings: SelectPlan["bindings"] = Object.freeze({});

export const emptyBindings = () => noBindings;

export const initialPlan = (root: TableBinding): SelectPlan =>
  Object.freeze({
    kind: "select",
    root,
    bindings: Object.freeze({ [root.alias]: root }),
    joins: EMPTY,
    selection: EMPTY,
    predicates: EMPTY,
    ordering: EMPTY,
    grouping: EMPTY,
    having: EMPTY,
    distinct: false,
  });

export const evaluateContext = <Result>(
  context: QueryContext,
  callback: () => Result,
): Result => {
  const previousBindings = shapeFrame.bindings;
  shapeFrame.bindings = context.bindings;
  shapeFrame.depth += 1;

  try {
    return callback();
  } finally {
    shapeFrame.bindings = previousBindings;
    shapeFrame.depth -= 1;
  }
};

export const lockPlan = (
  state: SelectPlan,
  mode: "UPDATE" | "SHARE",
  options: RowLockOptions = {},
): SelectPlan => {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (name) => !["of", "noWait", "skipLocked"].includes(name),
    ) ||
    (options.noWait !== undefined && typeof options.noWait !== "boolean") ||
    (options.skipLocked !== undefined &&
      typeof options.skipLocked !== "boolean")
  ) {
    throw new Error("symmetria: invalid row lock options");
  }

  if (options.noWait && options.skipLocked) {
    throw new Error("symmetria: choose either NOWAIT or SKIP LOCKED");
  }

  if (
    options.of !== undefined &&
    (!Array.isArray(options.of) ||
      !options.of.length ||
      options.of.some(
        (alias) =>
          typeof alias !== "string" || !Object.hasOwn(state.bindings, alias),
      ))
  ) {
    throw new Error("symmetria: row locks require existing query aliases");
  }

  return Object.freeze({
    ...state,
    locking: Object.freeze({
      ...options,
      mode,
      ...(options.of ? { of: Object.freeze([...options.of]) } : {}),
    }),
  });
};

export const readOrdering = (
  ordering: Ordering | readonly Ordering[],
  bindings: SelectPlan["bindings"],
) => {
  const descriptions = (Array.isArray(ordering) ? ordering : [ordering]).map(
    (entry: Ordering) => {
      if (!entry || !(ORDERING_EXPRESSION in entry)) {
        throw new Error(
          "symmetria: orderBy() expects ascending or descending expressions",
        );
      }

      validateNode(entry[ORDERING_EXPRESSION].expression.node, bindings);

      return entry[ORDERING_EXPRESSION];
    },
  );

  if (!descriptions.length) {
    throw new Error("symmetria: orderBy() requires expressions");
  }

  return descriptions;
};

export const presentSelection: readonly ExpressionDescription[] = Object.freeze(
  [
    {
      outputName: "present",
      node: Object.freeze({ kind: "raw", parts: Object.freeze(["1"]) }),
    },
  ],
);
