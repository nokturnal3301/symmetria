/**
 * Renders INSERT, UPDATE and DELETE plans to SQL, including the scope checks
 * of a scoped database's writes.
 */
import { scopeViolationText } from "../../driver/errors";
import type { PredicateDescription, ValueNode } from "../expressions";
import { DEFAULT_VALUE, type MutationPlan } from "../plan/types";
import {
  aliasSql,
  quoteIdentifier,
  type Bindings,
  type Compilation,
} from "./state";
import { projectionSql, valueSql } from "./values";
import { predicateSql } from "./predicates";
import { tableSql } from "./select";

/**
 * TRUE (or the `passing` condition) when the row satisfies the scope;
 * otherwise casting the violation text to boolean fails and aborts the whole
 * statement, so nothing is written, and PostgreSQL's error
 * (`invalid input syntax for type boolean: "SYMMETRIA_OUT_OF_SCOPE:insert:posts:16384"`)
 * names the check and the table. The failing branch reads the row's tableoid,
 * which keeps PostgreSQL from evaluating it while planning, even when the
 * scope is a constant.
 */
const scopeCheckSql = (
  compilation: Compilation,
  query: MutationPlan,
  checks: readonly PredicateDescription[],
  failure: "insert" | "update" | "conflict",
  passing?: () => string,
): string => {
  const scope = checks
    .map((description) =>
      predicateSql(compilation, description, query.bindings),
    )
    .join(" AND ");
  const text = scopeViolationText(failure, query.root.table.name);

  return `CASE WHEN ${scope} THEN ${passing ? passing() : "TRUE"} ELSE ('${text.replaceAll("'", "''")}' || ${aliasSql(compilation, query.root)}.tableoid)::boolean END`;
};

export const mutationSql = (
  compilation: Compilation,
  query: MutationPlan,
): string => {
  // A data error found while building, such as a value a codec rejects.
  if (query.failure) {
    throw query.failure.error;
  }

  const fragments: string[] = [];

  const assignments = (
    values: Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>>,
    bindings = query.bindings,
  ): string =>
    Object.entries(values)
      .map(([name, value]) => {
        const column = query.root.table.columns.find(
          (candidate) => candidate.name === name,
        )!;

        return `${quoteIdentifier(column.sqlName)} = ${value === DEFAULT_VALUE ? "DEFAULT" : valueSql(compilation, value, bindings)}`;
      })
      .join(", ");

  if (query.kind === "insert") {
    if (!query.values.length) {
      throw new Error(
        "symmetria: insert([]) has no SQL; executing it is a no-op",
      );
    }

    const names = query.root.table.columns.filter((column) =>
      query.values.some((values) => column.name in values),
    );

    fragments.push(`INSERT INTO ${tableSql(compilation, query.root)}`);

    if (!names.length && query.values.length === 1) {
      fragments.push("DEFAULT VALUES");
    } else {
      const columns = names.length
        ? names
        : query.root.table.columns.slice(0, 1);

      if (!columns.length) {
        throw new Error(
          "symmetria: cannot bulk insert into a table without columns",
        );
      }

      fragments.push(
        `(${columns.map((column) => quoteIdentifier(column.sqlName)).join(", ")}) VALUES ${query.values
          .map(
            (values) =>
              `(${columns
                .map((column) => {
                  const value = values[column.name];

                  return value === undefined || value === DEFAULT_VALUE
                    ? "DEFAULT"
                    : valueSql(compilation, value, query.bindings);
                })
                .join(", ")})`,
          )
          .join(", ")}`,
      );
    }

    if (query.conflict) {
      const target = query.conflict.columns.length
        ? ` (${query.conflict.columns.map((column) => quoteIdentifier(column.sqlName)).join(", ")})`
        : "";

      if (query.conflict.action === "nothing") {
        fragments.push(`ON CONFLICT${target} DO NOTHING`);
      } else {
        const { condition } = query.conflict;
        const conflictBindings: Bindings = {
          ...query.bindings,
          ...(query.conflict.excluded
            ? { excluded: query.conflict.excluded }
            : {}),
        };

        fragments.push(
          `ON CONFLICT${target} DO UPDATE SET ${assignments(query.conflict.values, conflictBindings)}`,
        );

        // A conflict with a row outside the scope fails the statement; one
        // inside it whose condition is false is skipped, as without a scope.
        if (query.checks) {
          fragments.push(
            `WHERE ${scopeCheckSql(
              compilation,
              query,
              query.checks,
              "conflict",
              condition &&
                (() => predicateSql(compilation, condition, conflictBindings)),
            )}`,
          );
        } else if (condition) {
          fragments.push(
            `WHERE ${predicateSql(compilation, condition, conflictBindings)}`,
          );
        }
      }
    }
  } else {
    if (!query.predicates.length && !query.unrestricted) {
      throw new Error(
        `symmetria: ${query.kind}() on "${query.root.table.name}" has no where(); call .all() to ${query.kind === "update" ? "update" : "delete"} every row`,
      );
    }

    fragments.push(
      query.kind === "update"
        ? `UPDATE ${tableSql(compilation, query.root)} SET ${assignments(query.values[0]!)}`
        : `DELETE FROM ${tableSql(compilation, query.root)}`,
    );
  }

  if (query.predicates.length) {
    fragments.push(
      `WHERE ${query.predicates.map((description) => predicateSql(compilation, description, query.bindings)).join(" AND ")}`,
    );
  }

  // Every row the statement writes, with its final values, must satisfy the scope.
  const check = query.checks
    ? `${scopeCheckSql(compilation, query, query.checks, query.kind === "update" ? "update" : "insert")} AS "__symmetria_scope"`
    : undefined;

  if (query.selection.length) {
    fragments.push(
      `RETURNING ${projectionSql(compilation, query.selection, query.bindings, false, true)}${check ? `, ${check}` : ""}`,
    );
  } else if (check) {
    fragments.push(`RETURNING ${check}`);
  }

  return fragments.join("\n");
};
