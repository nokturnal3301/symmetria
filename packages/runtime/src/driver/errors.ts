/**
 * PostgreSQL error inspection shared by the adapters: SQLSTATE lookup, the
 * conflict classes a transaction may retry and failed `$scope()` write checks.
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

/**
 * The text a failed `$scope()` write check casts to boolean (see the
 * compiler's scope checks), so PostgreSQL aborts the statement with 22P02 and
 * an error that names the check: the statement's own rows (`insert`, `update`)
 * or the existing row of an upsert conflict (`conflict`), and the table.
 */
export const scopeViolationText = (
  check: "insert" | "update" | "conflict",
  table: string,
): string => `SYMMETRIA_OUT_OF_SCOPE:${check}:${encodeURIComponent(table)}:`;

/** The text in PostgreSQL's message, whose quotes depend on `lc_messages`. */
const SCOPE_VIOLATION =
  /SYMMETRIA_OUT_OF_SCOPE:(insert|update|conflict):([^:]*):\d+/;

/**
 * PostgreSQL's error for a failed scope check as `SYMMETRIA_OUT_OF_SCOPE`,
 * naming the table, with the driver error as its cause; other errors pass
 * through. Writes and transaction scopes both apply it, so a transaction that
 * a caught violation aborted reports the same error.
 */
export const scopeViolation = (error: unknown): unknown => {
  const failed =
    sqlState(error) === "22P02"
      ? SCOPE_VIOLATION.exec(String((error as { message?: unknown }).message))
      : null;

  if (!failed) {
    return error;
  }

  const table = decodeURIComponent(failed[2]!);

  return Object.assign(
    new Error(
      failed[1] === "conflict"
        ? `symmetria: upsert on "${table}" conflicted with a row outside the database scope`
        : `symmetria: ${failed[1]} on "${table}" would write a row outside the database scope`,
      { cause: error },
    ),
    { code: "SYMMETRIA_OUT_OF_SCOPE", table },
  );
};

/** serialization_failure and deadlock_detected: the transaction can be re-run from the start. */
export const isRetryableTransactionError = (error: unknown): boolean => {
  const state = sqlState(error);

  return state === "40001" || state === "40P01";
};

/** Connection exceptions (class 08) and the shutdowns that end a session (57P01–57P05). */
const connectionState = (state: string): boolean =>
  state.startsWith("08") || /^57P0[1-5]$/.test(state);

/** Socket and pool failures, which carry no SQLSTATE. */
const NODE_POSTGRES_CONNECTION =
  /^(Connection terminated|Client has encountered a connection error|Client was closed|timeout exceeded when trying to connect)/;
const SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * Whether the connection itself failed, rather than a statement: the server
 * ended the session (class 08, 57P01–57P05), a socket error, or a client-side
 * connection loss (`Connection terminated unexpectedly` on node-postgres,
 * `ERR_POSTGRES_CONNECTION_CLOSED` and similar on Bun).
 */
export const isConnectionError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const state = sqlState(error);

  if (state) {
    return connectionState(state);
  }

  const { code, message } = error as { code?: unknown; message?: unknown };

  return (
    (typeof code === "string" &&
      (SOCKET_CODES.has(code) ||
        /^ERR_POSTGRES_(CONNECTION|IDLE|LIFETIME|TLS)_/.test(code))) ||
    (typeof message === "string" && NODE_POSTGRES_CONNECTION.test(message))
  );
};

/** What a failed statement violated, by SQLSTATE class, or `connection` when the connection was lost. */
export type DatabaseErrorKind =
  | "unique"
  | "foreign-key"
  | "not-null"
  | "check"
  | "exclusion"
  | "serialization"
  | "deadlock"
  | "connection"
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

/** Failures to open a connection, as opposed to losing one. */
const UNREACHABLE =
  /^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ERR_POSTGRES_CONNECTION_(REFUSED|TIMEOUT)|ERR_POSTGRES_TLS_.+)$/;

/** 08001 (unable to connect) or 08006 (connection_failure) for a connection error without a SQLSTATE. */
const connectionFailureState = (error: unknown): string | undefined => {
  if (!isConnectionError(error)) {
    return undefined;
  }

  const { code, message } = error as { code?: unknown; message?: unknown };

  return UNREACHABLE.test(String(code)) ||
    /^timeout exceeded when trying to connect/.test(String(message))
    ? "08001"
    : "08006";
};

/**
 * The server error behind a failed query, normalized across both drivers, or
 * undefined for anything else (symmetria errors, programming errors):
 * `if (databaseError(error)?.kind === "unique") …`. A lost or refused
 * connection is `kind: "connection"` on both drivers; without a server
 * SQLSTATE it reports 08006 (connection_failure) or 08001 (unable to connect).
 */
export const databaseError = (error: unknown): DatabaseError | undefined => {
  const state = sqlState(error) ?? connectionFailureState(error);

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
    kind: KINDS[state] ?? (connectionState(state) ? "connection" : "other"),
    sqlState: state,
    message,
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(constraint ? { constraint } : {}),
    ...(detail ? { detail } : {}),
  });
};
