import type { CatalogConstraint } from "./catalog";
import type { DriftFinding, DriftOptions } from "./drift";
import { expressionsMatch } from "./drift-expressions";
import { objectName, type MigrationTable } from "./snapshot";

export const constraintDrift = async (
  table: MigrationTable,
  catalog: CatalogConstraint[],
  options: DriftOptions,
): Promise<DriftFinding[]> => {
  const findings: DriftFinding[] = [];
  const constraints: {
    name: string;
    kind: string;
    columns?: string[];
    reference?: { table: string; column: string; onDelete: string };
    expression?: string;
  }[] = [
    ...(table.primaryKey.length
      ? [
          {
            name: objectName(table.name, "pkey"),
            kind: "p",
            columns: table.primaryKey,
          },
        ]
      : []),
    ...table.columns.flatMap((column) => [
      ...(column.unique
        ? [
            {
              name: objectName(table.name, column.name, "key"),
              kind: "u",
              columns: [column.name],
            },
          ]
        : []),
      ...(column.references
        ? [
            {
              name: objectName(table.name, column.name, "fkey"),
              kind: "f",
              columns: [column.name],
              reference: column.references,
            },
          ]
        : []),
    ]),
    ...(table.checks ?? []).map((check) => ({
      name: check.sqlName,
      kind: "c",
      expression: check.expression,
    })),
  ];
  const liveConstraints = catalog.filter(
    (constraint) => constraint.table_name === table.name,
  );
  const actions: Record<string, string> = {
    "no action": "a",
    restrict: "r",
    cascade: "c",
    "set null": "n",
    "set default": "d",
  };

  for (const constraint of constraints) {
    const live = liveConstraints.find(
      (entry) => entry.name === constraint.name,
    );

    if (!live) {
      findings.push({
        kind: "missing-constraint",
        table: table.name,
        expected: constraint.name,
      });
      continue;
    }

    if (!live.validated) {
      findings.push({
        kind: "invalid-constraint",
        table: table.name,
        actual: constraint.name,
      });
    }

    if (
      live.kind !== constraint.kind ||
      live.deferrable ||
      live.initially_deferred ||
      (constraint.kind === "c" && live.no_inherit) ||
      live.nulls_not_distinct ||
      (constraint.columns &&
        JSON.stringify(constraint.columns) !== JSON.stringify(live.columns)) ||
      (constraint.reference &&
        (live.reference_table !== constraint.reference.table ||
          live.reference_schema !== null ||
          JSON.stringify(live.reference_columns) !==
            JSON.stringify([constraint.reference.column]) ||
          live.on_delete !== actions[constraint.reference.onDelete] ||
          live.on_update !== "a" ||
          live.match !== "s")) ||
      (constraint.expression &&
        (!live.expression ||
          !(await expressionsMatch(
            [constraint.expression],
            [live.expression],
            table.name,
            options,
          ))))
    ) {
      findings.push({
        kind: "constraint-mismatch",
        table: table.name,
        expected: constraint.name,
        actual: live.definition,
      });
    }
  }

  for (const constraint of liveConstraints) {
    if (!constraints.some((entry) => entry.name === constraint.name)) {
      findings.push({
        kind: "extra-constraint",
        table: table.name,
        actual: constraint.name,
      });
    }
  }

  return findings;
};
