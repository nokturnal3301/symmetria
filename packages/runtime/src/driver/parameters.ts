/**
 * Parameter values as the adapters send them: arrays become PostgreSQL array
 * literals on both drivers, and node-postgres gets text for the values its own
 * serializer would change.
 */
import { postgresArrayLiteral } from "../query/compile/postgres/values";
import { timestampText } from "../query/codecs";

const isNegativeZero = (value: unknown): boolean =>
  value === 0 && 1 / value < 0;

/** `String(-0)` is "0"; PostgreSQL's floats keep the sign of zero. */
const arrayLiteral = (values: unknown[]): string =>
  postgresArrayLiteral(
    values.some(isNegativeZero)
      ? values.map((value) => (isNegativeZero(value) ? "-0" : value))
      : values,
  );

/**
 * node-postgres prints -0 as "0" and a Date in local time with a whole-minute
 * offset, which shifts historic instants whose offset has seconds. Bun.SQL
 * binds both exactly, except a Date before year 1 or after 9999, which it
 * prints in a form PostgreSQL does not read.
 */
const farDate = (value: unknown): value is Date => {
  if (!(value instanceof Date)) {
    return false;
  }

  const year = value.getUTCFullYear();

  return year < 1 || year > 9999;
};

const nodePostgresValue = (value: unknown): unknown => {
  if (isNegativeZero(value)) {
    return "-0";
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("symmetria: Date parameters must be valid Dates");
    }

    return timestampText(value);
  }

  return value;
};

/** Encode arrays identically for Bun.SQL and node-postgres; clone only when needed. */
export const postgresParameters = (
  parameters: unknown[],
  nodePostgres = false,
): unknown[] => {
  for (const value of parameters) {
    if (
      Array.isArray(value) ||
      (nodePostgres && (isNegativeZero(value) || value instanceof Date)) ||
      farDate(value)
    ) {
      return parameters.map((value) =>
        Array.isArray(value)
          ? arrayLiteral(value)
          : nodePostgres
            ? nodePostgresValue(value)
            : farDate(value)
              ? timestampText(value)
              : value,
      );
    }
  }

  return parameters;
};
