/**
 * Turns the live catalog into a declaration model: which builder, modifiers and
 * default each column gets, which foreign keys become relations, which tables are
 * junctions, plus a warning for everything the DSL cannot express faithfully.
 */
import { INDEX_METHODS as RUNTIME_INDEX_METHODS } from "symmetria/internal";
import { normalizeSqlType } from "../migrations/drift";
import type { CatalogConstraint } from "../migrations/catalog";
import type { IndexDetailRow, PullCatalog } from "./catalog";
import {
  camelKey,
  conventionalNames,
  escapeTemplate,
  isReservedColumnKey,
  isReservedTableKey,
  pascal,
  quoteSql,
} from "./names";

export type PullWarningCode =
  | "identity-by-default"
  | "serial"
  | "identity-type"
  | "generated-column"
  | "custom-type"
  | "constraint-name"
  | "foreign-key"
  | "unique-constraint"
  | "index"
  | "junction-index"
  | "check"
  | "enum"
  | "primary-key"
  | "name"
  | "partition"
  | "exclusion"
  | "extension";

export type PullWarning = {
  readonly code: PullWarningCode;
  readonly table?: string;
  readonly column?: string;
  /** The constraint, index or type the warning is about. */
  readonly object?: string;
  readonly message: string;
  /** SQL that makes the database match what the generated schema declares. */
  readonly fix?: string;
};

export type ColumnType =
  | {
      kind: "builder";
      name:
        | "int"
        | "bigint"
        | "smallint"
        | "real"
        | "doublePrecision"
        | "text"
        | "bool"
        | "uuid"
        | "timestamptz"
        | "date"
        | "time"
        | "interval"
        | "bytea"
        | "inet"
        | "jsonb"
        | "tsvector";
    }
  | { kind: "varchar"; length?: number }
  | { kind: "numeric"; precision?: number; scale?: number }
  | { kind: "enum"; values: string[] }
  | { kind: "vector"; dimensions?: number }
  | { kind: "custom"; sqlType: string; valueType: string };

export type ColumnDefault =
  | { kind: "auto" }
  | { kind: "now" }
  | { kind: "v4" }
  | { kind: "v7" }
  | { kind: "identity" }
  | { kind: "value"; source: string }
  | { kind: "sql"; sql: string };

export type PulledColumn = {
  kind: "column";
  key: string;
  sqlName: string;
  type: ColumnType;
  array: boolean;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  primaryKey: boolean;
  default?: ColumnDefault;
  comments: string[];
};

export type PulledReference = {
  kind: "reference";
  key: string;
  sqlName: string;
  /** Key of the referenced table. */
  target: string;
  /** Key of the referenced column when it is a unique column rather than the primary key. */
  by?: string;
  /** The SQL column name when it is not `<key>_id`. */
  column?: string;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  onDelete?: "cascade" | "setNull" | "noAction";
  inverse?: string;
  comments: string[];
};

export type PulledMember = PulledColumn | PulledReference;

export type IndexKeySource = {
  /** `column` keys name a scope member; `expression` keys hold template text with `${table.column}` interpolations. */
  kind: "column" | "expression";
  source: string;
  descending: boolean;
  nulls?: "first" | "last";
  /** Non-default operator class, rendered through operatorClass(). */
  opclass?: string;
};

export type PulledIndex = {
  /** Object key in the indexes callback; the exact SQL name for schema-level indexes. */
  key: string;
  keys: IndexKeySource[];
  unique: boolean;
  method: string;
  /** Scope member keys. */
  include: string[];
  /** Predicate template text, already interpolated and escaped. */
  where?: string;
  /** Storage parameters from pg_class.reloptions. */
  with?: Record<string, string | number>;
  comments: string[];
};

export type PulledCheck = {
  key: string;
  /** Predicate template text, already interpolated and escaped. */
  expression: string;
  comments: string[];
};

export type PulledTable = {
  key: string;
  sqlName: string;
  junction: boolean;
  members: PulledMember[];
  /** Member keys of an explicit primary key callback (composite keys and keys over relations). */
  primaryKey?: string[];
  indexes: PulledIndex[];
  checks: PulledCheck[];
  comments: string[];
  skipped: { sqlName: string; dataType: string; reason: string }[];
};

export type PulledSchema = {
  schemaName: string;
  tables: PulledTable[];
  /** Indexes whose SQL names do not follow `<table>_<key>_idx`, declared with their exact names. */
  schemaIndexes: { table: string; index: PulledIndex }[];
  /** Installed extensions other than plpgsql, declared through the schema options. */
  extensions: string[];
  skippedTables: { sqlName: string; reason: string }[];
  warnings: PullWarning[];
};

type CatalogColumn = PullCatalog["columns"][number];

