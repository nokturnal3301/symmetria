import { normalizeResult, quoteIdentifier } from "symmetria/internal";
import type { QueryExecutor, SchemaSnapshot } from "symmetria";
import { indexSQL } from "./ddl";
import { readCatalog } from "./catalog";
import { constraintDrift } from "./drift-constraints";
import { expressionsMatch } from "./drift-expressions";
import {
  migrationSnapshot,
  parseMigrationSnapshot,
  type MigrationSnapshot,
} from "./snapshot";

export type DriftKind =
  | "missing-table"
  | "extra-table"
  | "missing-column"
  | "extra-column"
  | "type-mismatch"
  | "nullability-mismatch"
  | "default-mismatch"
  | "identity-mismatch"
  | "missing-constraint"
  | "extra-constraint"
  | "constraint-mismatch"
  | "invalid-constraint"
  | "missing-enum"
  | "extra-enum"
  | "enum-mismatch"
  | "invalid-index"
  | "missing-index"
  | "index-mismatch"
  | "extra-index";
export type DriftFinding = {
  readonly kind: DriftKind;
  readonly table: string;
  readonly column?: string;
  readonly expected?: string;
  readonly actual?: string;
};
export type DriftOptions = {
  readonly execute: QueryExecutor;
  readonly snapshot: SchemaSnapshot | MigrationSnapshot;
  /** Schema to inspect; defaults to the connection's current_schema(). */
  readonly schemaName?: string;
  /** Schema containing the migration journal; defaults to public. */
  readonly metadataSchema?: string;
  readonly metadataTable?: string;
};

const indexKey = (expression: string) => {
  const ordering = /(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(FIRST|LAST))?$/i.exec(
    expression,
  )!;
  const descending = ordering[1]?.toUpperCase() === "DESC";

  return {
    expression: expression.slice(0, ordering.index),
    descending,
    nullsFirst: ordering[2]
      ? ordering[2].toUpperCase() === "FIRST"
      : descending,
  };
};

const typeAliases: Record<string, string> = {
  int: "integer",
  int4: "integer",
  serial: "integer",
  int8: "bigint",
  bigserial: "bigint",
  int2: "smallint",
  bool: "boolean",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  varchar: "character varying",
  float8: "double precision",
  float4: "real",
};

/** Compare declared and catalog types after resolving aliases such as timestamptz. */
export const normalizeSqlType = (sqlType: string): string => {
  const text = sqlType.trim().toLowerCase().replace(/\s+/g, " ");

  if (text.endsWith("[]")) {
    return `${normalizeSqlType(text.slice(0, -2))}[]`;
  }

  const match = /^([a-z_][a-z0-9_. ]*?)(\(.*\))?$/.exec(text);

  if (!match) {
    return text;
  }

  const base = match[1]!.trim();
  const qualified = base.includes(".")
    ? base.slice(base.indexOf(".") + 1)
    : base;

  // format_type() prints modifiers without spaces: `numeric(12, 2)` is `numeric(12,2)`.
  return `${typeAliases[qualified] ?? qualified}${match[2]?.replace(/\s+/g, "") ?? ""}`;
};

/**
 * Detect manual changes: tables, columns, types, nullability and declared indexes
 * are compared between the live catalog and the expected snapshot.
 */
