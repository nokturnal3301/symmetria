/**
 * Where the text of a sql`` fragment leaves PostgreSQL's lexer. A fragment is
 * pasted into SQL that Symmetria writes after it (` AS "key"`, ` DESC`, the
 * next assignment, a $scope() check), so it must end in plain SQL: a `--`
 * comment gets a line break, and a comment, string, quoted name or dollar
 * quote left open is refused. Strings are read as PostgreSQL reads them with
 * `standard_conforming_strings = on`, its default: a backslash escapes only
 * inside `E'…'`.
 */

export type RawState =
  | { readonly kind: "sql" }
  | { readonly kind: "line" }
  | { readonly kind: "block"; readonly depth: number }
  | { readonly kind: "string"; readonly escapes: boolean }
  | { readonly kind: "name" }
  | { readonly kind: "dollar"; readonly tag: string };

const SQL: RawState = { kind: "sql" };
const LINE: RawState = { kind: "line" };
const STRING: RawState = { kind: "string", escapes: false };
const ESCAPE_STRING: RawState = { kind: "string", escapes: true };
const NAME: RawState = { kind: "name" };

/** Characters that continue a name, so a `$` or `E` after one is part of it. */
const NAME_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/;
/** What may signal a comment or quoted text; a fragment without any is plain SQL. */
const MARKERS = /--|\/\*|['"$]/;

/**
 * The state after `text`, read from `state`. The start and end of `text` are
 * token boundaries: the interpolations around a template's strings stand there.
 */
export const scanRawText = (text: string, state: RawState = SQL): RawState => {
  if (state.kind === "sql" && !MARKERS.test(text)) {
    return state;
  }

  let index = 0;

  while (index < text.length) {
    const character = text[index]!;

    switch (state.kind) {
      case "line":
        if (character === "\n" || character === "\r") {
          state = SQL;
        }

        index += 1;
        break;
      case "block":
        if (character === "*" && text[index + 1] === "/") {
          state =
            state.depth > 1 ? { kind: "block", depth: state.depth - 1 } : SQL;
          index += 2;
        } else if (character === "/" && text[index + 1] === "*") {
          state = { kind: "block", depth: state.depth + 1 };
          index += 2;
        } else {
          index += 1;
        }

        break;
      case "string":
        if (state.escapes && character === "\\") {
          index += 2;
        } else if (character === "'") {
          if (text[index + 1] === "'") {
            index += 2;
          } else {
            state = SQL;
            index += 1;
          }
        } else {
          index += 1;
        }

        break;
      case "name":
        if (character === '"') {
          if (text[index + 1] === '"') {
            index += 2;
          } else {
            state = SQL;
            index += 1;
          }
        } else {
          index += 1;
        }

        break;
      case "dollar": {
        const end = text.indexOf(state.tag, index);

        if (end < 0) {
          index = text.length;
        } else {
          index = end + state.tag.length;
          state = SQL;
        }

        break;
      }
      case "sql": {
        const previous = index ? text[index - 1]! : "";

        if (character === "-" && text[index + 1] === "-") {
          state = LINE;
          index += 2;
        } else if (character === "/" && text[index + 1] === "*") {
          state = { kind: "block", depth: 1 };
          index += 2;
        } else if (character === "'") {
          // E'…' (or e'…') starts an escape string unless the E ends a name.
          state =
            (previous === "E" || previous === "e") &&
            !(index > 1 && NAME_PART.test(text[index - 2]!))
              ? ESCAPE_STRING
              : STRING;
          index += 1;
        } else if (character === '"') {
          state = NAME;
          index += 1;
        } else if (character === "$" && !NAME_PART.test(previous)) {
          const tag = DOLLAR_TAG.exec(text.slice(index));

          if (tag) {
            state = { kind: "dollar", tag: tag[0] };
            index += tag[0].length;
          } else {
            index += 1;
          }
        } else {
          index += 1;
        }

        break;
      }
    }
  }

  return state;
};

const OPEN: Record<Exclude<RawState["kind"], "sql" | "line">, string> = {
  block: "a /* comment",
  string: "a '…' string",
  name: 'a "…" quoted name',
  dollar: "a dollar-quoted string",
};

/** The template as its source wrote it, for messages. */
const sourceText = (raw: readonly string[]): string => {
  const text = raw.join("${…}");

  return `sql\`${text.length > 80 ? `${text.slice(0, 77)}...` : text}\``;
};

/**
 * The first escape in a template's source that has no value, such as `\u`
 * without hex digits or `\x` (a Windows path, a regular expression).
 */
const missingEscape = (raw: string): string => {
  const found =
    /\\(?:u(?!\{[0-9A-Fa-f]+\}|[0-9A-Fa-f]{4})|x(?![0-9A-Fa-f]{2})|0(?=[0-9])|[1-9])/.exec(
      raw.replace(/\\\\/g, "  "),
    );

  return found
    ? `the escape ${raw.slice(found.index, found.index + 2)}`
    : "an escape";
};

export type TemplateText = {
  /** The template's strings, the last one ending a `--` comment with a line break. */
  readonly strings: readonly string[];
  /** The positions of the values that stand inside a comment or quoted text. */
  readonly enclosed: readonly number[] | undefined;
};

const templates = new WeakMap<readonly string[], TemplateText>();

/** What a sql`` template's text means for the SQL around it; refuses one that cannot be pasted. */
export const readTemplate = (strings: TemplateStringsArray): TemplateText => {
  const known = templates.get(strings);

  if (known) {
    return known;
  }

  const undefinedAt = strings.findIndex((text) => text === undefined);

  if (undefinedAt >= 0) {
    throw new Error(
      `symmetria: ${sourceText(strings.raw)} has ${missingEscape(strings.raw[undefinedAt]!)}, which JavaScript reads as no text at all; write \\\\ for a backslash in the SQL, as in sql\`'C:\\\\users'\``,
    );
  }

  let state: RawState = SQL;
  let enclosed: number[] | undefined;

  strings.forEach((text, index) => {
    state = scanRawText(text, state);

    if (index < strings.length - 1 && state.kind !== "sql") {
      (enclosed ??= []).push(index);
    }
  });

  const end = state as RawState;

  if (end.kind !== "sql" && end.kind !== "line") {
    throw new Error(
      `symmetria: ${sourceText(strings.raw)} leaves ${OPEN[end.kind]} open, which would take in the SQL written after it; close it in the same template`,
    );
  }

  const text: TemplateText = {
    strings:
      end.kind === "line"
        ? [...strings.slice(0, -1), `${strings.at(-1)}\n`]
        : strings,
    enclosed,
  };

  templates.set(strings, text);

  return text;
};

/**
 * The rendered SQL of a fragment whose values stand inside a comment or
 * quoted text: such a value must not end it early or leave it open.
 */
export const closedRawSql = (sql: string): string => {
  const end = scanRawText(sql);

  if (end.kind === "sql") {
    return sql;
  }

  if (end.kind === "line") {
    return `${sql}\n`;
  }

  throw new Error(
    `symmetria: a value interpolated into a comment or quoted text of a sql\`\` template leaves ${OPEN[end.kind]} open; move the value out of it`,
  );
};
