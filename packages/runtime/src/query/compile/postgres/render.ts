/**
 * PostgreSQL renderer: dialect-specific SQL for casts, JSON aggregation, arrays and operators.
 */
import { freeze } from "../../plan/freeze";
import { sqlString } from "./search";
import type { PostgresRenderer, JsonObjectEntry } from "./types";

const jsonArray = (value: string): string =>
  `NULLIF((${value})::jsonb, 'null'::jsonb)`;

/**
 * Whether a document is a JSON array. has(), overlaps() and length() of SQL
 * NULL, JSON null, an object or a scalar are unknown, not an error: an error
 * would also stop a query whose other conditions decide the row first.
 */
const isJsonArray = (value: string): string =>
  `jsonb_typeof((${value})::jsonb) = 'array'`;

/**
 * length() without the array check, the form earlier versions sent: page
 * cursor fingerprints keep it, so cursors those versions issued stay valid.
 */
const arrayLength: PostgresRenderer["arrayLength"] = (value, json) =>
  json ? `jsonb_array_length(${jsonArray(value)})` : `cardinality(${value})`;

const jsonObjectWith =
  (keySql: (key: string) => string) =>
  (entries: readonly JsonObjectEntry[], jsonOutput: boolean): string => {
    const fields = entries.map(({ key, value }) => `${keySql(key)}, ${value}`);

    if (entries.length <= 50) {
      return `${jsonOutput ? "json_build_object" : "jsonb_build_object"}(${fields.join(", ")})`;
    }

    const chunks: string[] = [];

    for (let position = 0; position < entries.length; position += 50) {
      chunks.push(
        `jsonb_build_object(${fields.slice(position, position + 50).join(", ")})`,
      );
    }

    return `(${chunks.join(" || ")})${jsonOutput ? "::json" : ""}`;
  };

const jsonObject = jsonObjectWith(sqlString);

const MODIFIER = String.raw`\s*\(\s*\d+\s*(?:,\s*-?\d+\s*)?\)`;
const QUALIFIED = String.raw`((?:pg_catalog|"pg_catalog")\s*\.\s*)?`;
const ARRAY_SUFFIX = /(?:\s*\[\s*\d*\s*\])+$|\s+array(?:\s*\[\s*\d*\s*\])?$/i;
const ELEMENT_RULES: readonly (readonly [RegExp, string])[] = [
  // Plain `char` is char(1); bpchar is the same type without a length.
  [new RegExp(`^(?:char|character|bpchar)(?:${MODIFIER})?$`, "i"), "bpchar"],
  // `pg_catalog.char` is the one-byte "char", which takes no length.
  [new RegExp(`^${QUALIFIED}bpchar${MODIFIER}$`, "i"), "$1bpchar"],
  [
    new RegExp(
      `^${QUALIFIED}(varchar|character varying|char varying|numeric|decimal|dec|varbit|bit varying)${MODIFIER}$`,
      "i",
    ),
    "$1$2",
  ],
  // Plain `bit` is bit(1) too; the quoted name is the type without a length,
  // as `pg_catalog.bit` is.
  [new RegExp(`^bit(?:${MODIFIER})?$`, "i"), '"bit"'],
  [new RegExp(`^${QUALIFIED}bit${MODIFIER}$`, "i"), "$1bit"],
  // A quoted name is exactly that type: `"varchar"(5)`, `"bit"(3)`.
  [
    new RegExp(
      `^${QUALIFIED}("(?:bpchar|varchar|numeric|varbit|bit|timestamptz|timestamp|timetz|time)")${MODIFIER}$`,
    ),
    "$1$2",
  ],
  [
    new RegExp(
      `^${QUALIFIED}(timestamptz|timestamp|timetz|time)${MODIFIER}(\\s+with(?:out)?\\s+time\\s+zone)?$`,
      "i",
    ),
    "$1$2$3",
  ],
  // `interval day`, `interval(3)`: fields and precision cut the value too.
  [new RegExp(`^${QUALIFIED}interval\\b.+$`, "i"), "$1interval"],
];

