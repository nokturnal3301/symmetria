/**
 * Reads the SQL of CHECK constraints, partial-index predicates and index keys,
 * as PostgreSQL prints them and as the schema DSL renders them, into a small
 * expression tree. The diff compares expressions through `expressionKey`, so
 * rendering differences (outer parentheses, literal casts such as
 * `'-100'::integer`, `= true`, `= ANY (ARRAY[…])` for `IN`) are no change, and
 * `pull` reads the same tree to declare conditions as predicates.
 */
import { normalizeSqlType } from "./drift";

export type SqlExpression =
  /**
   * A number or string literal; `numeric` marks an unquoted number. `type` is
   * the cast it carried before simplification, which comparison keys ignore.
   */
  | {
      readonly kind: "constant";
      readonly value: string;
      readonly numeric: boolean;
      readonly type?: string;
    }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "column"; readonly name: string }
  | {
      readonly kind: "cast";
      readonly value: SqlExpression;
      readonly type: string;
    }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly arguments: readonly SqlExpression[];
    }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: SqlExpression;
      readonly right: SqlExpression;
    }
  | {
      readonly kind: "unary";
      readonly operator: string;
      readonly value: SqlExpression;
    }
  | { readonly kind: "not"; readonly value: SqlExpression }
  | {
      readonly kind: "logical";
      readonly operator: "AND" | "OR";
      readonly values: readonly SqlExpression[];
    }
  | {
      readonly kind: "null-test";
      readonly value: SqlExpression;
      readonly negated: boolean;
    }
  | {
      readonly kind: "truth-test";
      readonly value: SqlExpression;
      readonly test: "TRUE" | "FALSE" | "UNKNOWN";
      readonly negated: boolean;
    }
  | {
      readonly kind: "distinct";
      readonly left: SqlExpression;
      readonly right: SqlExpression;
      readonly negated: boolean;
    }
  | {
      readonly kind: "in";
      readonly value: SqlExpression;
      readonly values: readonly SqlExpression[];
      readonly negated: boolean;
    }
  | {
      readonly kind: "quantified";
      readonly operator: string;
      readonly quantifier: "ANY" | "ALL";
      readonly left: SqlExpression;
      readonly right: SqlExpression;
    }
  | { readonly kind: "array"; readonly values: readonly SqlExpression[] }
  | {
      readonly kind: "between";
      readonly value: SqlExpression;
      readonly lower: SqlExpression;
      readonly upper: SqlExpression;
      readonly negated: boolean;
      readonly symmetric: boolean;
    }
  | {
      readonly kind: "like";
      readonly value: SqlExpression;
      readonly pattern: SqlExpression;
      readonly operator: "LIKE" | "ILIKE";
      readonly negated: boolean;
    }
  | {
      readonly kind: "collate";
      readonly value: SqlExpression;
      readonly collation: string;
    }
  | {
      readonly kind: "case";
      readonly subject: SqlExpression | undefined;
      readonly branches: readonly {
        readonly when: SqlExpression;
        readonly then: SqlExpression;
      }[];
      readonly otherwise: SqlExpression | undefined;
    };

type Token =
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "string"; readonly value: string }
  /** Identifiers and keywords; unquoted words are lowercased. */
  | { readonly kind: "word"; readonly value: string; readonly quoted: boolean }
  | { readonly kind: "operator"; readonly text: string }
  | { readonly kind: "symbol"; readonly text: string };

/** Syntax the parser does not model: the caller falls back to the text. */
class UnsupportedExpression extends Error {}

const unsupported = (what: string): never => {
  throw new UnsupportedExpression(`unsupported SQL: ${what}`);
};

const OPERATOR_CHARACTERS = "+-*/<>=~!@#%^&|`?";
const WORD_START = /[A-Za-z_\u0080-\uFFFF]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/** The value of an `E'…'` string body. */
const unescape = (body: string): string =>
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