type TableFacts = {
  key: string;
  sqlName: string;
  columns: CatalogColumn[];
  generated: Set<string>;
  constraints: CatalogConstraint[];
  indexes: IndexDetailRow[];
  primaryKey: CatalogConstraint | undefined;
  /** Eligible foreign keys by column name. */
  references: Map<string, PendingReference>;
  junction: boolean;
};

type PendingReference = {
  constraint: CatalogConstraint;
  key: string;
  targetSql: string;
  by?: string | undefined;
  column?: string | undefined;
};

const ON_DELETE: Record<string, PulledReference["onDelete"]> = {
  c: "cascade",
  n: "setNull",
  a: "noAction",
};

const columnIdentifier = (name: string) =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : quoteSql(name);

/** JavaScript value type for a PostgreSQL type without a builder, as both drivers deliver it. */
const customValueType = (sqlType: string): string => {
  if (/^(oid|money)$/.test(sqlType) || /^float\d$/.test(sqlType)) {
    return "number";
  }

  if (sqlType === "timestamp without time zone") {
    return "Date";
  }

  if (sqlType === "json") {
    return "unknown";
  }

  return "string";
};

const renameFix = (table: string, from: string, to: string) =>
  `ALTER TABLE ${quoteSql(table)} RENAME CONSTRAINT ${quoteSql(from)} TO ${quoteSql(to)};`;

