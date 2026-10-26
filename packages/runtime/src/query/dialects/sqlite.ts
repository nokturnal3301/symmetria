import {
  isJsonType,
  sqliteColumnType,
  sqliteDefaultSQL,
  sqliteJsonPath,
  sqliteParameter,
  sqliteRowConverter,
} from "../dialect";
import type { DialectStrategy, JsonObjectEntry } from "./types";

const sqlString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** Enum labels sort by declaration position, as PostgreSQL orders them. */
const enumPosition = (value: string, labels: readonly string[]): string =>
  `(CASE ${value} ${labels.map((label, position) => `WHEN ${sqlString(label)} THEN ${position}`).join(" ")} END)`;

const jsonArray = (value: string): string =>
  `(CASE WHEN json_type(${value}) = 'null' THEN NULL ELSE ${value} END)`;

/** Scalar JSON text for a json_each row, preserving arrays and objects as JSON. */
const jsonValue = (alias: string): string =>
  `CASE ${alias}.type WHEN 'array' THEN ${alias}.value WHEN 'object' THEN ${alias}.value WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_quote(${alias}.value) END`;

const jsonEquality = (left: string, right: string): string => {
  const tree = (source: string): string =>
    `SELECT fullkey, CASE type WHEN 'real' THEN 'integer' ELSE type END, atom FROM json_tree(${source})`;

  return `(NOT EXISTS (${tree(left)} EXCEPT ${tree(right)}) AND NOT EXISTS (${tree(right)} EXCEPT ${tree(left)}))`;
};

const jsonComparison = (
  left: string,
  right: string,
  operator: string,
): string => {
  const nullSafe = operator === "IS" || operator === "IS NOT";
  const negated = operator === "<>" || operator === "IS NOT";

  return `(CASE WHEN ${left} IS NULL OR ${right} IS NULL THEN ${nullSafe ? `${left} ${operator} ${right}` : "NULL"} ELSE ${negated ? "NOT " : ""}${jsonEquality(left, right)} END)`;
};

const jsonObject = (entries: readonly JsonObjectEntry[]): string => {
  // json_object() treats text arguments as strings unless wrapped in json().
  const wrapped = entries.map(({ key, value, json }) => ({
    key,
    value: json ? `json(${value})` : value,
  }));
  const fields = wrapped.map(({ key, value }) => `${sqlString(key)}, ${value}`);

  if (entries.length <= 50) {
    return `json_object(${fields.join(", ")})`;
  }

  // Prepend escaped members without JSON paths or merge-patch NULL deletion.
  // Every value stays in the enclosing window/aggregate scope and occurs once.
  const lastChunk = Math.floor((entries.length - 1) / 50) * 50;
  let object = `json_object(${fields.slice(lastChunk).join(", ")})`;

  for (let position = lastChunk - 50; position >= 0; position -= 50) {
    const members = wrapped
      .slice(position, position + 50)
      .map(
        ({ key, value }) =>
          `${sqlString(`${JSON.stringify(key)}:`)} || json_quote(${value})`,
      );
    object = `json('{' || ${members.join(" || ',' || ")} || ',' || substr(${object}, 2))`;
  }

  return object;
};

