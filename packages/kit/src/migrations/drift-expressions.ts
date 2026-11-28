import { normalizeResult, quoteIdentifier } from "symmetria/internal";
import type { QueryExecutor } from "symmetria";

/**
 * An expression in parentheses. The line break ends a `--` comment at its
 * end, which snapshots saved by earlier versions hold without one
 * (`1 -- one`), so the comment cannot take in the closing parenthesis.
 */
export const enclosed = (expression: string): string => `(${expression}\n)`;

/**
 * The expressions the top node of an `EXPLAIN (VERBOSE, FORMAT JSON)` plan
 * prints, as PostgreSQL normalized them. A node that only passes on the rows
 * of the nodes below it (an Append over partitions) prints none: that plan is
 * reported, since nothing can be compared from it.
 */
const planOutput = (plan: unknown, table: string): string[] => {
  let parsed = plan;

  // A driver without a JSON parser delivers the plan as text.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = undefined;
    }
  }

  const top = (
    parsed as
      | { Plan?: { "Node Type"?: unknown; Output?: unknown } }[]
      | null
      | undefined
  )?.[0]?.Plan;
  const output = top?.Output;

  if (
    !Array.isArray(output) ||
    !output.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      `symmetria: cannot compare the expressions of ${table} with the database: PostgreSQL's plan for them ${
        top
          ? `starts with a ${String(top["Node Type"])} node, which lists no expressions`
          : "could not be read"
      }`,
    );
  }

  return output;
};

/** Let PostgreSQL normalize casts, parentheses and expression rewrites without scanning data. */
export const expressionsMatch = async (
  expected: readonly string[],
  actual: readonly string[],
  tableName: string,
  options: { execute: QueryExecutor; schemaName?: string },
): Promise<boolean> => {
  const table = `${options.schemaName ? `${quoteIdentifier(options.schemaName)}.` : ""}${quoteIdentifier(tableName)}`;

  try {
    // ONLY keeps the plan to one node, which prints the expressions. Without
    // it a partitioned table with two or more partitions is planned as an
    // Append over them, and that node prints none.
    const result = normalizeResult(
      await options.execute({
        sql: `EXPLAIN (VERBOSE, FORMAT JSON, COSTS OFF) SELECT ${[...expected, ...actual].map(enclosed).join(", ")} FROM ONLY ${table}`,
        parameters: [],
      }),
    );
    const output = planOutput(result.rows[0]?.["QUERY PLAN"], table);

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
