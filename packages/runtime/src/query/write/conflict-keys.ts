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
  type CompiledQuery,
  type MutationPlan,
  type TableBinding,
} from "../plan/types";
import { quoteIdentifier } from "../compile/state";

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

const TIMESTAMP_TYPE =
  /^(timestamptz|timestamp)(?:\s*\(\s*(\d)\s*\))?(?:\s+with(out)?\s+time\s+zone)?$/;
const TIMESTAMP_TEXT =
  /^(\d{4})-(\d\d)-(\d\d)[t ](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?\s*(z|[+-]\d\d(?::?\d\d)?)?$/;

/**
 * A timestamp as the microsecond its column stores: `timestamptz(0)` rounds
 * two instants of one second to the same key, and `…+00:00` is `…Z`. Text in
 * another spelling keeps its own.
 */
const timestampKey = (text: string, type: string): string | undefined => {
  const column = TIMESTAMP_TYPE.exec(type);
  const parts = column && TIMESTAMP_TEXT.exec(text.trim().toLowerCase());

  if (!column || !parts) {
    return undefined;
  }

  const zoned = column[1] === "timestamptz" || /with\s+time/.test(type);
  const zone = parts[8];

  // Without an offset the session's time zone decides, which only PostgreSQL knows.
  if (zoned && !zone) {
    return undefined;
  }

  const offset =
    zoned && zone !== "z"
      ? (zone![0] === "-" ? -1 : 1) *
        (Number(zone!.slice(1, 3)) * 60 +
          Number(zone!.slice(-2)) * (zone!.length > 3 ? 1 : 0))
      : 0;
  const milliseconds =
    Date.UTC(
      Number(parts[1]),
      Number(parts[2]) - 1,
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6]),
    ) -
    offset * 60_000;
  const micros =
    BigInt(milliseconds) * 1000n + BigInt((parts[7] ?? "").padEnd(6, "0"));
  const unit = 10n ** BigInt(6 - Number(column[2] ?? 6));
  // PostgreSQL counts from 2000-01-01 and rounds half away from that point:
  // 1999-06-01 00:00:00.5 becomes 00:00:00 in timestamptz(0), 2001 rounds up.
  const since = micros - POSTGRES_EPOCH;
  const rounded =
    since >= 0n
      ? ((since + unit / 2n) / unit) * unit
      : -(((-since + unit / 2n) / unit) * unit);

  return `timestamp:${rounded}`;
};

/** 2000-01-01T00:00:00Z in microseconds since 1970: PostgreSQL's zero. */
const POSTGRES_EPOCH = 946_684_800_000_000n;

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

  const timestamp = timestampKey(text, type);

  if (timestamp) {
    return timestamp;
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
    return Number.isNaN(bound.getTime())
      ? undefined
      : `value:${typedKey(bound.toISOString(), sqlType)}`;
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

/** The refusal of two rows with one conflict key, as PostgreSQL compares them. */
export const duplicateKeyError = (
  root: TableBinding,
  columns: readonly ColumnSnapshot[],
  cause?: unknown,
): DuplicateConflictKeyError =>
  new DuplicateConflictKeyError(
    `symmetria: two rows of the upsert on "${root.table.name}" share a conflict key (${columns.map((column) => column.name).join(", ")}) as PostgreSQL compares it; ON CONFLICT DO UPDATE cannot change a row twice, so merge or remove the duplicates`,
    root.table.name,
    cause === undefined ? undefined : { cause },
  );

/** A bound value as PostgreSQL's text input of its column type reads it. */
const textInput = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value instanceof Date
      ? value.toISOString()
      : value instanceof Uint8Array
        ? `\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
        : value !== null && typeof value === "object"
          ? JSON.stringify(value, (_key, entry: unknown) =>
              typeof entry === "bigint" ? String(entry) : entry,
            )
          : String(value);

const textArray = (values: readonly string[]): string =>
  `{${values.map((value) => `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`).join(",")}}`;

/**
 * A query that finds two rows with one conflict key, comparing keys as
 * their column types compare them in PostgreSQL itself (`inet` with and
 * without `/32`, `interval` spellings, jsonb key order, time zones). Run
 * before an upsert that is split into several statements, where a later
 * duplicate would otherwise overwrite an earlier one silently. Rows whose key
 * is NULL, a default or an SQL expression never conflict here.
 */
export const duplicateKeyProbe = (
  columns: readonly ColumnSnapshot[],
  rows: MutationPlan["values"],
): CompiledQuery | undefined => {
  const keys = columns.map((): string[] => []);

  for (const values of rows) {
    const bound = columns.map((column) => values[column.name]);

    if (
      bound.every(
        (value) =>
          value !== undefined &&
          value !== DEFAULT_VALUE &&
          value.kind === "parameter" &&
          value.value !== null,
      )
    ) {
      bound.forEach((value, position) =>
        keys[position]!.push(
          textInput((value as Extract<ValueNode, { kind: "parameter" }>).value),
        ),
      );
    }
  }

  if (keys[0]!.length < 2) {
    return undefined;
  }

  const names = columns.map((_column, position) => `k${position}`);
  // An enum compares as its labels; every other type as itself.
  const typed = columns.map(
    (column, position) =>
      `${quoteIdentifier(names[position]!)}::${column.sqlType === "enum" ? "text" : column.sqlType}`,
  );

  return {
    sql: `SELECT 1 AS "duplicate" FROM unnest(${columns.map((_column, position) => `$${position + 1}::text[]`).join(", ")}) AS "keys"(${names.map(quoteIdentifier).join(", ")}) GROUP BY ${typed.join(", ")} HAVING count(*) > 1 LIMIT 1`,
    parameters: keys.map(textArray),
  };
};
