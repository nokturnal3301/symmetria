import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot } from "symmetria";
import {
  enumerationSQL,
  foreignKeySQL,
  indexSQL,
  tableSQL,
} from "../migrations/ddl";
import { migrationSnapshot } from "../migrations/snapshot";
import { theme } from "./style";

export const inspectTabs = [
  "Columns",
  "Relations",
  "Indexes",
  "Checks",
  "SQL",
] as const;
export type InspectTab = (typeof inspectTabs)[number];
export type InspectEntry = {
  name: string;
  kind: string;
  badges: string[];
  description: string;
  target?: { table: string; column?: string };
};

const defaultLabel = (column: ColumnSnapshot): string | undefined => {
  if (!column.default) {
    return undefined;
  }

  if (column.default.kind === "sql") {
    return column.default.sql;
  }

  return typeof column.default.value === "bigint"
    ? String(column.default.value)
    : JSON.stringify(column.default.value, (_name, value) =>
        typeof value === "bigint" ? String(value) : value,
      );
};

export const inspectEntries = (
  table: TableSnapshot,
  tab: InspectTab,
): InspectEntry[] => {
  if (tab === "Columns") {
    return table.columns.map((column) => {
      const defaultValue = defaultLabel(column);
      const identity =
        column.default?.kind === "sql" && column.default.sql === "identity";

      return {
        name: column.name,
        kind: column.sqlType,
        badges: [
          column.primaryKey || table.primaryKey?.includes(column.sqlName)
            ? "PK"
            : "",
          column.references ? "FK" : "",
          column.unique ? "UNIQUE" : "",
          !column.notNull ? "NULL" : "",
          identity ? "AUTO" : defaultValue === undefined ? "" : "DEFAULT",
        ].filter(Boolean),
        description: [
          `${table.sqlName}.${column.sqlName} · ${column.sqlType} · ${column.notNull ? "NOT NULL" : "NULLABLE"}`,
          defaultValue === undefined
            ? ""
            : identity
              ? "GENERATED ALWAYS AS IDENTITY"
              : `Default: ${defaultValue}`,
          column.enumerationValues
            ? `Values: ${column.enumerationValues.join(" · ")}`
            : "",
          column.references
            ? `→ ${column.references.table}.${column.references.column} · ON DELETE ${column.references.onDelete.toUpperCase()}\nEnter to follow this foreign key`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        ...(column.references
          ? {
              target: {
                table: column.references.table,
                column: column.references.column,
              },
            }
          : {}),
      };
    });
  }

  if (tab === "Relations") {
    return table.relations.map((relation) => {
      const column =
        relation.kind === "through"
          ? undefined
          : table.columns.find((column) => column.name === relation.foreignKey);

      return {
        name: relation.name,
        kind: relation.kind === "through" ? "many ↔ many" : relation.kind,
        badges:
          relation.kind === "through"
            ? ["JUNCTION"]
            : relation.reverse
              ? ["REVERSE"]
              : relation.nullable
                ? ["OPTIONAL"]
                : [],
        description: `${table.name}.${relation.name} → ${relation.target}\n${relation.kind === "through" ? `Through ${relation.junction} (${relation.sourceForeignKey} → ${relation.targetForeignKey})` : `Foreign key: ${relation.reverse ? relation.target : table.name}.${relation.foreignKey}`}\nEnter to open ${relation.target}`,
        target: {
          table: relation.target,
          ...(relation.kind === "through"
            ? {}
            : relation.reverse
              ? { column: relation.foreignKey }
              : column?.references
                ? { column: column.references.column }
                : {}),
        },
      };
    });
  }

  if (tab === "Indexes") {
    return (table.indexes ?? []).map((index) => ({
      name: index.sqlName,
      kind: index.method,
      badges: index.unique ? ["UNIQUE"] : [],
      description: [
        index.sqlName,
        `Keys: ${index.keys.join(", ")}`,
        index.include.length ? `Include: ${index.include.join(", ")}` : "",
        index.where ? `Where: ${index.where}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }));
  }

  if (tab === "Checks") {
    return (table.checks ?? []).map((check) => ({
      name: check.sqlName,
      kind: "check",
      badges: [],
      description: `${check.sqlName}\nCHECK (${check.expression})`,
    }));
  }

  return [];
};

export const matchesEntry = (entry: InspectEntry, search: string): boolean =>
  `${entry.name} ${entry.kind} ${entry.description} ${entry.badges.join(" ")}`
    .toLowerCase()
    .includes(search.toLowerCase());

export const matchesTableName = (
  table: TableSnapshot,
  search: string,
): boolean =>
  `${table.name} ${table.sqlName}`.toLowerCase().includes(search.toLowerCase());

export const matchingTables = (
  snapshot: SchemaSnapshot,
  search: string,
): TableSnapshot[] =>
  snapshot.tables.filter(
    (table) =>
      matchesTableName(table, search) ||
      inspectTabs.some((tab) =>
        inspectEntries(table, tab).some((entry) => matchesEntry(entry, search)),
      ),
  );

/** Use the migration compiler so the preview includes enums, constraints and indexes. */
export const inspectTableSQL = (
  snapshot: SchemaSnapshot,
  table: TableSnapshot,
): string => {
  const migration = migrationSnapshot(snapshot);
  const definition = migration.tables.find(
    (candidate) => candidate.name === table.sqlName,
  )!;
  const enumerations = new Set(
    definition.columns.flatMap((column) =>
      column.enumeration ? [column.enumeration] : [],
    ),
  );

  return [
    ...migration.enumerations
      .filter((enumeration) => enumerations.has(enumeration.name))
      .map((enumeration) =>
        enumerationSQL(enumeration.name, enumeration.values),
      ),
    tableSQL(definition),
    ...definition.columns
      .filter((column) => column.references)
      .map((column) => foreignKeySQL(definition, column)),
    ...definition.indexes.map((index) => indexSQL(definition, index)),
  ]
    .map((statement) => `${statement};`)
    .join("\n\n");
};

const sqlKeywords = new Set(
  "CREATE TABLE TYPE AS ENUM ALTER ADD CONSTRAINT PRIMARY KEY FOREIGN REFERENCES ON DELETE UPDATE CASCADE RESTRICT SET NULL NOT DEFAULT GENERATED ALWAYS BY IDENTITY UNIQUE CHECK INDEX USING INCLUDE WHERE ASC DESC AND OR TRUE FALSE IS IN LIKE BETWEEN SELECT FROM NO ACTION MATCH FULL PARTIAL SIMPLE DEFERRABLE INITIALLY DEFERRED IMMEDIATE LEFT RIGHT INNER OUTER CROSS JOIN GROUP ORDER HAVING LIMIT OFFSET DISTINCT EXISTS RETURNING INSERT INTO VALUES CONFLICT DO NOTHING UNION ALL WITH FOR SHARE SKIP LOCKED NOWAIT EXPLAIN ANALYZE BUFFERS FORMAT JSON NULLS FIRST LAST".split(
    " ",
  ),
);

export const highlightSQL = (sql: string, color: boolean): string => {
  if (!color) {
    return sql;
  }

  const { style } = theme(color);

  return sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|(\$(?:[a-z_][\w]*)?\$)[\s\S]*?\1|\$\d+|\bE'(?:\\.|''|[^'])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b[a-z_][\w]*\b/gi,
    (token) => {
      if (token.startsWith("--") || token.startsWith("/*")) {
        return style(token, "muted");
      }

      if (token.startsWith('"')) {
        return style(token, "accent");
      }

      if (/^(?:E?'|\$)/i.test(token)) {
        return style(token, "pink");
      }

      if (sqlKeywords.has(token.toUpperCase())) {
        return style(token, "violet");
      }

      if (/^\d/.test(token)) {
        return style(token, "pink");
      }

      return token;
    },
  );
};
