import { unsupported } from "./expression-tree";

export type Token =
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "string"; readonly value: string }
  /** Identifiers and keywords; unquoted words are lowercased. */
  | { readonly kind: "word"; readonly value: string; readonly quoted: boolean }
  | { readonly kind: "operator"; readonly text: string }
  | { readonly kind: "symbol"; readonly text: string };

export const OPERATOR_CHARACTERS = "+-*/<>=~!@#%^&|`?";
export const WORD_START = /[A-Za-z_\u0080-\uFFFF]/;
export const WORD_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/** The value of an `E'…'` string body. */
export const unescape = (body: string): string =>
  body.replace(
    /\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/gs,
    (_match, escape: string) => {
      const simple: Record<string, string> = {
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };

      if (simple[escape] !== undefined) {
        return simple[escape];
      }

      if (/^x/.test(escape) && escape.length > 1) {
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      }

      if (/^[uU]/.test(escape) && escape.length > 1) {
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      }

      if (/^[0-7]+$/.test(escape)) {
        return String.fromCodePoint(Number.parseInt(escape, 8));
      }

      return escape;
    },
  );

export const tokenize = (sql: string): Token[] => {
  const tokens: Token[] = [];
  let position = 0;

  /** A quoted run ending at `quote`, a doubled quote continuing it. */
  const quoted = (start: number, quote: string, backslashes: boolean) => {
    let end = start;
    let body = "";

    while (end < sql.length) {
      const character = sql[end]!;

      if (backslashes && character === "\\") {
        body += sql.slice(end, end + 2);
        end += 2;
        continue;
      }

      if (character === quote) {
        if (sql[end + 1] === quote) {
          body += quote + quote;
          end += 2;
          continue;
        }

        return { body, end: end + 1 };
      }

      body += character;
      end += 1;
    }

    return unsupported("an unterminated quote");
  };

  while (position < sql.length) {
    const character = sql[position]!;
    const rest = sql.slice(position);

    if (/\s/.test(character)) {
      position += 1;
    } else if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", position);
      position = end < 0 ? sql.length : end + 1;
    } else if (rest.startsWith("/*")) {
      let depth = 1;
      position += 2;

      while (position < sql.length && depth) {
        if (sql.startsWith("/*", position)) {
          depth += 1;
          position += 2;
        } else if (sql.startsWith("*/", position)) {
          depth -= 1;
          position += 2;
        } else {
          position += 1;
        }
      }
    } else if (character === "'") {
      const { body, end } = quoted(position + 1, "'", false);
      tokens.push({ kind: "string", value: body.replaceAll("''", "'") });
      position = end;
    } else if (/^[eE]'/.test(rest)) {
      const { body, end } = quoted(position + 2, "'", true);
      tokens.push({
        kind: "string",
        value: unescape(body.replaceAll("''", "'")),
      });
      position = end;
    } else if (character === '"') {
      const { body, end } = quoted(position + 1, '"', false);
      tokens.push({
        kind: "word",
        value: body.replaceAll('""', '"'),
        quoted: true,
      });
      position = end;
    } else if (character === "$") {
      const tag =
        /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(
          rest,
        )?.[0];

      if (!tag) {
        unsupported("a parameter");
      }

      const end = sql.indexOf(tag!, position + tag!.length);

      if (end < 0) {
        unsupported("an unterminated dollar quote");
      }

      tokens.push({
        kind: "string",
        value: sql.slice(position + tag!.length, end),
      });
      position = end + tag!.length;
    } else if (
      /\d/.test(character) ||
      (character === "." && /\d/.test(sql[position + 1] ?? ""))
    ) {
      const text = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)![0];
      tokens.push({ kind: "number", text });
      position += text.length;
    } else if (WORD_START.test(character)) {
      if (/^([bBxXnN]'|[uU]&['"])/.test(rest)) {
        unsupported("a bit, national or Unicode-escaped literal");
      }

      let end = position + 1;

      while (end < sql.length && WORD_PART.test(sql[end]!)) {
        end += 1;
      }

      tokens.push({
        kind: "word",
        value: sql.slice(position, end).toLowerCase(),
        quoted: false,
      });
      position = end;
    } else if (rest.startsWith("::")) {
      tokens.push({ kind: "symbol", text: "::" });
      position += 2;
    } else if ("()[],.;:".includes(character)) {
      tokens.push({ kind: "symbol", text: character });
      position += 1;
    } else if (OPERATOR_CHARACTERS.includes(character)) {
      let end = position;

      while (
        end < sql.length &&
        OPERATOR_CHARACTERS.includes(sql[end]!) &&
        !sql.startsWith("--", end) &&
        !sql.startsWith("/*", end)
      ) {
        end += 1;
      }

      let text = sql.slice(position, end);

      // A multicharacter operator ends in + or - only when it also holds one
      // of ~ ! @ # % ^ & | ` ?, so `>-1` is `>` followed by `-1`.
      while (
        text.length > 1 &&
        /[+-]$/.test(text) &&
        !/[~!@#%^&|`?]/.test(text)
      ) {
        text = text.slice(0, -1);
      }

      tokens.push({ kind: "operator", text });
      position += text.length;
    } else {
      unsupported(`the character ${character}`);
    }
  }

  return tokens;
};
