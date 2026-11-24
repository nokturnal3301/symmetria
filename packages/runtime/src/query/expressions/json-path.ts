/**
 * JSON path expressions: typed access into jsonb columns with the matching codecs.
 */
import { freeze } from "../plan/freeze";
import {
  booleanCodec,
  decodeValue,
  jsonText,
  type RuntimeCodec,
} from "../codecs";
import { encodeJsonField, jsonRowCodec } from "../codecs/json";
import type { ExpressionDescription } from ".";
import {
  expressionSource,
  expressionSqlType,
  valueSqlType,
} from "../plan/metadata";
import { canonicalType } from "../codecs/type-names";

const arrayElement = (
  expression: ExpressionDescription,
  position: number,
): ExpressionDescription => {
  const elementType = expressionSqlType(expression).slice(0, -2);
  const codec =
    expression.codec?.element ??
    (canonicalType(elementType) === "boolean" ? booleanCodec : undefined);

  return {
    outputName: expression.outputName,
    node: {
      kind: "arrayIndex",
      value: expression.node,
      position,
      elementType,
    },
    ...(codec ? { codec } : {}),
  };
};

export const jsonPathTarget = (
  expression: ExpressionDescription,
  key: string | number,
): ExpressionDescription | undefined => {
  const source = expressionSource(expression);
  const node = source.node;

  if (node.kind === "jsonObject") {
    return node.selection.find((field) => field.outputName === key);
  }

  if (node.kind === "jsonRows") {
    return node.many
      ? typeof key === "number"
        ? {
            outputName: source.outputName,
            node: { kind: "jsonObject", selection: node.query.selection },
            codec: jsonRowCodec(node.query.selection),
          }
        : undefined
      : node.query.selection.find((field) => field.outputName === key);
  }

  return typeof key === "number" && expressionSqlType(source).endsWith("[]")
    ? arrayElement(source, key)
    : undefined;
};

export const jsonValueCodec = (
  target: ExpressionDescription | undefined,
): RuntimeCodec => ({
  parameterCast: "jsonb",
  encode: (value: unknown) => {
    const encoded = encodeJsonField(value, target?.codec);
    // As jsonPrecisionSql nests it: bigint and numeric values as JSON strings.
    const type = target ? valueSqlType(target) : "jsonb";

    return jsonText(
      encoded == null
        ? encoded
        : type === "boolean" && target?.node.kind !== "arrayIndex"
          ? Boolean(encoded)
          : type === "bigint" ||
              (type.startsWith("numeric") && !type.endsWith("[]"))
            ? String(encoded)
            : encoded,
    );
  },
  decode: (value: unknown) => decodeValue(value, target?.codec),
});

export const jsonPathDescription = (
  description: ExpressionDescription,
  path: readonly (string | number)[],
): ExpressionDescription => {
  let current = description;

  for (const key of path) {
    if (expressionSqlType(current).endsWith("[]") && typeof key === "number") {
      current = arrayElement(current, key);
      continue;
    }

    const target = jsonPathTarget(current, key);
    const type = target ? expressionSqlType(target) : "jsonb";
    const kind = target ? valueSqlType(target) : "jsonb";
    // An enum's type name is not known here: its label reads as text.
    const scalarType =
      type === "enum"
        ? "text"
        : type !== "derived" &&
            kind !== "json" &&
            kind !== "jsonb" &&
            !kind.endsWith("[]")
          ? type
          : undefined;
    const codec = scalarType ? target?.codec : jsonValueCodec(target);

    current = {
      outputName: description.outputName,
      node: freeze({
        kind: "jsonPath",
        value: current.node,
        path: freeze([key]),
        ...(target ? { target } : {}),
        ...(scalarType ? { scalarType } : {}),
      }),
      ...(codec ? { codec } : {}),
    };
  }

  return current;
};
