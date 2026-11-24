/**
 * Column, predicate and ordering handles: the objects behind the fluent API.
 */
import { freeze } from "../plan/freeze";
import {
  codecFor,
  encodeValue,
  cloneParameter,
  type RuntimeCodec,
} from "../codecs";
import {
  QUERY_PLAN,
  type OrderingDescription,
  type QueryReference,
  type SelectPlan,
} from "../plan/types";
import {
  expressionSource,
  expressionSqlType,
  valueSqlType,
} from "../plan/metadata";
import { isVectorType } from "../../schema/column";
import {
  jsonPathDescription,
  jsonPathTarget,
  jsonValueCodec,
} from "./json-path";
import {
  COLUMN_EXPRESSION,
  PREDICATE_EXPRESSION,
  ORDERING_EXPRESSION,
  type ValueNode,
  type ExpressionDescription,
  type SelectedColumn,
  type PredicateDescription,
  type Predicate,
  type Ordering,
} from "./nodes";
import type {
  SearchOptions,
  SearchRankOptions,
  SearchHeadlineOptions,
  VectorOperator,
  QueryColumn,
} from "./column-types";
import {
  asText,
  castNode,
  isTextType,
  jsonScalar,
  arithmetic,
  isJsonValue,
  readsAsString,
} from "./arithmetic";
import {
  searchLanguage,
  searchMode,
  rankOptions,
  headlineOptions,
  matchExpression,
} from "./search";
import { type OptionalPredicate, presentPredicates } from "./functions";

export class PredicateHandle {
  readonly [PREDICATE_EXPRESSION]: PredicateDescription;

  constructor(description: PredicateDescription) {
    this[PREDICATE_EXPRESSION] = freeze(description);
  }

  and(...conditions: OptionalPredicate[]): Predicate {
    return chained(this[PREDICATE_EXPRESSION], "AND", conditions);
  }

  or(...conditions: OptionalPredicate[]): Predicate {
    return chained(this[PREDICATE_EXPRESSION], "OR", conditions);
  }
}

export const predicate = (description: PredicateDescription): Predicate =>
  freeze(new PredicateHandle(description)) as unknown as Predicate;

/**
 * `a.and(b).and(c)` is one flat group, the SQL of `and(a, b, c)`: a group of
 * the same operator takes the new conditions instead of nesting.
 */
export const chained = (
  first: PredicateDescription,
  operator: "AND" | "OR",
  conditions: readonly unknown[],
): Predicate =>
  predicate({
    kind: "group",
    operator,
    predicates: freeze([
      ...(first.kind === "group" && first.operator === operator
        ? first.predicates
        : [first]),
      ...presentPredicates(conditions),
    ]),
  });

/**
 * A `sql` template is a value that can also stand where a condition is
 * expected; it counts as a predicate only there (`readPredicate`).
 */
export const isPredicate = (value: unknown): value is Predicate =>
  typeof value === "object" &&
  value !== null &&
  PREDICATE_EXPRESSION in value &&
  !(COLUMN_EXPRESSION in value);

export const readPredicate = (value: Predicate): PredicateDescription => {
  if (!value || typeof value !== "object" || !(PREDICATE_EXPRESSION in value)) {
    throw new Error(
      "symmetria: expected a SQL predicate, such as column.is(value)",
    );
  }

  return value[PREDICATE_EXPRESSION];
};

export const readColumn = (value: SelectedColumn): ExpressionDescription => {
  if (!value || typeof value !== "object" || !(COLUMN_EXPRESSION in value)) {
    throw new Error("symmetria: expected a column or SQL expression");
  }

  return value[COLUMN_EXPRESSION];
};

export const valueNode = (value: unknown, codec?: RuntimeCodec): ValueNode => {
  if (value && typeof value === "object" && COLUMN_EXPRESSION in value) {
    const node = (value as SelectedColumn)[COLUMN_EXPRESSION].node;

    return node.kind === "placeholder" && codec
      ? freeze({ ...node, codec })
      : node;
  }

  if (value === undefined) {
    throw new Error("symmetria: undefined is not a SQL value");
  }

  // Cloned as a parameter, a handle would bind as `{}`.
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (PREDICATE_EXPRESSION in value ||
      ORDERING_EXPRESSION in value ||
      QUERY_PLAN in value)
  ) {
    throw new Error(
      QUERY_PLAN in value
        ? "symmetria: a query is not a value; use query.scalar() for its one value, or exists(query) or column.in(query)"
        : `symmetria: ${PREDICATE_EXPRESSION in value ? "a condition" : "an ordering"} is not a value; use it in where or orderBy, or in a sql\`\` template`,
    );
  }

  // Literal shapes instead of spreads: a bulk insert builds one node per value.
  const encoded = cloneParameter(encodeValue(value, codec));
  const cast = codec?.parameterCast;
  const sqlType = codec?.sqlType;

  if (cast) {
    return freeze(
      sqlType
        ? { kind: "parameter", value: encoded, cast, sqlType }
        : { kind: "parameter", value: encoded, cast },
    );
  }

  return freeze(
    sqlType
      ? { kind: "parameter", value: encoded, sqlType }
      : { kind: "parameter", value: encoded },
  );
};

