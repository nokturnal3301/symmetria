/**
 * Table identity comes from object keys. References carry
 * only that key, so contextual typing does not depend on another table's body.
 * Runtime lowering reuses the snapshot assembler; queries use the typed graph.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { extendBuilder } from "../query/expressions/callable";
import {
  COLUMN_CODEC,
  isColumn,
  type ColumnMetadata as ColumnTypeMetadata,
  type Column,
} from "./column";
import { assembleSchema, type SchemaSnapshot } from "./assembly";
import { conditionRelations, type TableRelationCallback } from "./conditions";
import {
  table,
  junction,
  isTable,
  tableState,
  type ColumnInput,
  type Table,
  type TableHandle,
  type TableIndexCallback,
  type TableCheckCallback,
  type TableState,
  type OnDeleteAction,
  tableBody,
} from "./table";
import type { SlotState, ThroughInput } from "./slots";
import {
  and,
  createQueryTables,
  createSchemaTables,
  type QueryExecutor,
  type Driver,
  type Predicate,
  type RuntimeScope,
  type TableScopes,
} from "../query/select";
import { endStreams } from "../query/select/query";
import type { SchemaCodecs } from "../query/codecs";
import { collectDataErrors } from "../query/codecs/deferred";
import type { SchemaTables } from "../query/select/registry";
import {
  createIndexQuery,
  type IndexDefinition,
  type CreateIndexesOptions,
} from "./indexes";
import type {
  ConnectionHold,
  TransactionDriver,
  TransactionOptions,
} from "../query/plan/types";
import { SCHEMA_BIND } from "./binding";
import { computedFields, type ComputedCallback } from "./computed";
import {
  createMissing,
  createReindex,
  createSearch,
  deferredWrite,
  embedRows,
  embeddedSearches,
  needsEmbedding,
} from "../query/search";
import { embeddingColumns } from "./search-columns";
import { createScope } from "../query/select/scope";
import {
  declaredSearches,
  searchColumns,
  tableSearches,
  type Search,
  type SearchCallback,
} from "./search";
import { createNestedInsert } from "../query/write/nested-inserts";
import { readsOnly, runBatch } from "../query/batch";
import { executorProfiling } from "../observability/profiling";
import { isRetryableTransactionError } from "../driver/errors";

import {
  LINK,
  type LinkOptions,
  type LinkMetadata,
  createLink,
  isLink,
} from "./links";
import type {
  TableReferences,
  KeyInference,
  TableDefinition,
  NormalizeDefinitions,
  RelationGraph,
  ColumnMetadata,
  ValidateDirectReferences,
  ValidateSchema,
  ValidateSlots,
} from "./graph";
import type { QueryRows, SchemaOptions, Database } from "./database";
import {
  type TableHandles,
  type InverseRelation,
  linkDefinitions,
  addJunctions,
  claimSlots,
  inferPrimaryKeys,
  inverseOverrides,
  declareConditions,
  declaredExtensions,
  columnCodecs,
  encodeDefaults,
  applyDeclarations,
  indexJunctionSecondKeys,
} from "./lowering";

/** Where a bound database keeps the function that builds its table handles. */
const TABLE_HANDLE = Symbol("symmetria.schema.tableHandle");
/** The longest wait between two `$transaction` retries, unless retryDelayMs is longer. */
const MAX_RETRY_DELAY_MS = 1000;
/**
 * Starts a transaction, and starts it again after a retryable failure. Each
 * attempt gets a fresh connection, BEGIN and bound database; the callback must
 * therefore be safe to run again.
 */
const retryTransaction = async <Result>(
  begin: (settings: TransactionOptions | undefined) => Promise<Result>,
  options: TransactionOptions | undefined,
): Promise<Result> => {
  const { retries = 0, retryDelayMs = 10, ...settings } = options ?? {};

  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 20) {
    throw new Error("symmetria: retries must be an integer between 0 and 20");
  }

  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("symmetria: retryDelayMs must be a non-negative number");
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await begin(options === undefined ? undefined : settings);
    } catch (error) {
      if (attempt >= retries || !isRetryableTransactionError(error)) {
        throw error;
      }

      // The wait doubles per attempt up to a second (or retryDelayMs when
      // larger), so twenty retries under contention never wait for hours.
      const delay =
        Math.random() *
        Math.min(
          retryDelayMs * 2 ** attempt,
          Math.max(retryDelayMs, MAX_RETRY_DELAY_MS),
        );

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
};

