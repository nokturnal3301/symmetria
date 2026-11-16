import { timestampText } from "../../codecs";

/** PostgreSQL array literal, retaining null elements and codec-encoded JSON. */
export const postgresArrayLiteral = (values: readonly unknown[]): string =>
  `{${values
    .map((value) => {
      if (value == null) {
        return "NULL";
      }

      const text =
        value instanceof Date
          ? timestampText(value)
          : value instanceof Uint8Array
            ? `\\x${Buffer.from(value).toString("hex")}`
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);

      return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join(",")}}`;
