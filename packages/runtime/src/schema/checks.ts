import { codecFor, type SchemaCodecs } from "../query/codecs";
import { quoteIdentifier } from "../query/compiler";
import { ddlExpressions } from "./ddl-expressions";
import { readPredicate } from "../query/expressions";
import { createScope } from "../query/select";
import { snakeCase, type SchemaSnapshot } from "./assembly";
import type { TableCheckCallback } from "./table";

export type CheckSnapshot = {
  readonly name: string;
  readonly sqlName: string;
  readonly expression: string;
};

export const applyChecks = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs,
  tableName: string,
  callback: TableCheckCallback,
): void => {
  const table = snapshot.tables.find(
    (candidate) => candidate.name === tableName,
  )!;

  const binding = {
    table,
    alias: tableName,
    codecs: Object.fromEntries(
      table.columns.flatMap((column) => {
        const codec =
          codecs[tableName]?.[column.name] ?? codecFor(column.sqlType);

        return codec ? [[column.name, codec]] : [];
      }),
    ),
  };

  const expressions = ddlExpressions((node) => {
    if (node.description.binding !== binding) {
      throw new Error(
        "symmetria: checks require columns from their table callback",
      );
    }

    return quoteIdentifier(node.description.column.sqlName);
  });

  const names = new Set((table.checks ?? []).map((check) => check.sqlName));

  for (const [name, condition] of Object.entries(
    callback(createScope({ [tableName]: binding })[tableName]!),
  )) {
    quoteIdentifier(name);
    const sqlName = `${table.sqlName}_${snakeCase(name)}_check`;
    quoteIdentifier(sqlName);

    if (names.has(sqlName)) {
      throw new Error(`symmetria: duplicate check constraint "${sqlName}"`);
    }

    names.add(sqlName);

    table.checks = Object.freeze([
      ...(table.checks ?? []),
      Object.freeze({
        name,
        sqlName,
        expression: expressions.predicateSQL(readPredicate(condition)),
      }),
    ]);
  }
};
