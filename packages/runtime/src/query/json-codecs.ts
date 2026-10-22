/** JSON field and row codecs; their encoding follows the dialect's JSON rules. */
import { createRowDecoder, encodeValue, type RuntimeCodec } from "./codecs";
import { resolveDialect } from "./dialects/registry";
import type { Dialect } from "./state";

export const encodeJsonField = (
  value: unknown,
  codec: RuntimeCodec | undefined,
  dialect: Dialect,
): unknown => {
  if (value == null) {
    return value;
  }

  if (codec?.parameterCast?.endsWith("[]")) {
    if (!Array.isArray(value)) {
      throw new Error("symmetria: array columns accept arrays");
    }

    // Serialized element dialects encode each element before the container.
    return value.map((entry) =>
      resolveDialect(dialect).capabilities.serializedJsonArrayElements
        ? encodeValue(entry, codec.element)
        : encodeJsonField(entry, codec.element, dialect),
    );
  }

  const encoded = encodeValue(value, codec);

  return (codec?.parameterCast === "json" ||
    codec?.parameterCast === "jsonb") &&
    typeof encoded === "string"
    ? JSON.parse(encoded)
    : encoded;
};

/** Composite parameters use the same encoded field values as SQL JSON projections. */
export const jsonRowCodec = (
  selection: readonly {
    readonly outputName: string;
    readonly codec?: RuntimeCodec;
  }[],
  dialect: Dialect,
  many = false,
): RuntimeCodec => {
  // Queries are built far more often than executed; generate the decoder on first use.
  let rowDecoder: ReturnType<typeof createRowDecoder> | undefined;

  const decodeRow = (row: Record<string, unknown>): Record<string, unknown> =>
    (rowDecoder ??= createRowDecoder(selection))(row);

  return Object.freeze({
    parameterCast: "jsonb",
    encode: (value: unknown) => {
      const encodeField = (value: unknown, codec?: RuntimeCodec): unknown => {
        const encoded = encodeJsonField(value, codec, dialect);

        // SQL boolean fields follow the dialect; native JSON booleans stay booleans.
        return typeof encoded === "boolean" &&
          codec?.parameterCast !== "json" &&
          codec?.parameterCast !== "jsonb"
          ? resolveDialect(dialect).jsonBoolean(encoded)
          : encoded;
      };

      const encodeRow = (row: Record<string, unknown>) =>
        Object.fromEntries(
          selection.map((expression) => [
            expression.outputName,
            encodeField(row[expression.outputName], expression.codec),
          ]),
        );

      return JSON.stringify(
        many
          ? (value as Record<string, unknown>[]).map(encodeRow)
          : encodeRow(value as Record<string, unknown>),
      );
    },
    decode: (value: unknown) =>
      many
        ? (value as Record<string, unknown>[]).map(decodeRow)
        : decodeRow(value as Record<string, unknown>),
  });
};