type ScopeInput = Readonly<
  Record<string, ((columns: never) => Predicate) | undefined>
>;

/** The scopes in force after `$scope(next)`: a table filtered before keeps its filter, ANDed with the new one. */
const mergeScopes = (
  tablesByName: ReadonlyMap<string, unknown>,
  scopes: TableScopes,
  next: ScopeInput,
): TableScopes =>
  Object.fromEntries(
    [...new Set([...Object.keys(scopes), ...Object.keys(next)])].map(
      (tableName) => {
        if (!tablesByName.has(tableName)) {
          throw new Error(
            `symmetria: $scope() received unknown table "${tableName}"`,
          );
        }

        const previous = scopes[tableName];
        const added = next[tableName] as TableScopes[string] | undefined;

        if (added !== undefined && typeof added !== "function") {
          throw new Error(
            `symmetria: $scope() expects a predicate callback for "${tableName}"`,
          );
        }

        return [
          tableName,
          previous && added
            ? (columns: RuntimeScope[string]) =>
                and(previous(columns), added(columns))
            : (previous ?? added)!,
        ];
      },
    ),
  );

/**
 * What every bound database of a schema shares. It depends on the schema
 * alone, so it is built once and used by each transaction and each $scope().
 */
type SchemaRuntime = {
  readonly snapshot: SchemaSnapshot;
  readonly codecs: SchemaCodecs;
  readonly schemaTables: SchemaTables;
  readonly relationNames: ReadonlyMap<string, readonly string[]>;
  /**
   * Tables are own, enumerable members of a database, as `Object.keys()` and
   * spreads expect; reading one asks that database for the handle.
   */
  readonly tableAccessors: PropertyDescriptorMap;
};

const schemaRuntime = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs,
): SchemaRuntime => ({
  snapshot,
  codecs,
  schemaTables: createSchemaTables(snapshot, codecs),
  relationNames: new Map(
    snapshot.tables.map((table) => [
      table.name,
      table.relations.map((relation) => relation.name),
    ]),
  ),
  tableAccessors: Object.fromEntries(
    snapshot.tables.map((table) => [
      table.name,
      {
        enumerable: true,
        get(this: { [TABLE_HANDLE]: (tableName: string) => object }) {
          return this[TABLE_HANDLE](table.name);
        },
      },
    ]),
  ),
});

/** The drivers whose transaction callback the current async context runs in. */
const openTransactions = new AsyncLocalStorage<
  readonly { readonly driver: object; open: boolean }[]
>();

const declaredByTable = new WeakMap<object, readonly Search[]>();

/** A table's searches, read once against its own columns: names, kinds and models. */
const searchesOf = (
  table: SchemaSnapshot["tables"][number],
): readonly Search[] => {
  let declared = declaredByTable.get(table);

  if (!declared) {
    const binding = Object.freeze({
      table,
      alias: table.name,
      codecs: Object.freeze({}),
    });

    declared = declaredSearches(
      tableSearches.get(table) ?? [],
      createScope({ [binding.alias]: binding })[binding.alias]!,
    );
    declaredByTable.set(table, declared);
  }

  return declared;
};

