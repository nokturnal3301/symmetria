/** JSON field and row codecs, matching PostgreSQL JSON projections. */
import { freeze } from "../plan/freeze";
import { createRowDecoder, encodeValue, jsonText, type RuntimeCodec } from ".";

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

const utf8 = new TextEncoder();

/** PostgreSQL's order of jsonb keys: shorter first, then by their UTF-8 bytes. */
const jsonbKeyOrder = (names: readonly string[]): string[] =>
  names
    .map((name) => ({ name, bytes: utf8.encode(name) }))
    .sort((left, right) => {
      if (left.bytes.length !== right.bytes.length) {
        return left.bytes.length - right.bytes.length;
      }

      for (let index = 0; index < left.bytes.length; index += 1) {
        if (left.bytes[index] !== right.bytes[index]) {
          return left.bytes[index]! - right.bytes[index]!;
        }
      }

      return 0;
    })
    .map(({ name }) => name);

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
  // Rows of fields that need no decoding are the driver's parsed JSON as it
  // is. PostgreSQL builds them as json, which keeps the selected key order,
  // or as jsonb (DISTINCT, GROUP BY, a derived table, many fields), which
  // sorts the keys; a row whose keys came sorted is built again in order.
  const plain = selection.every(
    ({ codec }) => !codec || codec.passthrough || codec.reorders,
  );
  const names = selection.map((expression) => expression.outputName);
  const sorted = jsonbKeyOrder(names);
  // The first position where the two orders differ tells them apart.
  const diverges = names.findIndex(
    (name, position) => sorted[position] !== name,
  );
  const reordering = selection.filter(({ codec }) => codec?.reorders);
  const passthrough = plain && diverges < 0 && !reordering.length;
  const reorders = plain && !passthrough;
  const settled = (row: Record<string, unknown>): boolean => {
    if (diverges >= 0) {
      let position = 0;

      for (const key in row) {
        if (position === diverges) {
          if (key !== names[diverges]) {
            return false;
          }

          break;
        }

        position += 1;
      }
    }

    return reordering.every(({ outputName, codec }) => {
      const field = row[outputName];

      return field == null || codec!.decode(field) === field;
    });
  };

  return freeze({
    parameterCast: "jsonb",
    passthrough,
    reorders,
    encode: (value: unknown) => {
      const encodeRow = (row: Record<string, unknown>) =>
        Object.fromEntries(
          selection.map((expression) => [
            expression.outputName,
            encodeJsonField(row[expression.outputName], expression.codec),
          ]),
        );

      return jsonText(
        many
          ? (value as Record<string, unknown>[]).map(encodeRow)
          : encodeRow(value as Record<string, unknown>),
      );
    },
    decode: (value: unknown) => {
      if (
        passthrough ||
        (reorders &&
          (typeof value !== "object" ||
            (many
              ? (value as Record<string, unknown>[]).every(settled)
              : settled(value as Record<string, unknown>))))
      ) {
        return value;
      }

      const decode = (rowDecoder ??= createRowDecoder(selection));

      return many
        ? (value as Record<string, unknown>[]).map(decode)
        : decode(value as Record<string, unknown>);
    },
  });
};
