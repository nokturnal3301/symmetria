/**
 * Renders predicate nodes (comparisons, IN lists, JSON checks, subqueries) to SQL.
 */
import { expressionSqlType } from "../plan/metadata";
import { isJsonType } from "./postgres/values";
import type { PredicateDescription, ValueNode } from "../expressions";
import type { SelectPlan } from "../plan/types";
import {
  parameter,
  renderContext,
  type Bindings,
  type Compilation,
} from "./state";
import { jsonPrecisionSql, operandSql, searchVector, valueSql } from "./values";

const JSON_COMPARISONS = new Set(["=", "<>", "IS", "IS NOT"]);

const sqlTypeOf = (node: ValueNode): string =>
  expressionSqlType({ node, outputName: "value" });

/** Lists longer than this bind as a single PostgreSQL array parameter. */
const LARGE_LIST_THRESHOLD = 1000;

const largeListType = (
  description: Extract<PredicateDescription, { kind: "membership" }>,
): string | undefined => {
  if (
    !Array.isArray(description.values) ||
    description.values.length <= LARGE_LIST_THRESHOLD ||
    !description.values.every(
      (value: ValueNode) => value.kind === "parameter" && !value.cast,
    )
  ) {
    return undefined;
  }

  const type = sqlTypeOf(description.value);

  return /^(?:smallint|integer|bigint|text|uuid|boolean|timestamptz|date|(?:numeric|varchar|character varying)(?:\(\d+(?:,\s*\d+)?\))?)$/.test(
    type,
  )
    ? type
    : undefined;
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
    case "not":
      return `NOT (${predicateSql(compilation, description.predicate, bindings)})`;
    case "notTrue":
      return `(${predicateSql(compilation, description.predicate, bindings)}) IS NOT TRUE`;
    case "nullCheck":
      return `${operandSql(compilation, description.value, bindings)} IS ${description.negated ? "NOT " : ""}NULL`;
    case "comparison": {
      const operator = renderer.comparisonOperator(description.operator);
      const json =
        JSON_COMPARISONS.has(operator) &&
        isJsonType(sqlTypeOf(description.left));
      const nullable =
        description.nullableParameter &&
        description.right.kind === "placeholder";
      const left = operandSql(compilation, description.left, bindings);
      const right = operandSql(compilation, description.right, bindings);
      const comparison = json
        ? renderer.jsonComparison(
            left,
            right,
            operator as "=" | "<>" | "IS" | "IS NOT",
          )
        : `${left} ${operator} ${right}`;

      if (!nullable || description.right.kind !== "placeholder") {
        return comparison;
      }

      const type = sqlTypeOf(description.left);

      if (type === "enum") {
        return `${left} ${renderer.comparisonOperator(operator === "<>" ? "IS DISTINCT FROM" : "IS NOT DISTINCT FROM")} ${right}`;
      }

      const checked = renderer.cast(right, {
        kind: "typed",
        type: type === "derived" ? description.right.sqlType : type,
      });

      return `(CASE WHEN ${checked} IS NULL THEN ${left} IS ${operator === "<>" ? "NOT " : ""}NULL ELSE ${comparison} END)`;
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
        renderer.searchQuery(
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
      const arrayType = largeListType(description);

      if (arrayType) {
        const values = (description.values as readonly ValueNode[]).map(
          (value) => (value as Extract<ValueNode, { kind: "parameter" }>).value,
        );

        return `${left} ${description.negated ? "<> ALL" : "= ANY"}(${renderer.cast(parameter(compilation, values), { kind: "typed", type: `${arrayType}[]` })})`;
      }

      const operand = Array.isArray(description.values)
        ? {
            kind: "list" as const,
            values: description.values.map((value) =>
              operandSql(compilation, value, bindings),
            ),
          }
        : {
            kind: "subquery" as const,
            sql: compilation.selectSql(
              description.values as SelectPlan,
              bindings,
            ),
            column: (description.values as SelectPlan).selection[0]!.outputName,
          };

      if (isJsonType(sqlTypeOf(description.value))) {
        return renderer.jsonMembership(
          left,
          operand,
          description.negated,
          renderContext(compilation, bindings),
        );
      }

      return `${left} ${description.negated ? "NOT " : ""}IN (${operand.kind === "list" ? operand.values.join(", ") : operand.sql})`;
    }
  }
};