/** A table of a bound database: its query table, with an insert() that also takes related rows. */
const createTableHandle = (
  { snapshot, codecs, schemaTables, relationNames }: SchemaRuntime,
  tableName: string,
  queryTable: object,
  runTransaction: Parameters<typeof createNestedInsert>[3],
  scoped: boolean,
): object => {
  const tableSnapshot = schemaTables.tablesByName.get(tableName)!;
  const relations = relationNames.get(tableName)!;

  const searches = tableSearches.get(tableSnapshot) ?? [];
  const embedded = searches.length
    ? embeddedSearches(searchesOf(tableSnapshot), searchColumns, tableSnapshot)
    : [];
  // Rows whose searches keep an embedding wait for it before they are written.
  const embedding =
    <Values>(write: (values: Values) => object, upsert = false) =>
    (values: Values, ...rest: unknown[]): object => {
      const rows = (Array.isArray(values) ? values : [values]) as Record<
        string,
        unknown
      >[];

      if (!embedded.length || !needsEmbedding(embedded, rows)) {
        return (write as (...argumentsList: unknown[]) => object)(
          values,
          ...rest,
        );
      }

      return deferredWrite(async (_chained, calls) => {
        // `doUpdate("title")` that sets every column an embedding reads also
        // sets the embedding computed for those values.
        const chained = (builder: object) =>
          calls.reduce(
            (current, [method, argumentsList]) =>
              (
                current as Record<
                  string,
                  (...values: readonly unknown[]) => object
                >
              )[method]!(
                ...(method === "doUpdate" &&
                argumentsList.every((name) => typeof name === "string")
                  ? withEmbeddedColumns(argumentsList)
                  : argumentsList),
              ),
            builder,
          );

        // A write the rows already fail is refused before a model is paid for.
        const [, failure] = collectDataErrors(() =>
          chained(
            (write as (...argumentsList: unknown[]) => object)(values, ...rest),
          ),
        );

        if (failure) {
          throw failure.error;
        }

        // An upsert keeps the columns it does not set; their text is unknown here.
        const filled = await embedRows(
          embedded,
          rows,
          upsert || calls.some(([method]) => method === "onConflict"),
        );

        return {
          builder: chained(
            (write as (...argumentsList: unknown[]) => object)(
              Array.isArray(values) ? filled : filled[0],
              ...(upsert ? [withEmbeddings(rest[0])] : rest),
            ),
          ),
          chained: true as const,
        };
      });
    };

  // A list of columns to overwrite that holds every column an embedding
  // reads also overwrites the embedding, which describes exactly those values.
  const withEmbeddedColumns = (update: readonly unknown[]): unknown[] => [
    ...update,
    ...embedded
      .filter((search) => search.sources.every((name) => update.includes(name)))
      .map((search) => search.column)
      .filter((column) => !update.includes(column)),
  ];
  const withEmbeddings = (options: unknown): unknown => {
    const update = (options as { update?: unknown } | undefined)?.update;

    return Array.isArray(update)
      ? { ...(options as object), update: withEmbeddedColumns(update) }
      : options;
  };

  return extendBuilder(queryTable, {
    $name: tableSnapshot.sqlName,
    ...(searches.length
      ? {
          search: Object.assign(
            createSearch(
              queryTable,
              tableSnapshot,
              searches,
              searchesOf(tableSnapshot),
              scoped,
            ),
            {
              reindex: createReindex(queryTable, tableSnapshot, embedded),
              missing: createMissing(queryTable, tableSnapshot, embedded),
            },
          ),
        }
      : {}),
    ...(embedded.length
      ? {
          upsert: embedding(
            (queryTable as { upsert: (values: unknown) => object }).upsert,
            true,
          ),
        }
      : {}),
    insert: embedding(
      (
        values: Record<string, unknown> | readonly Record<string, unknown>[],
      ) => {
        const rows = Array.isArray(values) ? values : [values];

        if (
          rows.some(
            (row) =>
              row &&
              relations.some(
                (name) => (row as Record<string, unknown>)[name] !== undefined,
              ),
          )
        ) {
          return createNestedInsert(
            snapshot,
            tableSnapshot.name,
            values,
            runTransaction,
            codecs,
          );
        }

        // An omitted (undefined) relation keeps the flat, single-statement INSERT.
        const flat = (row: Record<string, unknown>) =>
          row && relations.some((name) => name in row)
            ? Object.fromEntries(
                Object.entries(row).filter(
                  ([name]) => !relations.includes(name),
                ),
              )
            : row;

        return (
          queryTable as {
            insert: (values: unknown) => object;
          }
        ).insert(
          Array.isArray(values)
            ? rows.map(flat)
            : flat(values as Record<string, unknown>),
        );
      },
    ),
  });
};