const stripModifier = (type: string): string => {
  const suffix = ARRAY_SUFFIX.exec(type);
  const element = suffix ? type.slice(0, suffix.index).trim() : type.trim();

  for (const [rule, replacement] of ELEMENT_RULES) {
    if (rule.test(element)) {
      return `${element.replace(rule, replacement)}${suffix?.[0] ?? ""}`;
    }
  }

  return type;
};

const unconstrainedTypes = new Map<string, string>();

/**
 * An explicit cast to `varchar(5)`, `numeric(10,2)`, `timestamptz(0)`,
 * `bit(3)` or `interval day` silently cuts or rounds the value, so a bound
 * value compared with such a column would match rows it does not equal. Casts
 * state the type without its modifier, also as an array's element; assignment
 * to a column still applies the column's own length, scale and precision.
 * `char(5)` becomes `bpchar`, the same type without a length: plain `char`
 * would mean `char(1)` and cut the value to one character, as plain `bit`
 * means `bit(1)`.
 */
export const unconstrained = (type: string): string => {
  let stripped = unconstrainedTypes.get(type);

  if (stripped === undefined) {
    stripped = stripModifier(type);

    // Type names come from declarations; bound the map anyway.
    if (unconstrainedTypes.size < 1024) {
      unconstrainedTypes.set(type, stripped);
    }
  }

  return stripped;
};

/**
 * Casts that keep the modifiers of timestamps, times, intervals and bit
 * strings, the form earlier versions sent: a page cursor's fingerprint is the
 * text of its query's shape, so cursors those versions issued stay valid.
 */
const shapeUnconstrained = (type: string): string =>
  type
    .replace(/^(?:char|character|bpchar)\s*\([^)]*\)/i, "bpchar")
    .replace(/^(varchar|character varying|numeric|decimal)\s*\([^)]*\)/i, "$1");

const castWith =
  (strip: (type: string) => string): PostgresRenderer["cast"] =>
  (value, target) => {
    switch (target.kind) {
      case "parameter":
        return `${value}::text::${strip(target.type)}`;
      case "numeric":
        return `${value}::numeric`;
      case "text":
        return target.array ? `(${value})::text[]` : `(${value})::text`;
      case "typed":
        return `(${value})::${strip(target.type)}`;
    }
  };

/**
 * Whether a JSON array holds an element (or, with `overlap`, any element of
 * another): TRUE or FALSE, also for a document that is NULL. Queries guard it
 * with the array check below; page cursor fingerprints keep it bare, the form
 * earlier versions sent.
 */
const jsonHas: PostgresRenderer["jsonHas"] = (
  value,
  element,
  options,
  context,
) => {
  const array = jsonArray(value);
  const elementAlias = context.nestedAlias("__symmetria_element");
  const other = context.nestedAlias("__symmetria_element_other");

  if (options.overlap) {
    const operand = options.elementArray
      ? `to_jsonb(${options.operand})`
      : element;

    return `EXISTS (SELECT 1 FROM jsonb_array_elements(${array}) AS ${elementAlias}("value") CROSS JOIN jsonb_array_elements(${jsonArray(operand)}) AS ${other}("value") WHERE ${elementAlias}."value" = ${other}."value")`;
  }

  return `EXISTS (SELECT 1 FROM jsonb_array_elements(${array}) AS ${elementAlias}("value") WHERE ${elementAlias}."value" = COALESCE(${options.encoded ? element : `to_jsonb(${element})`}, 'null'::jsonb))`;
};

