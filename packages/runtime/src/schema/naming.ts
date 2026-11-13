/**
 * Derived SQL object names: constraint, index and enum names built from table and
 * column names. Names over PostgreSQL's 63-byte limit keep a readable prefix and
 * end in a hash of the full name, so long tables and columns stay declarable.
 */
import { createHash } from "node:crypto";

/** The longest prefix kept before the hash of an over-long derived name. */
const PREFIX_BYTES = 50;

/** `parts` joined with underscores; over 63 bytes, a 50-byte prefix plus 12 hex digits of its SHA-256. */
export const objectName = (...parts: string[]): string => {
  const name = parts.join("_");

  if (Buffer.byteLength(name) <= 63) {
    return name;
  }

  let prefix = "";

  for (const character of name) {
    if (Buffer.byteLength(prefix + character) > PREFIX_BYTES) {
      break;
    }

    prefix += character;
  }

  return `${prefix}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
};