/** A database object over one executor: the schema itself, a transaction, a savepoint or a `$scope()`. */
const bindDatabase = (
  runtime: SchemaRuntime,
  executor: QueryExecutor | undefined,
  transactionDriver: TransactionDriver | undefined,
  driver: Driver | undefined,
  scopes: TableScopes = {},
  addedScopes?: readonly string[],
): object => {
  const { snapshot, schemaTables } = runtime;
  // Atomic multi-statement work (chunked bulk inserts): a savepoint inside a
  // transaction, otherwise a transaction of the configured driver.
  const atomicDriver = transactionDriver ?? driver;
  // Streams hold a connection for the whole iteration: the current
  // transaction's connection when there is one (a savepoint would block the
  // caller), otherwise a transaction of the configured driver.
  const hold: ConnectionHold | undefined = transactionDriver
    ? (run) => run(transactionDriver.execute)
    : driver?.transaction
      ? Object.assign(
          ((run) =>
            driver.transaction!((connection) =>
              run(connection.execute),
            )) as ConnectionHold,
          // $close() ends the streams open on this driver.
          { owner: driver },
        )
      : undefined;
  const queryTables = createQueryTables(
    schemaTables,
    executor,
    scopes,
    atomicDriver?.transaction
      ? (run) =>
          atomicDriver.transaction!((connection) => run(connection.execute))
      : undefined,
    hold,
  );
  const profile = executorProfiling(executor);

  // A callback $scope() was just given runs once now, so one that cannot
  // be a filter fails $scope() itself, not the first query on its table.
  addedScopes?.forEach(queryTables.checkScope);

  const runTransaction = async <Result>(
    callback: (database: Record<string, unknown>) => PromiseLike<Result>,
    options?: TransactionOptions,
  ): Promise<Result> => {
    const run = async (connection: TransactionDriver) =>
      callback(
        bindDatabase(
          runtime,
          connection.execute,
          connection,
          driver,
          scopes,
        ) as Record<string, unknown>,
      );

    if (transactionDriver) {
      if (options !== undefined) {
        throw new Error(
          "symmetria: transaction options cannot be changed inside a savepoint",
        );
      }

      return transactionDriver.transaction(run);
    }

    if (!driver?.transaction) {
      throw new Error(
        "symmetria: the configured driver does not support transactions",
      );
    }

    return retryTransaction((settings) => {
      // Code the callback starts that still runs after it returned (a timer,
      // a shutdown hook) is not inside the transaction any more.
      const entry = { driver, open: true };
      const held = [
        ...(openTransactions.getStore() ?? []).filter((outer) => outer.open),
        entry,
      ];

      return driver.transaction!(
        (connection) =>
          openTransactions.run(held, async () => {
            try {
              return await run(connection);
            } finally {
              entry.open = false;
            }
          }),
        settings,
      );
    }, options);
  };

  // A transaction usually touches a few tables of many: handles are built
  // on first use and kept, so a table reads as the same object every time.
  const tableHandles = new Map<string, object>();

  const tableHandle = (tableName: string): object => {
    let handle = tableHandles.get(tableName);

    if (!handle) {
      const table = createTableHandle(
        runtime,
        tableName,
        queryTables.table(tableName),
        runTransaction,
        !!scopes[tableName],
      );

      handle = profile ? profile.trackBuilder(table) : table;
      tableHandles.set(tableName, handle);
    }

    return handle;
  };

  const database = Object.create(Object.prototype, runtime.tableAccessors);

  Object.defineProperty(database, TABLE_HANDLE, { value: tableHandle });

  return Object.freeze(
    Object.assign(database, {
      ...(!transactionDriver
        ? {
            [SCHEMA_BIND]: (connection: Driver) =>
              bindDatabase(
                runtime,
                connection.execute,
                undefined,
                connection,
                scopes,
              ),
          }
        : {}),
      $scope: (next: ScopeInput) =>
        bindDatabase(
          runtime,
          executor,
          transactionDriver,
          driver,
          mergeScopes(schemaTables.tablesByName, scopes, next),
          Object.keys(next).filter((tableName) => next[tableName]),
        ),
      // Reads only: what needs a connection of its own (a nested insert, a
      // stream, a transaction) is refused by the handle's driver.
      $batch: (callback: (database: object) => unknown) =>
        runBatch(
          executor,
          (collecting) =>
            callback(
              bindDatabase(
                runtime,
                collecting,
                undefined,
                {
                  execute: collecting,
                  close: async () => {},
                  transaction: () => Promise.reject(readsOnly()),
                },
                scopes,
              ),
            ),
          snapshot.tables,
        ),
      $snapshot: () => structuredClone(snapshot),
      $createIndexes: (settings?: CreateIndexesOptions) =>
        createIndexQuery(snapshot, executor, settings, !!transactionDriver),
      $transaction: runTransaction,
      ...(transactionDriver
        ? {}
        : {
            $close: async () => {
              // Closing waits for open transactions, and this one would
              // wait for the close: neither would ever finish.
              if (
                driver &&
                openTransactions
                  .getStore()
                  ?.some((entry) => entry.open && entry.driver === driver)
              ) {
                throw new Error(
                  "symmetria: $close() was called inside a $transaction() of the same database; close it after the transaction ends",
                );
              }

              if (driver) {
                await endStreams(driver);
              }

              await driver?.close();
            },
          }),
    }),
  );
};

