/**
 * Column defaults compared by value: Symmetria writes a value default as an
 * escape-string literal (`E'{"a b","c"}'::text[]`), PostgreSQL prints it back
 * in its own form (`'{"a b",c}'::text[]`), and a pulled schema keeps that
 * form. Both are the same default, so changing one into the other is no
 * migration.
 */
import { normalizeSqlType } from "./drift";
import { expressionKey } from "./expressions";
import { intervalKey } from "./expression-simplify";

const LITERAL = /^(E?)'((?:[^'\\]|''|\\.)*)'(?:::([\s\S]+))?$/;

/** The text of a quoted literal, its escapes undone. */
const literalText = (escaped: boolean, body: string): string | undefined => {
  let text = "";

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;

    if (char === "'") {
      text += "'";
      index += 1;
    } else if (char === "\\" && escaped) {
      const next = body[index + 1];

      // Only the escapes Symmetria writes; others are left to the text form.
      if (next !== "\\" && next !== "'") {
        return undefined;
      }

      text += next;
      index += 1;
    } else {
      text += char;
    }
  }

  return text;
};

/** A one-dimensional array literal's elements, `NULL` as null. */
const arrayElements = (text: string): (string | null)[] | undefined => {
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return undefined;
  }

  const elements: (string | null)[] = [];
  let index = 1;

  if (text === "{}") {
    return elements;
  }

  while (index < text.length) {
    let element = "";

    if (text[index] === '"') {
      index += 1;

      while (text[index] !== '"') {
        if (index >= text.length) {
          return undefined;
        }

        if (text[index] === "\\") {
          index += 1;
        }

        element += text[index];
        index += 1;
      }

      index += 1;
      elements.push(element);
    } else {
      while (text[index] !== "," && text[index] !== "}") {
        if (text[index] === "{" || index >= text.length) {
          return undefined;
        }

        element += text[index];
        index += 1;
      }

      elements.push(element === "NULL" ? null : element.trim());
    }

    index += 1;
  }

  return elements;
};

/** JSON with its object keys sorted, as jsonb holds no key order. */
const sortedJson = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortedJson)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              sortedJson((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;

/** A timestamp as epoch milliseconds; one without a zone reads as UTC. */
const timestampKey = (text: string, zoned: boolean): string | undefined => {
  const iso = text
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const time = Date.parse(
    zoned || /(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`,
  );

  return Number.isNaN(time) ? undefined : String(time);
};

/** A key equal for two spellings of one default value of a column type. */
const valueKey = (text: string, sqlType: string): string | undefined => {
  if (sqlType.endsWith("[]")) {
    const elements = arrayElements(text);

    return elements && JSON.stringify(elements);
  }

  if (sqlType === "jsonb" || sqlType === "json") {
    try {
      return JSON.stringify(sortedJson(JSON.parse(text)));
    } catch {
      return undefined;
    }
  }

  if (sqlType.startsWith("timestamp")) {
    return timestampKey(text, sqlType.includes("with time zone"));
  }

  if (sqlType.startsWith("interval")) {
    return intervalKey(text);
  }

  return undefined;
};

/**
 * The comparison key of a column default: its value for a literal of the
 * column's type, otherwise its normalized expression.
 */
export const defaultKey = (
  sql: string,
  column: { readonly name: string; readonly sqlType: string },
): string => {
  const sqlType = normalizeSqlType(column.sqlType);
  const literal = LITERAL.exec(sql.trim());

  if (literal) {
    const cast = literal[3] && normalizeSqlType(literal[3]);
    const text = literalText(literal[1] === "E", literal[2]!);

    // A literal cast to another type than the column's is an expression.
    if (text !== undefined && (!cast || cast === sqlType)) {
      const key = valueKey(text, sqlType);

      if (key !== undefined) {
        return `value ${key}`;
      }
    }
  }

  return expressionKey(sql, new Map([[column.name, column.sqlType]]));
};
