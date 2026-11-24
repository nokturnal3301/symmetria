/**
 * Builds the table binding for a derived source (subquery or CTE) from its plan.
 */
import { freeze } from "./freeze";
import { expressionSqlType } from "./metadata";
import { codecMap } from "../codecs";
import { keyAlias } from "../compile/state";
import type { SelectPlan, TableBinding } from "./types";

export const derivedBinding = (plan: SelectPlan, alias: string): TableBinding =>
  freeze({
    table: {
      name: alias,
      sqlName: alias,
      junction: false,
      relations: [],
      columns: plan.selection.map((expression) => ({
        name: expression.outputName,
        // A key longer than an SQL name is selected under a shorter alias.
        sqlName: keyAlias(expression.outputName),
        sqlType: expressionSqlType(expression),
        notNull: false,
        unique: false,
        primaryKey: false,
      })),
    },
    alias,
    derived: plan,
    projection: freeze(
      Object.fromEntries(
        plan.selection.map((expression) => [expression.outputName, expression]),
      ),
    ),

    codecs: freeze(
      codecMap(
        Object.fromEntries(
          plan.selection.flatMap((expression) =>
            expression.codec ? [[expression.outputName, expression.codec]] : [],
          ),
        ),
      ),
    ),
  });