export const buildPulledSchema = (catalog: PullCatalog): PulledSchema => {
  const warnings: PullWarning[] = [];
  const skippedTables: PulledSchema["skippedTables"] = [];
  const schemaIndexes: PulledSchema["schemaIndexes"] = [];
  const warn = (warning: PullWarning) => {
    warnings.push(warning);
  };

  // Enum ownership: a column can declare an enum with oneOf() only when it is the
  // enum's only user and the type already carries the derived name.
  const enumUsers = new Map<string, CatalogColumn[]>();

  for (const column of catalog.columns) {
    if (column.enum_name) {
      const users = enumUsers.get(column.enum_name) ?? [];
      users.push(column);
      enumUsers.set(column.enum_name, users);
    }
  }

  const enumLabels = new Map(
    catalog.enumerations.map((entry) => [entry.name, entry.values]),
  );
  const ownsEnum = (column: CatalogColumn): boolean =>
    !!column.enum_name &&
    column.enum_schema === null &&
    enumUsers.get(column.enum_name)?.length === 1 &&
    column.enum_name ===
      conventionalNames.enumeration(column.table_name, column.column_name);

  // -- pass 1: tables that can be declared, with their catalog facts ----------
  const facts = new Map<string, TableFacts>();

  for (const table of catalog.tables) {
    const details = catalog.details.find((entry) => entry.name === table.name);

    if (details?.partition) {
      skippedTables.push({
        sqlName: table.name,
        reason: "partitions are declared through their parent table",
      });
      warn({
        code: "partition",
        table: table.name,
        message: `"${table.name}" is a partition; only the parent table is declared`,
      });
      continue;
    }

    const key = camelKey(table.name);

    if (!key || isReservedTableKey(key)) {
      skippedTables.push({
        sqlName: table.name,
        reason: "the name cannot be produced by a schema key",
      });
      warn({
        code: "name",
        table: table.name,
        message: `"${table.name}" cannot be declared: table keys are camelCase and map to lowercase snake_case names`,
      });
      continue;
    }

    const layout = catalog.layout.filter(
      (entry) => entry.table_name === table.name,
    );
    const columns = catalog.columns
      .filter((entry) => entry.table_name === table.name)
      .sort((left, right) => {
        const position = (column: CatalogColumn) =>
          layout.find((entry) => entry.column_name === column.column_name)
            ?.position ?? Number.MAX_SAFE_INTEGER;

        return position(left) - position(right);
      });
    const constraints = catalog.constraints.filter(
      (entry) => entry.table_name === table.name,
    );

    if (details?.kind === "p") {
      warn({
        code: "partition",
        table: table.name,
        message: `"${table.name}" is partitioned; the declaration describes a plain table`,
      });
    }

    facts.set(table.name, {
      key,
      sqlName: table.name,
      columns,
      generated: new Set(
        layout
          .filter((entry) => entry.generated !== "")
          .map((entry) => entry.column_name),
      ),
      constraints,
      indexes: catalog.indexDetails.filter(
        (entry) => entry.table_name === table.name,
      ),
      primaryKey: constraints.find((entry) => entry.kind === "p"),
      references: new Map(),
      junction: false,
    });
  }

  // -- pass 2: foreign keys that can become relations -------------------------
  for (const table of facts.values()) {
    const columnKeys = new Set(
      table.columns.map((column) => camelKey(column.column_name)),
    );

    for (const constraint of table.constraints.filter(
      (entry) => entry.kind === "f",
    )) {
      const reason = (() => {
        const [columnName] = constraint.columns;
        const column = table.columns.find(
          (entry) => entry.column_name === columnName,
        );

        if (constraint.columns.length !== 1 || !column) {
          return "composite foreign keys are not supported";
        }

        if (constraint.reference_schema !== null) {
          return "references a table in another schema";
        }

        if (constraint.on_update !== "a") {
          return "ON UPDATE actions are not supported";
        }

        if (constraint.match !== "s") {
          return "MATCH FULL / PARTIAL are not supported";
        }

        if (constraint.deferrable) {
          return "deferrable constraints are not supported";
        }

        if (!constraint.validated) {
          return "the constraint is NOT VALID";
        }

        if (constraint.on_delete === "d") {
          return "ON DELETE SET DEFAULT is not supported";
        }

        // `<relation>_id` columns keep the convention; any other name becomes `.column("<name>")`.
        const conventional =
          columnName!.endsWith("_id") && columnName!.length > 3;
        const key = camelKey(
          conventional ? columnName!.slice(0, -3) : columnName!,
        );

        if (!key || isReservedColumnKey(key)) {
          return `"${columnName}" does not map to a relation key`;
        }

        if (columnKeys.has(key) && key !== camelKey(columnName!)) {
          return `a column already uses the key "${key}"`;
        }

        if (!conventional && columnKeys.has(`${key}Id`)) {
          return `a column already uses the key "${key}Id"`;
        }

        const target = facts.get(constraint.reference_table ?? "");

        if (!target) {
          return `the referenced table "${constraint.reference_table}" is not declared`;
        }

        const [referencedName] = constraint.reference_columns;
        const targetKey = target.primaryKey?.columns;
        const isPrimary =
          targetKey?.length === 1 && targetKey[0] === referencedName;
        const isUnique = target.constraints.some(
          (entry) =>
            entry.kind === "u" &&
            entry.columns.length === 1 &&
            entry.columns[0] === referencedName,
        );

        if (!isPrimary && !isUnique) {
          return "relations must reference a single-column primary key or UNIQUE constraint";
        }

        const targetColumn = target.columns.find(
          (entry) => entry.column_name === referencedName,
        )!;

        if (
          normalizeSqlType(column.data_type) !==
          normalizeSqlType(targetColumn.data_type)
        ) {
          return `its type ${column.data_type} differs from the referenced key ${targetColumn.data_type}`;
        }

        if (column.default !== null || column.identity !== "") {
          return "relation columns cannot carry a default";
        }

        if (table.generated.has(columnName!)) {
          return "generated columns cannot be relations";
        }

        table.references.set(columnName!, {
          constraint,
          key,
          targetSql: target.sqlName,
          ...(isPrimary ? {} : { by: camelKey(referencedName!) }),
          ...(conventional ? {} : { column: columnName! }),
        });

        return undefined;
      })();

      if (reason) {
        warn({
          code: "foreign-key",
          table: table.sqlName,
          column: constraint.columns.join(", "),
          object: constraint.name,
          message: `foreign key "${constraint.name}" is kept as a plain column: ${reason}`,
        });
      }
    }
  }

  // -- pass 3: junctions and the relation namespace ---------------------------
  for (const table of facts.values()) {
    const keyColumns = table.primaryKey?.columns ?? [];

    table.junction =
      keyColumns.length === 2 &&
      keyColumns.every((column) => table.references.has(column)) &&
      !table.columns.some((column) => column.column_name === "id");
  }

  const relationNames = new Map<string, Set<string>>(
    [...facts.values()].map((table) => [table.sqlName, new Set<string>()]),
  );
  const claim = (tableSql: string, name: string): boolean => {
    const names = relationNames.get(tableSql)!;

    if (names.has(name)) {
      return false;
    }

    names.add(name);

    return true;
  };

  for (const table of facts.values()) {
    for (const reference of table.references.values()) {
      claim(table.sqlName, reference.key);
    }
  }

  for (const table of facts.values()) {
    if (!table.junction) {
      continue;
    }

    const [first, second] = table.primaryKey!.columns.map(
      (column) => table.references.get(column)!,
    ) as [PendingReference, PendingReference];
    const firstTarget = facts.get(first.targetSql)!;
    const secondTarget = facts.get(second.targetSql)!;

    if (
      first.targetSql === second.targetSql ||
      relationNames.get(first.targetSql)!.has(secondTarget.key) ||
      relationNames.get(second.targetSql)!.has(firstTarget.key)
    ) {
      table.junction = false;
      warn({
        code: "foreign-key",
        table: table.sqlName,
        message: `"${table.sqlName}" links ${first.targetSql} and ${second.targetSql} but is declared as a plain table: its many-to-many relation names would clash with existing relations`,
      });
      continue;
    }

    claim(first.targetSql, secondTarget.key);
    claim(second.targetSql, firstTarget.key);
  }

  const inverses = new Map<PendingReference, string>();

  for (const table of facts.values()) {
    const ordered = table.columns
      .map((column) => table.references.get(column.column_name))
      .filter((reference): reference is PendingReference => !!reference);

    for (const reference of ordered) {
      const self = reference.targetSql === table.sqlName;

      if (!self && claim(reference.targetSql, table.key)) {
        continue;
      }

      let name = `${table.key}By${pascal(reference.key)}`;
      let attempt = 2;

      while (!claim(reference.targetSql, name)) {
        name = `${table.key}By${pascal(reference.key)}${attempt}`;
        attempt += 1;
      }

      inverses.set(reference, name);
    }
  }

  // -- pass 4: declarations ---------------------------------------------------
  const tables: PulledTable[] = [];

  for (const table of facts.values()) {
    const declared: PulledTable = {
      key: table.key,
      sqlName: table.sqlName,
      junction: table.junction,
      members: [],
      indexes: [],
      checks: [],
      comments: [],
      skipped: [],
    };
    const uniqueConstraints = table.constraints.filter(
      (entry) => entry.kind === "u",
    );
    const primaryKeyColumns = table.primaryKey?.columns ?? [];
    const consumedIndexes = new Set<string>();

    const uniqueFor = (
      columnName: string,
    ): { unique: boolean; comments: string[] } => {
      const constraint = uniqueConstraints.find(
        (entry) =>
          entry.columns.length === 1 && entry.columns[0] === columnName,
      );

      if (!constraint) {
        return { unique: false, comments: [] };
      }

      const comments: string[] = [];
      const expected = conventionalNames.unique(table.sqlName, columnName);

      if (constraint.name !== expected) {
        comments.push(`constraint "${constraint.name}" is named "${expected}"`);
        warn({
          code: "constraint-name",
          table: table.sqlName,
          column: columnName,
          object: constraint.name,
          message: `unique constraint "${constraint.name}" will be expected as "${expected}"`,
          fix: renameFix(table.sqlName, constraint.name, expected),
        });
      }

      if (
        constraint.deferrable ||
        constraint.nulls_not_distinct ||
        !constraint.validated
      ) {
        comments.push("declared as a plain UNIQUE constraint");
        warn({
          code: "unique-constraint",
          table: table.sqlName,
          column: columnName,
          object: constraint.name,
          message: `unique constraint "${constraint.name}" uses options the schema cannot declare (deferrable, NULLS NOT DISTINCT or NOT VALID)`,
        });
      }

      return { unique: true, comments };
    };

    const plainIndexOn = (columnName: string) =>
      table.indexes.find(
        (entry) =>
          entry.keys.length === 1 &&
          entry.keys[0] === columnIdentifier(columnName) &&
          !entry.is_unique &&
          entry.method === "btree" &&
          entry.predicate === null &&
          entry.included.length === 0 &&
          !entry.nulls_not_distinct,
      );

    const indexFor = (columnName: string, unique: boolean): boolean => {
      if (unique || primaryKeyColumns.includes(columnName)) {
        return false;
      }

      const candidate = plainIndexOn(columnName);

      if (
        candidate &&
        candidate.index_name ===
          conventionalNames.index(table.sqlName, columnName)
      ) {
        consumedIndexes.add(candidate.index_name);

        return true;
      }

      return false;
    };

    for (const column of table.columns) {
      const reference = table.references.get(column.column_name);

      if (reference) {
        const { unique, comments } = uniqueFor(column.column_name);
        const member: PulledReference = {
          kind: "reference",
          key: reference.key,
          sqlName: column.column_name,
          target: facts.get(reference.targetSql)!.key,
          ...(reference.by === undefined ? {} : { by: reference.by }),
          ...(reference.column === undefined
            ? {}
            : { column: reference.column }),
          nullable: !column.not_null,
          unique,
          index: indexFor(column.column_name, unique),
          comments,
        };
        const onDelete = ON_DELETE[reference.constraint.on_delete];

        if (onDelete) {
          member.onDelete = onDelete;
        }

        const inverse = inverses.get(reference);

        if (inverse) {
          member.inverse = inverse;
        }

        const expected = conventionalNames.foreignKey(
          table.sqlName,
          column.column_name,
        );

        if (reference.constraint.name !== expected) {
          member.comments.push(
            `constraint "${reference.constraint.name}" is named "${expected}"`,
          );
          warn({
            code: "constraint-name",
            table: table.sqlName,
            column: column.column_name,
            object: reference.constraint.name,
            message: `foreign key "${reference.constraint.name}" will be expected as "${expected}"`,
            fix: renameFix(table.sqlName, reference.constraint.name, expected),
          });
        }

        declared.members.push(member);
        continue;
      }

      const key = camelKey(column.column_name);

      if (!key) {
        declared.skipped.push({
          sqlName: column.column_name,
          dataType: column.data_type,
          reason: "the name cannot be produced by a column key",
        });
        warn({
          code: "name",
          table: table.sqlName,
          column: column.column_name,
          message: `"${table.sqlName}.${column.column_name}" cannot be declared: column keys are camelCase and map to lowercase snake_case names`,
        });
        continue;
      }

      const member = columnMember(column, key, table, {
        ownsEnum,
        enumValues: (name) => enumLabels.get(name),
        warn,
        uniqueFor,
        indexFor,
      });
      declared.members.push(member);
    }

    // Junctions declare their two relations first, in primary-key order.
    if (table.junction) {
      const keyOrder = primaryKeyColumns;
      declared.members.sort((left, right) => {
        const rank = (member: PulledMember) => {
          const position = keyOrder.indexOf(member.sqlName);

          return position === -1 ? keyOrder.length : position;
        };

        return rank(left) - rank(right);
      });

      const second = declared.members[1] as PulledReference;
      second.index = false;
      const leading = table.indexes.find(
        (entry) =>
          entry.keys[0] === columnIdentifier(second.sqlName) ||
          entry.keys[0]?.startsWith(`${columnIdentifier(second.sqlName)} `),
      );
      const expected = conventionalNames.index(table.sqlName, second.sqlName);

      if (leading && plainIndexOn(second.sqlName)?.index_name === expected) {
        consumedIndexes.add(expected);
      } else if (!leading) {
        warn({
          code: "junction-index",
          table: table.sqlName,
          column: second.sqlName,
          object: expected,
          message: `junction "${table.sqlName}" gets an automatic index "${expected}" on its second key, which the database does not have`,
          fix: `CREATE INDEX ${quoteSql(expected)} ON ${quoteSql(table.sqlName)} (${quoteSql(second.sqlName)});`,
        });
      }
    } else {
      primaryKey(table, declared, warn);
    }

    const tableNames = new Set([...facts.keys()]);
    const indexTools: IndexTools = {
      table,
      declared,
      tableNames,
      warn,
      declare: (index) => {
        if (index.exact) {
          schemaIndexes.push({ table: declared.key, index: index.index });
        } else {
          declared.indexes.push(index.index);
        }
      },
    };

    for (const constraint of uniqueConstraints.filter(
      (entry) => entry.columns.length !== 1,
    )) {
      const row = table.indexes.find(
        (entry) => entry.index_name === constraint.name,
      );
      const columns = constraint.columns.map(quoteSql).join(", ");
      warn({
        code: "unique-constraint",
        table: table.sqlName,
        object: constraint.name,
        message: `multi-column unique constraint "${constraint.name}" (${constraint.columns.join(", ")}) is declared as a unique index of the same name; the constraint itself stays undeclared`,
        fix: `ALTER TABLE ${quoteSql(table.sqlName)} DROP CONSTRAINT ${quoteSql(constraint.name)}; CREATE UNIQUE INDEX ${quoteSql(constraint.name)} ON ${quoteSql(table.sqlName)} (${columns});`,
      });

      if (row) {
        declareIndex(row, indexTools, { exact: true });
      }
    }

    for (const constraint of table.constraints.filter(
      (entry) => entry.kind === "c",
    )) {
      const check = checkMember(table, constraint, warn);
      check.expression = interpolate(
        check.expression,
        scopeMembers(declared),
        declared.key,
      ).template;
      declared.checks.push(check);
    }

    for (const constraint of table.constraints.filter(
      (entry) => entry.kind === "x",
    )) {
      warn({
        code: "exclusion",
        table: table.sqlName,
        object: constraint.name,
        message: `exclusion constraint "${constraint.name}" cannot be declared`,
      });
    }

    for (const index of table.indexes) {
      const owned = catalog.indexes.some(
        (entry) =>
          entry.table_name === table.sqlName &&
          entry.name === index.index_name &&
          entry.constraint,
      );

      if (owned || consumedIndexes.has(index.index_name)) {
        continue;
      }

      declareIndex(index, indexTools, {});
    }

    tables.push(declared);
  }

  for (const enumeration of catalog.enumerations) {
    const users = enumUsers.get(enumeration.name) ?? [];

    if (users.length === 1 && ownsEnum(users[0]!)) {
      continue;
    }

    const [user] = users;
    const expected =
      users.length === 1
        ? conventionalNames.enumeration(user!.table_name, user!.column_name)
        : undefined;

    warn({
      code: "enum",
      object: enumeration.name,
      ...(user ? { table: user.table_name, column: user.column_name } : {}),
      message: users.length
        ? users.length === 1
          ? `enum "${enumeration.name}" is used through customType(); oneOf() expects it to be named "${expected}"`
          : `enum "${enumeration.name}" is shared by ${users.length} columns; each is declared through customType()`
        : `enum "${enumeration.name}" is unused and not declared`,
      ...(expected
        ? {
            fix: `ALTER TYPE ${quoteSql(enumeration.name)} RENAME TO ${quoteSql(expected)};`,
          }
        : {}),
    });
  }

  for (const extension of catalog.extensions) {
    if (
      extension.schema !== catalog.schemaName &&
      extension.schema !== "public"
    ) {
      warn({
        code: "extension",
        object: extension.name,
        message: `extension "${extension.name}" is installed in schema "${extension.schema}"; a migration generated from this schema would create it on the search_path instead`,
      });
    }
  }

  return {
    schemaName: catalog.schemaName,
    tables,
    schemaIndexes,
    extensions: catalog.extensions.map((extension) => extension.name),
    skippedTables,
    warnings,
  };
};

