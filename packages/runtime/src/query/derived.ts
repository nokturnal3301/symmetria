import { expressionSqlType } from "./metadata";
import type { SelectPlan, TableBinding } from "./state";

export const derivedBinding = (plan: SelectPlan, alias: string): TableBinding =>
  Object.freeze({
    table: {
      name: alias,
      sqlName: alias,
      junction: false,
      relations: [],
      columns: plan.selection.map((expression) => ({
        name: expression.outputName,
        sqlName: expression.outputName,
        sqlType: expressionSqlType(expression),
        notNull: false,
        unique: false,
        primaryKey: false,
      })),
    },
    alias,
    derived: plan,
    projection: Object.freeze(
      Object.fromEntries(
        plan.selection.map((expression) => [expression.outputName, expression]),
      ),
    ),
    ...(plan.root.dialect ? { dialect: plan.root.dialect } : {}),
    codecs: Object.freeze(
      Object.fromEntries(
        plan.selection.flatMap((expression) =>
          expression.codec ? [[expression.outputName, expression.codec]] : [],
        ),
      ),
    ),
  });
