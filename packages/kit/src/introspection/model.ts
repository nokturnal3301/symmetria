/**
 * Turns the live catalog into a declaration model: which builder, modifiers and
 * default each column gets, which foreign keys become relations, which tables are
 * junctions, plus a warning for everything the DSL cannot express faithfully.
 */
import type { Casing } from "symmetria";
import { INDEX_METHODS as RUNTIME_INDEX_METHODS } from "symmetria/internal";
import { normalizeSqlType } from "../migrations/drift";
import type { CatalogConstraint } from "../migrations/catalog";
import type { IndexDetailRow, PullCatalog } from "./catalog";
import {
  declaredCondition,
  declaredKey,
  valueKind,
  type ConditionScope,
} from "./conditions";
import {
  camelKey,
  chooseCasing,
  keyAllocator,
  keyFor,
  naturalKey,
  referenceKey,
  conventionalNames,
  escapeTemplate,
  isReservedColumnKey,
  isReservedTableKey,
  pascal,
  quoteSql,
  sqlString,
  tableBindings,
} from "./names";

export type PullWarningCode =
  /** No longer reported: BY DEFAULT identities are declared with `.auto.byDefault`. */
  | "identity-by-default"
  | "serial"
  | "identity-type"
  | "generated-column"
  | "custom-type"
  | "collation"
  | "constraint-name"
  | "foreign-key"
  | "unique-constraint"
  | "unique-index"
  | "view"
  | "trigger"
  | "migration-table"
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
        | "timestamp"
        | "date"
        | "time"
        | "interval"
        | "bytea"
        | "inet"
        | "jsonb"
        | "tsvector";
      /** Fractional-second precision of timestamp builders, `timestamp(3)`. */
      precision?: number;
    }
  | { kind: "varchar"; length?: number }
  | { kind: "numeric"; precision?: number; scale?: number }
  /** `oneOf(...)`; `name` is set when the type is not `<table>_<column>_enum` or is shared. */
  | { kind: "enum"; values: string[]; name?: string }
  | { kind: "vector"; dimensions?: number }
  | { kind: "custom"; sqlType: string; valueType: string };

export type ColumnDefault =
  | { kind: "auto"; byDefault?: true }
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
  /** Non-default collation, declared with `.collate()`. */
  collation?: string;
  comments: string[];
};

export type PulledReference = {
  kind: "reference";
  key: string;
  sqlName: string;
  /** Key of the referenced table; the generated code names it by that table's binding. */
  target: string;
  /** Key of the referenced column when it is a unique column rather than the primary key. */
  by?: string;
  /** The SQL column name when it is not `<key>_id`. */
  column?: string;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  onDelete?: "cascade" | "setNull" | "noAction";
  onUpdate?: "cascade" | "restrict";
  inverse?: string;
  comments: string[];
};

export type PulledMember = PulledColumn | PulledReference;

export type IndexKeySource = {
  /**
   * `column` keys name a scope member; `value` keys hold DSL source such as
   * `users.score.plus(1)`; `expression` keys hold template text with
   * `${table.column}` interpolations.
   */
  kind: "column" | "value" | "expression";
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
  where?: PulledCondition;
  /** Storage parameters from pg_class.reloptions. */
  with?: Record<string, string | number>;
  comments: string[];
};

/**
 * A CHECK or WHERE condition: a DSL predicate such as `users.score.above(0)`
 * with the functions it imports, or `sql` template text, already interpolated
 * and escaped, for conditions the DSL cannot express.
 */
export type PulledCondition =
  | { kind: "predicate"; source: string; imports: readonly string[] }
  | { kind: "sql"; template: string };

export type PulledCheck = {
  key: string;
  condition: PulledCondition;
  comments: string[];
};