export const readQuery = (query: QueryReference): SelectPlan => {
  if (!query || !(QUERY_PLAN in query) || !query[QUERY_PLAN].selection.length) {
    throw new Error("symmetria: a subquery requires selected fields");
  }

  return query[QUERY_PLAN];
};

export class OrderingHandle {
  readonly [ORDERING_EXPRESSION]: OrderingDescription;

  constructor(description: OrderingDescription) {
    this[ORDERING_EXPRESSION] = freeze(description);
  }

  get nullsFirst(): Ordering {
    return ordering({ ...this[ORDERING_EXPRESSION], nulls: "FIRST" });
  }

  get nullsLast(): Ordering {
    return ordering({ ...this[ORDERING_EXPRESSION], nulls: "LAST" });
  }
}

// Outside the types, `column.asc.desc` would read `undefined`, which an
// orderBy takes for "no ordering" and silently drops.
for (const direction of ["asc", "desc", "ascending", "descending"]) {
  Object.defineProperty(OrderingHandle.prototype, direction, {
    get() {
      throw new Error(
        `symmetria: this ordering already has a direction; remove the second one (.${direction})`,
      );
    },
  });
}

export const ordering = (description: OrderingDescription): Ordering =>
  freeze(new OrderingHandle(description)) as unknown as Ordering;

export type ComparisonOperator = Extract<
  PredicateDescription,
  { kind: "comparison" }
>["operator"];

export const compare = (
  description: ExpressionDescription,
  operator: ComparisonOperator,
  value: unknown,
): Predicate => {
  if (
    (value === null && operator !== "IS DISTINCT FROM") ||
    value === undefined
  ) {
    throw new Error(
      "symmetria: use is(null) or isNot(null) for NULL comparisons",
    );
  }

  let right = valueNode(value, description.codec);
  let left = description;
  // A text column compared with an enum, uuid or date column: PostgreSQL has
  // no operator for the pair, so the other one compares as text.
  const other =
    value && typeof value === "object" && COLUMN_EXPRESSION in value
      ? readColumn(value as never)
      : undefined;

  if (other) {
    if (isTextType(valueSqlType(description)) && readsAsString(other)) {
      right = castNode(right, "text");
    } else if (readsAsString(description) && isTextType(valueSqlType(other))) {
      left = asText(description);
    }
  }

  const nullable =
    right.kind === "placeholder" &&
    right.nullable &&
    (operator === "=" || operator === "<>");
  const nullLike = NULL_LIKE.has(operator);
  const stored = nullLike && storesJsonNull(left);
  // Bound to null, a nullable parameter makes `<>` a null check, which not()
  // negates as written: its NULLIF() stays. `=` and `@>` keep the plain
  // operand, and the statement makes JSON null answer NULL beside it.
  const bareJson = stored
    ? nullable
      ? undefined
      : jsonComparedBare(operator, right)
    : (operator === "=" || operator === "@>") && comparedBare(left)
      ? "compared"
      : undefined;
  // JSON null is null here as in is(null); `=` matches it to no value
  // either way, so it keeps the plain operand an index can serve. So does
  // a NOT NULL jsonb column wherever its comparison can be written bare.
  const operand =
    nullLike &&
    !(stored && operator === "IS DISTINCT FROM" && distinctBare(right))
      ? jsonNullAsNull(left)
      : left.node;

  const comparison = {
    kind: "comparison" as const,
    left: operand,
    operator,
    // IS DISTINCT FROM reads JSON null on its other side as null too, so two
    // JSON nulls are not distinct, and a parameter bound to JSON null is
    // isDistinctFrom(null).
    right:
      operand !== left.node && DISTINCT.has(operator)
        ? distinctOperand(right)
        : right,
  };

  return predicate(
    nullable
      ? {
          ...comparison,
          nullableParameter: true as const,
          // Bound to null, the comparison is is(null): JSON null counts too.
          nullCheck: readPredicate(nullPredicate(description, false)),
          ...(bareJson ? { bareJson } : {}),
        }
      : bareJson
        ? { ...comparison, bareJson }
        : comparison,
  );
};

