/**
 * Full-text search SQL shared by the query renderer and schema DDL: tsvector
 * documents, tsquery parsing, matching, ranking and headlines. Pure string helpers.
 */
import type {
  SearchHeadlineOptions,
  SearchMode,
  SearchWeight,
} from "../../expressions";

export const sqlString = (text: string): string =>
  `'${text.replaceAll("'", "''")}'`;

export type SearchDocumentPart = {
  readonly value: string;
  readonly weight?: SearchWeight;
  /** The rendered value is already a tsvector and must not be wrapped in to_tsvector(). */
  readonly isVector: boolean;
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
    .map(({ value, weight, isVector }) => {
      const vector = isVector
        ? value
        : `to_tsvector(${sqlString(language)}, coalesce(${value}, ''))`;

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

/** The ts_headline() options literal, or undefined when every option is default. */
export const headlineOptionsSql = (
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

  return entries.length ? sqlString(entries.join(", ")) : undefined;
};

export const searchHeadlineSql = (
  language: string,
  text: string,
  query: string,
  options: SearchHeadlineRendering,
): string => {
  const literal = headlineOptionsSql(options);

  return `ts_headline(${sqlString(language)}, ${text}, ${query}${literal ? `, ${literal}` : ""})`;
};
