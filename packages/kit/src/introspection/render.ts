/**
 * Renders a pulled schema as TypeScript source in the keyed-callback schema() form,
 * importing only the builders it uses and marking approximations with `// pull:`.
 */
import { sqlKey, type Casing } from "symmetria";
import { escapeTemplate, quoteString } from "./names";
import type {
  ColumnType,
  IndexKeySource,
  PulledColumn,
  PulledCondition,
  PulledIndex,
  PulledMember,
  PulledReference,
  PulledSchema,
  PulledTable,
} from "./model";

export type RenderOptions = {
  /** Name of the exported schema constant (default: appSchema). */
  readonly exportName?: string;
  /** Module specifier for the runtime import (default: symmetria). */
  readonly module?: string;
  /** Comment lines placed at the top of the file. */
  readonly header?: readonly string[];
  /** Module specifier for the pgvector entry (default: `${module}/vector`). */
  readonly vectorModule?: string;
};

const PASSTHROUGH = `/** Driver-native values for types without a builder; replace with real codecs when convenient. */
const passthrough = <Value>() => ({
  encode: (value: Value): unknown => value,
  decode: (value: unknown): Value => value as Value,
});`;

const IMPORT_ORDER = [
  "and",
  "bigint",
  "bool",
  "bytea",
  "customType",
  "date",
  "doublePrecision",
  "index",
  "inet",
  "int",
  "interval",
  "jsonb",
  "junction",
  "not",
  "numeric",
  "oneOf",
  "operatorClass",
  "or",
  "real",
  "schema",
  "smallint",
  "sql",
  "table",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "tsvector",
  "uuid",
  "varchar",
];

const typeSource = (type: ColumnType, imports: Set<string>): string => {
  switch (type.kind) {
    case "builder":
      imports.add(type.name);

      return type.name === "jsonb"
        ? "jsonb<unknown>()"
        : type.precision === undefined
          ? type.name
          : `${type.name}(${type.precision})`;
    case "varchar":
      imports.add("varchar");

      return type.length === undefined ? "varchar" : `varchar(${type.length})`;
    case "numeric": {
      imports.add("numeric");
      const arguments_ = [type.precision, type.scale].filter(
        (part) => part !== undefined,
      );

      return arguments_.length
        ? `numeric(${arguments_.join(", ")})`
        : "numeric";
    }
    case "enum":
      imports.add("oneOf");

      return `oneOf(${type.values.map(quoteString).join(", ")})${type.name === undefined ? "" : `.typeName(${quoteString(type.name)})`}`;
    case "vector":
      imports.add("vector");

      return `vector(${type.dimensions ?? ""})`;
    case "custom":
      imports.add("customType");

      return `customType<${type.valueType}>(${quoteString(type.sqlType)}, passthrough<${type.valueType}>())`;
  }
};

const columnSource = (
  column: PulledColumn,
  imports: Set<string>,
  casing: Casing,
): string => {
  let source = typeSource(column.type, imports);

  if (column.collation !== undefined) {
    source += `.collate(${quoteString(column.collation)})`;
  }

  if (column.array) {
    source += ".array";
  }

  if (sqlKey(column.key, casing) !== column.sqlName) {
    source += `.named(${quoteString(column.sqlName)})`;
  }

  switch (column.default?.kind) {
    case "auto":
      source += column.default.byDefault ? ".auto.byDefault" : ".auto";
      break;
    case "now":
      source += ".now";
      break;
    case "v4":
      source += ".v4";
      break;
    case "v7":
      source += ".v7";
      break;
    case "identity":
      imports.add("sql");
      source += ".default(sql`identity`)";
      break;
    case "value":
      source += `.default(${column.default.source})`;
      break;
    case "sql":
      imports.add("sql");
      source += `.default(sql\`${escapeTemplate(column.default.sql)}\`)`;
      break;
    default:
  }

  if (column.nullable) {
    source += ".nullable";
  }

  if (column.unique) {
    source += ".unique";
  }

  if (column.index) {
    source += ".index";
  }

  if (column.primaryKey) {
    source += ".primaryKey";
  }

  return source;
};

const referenceSource = (
  reference: PulledReference,
  bindings: ReadonlyMap<string, string>,
): string => {
  let source = bindings.get(reference.target) ?? reference.target;

  if (reference.by) {
    source += `.by(${quoteString(reference.by)})`;
  }

  if (reference.column) {
    source += `.column(${quoteString(reference.column)})`;
  }

  if (reference.nullable) {
    source += ".nullable";
  }

  if (reference.unique) {
    source += ".unique";
  }

  if (reference.index) {
    source += ".index";
  }

  if (reference.onDelete) {
    source += `.onDelete.${reference.onDelete}`;
  }

  if (reference.onUpdate) {
    source += `.onUpdate.${reference.onUpdate}`;
  }

  if (reference.inverse) {
    source += `.inverse(${quoteString(reference.inverse)})`;
  }

  return source;
};