export const membership = (
  description: ExpressionDescription,
  values: readonly unknown[] | QueryReference,
  negated: boolean,
): Predicate => {
  if (!Array.isArray(values)) {
    // A column, an expression or a prepared parameter is one value.
    if (values == null || !(QUERY_PLAN in Object(values))) {
      throw new Error(
        `symmetria: ${negated ? "notIn()" : "in()"} takes an array of values or a single-column subquery, not ${COLUMN_EXPRESSION in Object(values) ? "a column, expression or prepared parameter" : values == null ? String(values) : `a ${typeof values === "object" ? "plain object" : typeof values}`}; a prepared query's list has a fixed length, one parameter per item (in([p.first, p.second]))`,
      );
    }

    const query = readQuery(values as QueryReference);

    if (query.selection.length !== 1) {
      throw new Error("symmetria: IN requires a single-column subquery");
    }

    // Text against an enum, uuid or date subquery compares as text.
    const [selected] = query.selection as [ExpressionDescription];
    const textual = isTextType(valueSqlType(description));

    return predicate({
      kind: "membership",
      // As for a list, notIn() reads JSON null as SQL NULL.
      value:
        !textual && isTextType(valueSqlType(selected))
          ? asText(description).node
          : negated
            ? jsonNullAsNull(description, true)
            : description.node,
      values:
        textual && readsAsString(selected)
          ? freeze({
              ...query,
              selection: freeze([
                freeze({
                  ...selected,
                  node: castNode(selected.node, "text"),
                }),
              ]),
            })
          : query,
      negated,
    });
  }

  // `x IN (…, NULL)` never matches the NULL and `x NOT IN (…, NULL)` matches
  // no row at all.
  if (values.includes(null)) {
    throw new Error(
      `symmetria: ${negated ? "notIn()" : "in()"} lists cannot contain null; combine the list with ${negated ? "isNot(null)" : "is(null)"}`,
    );
  }

  const list = {
    kind: "membership" as const,
    value: negated ? jsonNullAsNull(description) : description.node,
    values: freeze(values.map((value) => valueNode(value, description.codec))),
    negated,
  };

  return predicate(
    !negated && comparedBare(description)
      ? { ...list, bareJson: "compared" as const }
      : list,
  );
};

/**
 * JS null written to a non-nullable json/jsonb column: the JSON value `null`,
 * checked by the column's codec (a jsonb(schema) validates it). Nullable
 * columns keep null as SQL NULL.
 */
export const jsonNullNode = (
  codec: RuntimeCodec | undefined,
  sqlType: string,
): ValueNode =>
  freeze({
    kind: "parameter",
    value: codec ? codec.encode(null as never) : "null",
    cast: codec?.parameterCast ?? sqlType,
  });

/** A non-nullable jsonb table column, where JS null is stored as JSON null. */
export const storesJsonNull = (description: ExpressionDescription): boolean =>
  description.node.kind === "column" &&
  description.node.description.column.notNull &&
  !description.node.description.binding.projection &&
  expressionSqlType(description) === "jsonb";

/** `NULLIF(value, 'null'::jsonb)`, built by jsonNullAsNull or written so. */
const withoutJsonNullNode = (node: ValueNode): boolean => {
  if (node.kind !== "raw" || node.parts.length !== 3) {
    return false;
  }

  const [open, , close] = node.parts;

  return (
    typeof open === "string" &&
    open.startsWith("NULLIF(") &&
    typeof close === "string" &&
    close.endsWith(", 'null'::jsonb)")
  );
};

/**
 * A JSON path reads a missing key as SQL NULL and a key holding JSON null as
 * a JSON value; both decode to null, so both count as null in conditions. So
 * do JSON null in a NOT NULL or nullable column (JS null is stored as JSON
 * null in the first; an update can store it in the second), a path carried
 * through a CTE or a derived table, and a JSON scalar subquery.
 *
 * `wraps` marks the places where earlier versions compared the operand bare
 * (a NOT NULL jsonb column, a between() from a bound that may sort below JSON
 * null, a notIn() subquery): a page cursor's shape and schema DDL render the
 * operand alone there, the form those versions wrote, so page cursors they
 * issued stay valid and existing checks and indexes do not change.
 */