type ColumnTools = {
  ownsEnum: (column: CatalogColumn) => boolean;
  enumValues: (name: string) => string[] | undefined;
  warn: (warning: PullWarning) => void;
  uniqueFor: (columnName: string) => { unique: boolean; comments: string[] };
  indexFor: (columnName: string, unique: boolean) => boolean;
};

const columnMember = (
  column: CatalogColumn,
  key: string,
  table: TableFacts,
  tools: ColumnTools,
): PulledColumn => {
  const comments: string[] = [];
  const { unique, comments: uniqueComments } = tools.uniqueFor(
    column.column_name,
  );
  comments.push(...uniqueComments);
  const { type, array } = columnType(column, table, tools, comments);
  const member: PulledColumn = {
    kind: "column",
    key,
    sqlName: column.column_name,
    type,
    array,
    nullable: !column.not_null,
    unique,
    index: tools.indexFor(column.column_name, unique),
    primaryKey: false,
    comments,
  };

  if (isReservedColumnKey(key)) {
    comments.push(
      `"${key}" is also a table method; use it inside shape callbacks`,
    );
    tools.warn({
      code: "name",
      table: table.sqlName,
      column: column.column_name,
      message: `"${table.sqlName}.${column.column_name}" shares its key with a table method; reach it inside shape callbacks`,
    });
  }

  if (table.generated.has(column.column_name)) {
    comments.push("generated column; the expression is not declared");
    tools.warn({
      code: "generated-column",
      table: table.sqlName,
      column: column.column_name,
      message: `"${table.sqlName}.${column.column_name}" is a generated column; the schema declares a plain column`,
    });

    return member;
  }

  const value = columnDefault(column, type, array, table, tools, comments);

  if (value) {
    member.default = value;
  }

  return member;
};

