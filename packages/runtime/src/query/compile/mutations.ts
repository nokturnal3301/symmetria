import type { ColumnSnapshot } from "../../schema/assembly";
import type { ValueNode } from "../expressions";
import { DEFAULT_VALUE, type MutationPlan } from "../state";
import { quoteIdentifier, renderContext, type Compilation } from "./state";
import { projectionSql, valueSql } from "./values";
import { predicateSql } from "./predicates";
import { tableSql } from "./select";

export const mutationSql = (
  compilation: Compilation,
  query: MutationPlan,
): string => {
  const fragments: string[] = [];

  if (!compilation.dialect.capabilities.mutationRootAlias) {
    compilation.aliasNames.set(query.root, query.root.table.sqlName);
  }

  const defaultSql = (column: ColumnSnapshot): string =>
    compilation.dialect.defaultValue(
      column,
      renderContext(compilation, query.bindings),
    );

  const assignments = (
    values: Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>>,
    bindings = query.bindings,
  ): string =>
    Object.entries(values)
      .map(([name, value]) => {
        const column = query.root.table.columns.find(
          (candidate) => candidate.name === name,
        )!;

        return `${quoteIdentifier(column.sqlName)} = ${value === DEFAULT_VALUE ? defaultSql(column) : valueSql(compilation, value, bindings)}`;
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

    if (
      !names.length &&
      query.values.length === 1 &&
      (compilation.dialect.capabilities.defaultValuesOnConflict ||
        !query.conflict)
    ) {
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
                    ? defaultSql(column)
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
        fragments.push(
          `ON CONFLICT${target} DO UPDATE SET ${assignments(query.conflict.values, { ...query.bindings, ...(query.conflict.excluded ? { excluded: query.conflict.excluded } : {}) })}`,
        );

        // A scoped database never updates a conflicting row outside its scope.
        if (query.conflict.predicates?.length) {
          fragments.push(
            `WHERE ${query.conflict.predicates.map((description) => predicateSql(compilation, description, query.bindings)).join(" AND ")}`,
          );
        }
      }
    }
  } else if (query.kind === "update") {
    fragments.push(
      `UPDATE ${tableSql(compilation, query.root)} SET ${assignments(query.values[0]!)}`,
    );
  } else {
    fragments.push(`DELETE FROM ${tableSql(compilation, query.root)}`);
  }

  if (query.predicates.length) {
    fragments.push(
      `WHERE ${query.predicates.map((description) => predicateSql(compilation, description, query.bindings)).join(" AND ")}`,
    );
  }

  if (query.selection.length) {
    fragments.push(
      `RETURNING ${projectionSql(compilation, query.selection, query.bindings, false, true)}`,
    );
  }

  return fragments.join("\n");
};
