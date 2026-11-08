/** applyShape(): evaluates one projection callback with its options into a plan. */
import {
  readColumn,
  type Ordering,
  type Parameter,
  type SelectedColumn,
} from "../expressions";
import {
  QUERY_PLAN,
  containsBinding,
  type RowLockOptions,
  type SelectPlan,
  type TableBinding,
} from "../plan/types";
import { SHAPE_SOURCE, shapeExpressions } from "./projections";
import {
  countValue,
  evaluateContext,
  lockPlan,
  readOrdering,
  readSelection,
  shapeFrame,
  validateNode,
} from "./scope";
import {
  localJoin,
  readShapePredicates,
  type LocalJoinInput,
  type ShapeCallback,
  type ShapePredicate,
} from "./joins";
import type { QueryContext } from "./registry";
import type { ProjectionObject, QueryOptions, RuntimeScope } from "./types";

const emptyShape = () => ({});

const queryOptionNames = new Set<keyof QueryOptions<never, never>>([
  "where",
  "orderBy",
  "limit",
  "offset",
  "groupBy",
  "having",
  "distinct",
  "forUpdate",
  "forShare",
]);

export const applyShape = (
  context: QueryContext,
  binding: TableBinding,
  callback: ShapeCallback | Record<string, unknown>,
  options?: Record<string, unknown>,
): SelectPlan => {
  if (typeof callback === "object" && options === undefined) {
    options = callback;
    callback = emptyShape;
  }

  if (typeof callback !== "function") {
    throw new Error("symmetria: a shape requires a synchronous callback");
  }

  if (SHAPE_SOURCE in callback && callback[SHAPE_SOURCE] !== binding.table) {
    throw new Error("symmetria: reusable shape belongs to another table");
  }

  if (
    options !== undefined &&
    (!options || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new Error("symmetria: query options must be an object");
  }

  const initialJoinCount = context.plan.joins.length;
  const ancestors = shapeFrame.bindings?.();

  if (
    ancestors &&
    Object.values(context.plan.bindings).some((binding) =>
      containsBinding(ancestors, binding),
    )
  ) {
    throw new Error(
      "symmetria: nested queries require a distinct source occurrence",
    );
  }

  let active = true;

  const assertActive = () => {
    if (!active || shapeFrame.bindings !== context.bindings) {
      throw new Error(
        "symmetria: local JOIN helpers and whereNotNull can only be used inside their shape callback",
      );
    }
  };

  const join =
    (kind: "LEFT" | "INNER" | "AUTO" | "CROSS") =>
    (
      input: LocalJoinInput,
      condition?: (columns: RuntimeScope[string]) => ShapePredicate,
    ) => {
      assertActive();

      return localJoin(context, kind, input, condition);
    };

  const whereNotNull = (column: SelectedColumn): SelectedColumn => {
    assertActive();
    const expression = readColumn(column);
    validateNode(expression.node, context.bindings());
    context.plan = Object.freeze({
      ...context.plan,
      predicates: Object.freeze([
        ...context.plan.predicates,
        Object.freeze({
          kind: "nullCheck" as const,
          value: expression.node,
          negated: true,
        }),
      ]),
    });

    return column;
  };

  let result: Record<string, unknown>;
  let controls: [string, unknown][] | undefined;

  try {
    result = evaluateContext(context, () => {
      const columns = context.columns(binding);
      // Tools live only for these callbacks; freezing them is pure overhead.
      const tools = Object.assign(Object.create(shapeExpressions), {
        join: join("AUTO"),
        innerJoin: join("INNER"),
        leftJoin: join("LEFT"),
        crossJoin: join("CROSS"),
        whereNotNull,
      });
      const projection = callback(columns, tools);

      if (options !== undefined) {
        controls = Object.entries(options).map(([name, value]) => {
          if (!queryOptionNames.has(name as keyof QueryOptions<never, never>)) {
            throw new Error(`symmetria: unknown query option "${name}"`);
          }

          return [
            name,
            typeof value === "function" ? value(columns, tools) : value,
          ];
        });
      }

      return projection;
    });
  } finally {
    active = false;
  }

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (typeof result.then === "function" && !(QUERY_PLAN in result.then))
  ) {
    throw new Error(
      "symmetria: a shape callback must synchronously return an object",
    );
  }

  const fields: Record<string, ProjectionObject[string]> = Object.create(null);
  const entries = Object.entries(result);

  for (const [name] of entries) {
    if (name.startsWith("$")) {
      throw new Error(
        `symmetria: "${name}" is not a field; query options such as ${name.slice(1)} belong to the second argument: posts(shape, { ${name.slice(1)}: … })`,
      );
    }
  }

  if (SHAPE_SOURCE in callback && !entries.length) {
    throw new Error("symmetria: shape() requires projected fields");
  }

  const settings = controls ?? [];

  // This draft stays private until all controls and projections are validated.
  // Copy once, then freeze the completed plan rather than copying per control.
  let plan = { ...context.plan };

  if (
    settings.some(([name, value]) => name === "forUpdate" && value) &&
    settings.some(([name, value]) => name === "forShare" && value)
  ) {
    throw new Error("symmetria: choose either forUpdate or forShare");
  }

  for (const [name, value] of settings) {
    switch (name) {
      case "distinct": {
        if (value !== undefined) {
          if (typeof value !== "boolean") {
            throw new Error("symmetria: distinct requires a boolean");
          }

          plan.distinct = value;
        }

        break;
      }
      case "forUpdate":
      case "forShare": {
        if (value !== undefined && value !== false) {
          plan = {
            ...lockPlan(
              plan,
              name === "forUpdate" ? "UPDATE" : "SHARE",
              value === true ? {} : (value as RowLockOptions),
            ),
          };
        }

        break;
      }
      case "where":
      case "having": {
        const clause = name === "where" ? "predicates" : "having";

        if (value !== undefined && value !== null && value !== false) {
          plan[clause] = Object.freeze([
            ...plan[clause],
            ...readShapePredicates(value as ShapePredicate),
          ]);
        }

        break;
      }
      case "orderBy": {
        if (value !== undefined) {
          plan.ordering = Object.freeze([
            ...plan.ordering,
            ...readOrdering(value as Ordering, context.bindings()),
          ]);
        }

        break;
      }
      case "groupBy": {
        if (value !== undefined) {
          if (!Array.isArray(value) || !value.length) {
            throw new Error("symmetria: groupBy requires expressions");
          }

          const grouping = value.map(readColumn);
          grouping.forEach((expression) =>
            validateNode(expression.node, context.bindings()),
          );
          plan.grouping = Object.freeze([...plan.grouping, ...grouping]);
        }

        break;
      }
      case "limit":
      case "offset": {
        if (value !== undefined) {
          plan[name === "limit" ? "limit" : "offset"] = countValue(
            name,
            value as number | Parameter<number>,
          );
        }

        break;
      }
      default: {
        throw new Error(`symmetria: unknown query option "${name}"`);
      }
    }
  }

  for (const [name, value] of entries) {
    fields[name] = value as ProjectionObject[string];
  }

  if (
    !entries.length &&
    !settings.length &&
    context.plan.joins.length === initialJoinCount
  ) {
    throw new Error(
      "symmetria: a shape requires at least one field or query option",
    );
  }

  if (Object.keys(fields).length) {
    plan.selection = readSelection(fields, context.bindings());
  }

  return Object.freeze(plan);
};
