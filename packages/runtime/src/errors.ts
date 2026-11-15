/**
 * Error classes: Symmetria's own failures carry a `code`, and database
 * failures from the built-in adapters carry what PostgreSQL reported, so both
 * can be told apart with `instanceof`.
 */
import type { DatabaseErrorKind } from "./driver/errors";

/** A failure Symmetria itself detected; `code` names it for `switch` and logs. */
export class SymmetriaError extends Error {
  override name = "SymmetriaError";
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** `one()`, `get()` or a nested `connect` found no row. */
export class NotFoundError extends SymmetriaError {
  override name = "NotFoundError";
  readonly table: string;

  constructor(message: string, table: string) {
    super(message, "SYMMETRIA_RECORD_NOT_FOUND");
    this.table = table;
  }
}

/** `one()` or `maybeOne()` found more than one row. */
export class TooManyRowsError extends SymmetriaError {
  override name = "TooManyRowsError";
  readonly table: string;

  constructor(message: string, table: string) {
    super(message, "SYMMETRIA_TOO_MANY_ROWS");
    this.table = table;
  }
}

/** A write through a `$scope()` database would leave a row outside the scope. */
export class OutOfScopeError extends SymmetriaError {
  override name = "OutOfScopeError";
  readonly table: string;

  constructor(message: string, table: string, cause: unknown) {
    super(message, "SYMMETRIA_OUT_OF_SCOPE", { cause });
    this.table = table;
  }
}

/** Two rows of one upsert share a conflict key. */
export class DuplicateConflictKeyError extends SymmetriaError {
  override name = "DuplicateConflictKeyError";
  readonly table: string;

  constructor(message: string, table: string) {
    super(message, "SYMMETRIA_DUPLICATE_CONFLICT_KEY");
    this.table = table;
  }
}

/** What `QueryError` takes from the driver error it wraps. */
export type QueryErrorFields = {
  readonly kind: DatabaseErrorKind;
  readonly sqlState: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
  readonly detail?: string;
};

const RESERVED = new Set(["name", "message", "stack", "cause"]);

/**
 * A statement PostgreSQL rejected, or a connection that failed, as the
 * built-in adapters throw it. The driver's own error is the `cause`, and its
 * fields (`code`, `errno`, `hint`, `severity`, …) are copied, so code that
 * read them from the driver error keeps working.
 */
export class QueryError extends Error {
  override name = "QueryError";
  /** What was violated; `"other"` for every SQLSTATE without a class of its own. */
  declare readonly kind: DatabaseErrorKind;
  /** The five-character SQLSTATE, such as `23505`. */
  declare readonly sqlState: string;
  declare readonly table?: string;
  declare readonly column?: string;
  declare readonly constraint?: string;
  /** PostgreSQL's DETAIL, such as `Key (email)=(ada@example.com) already exists.` */
  declare readonly detail?: string;

  constructor(message: string, fields: QueryErrorFields, cause: unknown) {
    super(message, { cause });

    if (cause && typeof cause === "object") {
      for (const [key, value] of Object.entries(cause)) {
        if (!RESERVED.has(key)) {
          (this as Record<string, unknown>)[key] = value;
        }
      }
    }

    Object.assign(this, fields);
  }
}

/** SQLSTATE 23505: a unique or primary key already holds the value. */
export class UniqueViolation extends QueryError {
  override name = "UniqueViolation";
}

/** SQLSTATE 23503: the referenced row is missing, or a referencing row still exists. */
export class ForeignKeyViolation extends QueryError {
  override name = "ForeignKeyViolation";
}

/** SQLSTATE 23502: NULL in a NOT NULL column. */
export class NotNullViolation extends QueryError {
  override name = "NotNullViolation";
}

/** SQLSTATE 23514: a CHECK constraint failed. */
export class CheckViolation extends QueryError {
  override name = "CheckViolation";
}

/** SQLSTATE 23P01: an exclusion constraint failed. */
export class ExclusionViolation extends QueryError {
  override name = "ExclusionViolation";
}

/** SQLSTATE 40001: a concurrent transaction conflicted; `retries` re-runs it. */
export class SerializationFailure extends QueryError {
  override name = "SerializationFailure";
}

/** SQLSTATE 40P01: PostgreSQL ended the transaction to break a deadlock. */
export class DeadlockDetected extends QueryError {
  override name = "DeadlockDetected";
}

/** The connection was lost or could not be opened. */
export class ConnectionError extends QueryError {
  override name = "ConnectionError";
}
