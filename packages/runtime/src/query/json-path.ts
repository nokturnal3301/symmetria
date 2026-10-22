import { booleanCodec, decodeValue, type RuntimeCodec } from "./codecs";
import { encodeJsonField, jsonRowCodec } from "./json-codecs";
import { resolveDialect } from "./dialects/registry";
import type { ExpressionDescription } from "./expressions";
import {
  expressionDialect,
  expressionSource,
  expressionSqlType,
} from "./metadata";
import type { Dialect } from "./state";

const arrayElement = (
  expression: ExpressionDescription,
  position: number,
): ExpressionDescription => {
  const elementType = expressionSqlType(expression).slice(0, -2);
  const codec =
    expression.codec?.element ??
    (["boolean", "bool"].includes(elementType) ? booleanCodec : undefined);

  return {
    outputName: expression.outputName,
    node: { kind: "arrayIndex", value: expression.node, position, elementType },
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
            codec: jsonRowCodec(
              node.query.selection,
              node.query.root.dialect ?? "postgres",
            ),
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
  dialect: Dialect,
): RuntimeCodec => ({
  parameterCast: "jsonb",
  encode: (value: unknown) => {
    const encoded = encodeJsonField(value, target?.codec, dialect);
    const type = target ? expressionSqlType(target) : "jsonb";

    return JSON.stringify(
      encoded == null
        ? encoded
        : ["boolean", "bool"].includes(type) &&
            target?.node.kind !== "arrayIndex"
          ? resolveDialect(dialect).jsonBoolean(Boolean(encoded))
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
  const dialect = expressionDialect(description);
  let current = description;

  for (const key of path) {
    if (expressionSqlType(current).endsWith("[]") && typeof key === "number") {
      current = arrayElement(current, key);
      continue;
    }

    const target = jsonPathTarget(current, key);
    const type = target ? expressionSqlType(target) : "jsonb";
    const scalarType =
      type !== "derived" &&
      type !== "json" &&
      type !== "jsonb" &&
      !type.endsWith("[]")
        ? type
        : undefined;
    const source = expressionSource(current);
    const sourceType = expressionSqlType(source);
    const serialized =
      resolveDialect(dialect).capabilities.serializedJsonArrayElements &&
      (sourceType === "json[]" || sourceType === "jsonb[]");
    const codec = scalarType ? target?.codec : jsonValueCodec(target, dialect);
    current = {
      outputName: description.outputName,
      node: Object.freeze({
        kind: "jsonPath",
        value: current.node,
        path: Object.freeze([key]),
        ...(target ? { target } : {}),
        ...(scalarType ? { scalarType } : {}),
        ...(serialized ? { serialized: true } : {}),
      }),
      ...(codec ? { codec } : {}),
    };
  }

  return current;
};