const tokenize = (sql: string): Token[] => {
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

const COMPARISONS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);
/** Keywords that end an operand, so they never read as column names. */
const RESERVED = new Set([
  "all",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "between",
  "case",
  "cast",
  "collate",
  "desc",
  "distinct",
  "else",
  "end",
  "escape",
  "exists",
  "false",
  "from",
  "ilike",
  "in",
  "is",
  "isnull",
  "like",
  "not",
  "notnull",
  "null",
  "or",
  "order",
  "select",
  "similar",
  "some",
  "then",
  "true",
  "when",
]);
/** Keywords PostgreSQL evaluates like functions without parentheses. */
const VALUE_FUNCTIONS = new Set([
  "current_date",
  "current_time",
  "current_timestamp",
  "localtime",
  "localtimestamp",
  "current_user",
  "current_role",
  "session_user",
  "current_catalog",
  "current_schema",
]);
/** Type names written before a string literal: `interval '1 day'`. */
const TYPED_LITERALS = new Set([
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "interval",
  "boolean",
  "integer",
  "numeric",
  "text",
  "uuid",
  "json",
  "jsonb",
]);

/**
 * Binding power of each infix form, PostgreSQL's precedence from loosest:
 * OR, AND, NOT, IS, comparisons, BETWEEN/IN/LIKE, other operators, + -, * / %,
 * ^, COLLATE, unary + -, [ ], ::.
 */
const POWER = {
  or: 1,
  and: 2,
  not: 3,
  is: 4,
  comparison: 5,
  membership: 6,
  operator: 7,
  additive: 8,
  multiplicative: 9,
  exponent: 10,
  collate: 12,
  unary: 13,
  subscript: 14,
  cast: 15,
} as const;

