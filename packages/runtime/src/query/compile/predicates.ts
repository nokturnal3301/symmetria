import { encodeValue } from "../codecs";
import { expressionSqlType } from "../metadata";
import { isJsonType } from "../dialect";
import type { SearchOperand } from "../dialects/types";
import type { PredicateDescription, ValueNode } from "../expressions";
import type { SelectPlan } from "../state";
import {
  parameter,
  renderContext,
  type Bindings,
  type Compilation,
} from "./state";
import {
  jsonPrecisionSql,
  operandSql,
  orderedOperandSql,
  orderedType,
  valueSql,
} from "./values";

const JSON_COMPARISONS = new Set(["=", "<>", "IS", "IS NOT"]);
const EQUALITY_COMPARISONS = new Set([
  "=",
  "<>",
  "IS",
  "IS NOT",
  "IS DISTINCT FROM",
  "IS NOT DISTINCT FROM",
]);

/**
 * Both sides of a comparison, adjusted to the left side's sort order where the
 * dialect asks for it; cursor tuples adjust member by member.
 */
const comparisonOperands = (
  compilation: Compilation,
  left: ValueNode,
  right: ValueNode,
  operator: string,
  bindings: Bindings,
): [string, string] => {
  if (!compilation.dialect.orderedOperand) {
    return [
      operandSql(compilation, left, bindings),
      operandSql(compilation, right, bindings),
    ];
  }

  const equality = EQUALITY_COMPARISONS.has(operator);

  if (
    left.kind === "tuple" &&
    right.kind === "tuple" &&
    left.values.length === right.values.length
  ) {
    const types = left.values.map(orderedType);

    const members = (values: readonly ValueNode[]) =>
      `(${values.map((value, position) => orderedOperandSql(compilation, value, bindings, types[position], equality)).join(", ")})`;

    return [members(left.values), members(right.values)];
  }

  const type = orderedType(left);

  return [
    orderedOperandSql(compilation, left, bindings, type, equality),
    orderedOperandSql(compilation, right, bindings, type, equality),
  ];
};

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

/** Lists longer than this bind as a single array parameter where the dialect has native arrays. */
export const LARGE_LIST_THRESHOLD = 1000;

const largeListType = (
  compilation: Compilation,
  description: Extract<PredicateDescription, { kind: "membership" }>,
): string | undefined => {
  if (
    !compilation.dialect.capabilities.nativeArrays ||
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
      return `${operandSql(compilation, description.value, bindings)} IS ${description.negated ? "NOT " : ""}NULL`;
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
      const [left, right] = json
        ? [
            operandSql(compilation, description.left, bindings),
            operandSql(compilation, description.right, bindings),
          ]
        : comparisonOperands(
            compilation,
            description.left,
            description.right,
            description.operator,
            bindings,
          );
      const comparison = json
        ? dialect.jsonComparison(
            left,
            right,
            operator as "=" | "<>" | "IS" | "IS NOT",
          )
        : dialect.patternMatch &&
            (description.operator === "LIKE" ||
              description.operator === "ILIKE")
          ? dialect.patternMatch(left, right, description.operator === "ILIKE")
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
    case "between": {
      const type = orderedType(description.value);

      const operand = (node: ValueNode) =>
        orderedOperandSql(compilation, node, bindings, type);

      return `${operand(description.value)} BETWEEN ${operand(description.lower)} AND ${operand(description.upper)}`;
    }
    case "has": {
      if (description.json) {
        const value = operandSql(compilation, description.value, bindings);
        const element = operandSql(compilation, description.element, bindings);
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
        const element = operandSql(compilation, description.element, bindings);
        const value = operandSql(compilation, description.value, bindings);

        return dialect.arrayHas(
          value,
          element,
          { serializedElements: !!description.serializedElements },
          renderContext(compilation, bindings),
        );
      }

      const value = operandSql(compilation, description.value, bindings);
      const element = operandSql(compilation, description.element, bindings);

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

      const left = operandSql(compilation, description.value, bindings);
      const arrayType = largeListType(compilation, description);

      // Long literal lists bind as one array parameter: stable SQL text and no wire-protocol parameter limit.
      if (arrayType) {
        const values = (description.values as readonly ValueNode[]).map(
          (value) => (value as Extract<ValueNode, { kind: "parameter" }>).value,
        );

        return `${left} ${description.negated ? "<> ALL" : "= ANY"}(${dialect.cast(parameter(compilation, values), { kind: "typed", type: `${arrayType}[]` })})`;
      }

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