const columnType = (
  column: CatalogColumn,
  table: TableFacts,
  tools: ColumnTools,
  comments: string[],
): { type: ColumnType; array: boolean } => {
  const normalized = normalizeSqlType(column.data_type);
  const array = normalized.endsWith("[]") && !normalized.endsWith("[][]");
  const base = array ? normalized.slice(0, -2) : normalized;

  if (column.enum_name && !array) {
    const values = tools.ownsEnum(column)
      ? tools.enumValues(column.enum_name)
      : undefined;

    if (values) {
      return { type: { kind: "enum", values }, array: false };
    }
  }

  const builder = (
    {
      integer: "int",
      bigint: "bigint",
      smallint: "smallint",
      real: "real",
      "double precision": "doublePrecision",
      text: "text",
      boolean: "bool",
      uuid: "uuid",
      "timestamp with time zone": "timestamptz",
      date: "date",
      "time without time zone": "time",
      interval: "interval",
      bytea: "bytea",
      inet: "inet",
      jsonb: "jsonb",
      tsvector: "tsvector",
    } as const
  )[base];

  if (builder) {
    return { type: { kind: "builder", name: builder }, array };
  }

  const vectorType = /^vector(?:\((\d+)\))?$/.exec(base);

  if (vectorType && !array) {
    return {
      type: {
        kind: "vector",
        ...(vectorType[1] ? { dimensions: Number(vectorType[1]) } : {}),
      },
      array: false,
    };
  }

  const varchar = /^character varying(?:\((\d+)\))?$/.exec(base);

  if (varchar) {
    return {
      type: {
        kind: "varchar",
        ...(varchar[1] ? { length: Number(varchar[1]) } : {}),
      },
      array,
    };
  }

  const numeric = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(base);

  if (numeric) {
    return {
      type: {
        kind: "numeric",
        ...(numeric[1] ? { precision: Number(numeric[1]) } : {}),
        ...(numeric[2] ? { scale: Number(numeric[2]) } : {}),
      },
      array,
    };
  }

  const sqlType = column.data_type;
  const enumeration =
    column.enum_name && !array ? tools.enumValues(column.enum_name) : undefined;
  const valueType = enumeration
    ? enumeration.map((value) => JSON.stringify(value)).join(" | ")
    : customValueType(base) + (normalized.endsWith("[]") ? "[]" : "");

  if (enumeration) {
    comments.push(
      `enum "${column.enum_name}" is declared through customType()`,
    );
  } else {
    comments.push(`no builder for ${sqlType}`);
    tools.warn({
      code: "custom-type",
      table: table.sqlName,
      column: column.column_name,
      object: sqlType,
      message: `"${table.sqlName}.${column.column_name}" uses ${sqlType}, declared through customType() with driver-native values`,
    });
  }

  return { type: { kind: "custom", sqlType, valueType }, array: false };
};

