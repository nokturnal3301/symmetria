import { INDEX_METHODS as RUNTIME_INDEX_METHODS } from "symmetria/internal";
import type { CatalogConstraint } from "../migrations/catalog";
import type { IndexDetailRow } from "./catalog";
import {
  declaredCondition,
  declaredKey,
  valueKind,
  type ConditionScope,
} from "./conditions";
import {
  camelKey,
  naturalKey,
  conventionalNames,
  escapeTemplate,
  pascal,
  quoteSql,
} from "./names";
import type {
  PullWarning,
  PulledMember,
  IndexKeySource,
  PulledIndex,
  PulledCondition,
  PulledCheck,
  PulledTable,
} from "./pulled";
import { type TableFacts, renameFix } from "./model";

/** Warns, with a RENAME CONSTRAINT fix, when the primary key is not named `<table>_pkey`. */
export const primaryKeyName = (
  table: TableFacts,
  declared: PulledTable,
  warn: (warning: PullWarning) => void,
) => {
  const constraint = table.primaryKey;
  const expected = conventionalNames.primaryKey(table.sqlName);

  if (!constraint || constraint.name === expected) {
    return;
  }

  declared.comments.push(
    `primary key "${constraint.name}" is named "${expected}"`,
  );
  warn({
    code: "constraint-name",
    table: table.sqlName,
    object: constraint.name,
    message: `primary key "${constraint.name}" will be expected as "${expected}"`,
    fix: renameFix(table.sqlName, constraint.name, expected),
  });
};

export const primaryKey = (
  table: TableFacts,
  declared: PulledTable,
  warn: (warning: PullWarning) => void,
) => {
  const constraint = table.primaryKey;

  if (!constraint) {
    const id = declared.members.find((member) => member.key === "id");

    if (id?.kind === "column" && id.nullable) {
      // schema() would infer a primary key from "id", which must not be nullable.
      declared.members.splice(declared.members.indexOf(id), 1);
      declared.skipped.push({
        sqlName: id.sqlName,
        dataType:
          table.columns.find((column) => column.column_name === id.sqlName)
            ?.data_type ?? "",
        reason: 'a nullable "id" without a primary key cannot be declared',
      });
      warn({
        code: "primary-key",
        table: table.sqlName,
        column: id.sqlName,
        message: `"${table.sqlName}" has no primary key and its "id" column is nullable; the column is left out because the schema would make it the key`,
        fix: `ALTER TABLE ${quoteSql(table.sqlName)} ALTER COLUMN "id" SET NOT NULL, ADD PRIMARY KEY ("id");`,
      });
    } else if (id) {
      warn({
        code: "primary-key",
        table: table.sqlName,
        message: `"${table.sqlName}" has no primary key, but the schema treats its "id" column as one`,
        fix: `ALTER TABLE ${quoteSql(table.sqlName)} ADD PRIMARY KEY ("id");`,
      });
    } else {
      warn({
        code: "primary-key",
        table: table.sqlName,
        message: `"${table.sqlName}" has no primary key; other tables cannot reference it`,
      });
    }

    return;
  }

  primaryKeyName(table, declared, warn);

  const members = constraint.columns.map((column) =>
    declared.members.find((member) => member.sqlName === column),
  );

  if (members.some((member) => !member)) {
    warn({
      code: "primary-key",
      table: table.sqlName,
      object: constraint.name,
      message: `primary key "${constraint.name}" includes a column the schema could not declare`,
    });

    return;
  }

  const [single] = members as PulledMember[];

  if (members.length === 1 && single!.kind === "column") {
    if (single!.key !== "id") {
      single!.primaryKey = true;
    }

    return;
  }

  declared.primaryKey = (members as PulledMember[]).map((member) =>
    member.kind === "reference" ? `${member.key}Id` : member.key,
  );
};

/** The columns a table's conditions name, with the kind of value each one holds. */
export const conditionScope = (
  table: TableFacts,
  declared: PulledTable,
  enumLabels: ReadonlyMap<string, string[]>,
): ConditionScope => {
  const members = scopeMembers(declared);

  return new Map(
    table.columns.flatMap((column) => {
      const member = members.get(column.column_name);
      const labels =
        column.enum_name && column.enum_schema === null
          ? enumLabels.get(column.enum_name)
          : undefined;

      return member
        ? [
            [
              column.column_name,
              {
                source: `${declared.binding}.${member}`,
                sqlType: column.data_type,
                value: valueKind(column.data_type, labels),
              },
            ] as const,
          ]
        : [];
    }),
  );
};