const comment = (notes: readonly string[]): string =>
  notes.length ? ` // pull: ${notes.join("; ")}` : "";

const memberLine = (
  member: PulledMember,
  imports: Set<string>,
  casing: Casing,
  bindings: ReadonlyMap<string, string>,
): string =>
  `${member.key}: ${member.kind === "column" ? columnSource(member, imports, casing) : referenceSource(member, bindings)},${comment(member.comments)}`;

/** `{ users, date: dateTable }`: tables destructured by key under their bindings. */
const destructure = (
  keys: readonly string[],
  bindings: ReadonlyMap<string, string>,
): string =>
  `{ ${keys
    .map((key) => {
      const binding = bindings.get(key) ?? key;

      return binding === key ? key : `${key}: ${binding}`;
    })
    .join(", ")} }`;

const keySource = (
  key: IndexKeySource,
  tableKey: string,
  imports: Set<string>,
): string => {
  let source =
    key.kind === "column"
      ? `${tableKey}.${key.source}`
      : key.kind === "value"
        ? key.source
        : `sql<string>\`${key.source}\``;

  if (key.descending) {
    source += ".descending";
  } else if (key.nulls) {
    source += ".ascending";
  }

  if (key.nulls) {
    source += key.nulls === "first" ? ".nullsFirst" : ".nullsLast";
  }

  if (key.opclass) {
    imports.add("operatorClass");

    return `operatorClass(${source}, ${quoteString(key.opclass)})`;
  }

  return source;
};

const storageSource = (options: Record<string, string | number>): string =>
  `{ ${Object.entries(options)
    .map(
      ([name, value]) =>
        `${/^[a-z_][a-z0-9_]*$/i.test(name) ? name : quoteString(name)}: ${typeof value === "number" ? value : quoteString(value)}`,
    )
    .join(", ")} }`;

/**
 * A CHECK or WHERE condition: a predicate as it is, or a boolean `sql`
 * expression, which is a condition by itself (`.is(true)` would add `= true`).
 */
const conditionSource = (
  condition: PulledCondition,
  imports: Set<string>,
): string => {
  if (condition.kind === "predicate") {
    for (const name of condition.imports) {
      imports.add(name);
    }

    return condition.source;
  }

  imports.add("sql");

  return `sql<boolean>\`${condition.template}\``;
};

const indexSource = (
  index: PulledIndex,
  tableKey: string,
  imports: Set<string>,
): string => {
  imports.add("index");

  if (index.keys.some((key) => key.kind === "expression")) {
    imports.add("sql");
  }

  let source = `index(${index.keys.map((key) => keySource(key, tableKey, imports)).join(", ")})`;

  if (index.unique) {
    source += ".unique";
  }

  if (index.method !== "btree") {
    source += `.using(${quoteString(index.method)})`;
  }

  if (index.include.length) {
    source += `.include(${index.include.map((member) => `${tableKey}.${member}`).join(", ")})`;
  }

  if (index.with) {
    source += `.with(${storageSource(index.with)})`;
  }

  if (index.where) {
    source += `.where(${conditionSource(index.where, imports)})`;
  }

  return source;
};

