import { normalizeResult, quoteIdentifier } from "symmetria/internal";
import type { QueryExecutor, SchemaSnapshot } from "symmetria";
import { indexSQL } from "./ddl";
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

const indexExpressionsMatch = async (
  expected: readonly string[],
  actual: readonly string[],
  tableName: string,
  options: DriftOptions,
): Promise<boolean> => {
  const table = `${options.schemaName ? `${quoteIdentifier(options.schemaName)}.` : ""}${quoteIdentifier(tableName)}`;

  try {
    // Let PostgreSQL normalize casts, parentheses and rewrites such as IN -> ANY.
    // EXPLAIN without ANALYZE plans the expressions without scanning table data.
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
    // A changed column/type can make the declared index expression unresolvable.
    if (
      error &&
      typeof error === "object" &&
      ["code", "errno"].some((field) =>
        ["42703", "42704", "42804", "42846", "42883", "22P02"].includes(
          String((error as Record<string, unknown>)[field]),
        ),
      )
    ) {
      return false;
    }

    throw error;
  }
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

  return `${typeAliases[qualified] ?? qualified}${match[2] ?? ""}`;
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
  const metadataTable = options.metadataTable ?? "_symmetria_migrations";
  const schemaFilter = options.schemaName
    ? "namespace.nspname = $2"
    : "namespace.nspname = current_schema()";
  const parameters = options.schemaName
    ? [metadataTable, options.schemaName]
    : [metadataTable];
  const columns = normalizeResult(
    await options.execute({
      sql: `SELECT relation.relname AS table_name, attribute.attname AS column_name,
        format_type(attribute.atttypid, attribute.atttypmod) AS data_type, attribute.attnotnull AS not_null
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${schemaFilter} AND relation.relkind IN ('r', 'p') AND attribute.attnum > 0
        AND NOT attribute.attisdropped AND relation.relname <> $1
      ORDER BY relation.relname, attribute.attnum`,
      parameters,
    }),
  ).rows as {
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
  }[];
  const indexes = normalizeResult(
    await options.execute({
      sql: `SELECT relation.relname AS table_name, indexrelation.relname AS index_name,
        index.indisunique AS is_unique, accessmethod.amname AS method,
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
      WHERE ${schemaFilter} AND relation.relname <> $1 AND NOT index.indisprimary
      ORDER BY relation.relname, indexrelation.relname`,
      parameters,
    }),
  ).rows as {
    table_name: string;
    index_name: string;
    is_unique: boolean;
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

      const expectedType = normalizeSqlType(
        column.enumeration ?? column.sqlType,
      );
      const actualType = normalizeSqlType(live.type);

      if (expectedType !== actualType) {
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
        definition.method !== live.method ||
        declaredKeys.length !== live.keys.length ||
        definition.include.length !== live.included.length ||
        declaredKeys.some(
          (key, position) =>
            key.descending !== !!(live.options[position]! & 1) ||
            key.nullsFirst !== !!(live.options[position]! & 2),
        ) ||
        !(await indexExpressionsMatch(
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
        name.endsWith("_key");

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