const jsonNullAsNull = (
  description: ExpressionDescription,
  wraps?: true,
): ValueNode => {
  const { node } = description;

  if (!isJsonValue(description) || withoutJsonNullNode(node)) {
    return node;
  }

  const json = valueSqlType(description) === "json";

  return (wraps ?? storesJsonNull(description))
    ? freeze({
        kind: "raw",
        parts: freeze([
          json ? "NULLIF((" : "NULLIF(",
          node,
          json ? ")::jsonb, 'null'::jsonb)" : ", 'null'::jsonb)",
        ]),
        sqlType: "jsonb",
        delimited: true,
        wraps: true,
      })
    : freeze({
        kind: "raw",
        parts: freeze([
          "NULLIF(",
          json ? castNode(node, "jsonb") : node,
          ", 'null'::jsonb)",
        ]),
        sqlType: "jsonb",
      });
};

/**
 * Whether a between() bound is a JSON value that sorts above JSON null, so
 * that JSON null answers FALSE as a missing path answers NULL: jsonb sorts an
 * empty top-level array below null, and a bound known only when the query
 * runs (a prepared parameter, a column) may be one.
 */
const sortsAboveJsonNull = (node: ValueNode): boolean => {
  if (node.kind !== "parameter" || node.value === null) {
    return node.kind === "parameter";
  }

  if (typeof node.value !== "string") {
    return false;
  }

  try {
    const value: unknown = JSON.parse(node.value);

    return value !== null && !(Array.isArray(value) && !value.length);
  } catch {
    return false;
  }
};

/** JSON null written as a literal value. */
const jsonNullParameter = (node: ValueNode): boolean =>
  node.kind === "parameter" &&
  typeof node.value === "string" &&
  node.value.trim() === "null";

/**
 * `isDistinctFrom(value)` of a NOT NULL jsonb column with a literal that is
 * neither SQL NULL nor JSON null: the column compared bare holds for JSON
 * null already, as NULL does.
 */
const distinctBare = (right: ValueNode): boolean =>
  right.kind === "parameter" &&
  right.value !== null &&
  !jsonNullParameter(right);

const DISTINCT = new Set<ComparisonOperator>([
  "IS DISTINCT FROM",
  "IS NOT DISTINCT FROM",
]);

/**
 * The other side of `IS DISTINCT FROM` beside a left side that reads JSON
 * null as null: a JSON column, expression or parameter does too. A literal
 * is JSON null only when written so. Earlier versions compared this side
 * bare, so a page cursor's shape and schema DDL render it alone, as those
 * versions wrote it (`wraps`).
 */
const distinctOperand = (right: ValueNode): ValueNode =>
  (right.kind === "parameter" && !jsonNullParameter(right)) ||
  !isJsonValue({ node: right, outputName: "value" })
    ? right
    : jsonNullAsNull({ node: right, outputName: "value" }, true);

/**
 * Whether a NOT NULL jsonb column can be compared bare, which its indexes
 * serve, and how the bare comparison answers JSON null: jsonb sorts JSON
 * null below every value but a top-level `[]`, so `>` and `>=` against a
 * literal above it are FALSE for it (`compared`); other bounds and `<`,
 * `<=`, `<>` may be TRUE (`excluded`). The statement makes JSON null answer
 * NULL either way.
 */
const jsonComparedBare = (
  operator: ComparisonOperator,
  right: ValueNode,
): "compared" | "excluded" | undefined =>
  operator === ">" || operator === ">="
    ? right.kind === "parameter" &&
      right.value !== null &&
      sortsAboveJsonNull(right)
      ? "compared"
      : "excluded"
    : operator === "<" || operator === "<=" || operator === "<>"
      ? "excluded"
      : undefined;

/**
 * A jsonb column or JSON path, which `=`, `@>`, an IN list and between()
 * compare bare, as an index on it or a partial index declared with the same
 * condition is written. JSON null answers FALSE there (TRUE for `=` and `@>`
 * only against JSON null), so the statement adds constant-NULL parts that
 * make that FALSE NULL wherever the comparison stands, as for a missing path
 * (see `bareJsonSql`); a filter drops them.
 */
const comparedBare = (description: ExpressionDescription): boolean =>
  (description.node.kind === "column" ||
    description.node.kind === "jsonPath") &&
  valueSqlType(description) === "jsonb";

/** The operand a `bareJson` comparison or between reads bare: the column inside its NULLIF(). */
export const bareJsonOperand = (node: ValueNode): ValueNode =>
  node.kind === "raw" && node.wraps ? (node.parts[1] as ValueNode) : node;

/**
 * What `'null'::jsonb <operator> literal` answers, which is what a bare
 * comparison answers for a row holding JSON null: jsonb sorts JSON null below
 * every value but a top-level `[]`. Undefined when the other side is known
 * only when the query runs (a prepared parameter, a column).
 */