const columnDefault = (
  column: CatalogColumn,
  type: ColumnType,
  array: boolean,
  table: TableFacts,
  tools: ColumnTools,
  comments: string[],
): ColumnDefault | undefined => {
  const name = `${table.sqlName}.${column.column_name}`;

  if (column.identity !== "") {
    if (column.identity === "d") {
      comments.push("identity BY DEFAULT is declared as GENERATED ALWAYS");
      tools.warn({
        code: "identity-by-default",
        table: table.sqlName,
        column: column.column_name,
        message: `"${name}" is GENERATED BY DEFAULT AS IDENTITY; the schema declares GENERATED ALWAYS`,
        fix: `ALTER TABLE ${quoteSql(table.sqlName)} ALTER COLUMN ${quoteSql(column.column_name)} SET GENERATED ALWAYS;`,
      });
    }

    if (
      type.kind === "builder" &&
      (type.name === "int" ||
        type.name === "bigint" ||
        type.name === "smallint") &&
      !array
    ) {
      return { kind: "auto" };
    }

    comments.push("identity column");
    tools.warn({
      code: "identity-type",
      table: table.sqlName,
      column: column.column_name,
      message: `"${name}" is an identity column of type ${column.data_type}; it is declared through a raw identity default`,
    });

    return { kind: "identity" };
  }

  const text = column.default;

  if (text === null) {
    return undefined;
  }

  if (!array && type.kind === "builder") {
    if (type.name === "timestamptz" && text === "now()") {
      return { kind: "now" };
    }

    if (type.name === "uuid" && text === "gen_random_uuid()") {
      return { kind: "v4" };
    }

    if (type.name === "uuid" && text === "uuidv7()") {
      return { kind: "v7" };
    }
  }

  if (/^nextval\('[^']*'::regclass\)$/.test(text)) {
    comments.push("serial column; migrations will not create the sequence");
    tools.warn({
      code: "serial",
      table: table.sqlName,
      column: column.column_name,
      message: `"${name}" is a serial column; the schema keeps its nextval() default but migrations from this schema will not create the sequence`,
      fix: `ALTER TABLE ${quoteSql(table.sqlName)} ALTER COLUMN ${quoteSql(column.column_name)} DROP DEFAULT, ALTER COLUMN ${quoteSql(column.column_name)} ADD GENERATED ALWAYS AS IDENTITY;`,
    });

    return { kind: "sql", sql: text };
  }

  const literal = !array ? literalDefault(text, type) : undefined;

  return literal
    ? { kind: "value", source: literal }
    : { kind: "sql", sql: text };
};

