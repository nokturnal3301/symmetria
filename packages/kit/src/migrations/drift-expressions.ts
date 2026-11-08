import { normalizeResult, quoteIdentifier } from "symmetria/internal";
import type { QueryExecutor } from "symmetria";

/** Let PostgreSQL normalize casts, parentheses and expression rewrites without scanning data. */
export const expressionsMatch = async (
  expected: readonly string[],
  actual: readonly string[],
  tableName: string,
  options: { execute: QueryExecutor; schemaName?: string },
): Promise<boolean> => {
  const table = `${options.schemaName ? `${quoteIdentifier(options.schemaName)}.` : ""}${quoteIdentifier(tableName)}`;

  try {
    const result = normalizeResult(
      await options.execute({
        sql: `EXPLAIN (VERBOSE, FORMAT JSON, COSTS OFF) SELECT ${[...expected, ...actual].map((expression) => `(${expression})`).join(", ")} FROM ${table}`,
        parameters: [],
      }),
    );
    const plan = result.rows[0]?.["QUERY PLAN"] as {
      Plan: { Output: string[] };
    }[];
    const output = plan[0]!.Plan.Output;

    return (
      output.length === expected.length * 2 &&
      output
        .slice(0, expected.length)
        .every(
          (expression, position) =>
            expression === output[position + expected.length],
        )
    );
  } catch (error) {
    // A changed column/type can make the declared expression unresolvable.
    if (
      error &&
      typeof error === "object" &&
      ["code", "errno"].some((field) =>
        [
          "42703",
          "42704",
          "42804",
          "42846",
          "42883",
          "22P02",
          "42601",
        ].includes(String((error as Record<string, unknown>)[field])),
      )
    ) {
      return false;
    }

    throw error;
  }
};
