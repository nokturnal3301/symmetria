/**
 * Drift detection: compares the live catalog with the expected snapshot and reports findings by kind.
 */
import { quoteIdentifier } from "symmetria/internal";
import type { QueryExecutor, SchemaSnapshot } from "symmetria";
import { indexSQL } from "./ddl";
import { readCatalog, readExtensions } from "./catalog";
import { readIndexDetails } from "../introspection/catalog";
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
  | "collation-mismatch"
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
  | "extra-index"
  | "missing-extension";
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
  /**
   * Undeclared tables to leave out, such as `_prisma_migrations`, PostGIS
   * `spatial_ref_sys` or another service's tables. Declared tables are always compared.
   */
  readonly ignoreTables?: readonly string[];
};

/**
 * A declared key's ordering and collation. PostgreSQL stores a key's top-level
 * `COLLATE` as the key's collation, not in its expression, and EXPLAIN does not
 * print collations, so the collation is compared on its own.
 */
const indexKey = (key: string) => {
  const ordering = /(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(FIRST|LAST))?$/i.exec(
    key,
  )!;
  const descending = ordering[1]?.toUpperCase() === "DESC";
  const expression = key.slice(0, ordering.index);
  const collated =
    /^\((.*)\s+COLLATE\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)\)$/is.exec(
      expression.trim(),
    );

  return {
    expression: collated ? `(${collated[1]})` : expression,
    collation: collated
      ? collated[2]!.startsWith('"')
        ? collated[2]!.slice(1, -1).replaceAll('""', '"')
        : collated[2]!.toLowerCase()
      : null,
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
  time: "time without time zone",
  timetz: "time with time zone",
};

/** Compare declared and catalog types after resolving aliases such as timestamptz. */
export const normalizeSqlType = (sqlType: string): string => {
  const text = sqlType.trim().toLowerCase().replace(/\s+/g, " ");

  if (text.endsWith("[]")) {
    return `${normalizeSqlType(text.slice(0, -2))}[]`;
  }

  // Precision may sit before a time-zone suffix: `time(3) without time zone`.
  const match =
    /^([a-z_][a-z0-9_. ]*?)(\(.*?\))?( with(?:out)? time zone)?$/.exec(text);

  if (!match) {
    return text;
  }

  const base = `${match[1]!.trim()}${match[3] ?? ""}`;
  const qualified = base.includes(".")
    ? base.slice(base.indexOf(".") + 1)
    : base;

  // format_type() prints modifiers without spaces: `numeric(12, 2)` is `numeric(12,2)`.
  return `${typeAliases[qualified] ?? qualified}${match[2]?.replace(/\s+/g, "") ?? ""}`;
};

/** The `ignoreTables` entries to leave out: a table the schema declares is always compared. */
export const undeclaredTables = (
  ignoreTables: readonly string[] | undefined,
  snapshot: Pick<MigrationSnapshot, "tables">,
): string[] =>
  (ignoreTables ?? []).filter(
    (name) => !snapshot.tables.some((table) => table.name === name),
  );

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
  const catalog = await readCatalog({
    ...options,
    ignoreTables: undeclaredTables(options.ignoreTables, expected),
  });
  const columns = catalog.columns;
  const indexes = await readIndexDetails(options);
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

      if ((column.collation ?? null) !== details.collation) {
        findings.push({
          kind: "collation-mismatch",
          table: table.name,
          column: column.name,
          expected: column.collation ?? "default",
          actual: details.collation ?? "default",
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

      if (
        details.identity !==
        (column.identity ? (column.identityByDefault ? "d" : "a") : "")
      ) {
        findings.push({
          kind: "identity-mismatch",
          table: table.name,
          column: column.name,
          expected: column.identity
            ? column.identityByDefault
              ? "GENERATED BY DEFAULT"
              : "GENERATED ALWAYS"
            : "none",
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
          (_key, position) =>
            (definition.opclasses?.[position] ?? null) !==
            (live.opclasses[position] ?? null),
        ) ||
        !sameStorage(definition.with, live.reloptions) ||
        declaredKeys.some(
          (key, position) =>
            key.descending !== !!(live.options[position]! & 1) ||
            key.nullsFirst !== !!(live.options[position]! & 2) ||
            key.collation !== (live.collations[position] ?? null),
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

  if (expected.extensions?.length) {
    const installed = new Set(
      (await readExtensions(options)).map((extension) => extension.name),
    );

    for (const name of expected.extensions) {
      if (!installed.has(name)) {
        findings.push({ kind: "missing-extension", table: name });
      }
    }
  }

  return findings;
};

/** `WITH (m = 16)` versus pg_class.reloptions `["m=16"]`, compared as normalized name=value sets. */
const sameStorage = (
  declared: Readonly<Record<string, string | number>> | undefined,
  live: readonly string[] | null,
): boolean => {
  const normalize = (entries: readonly string[]) =>
    entries
      .map((entry) => {
        const separator = entry.indexOf("=");

        return `${entry.slice(0, separator).trim().toLowerCase()}=${entry
          .slice(separator + 1)
          .trim()
          .replace(/^'(.*)'$/, "$1")}`;
      })
      .sort();
  const expected = normalize(
    Object.entries(declared ?? {}).map(([name, value]) => `${name}=${value}`),
  );
  const actual = normalize(live ?? []);

  return JSON.stringify(expected) === JSON.stringify(actual);
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
