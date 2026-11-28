/**
 * Column defaults compared by value: Symmetria writes a value default as an
 * escape-string literal (`E'{"a b","c"}'::text[]`), PostgreSQL prints it back
 * in its own form (`'{"a b",c}'::text[]`), and a pulled schema keeps that
 * form. Both are the same default, so changing one into the other is no
 * migration.
 */
import { timestampKey } from "symmetria/internal";
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

/** The white space PostgreSQL's array input skips: ASCII only, not NBSP. */
const ARRAY_SPACE = /[ \t\n\r\f\v]/;

/**
 * A one-dimensional array literal's elements as PostgreSQL's array input
 * reads them, `NULL` as null: white space around elements and delimiters is
 * skipped, a quoted element keeps everything between its quotes (a backslash
 * takes the next character as it is), and only an unquoted `NULL`, in any
 * letter case, is null. Undefined for a literal PostgreSQL refuses (`{a,}`,
 * `{"a"b}`) and for one this does not read: explicit bounds (`[0:1]={a,b}`
 * is another value than `{a,b}`), nested arrays, and a backslash outside
 * quotes. `delimiter` is the element type's.
 */
const arrayElements = (
  text: string,
  delimiter = ",",
): (string | null)[] | undefined => {
  const elements: (string | null)[] = [];
  let index = 0;
  const skipSpace = (): void => {
    while (index < text.length && ARRAY_SPACE.test(text[index]!)) {
      index += 1;
    }
  };

  skipSpace();

  if (text[index] !== "{") {
    return undefined;
  }

  index += 1;
  skipSpace();

  // `{}` and `{ }` hold nothing; after a delimiter an element must follow.
  while (text[index] !== "}" || elements.length > 0) {
    if (text[index] === '"') {
      let element = "";

      index += 1;

      while (text[index] !== '"') {
        if (text[index] === "\\") {
          index += 1;
        }

        if (index >= text.length) {
          return undefined;
        }

        element += text[index];
        index += 1;
      }

      index += 1;
      elements.push(element);
    } else {
      const start = index;

      while (text[index] !== delimiter && text[index] !== "}") {
        if (index >= text.length || '{"\\'.includes(text[index]!)) {
          return undefined;
        }

        index += 1;
      }

      let end = index;

      while (end > start && ARRAY_SPACE.test(text[end - 1]!)) {
        end -= 1;
      }

      if (end === start) {
        return undefined;
      }

      const element = text.slice(start, end);

      elements.push(/^[nN][uU][lL][lL]$/.test(element) ? null : element);
    }

    // After an element: its delimiter, or the end of the array.
    skipSpace();

    if (text[index] === "}") {
      break;
    }

    if (text[index] !== delimiter) {
      return undefined;
    }

    index += 1;
    skipSpace();
  }

  index += 1;
  skipSpace();

  return index === text.length ? elements : undefined;
};

/** Exact decimal key of a validated JSON number, without expanding exponents. */
const jsonNumberKey = (source: string): string => {
  const [mantissa, exponent = "0"] = source.toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.replace(/^-/, "").split(".");
  const digits = (whole! + fraction).replace(/^0+/, "");
  if (!digits) {
    return "n0";
  }
  const significant = digits.replace(/0+$/, "");
  const power =
    BigInt(exponent) +
    BigInt(digits.length - significant.length - fraction.length);
  return `n${source.startsWith("-") ? "-" : ""}${significant}e${power}`;
};

/** `interval` and `interval(3)`, as normalizeSqlType writes them. */
const PLAIN_INTERVAL = /^interval(?:\(\d\))?$/;

/** A key equal for two spellings of one default value of a column type. */
const valueKey = (text: string, sqlType: string): string | undefined => {
  if (sqlType.endsWith("[]")) {
    // Elements of a box are apart by a semicolon; the other types' by a comma.
    const elements = arrayElements(text, sqlType === "box[]" ? ";" : ",");

    return elements && JSON.stringify(elements);
  }

  if (sqlType === "json") {
    return text; // Unlike jsonb, PostgreSQL json preserves its source text.
  }

  if (sqlType === "jsonb") {
    try {
      // Revivers see children first: sort object keys, but keep numeric
      // tokens as written rather than rounding them to JavaScript numbers.
      return JSON.stringify(
        JSON.parse(
          text,
          (_key: string, value: unknown, context?: { source?: string }) => {
            if (typeof value === "number") {
              return jsonNumberKey(context!.source!);
            }
            if (typeof value === "string") {
              return `s${value}`;
            }
            return value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
              ? Object.fromEntries(
                  Object.entries(value).sort(([a], [b]) =>
                    a < b ? -1 : a > b ? 1 : 0,
                  ),
                )
              : value;
          },
        ),
      );
    } catch {
      return undefined;
    }
  }

  if (sqlType.startsWith("timestamp")) {
    // normalizeSqlType puts the precision after the zone suffix.
    return timestampKey(
      text,
      sqlType.replace(/( with(?:out)? time zone)(\(\d\))$/, "$2$1"),
    );
  }

  // An interval restricted to some fields (`interval hour to minute`) reads
  // a number without a unit in another unit, so only the plain type has a key.
  if (PLAIN_INTERVAL.test(sqlType)) {
    return intervalKey(text);
  }

  return undefined;
};

/**
 * The value key of SQL that is one literal of the column's type, if it is;
 * `typed` asks for the cast to that type to be written out.
 */
const literalKey = (
  sql: string,
  sqlType: string,
  typed = false,
): string | undefined => {
  const literal = LITERAL.exec(sql);

  if (!literal) {
    return undefined;
  }

  const cast = literal[3] && normalizeSqlType(literal[3]);
  const text = literalText(literal[1] === "E", literal[2]!);

  // A literal cast to another type than the column's is an expression.
  return text !== undefined && (cast ? cast === sqlType : !typed)
    ? valueKey(text, sqlType)
    : undefined;
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
  const key = literalKey(sql.trim(), sqlType);

  if (key !== undefined) {
    return `value ${key}`;
  }

  const expression = expressionKey(
    sql,
    new Map([[column.name, column.sqlType]]),
  );
  // The other spellings of an interval literal (`INTERVAL '1 day'`,
  // `('1 day')::interval`) are that literal in the normalized expression,
  // so they are the same default as `'1 day'::interval`.
  const typed = PLAIN_INTERVAL.test(sqlType)
    ? literalKey(expression, sqlType, true)
    : undefined;

  return typed === undefined ? expression : `value ${typed}`;
};
