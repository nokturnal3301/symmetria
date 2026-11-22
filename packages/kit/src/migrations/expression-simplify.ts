/**
 * Rewrites an expression tree into the form PostgreSQL's printing and the
 * schema DSL's rendering share, keeping its meaning.
 */
import { normalizeSqlType } from "./drift";
import type { SqlExpression } from "./expression-tree";

export const NUMERIC_TYPES =
  /^(integer|bigint|smallint|numeric|real|double precision)(\(|$)/;
/**
 * Types whose cast to text PostgreSQL adds on its own and that compare the
 * same either way; not `char(n)`, which trims, or `citext`, which ignores case.
 */
export const TEXT_TYPES = /^(text|character varying)(\(|$)/;
/** The text types without a length: a cast to one never truncates. */
export const UNBOUNDED_TEXT = /^(text|character varying)$/;
export const NEGATED_COMPARISON: Readonly<Record<string, string>> = {
  "=": "<>",
  "<>": "=",
  "<": ">=",
  ">=": "<",
  ">": "<=",
  "<=": ">",
};
export const FLIPPED_COMPARISON: Readonly<Record<string, string>> = {
  "=": "=",
  "<>": "<>",
  "<": ">",
  ">": "<",
  "<=": ">=",
  ">=": "<=",
};
export const LIKE_OPERATORS: Readonly<
  Record<string, { operator: "LIKE" | "ILIKE"; negated: boolean }>
> = {
  "~~": { operator: "LIKE", negated: false },
  "~~*": { operator: "ILIKE", negated: false },
  "!~~": { operator: "LIKE", negated: true },
  "!~~*": { operator: "ILIKE", negated: true },
};

/** `0042` and `42` are one integer; other numbers keep their digits. */
export const canonicalNumber = (text: string): string => {
  const value = text.replace(/^\+/, "");

  return /^-?\d+$/.test(value) ? BigInt(value).toString() : value.toLowerCase();
};

export const INTEGER_TYPES = /^(integer|bigint|smallint)$/;
export const LENGTH_TYPES = /^(?:character varying|character|char)\((\d+)\)$/;
export const SCALE_TYPES = /^numeric\(\d+(?:,(\d+))?\)$/;

/**
 * Whether a cast gives a literal another value, so it is no rendering detail:
 * `'abc'::varchar(2)` is `'ab'`, `1.9::integer` is `2` and `1.25::numeric(3,1)`
 * is `1.3`. The casts PostgreSQL prints on its own (`'a'::text`,
 * `'-100'::integer`) never do.
 */
export const castChangesLiteral = (
  literal: Extract<SqlExpression, { kind: "constant" }>,
  type: string,
): boolean => {
  const length = LENGTH_TYPES.exec(type);

  if (length) {
    return [...literal.value].length > Number(length[1]);
  }

  const fraction = /^[+-]?\d*\.(\d*?)0*$/.exec(literal.value)?.[1];

  if (fraction === undefined || fraction === "") {
    return false;
  }

  if (INTEGER_TYPES.test(type)) {
    return true;
  }

  const scale = SCALE_TYPES.exec(type);

  return scale !== null && fraction.length > Number(scale[1] ?? 0);
};

/** The type PostgreSQL names in a literal's cast: `numeric`, not `numeric(10,2)`. */
const castType = (sqlType: string): string =>
  sqlType.startsWith("numeric(") ? "numeric" : sqlType;

export const isLiteral = (node: SqlExpression): boolean =>
  node.kind === "constant" || node.kind === "boolean" || node.kind === "null";

/**
 * Rewrites an expression into the form both renderings share, keeping its
 * meaning: casts that leave a literal's value alone and PostgreSQL's implicit
 * casts of text columns (`(nick)::text` for a varchar) go, `IN` replaces
 * `= ANY (ARRAY[…])`, `LIKE` replaces `~~`, `BETWEEN` becomes its two
 * comparisons, a literal moves to the right of a comparison, `x = true`
 * becomes `x`, `NOT` folds into the test it negates and nested AND/OR flatten.
 * `columns` maps column names to SQL types.
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
        if (castChangesLiteral(value, node.type)) {
          return { ...node, value };
        }

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

      // PostgreSQL compares a length-limited string as text and prints that
      // cast: `('abc'::character varying(2))::text`.
      if (
        value.kind === "cast" &&
        UNBOUNDED_TEXT.test(node.type) &&
        LENGTH_TYPES.test(value.type) &&
        (value.value.kind === "constant" ||
          value.type.startsWith("character varying"))
      ) {
        return value;
      }

      if (value.kind === "column") {
        const type = columns.get(value.name);
        const own = type === undefined ? undefined : normalizeSqlType(type);

        if (
          own !== undefined &&
          (own === node.type ||
            (TEXT_TYPES.test(own) && UNBOUNDED_TEXT.test(node.type)))
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

      // A quoted literal compared with a column takes the column's type, as
      // PostgreSQL resolves it and prints it back: `num > E'0'` is stored
      // as `num > '0'::numeric`. Text columns compare as text, which
      // PostgreSQL prints with casts of its own, and are left as they are.
      if (
        left.kind === "column" &&
        right.kind === "constant" &&
        !right.numeric &&
        right.type === undefined
      ) {
        const type = columns.get(left.name);
        const own = type === undefined ? undefined : normalizeSqlType(type);

        if (
          own !== undefined &&
          !TEXT_TYPES.test(own) &&
          !LENGTH_TYPES.test(own) &&
          !own.endsWith("[]")
        ) {
          right = simplify({ kind: "cast", value: right, type: castType(own) });
        }
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