export const parseExpression = (sql: string): SqlExpression => {
  const tokens = tokenize(sql);
  let position = 0;

  const peek = (offset = 0): Token | undefined => tokens[position + offset];
  const next = (): Token => tokens[position++] ?? unsupported("the end");

  const isWord = (token: Token | undefined, ...values: string[]): boolean =>
    token?.kind === "word" && !token.quoted && values.includes(token.value);

  const isSymbol = (token: Token | undefined, text: string): boolean =>
    token?.kind === "symbol" && token.text === text;

  const expectSymbol = (text: string): void => {
    if (!isSymbol(next(), text)) {
      unsupported(`a missing ${text}`);
    }
  };

  const expectWord = (value: string): void => {
    if (!isWord(next(), value)) {
      unsupported(`a missing ${value.toUpperCase()}`);
    }
  };

  const list = (close: string): SqlExpression[] => {
    const values: SqlExpression[] = [];

    if (isSymbol(peek(), close)) {
      next();

      return values;
    }

    for (;;) {
      values.push(expression(0));
      const token = next();

      if (isSymbol(token, close)) {
        return values;
      }

      if (!isSymbol(token, ",")) {
        unsupported("a list");
      }
    }
  };

  /** A type after `::` or `AS`: `double precision`, `character varying(20)[]`, `"Role"`. */
  const typeName = (): string => {
    const token = next();

    if (token.kind !== "word") {
      return unsupported("a type name");
    }

    let name = token.value;

    if (!token.quoted) {
      if (name === "double" && isWord(peek(), "precision")) {
        next();
        name = "double precision";
      } else if (
        ["character", "char", "bit"].includes(name) &&
        isWord(peek(), "varying")
      ) {
        next();
        name = `${name === "bit" ? "bit" : "character"} varying`;
      }
    }

    while (isSymbol(peek(), ".") && peek(1)?.kind === "word") {
      next();
      const part = next() as Extract<Token, { kind: "word" }>;
      name = part.value;
    }

    let modifiers = "";

    if (isSymbol(peek(), "(")) {
      next();
      const values: string[] = [];

      for (;;) {
        const value = next();

        if (value.kind !== "number") {
          unsupported("a type modifier");
        }

        values.push((value as { text: string }).text);
        const separator = next();

        if (isSymbol(separator, ")")) {
          break;
        }

        if (!isSymbol(separator, ",")) {
          unsupported("a type modifier");
        }
      }

      modifiers = `(${values.join(",")})`;
    }

    let zone = "";

    if (
      !token.quoted &&
      ["timestamp", "time"].includes(name) &&
      isWord(peek(), "with", "without") &&
      isWord(peek(1), "time") &&
      isWord(peek(2), "zone")
    ) {
      zone = ` ${(next() as { value: string }).value} time zone`;
      next();
      next();
    }

    let dimensions = "";

    while (isSymbol(peek(), "[")) {
      next();

      if (peek()?.kind === "number") {
        next();
      }

      expectSymbol("]");
      dimensions += "[]";
    }

    return token.quoted
      ? `"${name}"${modifiers}${dimensions}`
      : normalizeSqlType(`${name}${modifiers}${zone}${dimensions}`);
  };

  const caseExpression = (): SqlExpression => {
    const subject = isWord(peek(), "when") ? undefined : expression(0);
    const branches: { when: SqlExpression; then: SqlExpression }[] = [];

    while (isWord(peek(), "when")) {
      next();
      const when = expression(0);
      expectWord("then");
      branches.push({ when, then: expression(0) });
    }

    let otherwise: SqlExpression | undefined;

    if (isWord(peek(), "else")) {
      next();
      otherwise = expression(0);
    }

    expectWord("end");

    return branches.length
      ? { kind: "case", subject, branches, otherwise }
      : unsupported("CASE without WHEN");
  };

  const prefix = (): SqlExpression => {
    const token = next();

    switch (token.kind) {
      case "number":
        return { kind: "constant", value: token.text, numeric: true };
      case "string":
        return { kind: "constant", value: token.value, numeric: false };
      case "operator":
        return token.text === "-" || token.text === "+"
          ? {
              kind: "unary",
              operator: token.text,
              value: expression(POWER.unary),
            }
          : {
              kind: "unary",
              operator: token.text,
              value: expression(POWER.operator),
            };
      case "symbol": {
        if (token.text !== "(") {
          return unsupported(`"${token.text}"`);
        }

        const inner = expression(0);
        expectSymbol(")");

        return inner;
      }
      case "word":
        break;
    }

    const word = token as Extract<Token, { kind: "word" }>;

    if (!word.quoted) {
      switch (word.value) {
        case "true":
        case "false":
          return { kind: "boolean", value: word.value === "true" };
        case "null":
          return { kind: "null" };
        case "not":
          return { kind: "not", value: expression(POWER.not) };
        case "case":
          return caseExpression();
        case "array": {
          expectSymbol("[");

          return { kind: "array", values: list("]") };
        }
        case "cast": {
          expectSymbol("(");
          const value = expression(0);
          expectWord("as");
          const type = typeName();
          expectSymbol(")");

          return { kind: "cast", value, type };
        }
        default:
      }

      if (RESERVED.has(word.value)) {
        return unsupported(word.value.toUpperCase());
      }

      if (VALUE_FUNCTIONS.has(word.value) && !isSymbol(peek(), "(")) {
        return { kind: "call", name: word.value, arguments: [] };
      }

      if (TYPED_LITERALS.has(word.value) && peek()?.kind === "string") {
        const literal = next() as { value: string };

        return {
          kind: "cast",
          value: { kind: "constant", value: literal.value, numeric: false },
          type: normalizeSqlType(word.value),
        };
      }
    }

    let name = word.value;

    if (isSymbol(peek(), ".")) {
      // Only functions are qualified here: `pg_catalog.lower(…)`.
      while (isSymbol(peek(), ".")) {
        next();
        const part = next();

        if (part.kind !== "word") {
          unsupported("a qualified name");
        }

        name = `${name}.${(part as { value: string }).value}`;
      }

      if (!isSymbol(peek(), "(")) {
        unsupported("a qualified column");
      }
    }

    if (isSymbol(peek(), "(")) {
      next();

      if (isWord(peek(), "distinct", "all", "variadic")) {
        unsupported("an aggregate or variadic call");
      }

      if (
        peek()?.kind === "operator" &&
        (peek() as { text: string }).text === "*"
      ) {
        next();
        expectSymbol(")");

        return {
          kind: "call",
          name: name.replace(/^pg_catalog\./, ""),
          arguments: [{ kind: "column", name: "*" }],
        };
      }

      return {
        kind: "call",
        name: name.replace(/^pg_catalog\./, ""),
        arguments: list(")"),
      };
    }

    return { kind: "column", name };
  };

  /** The infix or postfix form at the next token when it binds tighter than `minimum`. */
  const infix = (
    left: SqlExpression,
    minimum: number,
  ): SqlExpression | undefined => {
    const token = peek();

    if (!token) {
      return undefined;
    }

    if (token.kind === "symbol") {
      if (token.text === "::" && POWER.cast > minimum) {
        next();

        return { kind: "cast", value: left, type: typeName() };
      }

      if (token.text === "[" && POWER.subscript > minimum) {
        unsupported("a subscript");
      }

      return undefined;
    }

    if (token.kind === "operator") {
      const operator = token.text === "!=" ? "<>" : token.text;
      const power = COMPARISONS.has(operator)
        ? POWER.comparison
        : ["+", "-"].includes(operator)
          ? POWER.additive
          : ["*", "/", "%"].includes(operator)
            ? POWER.multiplicative
            : operator === "^"
              ? POWER.exponent
              : POWER.operator;

      if (power <= minimum) {
        return undefined;
      }

      next();

      if (isWord(peek(), "any", "some", "all") && isSymbol(peek(1), "(")) {
        const quantifier = isWord(next(), "all") ? "ALL" : "ANY";
        next();

        if (isWord(peek(), "select")) {
          unsupported("a subquery");
        }

        const right = expression(0);
        expectSymbol(")");

        return { kind: "quantified", operator, quantifier, left, right };
      }

      return { kind: "binary", operator, left, right: expression(power) };
    }

    if (token.kind !== "word" || token.quoted) {
      return undefined;
    }

    const negated =
      token.value === "not" &&
      isWord(peek(1), "between", "in", "like", "ilike", "similar");
    const keyword = negated
      ? (peek(1) as { value: string }).value
      : token.value;

    switch (keyword) {
      case "or":
      case "and": {
        const power = keyword === "or" ? POWER.or : POWER.and;

        if (power <= minimum) {
          return undefined;
        }

        next();

        return {
          kind: "logical",
          operator: keyword === "or" ? "OR" : "AND",
          values: [left, expression(power)],
        };
      }
      case "is": {
        if (POWER.is <= minimum) {
          return undefined;
        }

        next();
        const not = isWord(peek(), "not");

        if (not) {
          next();
        }

        const test = next();

        if (isWord(test, "null")) {
          return { kind: "null-test", value: left, negated: not };
        }

        if (isWord(test, "true", "false", "unknown")) {
          return {
            kind: "truth-test",
            value: left,
            test: (test as { value: string }).value.toUpperCase() as
              | "TRUE"
              | "FALSE"
              | "UNKNOWN",
            negated: not,
          };
        }

        if (isWord(test, "distinct")) {
          expectWord("from");

          return {
            kind: "distinct",
            left,
            right: expression(POWER.is),
            negated: not,
          };
        }

        return unsupported("IS");
      }
      case "isnull":
      case "notnull":
        if (POWER.is <= minimum) {
          return undefined;
        }

        next();

        return {
          kind: "null-test",
          value: left,
          negated: keyword === "notnull",
        };
      case "between":
      case "in":
      case "like":
      case "ilike":
      case "similar": {
        if (POWER.membership <= minimum) {
          return undefined;
        }

        next();

        if (negated) {
          next();
        }

        if (keyword === "similar") {
          return unsupported("SIMILAR TO");
        }

        if (keyword === "in") {
          expectSymbol("(");

          if (isWord(peek(), "select")) {
            unsupported("a subquery");
          }

          return { kind: "in", value: left, values: list(")"), negated };
        }

        if (keyword === "between") {
          const symmetric = isWord(peek(), "symmetric");

          if (symmetric || isWord(peek(), "asymmetric")) {
            next();
          }

          const lower = expression(POWER.membership);
          expectWord("and");

          return {
            kind: "between",
            value: left,
            lower,
            upper: expression(POWER.membership),
            negated,
            symmetric,
          };
        }

        const pattern = expression(POWER.membership);

        if (isWord(peek(), "escape")) {
          unsupported("LIKE … ESCAPE");
        }

        return {
          kind: "like",
          value: left,
          pattern,
          operator: keyword === "like" ? "LIKE" : "ILIKE",
          negated,
        };
      }
      case "collate": {
        if (POWER.collate <= minimum) {
          return undefined;
        }

        next();
        let collation = next();

        while (isSymbol(peek(), ".")) {
          next();
          collation = next();
        }

        if (collation.kind !== "word") {
          return unsupported("a collation");
        }

        return { kind: "collate", value: left, collation: collation.value };
      }
      case "at":
        return unsupported("AT TIME ZONE");
      default:
        return undefined;
    }
  };

  const expression = (minimum: number): SqlExpression => {
    let left = prefix();

    for (;;) {
      const extended = infix(left, minimum);

      if (!extended) {
        return left;
      }

      left = extended;
    }
  };

  const result = expression(0);

  if (position < tokens.length) {
    unsupported("trailing tokens");
  }

  return result;
};

