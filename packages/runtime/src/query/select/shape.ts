/** applyShape(): evaluates one projection callback with its options into a plan. */
import { freeze } from "../plan/freeze";
import {
  COLUMN_EXPRESSION,
  createExpression,
  notNullPredicate,
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
import { expressionSqlType } from "../plan/metadata";
import { isVectorType } from "../../schema/column";
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
  FULL_JOIN,
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

/**
 * The options that also receive the projection's fields. A WHERE runs before
 * aggregates and windows exist, so `where` reads the source columns only.
 */
const selectedOptionNames: ReadonlySet<string> = new Set([
  "orderBy",
  "groupBy",
  "having",
]);

/** A nested object, collection or relation: several values, not one to sort or group by. */
const nestedField = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || !(COLUMN_EXPRESSION in value)) {
    return true;
  }

  const { kind } = readColumn(value as SelectedColumn).node;

  return kind === "jsonRows" || kind === "jsonObject";
};

/**
 * The third argument of `orderBy`, `groupBy` and `having` callbacks: the
 * fields the projection callback returned, as the same expressions, so a
 * computed field is written once. Without new fields it is the selection the
 * query already has. Nested results and unknown names fail when they are read.
 */
const selectedFields = (
  projection: unknown,
  plan: SelectPlan,
): Record<string, unknown> => {
  const returned =
    projection && typeof projection === "object" && !Array.isArray(projection)
      ? (projection as Record<string, unknown>)
      : {};
  const fields: Record<string, unknown> = Object.keys(returned).length
    ? returned
    : Object.fromEntries(
        plan.selection.map((expression) => [
          expression.outputName,
          createExpression(expression),
        ]),
      );

  return new Proxy(fields, {
    get: (target, name) => {
      if (typeof name !== "string") {
        return Reflect.get(target, name);
      }

      if (!Object.hasOwn(target, name)) {
        throw new Error(
          `symmetria: "${name}" is not a selected field; the third callback argument holds the projection's fields: ${Object.keys(target).join(", ") || "none"}`,
        );
      }

      if (nestedField(target[name])) {
        throw new Error(
          `symmetria: selected field "${name}" is a nested result; orderBy, groupBy and having take scalar fields`,
        );
      }

      return target[name];
    },
  });
};

/** `{ state: "draft" }`, not a predicate, an ordering or any other handle. */
export const plainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype &&
  !Object.getOwnPropertySymbols(value).length;

/** A column of the source by key, for the object forms of `where` and `orderBy`. */
const sourceColumn = (
  columns: RuntimeScope[string],
  option: string,
  key: string,
): RuntimeScope[string][string] => {
  // An unknown key throws here, with the closest known name.
  const column = columns[key];

  if (!column || typeof column !== "object" || !(COLUMN_EXPRESSION in column)) {
    throw new Error(
      `symmetria: ${option}: "${key}" is a relation; the object form takes columns, use a callback for relation paths`,
    );
  }

  return column;
};

/**
 * `where: { state: "draft", editorId: null }`: every key equals its value,
 * `null` is IS NULL and `undefined` leaves the key out, as in query options.
 */
export const equalityPredicates = (
  columns: RuntimeScope[string],
  filter: Record<string, unknown>,
): ShapePredicate =>
  Object.entries(filter).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }

    const column = sourceColumn(columns, "where", key);

    if (
      Array.isArray(value) &&
      !/(?:\[\]|^jsonb?)$/.test(expressionSqlType(readColumn(column))) &&
      !isVectorType(expressionSqlType(readColumn(column)))
    ) {
      throw new Error(
        `symmetria: where: "${key}" takes one value; write a list as a callback, ${key}.in([...])`,
      );
    }

    return [column.is(value as never)];
  }) as unknown as ShapePredicate;

/** `orderBy: { spent: "desc" }`: selected fields first, as ORDER BY reads output names, then source columns. */
const fieldOrdering = (
  columns: RuntimeScope[string],
  selected: () => object,
  fields: Record<string, unknown>,
): Ordering[] =>
  Object.entries(fields).flatMap(([key, direction]) => {
    if (direction === undefined) {
      return [];
    }

    const ascending = direction === "asc" || direction === "ascending";

    if (!ascending && direction !== "desc" && direction !== "descending") {
      throw new Error(
        `symmetria: orderBy: "${key}" must be "asc" or "desc" ("ascending" or "descending"), received ${JSON.stringify(direction) ?? String(direction)}`,
      );
    }

    const fieldsNow = selected() as Record<string, unknown>;
    const expression = (
      Object.hasOwn(fieldsNow, key)
        ? fieldsNow[key]
        : sourceColumn(columns, "orderBy", key)
    ) as RuntimeScope[string][string];

    return [ascending ? expression.ascending : expression.descending];
  });

