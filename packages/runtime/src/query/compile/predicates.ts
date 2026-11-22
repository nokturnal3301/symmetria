/**
 * Renders predicate nodes (comparisons, IN lists, JSON checks, subqueries) to SQL.
 */
import { expressionSqlType } from "../plan/metadata";
import { tsquerySql } from "./postgres/search";
import { unconstrained } from "./postgres/render";
import { negatable } from "../expressions/core";
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
      // plain form alone.
      const strict = compilation.shapeOnly
        ? description.predicate
        : negatable(description.predicate);

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
      const left = operandSql(compilation, description.left, bindings);
      const right = operandSql(compilation, description.right, bindings);
      const comparison = `${left} ${operator} ${right}`;

      if (!nullable || description.right.kind !== "placeholder") {
        return comparison;
      }

      const type = sqlTypeOf(description.left);
      const isNull = description.nullCheck
        ? predicateSql(compilation, description.nullCheck, bindings)
        : `${left} IS NULL`;
      const whenNull = operator === "<>" ? `NOT (${isNull})` : isNull;

      // An enum type's name is not known here to cast the parameter; the
      // comparison comes first, so PostgreSQL takes the type from it. As in
      // the CASE form, each branch is TRUE or FALSE when the other one holds,
      // so not() of it stays exact: bound to null it is the null check alone,
      // and a NULL row never matches a value under = or <>.
      if (type === "enum") {
        return `((${comparison} AND ${right} IS NOT NULL) OR (${right} IS NULL AND ${whenNull}))`;
      }

      const checked = renderer.cast(right, {
        kind: "typed",
        type: type === "derived" ? description.right.sqlType : type,
      });

      return `(CASE WHEN ${checked} IS NULL THEN ${whenNull} ELSE ${comparison} END)`;
    }
    case "between": {
      const operand = (node: ValueNode) =>
        operandSql(compilation, node, bindings);

      return `${operand(description.value)} BETWEEN ${operand(description.lower)} AND ${operand(description.upper)}`;
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
      const listType = largeListType(description);
      // A page cursor's fingerprint keeps the list as 3.4.1 and earlier
      // bound it: one parameter per value unless the type is a plain one.
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

        return `${left} ${description.negated ? "<> ALL" : "= ANY"}(${array})`;
      }

      const operand = Array.isArray(description.values)
        ? description.values
            .map((value) => operandSql(compilation, value, bindings))
            .join(", ")
        : compilation.selectSql(description.values as SelectPlan, bindings);

      return `${left} ${description.negated ? "NOT " : ""}IN (${operand})`;
    }
  }
};
