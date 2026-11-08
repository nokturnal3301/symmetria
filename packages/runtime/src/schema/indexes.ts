/**
 * Index definitions: declaration, snapshot shape and CREATE INDEX generation including $createIndexes.
 */
import { codecFor, codecMap, type SchemaCodecs } from "../query/codecs";
import { quoteIdentifier } from "../query/compile";
import { ddlExpressions } from "./ddl-expressions";
import {
  ORDERING_EXPRESSION,
  readColumn,
  readPredicate,
  type Ordering,
  type Predicate,
  type PredicateDescription,
  type SelectedColumn,
  type ValueNode,
} from "../query/expressions";
import {
  createScope,
  type RuntimeScope,
  type ScopedColumn,
} from "../query/select";
import type {
  CompiledQuery,
  QueryExecutor,
  TableBinding,
} from "../query/plan/types";
import { snakeCase, type SchemaSnapshot } from "./assembly";

const INDEX_DEFINITION = Symbol("symmetria.index");
const OPERATOR_CLASS = Symbol("symmetria.index.opclass");
export type IndexMethod =
  | "btree"
  | "hash"
  | "gin"
  | "gist"
  | "spgist"
  | "brin"
  | "hnsw"
  | "ivfflat";
export const INDEX_METHODS: readonly IndexMethod[] = Object.freeze([
  "btree",
  "hash",
  "gin",
  "gist",
  "spgist",
  "brin",
  "hnsw",
  "ivfflat",
]);
/** Methods that index exactly one column without ordering or INCLUDE (pgvector). */
const VECTOR_METHODS: readonly IndexMethod[] = Object.freeze([
  "hnsw",
  "ivfflat",
]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** An index key with an operator class: `operatorClass(posts.embedding, "vector_cosine_ops")`. */
export interface OperatorClassKey<Name extends string = string> {
  readonly [OPERATOR_CLASS]: {
    readonly key: SelectedColumn | Ordering;
    readonly name: string;
    readonly column: Name;
  };
}
type IndexKey = SelectedColumn | Ordering | OperatorClassKey;
export type IndexStorageOptions = Readonly<Record<string, string | number>>;
type IndexDescription = {
  readonly keys: readonly IndexKey[];
  readonly unique: boolean;
  readonly method: IndexMethod;
  readonly include: readonly SelectedColumn[];
  readonly where?: PredicateDescription;
  readonly with?: IndexStorageOptions;
};

/** Attaches a PostgreSQL operator class to an index key (`text_pattern_ops`, `vector_cosine_ops`, ...). */
export const operatorClass = <Key extends SelectedColumn | Ordering>(
  key: Key,
  name: string,
): OperatorClassKey<
  Key extends ScopedColumn & SelectedColumn<unknown, infer Name> ? Name : never
> => {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`symmetria: invalid operator class "${name}"`);
  }

  return Object.freeze({
    [OPERATOR_CLASS]: Object.freeze({ key, name }),
  }) as never;
};

