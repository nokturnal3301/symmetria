/** Only identifiers outside SQL literals/comments participate in column renames. */
const tokens = (
  sql: string,
): { text: string; kind: "identifier" | "literal" | "other" }[] => {
  const result: { text: string; kind: "identifier" | "literal" | "other" }[] =
    [];
  let position = 0;

  while (position < sql.length) {
    const start = position;
    let kind: "identifier" | "literal" | "other" = "other";

    if (sql.startsWith("--", position)) {
      const end = sql.indexOf("\n", position + 2);
      position = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", position)) {
      let depth = 1;
      position += 2;

      while (position < sql.length && depth) {
        if (sql.startsWith("/*", position)) {
          depth++;
          position += 2;
        } else if (sql.startsWith("*/", position)) {
          depth--;
          position += 2;
        } else {
          position++;
        }
      }
    } else {
      const tag =
        sql[position] === "$" && !/[\w$]/.test(sql[position - 1] ?? "")
          ? /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*)?\$/.exec(
              sql.slice(position),
            )?.[0]
          : undefined;
      const escaped =
        /[eE]/.test(sql[position]!) &&
        sql[position + 1] === "'" &&
        !/[\w$]/.test(sql[position - 1] ?? "");
      const quote = escaped ? "'" : sql[position];

      if (tag) {
        const end = sql.indexOf(tag, position + tag.length);
        position = end < 0 ? sql.length : end + tag.length;
        kind = "literal";
      } else if (quote === "'" || quote === '"') {
        kind = quote === '"' ? "identifier" : "literal";
        position += escaped ? 2 : 1;

        while (position < sql.length) {
          if (escaped && sql[position] === "\\") {
            position += 2;
            continue;
          }

          if (sql[position++] === quote) {
            if (sql[position] === quote) {
              position++;
              continue;
            }

            break;
          }
        }
      } else {
        position++;
      }
    }

    result.push({ text: sql.slice(start, position), kind });
  }

  return result;
};

export const renameExpressionIdentifiers = (
  sql: string,
  names: ReadonlyMap<string, string>,
): string =>
  tokens(sql)
    .map((token) =>
      token.kind === "identifier"
        ? (names.get(token.text) ?? token.text)
        : token.text,
    )
    .join("");

/** Unknown escape forms conservatively require enum replacement before use. */
export const expressionUsesLiteral = (sql: string, value: string): boolean =>
  tokens(sql).some((token) => {
    if (token.kind !== "literal") {
      return false;
    }

    const text = token.text;

    if (text[0] === "$") {
      const length = text.indexOf("$", 1) + 1;

      return text.slice(length, -length) === value;
    }

    const escaped = text[0] !== "'";
    let literal = text.slice(escaped ? 2 : 1, -1).replaceAll("''", "'");

    if (escaped) {
      if (/\\[^\\']/.test(literal)) {
        return true;
      }

      literal = literal.replace(/\\([\\'])/g, "$1");
    }

    return literal === value;
  });
