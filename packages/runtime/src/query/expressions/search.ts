/**
 * Full-text search expressions: language, query mode, rank and headline options.
 */
import { freeze } from "../plan/freeze";
import {
  booleanCodec,
  codecFor,
  decodeValue,
  encodeValue,
  type RuntimeCodec,
} from "../codecs";
import { expressionSource, expressionSqlType } from "../plan/metadata";
import {
  COLUMN_EXPRESSION,
  type ExpressionDescription,
  type SelectedColumn,
} from "./nodes";
import type {
  SearchMode,
  SearchRankOptions,
  SearchHeadlineOptions,
  SearchHeadlineText,
  QueryColumn,
} from "./column-types";
import { readColumn, valueNode, createExpression } from "./core";

export const searchLanguage = (language = "simple"): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(language)) {
    throw new Error(
      "symmetria: search language must be a PostgreSQL text search configuration name",
    );
  }

  return language;
};

export const SEARCH_MODES: ReadonlySet<string> = new Set([
  "websearch",
  "plain",
  "phrase",
  "raw",
]);

export const searchMode = (mode: SearchMode = "websearch"): SearchMode => {
  if (!SEARCH_MODES.has(mode)) {
    throw new Error(
      "symmetria: search mode must be websearch, plain, phrase or raw",
    );
  }

  return mode;
};

export const rankOptions = (options: SearchRankOptions) => {
  const { weights, normalization, coverDensity } = options;

  if (
    weights !== undefined &&
    (!Array.isArray(weights) ||
      weights.length !== 4 ||
      weights.some(
        (weight) =>
          typeof weight !== "number" || !Number.isFinite(weight) || weight < 0,
      ))
  ) {
    throw new Error(
      "symmetria: search weights must be four non-negative numbers in PostgreSQL's order (D, C, B, A)",
    );
  }

  if (
    normalization !== undefined &&
    (!Number.isSafeInteger(normalization) ||
      normalization < 0 ||
      normalization > 63)
  ) {
    throw new Error(
      "symmetria: search normalization must be an integer between 0 and 63",
    );
  }

  return {
    ...(weights
      ? {
          weights: freeze([...weights]) as unknown as readonly [
            number,
            number,
            number,
            number,
          ],
        }
      : {}),
    ...(normalization === undefined ? {} : { normalization }),
    ...(coverDensity ? { coverDensity: true as const } : {}),
  };
};

export const HEADLINE_OPTIONS = {
  startSel: "string",
  stopSel: "string",
  fragmentDelimiter: "string",
  maxWords: "integer",
  minWords: "integer",
  shortWord: "integer",
  maxFragments: "integer",
  highlightAll: "boolean",
} as const;

export const headlineOptions = (
  options: SearchHeadlineOptions,
): SearchHeadlineText => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(options)) {
    if (key === "language" || key === "mode" || value === undefined) {
      continue;
    }

    const expected = HEADLINE_OPTIONS[key as keyof typeof HEADLINE_OPTIONS];

    if (!expected) {
      throw new Error(`symmetria: unknown headline option "${key}"`);
    }

    const valid =
      expected === "string"
        ? typeof value === "string" && !value.includes("\0")
        : expected === "integer"
          ? Number.isSafeInteger(value) && (value as number) >= 0
          : typeof value === "boolean";

    if (!valid) {
      throw new Error(
        `symmetria: headline option "${key}" must be a ${expected === "integer" ? "non-negative integer" : expected}`,
      );
    }

    result[key] = value;
  }

  return freeze(result) as SearchHeadlineText;
};

export const matchExpression = (
  description: ExpressionDescription,
  branches: Record<string, unknown>,
): QueryColumn<unknown, string> => {
  const source = expressionSource(description).node;
  const enumeration =
    source.kind === "column"
      ? source.description.column.enumerationValues
      : undefined;
  const entries =
    branches && typeof branches === "object" && !Array.isArray(branches)
      ? Object.entries(branches)
      : [];

  if (
    !entries.length ||
    (enumeration &&
      (entries.length !== enumeration.length ||
        enumeration.some((name) => !Object.hasOwn(branches, name))))
  ) {
    throw new Error(
      "symmetria: match() requires exactly one branch for every enum value",
    );
  }

  const selected = entries
    .map(([, value]) => value)
    .filter(
      (value): value is SelectedColumn =>
        !!value && typeof value === "object" && COLUMN_EXPRESSION in value,
    )
    .map(readColumn);

  const selectedDescription =
    selected.find(
      (expression) => expressionSqlType(expression) !== "derived",
    ) ?? selected[0];

  const literal = entries.find(
    ([, value]) =>
      value !== null &&
      !(value && typeof value === "object" && COLUMN_EXPRESSION in value),
  )?.[1];

  const literalType =
    literal instanceof Date
      ? "timestamptz"
      : typeof literal === "bigint"
        ? "bigint"
        : typeof literal === "number"
          ? "double precision"
          : typeof literal === "boolean"
            ? "boolean"
            : "text";

  const selectedType = selectedDescription
    ? expressionSqlType(selectedDescription)
    : "derived";

  const sqlType =
    selectedType !== "derived"
      ? selectedType
      : literal !== undefined || !selectedDescription
        ? literalType
        : "derived";

  const codec =
    selectedDescription?.codec ??
    (sqlType === "boolean" ? booleanCodec : codecFor(sqlType));

  const parameterCodec: RuntimeCodec = {
    encode: (value) => {
      const encoded = encodeValue(value, codec);

      return encoded instanceof Date ? encoded.toISOString() : encoded;
    },
    decode: (value) => decodeValue(value, codec),
    ...(sqlType === "derived" || sqlType === "enum"
      ? {}
      : { parameterCast: sqlType }),
  };

  const values = entries.map(([name, result]) => {
    const expression =
      result && typeof result === "object" && COLUMN_EXPRESSION in result
        ? readColumn(result as SelectedColumn)
        : undefined;

    if (
      expression &&
      expressionSqlType(expression) !== "derived" &&
      expressionSqlType(expression) !== sqlType
    ) {
      throw new Error("symmetria: match() branches require the same SQL type");
    }

    if (
      !expression &&
      result !== null &&
      ((!selectedDescription && typeof result !== typeof literal) ||
        result === undefined)
    ) {
      throw new Error(
        "symmetria: match() branches require compatible scalar values",
      );
    }

    const node = valueNode(result, parameterCodec);

    return freeze({
      when: valueNode(name, description.codec),
      then:
        node.kind === "parameter" && sqlType !== "derived" && sqlType !== "enum"
          ? freeze({ ...node, cast: sqlType })
          : node,
    });
  });

  return createExpression({
    outputName: description.outputName,
    ...(codec ? { codec } : {}),
    node: freeze({
      kind: "case",
      value: description.node,
      branches: freeze(values),
      sqlType,
    }),
  });
};