const createSchema = <
  const TableNames extends string,
  const KeyValues extends Record<TableNames, unknown>,
  const Shapes extends Record<TableNames, unknown>,
  const Definition extends Record<
    TableNames,
    Record<string, Exclude<ColumnInput, undefined> | LinkMetadata>
  >,
  const Indexes extends Record<string, IndexDefinition> = {},
>(
  definitions: Record<TableNames, unknown> & {
    // Column records of tables declared without a callback; keyed links carry them.
    [TableName in keyof Shapes]:
      | Shapes[TableName]
      | Table<Shapes[TableName]>
      | ((
          references: TableReferences<TableNames, KeyValues, Shapes>,
        ) => unknown);
  } & {
    [TableName in keyof KeyValues]:
      | KeyInference<KeyValues[TableName]>
      | ((
          references: TableReferences<TableNames, KeyValues, Shapes>,
        ) => KeyInference<KeyValues[TableName]>);
  } & {
    [TableName in keyof Definition]:
      | Definition[TableName]
      | Table<Definition[TableName]>
      | ((
          references: TableReferences<TableNames, KeyValues, Shapes>,
        ) => Definition[TableName] | Table<Definition[TableName]>);
  } & ValidateSchema<NormalizeDefinitions<NoInfer<Definition>>> &
    ValidateDirectReferences<NoInfer<Definition>> &
    ValidateSlots<NoInfer<Definition>>,
  options: SchemaOptions<
    NoInfer<QueryRows<NormalizeDefinitions<Definition>>>,
    Indexes
  > = {},
): Database<
  NormalizeDefinitions<Definition>,
  RelationGraph<NormalizeDefinitions<Definition>>,
  Indexes