export const jsonNullAnswer = (
  operator: string,
  right: ValueNode,
): boolean | undefined => {
  if (right.kind !== "parameter" || typeof right.value !== "string") {
    return undefined;
  }

  const text = right.value.trim();
  // JSON null against the literal: equal (0), above `[]` (1), below the rest (-1).
  const order = text === "null" ? 0 : /^\[\s*\]$/.test(text) ? 1 : -1;

  switch (operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<>":
      return order !== 0;
    default:
      return undefined;
  }
};

/** A comparison with the JSON null literal, as is(null) of a NOT NULL jsonb column writes it. */
const comparesWithJsonNull = (
  description: Extract<PredicateDescription, { kind: "comparison" }>,
): boolean =>
  description.right.kind === "raw" &&
  description.right.parts.length === 1 &&
  description.right.parts[0] === "'null'::jsonb";

/**
 * The predicate as a query's `not()` negates it. `=`, `in()`, `between` and
 * `contains()` keep the plain JSON operand an index can serve: for JSON null
 * they answer FALSE where a missing path answers NULL, and a filter drops both
 * alike. NOT turns only the FALSE into TRUE, so below a not() those operands
 * read JSON null as SQL NULL, as isNot() and notIn() do, and not(is(x)) leaves
 * out what isNot(x) leaves out. Of a jsonb column or path (`bareJson`) they
 * answer NULL for it already. The same predicate is returned when nothing
 * changes; nested not() and subqueries are compiled on their own. Schema DDL
 * (checks, partial indexes) renders the predicate as written.
 */
export const negatable = (
  description: PredicateDescription,
): PredicateDescription => {
  const operand = (node: ValueNode): ValueNode =>
    jsonNullAsNull({ node, outputName: "value" });

  switch (description.kind) {
    case "group": {
      const predicates = description.predicates.map(negatable);

      return predicates.some(
        (child, position) => child !== description.predicates[position],
      )
        ? freeze({ ...description, predicates: freeze(predicates) })
        : description;
    }
    case "comparison": {
      // `column = 'null'::jsonb` of is(null) is FALSE for every other value.
      // A column compared bare (`bareJson`) answers NULL for JSON null already.
      if (
        description.bareJson ||
        (description.operator !== "=" && description.operator !== "@>") ||
        comparesWithJsonNull(description)
      ) {
        return description;
      }

      const left = operand(description.left);

      return left === description.left
        ? description
        : freeze({ ...description, left });
    }
    case "membership": {
      // Compared bare beside its constant-NULL parts, it answers NULL for
      // JSON null already.
      if (description.bareJson) {
        return description;
      }

      const value = description.negated
        ? description.value
        : operand(description.value);

      return value === description.value
        ? description
        : freeze({ ...description, value });
    }
    case "between": {
      // Compared bare beside its constant-NULL parts, it answers NULL for
      // JSON null already.
      if (description.bareJson) {
        return description;
      }

      const value = operand(description.value);

      return value === description.value
        ? description
        : freeze({ ...description, value });
    }
    default:
      return description;
  }
};

/**
 * The jsonb operand when all that negatable() changes is that one operand of
 * one `=`, `@>`, IN list or between, or undefined. JSON null answers FALSE
 * there and the strict form NULL, so the strict negation is the plain one
 * where the operand is not JSON null, and NULL where it is:
 * `NOT (P) AND (jsonb_typeof(operand) <> 'null' OR NULL)` reads the operand
 * once more but compares it once. A subquery is left out: NULL IN (no rows)
 * is FALSE.
 */
export const negatedJsonOperand = (
  description: PredicateDescription,
): ValueNode | undefined => {
  const node =
    description.kind === "comparison"
      ? description.left
      : description.kind === "membership"
        ? !description.negated &&
          Array.isArray(description.values) &&
          description.values.length
          ? description.value
          : undefined
        : description.kind === "between"
          ? description.value
          : undefined;

  return node &&
    valueSqlType({ node, outputName: "value" }) === "jsonb" &&
    negatable(description) !== description
    ? node
    : undefined;
};

/** Comparisons that tell a NULL operand from a value. */
const NULL_LIKE = new Set<ComparisonOperator>([
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "IS DISTINCT FROM",
  "IS NOT DISTINCT FROM",
]);

export const nullPredicate = (
  description: ExpressionDescription,
  negated: boolean,
): Predicate => {
  const stored = storesJsonNull(description);
  // A NOT NULL jsonb column checks JSON null by comparison, which its index serves.
  const check: PredicateDescription = {
    kind: "nullCheck",
    value: stored ? description.node : jsonNullAsNull(description),
    negated,
  };

  // SQL NULL still appears through outer joins, so both forms count as null.
  return stored
    ? predicate({
        kind: "group",
        operator: negated ? "AND" : "OR",
        predicates: freeze([
          freeze(check),
          freeze({
            kind: "comparison" as const,
            left: description.node,
            operator: negated ? ("<>" as const) : ("=" as const),
            right: freeze({
              kind: "raw" as const,
              parts: freeze(["'null'::jsonb"]),
              sqlType: "jsonb",
            }),
          }),
        ]),
      })
    : predicate(check);
};