const unescapeLiteral = (text: string) => text.replaceAll("''", "'");

/** JavaScript source for defaults PostgreSQL prints as simple literals. */
const literalDefault = (text: string, type: ColumnType): string | undefined => {
  const quoted = /^'((?:[^']|'')*)'::(.+)$/.exec(text);
  const integer =
    /^(-?\d+)$/.exec(text) ??
    /^'(-?\d+)'::(integer|bigint|smallint)$/.exec(text);

  const decimal =
    /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
    /^'(-?\d+(?:\.\d+)?)'::(real|double precision|integer|numeric)$/.exec(text);

  switch (type.kind) {
    case "builder":
      switch (type.name) {
        case "int":
        case "smallint":
          return integer ? integer[1] : undefined;
        case "bigint":
          return integer ? `${integer[1]}n` : undefined;
        case "real":
        case "doublePrecision":
          return decimal ? decimal[1] : undefined;
        case "date":
          return quoted && quoted[2] === "date"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "time":
          return quoted && quoted[2] === "time without time zone"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "interval":
          return quoted && quoted[2] === "interval"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "inet":
          return quoted && quoted[2] === "inet"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "bool":
          return text === "true" || text === "false" ? text : undefined;
        case "text":
        case "uuid":
          return quoted &&
            /^(text|character varying(\(\d+\))?|uuid|bpchar)$/.test(quoted[2]!)
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "jsonb":
          return quoted &&
            quoted[2] === "jsonb" &&
            /^(\{\}|\[\])$/.test(quoted[1]!)
            ? quoted[1]
            : undefined;
        default:
          return undefined;
      }
    case "varchar":
      return quoted &&
        /^(text|character varying(\(\d+\))?|bpchar)$/.test(quoted[2]!)
        ? JSON.stringify(unescapeLiteral(quoted[1]!))
        : undefined;
    case "numeric": {
      const decimal =
        /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
        /^'(-?\d+(?:\.\d+)?)'::numeric(\(\d+(,\d+)?\))?$/.exec(text);

      return decimal ? JSON.stringify(decimal[1]) : undefined;
    }
    case "enum":
      return quoted && type.values.includes(unescapeLiteral(quoted[1]!))
        ? JSON.stringify(unescapeLiteral(quoted[1]!))
        : undefined;
    case "custom": {
      if (type.valueType === "number") {
        const number =
          /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
          /^'(-?\d+(?:\.\d+)?)'::\w+( \w+)?$/.exec(text);

        return number ? number[1] : undefined;
      }

      if (type.valueType.startsWith('"') && quoted) {
        const value = JSON.stringify(unescapeLiteral(quoted[1]!));

        return type.valueType.split(" | ").includes(value) ? value : undefined;
      }

      return undefined;
    }
  }
};

