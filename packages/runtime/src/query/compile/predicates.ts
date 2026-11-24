/**
 * Renders predicate nodes (comparisons, IN lists, JSON checks, subqueries) to SQL.
 */
import { expressionSqlType } from "../plan/metadata";
import { tsquerySql } from "./postgres/search";
import { unconstrained } from "./postgres/render";
import { canonicalType, isBuiltInType } from "../codecs/type-names";
import {
  bareJsonOperand,
  jsonNullAnswer,
  negatable,
  negatedJsonOperand,
} from "../expressions/core";
import type {
  PredicateDescription,
  ScopePredicate,
  ValueNode,
} from "../expressions";
import type { SelectPlan } from "../plan/types";
import {
  parameter,
  renderContext,
  type Bindings,
  type Compilation,
} from "./state";
import { jsonPrecisionSql, operandSql, searchVector, valueSql } from "./values";

const sqlTypeOf = (node: ValueNode): string =>
  expressionSqlType({ node, outputName: "value" });

/** Lists longer than this bind as a single PostgreSQL array parameter. */
const LARGE_LIST_THRESHOLD = 1000;

/** Types whose values bind as they are, written out as the array's type. */
const PLAIN_LIST_TYPE =
  /^(?:smallint|integer|bigint|text|uuid|boolean|timestamptz|date|(?:numeric|varchar|character varying)(?:\(\d+(?:,\s*\d+)?\))?)$/;

/**
 * How a list longer than 1,000 values binds as one array parameter, or
 * undefined to keep `IN ($1, …)`: the plain types above cast the array to
 * their type (without a length or scale, which would cut or round the
 * values); values bound with a cast (`$n::text::jsonb`, real, a vector) cast
 * the array the same way (`$1::text[]::jsonb[]`); any other type, such as an
 * enum, a timestamp or inet, leaves the array untyped, so PostgreSQL takes
 * its type from the compared value as it does for each `$n` of an IN list.
 */
const largeListType = (
  description: Extract<PredicateDescription, { kind: "membership" }>,
): { readonly cast?: string; readonly type?: string } | undefined => {
  if (
    !Array.isArray(description.values) ||
    description.values.length <= LARGE_LIST_THRESHOLD
  ) {
    return undefined;
  }

  const first = description.values[0] as ValueNode;
  const cast = first.kind === "parameter" ? first.cast : undefined;

  if (
    cast?.endsWith("]") ||
    !description.values.every(
      (value: ValueNode) =>
        value.kind === "parameter" &&
        value.cast === cast &&
        !Array.isArray(value.value),
    )
  ) {
    return undefined;
  }

  if (cast) {
    return { cast };
  }

  const type = sqlTypeOf(description.value);

  return PLAIN_LIST_TYPE.test(type) ? { type } : {};
};

/** Stands for a $scope() filter in a shape-only compilation; never executed. */
const SCOPE_MARKER = "<$scope>";

/**
 * A $scope() filter renders like any predicate, and the compilation records
 * where it landed: its SQL, parameter range, bindings and aliases, so each
 * execution can render the callback's current result in its place. Expression
 * caches stay out of it, so no other clause reuses its parameters.
 */
const scopeSql = (
  compilation: Compilation,
  description: ScopePredicate,
  bindings: Bindings,
): string => {
  if (compilation.shapeOnly) {
    return SCOPE_MARKER;
  }

  const current =
    compilation.scopeValues?.get(description) ?? description.predicate;
  const caches = compilation.expressionCaches;
  const aliases = new Map(compilation.aliasNames);
  const start = compilation.parameters.length;
  compilation.expressionCaches = undefined;

  try {
    const sql = predicateSql(compilation, current, bindings);
    (compilation.scopes ??= []).push({
      description,
      bindings,
      aliases,
      start,
      end: compilation.parameters.length,
      sql,
    });

    return sql;
  } finally {
    compilation.expressionCaches = caches;
  }
};

/**
 * A comparison of a jsonb column read bare, which its btree index and a
 * partial index declared with the same condition serve, written so that JSON
 * null answers NULL, as `NULLIF(column, 'null'::jsonb)` would, in every
 * context (below a raw NOT, in a selected boolean). `answer` is what the bare
 * comparison answers for JSON null, when that is known. In a filter,
 * PostgreSQL drops the constant NULL parts, and the comparison stays one
 * condition of the filter (`"meta" > $1 AND "meta" <> 'null'::jsonb`).
 */
