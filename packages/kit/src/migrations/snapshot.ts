import { createHash } from "node:crypto";
import { quoteIdentifier } from "symmetria/internal";
import type { SchemaSnapshot, IndexSnapshot, CheckSnapshot } from "symmetria";

export type MigrationColumn = {
  name: string;
  sqlType: string;
  enumeration?: string;
  notNull: boolean;
  unique: boolean;
  identity: boolean;
  default?: string;
  references?: { table: string; column: string; onDelete: string };
};
export type MigrationTable = {
  name: string;
  columns: MigrationColumn[];
  primaryKey: string[];
  indexes: IndexSnapshot[];
  checks?: CheckSnapshot[];
};
export type MigrationSnapshot = {
  version: 1;
  dialect: "postgresql";
  tables: MigrationTable[];
  enumerations: { name: string; values: string[] }[];
};

export const compareNames = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const checksum = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export const canonicalJSON = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareNames(left, right))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJSON(entry)}`)
      .join(",")}}`;
  }

  const encoded = JSON.stringify(value);

  if (encoded === undefined) {
    throw new Error(
      "symmetria: snapshots cannot contain undefined or functions",
    );
  }

  return encoded;
};

/** PostgreSQL names share a 63-byte limit, not a 63-character limit. */
export const objectName = (...parts: string[]): string => {
  const name = parts.join("_");

  if (Buffer.byteLength(name) <= 63) {
    return name;
  }

  let prefix = "";

  for (const character of name) {
    if (Buffer.byteLength(prefix + character) > 50) {
      break;
    }

    prefix += character;
  }

  return `${prefix}_${checksum(name).slice(0, 12)}`;
};

export const quoteLiteral = (value: unknown): string => {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (value instanceof Date) {
    return `${quoteLiteral(value.toISOString())}::timestamptz`;
  }

  if (typeof value === "string") {
    if (value.includes("\0")) {
      throw new Error(
        "symmetria: PostgreSQL literals cannot contain null bytes",
      );
    }

    return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  }

  throw new Error(
    "symmetria: unsupported default value; provide an encoded scalar or an SQL default",
  );
};

export const emptySnapshot = (): MigrationSnapshot => ({
  version: 1,
  dialect: "postgresql",
  tables: [],
  enumerations: [],
});

export const migrationSnapshot = (
  schema: SchemaSnapshot,
): MigrationSnapshot => {
  const enumerations = new Map<string, { name: string; values: string[] }>();
  const enumerationOwners = new Map<string, string>();

  const resolveEnumeration = (
    tableName: string,
    columnName: string,
    visited = new Set<string>(),
  ): string => {
    const key = canonicalJSON([tableName, columnName]);

    if (visited.has(key)) {
      throw new Error(
        "symmetria: circular enum reference without an enum definition",
      );
    }

    visited.add(key);
    const table = schema.tables.find(
      (candidate) => candidate.sqlName === tableName,
    );
    const column = table?.columns.find(
      (candidate) => candidate.sqlName === columnName,
    );

    if (column?.enumerationValues) {
      const name = objectName(tableName, columnName, "enum");
      const definition = { name, values: [...column.enumerationValues] };
      const existing = enumerations.get(name);

      if (
        existing &&
        (enumerationOwners.get(name) !== key ||
          canonicalJSON(existing) !== canonicalJSON(definition))
      ) {
        throw new Error(`symmetria: duplicate enum name "${name}"`);
      }

      enumerations.set(name, definition);
      enumerationOwners.set(name, key);

      return name;
    }

    if (column?.references) {
      return resolveEnumeration(
        column.references.table,
        column.references.column,
        visited,
      );
    }

    throw new Error(
      `symmetria: enum "${tableName}.${columnName}" has no values`,
    );
  };

  const tables: MigrationTable[] = schema.tables.map((table) => ({
    name: table.sqlName,
    columns: table.columns.map((column): MigrationColumn => {
      const identity =
        column.default?.kind === "sql" && column.default.sql === "identity";
      const defaultSql =
        !column.default || identity
          ? undefined
          : column.default.kind === "sql"
            ? column.default.sql
            : ["json", "jsonb"].includes(column.sqlType)
              ? `${quoteLiteral(canonicalJSON(JSON.parse(JSON.stringify(column.default.value))))}::${column.sqlType}`
              : quoteLiteral(column.default.value);

      return {
        name: column.sqlName,
        sqlType: column.sqlType,
        notNull: column.notNull,
        unique: column.unique,
        identity,
        ...(column.sqlType === "enum"
          ? { enumeration: resolveEnumeration(table.sqlName, column.sqlName) }
          : {}),
        ...(defaultSql === undefined ? {} : { default: defaultSql }),
        ...(column.references ? { references: { ...column.references } } : {}),
      };
    }),
    primaryKey: [
      ...(table.primaryKey ??
        table.columns
          .filter((column) => column.primaryKey)
          .map((column) => column.sqlName)),
    ],
    indexes: (table.indexes ?? []).map((definition) => ({
      ...definition,
      name: definition.sqlName,
    })),
    ...(table.checks?.length
      ? {
          checks: table.checks.map((definition) => ({
            ...definition,
            name: definition.sqlName,
          })),
        }
      : {}),
  }));

  return parseMigrationSnapshot({
    version: 1,
    dialect: "postgresql",
    tables,
    enumerations: [...enumerations.values()],
  });
};

