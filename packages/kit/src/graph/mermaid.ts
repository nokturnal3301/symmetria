/**
 * Entity-relationship graph of a schema and its Mermaid `erDiagram` rendering,
 * for README files, pull requests and documentation.
 */
import type { SchemaSnapshot } from "symmetria";
import {
  commentText,
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

/**
 * Line breaks (U+2028 and U+2029 too) and other control characters would end
 * a line of the diagram: written as escapes, as in a comment.
 */
const oneLine = commentText;

const entityName = (name: string): string =>
  /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)
    ? name
    : `"${oneLine(name).replaceAll('"', "#quot;")}"`;

/**
 * Mermaid attribute types and names are one word: a letter or `_` first, then
 * letters, digits, `_`, `-`, brackets and parentheses. Anything else becomes
 * `_` (`First Name` → `First_Name`, `2fa` → `_2fa`).
 */
const attributeWord = (text: string): string => {
  const word = text.replace(/[^A-Za-z0-9_()[\]-]/g, "_");

  return /^[A-Za-z_]/.test(word) ? word : `_${word}`;
};

const attributeKeys = (column: GraphColumn): string => {
  const keys = [
    ...(column.primaryKey ? ["PK"] : []),
    ...(column.foreignKey ? ["FK"] : []),
    ...(column.unique && !column.primaryKey ? ["UK"] : []),
  ];

  return keys.length ? ` ${keys.join(", ")}` : "";
};

/**
 * An attribute's comment, a quoted string with no `"` inside: the real name
 * of an attribute written as another word, and the notes.
 */
const attributeComment = (column: GraphColumn, word: string): string => {
  const notes = [
    ...(word === column.name
      ? []
      : [`name: ${oneLine(column.name).replaceAll('"', "'")}`]),
    ...(column.nullable ? ["nullable"] : []),
    ...(column.identity ? ["identity"] : []),
  ];

  return notes.length ? ` "${notes.join(", ")}"` : "";
};

/** A relationship label: one word, or a quoted string with no `"` inside. */
const relationshipLabel = (label: string): string =>
  /^[A-Za-z_][A-Za-z0-9_-]*$/.test(label)
    ? label
    : `"${oneLine(label).replaceAll('"', "'")}"`;

const cardinality = (edge: GraphEdge): string => {
  const parent = edge.optional ? "|o" : "||";
  const child = edge.one ? "o|" : "o{";
  const line = edge.identifying ? "--" : "..";

  return `${parent}${line}${child}`;
};

/**
 * A schema graph as a Mermaid `erDiagram`. A column name Mermaid cannot take
 * as an attribute is written with `_` in place of what it cannot take
 * (`First Name` as `First_Name`, `2fa` as `_2fa`), with its real name in the
 * note; other names and relation labels are quoted when they need it.
 */
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
    // Names that become the same word stay apart: `First Name` and
    // `First_Name` are written First_Name and First_Name_2.
    const words = new Set<string>();

    for (const column of table.columns) {
      const base = attributeWord(column.name);
      let word = base;

      for (let suffix = 2; words.has(word); suffix += 1) {
        word = `${base}_${suffix}`;
      }

      words.add(word);
      lines.push(
        `    ${attributeWord(column.type)} ${word}${attributeKeys(column)}${attributeComment(column, word)}`,
      );
    }

    lines.push("  }");
  }

  if (graph.edges.length) {
    lines.push("");
  }

  for (const edge of graph.edges) {
    lines.push(
      `  ${entityName(edge.from)} ${cardinality(edge)} ${entityName(edge.to)} : ${relationshipLabel(edge.label)}`,
    );
  }

  const diagram = `${lines.join("\n")}\n`;

  return options.fenced ? `\`\`\`mermaid\n${diagram}\`\`\`\n` : diagram;
};
