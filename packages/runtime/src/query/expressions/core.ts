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
import { expressionSource, expressionSqlType } from "../plan/metadata";
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
import { castNode, jsonScalar, arithmetic, isJsonValue } from "./arithmetic";
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

  const right = valueNode(value, description.codec);

  return predicate({
    kind: "comparison",
    left: description.node,
    operator,
    right,
    ...(right.kind === "placeholder" &&
    right.nullable &&
    (operator === "=" || operator === "<>")
      ? { nullableParameter: true as const }
      : {}),
  });
};

export const membership = (
  description: ExpressionDescription,
  values: readonly unknown[] | QueryReference,
  negated: boolean,
): Predicate => {
  if (!Array.isArray(values)) {
    const query = readQuery(values as QueryReference);

    if (query.selection.length !== 1) {
      throw new Error("symmetria: IN requires a single-column subquery");
    }

    return predicate({
      kind: "membership",
      value: description.node,
      values: query,
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

  return predicate({
    kind: "membership",
    value: description.node,
    values: freeze(values.map((value) => valueNode(value, description.codec))),
    negated,
  });
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

export const nullPredicate = (
  description: ExpressionDescription,
  negated: boolean,
): Predicate => {
  // A JSON path reads a missing key as SQL NULL and a key holding JSON null
  // as a JSON value; both decode to null, so both count as null here.
  const check: PredicateDescription = {
    kind: "nullCheck",
    value:
      description.node.kind === "jsonPath" && isJsonValue(description)
        ? freeze({
            kind: "raw",
            parts: freeze([
              "NULLIF(",
              expressionSqlType(description) === "json"
                ? castNode(description.node, "jsonb")
                : description.node,
              ", 'null'::jsonb)",
            ]),
            sqlType: "jsonb",
          })
        : description.node,
    negated,
  };

  // SQL NULL still appears through outer joins, so both forms count as null.
  return storesJsonNull(description)
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

    if (expressionSqlType(description) !== "jsonb") {
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
    const sqlType = expressionSqlType(description);
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

    if (expressionSqlType(description).endsWith("[]")) {
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
    const type = expressionSqlType(description);
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
        ...(!expressionSqlType(description).endsWith("[]")
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
      value: this[COLUMN_EXPRESSION].node,
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
        value: this[COLUMN_EXPRESSION].node,
        query: valueNode(query),
        language: this.searchConfiguration(options.language),
        mode: searchMode(options.mode),
        ...rankOptions(options),
      }),
    });
  }

  searchHeadline(query: unknown, options: SearchHeadlineOptions = {}) {
    const description = this[COLUMN_EXPRESSION];

    if (expressionSqlType(description) === "tsvector") {
      throw new Error(
        "symmetria: searchHeadline() highlights text; call it on the text column, not on a tsvector",
      );
    }

    return createExpression<string | null, "searchHeadline">({
      outputName: "searchHeadline",
      node: freeze({
        kind: "searchHeadline",
        value: description.node,
        query: valueNode(query),
        language: searchLanguage(options.language),
        mode: searchMode(options.mode),
        options: headlineOptions(options),
      }),
    });
  }

  private distance(operator: VectorOperator, name: string, query: unknown) {
    const description = this[COLUMN_EXPRESSION];

    if (!/^vector(\(|$)/.test(expressionSqlType(description))) {
      throw new Error(
        "symmetria: distance operators require a vector column or expression",
      );
    }

    return createExpression<number, string>({
      outputName: name,
      node: freeze({
        kind: "binary",
        left: description.node,
        operator,
        right: valueNode(query, description.codec),
        sqlType: "double precision",
      }),
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

    return predicate({
      kind: "between",
      value: description.node,
      lower: valueNode(lower, description.codec),
      upper: valueNode(upper, description.codec),
    });
  }

  like(pattern: string) {
    return compare(jsonScalar(this[COLUMN_EXPRESSION]), "LIKE", pattern);
  }

  ilike(pattern: string) {
    return compare(jsonScalar(this[COLUMN_EXPRESSION]), "ILIKE", pattern);
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