/** Validate persisted snapshots before diffing. SQL expressions remain author-owned SQL. */
export const parseMigrationSnapshot = (input: unknown): MigrationSnapshot => {
  const fail = (): never => {
    throw new Error(
      "symmetria: invalid migration snapshot (expected PostgreSQL snapshot version 1)",
    );
  };

  if (!input || typeof input !== "object") {
    return fail();
  }

  const snapshot = input as MigrationSnapshot;

  if (
    snapshot.version !== 1 ||
    snapshot.dialect !== "postgresql" ||
    !Array.isArray(snapshot.tables) ||
    !Array.isArray(snapshot.enumerations)
  ) {
    return fail();
  }

  const identifier = (name: unknown): string => {
    if (typeof name !== "string") {
      return fail();
    }

    quoteIdentifier(name);

    return name;
  };

  const text = (value: unknown): string =>
    typeof value === "string" && value.length ? value : fail();

  const uniqueNames = (names: readonly string[]): void => {
    if (new Set(names).size !== names.length) {
      throw new Error("symmetria: duplicate migration object name");
    }
  };

  const enumerations = snapshot.enumerations
    .map((enumeration) => {
      if (
        !enumeration ||
        !Array.isArray(enumeration.values) ||
        !enumeration.values.length ||
        enumeration.values.some(
          (value) =>
            typeof value !== "string" ||
            value.includes("\0") ||
            Buffer.byteLength(value) > 63,
        )
      ) {
        return fail();
      }

      uniqueNames(enumeration.values);

      return {
        name: identifier(enumeration.name),
        values: [...enumeration.values],
      };
    })
    .sort((left, right) => compareNames(left.name, right.name));
  uniqueNames(enumerations.map((enumeration) => enumeration.name));
  const tables = snapshot.tables
    .map((table): MigrationTable => {
      if (
        !table ||
        !Array.isArray(table.columns) ||
        !Array.isArray(table.primaryKey) ||
        !Array.isArray(table.indexes)
      ) {
        return fail();
      }

      const name = identifier(table.name);
      const columns = table.columns
        .map((column): MigrationColumn => {
          if (
            !column ||
            typeof column.notNull !== "boolean" ||
            typeof column.unique !== "boolean" ||
            typeof column.identity !== "boolean"
          ) {
            return fail();
          }

          if (
            column.enumeration !== undefined &&
            !enumerations.some(
              (enumeration) => enumeration.name === column.enumeration,
            )
          ) {
            return fail();
          }

          if (
            (column.sqlType === "enum") !==
            (column.enumeration !== undefined)
          ) {
            return fail();
          }

          if (
            column.identity &&
            (!column.notNull ||
              !["smallint", "integer", "bigint"].includes(column.sqlType) ||
              column.default !== undefined)
          ) {
            throw new Error(
              "symmetria: identity requires a non-null integer column without another default",
            );
          }

          if (
            column.references &&
            ![
              "cascade",
              "restrict",
              "no action",
              "set null",
              "set default",
            ].includes(column.references.onDelete)
          ) {
            return fail();
          }

          return {
            name: identifier(column.name),
            sqlType: text(column.sqlType),
            notNull: column.notNull,
            unique: column.unique,
            identity: column.identity,
            ...(column.enumeration === undefined
              ? {}
              : { enumeration: column.enumeration }),
            ...(column.default === undefined
              ? {}
              : { default: text(column.default) }),
            ...(column.references
              ? {
                  references: {
                    table: identifier(column.references.table),
                    column: identifier(column.references.column),
                    onDelete: column.references.onDelete,
                  },
                }
              : {}),
          };
        })
        .sort((left, right) => compareNames(left.name, right.name));
      uniqueNames(columns.map((column) => column.name));
      const primaryKey = table.primaryKey.map(identifier);
      uniqueNames(primaryKey);

      if (
        primaryKey.some(
          (name) =>
            !columns.some((column) => column.name === name && column.notNull),
        )
      ) {
        throw new Error(
          "symmetria: primary keys must reference non-null columns",
        );
      }

      const indexes = table.indexes
        .map((definition): IndexSnapshot => {
          if (
            !definition ||
            typeof definition.unique !== "boolean" ||
            !["btree", "hash", "gin", "gist", "spgist", "brin"].includes(
              definition.method,
            ) ||
            !Array.isArray(definition.keys) ||
            !definition.keys.length ||
            !Array.isArray(definition.include)
          ) {
            return fail();
          }

          return {
            name: identifier(definition.sqlName),
            sqlName: identifier(definition.sqlName),
            unique: definition.unique,
            method: definition.method,
            keys: definition.keys.map(text),
            include: definition.include.map(text),
            ...(definition.where === undefined
              ? {}
              : { where: text(definition.where) }),
          };
        })
        .sort((left, right) => compareNames(left.sqlName, right.sqlName));

      if (table.checks !== undefined && !Array.isArray(table.checks)) {
        return fail();
      }

      const checks = (table.checks ?? [])
        .map((definition): CheckSnapshot => {
          if (!definition || typeof definition !== "object") {
            return fail();
          }

          return {
            name: identifier(definition.sqlName),
            sqlName: identifier(definition.sqlName),
            expression: text(definition.expression),
          };
        })
        .sort((left, right) => compareNames(left.sqlName, right.sqlName));
      uniqueNames([
        ...checks.map((definition) => definition.sqlName),
        ...(primaryKey.length ? [objectName(name, "pkey")] : []),
        ...columns.flatMap((column) => [
          ...(column.unique ? [objectName(name, column.name, "key")] : []),
          ...(column.references ? [objectName(name, column.name, "fkey")] : []),
        ]),
      ]);

      return {
        name,
        columns,
        primaryKey,
        indexes,
        ...(checks.length ? { checks } : {}),
      };
    })
    .sort((left, right) => compareNames(left.name, right.name));
  uniqueNames(tables.map((table) => table.name));
  // Tables, indexes and enum types share PostgreSQL namespaces with table row types.
  uniqueNames([
    ...tables.map((table) => table.name),
    ...tables.flatMap((table) => [
      ...table.indexes.map((definition) => definition.sqlName),
      ...(table.primaryKey.length ? [objectName(table.name, "pkey")] : []),
      ...table.columns
        .filter((column) => column.unique)
        .map((column) => objectName(table.name, column.name, "key")),
    ]),
  ]);
  uniqueNames([
    ...tables.map((table) => table.name),
    ...enumerations.map((enumeration) => enumeration.name),
  ]);

  for (const table of tables) {
    for (const column of table.columns) {
      if (column.references) {
        const reference = column.references;

        if (
          !tables
            .find((candidate) => candidate.name === reference.table)
            ?.columns.some((candidate) => candidate.name === reference.column)
        ) {
          throw new Error(
            `symmetria: unknown reference target "${reference.table}.${reference.column}"`,
          );
        }
      }
    }
  }

  return { version: 1, dialect: "postgresql", tables, enumerations };
};

export const snapshotHash = (snapshot: MigrationSnapshot): string =>
  checksum(canonicalJSON(parseMigrationSnapshot(snapshot)));