const primaryKey = (
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

  const expected = conventionalNames.primaryKey(table.sqlName);

  if (constraint.name !== expected) {
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
  }

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

const checkMember = (
  table: TableFacts,
  constraint: CatalogConstraint,
  warn: (warning: PullWarning) => void,
): PulledCheck => {
  const comments: string[] = [];
  const suffix = `_check`;
  const prefix = `${table.sqlName}_`;
  const conventional =
    constraint.name.startsWith(prefix) && constraint.name.endsWith(suffix)
      ? camelKey(constraint.name.slice(prefix.length, -suffix.length))
      : undefined;
  let key = conventional;

  if (!key) {
    key =
      camelKey(constraint.name) ??
      camelKey(
        constraint.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/_(\d)/g, "$1"),
      ) ??
      `check${pascal(String(table.constraints.indexOf(constraint) + 1))}`;
    const expected = conventionalNames.check(table.sqlName, key);
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

  return { key, expression: constraint.expression ?? "TRUE", comments };
};

type IndexTools = {
  table: TableFacts;
  declared: PulledTable;
  tableNames: Set<string>;
  warn: (warning: PullWarning) => void;
  declare: (index: { exact: boolean; index: PulledIndex }) => void;
};

const INDEX_METHODS: ReadonlySet<string> = new Set(RUNTIME_INDEX_METHODS);
const SQL_KEYWORDS = new Set([
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
const interpolate = (
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
    const isTypeName = /::\s*$/.test(before) || /\.\s*$/.test(before);
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

const scopeMembers = (declared: PulledTable): Map<string, string> =>
  new Map(
    declared.members.map((member) => [
      member.sqlName,
      member.kind === "reference" ? `${member.key}Id` : member.key,
    ]),
  );

/** Declares one live index through `.indexes()` or, when its name is not derived, the schema-level `indexes` option. */
const declareIndex = (
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

    if (/\bcollate\b/i.test(text)) {
      return skip("per-key COLLATE is not supported");
    }

    const column =
      /^"((?:[^"]|"")+)"$/.exec(text)?.[1]?.replaceAll('""', '"') ??
      (/^[a-z_][a-z0-9_]*$/.test(text) ? text : undefined);
    const nulls: IndexKeySource["nulls"] | undefined =
      descending && !nullsFirst
        ? "last"
        : !descending && nullsFirst
          ? "first"
          : undefined;

    if (column !== undefined) {
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

    const expression = interpolate(text, members, declared.key);

    if (!expression.columns) {
      return skip("expression keys must reference a declared column");
    }

    keys.push({
      kind: "expression",
      source: expression.template,
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
    ? interpolate(row.predicate, members, declared.key).template
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
      ? camelKey(row.index_name.slice(prefix.length, -suffix.length))
      : undefined;

  if (
    derivedKey &&
    conventionalNames.index(table.sqlName, derivedKey) === row.index_name &&
    !declared.indexes.some((entry) => entry.key === derivedKey)
  ) {
    tools.declare({ exact: false, index: { ...index, key: derivedKey } });

    return;
  }

  if (!/^[a-z_][a-z0-9_]*$/.test(row.index_name)) {
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