/** A condition as a DSL predicate when it can be one, else as `sql` text. */
export const pulledCondition = (
  text: string,
  scope: ConditionScope,
  declared: PulledTable,
): PulledCondition => {
  const predicate = declaredCondition(text, scope);

  return predicate
    ? { kind: "predicate", ...predicate }
    : {
        kind: "sql",
        template: interpolate(
          withoutTruthComparison(text),
          scopeMembers(declared),
          declared.binding,
        ).template,
      };
};

export const checkMember = (
  table: TableFacts,
  constraint: CatalogConstraint,
  warn: (warning: PullWarning) => void,
  taken: Set<string>,
): Omit<PulledCheck, "condition"> => {
  const comments: string[] = [];
  const suffix = `_check`;
  const prefix = `${table.sqlName}_`;
  const conventional =
    constraint.name.startsWith(prefix) && constraint.name.endsWith(suffix)
      ? naturalKey(
          constraint.name.slice(prefix.length, -suffix.length),
          table.casing,
        )
      : undefined;
  let key =
    conventional &&
    !taken.has(conventional) &&
    conventionalNames.check(table.sqlName, conventional, table.casing) ===
      constraint.name
      ? conventional
      : undefined;

  if (!key) {
    // A derived name over 63 bytes ends in a hash of the full name, which the key
    // cannot be read back from; the readable part after the table name stands in.
    const hashed = /^(.+)_[0-9a-f]{12}$/.exec(constraint.name);
    const source =
      hashed && hashed[1]!.startsWith(prefix)
        ? hashed[1]!.slice(prefix.length)
        : constraint.name;
    const base =
      camelKey(source) ??
      camelKey(
        source
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/_(\d)/g, "$1"),
      ) ??
      `check${pascal(String(table.constraints.indexOf(constraint) + 1))}`;
    key = base;

    for (let ordinal = 2; taken.has(key); ordinal += 1) {
      key = `${base}${ordinal}`;
    }

    const expected = conventionalNames.check(table.sqlName, key, table.casing);
    comments.push(`constraint "${constraint.name}" is named "${expected}"`);
    warn({
      code: "constraint-name",
      table: table.sqlName,
      object: constraint.name,
      message: `check constraint "${constraint.name}" will be expected as "${expected}"`,
      fix: renameFix(table.sqlName, constraint.name, expected),
    });
  }

  if (constraint.no_inherit || !constraint.validated) {
    comments.push("declared as a plain CHECK constraint");
    warn({
      code: "check",
      table: table.sqlName,
      object: constraint.name,
      message: `check constraint "${constraint.name}" is NO INHERIT or NOT VALID, which the schema cannot declare`,
    });
  }

  taken.add(key);

  return { key, comments };
};

/** Whether `text` is one parenthesized expression, `(…)`, quotes and strings respected. */
export const parenthesized = (text: string): boolean => {
  if (!text.startsWith("(") || !text.endsWith(")")) {
    return false;
  }

  let depth = 0;

  for (let position = 0; position < text.length; position += 1) {
    const character = text[position]!;

    if (character === "'" || character === '"') {
      // A doubled quote inside a literal or identifier continues it.
      let end = position + 1;

      while (end < text.length) {
        if (text[end] === character) {
          if (text[end + 1] === character) {
            end += 2;
            continue;
          }

          break;
        }

        end += 1;
      }

      position = end;
      continue;
    }

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;

      if (depth === 0 && position < text.length - 1) {
        return false;
      }
    }
  }

  return depth === 0;
};

/**
 * `((expr) = true)` is how PostgreSQL prints a condition declared with `.is(true)`.
 * In a CHECK or WHERE clause the comparison changes nothing (NULL stays NULL), so
 * the inner `(expr)` is declared instead: pulling again then produces the same
 * schema, where each cycle used to wrap one more `= true`.
 */
export const withoutTruthComparison = (text: string): string => {
  let current = text.trim();

  for (;;) {
    let inner = current;

    while (parenthesized(inner)) {
      inner = inner.slice(1, -1).trim();
    }

    const operand = /^(.*?)\s*=\s*true$/is.exec(inner)?.[1]?.trim();

    if (!operand || !parenthesized(operand)) {
      return current;
    }

    current = operand;
  }
};

