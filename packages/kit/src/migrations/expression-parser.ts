/**
 * Parses the SQL of a CHECK constraint, an index predicate or an index key
 * into an expression tree, with PostgreSQL's operator precedence.
 */
import { normalizeSqlType } from "./drift";
import { type SqlExpression, unsupported } from "./expression-tree";
import { type Token, tokenize } from "./expression-lexer";

export const COMPARISONS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);
/** Keywords that end an operand, so they never read as column names. */
export const RESERVED = new Set([
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
export const VALUE_FUNCTIONS = new Set([
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
export const TYPED_LITERALS = new Set([
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
export const POWER = {
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