const tableSource = (
  table: PulledTable,
  imports: Set<string>,
  casing: Casing,
  bindings: ReadonlyMap<string, string>,
): string[] => {
  const targets = [
    ...new Set(
      table.members
        .filter(
          (member): member is PulledReference => member.kind === "reference",
        )
        .map((member) => member.target),
    ),
  ].sort();
  const callback = targets.length > 0;
  const indent = callback ? "      " : "    ";
  const constructor = table.junction ? "junction" : "table";
  imports.add(constructor);
  const body = [
    ...table.comments.map((note) => `${indent}// pull: ${note}`),
    ...table.members.map(
      (member) => `${indent}${memberLine(member, imports, casing, bindings)}`,
    ),
    ...table.skipped.map(
      (column) =>
        `${indent}// ${column.sqlName} ${column.dataType}: pull: ${column.reason}`,
    ),
  ];
  // Chain links are rendered as line arrays so outer indentation applies to every line.
  const chain: string[][] = [];

  if (sqlKey(table.key, casing) !== table.sqlName) {
    chain.push([`.named(${quoteString(table.sqlName)})`]);
  }

  if (table.primaryKey) {
    chain.push([
      `.primaryKey((${table.binding}) => [${table.primaryKey.map((key) => `${table.binding}.${key}`).join(", ")}])`,
    ]);
  }

  if (table.indexes.length) {
    chain.push([
      `.indexes((${table.binding}) => ({`,
      ...table.indexes.map(
        (index) =>
          `  ${index.key}: ${indexSource(index, table.binding, imports)},${comment(index.comments)}`,
      ),
      "}))",
    ]);
  }

  if (table.checks.length) {
    chain.push([
      `.checks((${table.binding}) => ({`,
      ...table.checks.map(
        (check) =>
          `  ${check.key}: ${conditionSource(check.condition, imports)},${comment(check.comments)}`,
      ),
      "}))",
    ]);
  }

  const chainIndent = callback ? "      " : "    ";
  const chainLines = chain.flatMap((link, position) =>
    link.map((line, lineIndex) =>
      position === chain.length - 1 && lineIndex === link.length - 1
        ? `${chainIndent}${line},`
        : `${chainIndent}${line}`,
    ),
  );
  const closing = chainLines.length
    ? [`${indent.slice(2)}})`, ...chainLines]
    : [`${indent.slice(2)}}),`];

  if (!callback) {
    return [`  ${table.key}: ${constructor}({`, ...body, ...closing];
  }

  return [
    `  ${table.key}: (${destructure(targets, bindings)}) =>`,
    `    ${constructor}({`,
    ...body,
    ...closing,
  ];
};

const importLine = (names: readonly string[], module: string): string => {
  const single = `import { ${names.join(", ")} } from ${quoteString(module)};`;

  return single.length <= 80
    ? single
    : `import {\n${names.map((name) => `  ${name},`).join("\n")}\n} from ${quoteString(module)};`;
};

export const renderSchema = (
  model: PulledSchema,
  options: RenderOptions = {},
): string => {
  const exportName = options.exportName ?? "appSchema";
  const module = options.module ?? "symmetria";
  const imports = new Set<string>(["schema"]);
  const bindings = new Map(
    model.tables.map((table) => [table.key, table.binding]),
  );
  const tables = model.tables.flatMap((table) =>
    tableSource(table, imports, model.casing, bindings),
  );
  // Schema-level indexes contribute imports too, so render them before the import line.
  for (const { binding, index } of model.schemaIndexes) {
    indexSource(index, binding, imports);
  }
  const passthrough = model.tables.some((table) =>
    table.members.some(
      (member) => member.kind === "column" && member.type.kind === "custom",
    ),
  );
  const header = options.header ?? [
    `Generated by symmetria pull from schema ${quoteString(model.schemaName)}.`,
    "Lines marked `pull:` are approximations; the command lists every warning.",
  ];
  const schemaIndexLines = model.schemaIndexes.map(
    ({ binding, index }) =>
      `      ${/^[a-z_][a-z0-9_]*$/i.test(index.key) ? index.key : quoteString(index.key)}: ${indexSource(index, binding, imports)},${comment(index.comments)}`,
  );
  const optionLines = [
    ...(model.casing === "preserve" ? [`    casing: "preserve",`] : []),
    ...(model.extensions.length
      ? [`    extensions: [${model.extensions.map(quoteString).join(", ")}],`]
      : []),
    ...(schemaIndexLines.length
      ? [
          `    indexes: (${destructure([...new Set(model.schemaIndexes.map((entry) => entry.table))].sort(), bindings)}) => ({`,
          ...schemaIndexLines,
          "    }),",
        ]
      : []),
  ];
  const vectorImport = imports.has("vector")
    ? [
        `import { vector } from ${quoteString(options.vectorModule ?? `${module}/vector`)};`,
      ]
    : [];
  const sections = [
    header.map((line) => `// ${line}`).join("\n"),
    [
      importLine(
        IMPORT_ORDER.filter((name) => imports.has(name)),
        module,
      ),
      ...vectorImport,
    ].join("\n"),
    ...(passthrough ? [PASSTHROUGH] : []),
    ...(model.skippedTables.length
      ? [
          model.skippedTables
            .map(
              (table) =>
                `// pull: table "${table.sqlName}" skipped: ${table.reason}`,
            )
            .join("\n"),
        ]
      : []),
    optionLines.length
      ? `export const ${exportName} = schema(\n  {\n${tables.map((line) => (line ? `  ${line}` : line)).join("\n")}\n  },\n  {\n${optionLines.join("\n")}\n  },\n);`
      : `export const ${exportName} = schema({\n${tables.join("\n")}\n});`,
  ];

  return `${sections.join("\n\n")}\n`;
};