export type IndexTools = {
  table: TableFacts;
  declared: PulledTable;
  tableNames: Set<string>;
  scope: ConditionScope;
  warn: (warning: PullWarning) => void;
  declare: (index: { exact: boolean; index: PulledIndex }) => void;
};

export const INDEX_METHODS: ReadonlySet<string> = new Set(
  RUNTIME_INDEX_METHODS,
);
export const SQL_KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "null",
  "true",
  "false",
  "in",
  "like",
  "ilike",
  "between",
  "case",
  "when",
  "then",
  "else",
  "end",
  "distinct",
  "from",
  "similar",
  "to",
  "escape",
  "collate",
  "asc",
  "desc",
  "nulls",
  "first",
  "last",
  "array",
  "any",
  "all",
  "some",
  "exists",
  "cast",
  "interval",
  "current_date",
  "current_timestamp",
  "current_time",
  "localtime",
  "localtimestamp",
]);

/**
 * Replaces column references in SQL text with `${table.member}` interpolations
 * and escapes the rest for a template literal. Strings, quoted identifiers,
 * function names and type names are left alone.
 */
export const interpolate = (
  text: string,
  members: Map<string, string>,
  tableKey: string,
): { template: string; columns: number } => {
  let template = "";
  let columns = 0;
  let position = 0;

  while (position < text.length) {
    const character = text[position]!;

    if (character === "'") {
      let end = position + 1;

      while (end < text.length) {
        if (text[end] === "'") {
          if (text[end + 1] === "'") {
            end += 2;
            continue;
          }

          break;
        }

        end += 1;
      }

      template += escapeTemplate(text.slice(position, end + 1));
      position = end + 1;
      continue;
    }

    const identifier =
      character === '"'
        ? /^"((?:[^"]|"")+)"/.exec(text.slice(position))
        : /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(position));

    if (!identifier) {
      template += escapeTemplate(character);
      position += 1;
      continue;
    }

    const token = identifier[0];
    const name =
      character === '"' ? identifier[1]!.replaceAll('""', '"') : token;
    const before = text.slice(0, position);
    const after = text.slice(position + token.length);
    const member = members.get(name);
    const isFunction = /^\s*\(/.test(after);
    const isTypeName =
      /::\s*$/.test(before) ||
      /\.\s*$/.test(before) ||
      /\bcollate\s*$/i.test(before);
    const isKeyword =
      character !== '"' && SQL_KEYWORDS.has(token.toLowerCase());

    if (member && !isFunction && !isTypeName && !isKeyword) {
      template += `\${${tableKey}.${member}}`;
      columns += 1;
    } else {
      template += escapeTemplate(token);
    }

    position += token.length;
  }

  return { template, columns };
};

export const scopeMembers = (declared: PulledTable): Map<string, string> =>
  new Map(
    declared.members.map((member) => [
      member.sqlName,
      member.kind === "reference" ? `${member.key}Id` : member.key,
    ]),
  );

