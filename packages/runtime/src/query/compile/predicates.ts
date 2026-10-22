import { encodeValue } from "../codecs";
import { expressionSqlType } from "../metadata";
import { isJsonType } from "../dialect";
import type { SearchOperand } from "../dialects/types";
import type { PredicateDescription, ValueNode } from "../expressions";
import type { SelectPlan } from "../state";
import { renderContext, type Bindings, type Compilation } from "./state";
import { jsonPrecisionSql, valueSql } from "./values";

const JSON_COMPARISONS = new Set(["=", "<>", "IS", "IS NOT"]);

const sqlTypeOf = (node: ValueNode): string =>
  expressionSqlType({ node, outputName: "value" });

/** The search query as the dialect may need it: rendered, literal or re-encoded. */
const searchOperand = (
  compilation: Compilation,
  query: ValueNode,
  bindings: Bindings,
): SearchOperand => ({
  render: () => valueSql(compilation, query, bindings),
  literal:
    query.kind === "parameter" && typeof query.value === "string"
      ? query.value
      : undefined,
  renderEncoded:
    query.kind === "placeholder"
      ? (transform) =>
          valueSql(
            compilation,
            {
              ...query,
              codec: {
                encode: (value) => transform(encodeValue(value, query.codec)),
                decode: (value) => value,
              },
            },
            bindings,
          )
      : undefined,
});

export const predicateSql = (
  compilation: Compilation,
  description: PredicateDescription,
  bindings: Bindings,
): string => {
  const { dialect } = compilation;

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
      return `${valueSql(compilation, description.value, bindings)} IS ${description.negated ? "NOT " : ""}NULL`;
    case "comparison": {
      if (
        !dialect.capabilities.containmentOperators &&
        (description.operator === "@>" || description.operator === "&&")
      ) {
        throw new Error(
          `symmetria: containment and overlap operators are not available in dialect "${dialect.name}"`,
        );
      }

      const operator = dialect.comparisonOperator(description.operator);
      const json =
        JSON_COMPARISONS.has(operator) &&
        isJsonType(sqlTypeOf(description.left));
      const nullable =
        description.nullableParameter &&
        description.right.kind === "placeholder";
      const left = valueSql(compilation, description.left, bindings);
      const right = valueSql(compilation, description.right, bindings);
      const comparison = json
        ? dialect.jsonComparison(
            left,
            right,
            operator as "=" | "<>" | "IS" | "IS NOT",
          )
        : `${left} ${operator} ${right}`;

      if (!nullable || description.right.kind !== "placeholder") {
        return comparison;
      }

      const type = sqlTypeOf(description.left);
      const checked = dialect.cast(right, {
        kind: "typed",
        type: type === "derived" ? description.right.sqlType : type,
      });

      return `(CASE WHEN ${checked} IS NULL THEN ${left} IS ${operator === "<>" ? "NOT " : ""}NULL ELSE ${comparison} END)`;
    }
    case "between":
      return `${valueSql(compilation, description.value, bindings)} BETWEEN ${valueSql(compilation, description.lower, bindings)} AND ${valueSql(compilation, description.upper, bindings)}`;
    case "has": {
      if (description.json) {
        const value = valueSql(compilation, description.value, bindings);
        const element = valueSql(compilation, description.element, bindings);
        const expression = { node: description.element, outputName: "value" };
        const elementType = expressionSqlType(expression);

        return dialect.jsonHas(
          value,
          element,
          {
            overlap: !!description.overlap,
            encoded:
              description.element.kind === "parameter" ||
              description.element.kind === "placeholder",
            elementType,
            elementArray: elementType.endsWith("[]"),
            operand: jsonPrecisionSql(compilation, expression, element),
            serializedElements: !!description.serializedElements,
            serializedOperandElements: !!description.serializedOperandElements,
          },
          renderContext(compilation, bindings),
        );
      }

      // Native arrays render the element first; JSON emulation renders the array first.
      if (dialect.capabilities.nativeArrays) {
        const element = valueSql(compilation, description.element, bindings);
        const value = valueSql(compilation, description.value, bindings);

        return dialect.arrayHas(
          value,
          element,
          { serializedElements: !!description.serializedElements },
          renderContext(compilation, bindings),
        );
      }

      const value = valueSql(compilation, description.value, bindings);
      const element = valueSql(compilation, description.element, bindings);

      return dialect.arrayHas(
        value,
        element,
        { serializedElements: !!description.serializedElements },
        renderContext(compilation, bindings),
      );
    }
    case "search":
      if (!dialect.capabilities.fullTextSearch) {
        throw new Error(
          `symmetria: search() is not available in dialect "${dialect.name}"`,
        );
      }

      return dialect.search(
        valueSql(compilation, description.value, bindings),
        searchOperand(compilation, description.query, bindings),
        description.language,
        renderContext(compilation, bindings),
      );
    case "exists":
      return `${description.negated ? "NOT " : ""}EXISTS (${compilation.selectSql(description.query, bindings)})`;
    case "membership": {
      if (Array.isArray(description.values) && !description.values.length) {
        return description.negated ? "TRUE" : "FALSE";
      }

      const left = valueSql(compilation, description.value, bindings);
      const operand = Array.isArray(description.values)
        ? {
            kind: "list" as const,
            values: description.values.map((value) =>
              valueSql(compilation, value, bindings),
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
        return dialect.jsonMembership(
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
