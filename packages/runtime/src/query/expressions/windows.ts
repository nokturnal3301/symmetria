/**
 * Window functions: `over()`, row numbering, ranks, `lag` and `lead`.
 */
import { freeze } from "../plan/freeze";
import { countCodec } from "../codecs";
import {
  COLUMN_EXPRESSION,
  ORDERING_EXPRESSION,
  type TraitsOf,
  type ExpressionDescription,
  type SelectedColumn,
  type ExpressionValue,
  type Ordering,
} from "./nodes";
import type { Literal, StoredOf, QueryColumn } from "./column-types";
import { ColumnHandle, readColumn, valueNode, createExpression } from "./core";

export type WindowBoundary =
  | "unbounded preceding"
  | "current row"
  | "unbounded following"
  | { readonly preceding: number }
  | { readonly following: number };

export type WindowOptions = {
  readonly partitionBy?: readonly SelectedColumn[];
  readonly orderBy?: Ordering | readonly Ordering[];
  readonly rows?: readonly [WindowBoundary, WindowBoundary];
};

export type WindowExpression<
  Value,
  Name extends string,
  Traits = {},
> = QueryColumn<Value, Name, Traits> & {
  readonly over: (options?: WindowOptions) => QueryColumn<Value, Name, Traits>;
};

/** The output name of a selected column or expression. */
export type OutputNameOf<Expression extends SelectedColumn> =
  Expression[typeof COLUMN_EXPRESSION]["outputName"];

export const over = <Expression extends SelectedColumn>(
  expression: Expression,
  options: WindowOptions = {},
): QueryColumn<
  ExpressionValue<Expression>,
  OutputNameOf<Expression>,
  TraitsOf<Expression>
> => {
  for (const key of Object.keys(options)) {
    if (key !== "partitionBy" && key !== "orderBy" && key !== "rows") {
      throw new Error(
        `symmetria: over() takes partitionBy, orderBy and rows, not "${key}"`,
      );
    }
  }

  if (
    options.partitionBy !== undefined &&
    !Array.isArray(options.partitionBy)
  ) {
    throw new Error(
      "symmetria: over() partitionBy is a list, such as [post.authorId]",
    );
  }

  const description = readColumn(expression);
  const ordering = options.orderBy
    ? Array.isArray(options.orderBy)
      ? options.orderBy
      : [options.orderBy]
    : [];

  const boundary = (value: WindowBoundary): WindowBoundary => {
    if (typeof value === "string") {
      if (
        !["unbounded preceding", "current row", "unbounded following"].includes(
          value,
        )
      ) {
        throw new Error("symmetria: invalid window frame boundary");
      }

      return value;
    }

    const names = Object.keys(value);
    const offset = "preceding" in value ? value.preceding : value.following;

    if (
      names.length !== 1 ||
      !["preceding", "following"].includes(names[0]!) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new Error(
        "symmetria: window frame offsets must be nonnegative safe integers",
      );
    }

    return freeze({ ...value });
  };

  const rows = options.rows?.map(boundary) as
    | readonly [WindowBoundary, WindowBoundary]
    | undefined;

  if (
    rows &&
    (rows.length !== 2 ||
      rows[0] === "unbounded following" ||
      rows[1] === "unbounded preceding")
  ) {
    throw new Error("symmetria: invalid window frame bounds");
  }

  return createExpression({
    ...description,
    outputName: expression[COLUMN_EXPRESSION].outputName,
    node: freeze({
      kind: "window",
      expression: description.node,
      partitionBy: freeze(
        (options.partitionBy ?? []).map((column) => readColumn(column).node),
      ),
      orderBy: freeze(
        ordering.map((entry: Ordering) => {
          if (!entry || !(ORDERING_EXPRESSION in entry)) {
            throw new Error(
              "symmetria: window orderBy requires ordering expressions",
            );
          }

          return entry[ORDERING_EXPRESSION];
        }),
      ),
      ...(rows ? { rows: freeze(rows) } : {}),
    }),
  });
};

/**
 * A column handle whose `over()` lives on its prototype, so an aggregate costs
 * one object. Created on first use: this module and `core` import each other.
 */
let WindowHandle:
  | (new (
      description: ExpressionDescription,
    ) => ColumnHandle)
  | undefined;

const windowHandle = () =>
  (WindowHandle ??= class extends ColumnHandle {
    over(options?: WindowOptions) {
      return over(this as unknown as SelectedColumn, options);
    }
  });

/** An expression that can become a window: the ranking functions and the aggregates. */
export const windowExpression = <Value, Name extends string, Traits = {}>(
  description: ExpressionDescription<Name>,
): WindowExpression<Value, Name, Traits> =>
  freeze(new (windowHandle())(description)) as unknown as WindowExpression<
    Value,
    Name,
    Traits
  >;

export const windowFunction = <Value, Name extends string, Traits = {}>(
  expression: QueryColumn<Value, Name, Traits>,
): WindowExpression<Value, Name, Traits> =>
  windowExpression(
    readColumn(expression) as unknown as ExpressionDescription<Name>,
  );

export const rowNumber = (): WindowExpression<number, "rowNumber"> =>
  windowFunction(
    createExpression({
      node: { kind: "raw", parts: ["ROW_NUMBER()"] },
      outputName: "rowNumber",
      codec: countCodec,
    }),
  );

export const rank = (): WindowExpression<number, "rank"> =>
  windowFunction(
    createExpression({
      node: { kind: "raw", parts: ["RANK()"] },
      outputName: "rank",
      codec: countCodec,
    }),
  );

export const denseRank = (): WindowExpression<number, "denseRank"> =>
  windowFunction(
    createExpression({
      node: { kind: "raw", parts: ["DENSE_RANK()"] },
      outputName: "denseRank",
      codec: countCodec,
    }),
  );

export const relativeWindow = <
  Expression extends SelectedColumn,
  Name extends "lag" | "lead",
>(
  name: Name,
  expression: Expression,
  offset: number,
  fallback: unknown,
): WindowExpression<
  ExpressionValue<Expression> | null,
  Name,
  TraitsOf<Expression>
> => {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(
      "symmetria: lag/lead offset must be a nonnegative safe integer",
    );
  }

  const description = readColumn(expression);

  return windowFunction(
    createExpression({
      ...description,
      outputName: name,
      node: {
        kind: "relativeWindow",
        name,
        value: description.node,
        offset: valueNode(offset),
        ...(fallback === undefined
          ? {}
          : { fallback: valueNode(fallback, description.codec) }),
      },
    }),
  );
};

/** The value of the row `offset` rows before; `fallback` (stored like the column) where there is none. */
export const lag = <Expression extends SelectedColumn>(
  expression: Expression,
  offset = 1,
  fallback?: Literal<StoredOf<Expression>>,
): WindowExpression<
  ExpressionValue<Expression> | null,
  "lag",
  TraitsOf<Expression>
> => relativeWindow("lag", expression, offset, fallback);

/** The value of the row `offset` rows after; `fallback` (stored like the column) where there is none. */
export const lead = <Expression extends SelectedColumn>(
  expression: Expression,
  offset = 1,
  fallback?: Literal<StoredOf<Expression>>,
): WindowExpression<
  ExpressionValue<Expression> | null,
  "lead",
  TraitsOf<Expression>
> => relativeWindow("lead", expression, offset, fallback);