/** Declares one live index through `.indexes()` or, when its name is not derived, the schema-level `indexes` option. */
export const declareIndex = (
  row: IndexDetailRow,
  tools: IndexTools,
  options: { exact?: boolean },
): void => {
  const { table, declared, warn } = tools;
  const skip = (reason: string) =>
    warn({
      code: "index",
      table: table.sqlName,
      object: row.index_name,
      message: `index "${row.index_name}" is not declared: ${reason} (${row.definition})`,
    });

  if (row.nulls_not_distinct) {
    return skip("NULLS NOT DISTINCT is not supported");
  }

  if (!INDEX_METHODS.has(row.method)) {
    return skip(`unsupported access method ${row.method}`);
  }

  const members = scopeMembers(declared);
  const comments: string[] = [];
  const keys: IndexKeySource[] = [];

  for (const [position, rawKey] of row.keys.entries()) {
    const bits = row.options[position] ?? 0;
    const descending = !!(bits & 1);
    const nullsFirst = !!(bits & 2);
    const text = rawKey.trim();

    const operatorClass = row.opclasses[position] ?? undefined;
    // A key collation is declared as part of an expression key: `${t.code} COLLATE "C"`.
    const collation = row.collations[position] ?? undefined;
    const column =
      /^"((?:[^"]|"")+)"$/.exec(text)?.[1]?.replaceAll('""', '"') ??
      (/^[a-z_][a-z0-9_]*$/.test(text) ? text : undefined);
    const nulls: IndexKeySource["nulls"] | undefined =
      descending && !nullsFirst
        ? "last"
        : !descending && nullsFirst
          ? "first"
          : undefined;

    if (column !== undefined && collation === undefined) {
      const member = members.get(column);

      if (!member) {
        return skip(`column "${column}" is not declared`);
      }

      keys.push({
        kind: "column",
        source: member,
        descending,
        ...(nulls ? { nulls } : {}),
        ...(operatorClass ? { opclass: operatorClass } : {}),
      });
      continue;
    }

    // Arithmetic over columns is declared with plus() and friends.
    const computed =
      collation === undefined ? declaredKey(text, tools.scope) : undefined;

    if (computed !== undefined) {
      keys.push({
        kind: "value",
        source: computed,
        descending,
        ...(nulls ? { nulls } : {}),
        ...(operatorClass ? { opclass: operatorClass } : {}),
      });
      continue;
    }

    const expression = interpolate(text, members, declared.binding);

    if (!expression.columns) {
      return skip("expression keys must reference a declared column");
    }

    keys.push({
      kind: "expression",
      source:
        collation === undefined
          ? expression.template
          : `${expression.template} COLLATE ${escapeTemplate(quoteSql(collation))}`,
      descending,
      ...(nulls ? { nulls } : {}),
      ...(operatorClass ? { opclass: operatorClass } : {}),
    });
  }

  const include: string[] = [];

  for (const rawColumn of row.included) {
    const text = rawColumn.trim();
    const column =
      /^"((?:[^"]|"")+)"$/.exec(text)?.[1]?.replaceAll('""', '"') ?? text;
    const member = members.get(column);

    if (!member) {
      return skip(`INCLUDE column "${column}" is not declared`);
    }

    include.push(member);
  }

  const ordered = keys.some((key) => key.descending || key.nulls);

  if (row.is_unique && row.method !== "btree") {
    return skip("unique indexes require btree");
  }

  if (
    ["hash", "spgist", "hnsw", "ivfflat"].includes(row.method) &&
    keys.length !== 1
  ) {
    return skip(`${row.method} indexes take one key`);
  }

  if (include.length && !["btree", "gist", "spgist"].includes(row.method)) {
    return skip(`${row.method} does not support INCLUDE`);
  }

  if (ordered && row.method !== "btree") {
    return skip("ordered keys require btree");
  }

  const where = row.predicate
    ? pulledCondition(row.predicate, tools.scope, declared)
    : undefined;
  const storage = Object.fromEntries(
    (row.reloptions ?? []).flatMap((entry) => {
      const separator = entry.indexOf("=");

      if (separator === -1) {
        return [];
      }

      const name = entry.slice(0, separator).trim();
      const raw = entry.slice(separator + 1).trim();

      return [[name, /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw]];
    }),
  );
  const index: PulledIndex = {
    key: "",
    keys,
    unique: row.is_unique,
    method: row.method,
    include,
    ...(where ? { where } : {}),
    ...(Object.keys(storage).length ? { with: storage } : {}),
    comments,
  };
  const prefix = `${table.sqlName}_`;
  const suffix = "_idx";
  const derivedKey =
    !options.exact &&
    row.index_name.startsWith(prefix) &&
    row.index_name.endsWith(suffix)
      ? naturalKey(
          row.index_name.slice(prefix.length, -suffix.length),
          table.casing,
        )
      : undefined;

  if (
    derivedKey &&
    conventionalNames.index(table.sqlName, derivedKey, table.casing) ===
      row.index_name &&
    !declared.indexes.some((entry) => entry.key === derivedKey)
  ) {
    tools.declare({ exact: false, index: { ...index, key: derivedKey } });

    return;
  }

  if (
    table.casing !== "preserve" &&
    !/^[a-z_][a-z0-9_]*$/.test(row.index_name)
  ) {
    return skip(
      "its name contains characters the schema cannot produce; indexes are named <table>_<key>_idx or by a lowercase schema-level key",
    );
  }

  if (tools.tableNames.has(row.index_name)) {
    return skip("its name is also a table name");
  }

  comments.push("name kept exactly");
  tools.declare({ exact: true, index: { ...index, key: row.index_name } });
};
