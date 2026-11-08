/** JSON field and row codecs, matching PostgreSQL JSON projections. */
import { createRowDecoder, encodeValue, type RuntimeCodec } from ".";

export const encodeJsonField = (
  value: unknown,
  codec: RuntimeCodec | undefined,
): unknown => {
  if (value == null) {
    return value;
  }

  if (codec?.parameterCast?.endsWith("[]")) {
    if (!Array.isArray(value)) {
      throw new Error("symmetria: array columns accept arrays");
    }

    return value.map((entry) => encodeJsonField(entry, codec.element));
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
  many = false,
): RuntimeCodec => {
  // Queries are built far more often than executed; generate the decoder on first use.
  let rowDecoder: ReturnType<typeof createRowDecoder> | undefined;

  const decodeRow = (row: Record<string, unknown>): Record<string, unknown> =>
    (rowDecoder ??= createRowDecoder(selection))(row);

  return Object.freeze({
    parameterCast: "jsonb",
    encode: (value: unknown) => {
      const encodeRow = (row: Record<string, unknown>) =>
        Object.fromEntries(
          selection.map((expression) => [
            expression.outputName,
            encodeJsonField(row[expression.outputName], expression.codec),
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