/** `WITH (m = 16, ef_construction = 64)` storage parameters, validated as identifiers and scalars. */
const storageOptions = (
  options: Record<string, string | number>,
): IndexStorageOptions => {
  const entries = Object.entries(options).filter(
    ([, value]) => value !== undefined,
  );

  if (!entries.length) {
    throw new Error("symmetria: with() requires at least one storage option");
  }

  for (const [name, value] of entries) {
    if (!IDENTIFIER.test(name)) {
      throw new Error(`symmetria: invalid index storage option "${name}"`);
    }

    if (
      !(
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length && !/[\0']/.test(value))
      )
    ) {
      throw new Error(
        `symmetria: index storage option "${name}" must be a finite number or a plain string`,
      );
    }
  }

  return Object.freeze(
    Object.fromEntries(
      entries.sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
  );
};
declare const INDEX_TYPES: unique symbol;

export interface IndexDefinition<
  ColumnNames extends string = string,
  Unique extends boolean = boolean,
  Complete extends boolean = boolean,
> {
  readonly [INDEX_TYPES]: {
    columns: ColumnNames;
    unique: Unique;
    complete: Complete;
  };
  readonly [INDEX_DEFINITION]: IndexDescription;
  readonly unique: IndexDefinition<ColumnNames, true, Complete>;
  readonly using: (
    method: IndexMethod,
  ) => IndexDefinition<ColumnNames, Unique, Complete>;
  readonly include: (
    first: SelectedColumn,
    ...columns: SelectedColumn[]
  ) => IndexDefinition<ColumnNames, Unique, Complete>;
  readonly where: (
    predicate: Predicate,
  ) => IndexDefinition<ColumnNames, Unique, false>;
  /** Storage parameters: `index(...).using("hnsw").with({ m: 16, ef_construction: 64 })`. */
  readonly with: (
    options: Record<string, string | number>,
  ) => IndexDefinition<ColumnNames, Unique, Complete>;
}
export type IndexSnapshot = {
  readonly name: string;
  readonly sqlName: string;
  readonly unique: boolean;
  readonly method: IndexMethod;
  readonly keys: readonly string[];
  readonly include: readonly string[];
  readonly where?: string;
  /** Operator class per key; absent when every key uses the default class. */
  readonly opclasses?: readonly (string | null)[];
  /** Storage parameters; absent when none are set. */
  readonly with?: IndexStorageOptions;
};
export type CreateIndexesOptions = {
  readonly concurrently?: boolean;
  readonly ifNotExists?: boolean;
};
export type IndexQuery = {
  readonly toSQL: () => CompiledQuery[];
  readonly execute: () => Promise<void>;
};

const defineIndex = (description: IndexDescription): IndexDefinition => {
  const result = {
    [INDEX_DEFINITION]: Object.freeze(description),
    using: (method: IndexMethod) => {
      if (!INDEX_METHODS.includes(method)) {
        throw new Error(`symmetria: unsupported index method "${method}"`);
      }

      return defineIndex({ ...description, method });
    },
    with: (options: Record<string, string | number>) =>
      defineIndex({ ...description, with: storageOptions(options) }),
    include: (first: SelectedColumn, ...columns: SelectedColumn[]) =>
      defineIndex({
        ...description,
        include: Object.freeze([first, ...columns]),
      }),
    where: (condition: Predicate) =>
      defineIndex({ ...description, where: readPredicate(condition) }),
  };
  Object.defineProperty(result, "unique", {
    get: () => defineIndex({ ...description, unique: true }),
  });

  return Object.freeze(result) as IndexDefinition;
};

/** Names come from the keys returned by an indexes callback. */
type KeyName<Key> =
  Key extends OperatorClassKey<infer Name>
    ? Name
    : Key extends ScopedColumn & SelectedColumn<unknown, infer Name>
      ? Name
      : never;

export const index = <const Keys extends readonly [IndexKey, ...IndexKey[]]>(
  ...[first, ...keys]: Keys
): IndexDefinition<KeyName<Keys[number]>, false, true> => {
  if (!first) {
    throw new Error("symmetria: an index requires at least one key");
  }

  return defineIndex({
    keys: Object.freeze([first, ...keys]),
    unique: false,
    method: "btree",
    include: Object.freeze([]),
  }) as IndexDefinition<KeyName<Keys[number]>, false, true>;
};

export const applyIndexes = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs,
  callback: (scope: RuntimeScope) => Record<string, IndexDefinition>,
  tableName?: string,
): void => {
  const bindings: Record<string, TableBinding> = Object.fromEntries(
    snapshot.tables
      .filter((table) => tableName === undefined || table.name === tableName)
      .map((table) => [
        table.name,
        Object.freeze({
          table,
          alias: table.name,
          codecs: Object.freeze(
            codecMap(
              Object.fromEntries(
                table.columns.flatMap((column) => {
                  const codec =
                    codecs[table.name]?.[column.name] ??
                    codecFor(column.sqlType);

                  return codec ? [[column.name, codec]] : [];
                }),
              ),
            ),
          ),
        }),
      ]),
  );
  const definitions = callback(createScope(bindings));
  const names = new Set(
    snapshot.tables.flatMap((table) => [
      table.sqlName,
      ...(table.indexes ?? []).map((definition) => definition.sqlName),
    ]),
  );

  for (const [name, definition] of Object.entries(definitions)) {
    if (!definition || !(INDEX_DEFINITION in definition)) {
      throw new Error(`symmetria: "${name}" is not an index definition`);
    }

    quoteIdentifier(name);
    const sqlName =
      tableName === undefined
        ? snakeCase(name)
        : `${bindings[tableName]!.table.sqlName}_${snakeCase(name)}_idx`;
    quoteIdentifier(sqlName);

    if (names.has(sqlName)) {
      throw new Error(`symmetria: duplicate SQL index name "${sqlName}"`);
    }

    names.add(sqlName);
    const description = definition[INDEX_DEFINITION];
    let owner: TableBinding | undefined;

    const columnSql = (node: ValueNode): string => {
      if (node.kind !== "column") {
        throw new Error("symmetria: INCLUDE requires plain columns");
      }

      const { binding, column } = node.description;

      if (bindings[binding.alias] !== binding) {
        throw new Error(
          "symmetria: index columns must come from the indexes callback",
        );
      }

      if (owner && owner !== binding) {
        throw new Error("symmetria: an index can reference only one table");
      }

      owner = binding;

      return quoteIdentifier(column.sqlName);
    };

    const { valueSQL: valueSql, predicateSQL: predicateSql } =
      ddlExpressions(columnSql);

    if (description.unique && description.method !== "btree") {
      throw new Error("symmetria: unique indexes require btree");
    }

    if (
      ["hash", "spgist"].includes(description.method) &&
      description.keys.length !== 1
    ) {
      throw new Error(
        `symmetria: ${description.method} indexes require one key`,
      );
    }

    if (
      description.include.length &&
      !["btree", "gist", "spgist"].includes(description.method)
    ) {
      throw new Error(
        `symmetria: ${description.method} does not support INCLUDE`,
      );
    }

    if (
      VECTOR_METHODS.includes(description.method) &&
      description.keys.length !== 1
    ) {
      throw new Error(
        `symmetria: ${description.method} indexes require one key`,
      );
    }

    const keyColumns = new Set<string>();
    const opclasses: (string | null)[] = [];
    const keys = description.keys.map((entry) => {
      const operatorClassKey =
        entry && OPERATOR_CLASS in entry ? entry[OPERATOR_CLASS] : undefined;
      const key = operatorClassKey?.key ?? (entry as SelectedColumn | Ordering);
      opclasses.push(operatorClassKey?.name ?? null);
      const ordering =
        key && ORDERING_EXPRESSION in key
          ? key[ORDERING_EXPRESSION]
          : undefined;
      const expression =
        ordering?.expression ?? readColumn(key as SelectedColumn);

      if (ordering && description.method !== "btree") {
        throw new Error("symmetria: ordered index keys require btree");
      }

      const expressionSql = valueSql(expression.node);

      if (expression.node.kind === "column") {
        keyColumns.add(expressionSql);
      }

      return `${expression.node.kind === "column" ? expressionSql : `(${expressionSql})`}${ordering ? ` ${ordering.direction}${ordering.nulls ? ` NULLS ${ordering.nulls}` : ""}` : ""}`;
    });

    if (!owner) {
      throw new Error("symmetria: index keys must reference a table column");
    }

    const include = description.include.map((column) =>
      columnSql(readColumn(column).node),
    );

    if (
      new Set(include).size !== include.length ||
      include.some((column) => keyColumns.has(column))
    ) {
      throw new Error("symmetria: duplicate INCLUDE column or key");
    }

    const where = description.where
      ? predicateSql(description.where)
      : undefined;
    const indexSnapshot: IndexSnapshot = Object.freeze({
      name,
      sqlName,
      unique: description.unique,
      method: description.method,
      keys: Object.freeze(keys),
      include: Object.freeze(include),
      ...(where === undefined ? {} : { where }),
      ...(opclasses.some(Boolean)
        ? { opclasses: Object.freeze(opclasses) }
        : {}),
      ...(description.with ? { with: description.with } : {}),
    });
    owner.table.indexes = Object.freeze([
      ...(owner.table.indexes ?? []),
      indexSnapshot,
    ]);
  }
};

/** A snapshot key with its operator class inserted before any trailing ordering. */
export const indexKeySQL = (key: string, opclass: string | null): string => {
  if (!opclass) {
    return key;
  }

  const ordering = /(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/.exec(
    key,
  )!;

  return `${key.slice(0, ordering.index)} ${opclass}${key.slice(ordering.index)}`;
};

/** The `(key opclass, ...)`, `INCLUDE`, `WITH` and `WHERE` clauses shared by every CREATE INDEX renderer. */
export const indexClausesSQL = (definition: IndexSnapshot): string =>
  `(${definition.keys.map((key, position) => indexKeySQL(key, definition.opclasses?.[position] ?? null)).join(", ")})${definition.include.length ? ` INCLUDE (${definition.include.join(", ")})` : ""}${
    definition.with
      ? ` WITH (${Object.entries(definition.with)
          .map(
            ([name, value]) =>
              `${name} = ${typeof value === "number" ? value : `'${value.replaceAll("'", "''")}'`}`,
          )
          .join(", ")})`
      : ""
  }${definition.where === undefined ? "" : ` WHERE ${definition.where}`}`;

export const createIndexesSQL = (
  snapshot: SchemaSnapshot,
  options: CreateIndexesOptions = {},
): CompiledQuery[] =>
  snapshot.tables.flatMap((table) =>
    (table.indexes ?? []).map((definition) => ({
      sql: `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX ${options.concurrently ? "CONCURRENTLY " : ""}${options.ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdentifier(definition.sqlName)} ON ${quoteIdentifier(table.sqlName)} USING ${definition.method} ${indexClausesSQL(definition)}`,
      parameters: [],
    })),
  );

export const createIndexQuery = (
  snapshot: SchemaSnapshot,
  executor: QueryExecutor | undefined,
  options: CreateIndexesOptions = {},
  transaction = false,
): IndexQuery => {
  if (transaction && options.concurrently) {
    throw new Error(
      "symmetria: CREATE INDEX CONCURRENTLY cannot run inside a transaction",
    );
  }

  const settings = Object.freeze({ ...options });

  return Object.freeze({
    toSQL: () => createIndexesSQL(snapshot, settings),
    execute: async () => {
      if (!executor) {
        throw new Error(
          "symmetria: configure a driver or executor before creating indexes",
        );
      }

      for (const query of createIndexesSQL(snapshot, settings)) {
        await executor(query);
      }
    },
  });
};
