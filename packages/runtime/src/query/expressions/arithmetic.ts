/**
 * Arithmetic between columns and literals, with PostgreSQL's numeric promotion and exact decimals.
 */
import { freeze } from "../plan/freeze";
import {
  bigintCodec,
  countCodec,
  codecFor,
  numericCodec,
  encodeValue,
  cloneParameter,
  type RuntimeCodec,
} from "../codecs";
import { valueSqlType } from "../plan/metadata";
import {
  COLUMN_EXPRESSION,
  type ValueNode,
  type ExpressionDescription,
  type SelectedColumn,
} from "./nodes";
import type { QueryColumn } from "./column-types";
import { readColumn, createExpression } from "./core";

export type NumericClass = "decimal" | "bigint" | "float" | "integer";

export const castNode = (node: ValueNode, sqlType: string): ValueNode =>
  freeze({ kind: "raw", parts: freeze(["(", node, `)::${sqlType}`]), sqlType });

/** Types that read as strings but are not text: an enum, uuid, date, time, interval or network address. */
const STRING_VALUED =
  /^(?:enum|uuid|date|time|timetz|timestamp|timestamptz|interval|inet|cidr|macaddr8?)(?:\(|\s|$)/;
const TEXT_TYPE =
  /^(?:text|varchar|character varying|char|character|bpchar|citext|name)(?:\(|$)/;

export const isTextType = (sqlType: string): boolean => TEXT_TYPE.test(sqlType);

/** Whether an expression reads as a string without being text. */
export const readsAsString = (description: ExpressionDescription): boolean =>
  STRING_VALUED.test(valueSqlType(description));

/**
 * The expression as text, for what PostgreSQL defines on text only: LIKE,
 * full-text search, a comparison with a text column. An enum, uuid or date
 * has no such operator; as text it matches what its string reads.
 */
export const asText = (
  description: ExpressionDescription,
): ExpressionDescription => {
  if (!readsAsString(description)) {
    return description;
  }

  const { codec: _codec, ...rest } = description;

  return { ...rest, node: castNode(description.node, "text") };
};

/** A json/jsonb expression, such as a jsonb column or a path that does not reach a typed field. */
export const isJsonValue = (description: ExpressionDescription): boolean => {
  const sqlType = valueSqlType(description);

  return sqlType === "json" || sqlType === "jsonb";
};

/**
 * Whether a value was reached with `path()`, into a nested result or an array
 * (also aggregated, coalesced, windowed or selected through a derived table).
 */
export const readByPath = (node: ValueNode): boolean => {
  switch (node.kind) {
    case "jsonPath":
    case "arrayIndex":
      return true;
    case "column": {
      const source =
        node.description.binding.projection?.[node.description.column.name];

      return !!source && readByPath(source.node);
    }
    case "subquery":
      return (
        !!node.query.selection[0] && readByPath(node.query.selection[0].node)
      );
    case "window":
      return readByPath(node.expression);
    case "relativeWindow":
      return readByPath(node.value);
    case "coalesce":
      return !!node.values[0] && readByPath(node.values[0]);
    case "aggregate":
      return (
        (node.name === "MIN" || node.name === "MAX") &&
        !!node.value &&
        readByPath(node.value)
      );
    // An allow-list of the kinds a path value passes through unchanged.
    default:
      return false;
  }
};

/**
 * How PostgreSQL computes an operand, from its SQL type or codec, as
 * `NumericKind` types it: a JSON value, and a number reached with `path()`,
 * computes as double precision, the type of a JavaScript number; `count()` and
 * the ranking functions are integers, read as numbers.
 */
export const numericClass = (
  expression: ExpressionDescription,
): NumericClass => {
  if (isJsonValue(expression)) {
    return "float";
  }

  const sqlType = valueSqlType(expression);

  if (expression.codec === numericCodec || sqlType.startsWith("numeric")) {
    return "decimal";
  }

  if (expression.codec === countCodec) {
    return "integer";
  }

  if (expression.codec === bigintCodec || sqlType === "bigint") {
    return "bigint";
  }

  return sqlType === "real" ||
    sqlType === "double precision" ||
    readByPath(expression.node)
    ? "float"
    : "integer";
};

/**
 * PostgreSQL has no LIKE, arithmetic or SUM over jsonb, so a JSON value enters
 * them as its text (`#>> '{}'`: a string's characters, a number's digits),
 * cast to a SQL number when given. Other expressions pass through unchanged.
 */
export const jsonScalar = (
  description: ExpressionDescription,
  sqlType?: "double precision" | "numeric",
): ExpressionDescription => {
  if (!isJsonValue(description)) {
    return description;
  }

  const text: ValueNode = freeze({
    kind: "raw",
    parts: freeze(["(", description.node, " #>> '{}')"]),
    sqlType: "text",
  });

  return {
    outputName: description.outputName,
    node: sqlType ? castNode(text, sqlType) : text,
  };
};

export const decimalCodec: RuntimeCodec = freeze({
  ...numericCodec,
  sqlType: "numeric",
});

/** One side of an arithmetic operation: its class and the SQL type it has. */
export type ArithmeticSide = {
  readonly kind: NumericClass;
  readonly sqlType: string;
} & (
  | { readonly expression: ExpressionDescription }
  | { readonly literal: unknown; readonly cast?: string }
);

/** SQL types without arithmetic, whose values the types never offer it for: text, enums, dates, arrays, … */
export const NOT_NUMERIC =
  /^(text|varchar|char|enum|uuid|boolean|date|time|timestamp|timestamptz|interval|bytea|inet|tsvector|vector|halfvec)(\(|$)|\[\]$/;

/** A column or expression operand; raw SQL of unknown type cannot be typed. */
export const expressionSide = (
  description: ExpressionDescription,
): ArithmeticSide => {
  const sqlType = valueSqlType(description);

  if (NOT_NUMERIC.test(sqlType)) {
    throw new Error(
      `symmetria: arithmetic needs a number, bigint or numeric value, not ${sqlType}`,
    );
  }

  if (sqlType === "derived") {
    // Ranking functions are bigint in SQL and read as numbers, like count().
    if (description.codec === countCodec) {
      return { kind: "integer", sqlType: "bigint", expression: description };
    }

    throw new Error(
      "symmetria: arithmetic needs expressions of a known SQL type; write raw SQL as sql.of(column)`…`, such as sql.of(int)`…`",
    );
  }

  return { kind: numericClass(description), sqlType, expression: description };
};

/**
 * A JavaScript operand. Decimal text is a decimal and a bigint a bigint; a
 * number takes the other side's class, so next to an integer or bigint column
 * it must be an integer in range (a value error otherwise, as their codecs
 * report) and a fraction is written as decimal text: `quantity.multiply("1.5")`.
 * Like a SQL integer literal, a number next to a smallint is an integer.
 */
export const literalSide = (
  value: unknown,
  left: ArithmeticSide,
): ArithmeticSide => {
  if (typeof value === "string") {
    return {
      kind: "decimal",
      sqlType: "numeric",
      literal: encodeValue(value, numericCodec),
      cast: "numeric",
    };
  }

  if (typeof value === "bigint") {
    return {
      kind: "bigint",
      sqlType: "bigint",
      literal: encodeValue(value, bigintCodec),
      ...(left.sqlType === "bigint" ? {} : { cast: "bigint" }),
    };
  }

  if (typeof value !== "number") {
    throw new Error(
      "symmetria: arithmetic operands are numbers, bigints, decimal strings or numeric columns",
    );
  }

  if (left.kind === "decimal") {
    return {
      kind: "decimal",
      sqlType: "numeric",
      literal: String(value),
      cast: "numeric",
    };
  }

  if (left.kind === "float") {
    return {
      kind: "float",
      sqlType: "double precision",
      literal: value,
      cast: "double precision",
    };
  }

  // Next to a bigint, or a count() that is bigint in SQL, any safe integer fits.
  return left.kind === "bigint" || left.sqlType === "bigint"
    ? {
        kind: left.kind,
        sqlType: "bigint",
        literal: encodeValue(value, bigintCodec),
      }
    : {
        kind: "integer",
        sqlType: "integer",
        literal: encodeValue(value, codecFor("integer")),
        ...(left.sqlType === "smallint" ? { cast: "integer" } : {}),
      };
};

export const RESULT_TYPES: Readonly<Record<NumericClass, string>> = {
  decimal: "numeric",
  float: "double precision",
  bigint: "bigint",
  integer: "integer",
};

/** An operand as the result's SQL type: decimals and floats cast the other side explicitly. */
export const operandNode = (
  side: ArithmeticSide,
  result: NumericClass,
): ValueNode => {
  if ("literal" in side) {
    const cast =
      result === "decimal" || result === "float"
        ? RESULT_TYPES[result]
        : side.cast;

    return freeze({
      kind: "parameter",
      value: cloneParameter(side.literal),
      ...(cast ? { cast } : {}),
    });
  }

  const { expression } = side;

  if (isJsonValue(expression)) {
    return jsonScalar(
      expression,
      result === "decimal" ? "numeric" : "double precision",
    ).node;
  }

  const converted =
    result === "decimal"
      ? side.kind === "decimal"
      : result === "float"
        ? side.sqlType === "double precision"
        : true;

  return converted
    ? expression.node
    : castNode(expression.node, RESULT_TYPES[result]);
};

export type ArithmeticOperator = "+" | "-" | "*" | "/" | "quotient";

/**
 * `left <operator> right` with PostgreSQL's numeric promotion made explicit,
 * as `ArithmeticColumn` types it: a decimal operand makes the result numeric,
 * then a float double precision, then a bigint bigint. Division never
 * truncates: integers and bigints divide as numeric. `quotient` divides
 * toward zero in the integer type, with `div()` for decimals and `trunc()` for
 * floats. A JSON value computes as double precision, the type of a
 * JavaScript number.
 */
export const arithmetic = (
  source: ExpressionDescription,
  operator: ArithmeticOperator,
  value: unknown,
): QueryColumn<unknown, string> => {
  if (value === undefined || value === null) {
    throw new Error(
      "symmetria: arithmetic needs a value; use coalesce() for NULL operands",
    );
  }

  const left = expressionSide(source);
  const right =
    typeof value === "object" && COLUMN_EXPRESSION in value
      ? expressionSide(readColumn(value as SelectedColumn))
      : literalSide(value, left);
  const sides = [left.kind, right.kind];
  const promoted: NumericClass = sides.includes("decimal")
    ? "decimal"
    : sides.includes("float")
      ? "float"
      : sides.includes("bigint")
        ? "bigint"
        : "integer";
  const result: NumericClass =
    operator === "/" && (promoted === "bigint" || promoted === "integer")
      ? "decimal"
      : promoted;
  // Integers keep PostgreSQL's width: smallint with smallint, bigint for count().
  const integerType =
    left.sqlType === "bigint" || right.sqlType === "bigint"
      ? "bigint"
      : left.sqlType === "smallint" && right.sqlType === "smallint"
        ? "smallint"
        : "integer";
  const sqlType = result === "integer" ? integerType : RESULT_TYPES[result];
  const leftNode = operandNode(left, result);
  const rightNode = operandNode(right, result);
  const quotient = operator === "quotient";
  const division: ValueNode = freeze({
    kind: "binary",
    left: leftNode,
    operator: quotient ? "/" : operator,
    right: rightNode,
    sqlType,
  });
  const node: ValueNode = !quotient
    ? division
    : result === "decimal"
      ? freeze({
          kind: "raw",
          parts: freeze(["div(", leftNode, ", ", rightNode, ")"]),
          sqlType,
        })
      : result === "float"
        ? freeze({ kind: "raw", parts: freeze(["trunc", division]), sqlType })
        : division;

  return createExpression({
    outputName: source.outputName,
    node,
    codec:
      result === "decimal"
        ? decimalCodec
        : result === "bigint"
          ? bigintCodec
          : result === "float"
            ? codecFor("double precision")!
            : integerType === "bigint"
              ? countCodec
              : codecFor(integerType)!,
  });
};
