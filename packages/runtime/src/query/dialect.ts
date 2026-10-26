/**
 * SQL dialect helpers. PostgreSQL is the primary target; the SQLite dialect
 * (bun:sqlite) reuses the same plans with different placeholders, JSON functions,
 * default expressions and result value conversions.
 */
import { bigintCodec, type RuntimeCodec } from "./codecs";
import type { ExpressionDescription, ValueNode } from "./expressions";
import type { ColumnSnapshot } from "../schema/assembly";
import type { Dialect, MutationPlan, SelectPlan } from "./state";
import { expressionSqlType } from "./metadata";

export const planDialect = (plan: SelectPlan | MutationPlan): Dialect =>
  plan.root.dialect ?? "postgres";

/** `$."key"[0]` paths for SQLite's `->` operator. */
export const sqliteJsonPath = (path: readonly (string | number)[]): string =>
  `$${path
    .map((part) =>
      typeof part === "number" ? `[${part}]` : `.${JSON.stringify(part)}`,
    )
    .join("")}`;

export const SQLITE_UUID_SQL =
  "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";
export const SQLITE_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const baseType = (sqlType: string): string =>
  sqlType
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .trim();

const INTEGER_TYPES = new Set(["integer", "int", "int4", "smallint", "int2"]);

/** The declared scale of `numeric(p, s)` / `decimal(p, s)`; undefined without one. */
export const numericScale = (sqlType: string): number | undefined => {
  const match = /^(?:numeric|decimal)\(\d+,\s*(\d+)\)$/.exec(sqlType);

  return match ? Number(match[1]) : undefined;
};

/**
 * A plain decimal string rounded half away from zero to `scale` fractional
 * digits, as PostgreSQL stores it. Other text is returned unchanged.
 */
export const scaledDecimal = (text: string, scale: number): string => {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);

  if (!match) {
    return text;
  }

  const sign = match[1] === "-" ? "-" : "";
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction.slice(0, scale).padEnd(scale, "0")}`;

  if (fraction.length > scale && fraction.charCodeAt(scale) >= 53) {
    digits = (BigInt(digits) + 1n).toString().padStart(digits.length, "0");
  }

  const whole =
    digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, "") || "0";
  const value = scale ? `${whole}.${digits.slice(-scale)}` : whole;

  return sign && /[1-9]/.test(value) ? `${sign}${value}` : value;
};

const REAL_TYPES = new Set(["real", "double precision", "float4", "float8"]);

/** SQLite storage class for a PostgreSQL column type. */
export const sqliteColumnType = (
  sqlType: string,
): "INTEGER" | "REAL" | "TEXT" => {
  const type = baseType(sqlType);

  if (
    INTEGER_TYPES.has(type) ||
    ["bigint", "int8", "boolean", "bool"].includes(type)
  ) {
    return "INTEGER";
  }

  return REAL_TYPES.has(type) ? "REAL" : "TEXT";
};

export const isJsonType = (sqlType: string): boolean =>
  ["json", "jsonb"].includes(baseType(sqlType));

/**
 * SQLite has no DEFAULT keyword in VALUES, so omitted columns receive their
 * declared default expression; identity columns fall back to the rowid.
 */
export const sqliteDefaultSQL = (
  column: ColumnSnapshot,
  literal: (value: unknown) => string,
): string => {
  const fallback = column.default;

  if (!fallback) {
    return "NULL";
  }

  if (fallback.kind === "value") {
    return literal(fallback.value);
  }

  switch (fallback.sql) {
    case "identity":
      return "NULL";
    case "now()":
      return `(${SQLITE_NOW_SQL})`;
    case "gen_random_uuid()":
    case "uuidv7()":
      return `(${SQLITE_UUID_SQL})`;
    default:
      return `(${fallback.sql})`;
  }
};

/** Literal rendering for SQLite DDL defaults. */
export const sqliteLiteral = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : JSON.stringify(value);

  return `'${text.replaceAll("'", "''")}'`;
};

/** PostgreSQL array literal for array parameters: `{"a","b"}` with NULL elements. */
export const postgresArrayLiteral = (values: readonly unknown[]): string =>
  `{${values
    .map((value) => {
      if (value === null || value === undefined) {
        return "NULL";
      }

      const text =
        value instanceof Date
          ? value.toISOString()
          : typeof value === "boolean"
            ? value
              ? "t"
              : "f"
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);

      return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join(",")}}`;

/** bun:sqlite binds numbers, strings, bigints, blobs and null; everything else is converted. */
export const sqliteParameter = (value: unknown): unknown => {
  if (value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array)
  ) {
    return JSON.stringify(value);
  }

  return value;
};

type ValueKind =
  | "boolean"
  | "json"
  | "jsonObject"
  | "jsonRows"
  | "integer"
  | "bigint"
  | "count"
  | "other";