/** The labels of the enum column an expression reads, however far it was projected. */
export const enumerationOf = (
  description: ExpressionDescription,
): readonly string[] | undefined => {
  const source = expressionSource(description).node;

  return source.kind === "column"
    ? source.description.column.enumerationValues
    : undefined;
};

/**
 * Callable equality whose enum labels are predicates (`state.is.published`).
 * Anything else reads the function itself, so `is.call`, `is.name` or a
 * `then` probe behave as on any function.
 */
export const equality = (
  description: ExpressionDescription,
  negated: boolean,
) => {
  // Resolved on the first label read: most uses only call the function.
  let labels: readonly string[] | null | undefined;

  return new Proxy(
    (value: unknown) =>
      value === null
        ? nullPredicate(description, negated)
        : compare(description, negated ? "<>" : "=", value),
    {
      get: (target, name) => {
        if (typeof name !== "string") {
          return Reflect.get(target, name);
        }

        if (labels === undefined) {
          labels = enumerationOf(description) ?? null;
        }

        // A label wins over a function property of the same name, such as an
        // enum member "name" or "length". Without an enum column behind it
        // (a `sql<"a" | "b">` template, say) the labels exist only in the
        // types, so every name the function does not own stays a predicate.
        const member = labels
          ? labels.includes(name)
          : name !== "then" && !(name in target);

        return member
          ? compare(description, negated ? "<>" : "=", name)
          : Reflect.get(target, name);
      },
    },
  );
};

export const jsonPathKeys = (
  path: readonly unknown[],
): readonly (string | number)[] => {
  if (
    !path.length ||
    path.some(
      (part) =>
        typeof part !== "string" &&
        !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
    )
  ) {
    throw new Error(
      "symmetria: JSON paths require string keys or nonnegative integer positions",
    );
  }

  return path as readonly (string | number)[];
};

/**
 * A value written inside JSON travels as JSON text, `$n::text::jsonb`, which
 * both drivers bind alike. Without a JSON form (undefined, a function) it
 * would bind NULL, and `jsonb_set` returns NULL for a NULL value.
 */
export const jsonSetCodec: RuntimeCodec = freeze({
  parameterCast: "jsonb",
  encode: (value: unknown) => {
    const text = jsonValueCodec(undefined).encode(value as never);

    if (typeof text !== "string") {
      throw new Error("symmetria: set() needs a JSON value");
    }

    return text;
  },
  decode: (value: unknown) => value,
});

export const JSON_NULL: ValueNode = freeze({
  kind: "raw",
  parts: freeze(["'null'::jsonb"]),
  sqlType: "jsonb",
});

/** The new value of a `set()` as jsonb, never SQL NULL: null is the JSON value null. */
export const jsonSetValue = (value: unknown): ValueNode => {
  if (value === null) {
    return JSON_NULL;
  }

  if (!(value && typeof value === "object" && COLUMN_EXPRESSION in value)) {
    return valueNode(value, jsonSetCodec);
  }

  const description = readColumn(value as SelectedColumn);
  const sqlType = expressionSqlType(description);
  const node =
    description.node.kind === "placeholder"
      ? valueNode(value, jsonSetCodec)
      : sqlType === "jsonb"
        ? description.node
        : sqlType === "json"
          ? castNode(description.node, "jsonb")
          : freeze({
              kind: "raw" as const,
              parts: freeze(["to_jsonb(", description.node, ")"]),
              sqlType: "jsonb",
            });

  return freeze({ kind: "coalesce", values: freeze([node, JSON_NULL]) });
};

export const HANDLE_MEMO = Symbol("symmetria.query.memo");

export type HandleMemo = {
  is?: unknown;
  isNot?: unknown;
  ascending?: Ordering;
  descending?: Ordering;
};

/**
 * Column handles share one prototype; an instance owns only its description and
 * a memo for the accessor results. Objects created from a handle inherit both.
 */
export class ColumnHandle {
  readonly [COLUMN_EXPRESSION]: ExpressionDescription;
  readonly [HANDLE_MEMO]: HandleMemo;

  constructor(description: ExpressionDescription) {
    this[COLUMN_EXPRESSION] = freeze(description);
    this[HANDLE_MEMO] = {};
  }