export type PulledTable = {
  key: string;
  /**
   * The identifier that names the table in generated callbacks: the key, unless
   * the key would shadow an import (`date`, `text`, `sql`) or is a reserved word.
   */
  binding: string;
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
  /** The naming rule that lets most tables and columns be declared without `.named()`. */
  casing: Casing;
  tables: PulledTable[];
  /** Indexes whose SQL names do not follow `<table>_<key>_idx`, declared with their exact names. */
  schemaIndexes: { table: string; binding: string; index: PulledIndex }[];
  /** Enum types the schema declares with oneOf(). */
  enumerations: string[];
  /** Installed extensions other than plpgsql, declared through the schema options. */
  extensions: string[];
  skippedTables: { sqlName: string; reason: string }[];
  warnings: PullWarning[];
};

type CatalogColumn = PullCatalog["columns"][number];

type TableFacts = {
  key: string;
  binding: string;
  sqlName: string;
  casing: Casing;
  /** Scalar member key of every column, by SQL name. */
  columnKeys: Map<string, string>;
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

/** Prisma's migration history table: reported, never declared. */
const PRISMA_MIGRATIONS = "_prisma_migrations";

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

  if (sqlType === "json") {
    return "unknown";
  }

  return "string";
};

const renameFix = (table: string, from: string, to: string) =>
  `ALTER TABLE ${quoteSql(table)} RENAME CONSTRAINT ${quoteSql(from)} TO ${quoteSql(to)};`;

/**
 * Turns a serial column into `GENERATED BY DEFAULT AS IDENTITY`, what
 * `.auto.byDefault` declares. BY DEFAULT keeps inserts that supply their own id
 * working, as they did with serial. The identity continues after the highest id
 * and after the old sequence, so no id is handed out twice; the old sequence is
 * dropped. `sequence` is the regclass text of the nextval() default, already
 * quoted the way PostgreSQL prints names.
 */
const serialFix = (
  tableName: string,
  columnName: string,
  sequence: string,
): string => {
  const table = quoteSql(tableName);
  const column = quoteSql(columnName);

  return [
    `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT;`,
    `ALTER SEQUENCE ${sequence} OWNED BY NONE;`,
    `ALTER TABLE ${table} ALTER COLUMN ${column} ADD GENERATED BY DEFAULT AS IDENTITY;`,
    `SELECT setval(pg_get_serial_sequence(${sqlString(table)}, ${sqlString(columnName)}), GREATEST(COALESCE(MAX(${column}), 0), (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ${sequence})) + 1, false) FROM ${table};`,
    `DROP SEQUENCE ${sequence};`,
  ].join(" ");
};

