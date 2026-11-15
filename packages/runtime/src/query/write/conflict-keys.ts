/**
 * Duplicate conflict keys of an upsert, found before anything is sent: keys
 * are compared the way their column's type compares them.
 */
import { DuplicateConflictKeyError } from "../../errors";
import type { ColumnSnapshot } from "../../schema/assembly";
import { dataError } from "../codecs/deferred";
import type { ValueNode } from "../expressions";
import {
  DEFAULT_VALUE,
  type MutationPlan,
  type TableBinding,
} from "../plan/types";

/**
 * A decimal as one spelling per value: `1`, `1.0`, `+1` and `1e0` are the same
 * number to PostgreSQL. With the column's scale, the value is rounded as an
 * assignment rounds it (half away from zero), so `1.001` and `1.004` meet in a
 * `numeric(10,2)` key. Text that is not a decimal keeps its own spelling.
 */
const decimalKey = (text: string, scale: number | undefined): string => {
  const value = text.trim().toLowerCase();

  if (/^[+-]?nan$/.test(value)) {
    return "nan";
  }

  const infinite = /^([+-]?)inf(?:inity)?$/.exec(value);

  if (infinite) {
    return `${infinite[1] === "-" ? "-" : ""}inf`;
  }

  const parts = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(value);
  const exponent = Number(parts?.[4] ?? 0);

  if (
    !parts ||
    !(parts[2] || parts[3]) ||
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > 20000
  ) {
    return `text:${value}`;
  }

  let digits = BigInt(`${parts[2]}${parts[3] ?? ""}`);
  // The value is digits / 10^places.
  let places = (parts[3] ?? "").length - exponent;

  if (places < 0) {
    digits *= 10n ** BigInt(-places);
    places = 0;
  }

  if (scale !== undefined && places > scale) {
    const unit = 10n ** BigInt(places - scale);
    const rest = digits % unit;

    digits = digits / unit + (rest * 2n >= unit ? 1n : 0n);
    places = scale;
  }

  while (places > 0 && digits % 10n === 0n) {
    digits /= 10n;
    places -= 1;
  }

  return `${parts[1] === "-" && digits !== 0n ? "-" : ""}${digits}e-${places}`;
};

/**
 * The key of a text value as its column's type compares it: decimals by
 * value, UUIDs without regard to case, hyphens or braces, `char(n)` without
 * its padding.
 */
const typedKey = (text: string, sqlType: string): string => {
  const type = sqlType.toLowerCase();
  const decimal =
    /^(?:numeric|decimal)(?:\(\s*\d+\s*(?:,\s*(-?\d+)\s*)?\))?$/.exec(type);

  if (decimal) {
    return decimalKey(
      text,
      type.includes("(") ? Number(decimal[1] ?? 0) : undefined,
    );
  }

  if (type === "uuid") {
    return text.toLowerCase().replace(/[-{}]/g, "");
  }

  return /^(?:char|character|bpchar)(?:\(|$)/.test(type)
    ? text.replace(/ +$/, "")
    : text;
};

/** The bound value of a conflict column as a comparable key; undefined when only PostgreSQL knows it. */
const conflictKey = (
  value: ValueNode | typeof DEFAULT_VALUE | undefined,
  sqlType: string,
): string | undefined => {
  if (
    value === undefined ||
    value === DEFAULT_VALUE ||
    value.kind !== "parameter" ||
    value.value === null
  ) {
    return undefined;
  }

  const bound = value.value;

  if (bound instanceof Date) {
    return `date:${bound.getTime()}`;
  }

  return bound !== null && typeof bound === "object"
    ? `json:${JSON.stringify(bound, (_key, entry: unknown) =>
        typeof entry === "bigint" ? String(entry) : entry,
      )}`
    : `value:${typedKey(String(bound), sqlType)}`;
};

/**
 * PostgreSQL refuses to DO UPDATE one row twice in a statement, but a large
 * insert split into chunks would let the later duplicate win silently, so
 * duplicates are refused for every size, as a data error. NULL and
 * SQL-expression keys never conflict here and are left to PostgreSQL.
 */
export const rejectDuplicateKeys = (
  root: TableBinding,
  columns: readonly ColumnSnapshot[],
  rows: MutationPlan["values"],
): void => {
  if (rows.length < 2) {
    return;
  }

  const seen = new Map<string, number>();

  rows.forEach((values, position) => {
    const parts: string[] = [];

    for (const column of columns) {
      const key = conflictKey(values[column.name], column.sqlType);

      if (key === undefined) {
        return;
      }

      parts.push(key);
    }

    const key = JSON.stringify(parts);
    const first = seen.get(key);

    if (first !== undefined) {
      dataError(
        new DuplicateConflictKeyError(
          `symmetria: rows ${first + 1} and ${position + 1} of the upsert on "${root.table.name}" share a conflict key (${columns.map((column) => column.name).join(", ")}); ON CONFLICT DO UPDATE cannot change a row twice in one statement, so merge or remove the duplicates`,
          root.table.name,
        ),
      );
    }

    seen.set(key, position);
  });
};
