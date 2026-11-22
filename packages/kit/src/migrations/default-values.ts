/**
 * Column defaults compared by value: Symmetria writes a value default as an
 * escape-string literal (`E'{"a b","c"}'::text[]`), PostgreSQL prints it back
 * in its own form (`'{"a b",c}'::text[]`), and a pulled schema keeps that
 * form. Both are the same default, so changing one into the other is no
 * migration.
 */
import { normalizeSqlType } from "./drift";
import { expressionKey } from "./expressions";

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

const INTERVAL_UNITS: Record<string, [months: number, micros: number]> = {
  year: [12, 0],
  month: [1, 0],
  mon: [1, 0],
  week: [0, 7 * 86_400e6],
  day: [0, 86_400e6],
  hour: [0, 3_600e6],
  minute: [0, 60e6],
  min: [0, 60e6],
  second: [0, 1e6],
  sec: [0, 1e6],
};

/**
 * An interval as months and microseconds: `90 minutes` and `01:30:00` are
 * one interval. Days count as 24 hours here, which only matters across a
 * daylight-saving change, never for comparing two spellings of a default.
 */
const intervalKey = (text: string): string | undefined => {
  let months = 0;
  let micros = 0;
  let rest = text.trim().toLowerCase();
  const time = /(-?)(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*$/.exec(rest);

  if (time) {
    const sign = time[1] ? -1 : 1;

    micros +=
      sign *
      (Number(time[2]) * 3_600e6 +
        Number(time[3]) * 60e6 +
        Number(time[4] ?? 0) * 1e6);
    rest = rest.slice(0, time.index).trim();
  }

  for (const part of rest.matchAll(/(-?\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const unit = INTERVAL_UNITS[part[2]!.replace(/s$/, "")];

    if (!unit) {
      return undefined;
    }

    months += Number(part[1]) * unit[0];
    micros += Number(part[1]) * unit[1];
  }

  return rest.replace(/(-?\d+(?:\.\d+)?)\s*([a-z]+)/g, "").trim()
    ? undefined
    : `${months} ${Math.round(micros)}`;
};

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
