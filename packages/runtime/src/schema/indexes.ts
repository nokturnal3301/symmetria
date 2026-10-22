import { codecFor, type SchemaCodecs } from "../query/codecs";
import { quoteIdentifier } from "../query/compiler";
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
} from "../query/state";
import { snakeCase, type SchemaSnapshot } from "./assembly";

const INDEX_DEFINITION = Symbol("symmetria.index");
export type IndexMethod = "btree" | "hash" | "gin" | "gist" | "spgist" | "brin";
type IndexKey = SelectedColumn | Ordering;
type IndexDescription = {
  readonly keys: readonly IndexKey[];
  readonly unique: boolean;
  readonly method: IndexMethod;
  readonly include: readonly SelectedColumn[];
  readonly where?: PredicateDescription;
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
}
export type IndexSnapshot = {
  readonly name: string;
  readonly sqlName: string;
  readonly unique: boolean;
  readonly method: IndexMethod;
  readonly keys: readonly string[];
  readonly include: readonly string[];
  readonly where?: string;
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
      if (
        !["btree", "hash", "gin", "gist", "spgist", "brin"].includes(method)
      ) {
        throw new Error(`symmetria: unsupported index method "${method}"`);
      }

      return defineIndex({ ...description, method });
    },
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
export const index = <const Keys extends readonly [IndexKey, ...IndexKey[]]>(
  ...[first, ...keys]: Keys
): IndexDefinition<
  Keys[number] extends ScopedColumn & SelectedColumn<unknown, infer Name>
    ? Name
    : never,
  false,
  true
> => {
  if (!first) {
    throw new Error("symmetria: an index requires at least one key");
  }

  return defineIndex({
    keys: Object.freeze([first, ...keys]),
    unique: false,
    method: "btree",
    include: Object.freeze([]),
  }) as IndexDefinition<
    Keys[number] extends ScopedColumn & SelectedColumn<unknown, infer Name>
      ? Name
      : never,
    false,
    true
  >;
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
            Object.fromEntries(
              table.columns.flatMap((column) => {
                const codec =
                  codecs[table.name]?.[column.name] ?? codecFor(column.sqlType);

                return codec ? [[column.name, codec]] : [];
              }),
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

    const keyColumns = new Set<string>();
    const keys = description.keys.map((key) => {
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
    });
    owner.table.indexes = Object.freeze([
      ...(owner.table.indexes ?? []),
      indexSnapshot,
    ]);
  }
};

export const createIndexesSQL = (
  snapshot: SchemaSnapshot,
  options: CreateIndexesOptions = {},
): CompiledQuery[] =>
  snapshot.tables.flatMap((table) =>
    (table.indexes ?? []).map((definition) => ({
      sql: `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX ${options.concurrently ? "CONCURRENTLY " : ""}${options.ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdentifier(definition.sqlName)} ON ${quoteIdentifier(table.sqlName)} USING ${definition.method} (${definition.keys.join(", ")})${definition.include.length ? ` INCLUDE (${definition.include.join(", ")})` : ""}${definition.where === undefined ? "" : ` WHERE ${definition.where}`}`,
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
