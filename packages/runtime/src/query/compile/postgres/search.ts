/**
 * Full-text search SQL shared by the query renderer and schema DDL: tsvector
 * documents, tsquery parsing, matching, ranking and headlines. String helpers,
 * and the type a full-text function reads a value as.
 */
import type {
  SearchHeadlineOptions,
  SearchMode,
  SearchWeight,
  ValueNode,
} from "../../expressions";
import { isBuiltInType } from "../../codecs/type-names";
import { valueSqlType } from "../../plan/metadata";

/**
 * A string literal that means the same with `standard_conforming_strings` on
 * or off: text with a backslash is an `E'…'` string with the backslashes
 * doubled, which reads them as escapes under both settings; other text stays
 * a plain `'…'` literal.
 */
export const sqlString = (text: string): string =>
  text.includes("\\")
    ? `E'${text.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
    : `'${text.replaceAll("'", "''")}'`;

/**
 * Types full-text functions take as they are: text, JSON and a tsvector,
 * with a length or not; never an array of one (`varchar(40)[]`).
 */
const SEARCH_TEXT =
  /^(?:text|varchar|char|character|bpchar|name|json|jsonb|tsvector)(?:\(\d+\))?$/;

/**
 * Whether a full-text function reads a value of a type (in the runtime's
 * spelling: a customType's `base`, else its SQL type) through its text: a
 * type known not to be text, one of PostgreSQL's own (uuid, numeric, a date…),
 * an enum, or an array of any type (`citext[]`). Another type (a domain, an
 * extension's type, raw SQL) is not known: it may be text or JSON, so it is
 * read as it is.
 */
const readsThroughText = (type: string): boolean =>
  !SEARCH_TEXT.test(type) &&
  (isBuiltInType(type) || type === "enum" || type.endsWith("[]"));

/**
 * A value of a type (in one spelling) as the text a full-text function reads,
 * in queries and DDL alike, so an index serves the query: a type known not to
 * be text reads as its text, `(value)::text`, as table search reads it. Text,
 * a tsvector, a JSON value (a jsonb column, a path: PostgreSQL reads its
 * string values, without its keys, numbers and booleans, as an index on
 * `to_tsvector(cfg, value)` does), and a type not known (a customType without
 * `base`, raw SQL) render as they are.
 */
export const searchTextSql = (type: string, sql: string): string =>
  readsThroughText(type) ? `(${sql})::text` : sql;