/** PostgreSQL SQL rendering, shared by every execution adapter. */
export const postgresRenderer: PostgresRenderer = {
  placeholder: (position) => `$${position}`,
  cast: castWith(unconstrained),
  limitOffset: (limit, offset) => [
    ...(limit === undefined ? [] : [`LIMIT ${limit}`]),
    ...(offset === undefined ? [] : [`OFFSET ${offset}`]),
  ],
  rowLock: (lock) =>
    `FOR ${lock.mode}${lock.of ? ` OF ${lock.of.join(", ")}` : ""}${lock.noWait ? " NOWAIT" : lock.skipLocked ? " SKIP LOCKED" : ""}`,
  textCast: { prefix: "", suffix: "::text" },
  jsonObject,
  jsonRows: (nested, many, jsonOutput, shape) => {
    const aggregate = jsonOutput ? "json_agg" : "jsonb_agg";
    const type = jsonOutput ? "json" : "jsonb";
    const alias = shape?.alias ?? '"__symmetria_row"';
    const row = shape?.fields
      ? jsonObject(shape.fields, jsonOutput)
      : `${jsonOutput ? "row_to_json" : "to_jsonb"}(${alias})`;

    return many
      ? `(SELECT COALESCE(${shape?.fields ? `${aggregate}(${row})` : `${aggregate}(${alias})`}, '[]'::${type}) FROM (${nested}) AS ${alias})`
      : `(SELECT ${row} FROM (${nested}) AS ${alias})`;
  },
  jsonPath: (value, path, options, context) =>
    `(${value} ${options.scalarType ? "#>>" : "#>"} ARRAY[${path.map((part) => `${context.parameter(String(part))}::text`).join(", ")}])${options.scalarType ? `::${options.scalarType}` : ""}`,
  arrayIndex: (value, position, context) => {
    const parameter = context.parameter(position);

    // Narrow only the guarded subscript; retain the source's aggregate semantics.
    return `(${value})[(CASE WHEN ${parameter}::bigint < cardinality(${value}) THEN array_lower(${value}, 1)::bigint + ${parameter}::bigint END)::integer]`;
  },
  arrayLength: (value, json) =>
    json
      ? `jsonb_array_length(CASE WHEN ${isJsonArray(value)} THEN (${value})::jsonb END)`
      : `cardinality(${value})`,
  // NULL for a document that is not a JSON array (SQL NULL, JSON null, an
  // object or a scalar), as `= ANY()` of a NULL array is: not() of it holds
  // for neither.
  jsonHas: (value, element, options, context) =>
    `(CASE WHEN ${isJsonArray(value)} THEN ${jsonHas(value, element, options, context)} END)`,
  arrayHas: (value, element) => `${element} = ANY(${value})`,
  search: (vector, query) => `${vector} @@ ${query}`,
  recursiveUnion: (anchor, recursive, options) =>
    `(${anchor})\nUNION${options.unionAll ? " ALL" : ""}\n(${recursive})`,
  explain: (sql, analyze) => ({
    sql: `EXPLAIN (FORMAT JSON${analyze ? ", ANALYZE, BUFFERS" : ""}) ${sql}`,
    analyzed: analyze,
    plan: (rows) => {
      const value = rows[0]?.["QUERY PLAN"];
      const explanation: unknown =
        typeof value === "string" ? JSON.parse(value) : value;

      if (
        !Array.isArray(explanation) ||
        !explanation.length ||
        explanation.some(
          (entry) =>
            !entry || typeof entry !== "object" || Array.isArray(entry),
        )
      ) {
        throw new Error(
          "symmetria: EXPLAIN did not return a PostgreSQL JSON plan",
        );
      }

      return explanation as Record<string, unknown>[];
    },
  }),
  nullsDefault: (direction) => (direction === "ASC" ? "LAST" : "FIRST"),
};

freeze(postgresRenderer.textCast);
freeze(postgresRenderer);

/**
 * The renderer of a page cursor's fingerprint, never executed: casts, JSON
 * has() and length(), nested-object keys and nested rows in the form earlier
 * versions sent, so cursors those versions issued stay valid. A key is a
 * plain `'…'` literal, also with a backslash (queries write `E'…'`), and
 * nested rows always read `"__symmetria_row"` whole, also for a field of that
 * name or a long key (queries rebuild such rows).
 */
export const shapeRenderer: PostgresRenderer = freeze({
  ...postgresRenderer,
  cast: castWith(shapeUnconstrained),
  arrayLength,
  jsonHas,
  jsonObject: jsonObjectWith((key) => `'${key.replaceAll("'", "''")}'`),
  jsonRows: (nested, many, jsonOutput) =>
    postgresRenderer.jsonRows(nested, many, jsonOutput),
});