export const detectDrift = async (
  options: DriftOptions,
): Promise<DriftFinding[]> => {
  const expected =
    "version" in options.snapshot
      ? parseMigrationSnapshot(options.snapshot)
      : migrationSnapshot(options.snapshot);
  const catalog = await readCatalog(options);
  const metadataTable = options.metadataTable ?? "_symmetria_migrations";
  const schemaFilter = options.schemaName
    ? "namespace.nspname = $3"
    : "namespace.nspname = current_schema()";
  const metadataFilter =
    "NOT (relation.relname = $1 AND namespace.nspname = $2)";
  const parameters = [
    metadataTable,
    options.metadataSchema ?? "public",
    ...(options.schemaName ? [options.schemaName] : []),
  ];
  const columns = catalog.columns;
  const indexes = normalizeResult(
    await options.execute({
      sql: `SELECT relation.relname AS table_name, indexrelation.relname AS index_name,
        index.indisunique AS is_unique, index.indnullsnotdistinct AS nulls_not_distinct, accessmethod.amname AS method,
        ARRAY(SELECT pg_get_indexdef(index.indexrelid, position, true)
          FROM generate_series(1, index.indnkeyatts) position) AS keys,
        ARRAY(SELECT index.indoption[position - 1]::integer
          FROM generate_series(1, index.indnkeyatts) position) AS options,
        ARRAY(SELECT pg_get_indexdef(index.indexrelid, position, true)
          FROM generate_series(index.indnkeyatts + 1, index.indnatts) position) AS included,
        pg_get_expr(index.indpred, index.indrelid, true) AS predicate,
        pg_get_indexdef(index.indexrelid) AS definition
      FROM pg_index index
      JOIN pg_class relation ON relation.oid = index.indrelid
      JOIN pg_class indexrelation ON indexrelation.oid = index.indexrelid
      JOIN pg_am accessmethod ON accessmethod.oid = indexrelation.relam
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${schemaFilter} AND ${metadataFilter} AND NOT index.indisprimary
      ORDER BY relation.relname, indexrelation.relname`,
      parameters,
    }),
  ).rows as {
    table_name: string;
    index_name: string;
    is_unique: boolean;
    nulls_not_distinct: boolean;
    method: string;
    keys: string[];
    options: number[];
    included: string[];
    predicate: string | null;
    definition: string;
  }[];
  const findings: DriftFinding[] = [];
  const actualTables = new Map<
    string,
    Map<string, { type: string; notNull: boolean }>
  >();

  for (const table of catalog.tables) {
    actualTables.set(table.name, new Map());
  }

  for (const row of columns) {
    const table = actualTables.get(row.table_name) ?? new Map();
    table.set(row.column_name, { type: row.data_type, notNull: row.not_null });
    actualTables.set(row.table_name, table);
  }

  for (const table of expected.tables) {
    const actual = actualTables.get(table.name);

    if (!actual) {
      findings.push({ kind: "missing-table", table: table.name });
      continue;
    }

    for (const column of table.columns) {
      const live = actual.get(column.name);

      if (!live) {
        findings.push({
          kind: "missing-column",
          table: table.name,
          column: column.name,
        });
        continue;
      }

      const details = catalog.columns.find(
        (entry) =>
          entry.table_name === table.name && entry.column_name === column.name,
      )!;
      const expectedType = normalizeSqlType(
        column.enumeration ?? column.sqlType,
      );
      const actualType = normalizeSqlType(live.type);

      if (
        column.enumeration
          ? details.enum_name !== column.enumeration ||
            details.enum_schema !== null
          : expectedType !== actualType
      ) {
        findings.push({
          kind: "type-mismatch",
          table: table.name,
          column: column.name,
          expected: expectedType,
          actual: actualType,
        });
      }

      if (column.notNull !== live.notNull) {
        findings.push({
          kind: "nullability-mismatch",
          table: table.name,
          column: column.name,
          expected: column.notNull ? "NOT NULL" : "NULL",
          actual: live.notNull ? "NOT NULL" : "NULL",
        });
      }

      if (details.identity !== (column.identity ? "a" : "")) {
        findings.push({
          kind: "identity-mismatch",
          table: table.name,
          column: column.name,
          expected: column.identity ? "GENERATED ALWAYS" : "none",
          actual:
            details.identity === "a"
              ? "GENERATED ALWAYS"
              : details.identity === "d"
                ? "GENERATED BY DEFAULT"
                : "none",
        });
      }

      if (
        (column.default === undefined) !== (details.default === null) ||
        (column.default !== undefined &&
          details.default !== null &&
          !(await expressionsMatch(
            [
              `(${column.default})::${column.enumeration ? quoteIdentifier(column.enumeration) : column.sqlType}`,
            ],
            [
              `(${details.default})::${column.enumeration ? quoteIdentifier(column.enumeration) : column.sqlType}`,
            ],
            table.name,
            options,
          )))
      ) {
        findings.push({
          kind: "default-mismatch",
          table: table.name,
          column: column.name,
          ...(column.default === undefined ? {} : { expected: column.default }),
          ...(details.default === null ? {} : { actual: details.default }),
        });
      }
    }

    for (const columnName of actual.keys()) {
      if (!table.columns.some((column) => column.name === columnName)) {
        findings.push({
          kind: "extra-column",
          table: table.name,
          column: columnName,
        });
      }
    }

    const liveIndexes = indexes.filter((row) => row.table_name === table.name);

    for (const index of catalog.indexes.filter(
      (index) =>
        index.table_name === table.name && (!index.valid || !index.ready),
    )) {
      findings.push({
        kind: "invalid-index",
        table: table.name,
        actual: index.name,
      });
    }

    findings.push(
      ...(await constraintDrift(table, catalog.constraints, options)),
    );

    for (const definition of table.indexes) {
      const live = liveIndexes.find(
        (row) => row.index_name === definition.sqlName,
      );

      if (!live) {
        findings.push({
          kind: "missing-index",
          table: table.name,
          expected: definition.sqlName,
        });
        continue;
      }

      const declaredKeys = definition.keys.map(indexKey);

      if (
        definition.unique !== live.is_unique ||
        live.nulls_not_distinct ||
        definition.method !== live.method ||
        declaredKeys.length !== live.keys.length ||
        definition.include.length !== live.included.length ||
        declaredKeys.some(
          (key, position) =>
            key.descending !== !!(live.options[position]! & 1) ||
            key.nullsFirst !== !!(live.options[position]! & 2),
        ) ||
        !(await expressionsMatch(
          [
            ...declaredKeys.map((key) => key.expression),
            ...definition.include,
            definition.where ?? "TRUE",
          ],
          [...live.keys, ...live.included, live.predicate ?? "TRUE"],
          table.name,
          options,
        ))
      ) {
        findings.push({
          kind: "index-mismatch",
          table: table.name,
          expected: indexSQL(table, definition),
          actual: live.definition,
        });
      }
    }

    for (const { index_name: name } of liveIndexes) {
      const declared =
        table.indexes.some((definition) => definition.sqlName === name) ||
        catalog.indexes.some(
          (index) =>
            index.table_name === table.name &&
            index.name === name &&
            index.constraint,
        );

      if (!declared) {
        findings.push({ kind: "extra-index", table: table.name, actual: name });
      }
    }
  }

  for (const name of actualTables.keys()) {
    if (!expected.tables.some((table) => table.name === name)) {
      findings.push({ kind: "extra-table", table: name });
    }
  }

  for (const enumeration of expected.enumerations) {
    const live = catalog.enumerations.find(
      (entry) => entry.name === enumeration.name,
    );

    if (!live) {
      findings.push({ kind: "missing-enum", table: enumeration.name });
    } else if (
      JSON.stringify(live.values) !== JSON.stringify(enumeration.values)
    ) {
      findings.push({
        kind: "enum-mismatch",
        table: enumeration.name,
        expected: JSON.stringify(enumeration.values),
        actual: JSON.stringify(live.values),
      });
    }
  }

  for (const enumeration of catalog.enumerations) {
    if (
      !expected.enumerations.some((entry) => entry.name === enumeration.name)
    ) {
      findings.push({ kind: "extra-enum", table: enumeration.name });
    }
  }

  return findings;
};

export const formatDriftFindings = (
  findings: readonly DriftFinding[],
): string =>
  findings.length
    ? findings
        .map((finding) => {
          const target = `${quoteIdentifier(finding.table)}${finding.column ? `.${quoteIdentifier(finding.column)}` : ""}`;
          const details =
            finding.expected !== undefined || finding.actual !== undefined
              ? ` (expected ${finding.expected ?? "nothing"}, found ${finding.actual ?? "nothing"})`
              : "";

          return `${finding.kind.padEnd(21)} ${target}${details}`;
        })
        .join("\n")
    : "No schema drift detected.";
