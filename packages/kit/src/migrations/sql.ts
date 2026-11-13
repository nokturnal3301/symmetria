/**
 * Splits PostgreSQL scripts into statements the way psql does: quoted strings,
 * comments, dollar bodies, parenthesized lists (CREATE RULE … DO (…; …)) and
 * SQL-standard function bodies (BEGIN ATOMIC … END) never end a statement.
 */
export type ParsedStatement = {
  /** The statement as written, comments included. */
  sql: string;
  /** Keywords and unquoted identifiers, upper-cased, outside comments and literals. */
  words: string[];
  /** The statement with comments removed and every string literal or dollar body replaced by ''. */
  code: string;
};

const TRANSACTION_CONTROL = [
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "ABORT",
  "SAVEPOINT",
  "RELEASE",
];

/** CREATE [OR REPLACE] FUNCTION|PROCEDURE: the statements whose BEGIN … END blocks psql tracks. */
const routineDefinition = (words: readonly string[]): boolean =>
  words[0] === "CREATE" &&
  (["FUNCTION", "PROCEDURE"].includes(words[1] ?? "") ||
    (words[1] === "OR" &&
      words[2] === "REPLACE" &&
      ["FUNCTION", "PROCEDURE"].includes(words[3] ?? "")));

export const parseMigrationSQL = (script: string): ParsedStatement[] => {
  const statements: ParsedStatement[] = [];
  let start = 0;
  let position = 0;
  let hasCode = false;
  let words: string[] = [];
  let code = "";
  // Semicolons inside parentheses or a BEGIN ATOMIC body belong to the statement.
  let parentheses = 0;
  let blocks = 0;

  const finish = (end: number): void => {
    if (hasCode) {
      const first = words[0];

      if (
        TRANSACTION_CONTROL.includes(first ?? "") ||
        (first === "START" && words[1] === "TRANSACTION") ||
        (first === "PREPARE" && words[1] === "TRANSACTION")
      ) {
        throw new Error(
          "symmetria: migration transaction boundaries are managed by the runner",
        );
      }

      if (first === "COPY" && words.includes("STDIN")) {
        throw new Error(
          "symmetria: COPY FROM STDIN is not supported in migration SQL files",
        );
      }

      if (first === "SET" && words.includes("STANDARD_CONFORMING_STRINGS")) {
        throw new Error(
          "symmetria: migration scripts use standard_conforming_strings=on",
        );
      }

      statements.push({
        sql: script.slice(start, end).trim(),
        words,
        code: code.trim(),
      });
    }

    hasCode = false;
    words = [];
    code = "";
    parentheses = 0;
    blocks = 0;
    start = end + 1;
  };

  while (position < script.length) {
    const character = script[position]!;

    if (/\s/.test(character)) {
      code += character;
      position += 1;
      continue;
    }

    if (script.startsWith("--", position)) {
      const newline = script.indexOf("\n", position + 2);
      position = newline < 0 ? script.length : newline + 1;
      code += " ";
      continue;
    }

    if (script.startsWith("/*", position)) {
      let depth = 1;
      position += 2;

      while (position < script.length && depth) {
        if (script.startsWith("/*", position)) {
          depth += 1;
          position += 2;
        } else if (script.startsWith("*/", position)) {
          depth -= 1;
          position += 2;
        } else {
          position += 1;
        }
      }

      if (depth) {
        throw new Error("symmetria: unterminated SQL block comment");
      }

      code += " ";
      continue;
    }

    if (character === ";" && !parentheses && !blocks) {
      finish(position);
      position += 1;
      continue;
    }

    hasCode = true;

    if (character === "'" || character === '"') {
      const escaped =
        character === "'" &&
        /[eE]/.test(script[position - 1] ?? "") &&
        !/[\w$]/.test(script[position - 2] ?? "");
      const opening = position;
      position += 1;
      let closed = false;

      while (position < script.length) {
        if (escaped && script[position] === "\\") {
          position += 2;
          continue;
        }

        if (script[position] === character) {
          if (script[position + 1] === character) {
            position += 2;
            continue;
          }

          position += 1;
          closed = true;
          break;
        }

        position += 1;
      }

      if (!closed) {
        throw new Error("symmetria: unterminated SQL quote");
      }

      // Identifiers stay as written; literals never take part in classification.
      code += character === '"' ? script.slice(opening, position) : "''";
      continue;
    }

    if (character === "$") {
      const tag = script
        .slice(position)
        .match(/^\$(?:[A-Za-z_\u0080-￿][A-Za-z_0-9\u0080-￿]*)?\$/)?.[0];

      if (tag) {
        const end = script.indexOf(tag, position + tag.length);

        if (end < 0) {
          throw new Error("symmetria: unterminated SQL dollar quote");
        }

        position = end + tag.length;
        code += "''";
        continue;
      }
    }

    const word = script.slice(position).match(/^[A-Za-z_][A-Za-z_0-9$]*/)?.[0];

    if (word) {
      const keyword = word.toUpperCase();
      words.push(keyword);
      code += word;
      position += word.length;

      // psql's heuristic: inside CREATE FUNCTION/PROCEDURE, BEGIN opens a block,
      // CASE nests within one and END closes the innermost.
      if (!parentheses && routineDefinition(words)) {
        if (keyword === "BEGIN") {
          blocks += 1;
        } else if (keyword === "CASE" && blocks) {
          blocks += 1;
        } else if (keyword === "END" && blocks) {
          blocks -= 1;
        }
      }

      continue;
    }

    if (character === "(") {
      parentheses += 1;
    } else if (character === ")" && parentheses) {
      parentheses -= 1;
    }

    code += character;
    position += 1;
  }

  finish(script.length);

  return statements;
};

export const splitMigrationSQL = (script: string): string[] =>
  parseMigrationSQL(script).map((statement) => statement.sql);

export const formatMigrationSQL = (statements: readonly string[]): string =>
  statements.length
    ? `${statements.join(";\n\n")};\n`
    : "-- No schema changes.\n";