export const buildPulledSchema = (catalog: PullCatalog): PulledSchema => {
  const warnings: PullWarning[] = [];
  const skippedTables: PulledSchema["skippedTables"] = [];
  const schemaIndexes: PulledSchema["schemaIndexes"] = [];
  const warn = (warning: PullWarning) => {
    warnings.push(warning);
  };

  // Enums of this schema are declared with oneOf(). A column owns its enum when
  // it is the only user and the type carries the derived `<table>_<column>_enum`
  // name; every other enum keeps its own name through typeName(), on each column
  // that uses it, so a Prisma `"Role"` stays `"Role"`.
  const enumUsers = new Map<string, CatalogColumn[]>();

  for (const column of catalog.columns) {
    if (column.enum_name && column.enum_schema === null) {
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

  // Views, materialized views and triggers have no declaration; list each one.
  for (const object of catalog.undeclared ?? []) {
    warn({
      code: object.kind === "trigger" ? "trigger" : "view",
      table: object.table_name ?? object.name,
      object: object.name,
      message:
        object.kind === "trigger"
          ? `trigger "${object.name}" on "${object.table_name}" is not declared; the schema does not manage triggers, so migrations neither create nor drop it`
          : `${object.kind} "${object.name}" is not declared; queries cannot reach it through the schema and migrations neither create nor drop it`,
    });
  }

  // -- pass 1: tables that can be declared, with their catalog facts ----------
  const facts = new Map<string, TableFacts>();
  const declarable = catalog.tables.filter(
    (table) =>
      !catalog.details.find((entry) => entry.name === table.name)?.partition &&
      table.name !== PRISMA_MIGRATIONS,
  );
  const casing = chooseCasing([
    ...declarable.map((table) => table.name),
    ...catalog.columns
      .filter((column) =>
        declarable.some((table) => table.name === column.table_name),
      )
      .map((column) => column.column_name),
  ]);
  const allocateTableKey = keyAllocator(isReservedTableKey);

  for (const table of catalog.tables) {
    const details = catalog.details.find((entry) => entry.name === table.name);

    if (table.name === PRISMA_MIGRATIONS) {
      skippedTables.push({
        sqlName: table.name,
        reason: "Prisma's migration history; Symmetria keeps its own",
      });
      warn({
        code: "migration-table",
        table: table.name,
        message: `"${table.name}" is Prisma's migration history and is not declared; drop it once Symmetria manages the migrations`,
      });
      continue;
    }

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

    // Names the key cannot produce are declared with `.named()`.
    const key = allocateTableKey(keyFor(table.name, casing));

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

    const allocateColumnKey = keyAllocator();

    facts.set(table.name, {
      key,
      binding: key,
      sqlName: table.name,
      casing,
      columnKeys: new Map(
        columns.map((column) => [
          column.column_name,
          allocateColumnKey(keyFor(column.column_name, casing)),
        ]),
      ),
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

  // Tables keyed like an import (`date`, `sql`) get another name in callbacks.
  const bindings = tableBindings([...facts.values()].map((table) => table.key));

  for (const table of facts.values()) {
    table.binding = bindings.get(table.key)!;
  }

  // -- pass 2: foreign keys that can become relations -------------------------
  for (const table of facts.values()) {
    const columnKeys = new Set(table.columnKeys.values());

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

        if (!["a", "c", "r"].includes(constraint.on_update)) {
          return "ON UPDATE SET NULL / SET DEFAULT are not supported";
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

        // `<relation>_id` (or `<relation>Id` when names are preserved) keeps the
        // convention; any other name becomes `.column("<name>")`.
        const { key, column: explicitColumn } = referenceKey(
          columnName!,
          casing,
        );
        const conventional = explicitColumn === undefined;

        if (isReservedColumnKey(key)) {
          return `"${columnName}" does not map to a relation key`;
        }

        if (columnKeys.has(key) && key !== table.columnKeys.get(columnName!)) {
          return `a column already uses the key "${key}"`;
        }

        if (
          !conventional &&
          columnKeys.has(`${key}Id`) &&
          `${key}Id` !== table.columnKeys.get(columnName!)
        ) {
          return `a column already uses the key "${key}Id"`;
        }

        const target = facts.get(constraint.reference_table ?? "");

        if (!target) {
          return catalog.ignored?.includes(constraint.reference_table ?? "")
            ? `the referenced table "${constraint.reference_table}" is ignored (ignoreTables)`
            : `the referenced table "${constraint.reference_table}" is not declared`;
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
          ...(isPrimary ? {} : { by: target.columnKeys.get(referencedName!)! }),
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
      binding: table.binding,
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
        // Prisma enforces uniqueness with a unique index named like the
        // constraint (`User_email_key`); the schema declares `.unique` and the
        // fix turns the index into that constraint in place, without a rebuild.
        // Other unique indexes keep their exact index declarations.
        const expected = conventionalNames.unique(table.sqlName, columnName);
        const uniqueIndex = table.indexes.find(
          (entry) =>
            entry.index_name === expected &&
            entry.is_unique &&
            entry.keys.length === 1 &&
            entry.keys[0] === columnIdentifier(columnName) &&
            entry.method === "btree" &&
            entry.predicate === null &&
            entry.included.length === 0 &&
            !entry.nulls_not_distinct &&
            entry.opclasses.every((opclass) => opclass === null) &&
            entry.options.every((option) => option === 0) &&
            !table.constraints.some(
              (constraint) => constraint.name === entry.index_name,
            ),
        );

        if (!uniqueIndex) {
          return { unique: false, comments: [] };
        }

        consumedIndexes.add(uniqueIndex.index_name);
        warn({
          code: "unique-index",
          table: table.sqlName,
          column: columnName,
          object: uniqueIndex.index_name,
          message: `"${table.sqlName}.${columnName}" is unique through the index "${expected}", not a UNIQUE constraint of that name`,
          fix: `ALTER TABLE ${quoteSql(table.sqlName)} ADD CONSTRAINT ${quoteSql(expected)} UNIQUE USING INDEX ${quoteSql(expected)};`,
        });

        return {
          unique: true,
          comments: [`unique index "${expected}" becomes a constraint`],
        };
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

    // What `.index` creates: one ascending key with default operator class and
    // collation, no storage parameters. Anything else is declared through
    // `.indexes()` with its options.
    const plainIndexOn = (columnName: string) =>
      table.indexes.find(
        (entry) =>
          entry.keys.length === 1 &&
          entry.keys[0] === columnIdentifier(columnName) &&
          !entry.is_unique &&
          entry.method === "btree" &&
          entry.predicate === null &&
          entry.included.length === 0 &&
          !entry.nulls_not_distinct &&
          entry.options.every((option) => option === 0) &&
          entry.opclasses.every((opclass) => opclass === null) &&
          entry.collations.every((collation) => collation === null) &&
          !entry.reloptions?.length,
      );

    const indexFor = (columnName: string, unique: boolean): boolean => {
      if (unique || primaryKeyColumns.includes(columnName)) {
        return false;
      }

      const candidate = plainIndexOn(columnName);

      if (
        candidate &&
        candidate.index_name ===
          conventionalNames.columnIndex(table.sqlName, columnName)
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

        if (reference.constraint.on_update === "c") {
          member.onUpdate = "cascade";
        } else if (reference.constraint.on_update === "r") {
          member.onUpdate = "restrict";
        }

        const inverse = inverses.get(reference);

        if (inverse) {
          member.inverse = inverse;
        }

        // A relation column takes the referenced key's type and collation.
        const targetCollation =
          facts
            .get(reference.targetSql)!
            .columns.find(
              (entry) =>
                entry.column_name === reference.constraint.reference_columns[0],
            )?.collation ?? null;

        if (column.collation !== targetCollation) {
          member.comments.push(
            `collation ${column.collation ? `"${column.collation}"` : "default"} differs from the referenced key's`,
          );
          warn({
            code: "collation",
            table: table.sqlName,
            column: column.column_name,
            object: column.collation ?? "default",
            message: `"${table.sqlName}.${column.column_name}" uses ${column.collation ? `collation "${column.collation}"` : "the default collation"}; a relation column takes the referenced key's ${targetCollation ? `"${targetCollation}"` : "default collation"}`,
          });
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

      const key = table.columnKeys.get(column.column_name)!;

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
      const expected = conventionalNames.columnIndex(
        table.sqlName,
        second.sqlName,
      );

      // Prisma names a junction's key `_AToB_AB_pkey`; the schema derives `_AToB_pkey`.
      primaryKeyName(table, declared, warn);

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
      scope: conditionScope(table, declared, enumLabels),
      warn,
      declare: (index) => {
        if (index.exact) {
          schemaIndexes.push({
            table: declared.key,
            binding: declared.binding,
            index: index.index,
          });
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

    const checkKeys = new Set<string>();

    for (const constraint of table.constraints.filter(
      (entry) => entry.kind === "c",
    )) {
      declared.checks.push({
        ...checkMember(table, constraint, warn, checkKeys),
        condition: pulledCondition(
          constraint.expression ?? "TRUE",
          indexTools.scope,
          declared,
        ),
      });
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

  // Enums used by a declared column are declared through it; the rest are listed.
  const declaredTables = new Set(facts.keys());
  const enumerations: string[] = [];

  for (const enumeration of catalog.enumerations) {
    const users = (enumUsers.get(enumeration.name) ?? []).filter((column) =>
      declaredTables.has(column.table_name),
    );

    if (users.length) {
      enumerations.push(enumeration.name);
      continue;
    }

    warn({
      code: "enum",
      object: enumeration.name,
      message: `enum "${enumeration.name}" is not used by a declared column and is not declared`,
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
    casing,
    tables,
    schemaIndexes,
    enumerations,
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

  if (column.collation) {
    const collatable =
      (type.kind === "builder" && type.name === "text") ||
      type.kind === "varchar" ||
      (type.kind === "custom" && /^string(\[\])?$/.test(type.valueType));

    if (collatable) {
      member.collation = column.collation;
    } else {
      comments.push(`collation "${column.collation}" is not declared`);
      tools.warn({
        code: "collation",
        table: table.sqlName,
        column: column.column_name,
        object: column.collation,
        message: `"${table.sqlName}.${column.column_name}" uses collation "${column.collation}", which the schema cannot declare for ${column.data_type}`,
      });
    }
  }

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

  if (column.enum_name && column.enum_schema === null && !array) {
    const values = tools.enumValues(column.enum_name);

    if (values) {
      return {
        type: {
          kind: "enum",
          values,
          ...(tools.ownsEnum(column) ? {} : { name: column.enum_name }),
        },
        array: false,
      };
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

  const stamp = /^timestamp (with|without) time zone(?:\((\d)\))?$/.exec(base);

  if (stamp) {
    return {
      type: {
        kind: "builder",
        name: stamp[1] === "with" ? "timestamptz" : "timestamp",
        ...(stamp[2] ? { precision: Number(stamp[2]) } : {}),
      },
      array,
    };
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

  // Enums of other schemas and arrays of enums have no oneOf() form either.
  const sqlType = column.data_type;
  const valueType =
    customValueType(base) + (normalized.endsWith("[]") ? "[]" : "");
  comments.push(`no builder for ${sqlType}`);
  tools.warn({
    code: "custom-type",
    table: table.sqlName,
    column: column.column_name,
    object: sqlType,
    message: `"${table.sqlName}.${column.column_name}" uses ${sqlType}, declared through customType() with driver-native values`,
  });

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
  const integer =
    type.kind === "builder" &&
    (type.name === "int" ||
      type.name === "bigint" ||
      type.name === "smallint") &&
    !array;

  if (column.identity !== "") {
    if (integer) {
      return column.identity === "d"
        ? { kind: "auto", byDefault: true }
        : { kind: "auto" };
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
    if (
      (type.name === "timestamptz" || type.name === "timestamp") &&
      text === "now()"
    ) {
      return { kind: "now" };
    }

    if (type.name === "uuid" && text === "gen_random_uuid()") {
      return { kind: "v4" };
    }

    if (type.name === "uuid" && text === "uuidv7()") {
      return { kind: "v7" };
    }
  }

  const serial = /^nextval\('((?:[^']|'')*)'::regclass\)$/.exec(text);

  if (serial) {
    comments.push("serial column; migrations will not create the sequence");
    tools.warn({
      code: "serial",
      table: table.sqlName,
      column: column.column_name,
      message: integer
        ? `"${name}" is a serial column; the schema keeps its nextval() default but migrations from this schema will not create the sequence. The fix makes it an identity column (.auto.byDefault) that continues the sequence`
        : `"${name}" is a serial column; the schema keeps its nextval() default but migrations from this schema will not create the sequence`,
      ...(integer
        ? {
            fix: serialFix(
              table.sqlName,
              column.column_name,
              unescapeLiteral(serial[1]!),
            ),
          }
        : {}),
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

/** Warns, with a RENAME CONSTRAINT fix, when the primary key is not named `<table>_pkey`. */
const primaryKeyName = (
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
const conditionScope = (
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
const pulledCondition = (
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

const checkMember = (
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
const parenthesized = (text: string): boolean => {
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

type IndexTools = {
  table: TableFacts;
  declared: PulledTable;
  tableNames: Set<string>;
  scope: ConditionScope;
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