const TOOL_STATE = Symbol("symmetria.shape.tools");
const TOOL_SELECTED = Symbol("symmetria.shape.selected");

type ToolState = {
  readonly context: QueryContext;
  columns: RuntimeScope[string] | undefined;
  active: boolean;
};

/** What a shape callback receives next to its columns; each tool is made when it is read. */
class ShapeTools {
  readonly [TOOL_STATE]: ToolState;
  /** Set while an option callback that takes the selected fields runs. */
  [TOOL_SELECTED]: (() => object) | undefined = undefined;

  constructor(state: ToolState) {
    this[TOOL_STATE] = state;
  }
}

const assertActive = (state: ToolState) => {
  if (!state.active || shapeFrame.bindings !== state.context.bindings) {
    throw new Error(
      "symmetria: local JOIN helpers and whereNotNull can only be used inside their shape callback",
    );
  }
};

const joinTool = (
  kind: "LEFT" | "INNER" | "AUTO" | "CROSS" | "FULL",
): PropertyDescriptor => ({
  enumerable: true,
  get(this: ShapeTools) {
    const state = this[TOOL_STATE];

    return (
      input: LocalJoinInput,
      condition?: (columns: RuntimeScope[string]) => ShapePredicate,
    ) => {
      assertActive(state);

      return localJoin(state.context, kind, input, condition);
    };
  },
});

Object.setPrototypeOf(ShapeTools.prototype, shapeExpressions);
Object.defineProperties(ShapeTools.prototype, {
  join: joinTool("AUTO"),
  innerJoin: joinTool("INNER"),
  leftJoin: joinTool("LEFT"),
  crossJoin: joinTool("CROSS"),
  // Not public: a full join makes the root nullable, which the types do not model.
  [FULL_JOIN]: joinTool("FULL"),
  whereNotNull: {
    enumerable: true,
    get(this: ShapeTools) {
      const state = this[TOOL_STATE];

      return (column: SelectedColumn): SelectedColumn => {
        assertActive(state);
        const { context } = state;
        const expression = readColumn(column);
        validateNode(expression.node, context.bindings());
        context.plan = freeze({
          ...context.plan,
          predicates: freeze([
            ...context.plan.predicates,
            freeze(notNullPredicate(expression)),
          ]),
        });

        return column;
      };
    },
  },
  // The source's own columns, for `{ ...row, extra }`; relations are not among them.
  row: {
    enumerable: true,
    get(this: ShapeTools) {
      return { ...this[TOOL_STATE].columns };
    },
  },
  // The selected fields under a name, for the option callbacks that take them.
  selected: {
    get(this: ShapeTools) {
      return this[TOOL_SELECTED]?.();
    },
  },
});
delete (ShapeTools.prototype as { constructor?: unknown }).constructor;
Object.freeze(ShapeTools.prototype);

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

  const toolState: ToolState = { context, columns: undefined, active: true };

  let result: Record<string, unknown>;
  let controls: [string, unknown][] | undefined;

  try {
    result = evaluateContext(context, () => {
      const columns = context.columns(binding);
      // Tools live only for these callbacks; each is made when it is read.
      const tools = new ShapeTools(toolState);
      toolState.columns = columns;
      const projection = callback(columns, tools as never);

      if (options !== undefined) {
        context.options = true;
        let fields: object | undefined;
        const selected = () =>
          (fields ??= selectedFields(projection, context.plan));
        controls = Object.entries(options).map(([name, value]) => {
          if (!queryOptionNames.has(name as keyof QueryOptions<never, never>)) {
            throw new Error(`symmetria: unknown query option "${name}"`);
          }

          let resolved = value;

          if (typeof value === "function") {
            if (selectedOptionNames.has(name)) {
              // The same fields under a name, next to the third argument.
              tools[TOOL_SELECTED] = selected;
              resolved = value(columns, tools, selected());
              tools[TOOL_SELECTED] = undefined;
            } else {
              resolved = value(columns, tools);
            }
          }

          if (name === "where" && plainRecord(resolved)) {
            return [name, equalityPredicates(columns, resolved)];
          }

          if (name === "orderBy") {
            const entries = Array.isArray(resolved) ? resolved : [resolved];

            if (entries.some(plainRecord)) {
              return [
                name,
                entries.flatMap((entry) =>
                  plainRecord(entry)
                    ? fieldOrdering(columns, selected, entry)
                    : [entry],
                ),
              ];
            }
          }

          return [name, resolved];
        });
      }

      return projection;
    });
  } finally {
    toolState.active = false;
    context.options = false;
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
          plan[clause] = freeze([
            ...plan[clause],
            ...readShapePredicates(value as ShapePredicate),
          ]);
        }

        break;
      }
      case "orderBy": {
        if (value !== undefined) {
          plan.ordering = freeze([
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
          plan.grouping = freeze([...plan.grouping, ...grouping]);
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

  return freeze(plan);
};