  get is(): unknown {
    return (this[HANDLE_MEMO].is ??= equality(this[COLUMN_EXPRESSION], false));
  }

  get isNot(): unknown {
    return (this[HANDLE_MEMO].isNot ??= equality(
      this[COLUMN_EXPRESSION],
      true,
    ));
  }

  get ascending(): Ordering {
    return (this[HANDLE_MEMO].ascending ??= ordering({
      expression: this[COLUMN_EXPRESSION],
      direction: "ASC",
    }));
  }

  get descending(): Ordering {
    return (this[HANDLE_MEMO].descending ??= ordering({
      expression: this[COLUMN_EXPRESSION],
      direction: "DESC",
    }));
  }

  /** Short for `ascending`. */
  get asc(): Ordering {
    return this.ascending;
  }

  /** Short for `descending`. */
  get desc(): Ordering {
    return this.descending;
  }

  match(branches: Record<string, unknown>) {
    return matchExpression(this[COLUMN_EXPRESSION], branches);
  }

  path(...path: (string | number)[]) {
    return createExpression(
      jsonPathDescription(this[COLUMN_EXPRESSION], jsonPathKeys(path)),
    );
  }

  set(path: unknown, value: unknown) {
    const description = this[COLUMN_EXPRESSION];

    if (valueSqlType(description) !== "jsonb") {
      throw new Error(
        "symmetria: set() replaces a key inside a jsonb column or expression",
      );
    }

    const keys = jsonPathKeys(Array.isArray(path) ? path : [path]);

    // The keys are bound like those of path(); only the template's text is SQL.
    return createExpression({
      ...description,
      node: freeze({
        kind: "raw",
        parts: freeze([
          "jsonb_set(",
          description.node,
          ", ARRAY[",
          ...keys.flatMap((key, position) => [
            ...(position ? [", "] : []),
            freeze({ kind: "parameter" as const, value: String(key) }),
            "::text",
          ]),
          "], ",
          jsonSetValue(value),
          ", true)",
        ]),
        sqlType: "jsonb",
      }),
    });
  }

  contains(value: unknown) {
    const description = this[COLUMN_EXPRESSION];
    const sqlType = valueSqlType(description);
    const json = sqlType === "json" || sqlType === "jsonb";

    // A containment operand is a partial JSON value: serialize it without the column's schema validation.
    return compare(
      json ? { ...description, codec: codecFor(sqlType)! } : description,
      "@>",
      value,
    );
  }

  overlaps(value: unknown) {
    const description = this[COLUMN_EXPRESSION];

    if (valueSqlType(description).endsWith("[]")) {
      return compare(description, "&&", value);
    }

    return predicate({
      kind: "has",
      value: description.node,
      element: valueNode(value, description.codec),
      json: true,
      overlap: true,
    });
  }

  has(value: unknown) {
    const description = this[COLUMN_EXPRESSION];
    const type = valueSqlType(description);
    const json = !type.endsWith("[]");

    return predicate({
      kind: "has",
      value: description.node,
      element: valueNode(
        value,
        json
          ? jsonValueCodec(jsonPathTarget(description, 0))
          : description.codec?.element,
      ),
      ...(json ? { json: true } : {}),
    });
  }

  length() {
    const description = this[COLUMN_EXPRESSION];

    return createExpression<number, string>({
      outputName: description.outputName,
      node: freeze({
        kind: "arrayLength",
        value: description.node,
        ...(!valueSqlType(description).endsWith("[]")
          ? { json: true as const }
          : {}),
      }),
    });
  }

  /** A searchDocument() carries its own configuration; queries against it default to the same one. */
  private searchConfiguration(language: string | undefined): string {
    const node = this[COLUMN_EXPRESSION].node;

    return searchLanguage(
      language ?? (node.kind === "tsvector" ? node.language : undefined),
    );
  }

  search(query: unknown, options: SearchOptions = {}) {
    return predicate({
      kind: "search",
      value: asText(this[COLUMN_EXPRESSION]).node,
      query: valueNode(query),
      language: this.searchConfiguration(options.language),
      mode: searchMode(options.mode),
    });
  }

  searchRank(query: unknown, options: SearchRankOptions = {}) {
    return createExpression<number, "searchRank">({
      outputName: "searchRank",
      codec: codecFor("real")!,
      node: freeze({
        kind: "searchRank",
        value: asText(this[COLUMN_EXPRESSION]).node,
        query: valueNode(query),
        language: this.searchConfiguration(options.language),
        mode: searchMode(options.mode),
        ...rankOptions(options),
      }),
    });
  }

