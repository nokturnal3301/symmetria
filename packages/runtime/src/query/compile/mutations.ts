/**
 * Renders INSERT, UPDATE and DELETE plans to SQL, including the scope checks
 * of a scoped database's writes.
 */
import { scopeViolationText } from "../../driver/errors";
import type { PredicateDescription, ValueNode } from "../expressions";
import { DEFAULT_VALUE, type MutationPlan } from "../plan/types";
import {
  aliasSql,
  parameter,
  quoteIdentifier,
  type Bindings,
  type Compilation,
} from "./state";
import { projectionSql, valueSql } from "./values";
import { predicateSql } from "./predicates";
import { tableSql } from "./select";
import { unconstrained } from "./postgres/render";

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

/** From this many rows on, a plain multi-row INSERT sends one array per column. */
const ARRAY_INSERT_THRESHOLD = 100;

/** Column types whose values bind as they are; the array is cast to the type without its length or scale, which assignment then applies. */
const ARRAY_TYPES =
  /^(smallint|integer|bigint|text|uuid|boolean|date|double precision|timestamptz|timestamp|numeric|varchar|character varying)(?:\(\d+(?:,\s*\d+)?\))?$/;

/**
 * The rows of a bulk INSERT as one array per column, when every row carries
 * the same columns as plain values of types PostgreSQL reads from an array
 * literal exactly as from a parameter. Anything else (a DEFAULT, an SQL
 * expression, a prepared parameter, an enum, an array column) keeps VALUES.
 */
const columnArrays = (
  query: MutationPlan,
  columns: readonly MutationPlan["root"]["table"]["columns"][number][],
): { values: unknown[]; type: string }[] | undefined => {
  if (query.values.length < ARRAY_INSERT_THRESHOLD) {
    return undefined;
  }

  const arrays: { values: unknown[]; type: string }[] = [];

  for (const column of columns) {
    const values: unknown[] = [];
    let cast: string | undefined;
    let typed = false;

    for (const row of query.values) {
      const value = row[column.name];

      if (
        value === undefined ||
        value === DEFAULT_VALUE ||
        value.kind !== "parameter" ||
        Array.isArray(value.value)
      ) {
        return undefined;
      }

      // NULL is NULL under any cast; the other values must agree on theirs.
      if (value.value !== null) {
        if (typed && value.cast !== cast) {
          return undefined;
        }

        cast = value.cast;
        typed = true;
      }

      values.push(value.value);
    }

    if (cast) {
      // A value bound as `$1::text::jsonb` is an element of `text[]::jsonb[]`.
      if (cast.endsWith("]")) {
        return undefined;
      }

      arrays.push({ values, type: `text[]::${unconstrained(cast)}[]` });
      continue;
    }

    const base = ARRAY_TYPES.exec(column.sqlType)?.[1];

    if (!base) {
      return undefined;
    }

    arrays.push({
      values,
      type: `${base === "varchar" || base === "character varying" ? "text" : base}[]`,
    });
  }

  return arrays;
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

      const arrays = columnArrays(query, columns);

      fragments.push(
        arrays
          ? // One array per column: the statement's text and its parameter
            // count no longer grow with the number of rows.
            `(${columns.map((column) => quoteIdentifier(column.sqlName)).join(", ")}) SELECT * FROM unnest(${arrays
              .map(
                ({ values, type }) =>
                  `${parameter(compilation, values)}::${type}`,
              )
              .join(", ")})`
          : `(${columns.map((column) => quoteIdentifier(column.sqlName)).join(", ")}) VALUES ${query.values
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
