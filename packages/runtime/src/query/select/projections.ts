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
  dateTrunc,
  sql,
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  over,
  type ValueNode,
} from "../expressions";
import { childNodes } from "../plan/traverse";
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
  dateTrunc,
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
  dateTrunc,
  sql,
});
export type ReturningTools = typeof returningTools;

/** Reusable write projections share scalar SQL tools, table identity and codecs. */
/**
 * The forms `returning()` takes besides a callback or a reusable shape: no
 * argument is the whole row, column names are those columns.
 */
export const returningSelector = (
  selector: unknown,
  names: readonly unknown[],
): unknown => {
  if (selector === undefined && !names.length) {
    return (row: RuntimeScope[string]) => ({ ...row });
  }

  if (typeof selector === "string") {
    const columns = [selector, ...names];

    if (columns.some((name) => typeof name !== "string")) {
      throw new Error("symmetria: returning() takes column names as strings");
    }

    return (row: RuntimeScope[string]) =>
      Object.fromEntries(columns.map((name) => [name, row[name as string]]));
  }

  if (names.length) {
    throw new Error(
      "symmetria: returning() takes column names, or one callback or shape",
    );
  }

  return selector;
};

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

  const validateNode = (node: ValueNode): void => {
    if (
      node.kind === "aggregate" ||
      node.kind === "window" ||
      node.kind === "relativeWindow" ||
      node.kind === "subquery" ||
      node.kind === "rowCount" ||
      node.kind === "jsonRows"
    ) {
      unsupported();
    }

    childNodes(node).forEach(validateNode);

    // The element a path reads is described by an expression of its own.
    if (node.kind === "jsonPath" && node.target) {
      validateNode(node.target.node);
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