const bareJsonSql = (
  comparison: string,
  operand: string,
  answer: boolean | undefined,
): string => {
  // NULL for JSON null, else TRUE: ANDed, it turns a TRUE for JSON null into NULL.
  const present = `(${operand} <> 'null'::jsonb OR NULL)`;
  // NULL for JSON null, else FALSE: ORed, it turns a FALSE for JSON null into NULL.
  const nulled = `(${operand} = 'null'::jsonb AND NULL)`;

  return answer === true
    ? `(${comparison} AND ${present})`
    : answer === false
      ? `(${comparison} OR ${nulled})`
      : `((${comparison} OR ${nulled}) AND ${present})`;
};

export const predicateSql = (
  compilation: Compilation,
  description: PredicateDescription,
  bindings: Bindings,
): string => {
  const { renderer } = compilation;

  switch (description.kind) {
    case "group":
      if (!description.predicates.length) {
        return description.operator === "AND" ? "TRUE" : "FALSE";
      }

      return `(${description.predicates.map((child) => predicateSql(compilation, child, bindings)).join(` ${description.operator} `)})`;
    case "scope":
      return scopeSql(compilation, description, bindings);
    case "not": {
      const negated = `NOT (${predicateSql(compilation, description.predicate, bindings)})`;
      // `=`, `in()`, `between` and `contains()` answer FALSE for JSON null,
      // which NOT turns into TRUE. The negation of the same predicate with
      // JSON null read as SQL NULL (as isNot() and notIn() read it) only
      // narrows the plain one, so both together are exactly that negation,
      // and the plain one stays as written, as a CHECK or a partial index
      // declares it, for the planner to match. A cursor's shape keeps the
      // plain form alone. Where the strict form differs in one jsonb operand
      // only, a type check of that operand stands for it.
      if (compilation.shapeOnly) {
        return negated;
      }

      const operand = negatedJsonOperand(description.predicate);

      if (operand) {
        return `(${negated} AND (jsonb_typeof(${operandSql(compilation, operand, bindings)}) <> 'null' OR NULL))`;
      }

      const strict = negatable(description.predicate);

      return strict === description.predicate
        ? negated
        : `(${negated} AND NOT (${predicateSql(compilation, strict, bindings)}))`;
    }
    case "notTrue":
      return `(${predicateSql(compilation, description.predicate, bindings)}) IS NOT TRUE`;
    case "nullCheck":
      return `${operandSql(compilation, description.value, bindings)} IS ${description.negated ? "NOT " : ""}NULL`;
    case "comparison": {
      const { operator } = description;
      const nullable =
        description.nullableParameter &&
        description.right.kind === "placeholder";
      // A jsonb column or path compared bare, which its indexes serve,
      // reads JSON null as NULL as its NULLIF() would; a cursor's shape
      // keeps the comparison alone, the form earlier versions sent.
      const left = operandSql(
        compilation,
        description.bareJson
          ? bareJsonOperand(description.left)
          : description.left,
        bindings,
      );
      const right = operandSql(compilation, description.right, bindings);
      // `=` and `@>` are TRUE for JSON null only against JSON null, and stay so.
      const comparison =
        description.bareJson && !compilation.shapeOnly
          ? bareJsonSql(
              `${left} ${operator} ${right}`,
              left,
              operator === "=" || operator === "@>"
                ? false
                : jsonNullAnswer(operator, description.right),
            )
          : `${left} ${operator} ${right}`;

      if (!nullable || description.right.kind !== "placeholder") {
        return comparison;
      }

      const type = sqlTypeOf(description.left);
      const isNull = description.nullCheck
        ? predicateSql(compilation, description.nullCheck, bindings)
        : `${left} IS NULL`;
      const whenNull = operator === "<>" ? `NOT (${isNull})` : isNull;

      const declared = type === "derived" ? description.right.sqlType : type;

      // The parameter takes the type of its first use. PostgreSQL's own
      // types are named, without a modifier (casts drop it). Any other type
      // (an enum, a domain, an extension's citext) is not named, not even by
      // a customType()'s `base`: a domain's own type would round or check the
      // value before it is compared (an `amount` over numeric(30,10)), and
      // text for citext compares case-sensitively. The comparison comes
      // first, so PostgreSQL takes the parameter's type from the operator,
      // as for a literal: a domain's base type without its modifier, citext
      // itself. As in the CASE form, each branch is FALSE, never NULL, where
      // the other one applies, so not() of it stays exact: bound to null it is
      // the null check alone, and a NULL row never matches a value under = or
      // <>.
      if (!isBuiltInType(canonicalType(declared))) {
        return `((${comparison} AND ${right} IS NOT NULL) OR (${right} IS NULL AND ${whenNull}))`;
      }

      const checked = renderer.cast(right, { kind: "typed", type: declared });

      return `(CASE WHEN ${checked} IS NULL THEN ${whenNull} ELSE ${comparison} END)`;
    }
    case "between": {
      const operand = (node: ValueNode) =>
        operandSql(compilation, node, bindings);

      const value = operand(
        description.bareJson
          ? bareJsonOperand(description.value)
          : description.value,
      );
      const between = `${value} BETWEEN ${operand(description.lower)} AND ${operand(description.upper)}`;

      if (!description.bareJson || compilation.shapeOnly) {
        return between;
      }

      const from = jsonNullAnswer(">=", description.lower);
      const to = jsonNullAnswer("<=", description.upper);

      return bareJsonSql(
        between,
        value,
        from === false || to === false ? false : from && to ? true : undefined,
      );
    }
    case "has": {
      if (description.json) {
        const value = operandSql(compilation, description.value, bindings);
        const element = operandSql(compilation, description.element, bindings);
        const expression = { node: description.element, outputName: "value" };

        return renderer.jsonHas(
          value,
          element,
          {
            overlap: !!description.overlap,
            encoded:
              description.element.kind === "parameter" ||
              description.element.kind === "placeholder",
            elementArray: expressionSqlType(expression).endsWith("[]"),
            operand: jsonPrecisionSql(compilation, expression, element),
          },
          renderContext(compilation, bindings),
        );
      }

      const element = operandSql(compilation, description.element, bindings);
      const value = operandSql(compilation, description.value, bindings);

      return renderer.arrayHas(value, element);
    }
    case "search":
      return renderer.search(
        searchVector(
          compilation,
          description.value,
          bindings,
          description.language,
        ),
        tsquerySql(
          valueSql(compilation, description.query, bindings),
          description.language,
          description.mode,
        ),
      );
    case "exists":
      return `${description.negated ? "NOT " : ""}EXISTS (${compilation.selectSql(description.query, bindings)})`;
    case "membership": {
      if (Array.isArray(description.values) && !description.values.length) {
        return description.negated ? "TRUE" : "FALSE";
      }

      const left = operandSql(compilation, description.value, bindings);
      // An IN list of a jsonb column or path is FALSE for JSON null, as `=`.
      const bareMembership = (membership: string) =>
        description.bareJson && !compilation.shapeOnly
          ? bareJsonSql(membership, left, false)
          : membership;
      const listType = largeListType(description);
      // A page cursor's fingerprint keeps the list as earlier versions bound
      // it, one parameter per value unless the type is a plain one, so their
      // cursors stay valid.
      const arrayType =
        listType && (listType.type || !compilation.shapeOnly)
          ? listType
          : undefined;

      if (arrayType) {
        const values = (description.values as readonly ValueNode[]).map(
          (value) => (value as Extract<ValueNode, { kind: "parameter" }>).value,
        );
        const bound = parameter(compilation, values);
        const array = arrayType.cast
          ? `${bound}::text[]::${unconstrained(arrayType.cast)}[]`
          : arrayType.type
            ? renderer.cast(bound, {
                kind: "typed",
                type: `${arrayType.type}[]`,
              })
            : bound;

        return bareMembership(
          `${left} ${description.negated ? "<> ALL" : "= ANY"}(${array})`,
        );
      }

      const operand = Array.isArray(description.values)
        ? description.values
            .map((value) => operandSql(compilation, value, bindings))
            .join(", ")
        : compilation.selectSql(description.values as SelectPlan, bindings);

      return bareMembership(
        `${left} ${description.negated ? "NOT " : ""}IN (${operand})`,
      );
    }
  }
};
