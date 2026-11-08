/**
 * Entity-relationship graph of a schema and its Mermaid `erDiagram` rendering,
 * for README files, pull requests and documentation.
 */
import type { SchemaSnapshot } from "symmetria";
import {
  migrationSnapshot,
  parseMigrationSnapshot,
  type MigrationSnapshot,
} from "../migrations/snapshot";

export type GraphColumn = {
  readonly name: string;
  readonly type: string;
  readonly primaryKey: boolean;
  readonly foreignKey: boolean;
  readonly unique: boolean;
  readonly nullable: boolean;
  readonly identity: boolean;
};

export type GraphTable = {
  readonly name: string;
  readonly columns: readonly GraphColumn[];
  /** A table whose primary key is exactly its two foreign keys. */
  readonly junction: boolean;
};

export type GraphEdge = {
  /** The referenced (parent) table. */
  readonly from: string;
  /** The referencing (child) table. */
  readonly to: string;
  readonly column: string;
  /** Relation name shown on the edge: the column without its `_id` suffix. */
  readonly label: string;
  /** The foreign key is nullable, so a child may have no parent. */
  readonly optional: boolean;
  /** The foreign key is unique, so the relation is one-to-one. */
  readonly one: boolean;
  /** The foreign key is part of the child's primary key. */
  readonly identifying: boolean;
};

export type SchemaGraph = {
  readonly tables: readonly GraphTable[];
  readonly edges: readonly GraphEdge[];
};

export type MermaidOptions = {
  /** Wrap the diagram in a ```mermaid fence for Markdown. */
  readonly fenced?: boolean;
  /** Leave out column lists and show only entities and relations. */
  readonly compact?: boolean;
};

const relationLabel = (column: string): string =>
  column.endsWith("_id") && column.length > 3 ? column.slice(0, -3) : column;

/** Tables, columns and foreign-key edges of a declared schema or a migration snapshot. */
export const schemaGraph = (
  snapshot: SchemaSnapshot | MigrationSnapshot,
): SchemaGraph => {
  const expected =
    "version" in snapshot
      ? parseMigrationSnapshot(snapshot)
      : migrationSnapshot(snapshot);
  // A declared schema knows its relation names; migration snapshots fall back to the column name.
  const relationNames = new Map<string, string>();

  if (!("version" in snapshot)) {
    for (const table of snapshot.tables) {
      for (const relation of table.relations) {
        const column =
          relation.kind === "one" && !relation.reverse
            ? table.columns.find((entry) => entry.name === relation.foreignKey)
            : undefined;

        if (column) {
          relationNames.set(
            `${table.sqlName}.${column.sqlName}`,
            relation.name,
          );
        }
      }
    }
  }

  const edges: GraphEdge[] = [];
  const tables = expected.tables.map((table): GraphTable => {
    const primaryKey = new Set(table.primaryKey);
    const ordered = table.columns;
    const columns = ordered.map(
      (column): GraphColumn => ({
        name: column.name,
        type: column.enumeration ?? column.sqlType,
        primaryKey: primaryKey.has(column.name),
        foreignKey: !!column.references,
        unique: column.unique,
        nullable: !column.notNull,
        identity: column.identity,
      }),
    );

    for (const column of ordered) {
      if (column.references) {
        edges.push({
          from: column.references.table,
          to: table.name,
          column: column.name,
          label:
            relationNames.get(`${table.name}.${column.name}`) ??
            relationLabel(column.name),
          optional: !column.notNull,
          one: column.unique,
          identifying: primaryKey.has(column.name),
        });
      }
    }

    const keyColumns = table.columns.filter((column) =>
      primaryKey.has(column.name),
    );

    return {
      name: table.name,
      columns,
      junction:
        keyColumns.length === 2 &&
        keyColumns.every((column) => column.references),
    };
  });

  return { tables, edges };
};

const entityName = (name: string): string =>
  /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)
    ? name
    : `"${name.replaceAll('"', "#quot;")}"`;

/** Mermaid attribute types allow letters, digits, `_`, `-`, brackets and parentheses. */
const attributeType = (type: string): string =>
  type.replace(/[^A-Za-z0-9_()[\]-]/g, "_");

const attributeKeys = (column: GraphColumn): string => {
  const keys = [
    ...(column.primaryKey ? ["PK"] : []),
    ...(column.foreignKey ? ["FK"] : []),
    ...(column.unique && !column.primaryKey ? ["UK"] : []),
  ];

  return keys.length ? ` ${keys.join(", ")}` : "";
};

const attributeComment = (column: GraphColumn): string => {
  const notes = [
    ...(column.nullable ? ["nullable"] : []),
    ...(column.identity ? ["identity"] : []),
  ];

  return notes.length ? ` "${notes.join(", ")}"` : "";
};

const cardinality = (edge: GraphEdge): string => {
  const parent = edge.optional ? "|o" : "||";
  const child = edge.one ? "o|" : "o{";
  const line = edge.identifying ? "--" : "..";

  return `${parent}${line}${child}`;
};

export const renderMermaid = (
  graph: SchemaGraph,
  options: MermaidOptions = {},
): string => {
  const lines = ["erDiagram"];

  for (const table of graph.tables) {
    if (options.compact || !table.columns.length) {
      lines.push(`  ${entityName(table.name)}`);
      continue;
    }

    lines.push(`  ${entityName(table.name)} {`);

    for (const column of table.columns) {
      lines.push(
        `    ${attributeType(column.type)} ${column.name}${attributeKeys(column)}${attributeComment(column)}`,
      );
    }

    lines.push("  }");
  }

  if (graph.edges.length) {
    lines.push("");
  }

  for (const edge of graph.edges) {
    lines.push(
      `  ${entityName(edge.from)} ${cardinality(edge)} ${entityName(edge.to)} : ${edge.label}`,
    );
  }

  const diagram = `${lines.join("\n")}\n`;

  return options.fenced ? `\`\`\`mermaid\n${diagram}\`\`\`\n` : diagram;
};