/** Text that follows a setting (DateStyle, IntervalStyle, lc_monetary) or a label that can be renamed. */
const CHANGING_TEXT =
  /^(?:enum|date|interval|money|timestamp|timestamptz)(?:\(|$)/;
/** Types whose text PostgreSQL does not count as fixed either: ranges, multiranges and arrays. */
const UNFIXED_TEXT = /^(?:int4|int8|num|ts|tstz|date)(?:multi)?range$|\[\]$/;

/**
 * Whether PostgreSQL refuses an index on the text of a value of a type:
 * `"changing"` for text that follows the session's settings or a label that
 * can be renamed (an enum, a date, an interval, money, a timestamp),
 * `"unfixed"` for a range, a multirange or an array, undefined when it does
 * not refuse it. `(value)::text` of those calls an output function that is
 * not immutable.
 */
export const unfixedSearchText = (
  type: string,
): "changing" | "unfixed" | undefined =>
  !readsThroughText(type)
    ? undefined
    : CHANGING_TEXT.test(type)
      ? "changing"
      : UNFIXED_TEXT.test(type)
        ? "unfixed"
        : undefined;

/** Why PostgreSQL refuses an index on the text of a value of a type, or undefined when it does not. */
export const unindexableSearchText = (type: string): string | undefined => {
  const unfixed = unfixedSearchText(type);

  return unfixed === undefined
    ? undefined
    : unfixed === "unfixed"
      ? "PostgreSQL does not count the text of a range or an array as fixed"
      : type === "enum"
        ? "its values can be renamed"
        : "its text follows the session's settings (DateStyle, IntervalStyle, lc_monetary)";
};

/**
 * The type a full-text function reads a value as, in the runtime's spelling:
 * a column of a customType with a `base` is that base, so a domain over
 * jsonb declared with `base: "jsonb"` reads as JSON and one over date as a date.
 */
export const searchValueType = (node: ValueNode): string => {
  const codec =
    node.kind === "column"
      ? node.description.binding.codecs?.[node.description.column.name]
      : undefined;

  return valueSqlType({
    node,
    outputName: "value",
    ...(codec ? { codec } : {}),
  });
};

export const isJsonType = (type: string): boolean =>
  type === "json" || type === "jsonb";

export type SearchDocumentPart = {
  readonly value: string;
  readonly weight?: SearchWeight;
  /** The rendered value is already a tsvector and must not be wrapped in to_tsvector(). */
  readonly isVector: boolean;
  /** The value is json or jsonb: a missing one reads as an empty object, `''` is no JSON. */
  readonly isJson?: boolean;
};

export type SearchRankRendering = {
  readonly weights?: readonly number[];
  readonly normalization?: number;
  readonly coverDensity: boolean;
};

export type SearchHeadlineRendering = Readonly<
  Omit<SearchHeadlineOptions, "language" | "mode">
>;

const TSQUERY_FUNCTIONS: Record<SearchMode, string> = {
  websearch: "websearch_to_tsquery",
  plain: "plainto_tsquery",
  phrase: "phraseto_tsquery",
  raw: "to_tsquery",
};

export const tsquerySql = (
  query: string,
  language: string,
  mode: SearchMode,
): string => `${TSQUERY_FUNCTIONS[mode]}(${sqlString(language)}, ${query})`;

export const searchVectorSql = (
  value: string,
  language: string,
  isVector: boolean,
): string =>
  isVector ? value : `to_tsvector(${sqlString(language)}, ${value})`;

/** `setweight(to_tsvector(lang, coalesce(a, '')), 'A') || ...`; callers add parentheses when an operator follows. */
export const tsvectorSql = (
  parts: readonly SearchDocumentPart[],
  language: string,
): string =>
  parts
    .map(({ value, weight, isVector, isJson }) => {
      const vector = isVector
        ? value
        : `to_tsvector(${sqlString(language)}, coalesce(${value}, ${isJson ? "'{}'" : "''"}))`;

      return weight ? `setweight(${vector}, '${weight}')` : vector;
    })
    .join(" || ");

export const searchRankSql = (
  vector: string,
  query: string,
  options: SearchRankRendering,
): string =>
  `${options.coverDensity ? "ts_rank_cd" : "ts_rank"}(${[
    ...(options.weights ? [`'{${options.weights.join(",")}}'::real[]`] : []),
    vector,
    query,
    ...(options.normalization === undefined
      ? []
      : [String(options.normalization)]),
  ].join(", ")})`;

const HEADLINE_KEYS: Record<keyof SearchHeadlineRendering, string> = {
  startSel: "StartSel",
  stopSel: "StopSel",
  maxWords: "MaxWords",
  minWords: "MinWords",
  shortWord: "ShortWord",
  highlightAll: "HighlightAll",
  maxFragments: "MaxFragments",
  fragmentDelimiter: "FragmentDelimiter",
};

/** The ts_headline() options text, or undefined when every option is default. */
export const headlineOptionsText = (
  options: SearchHeadlineRendering,
): string | undefined => {
  const entries = (
    Object.keys(HEADLINE_KEYS) as (keyof SearchHeadlineRendering)[]
  ).flatMap((key) => {
    const value = options[key];

    if (value === undefined) {
      return [];
    }

    const text =
      typeof value === "string"
        ? `"${value.replaceAll('"', '""')}"`
        : String(value);

    return [`${HEADLINE_KEYS[key]}=${text}`];
  });

  return entries.length ? entries.join(", ") : undefined;
};

/** `options` is the bound options text: its values stay out of the SQL text. */
export const searchHeadlineSql = (
  language: string,
  text: string,
  query: string,
  options: string | undefined,
): string =>
  `ts_headline(${sqlString(language)}, ${text}, ${query}${options ? `, ${options}::text` : ""})`;
