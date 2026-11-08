import { postgresArrayLiteral } from "../query/compile/postgres/values";

/** Encode arrays identically for Bun.SQL and node-postgres; clone only when needed. */
export const postgresParameters = (parameters: unknown[]): unknown[] => {
  for (const value of parameters) {
    if (Array.isArray(value)) {
      return parameters.map((value) =>
        Array.isArray(value) ? postgresArrayLiteral(value) : value,
      );
    }
  }

  return parameters;
};