  searchHeadline(query: unknown, options: SearchHeadlineOptions = {}) {
    const description = this[COLUMN_EXPRESSION];

    if (valueSqlType(description) === "tsvector") {
      throw new Error(
        "symmetria: searchHeadline() highlights text; call it on the text column, not on a tsvector",
      );
    }

    return createExpression<string | null, "searchHeadline">({
      outputName: "searchHeadline",
      node: freeze({
        kind: "searchHeadline",
        value: asText(description).node,
        query: valueNode(query),
        language: searchLanguage(options.language),
        mode: searchMode(options.mode),
        options: headlineOptions(options),
      }),
    });
  }

  private distance(operator: VectorOperator, name: string, query: unknown) {
    const description = this[COLUMN_EXPRESSION];

    if (!isVectorType(valueSqlType(description))) {
      throw new Error(
        "symmetria: distance operators require a vector column or expression",
      );
    }

    const right = valueNode(query, description.codec);

    return createExpression<number, string>({
      outputName: name,
      node: freeze({
        kind: "binary",
        left: description.node,
        operator,
        // A bound vector is read once: `(SELECT $1::text::vector)` is
        // evaluated before the scan. Written bare, a plan PostgreSQL reuses
        // for every value (a kept statement after five runs) converts the
        // text again for each row it compares, about 50 µs for 1024 numbers.
        right:
          right.kind === "parameter" || right.kind === "placeholder"
            ? freeze({
                kind: "raw",
                parts: freeze(["(SELECT ", right, ")"]),
                sqlType: expressionSqlType(description),
                composed: true,
                delimited: true,
                readOnce: true,
              })
            : right,
        sqlType: "double precision",
      }),
      // Inside JSON (a nested result, $batch) a NaN distance is the text "NaN".
      codec: codecFor("double precision")!,
    });
  }

  l2Distance(query: unknown) {
    return this.distance("<->", "l2Distance", query);
  }

  cosineDistance(query: unknown) {
    return this.distance("<=>", "cosineDistance", query);
  }

  innerProduct(query: unknown) {
    return this.distance("<#>", "innerProduct", query);
  }

  l1Distance(query: unknown) {
    return this.distance("<+>", "l1Distance", query);
  }

  as(name: string) {
    if (!name.length) {
      throw new Error("symmetria: column aliases must be nonempty strings");
    }

    return createExpression({ ...this[COLUMN_EXPRESSION], outputName: name });
  }

  above(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], ">", value);
  }

  atLeast(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], ">=", value);
  }

  below(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], "<", value);
  }

  atMost(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], "<=", value);
  }

  isDistinctFrom(value: unknown) {
    return compare(this[COLUMN_EXPRESSION], "IS DISTINCT FROM", value);
  }

  in(values: readonly unknown[] | QueryReference) {
    return membership(this[COLUMN_EXPRESSION], values, false);
  }

  notIn(values: readonly unknown[] | QueryReference) {
    return membership(this[COLUMN_EXPRESSION], values, true);
  }

  between(lower: unknown, upper: unknown) {
    const description = this[COLUMN_EXPRESSION];
    const bound = valueNode(lower, description.codec);
    // Only from a bound above JSON null does it answer FALSE for JSON null.
    const json = isJsonValue(description) && !sortsAboveJsonNull(bound);
    const value = json ? jsonNullAsNull(description, true) : description.node;
    // A jsonb column or path is read bare, which its index serves, with JSON
    // null left out beside it: from a bound above JSON null, BETWEEN is
    // FALSE for it.
    const bare = comparedBare(description);

    return predicate({
      kind: "between",
      value,
      lower: bound,
      upper: valueNode(upper, description.codec),
      ...(bare
        ? { bareJson: json ? ("excluded" as const) : ("compared" as const) }
        : {}),
    });
  }

  like(pattern: string) {
    return compare(
      asText(jsonScalar(this[COLUMN_EXPRESSION])),
      "LIKE",
      pattern,
    );
  }

  ilike(pattern: string) {
    return compare(
      asText(jsonScalar(this[COLUMN_EXPRESSION])),
      "ILIKE",
      pattern,
    );
  }

  plus(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "+", value);
  }

  minus(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "-", value);
  }

  multiply(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "*", value);
  }

  divide(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "/", value);
  }

  quotient(value: unknown) {
    return arithmetic(this[COLUMN_EXPRESSION], "quotient", value);
  }
}

export const createExpression = <
  Value = unknown,
  OutputName extends string = string,
  Traits = {},
>(
  description: ExpressionDescription<OutputName>,
): QueryColumn<Value, OutputName, Traits> =>
  freeze(new ColumnHandle(description)) as unknown as QueryColumn<
    Value,
    OutputName,
    Traits
  >;