const valueKind = (node: ValueNode, codec?: RuntimeCodec): ValueKind => {
  if (codec?.parameterCast?.endsWith("[]")) {
    return "json";
  }

  switch (node.kind) {
    case "column": {
      const source =
        node.description.binding.projection?.[node.description.column.name];

      if (source) {
        return valueKind(source.node, source.codec);
      }

      const type = baseType(node.description.column.sqlType);

      if (type === "boolean" || type === "bool") {
        return "boolean";
      }

      if (type === "json" || type === "jsonb" || type.endsWith("[]")) {
        return "json";
      }

      if (INTEGER_TYPES.has(type)) {
        return "integer";
      }

      return type === "bigint" || type === "int8" ? "bigint" : "other";
    }
    case "binary":
      return valueKind(node.left, codec);
    case "aggregate":
      if (node.name === "COUNT") {
        return "count";
      }

      return node.value && (node.name === "MIN" || node.name === "MAX")
        ? valueKind(node.value, codec)
        : "other";
    case "coalesce":
      return node.values[0] ? valueKind(node.values[0], codec) : "other";
    case "window":
      return valueKind(node.expression, codec);
    case "relativeWindow":
      return valueKind(node.value, codec);
    case "subquery": {
      const first = node.query.selection[0];

      return first ? valueKind(first.node, first.codec) : "other";
    }
    case "rowCount":
      return "count";
    case "jsonObject":
      return "jsonObject";
    case "jsonRows":
      return "jsonRows";
    case "case":
    case "arrayIndex":
    case "jsonPath": {
      const type = baseType(
        expressionSqlType({
          node,
          outputName: "value",
          ...(codec ? { codec } : {}),
        }),
      );

      return type === "boolean" || type === "bool"
        ? "boolean"
        : INTEGER_TYPES.has(type)
          ? "integer"
          : type === "bigint"
            ? "bigint"
            : type === "json" || type === "jsonb"
              ? "json"
              : "other";
    }
    case "arrayLength":
      return "integer";
    default:
      return codec === bigintCodec ? "bigint" : "other";
  }
};

export const isJsonExpression = (expression: ExpressionDescription): boolean =>
  ["json", "jsonObject", "jsonRows"].includes(
    valueKind(expression.node, expression.codec),
  );

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

/**
 * SQLite returns integers as bigint (safeIntegers), booleans as 0/1 and JSON as
 * text. Convert them into the shapes PostgreSQL drivers deliver before codecs run.
 */
export const sqliteRowConverter = (
  selection: readonly ExpressionDescription[],
  nested = false,
): ((row: Record<string, unknown>) => Record<string, unknown>) => {
  const converter = (
    expression: ExpressionDescription,
  ): ((value: unknown) => unknown) => {
    const node = expression.node;

    if (node.kind === "jsonPath" && node.target) {
      return converter(node.target);
    }

    if (node.kind === "column") {
      const { binding, column } = node.description;
      const source = binding.projection?.[column.name];

      if (source) {
        return converter(source);
      }
    }

    const source =
      node.kind === "window"
        ? node.expression
        : node.kind === "relativeWindow"
          ? node.value
          : node.kind === "coalesce"
            ? node.values[0]
            : node.kind === "binary"
              ? node.left
              : node.kind === "aggregate" &&
                  (node.name === "MIN" || node.name === "MAX")
                ? node.value
                : undefined;

    if (source) {
      return converter({ ...expression, node: source });
    }

    if (node.kind === "subquery" && node.query.selection[0]) {
      return converter(node.query.selection[0]);
    }

    const parse = nested ? (value: unknown) => value : parseJson;

    switch (valueKind(node, expression.codec)) {
      case "boolean":
        return (value) => value === 1 || value === 1n || value === true;
      case "json": {
        // Array codecs serialize JSON elements separately before the SQLite driver
        // serializes their container. Match PostgreSQL's decoded element values.
        if (isJsonType(expression.codec?.element?.parameterCast ?? "")) {
          return (value) => {
            const parsed = parse(value);

            return Array.isArray(parsed) ? parsed.map(parseJson) : parsed;
          };
        }

        return parse;
      }
      case "jsonObject": {
        const convert = sqliteRowConverter(
          (node as Extract<ValueNode, { kind: "jsonObject" }>).selection,
          true,
        );

        return (value) => convert(parse(value) as Record<string, unknown>);
      }
      case "jsonRows": {
        const rows = node as Extract<ValueNode, { kind: "jsonRows" }>;
        const convert = sqliteRowConverter(rows.query.selection, true);

        return rows.many
          ? (value) => (parse(value) as Record<string, unknown>[]).map(convert)
          : (value) => convert(parse(value) as Record<string, unknown>);
      }
      case "bigint":
      case "count":
        return (value) => value;
      case "integer":
        return (value) => (typeof value === "bigint" ? Number(value) : value);
      default: {
        // numeric(p, s) text keeps whatever was written; PostgreSQL rounds to the
        // scale, and SUM keeps its input's scale.
        const scale = numericScale(
          expressionSqlType(
            node.kind === "aggregate" && node.name === "SUM" && node.value
              ? { ...expression, node: node.value }
              : expression,
          ),
        );

        if (scale !== undefined) {
          return (value) => scaledDecimal(String(value), scale);
        }

        return (value) =>
          typeof value === "bigint" && Number.isSafeInteger(Number(value))
            ? Number(value)
            : value;
      }
    }
  };

  const conversions = selection.map((expression) => ({
    name: expression.outputName,
    convert: converter(expression),
  }));

  return (row) =>
    Object.fromEntries(
      conversions.map(({ name, convert }) => {
        const value = row[name];

        return [name, value == null ? value : convert(value)];
      }),
    );
};
