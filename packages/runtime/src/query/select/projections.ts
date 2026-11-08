/**
 * Reusable RETURNING projections shared between read queries and writes.
 */
import {
  COLUMN_EXPRESSION,
  readColumn,
  and,
  or,
  not,
  when,
  exists,
  notExists,
  count,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  sql,
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  over,
} from "../expressions";
import type { TableSnapshot } from "../../schema/assembly";
import type { Projection, RuntimeScope } from ".";

export const SHAPE_SOURCE = Symbol("symmetria.query.shape");
export type ReusableShape<TableName extends string, Selection> = {
  readonly [SHAPE_SOURCE]: {
    readonly table: TableName;
    readonly selection: Selection;
  };
};

export const shapeExpressions = Object.freeze({
  and,
  or,
  not,
  when,
  exists,
  notExists,
  count,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  sql,
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  over,
});

/** The scalar tools a RETURNING callback receives: aggregates, windows and subqueries cannot appear there. */
export const returningTools = Object.freeze({
  and,
  or,
  not,
  when,
  coalesce,
  sql,
});
export type ReturningTools = typeof returningTools;

/** Reusable write projections share scalar SQL tools, table identity and codecs. */
export const returningProjection = (
  selector: (row: RuntimeScope[string], tools?: object) => Projection,
  row: RuntimeScope[string],
  table: TableSnapshot,
): Projection => {
  if (!(SHAPE_SOURCE in selector)) {
    return selector(row, returningTools);
  }

  if (selector[SHAPE_SOURCE] !== table) {
    throw new Error("symmetria: reusable shape belongs to another table");
  }

  const unsupported = () => {
    throw new Error(
      "symmetria: RETURNING shapes require row-local expressions without relations, aggregates, windows or query options",
    );
  };

  const result = selector(
    new Proxy(row, {
      get: (target, name) => {
        if (
          !Object.hasOwn(target, name) &&
          table.relations.some((relation) => relation.name === name)
        ) {
          return unsupported();
        }

        return Reflect.get(target, name);
      },
    }),
    {
      ...shapeExpressions,
      join: unsupported,
      innerJoin: unsupported,
      leftJoin: unsupported,
      crossJoin: unsupported,
      whereNotNull: unsupported,
    },
  );

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    ("then" in result && typeof result.then === "function") ||
    !Object.keys(result).length
  ) {
    throw new Error(
      "symmetria: shape() requires a synchronous object projection",
    );
  }

  const validateNode = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    if ("kind" in value) {
      if (["column", "parameter", "placeholder"].includes(String(value.kind))) {
        return;
      }

      if (
        [
          "aggregate",
          "window",
          "relativeWindow",
          "subquery",
          "rowCount",
          "jsonRows",
          "exists",
        ].includes(String(value.kind))
      ) {
        unsupported();
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "codec") {
        validateNode(child);
      }
    }
  };

  const validateFields = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (COLUMN_EXPRESSION in value) {
      validateNode(readColumn(value as never).node);

      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("$")) {
        unsupported();
      }

      validateFields(child);
    }
  };

  validateFields(result);

  return result;
};
