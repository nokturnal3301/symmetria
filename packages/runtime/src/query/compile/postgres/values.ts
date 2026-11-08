export const isJsonType = (sqlType: string): boolean =>
  /^(?:json|jsonb)$/.test(sqlType.toLowerCase().trim());

/** PostgreSQL array literal, retaining null elements and codec-encoded JSON. */
export const postgresArrayLiteral = (values: readonly unknown[]): string =>
  `{${values
    .map((value) => {
      if (value == null) {
        return "NULL";
      }

      const text =
        value instanceof Date
          ? value.toISOString()
          : value instanceof Uint8Array
            ? `\\x${Buffer.from(value).toString("hex")}`
            : typeof value === "boolean"
              ? value
                ? "t"
                : "f"
              : typeof value === "object"
                ? JSON.stringify(value)
                : String(value);

      return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join(",")}}`;
