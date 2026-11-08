/**
 * PostgreSQL error inspection shared by the adapters: SQLSTATE lookup and the
 * conflict classes a transaction may retry.
 */

/** The five-character SQLSTATE of a server error (`code` on pg, `errno` on Bun). */
export const sqlState = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = error as { code?: unknown; errno?: unknown };

  return [value.code, value.errno].find(
    (code): code is string =>
      typeof code === "string" && /^[0-9A-Z]{5}$/.test(code),
  );
};

/** serialization_failure and deadlock_detected: the transaction can be re-run from the start. */
export const isRetryableTransactionError = (error: unknown): boolean => {
  const state = sqlState(error);

  return state === "40001" || state === "40P01";
};

/** What a failed statement violated, by SQLSTATE class. */
export type DatabaseErrorKind =
  | "unique"
  | "foreign-key"
  | "not-null"
  | "check"
  | "exclusion"
  | "serialization"
  | "deadlock"
  | "other";

/** A server error described the same way for node-postgres and Bun.SQL. */
export type DatabaseError = {
  readonly kind: DatabaseErrorKind;
  readonly sqlState: string;
  readonly message: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
  /** PostgreSQL's DETAIL, such as `Key (email)=(ada@example.com) already exists.` */
  readonly detail?: string;
};

const KINDS: Record<string, DatabaseErrorKind> = {
  "23505": "unique",
  "23503": "foreign-key",
  "23502": "not-null",
  "23514": "check",
  "23P01": "exclusion",
  "40001": "serialization",
  "40P01": "deadlock",
};

/**
 * The server error behind a failed query, normalized across both drivers, or
 * undefined for anything else (network failures, symmetria errors):
 * `if (databaseError(error)?.kind === "unique") …`.
 */
export const databaseError = (error: unknown): DatabaseError | undefined => {
  const state = sqlState(error);

  if (!state) {
    return undefined;
  }

  const fields = error as Record<string, unknown>;
  const text = (name: string): string | undefined =>
    typeof fields[name] === "string" && fields[name] !== ""
      ? (fields[name] as string)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  // node-postgres omits the column of a NOT NULL violation; its message names it.
  const column =
    text("column") ?? /null value in column "([^"]+)"/.exec(message)?.[1];
  const table = text("table");
  const constraint = text("constraint");
  const detail = text("detail");

  return Object.freeze({
    kind: KINDS[state] ?? "other",
    sqlState: state,
    message,
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(constraint ? { constraint } : {}),
    ...(detail ? { detail } : {}),
  });
};