/** SQLite through bun:sqlite: JSON text, emulated search, no locks or LATERAL. */
export const sqliteDialect: DialectStrategy = {
  name: "sqlite",
  capabilities: {
    lateralJoins: false,
    rootPagination: false,
    rowLocks: false,
    mutationRootAlias: false,
    defaultValuesOnConflict: false,
    nativeArrays: false,
    serializedJsonArrayElements: true,
    containmentOperators: false,
    fullTextSearch: true,
    typedParameters: false,
    explicitNulls: true,
  },
  placeholder: (position) => `?${position}`,
  cast: (value, target) =>
    target.kind === "text" && !target.array ? `CAST(${value} AS TEXT)` : value,
  comparisonOperator: (operator) => {
    switch (operator) {
      case "ILIKE":
        return "LIKE";
      case "IS DISTINCT FROM":
        return "IS NOT";
      case "IS NOT DISTINCT FROM":
        return "IS";
      case "@>":
      case "&&":
        throw new Error(
          "symmetria: containment and overlap operators are not available in the SQLite dialect",
        );
      default:
        return operator;
    }
  },
  limitOffset: (limit, offset) => [
    ...(limit !== undefined
      ? [`LIMIT ${limit}`]
      : offset !== undefined
        ? ["LIMIT -1"]
        : []),
    ...(offset === undefined ? [] : [`OFFSET ${offset}`]),
  ],
  rowLock: () => {
    throw new Error(
      'symmetria: row locks are not available in dialect "sqlite"',
    );
  },
  textCast: { prefix: "CAST(", suffix: " AS TEXT)" },
  // numeric lives in TEXT storage and enums are plain text: compare by magnitude
  // and by declaration position, as PostgreSQL does.
  orderedOperand: (value, type, equality) => {
    if (/^(?:numeric|decimal)\b/.test(type.sqlType)) {
      return `CAST(${value} AS REAL)`;
    }

    if (type.enumerationValues && !equality) {
      return enumPosition(value, type.enumerationValues);
    }

    return undefined;
  },
  orderedAggregate: (name, value, type) => {
    // REAL keeps 15 significant digits; wider or unbounded numerics stay text
    // so custom codecs over them read back exactly.
    const precision = /^(?:numeric|decimal)\((\d+)/.exec(type.sqlType)?.[1];

    if (precision !== undefined && Number(precision) <= 15) {
      return `${name}(CAST(${value} AS REAL))`;
    }

    if (type.enumerationValues) {
      return `(CASE ${name}(${enumPosition(value, type.enumerationValues)}) ${type.enumerationValues.map((label, position) => `WHEN ${position} THEN ${sqlString(label)}`).join(" ")} END)`;
    }

    return undefined;
  },
  // The driver sets PRAGMA case_sensitive_like; PostgreSQL's escape character is
  // the backslash, and ILIKE folds case (ASCII only, as SQLite's lower() does).
  patternMatch: (left, right, caseInsensitive) =>
    caseInsensitive
      ? `lower(${left}) LIKE lower(${right}) ESCAPE '\\'`
      : `${left} LIKE ${right} ESCAPE '\\'`,
  jsonArray,
  jsonObject,
  jsonRows: (nested, fields, many, _jsonOutput, context) => {
    const rowObject = jsonObject(
      fields.map((field) => ({
        key: field.name,
        value: `"__symmetria_row".${context.quote(field.name)}`,
        json: field.json,
      })),
    );

    return many
      ? `(SELECT json_group_array(${rowObject}) FROM (${nested}) AS "__symmetria_row")`
      : `(SELECT ${rowObject} FROM (${nested}) AS "__symmetria_row")`;
  },
  jsonPath: (value, path, options, context) => {
    if (
      path.length === 1 &&
      typeof path[0] === "string" &&
      path[0].includes('"')
    ) {
      const alias = context.nestedAlias("__symmetria_json_path");
      const selected = options.scalarType
        ? `CAST(${alias}.value AS ${sqliteColumnType(options.scalarType)})`
        : jsonValue(alias);

      return `(SELECT ${selected} FROM json_each(${value}) AS ${alias} WHERE ${alias}.key = ${context.parameter(path[0])})`;
    }

    const parameter = context.parameter(sqliteJsonPath(path));

    return options.scalarType
      ? `CAST(json_extract(${value}, ${parameter}) AS ${sqliteColumnType(options.scalarType)})`
      : options.serialized
        ? `json_extract((${value} -> ${parameter}), '$')`
        : `(${value} -> ${parameter})`;
  },
  arrayIndex: (value, position, context) =>
    `json_extract(${value}, ${context.parameter(sqliteJsonPath([position]))})`,
  arrayLength: (value, json) =>
    `json_array_length(${json ? jsonArray(value) : value})`,
  jsonComparison,
  jsonMembership: (left, operand, negated, context) => {
    if (operand.kind === "list") {
      return `${negated ? "NOT " : ""}(${operand.values.map((value) => jsonComparison(left, value, "=")).join(" OR ")})`;
    }

    const alias = context.nestedAlias("__symmetria_member");
    const right = `${alias}.${context.quote(operand.column)}`;

    return `1 ${negated ? "NOT " : ""}IN (SELECT ${jsonComparison(left, right, "=")} FROM (${operand.sql}) AS ${alias})`;
  },
  jsonHas: (value, element, options, context) => {
    const array = jsonArray(value);
    const elementAlias = context.nestedAlias("__symmetria_element");
    const other = context.nestedAlias("__symmetria_element_other");
    // Compare JSON structure, preserving scalar types and ignoring object-key order.
    const member = options.serializedElements
      ? `COALESCE(${elementAlias}.value, 'null')`
      : jsonValue(elementAlias);
    const target = options.overlap
      ? options.serializedOperandElements
        ? `COALESCE(${other}.value, 'null')`
        : jsonValue(other)
      : `COALESCE(${options.encoded || isJsonType(options.elementType) ? element : ["boolean", "bool"].includes(options.elementType) ? `CASE WHEN ${element} IS NULL THEN 'null' WHEN ${element} THEN 'true' ELSE 'false' END` : `json_quote(${element})`}, 'null')`;

    return `EXISTS (SELECT 1 FROM json_each(${array}) AS ${elementAlias}${options.overlap ? ` CROSS JOIN json_each(${jsonArray(element)}) AS ${other}` : ""} WHERE ${jsonEquality(member, target)})`;
  },
  arrayHas: (value, element, options, context) => {
    const alias = context.nestedAlias("__symmetria_array");

    return options.serializedElements
      ? `(CASE WHEN ${value} IS NULL THEN NULL ELSE 1 IN (SELECT ${jsonComparison(`${alias}.value`, element, "=")} FROM json_each(${value}) AS ${alias}) END)`
      : `(CASE WHEN ${value} IS NULL THEN NULL ELSE ${element} IN (SELECT ${alias}.value FROM json_each(${value}) AS ${alias}) END)`;
  },
  search: (value, query, _language, context) => {
    // No text search configuration: every term must appear, case-insensitively.
    if (query.renderEncoded) {
      const terms = query.renderEncoded((encoded) =>
        JSON.stringify(String(encoded).split(/\s+/).filter(Boolean)),
      );
      const alias = context.nestedAlias("__symmetria_search");

      // One JSON parameter keeps the prepared SQL stable for any number of terms.
      return `(SELECT COUNT(*) > 0 AND MIN(lower(${value}) LIKE '%' || lower(${alias}.value) || '%') FROM json_each(${terms}) AS ${alias})`;
    }

    if (query.literal === undefined) {
      return `lower(${value}) LIKE '%' || lower(${query.render()}) || '%'`;
    }

    const terms = query.literal.split(/\s+/).filter(Boolean);

    if (!terms.length) {
      return "FALSE";
    }

    return `(${terms.map((term) => `lower(${value}) LIKE '%' || lower(${context.parameter(term)}) || '%'`).join(" AND ")})`;
  },
  defaultValue: (column, context) =>
    sqliteDefaultSQL(column, context.parameter),
  recursiveUnion: (anchor, recursive, options) =>
    `${options.anchorNeedsWrapper ? `SELECT * FROM (${anchor})` : anchor}\nUNION${options.unionAll ? " ALL" : ""}\n${recursive}`,
  rowConverter: (selection) => sqliteRowConverter(selection),
  jsonBoolean: (value) => (value ? 1 : 0),
  parameterValue: sqliteParameter,
  explain: (sql, analyze) => {
    if (analyze) {
      throw new Error(
        "symmetria: EXPLAIN ANALYZE is available for PostgreSQL only",
      );
    }

    return {
      sql: `EXPLAIN QUERY PLAN ${sql}`,
      analyzed: false,
      plan: (rows) => rows,
    };
  },
  // PostgreSQL's default; ORDER BY spells it out because SQLite's own is the reverse.
  nullsDefault: (direction) => (direction === "ASC" ? "LAST" : "FIRST"),
};

Object.freeze(sqliteDialect.capabilities);
Object.freeze(sqliteDialect.textCast);
Object.freeze(sqliteDialect);
