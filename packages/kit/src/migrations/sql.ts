/** Split PostgreSQL scripts without splitting quoted strings or function bodies. */
export const parseMigrationSQL = (
  script: string,
): { sql: string; words: string[] }[] => {
  const statements: { sql: string; words: string[] }[] = [];
  let start = 0;
  let position = 0;
  let hasCode = false;
  let words: string[] = [];

  const finish = (end: number): void => {
    if (hasCode) {
      const first = words[0];

      if (
        [
          "BEGIN",
          "COMMIT",
          "END",
          "ROLLBACK",
          "ABORT",
          "SAVEPOINT",
          "RELEASE",
        ].includes(first ?? "") ||
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

      statements.push({ sql: script.slice(start, end).trim(), words });
    }

    hasCode = false;
    words = [];
    start = end + 1;
  };

  while (position < script.length) {
    const character = script[position]!;

    if (/\s/.test(character)) {
      position += 1;
      continue;
    }

    if (script.startsWith("--", position)) {
      const newline = script.indexOf("\n", position + 2);
      position = newline < 0 ? script.length : newline + 1;
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

      continue;
    }

    if (character === ";") {
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

      continue;
    }

    if (character === "$") {
      const tag = script
        .slice(position)
        .match(
          /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*)?\$/,
        )?.[0];

      if (tag) {
        const end = script.indexOf(tag, position + tag.length);

        if (end < 0) {
          throw new Error("symmetria: unterminated SQL dollar quote");
        }

        position = end + tag.length;
        continue;
      }
    }

    const word = script.slice(position).match(/^[A-Za-z_][A-Za-z_0-9$]*/)?.[0];

    if (word) {
      words.push(word.toUpperCase());
      position += word.length;
    } else {
      position += 1;
    }
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