> => {
  const tableNames = Object.keys(definitions);
  const references = Object.freeze(
    Object.fromEntries(
      tableNames.map((tableName) => [tableName, createLink(tableName, {})]),
    ),
  );
  const tableIndexes = new Map<string, readonly TableIndexCallback[]>();
  const tableChecks = new Map<string, readonly TableCheckCallback[]>();
  const tableComputed = new Map<string, readonly ComputedCallback[]>();
  const tableSearch = new Map<string, readonly SearchCallback[]>();
  // What `.search()` declarations need: `vector`, `pg_search`.
  const neededExtensions = new Set<string>();
  const tableSqlNames = new Map<string, string>();
  const tableRelations = new Map<string, readonly TableRelationCallback[]>();
  const primaryKeys = new Map<string, readonly string[]>();
  const junctionTables = new Set<string>();
  // link(): what a delete does to a reference that does not say.
  const defaultDeletes = new Map<string, OnDeleteAction>();
  const tableNamesByState = new Map<TableState, string[]>();
  // Plain column records are tracked by identity so to(users) can name them too.
  const tableNamesByRecord = new Map<object, string[]>();
  const tableSlots = new Map<string, Readonly<Record<string, SlotState>>>();
  const tableThroughs = new Map<
    string,
    Readonly<Record<string, ThroughInput>>
  >();
  const rawDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([tableName, definition]) => {
      const resolved =
        typeof definition === "function"
          ? definition(references as TableReferences<TableNames, KeyValues>)
          : definition;

      if (!isTable(resolved)) {
        if (resolved && typeof resolved === "object") {
          tableNamesByRecord.set(resolved, [
            ...(tableNamesByRecord.get(resolved) ?? []),
            tableName,
          ]);

          // A plain record declares slots like table() does.
          const body = tableBody(resolved as Record<string, unknown>);

          tableSlots.set(tableName, body.slots);
          tableThroughs.set(tableName, body.throughs);

          return [tableName, body.columns];
        }

        return [tableName, resolved];
      }

      const state = tableState(resolved);

      tableSlots.set(tableName, state.slots);
      tableThroughs.set(tableName, state.throughs);
      tableNamesByState.set(state, [
        ...(tableNamesByState.get(state) ?? []),
        tableName,
      ]);
      tableIndexes.set(tableName, state.indexCallbacks);
      tableChecks.set(tableName, state.checkCallbacks);
      tableComputed.set(tableName, state.computedCallbacks);
      tableSearch.set(tableName, state.searchCallbacks);

      for (const extension of state.extensions) {
        neededExtensions.add(extension);
      }

      if (state.named !== undefined) {
        tableSqlNames.set(tableName, state.named);
      }
      tableRelations.set(tableName, state.relationCallbacks);

      if (state.primaryKey) {
        primaryKeys.set(tableName, state.primaryKey);
      }

      if (state.junction) {
        junctionTables.add(tableName);
      }

      if (state.defaultDelete) {
        defaultDeletes.set(tableName, state.defaultDelete);
      }

      return [tableName, state.columns];
    }),
  ) as Record<string, Record<string, unknown>>;
  const claimedSlots = new Set<string>();

  addJunctions(
    rawDefinitions,
    tableThroughs,
    tableNamesByState,
    junctionTables,
    tableSqlNames,
    claimedSlots,
  );

  const tableDefinitions = linkDefinitions(rawDefinitions, tableNamesByState);

  claimSlots(tableDefinitions, tableSlots, claimedSlots);
  inferPrimaryKeys(tableDefinitions, primaryKeys, junctionTables);

  const tableHandles: TableHandles = Object.create(null);
  const inverseRelations: InverseRelation[] = [];

  for (const [tableName, tableDefinition] of Object.entries(tableDefinitions)) {
    // Database methods a table of the same name would replace or be replaced
    // by, and `then`, which would make the database object awaitable.
    if (
      [
        "$scope",
        "$batch",
        "$snapshot",
        "$close",
        "$transaction",
        "$createIndexes",
        "then",
        "__proto__",
        "constructor",
        "prototype",
      ].includes(tableName)
    ) {
      throw new Error(`symmetria: reserved table name "${tableName}"`);
    }

    const columns: Record<string, ColumnInput> = Object.create(null);
    const columnEntries = Object.entries(tableDefinition);
    const isJunction = junctionTables.has(tableName);

    for (const [columnName, value] of columnEntries) {
      if (isColumn(value)) {
        if (
          primaryKeys.get(tableName)!.includes(columnName) &&
          !value.definition.notNull
        ) {
          throw new Error(
            `symmetria: primary key "${tableName}.${columnName}" cannot be nullable`,
          );
        }

        columns[columnName] = value;
        continue;
      }

      if (!isLink(value)) {
        throw new Error(
          `symmetria: invalid column "${tableName}.${columnName}"`,
        );
      }

      const { target } = value[LINK];
      const defaultDelete = defaultDeletes.get(tableName);
      const flags: LinkOptions =
        defaultDelete && value[LINK].flags.onDelete === undefined
          ? { ...value[LINK].flags, onDelete: defaultDelete }
          : value[LINK].flags;
      const targetDefinition = tableDefinitions[target];
      const targetKeys = primaryKeys.get(target) ?? [];

      if (!targetDefinition) {
        throw new Error(
          `symmetria: "${tableName}.${columnName}" references unknown table "${target}"`,
        );
      }

      if (flags.by !== undefined) {
        const referenced = targetDefinition[flags.by];

        if (
          !isColumn(referenced) ||
          !(
            referenced.definition.unique ||
            (targetKeys.length === 1 && targetKeys[0] === flags.by)
          )
        ) {
          throw new Error(
            `symmetria: "${tableName}.${columnName}" references "${target}.${flags.by}", which must be a unique column or the primary key`,
          );
        }
      } else if (
        targetKeys.length !== 1 ||
        !isColumn(targetDefinition[targetKeys[0]!])
      ) {
        throw new Error(
          `symmetria: "${tableName}.${columnName}" must reference a table with a single scalar primary key`,
        );
      }

      // A many-to-many relation named by its declaration: `tags: many(tags.posts)`.
      if (flags.through !== undefined && isJunction) {
        inverseRelations.push({
          target,
          name: flags.through,
          source: tableName,
          column: columnName,
        });
      }

      if (flags.inverse !== undefined) {
        if (isJunction) {
          throw new Error(
            "symmetria: junction inverse renaming is not implemented",
          );
        }

        inverseRelations.push({
          target,
          name: flags.inverse,
          source: tableName,
          column: columnName,
        });
      }

      // Resolve all handles only after every table body has been evaluated.
      columns[columnName] = Object.freeze({
        kind: "reference",
        target: target === tableName ? "self" : () => tableHandles[target]!,
        flags: Object.freeze({ ...flags }),
      }) as unknown as ColumnInput;
    }

    tableHandles[tableName] = (
      isJunction ? junction(columns) : table(columns)
    ) as TableHandle<Record<string, ColumnInput>>;
    const named = tableSqlNames.get(tableName);

    if (named !== undefined) {
      tableHandles[tableName] = tableHandles[tableName]!.named(named);
    }
    const explicitKeys = primaryKeys.get(tableName)!;

    if (!isJunction && explicitKeys.length) {
      tableHandles[tableName] = tableHandles[tableName]!.primaryKey(
        (columns) => {
          const scope =
            columns as unknown as import("../query/select").RuntimeScope[string];

          return [
            scope[explicitKeys[0]!]!,
            ...explicitKeys.slice(1).map((name) => scope[name]!),
          ];
        },
      );
    }
  }

  const overrides = inverseOverrides(inverseRelations, tableHandles);
  const conditions = declareConditions(
    tableRelations,
    tableHandles,
    tableDefinitions,
    tableNamesByState,
    tableNamesByRecord,
  );

  if (
    options.casing !== undefined &&
    options.casing !== "snake_case" &&
    options.casing !== "preserve"
  ) {
    throw new Error('symmetria: casing must be "snake_case" or "preserve"');
  }

  const snapshot = assembleSchema(
    tableHandles,
    overrides,
    conditions,
    options.casing,
  );

  for (const [tableName, slots] of tableSlots) {
    for (const key of Object.keys(slots)) {
      if (!claimedSlots.has(`${tableName}.${key}`)) {
        throw new Error(
          `symmetria: slot "${tableName}.${key}" is never claimed; the table on the other side declares it: one(${tableName}.${key}), maybe(${tableName}.${key}) or many(${tableName}.${key})`,
        );
      }
    }
  }

  if (options.extensions?.length || neededExtensions.size) {
    snapshot.extensions = declaredExtensions([
      ...(options.extensions ?? []),
      ...neededExtensions,
    ]);
  }

  for (const table of snapshot.tables) {
    computedFields.set(table, tableComputed.get(table.name) ?? []);
    tableSearches.set(table, tableSearch.get(table.name) ?? []);

    if (tableSearch.get(table.name)?.length) {
      embeddingColumns.set(
        table,
        searchesOf(table).flatMap((search) =>
          search.meaning
            ? [{ column: search.name, sources: searchColumns(search.meaning) }]
            : [],
        ),
      );

      for (const search of searchesOf(table)) {
        if (search.meaning) {
          table.columns.find(
            (column) => column.name === search.name,
          )!.embedding = {
            model: search.meaning.model.name,
            sources: searchColumns(search.meaning).map(
              (name) =>
                table.columns.find((column) => column.name === name)!.sqlName,
            ),
          };
        }
      }
    }
    conditionRelations.set(table, tableRelations.get(table.name) ?? []);
  }

  if (options.executor && options.driver) {
    throw new Error("symmetria: supply either driver or executor");
  }

  const codecs = columnCodecs(tableDefinitions, primaryKeys);

  encodeDefaults(snapshot, codecs);
  applyDeclarations(
    snapshot,
    codecs,
    tableIndexes,
    tableChecks,
    options.indexes as unknown as
      | ((scope: RuntimeScope) => Record<string, IndexDefinition>)
      | undefined,
  );
  indexJunctionSecondKeys(snapshot, codecs);

  return bindDatabase(
    schemaRuntime(snapshot, codecs),
    options.executor ?? options.driver?.execute,
    undefined,
    options.driver,
  ) as Database<
    NormalizeDefinitions<Definition>,
    RelationGraph<NormalizeDefinitions<Definition>>,
    Indexes
  >;
};