const NUMERIC_TYPES =
  /^(integer|bigint|smallint|numeric|real|double precision)(\(|$)/;
/**
 * Types whose cast to text PostgreSQL adds on its own and that compare the
 * same either way; not `char(n)`, which trims, or `citext`, which ignores case.
 */
const TEXT_TYPES = /^(text|character varying)(\(|$)/;
const NEGATED_COMPARISON: Readonly<Record<string, string>> = {
  "=": "<>",
  "<>": "=",
  "<": ">=",
  ">=": "<",
  ">": "<=",
  "<=": ">",
};
const FLIPPED_COMPARISON: Readonly<Record<string, string>> = {
  "=": "=",
  "<>": "<>",
  "<": ">",
  ">": "<",
  "<=": ">=",
  ">=": "<=",
};
const LIKE_OPERATORS: Readonly<
  Record<string, { operator: "LIKE" | "ILIKE"; negated: boolean }>
> = {
  "~~": { operator: "LIKE", negated: false },
  "~~*": { operator: "ILIKE", negated: false },
  "!~~": { operator: "LIKE", negated: true },
  "!~~*": { operator: "ILIKE", negated: true },
};

/** `0042` and `42` are one integer; other numbers keep their digits. */
const canonicalNumber = (text: string): string => {
  const value = text.replace(/^\+/, "");

  return /^-?\d+$/.test(value) ? BigInt(value).toString() : value.toLowerCase();
};

const isLiteral = (node: SqlExpression): boolean =>
  node.kind === "constant" || node.kind === "boolean" || node.kind === "null";

/**
 * Rewrites an expression into the form both renderings share, keeping its
 * meaning: casts on literals and PostgreSQL's implicit casts of text columns
 * (`(nick)::text` for a varchar) go, `IN` replaces `= ANY (ARRAY[…])`, `LIKE`
 * replaces `~~`, `BETWEEN` becomes its two comparisons, a literal moves to the
 * right of a comparison, `x = true` becomes `x`, `NOT` folds into the test it
 * negates and nested AND/OR flatten. `columns` maps column names to SQL types.
 */
export const simplifyExpression = (
  node: SqlExpression,
  columns: ReadonlyMap<string, string> = new Map(),
): SqlExpression => {
  const simplify = (current: SqlExpression): SqlExpression =>
    simplifyExpression(current, columns);

  switch (node.kind) {
    case "constant":
      return node.numeric
        ? { ...node, value: canonicalNumber(node.value) }
        : node;
    case "boolean":
    case "null":
    case "column":
      return node;
    case "cast": {
      const value = simplify(node.value);

      if (value.kind === "constant") {
        return NUMERIC_TYPES.test(node.type) && /^[+-]?[\d.]/.test(value.value)
          ? {
              kind: "constant",
              value: canonicalNumber(value.value),
              numeric: true,
              type: node.type,
            }
          : { ...value, type: node.type };
      }

      if (value.kind === "null") {
        return value;
      }

      if (value.kind === "array" && value.values.every(isLiteral)) {
        return value;
      }

      if (value.kind === "column") {
        const type = columns.get(value.name);
        const own = type === undefined ? undefined : normalizeSqlType(type);

        if (
          own !== undefined &&
          (own === node.type ||
            (TEXT_TYPES.test(own) && TEXT_TYPES.test(node.type)))
        ) {
          return value;
        }
      }

      return { ...node, value };
    }
    case "unary": {
      const value = simplify(node.value);

      if (value.kind === "constant" && value.numeric) {
        if (node.operator === "+") {
          return value;
        }

        if (node.operator === "-") {
          return {
            ...value,
            value: value.value.startsWith("-")
              ? value.value.slice(1)
              : canonicalNumber(`-${value.value}`),
          };
        }
      }

      return { ...node, value };
    }
    case "call":
      return { ...node, arguments: node.arguments.map(simplify) };
    case "binary": {
      let left = simplify(node.left);
      let right = simplify(node.right);
      let operator = node.operator;
      const like = LIKE_OPERATORS[operator];

      if (like) {
        return { kind: "like", value: left, pattern: right, ...like };
      }

      if (FLIPPED_COMPARISON[operator] === undefined) {
        return { ...node, left, right };
      }

      if (isLiteral(left) && !isLiteral(right)) {
        [left, right] = [right, left];
        operator = FLIPPED_COMPARISON[operator]!;
      }

      // `x = true` holds exactly when x does, NULL included; `x = false` is `NOT x`.
      if (right.kind === "boolean" && (operator === "=" || operator === "<>")) {
        return right.value === (operator === "=")
          ? left
          : simplify({ kind: "not", value: left });
      }

      return { kind: "binary", operator, left, right };
    }
    case "not": {
      const value = simplify(node.value);

      switch (value.kind) {
        case "not":
          return value.value;
        case "boolean":
          return { kind: "boolean", value: !value.value };
        case "null-test":
        case "in":
        case "like":
        case "distinct":
        case "truth-test":
          return { ...value, negated: !value.negated };
        case "binary":
          return NEGATED_COMPARISON[value.operator]
            ? { ...value, operator: NEGATED_COMPARISON[value.operator]! }
            : { kind: "not", value };
        case "logical":
          // NOT BETWEEN reads as NOT (x >= a AND x <= b); PostgreSQL stores x < a OR x > b.
          return value.operator === "AND" &&
            value.values.length === 2 &&
            value.values.every(
              (entry) =>
                entry.kind === "binary" &&
                NEGATED_COMPARISON[entry.operator] !== undefined,
            )
            ? simplify({
                kind: "logical",
                operator: "OR",
                values: value.values.map((entry) => ({
                  kind: "not",
                  value: entry,
                })),
              })
            : { kind: "not", value };
        default:
          return { kind: "not", value };
      }
    }
    case "logical": {
      const values = node.values
        .map(simplify)
        .flatMap((value) =>
          value.kind === "logical" && value.operator === node.operator
            ? value.values
            : [value],
        );

      return values.length === 1 ? values[0]! : { ...node, values };
    }
    case "null-test":
    case "truth-test":
      return { ...node, value: simplify(node.value) };
    case "distinct": {
      const left = simplify(node.left);
      const right = simplify(node.right);

      return isLiteral(left) && !isLiteral(right)
        ? { ...node, left: right, right: left }
        : { ...node, left, right };
    }
    case "in": {
      const value = simplify(node.value);
      const values = node.values.map(simplify);

      return values.length === 1
        ? {
            kind: "binary",
            operator: node.negated ? "<>" : "=",
            left: value,
            right: values[0]!,
          }
        : { ...node, value, values };
    }
    case "quantified": {
      const left = simplify(node.left);
      const right = simplify(node.right);

      if (
        right.kind === "array" &&
        ((node.operator === "=" && node.quantifier === "ANY") ||
          (node.operator === "<>" && node.quantifier === "ALL"))
      ) {
        return simplify({
          kind: "in",
          value: left,
          values: right.values,
          negated: node.operator === "<>",
        });
      }

      return { ...node, left, right };
    }
    case "array":
      return { ...node, values: node.values.map(simplify) };
    case "between": {
      if (node.symmetric) {
        return {
          ...node,
          value: simplify(node.value),
          lower: simplify(node.lower),
          upper: simplify(node.upper),
        };
      }

      // PostgreSQL stores BETWEEN as these comparisons.
      const comparisons: SqlExpression = {
        kind: "logical",
        operator: "AND",
        values: [
          {
            kind: "binary",
            operator: ">=",
            left: node.value,
            right: node.lower,
          },
          {
            kind: "binary",
            operator: "<=",
            left: node.value,
            right: node.upper,
          },
        ],
      };

      return simplify(
        node.negated ? { kind: "not", value: comparisons } : comparisons,
      );
    }
    case "like":
      return {
        ...node,
        value: simplify(node.value),
        pattern: simplify(node.pattern),
      };
    case "collate":
      return { ...node, value: simplify(node.value) };
    case "case":
      return {
        ...node,
        subject: node.subject && simplify(node.subject),
        branches: node.branches.map((branch) => ({
          when: simplify(branch.when),
          then: simplify(branch.then),
        })),
        otherwise: node.otherwise && simplify(node.otherwise),
      };
  }
};

const quoted = (text: string, quote: string): string =>
  `${quote}${text.replaceAll(quote, quote + quote)}${quote}`;

/** Fully parenthesized text of a simplified tree: equal texts, equal expressions. */
const printKey = (node: SqlExpression): string => {
  switch (node.kind) {
    case "constant":
      // A real literal compares in single precision, unlike the same digits elsewhere.
      return `${quoted(node.value, "'")}${node.type === "real" ? "::real" : ""}`;
    case "boolean":
      return node.value ? "TRUE" : "FALSE";
    case "null":
      return "NULL";
    case "column":
      return node.name === "*" ? "*" : quoted(node.name, '"');
    case "cast":
      return `CAST(${printKey(node.value)} AS ${node.type})`;
    case "call":
      return `${node.name}(${node.arguments.map(printKey).join(", ")})`;
    case "binary":
      return `(${printKey(node.left)} ${node.operator} ${printKey(node.right)})`;
    case "unary":
      return `(${node.operator}${printKey(node.value)})`;
    case "not":
      return `(NOT ${printKey(node.value)})`;
    case "logical":
      return `(${node.values.map(printKey).join(` ${node.operator} `)})`;
    case "null-test":
      return `(${printKey(node.value)} IS ${node.negated ? "NOT " : ""}NULL)`;
    case "truth-test":
      return `(${printKey(node.value)} IS ${node.negated ? "NOT " : ""}${node.test})`;
    case "distinct":
      return `(${printKey(node.left)} IS ${node.negated ? "NOT " : ""}DISTINCT FROM ${printKey(node.right)})`;
    case "in":
      return `(${printKey(node.value)} ${node.negated ? "NOT " : ""}IN (${node.values.map(printKey).join(", ")}))`;
    case "quantified":
      return `(${printKey(node.left)} ${node.operator} ${node.quantifier} (${printKey(node.right)}))`;
    case "array":
      return `ARRAY[${node.values.map(printKey).join(", ")}]`;
    case "between":
      return `(${printKey(node.value)} ${node.negated ? "NOT " : ""}BETWEEN${node.symmetric ? " SYMMETRIC" : ""} ${printKey(node.lower)} AND ${printKey(node.upper)})`;
    case "like":
      return `(${printKey(node.value)} ${node.negated ? "NOT " : ""}${node.operator} ${printKey(node.pattern)})`;
    case "collate":
      return `(${printKey(node.value)} COLLATE ${quoted(node.collation, '"')})`;
    case "case":
      return `(CASE${node.subject ? ` ${printKey(node.subject)}` : ""} ${node.branches.map((branch) => `WHEN ${printKey(branch.when)} THEN ${printKey(branch.then)}`).join(" ")}${node.otherwise ? ` ELSE ${printKey(node.otherwise)}` : ""} END)`;
  }
};

/**
 * The comparison key of a CHECK expression, index predicate or key expression:
 * two expressions with equal keys are the same expression. SQL the parser does
 * not model is compared by its text, with whitespace collapsed.
 */
export const expressionKey = (
  sql: string,
  columns?: ReadonlyMap<string, string>,
): string => {
  try {
    return printKey(simplifyExpression(parseExpression(sql), columns));
  } catch (error) {
    if (error instanceof UnsupportedExpression) {
      return sql.replace(/\s+/g, " ").trim();
    }

    throw error;
  }
};

/** Parses and simplifies, or returns undefined for SQL the parser does not model. */
export const readExpression = (
  sql: string,
  columns?: ReadonlyMap<string, string>,
): SqlExpression | undefined => {
  try {
    return simplifyExpression(parseExpression(sql), columns);
  } catch (error) {
    if (error instanceof UnsupportedExpression) {
      return undefined;
    }

    throw error;
  }
};

/** An index key's comparison key: its expression's key, then its ordering. */
export const indexKeyKey = (
  key: string,
  columns?: ReadonlyMap<string, string>,
): string => {
  const ordering = /(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i.exec(
    key,
  )!;

  return `${expressionKey(key.slice(0, ordering.index), columns)}${ordering[0].toUpperCase().replace(/\s+/g, " ")}`;
};
