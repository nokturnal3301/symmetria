/**
 * PostgreSQL renderer: dialect-specific SQL for casts, JSON aggregation, arrays and operators.
 */
import { postgresArrayLiteral } from "./values";
import {
  searchHeadlineSql,
  searchRankSql,
  searchVectorSql,
  sqlString,
  tsquerySql,
  tsvectorSql,
} from "./search";
import type { PostgresRenderer, JsonObjectEntry } from "./types";

const jsonArray = (value: string): string =>
  `NULLIF((${value})::jsonb, 'null'::jsonb)`;

const jsonObject = (
  entries: readonly JsonObjectEntry[],
  jsonOutput: boolean,
): string => {
  const fields = entries.map(({ key, value }) => `${sqlString(key)}, ${value}`);

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

/** PostgreSQL SQL rendering, shared by every execution adapter. */
export const postgresRenderer: PostgresRenderer = {
  name: "postgres",
  placeholder: (position) => `$${position}`,
  cast: (value, target) => {
    switch (target.kind) {
      case "parameter":
        return `${value}::text::${target.type}`;
      case "numeric":
        return `${value}::numeric`;
      case "text":
        return target.array ? `(${value})::text[]` : `(${value})::text`;
      case "typed":
        return `(${value})::${target.type}`;
    }
  },
  comparisonOperator: (operator) => operator,
  limitOffset: (limit, offset) => [
    ...(limit === undefined ? [] : [`LIMIT ${limit}`]),
    ...(offset === undefined ? [] : [`OFFSET ${offset}`]),
  ],
  rowLock: (lock) =>
    `FOR ${lock.mode}${lock.of ? ` OF ${lock.of.join(", ")}` : ""}${lock.noWait ? " NOWAIT" : lock.skipLocked ? " SKIP LOCKED" : ""}`,
  textCast: { prefix: "", suffix: "::text" },
  jsonArray,
  jsonObject,
  jsonRows: (nested, many, jsonOutput) => {
    const aggregate = jsonOutput ? "json_agg" : "jsonb_agg";
    const row = jsonOutput ? "row_to_json" : "to_jsonb";
    const type = jsonOutput ? "json" : "jsonb";

    return many
      ? `(SELECT COALESCE(${aggregate}("__symmetria_row"), '[]'::${type}) FROM (${nested}) AS "__symmetria_row")`
      : `(SELECT ${row}("__symmetria_row") FROM (${nested}) AS "__symmetria_row")`;
  },
  jsonPath: (value, path, options, context) =>
    `(${value} ${options.scalarType ? "#>>" : "#>"} ARRAY[${path.map((part) => `${context.parameter(String(part))}::text`).join(", ")}])${options.scalarType ? `::${options.scalarType}` : ""}`,
  arrayIndex: (value, position, context) => {
    const parameter = context.parameter(position);

    // Narrow only the guarded subscript; retain the source's aggregate semantics.
    return `(${value})[(CASE WHEN ${parameter}::bigint < cardinality(${value}) THEN array_lower(${value}, 1)::bigint + ${parameter}::bigint END)::integer]`;
  },
  arrayLength: (value, json) =>
    json ? `jsonb_array_length(${jsonArray(value)})` : `cardinality(${value})`,
  jsonComparison: (left, right, operator) => `${left} ${operator} ${right}`,
  jsonMembership: (left, operand, negated) =>
    `${left} ${negated ? "NOT " : ""}IN (${operand.kind === "list" ? operand.values.join(", ") : operand.sql})`,
  jsonHas: (value, element, options, context) => {
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
  },
  arrayHas: (value, element) => `${element} = ANY(${value})`,
  searchVector: searchVectorSql,
  searchQuery: tsquerySql,
  search: (vector, query) => `${vector} @@ ${query}`,
  searchRank: searchRankSql,
  searchHeadline: searchHeadlineSql,
  searchDocument: tsvectorSql,
  recursiveUnion: (anchor, recursive, options) =>
    `(${anchor})\nUNION${options.unionAll ? " ALL" : ""}\n(${recursive})`,
  parameterValue: (value) =>
    Array.isArray(value) ? postgresArrayLiteral(value) : value,
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

Object.freeze(postgresRenderer.textCast);
Object.freeze(postgresRenderer);