type KeyValuesOf<Keys extends Record<string, Column<ColumnTypeMetadata>>> = {
  [Name in keyof Keys]: ColumnMetadata<Keys[Name]>["valueType"];
};

/** Anchor key types before checking mutually recursive table callbacks. */
const withKeys =
  <const Keys extends Record<string, Column<ColumnTypeMetadata>>>(keys: Keys) =>
  <
    const Definition extends Record<keyof Keys & string, TableDefinition>,
    const Indexes extends Record<string, IndexDefinition> = {},
  >(
    definitions: {
      [Name in keyof Definition]:
        | Definition[Name]
        | Table<Definition[Name]>
        | ((
            references: TableReferences<keyof Keys & string, KeyValuesOf<Keys>>,
          ) => Definition[Name] | Table<Definition[Name]>);
    } & ValidateSchema<NoInfer<Definition>>,
    options: SchemaOptions<NoInfer<QueryRows<Definition>>, Indexes> = {},
  ): Database<Definition, RelationGraph<Definition>, Indexes> => {
    for (const [name, key] of Object.entries(keys)) {
      if (!isColumn(key)) {
        throw new Error(
          "symmetria: schema.keys() expects primary-key column types",
        );
      }

      if (!Object.hasOwn(definitions, name)) {
        throw new Error(`symmetria: unknown schema.keys() table "${name}"`);
      }
    }

    const anchored = Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        (
          references: TableReferences<keyof Keys & string, KeyValuesOf<Keys>>,
        ) => {
          const resolved =
            typeof definition === "function"
              ? definition(references)
              : definition;
          const key = keys[name];

          if (key) {
            const state = isTable(resolved) ? tableState(resolved) : undefined;
            const columns = state?.columns ?? (resolved as TableDefinition);
            const marked = Object.entries(columns)
              .filter(
                ([, column]) =>
                  isColumn(column) && column.definition.primaryKey,
              )
              .map(([name]) => name);
            const names =
              state?.primaryKey ?? (marked.length ? marked : ["id"]);
            const primary = names.length === 1 ? columns[names[0]!] : undefined;

            if (
              !isColumn(primary) ||
              primary.definition.sqlType !== key.definition.sqlType ||
              primary[COLUMN_CODEC] !== key[COLUMN_CODEC] ||
              JSON.stringify(primary.definition.enumerationValues) !==
                JSON.stringify(key.definition.enumerationValues)
            ) {
              throw new Error(
                `symmetria: primary key for "${name}" does not match schema.keys()`,
              );
            }
          }

          return resolved;
        },
      ]),
    );

    return createSchema(
      anchored as never,
      options as never,
    ) as unknown as Database<Definition, RelationGraph<Definition>, Indexes>;
  };

export const schema = Object.assign(createSchema, { keys: withKeys });
