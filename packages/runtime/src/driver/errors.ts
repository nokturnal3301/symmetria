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
