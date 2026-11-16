/** createQueryTables(): one callable per table with lookups, shapes and mutations. */
import { freeze } from "../plan/freeze";
import {
  primaryKeyColumns,
  type ColumnSnapshot,
  type TableSnapshot,
} from "../../schema/assembly";
import { computedFields } from "../../schema/computed";
import { collectDataErrors, dataError } from "../codecs/deferred";
import {
  readColumn,
  readPredicate,
  valueNode,
  type ExpressionDescription,
  type PredicateDescription,
  type ValueNode,
} from "../expressions";
import { createMutation } from "../write/mutations";
import type { AtomicRunner, MutationOptions } from "../write/types";
import { SHAPE_SOURCE } from "./projections";
import type {
  QueryExecutor,
  SelectPlan,
  ConnectionHold,
  TableBinding,
} from "../plan/types";
import { executorProfiling } from "../../observability/profiling";
import { boundMethodDescriptors, extendBuilder } from "../expressions/callable";
import { createContext } from "./context";
import type { ShapeCallback } from "./joins";
import { equalityPredicates, plainRecord } from "./shape";
import { createQueryFactory } from "./query";
import {
  createTableRegistry,
  type SchemaTables,
  type TableScopes,
} from "./registry";
import {
  QUERY_STATE,
  createScope,
  initialPlan,
  type QueryHandle,
  shapeFrame,
} from "./scope";
import type { RuntimeScope } from "./types";

export {
  createSchemaTables,
  type SchemaTables,
  type TableScopes,
} from "./registry";

type WriteBuilder = {
  readonly where: (callback: (row: RuntimeScope[string]) => unknown) => object;
  readonly onConflict: (...columns: string[]) => {
    readonly doUpdate: (...columns: string[]) => object;
  };
};

/**
 * `update(values, { where })` and `delete({ where })`: the options form of
 * `.where()`. An object of equalities must name at least one column, because
 * a filter that ends up empty would otherwise write every row.
 */
const restricted = (
  kind: "update" | "delete",
  mutation: object,
  options: unknown,
): object => {
  if (options === undefined) {
    return mutation;
  }

  if (!plainRecord(options)) {
    throw new Error(`symmetria: ${kind}() options must be an object`);
  }

  for (const name of Object.keys(options)) {
    if (name !== "where") {
      throw new Error(`symmetria: unknown ${kind}() option "${name}"`);
    }
  }

  const { where } = options;

  if (where === undefined) {
    return mutation;
  }

  return (mutation as WriteBuilder).where((row) => {
    const value = typeof where === "function" ? where(row) : where;

    if (!plainRecord(value)) {
      return value;
    }

    const predicates = equalityPredicates(row, value) as readonly unknown[];

    if (!predicates.length) {
      throw new Error(
        `symmetria: ${kind}() where: {} names no column; call .all() to ${kind} every row`,
      );
    }

    // One condition is that condition, as `.where()` would write it.
    return predicates.length === 1 ? predicates[0] : predicates;
  });
};

/** A lookup as `get()` and `find()` use it. */
type LookupQuery = {
  (shape: ShapeCallback): LookupQuery;
  readonly one: () => Promise<Record<string, unknown>>;
  readonly maybeOne: () => Promise<Record<string, unknown> | null>;
};

/** The table handles of one bound database, each created when first asked for. */
export type QueryTables = {
  readonly table: (tableName: string) => object;
  /**
   * Runs a table's `$scope()` callback now, so a mistake in it is reported
   * by `$scope()` itself rather than by the first query on that table.
   */
  readonly checkScope: (tableName: string) => void;
};

/**
 * A database is bound for every transaction attempt and every `$scope()`,
 * and most of them touch a few tables: a handle, its root binding and its
 * `$scope()` filter are therefore built on first use, not for every table.
 */
export const createQueryTables = (
  schemaTables: SchemaTables,
  executor?: QueryExecutor,
  scopes: TableScopes = {},
  atomic?: AtomicRunner,
  hold?: ConnectionHold,
): QueryTables => {
  const profile = executorProfiling(executor);
  const registry = createTableRegistry(schemaTables, scopes);
  const { createQuery, queryPrototype } = createQueryFactory(
    registry,
    executor,
    profile,
    hold,
  );

  const roots = new Map<string, { root: TableBinding; plan: SelectPlan }>();

  const rootOf = (tableName: string) => {
    let entry = roots.get(tableName);

    if (!entry) {
      const root = registry.bindingFor(tableName, tableName);

      entry = { root, plan: registry.scopedPlan(root) };
      roots.set(tableName, entry);
    }

    return entry;
  };

  const createTable = (table: TableSnapshot): object => {
    const { root, plan: rootPlan } = rootOf(table.name);
    const mutationOptions: MutationOptions = freeze({
      ...(atomic ? { atomic } : {}),
      scope: () => registry.scopePredicates(root),
      context: (plan: SelectPlan) => createContext(registry, plan),
    });
    const lookupPrototype = Object.freeze(
      Object.create(
        queryPrototype,
        boundMethodDescriptors({
          update(
            this: QueryHandle,
            values:
              | Record<string, unknown>
              | ((row: RuntimeScope[string]) => Record<string, unknown>),
            options?: unknown,
          ) {
            const plan = this[QUERY_STATE].plan;

            return restricted(
              "update",
              createMutation("update", plan.root, values, executor, {
                ...mutationOptions,
                scope: () => plan.predicates,
                ...(plan.failure ? { failure: plan.failure } : {}),
              }),
              options,
            );
          },
          delete(this: QueryHandle, options?: unknown) {
            const plan = this[QUERY_STATE].plan;

            return restricted(
              "delete",
              createMutation("delete", plan.root, {}, executor, {
                ...mutationOptions,
                scope: () => plan.predicates,
                ...(plan.failure ? { failure: plan.failure } : {}),
              }),
              options,
            );
          },
        }),
      ),
    );

    /**
     * Key lookups build their plan directly instead of materializing a column
     * scope; scoped tables and computed fields still need the full scope. A
     * key value the codecs reject fails the lookup when it runs.
     */
    const keyLookup = (
      label: "primary key" | "unique key",
      keys: readonly ColumnSnapshot[],
      values: readonly unknown[],
    ): object => {
      const [plan, failure] = collectDataErrors(() =>
        keyPlan(label, keys, values),
      );

      return createQuery(
        failure ? freeze({ ...plan, failure }) : plan,
        false,
        false,
        lookupPrototype,
        plan.root === root,
      );
    };

    const keyPlan = (
      label: "primary key" | "unique key",
      keys: readonly ColumnSnapshot[],
      keyValues: readonly unknown[],
    ): SelectPlan => {
      const binding = shapeFrame.bindings ? freeze({ ...root }) : root;
      const values = keyValues.map((value, position) => {
        if (value !== null && value !== undefined) {
          return value;
        }

        dataError(
          new Error(
            `symmetria: ${label} "${keys[position]!.name}" cannot be null or undefined`,
          ),
        );

        return null;
      });

      if (registry.scopes[table.name] || computedFields.get(table)?.length) {
        const columns = createScope({ [binding.alias]: binding })[
          binding.alias
        ]!;

        return freeze({
          ...initialPlan(binding),
          predicates: freeze([
            ...registry.scopePredicates(binding),
            ...keys.map((column, position) =>
              readPredicate(
                columns[column.name]!.is(values[position] as never),
              ),
            ),
          ]),
          selection: freeze(Object.values(columns).map(readColumn)),
        });
      }

      const columnNode = (column: ColumnSnapshot): ValueNode =>
        freeze({
          kind: "column",
          description: freeze({ binding, column }),
        });

      const predicates = keys.map((column, position): PredicateDescription => {
        const right = valueNode(values[position], binding.codecs[column.name]);

        return freeze({
          kind: "comparison",
          left: columnNode(column),
          operator: "=",
          right,
          ...(right.kind === "placeholder" && right.nullable
            ? { nullableParameter: true as const }
            : {}),
        });
      });
      const selection = table.columns
        .filter((column) => !column.hidden)
        .map((column): ExpressionDescription => {
          const codec = binding.codecs[column.name];

          return freeze({
            node: columnNode(column),
            outputName: column.name,
            ...(codec ? { codec } : {}),
          });
        });

      return freeze({
        ...initialPlan(binding),
        predicates: freeze(predicates),
        selection: freeze(selection),
      });
    };

    const uniqueLookup = (names: readonly string[], value: unknown) => {
      if (
        !names.length ||
        (names.length > 1 &&
          (!value ||
            typeof value !== "object" ||
            Object.keys(value).length !== names.length ||
            names.some((name) => !Object.hasOwn(value, name))))
      ) {
        throw new Error(
          `symmetria: unique lookup requires exactly these key fields: ${names.join(", ")}`,
        );
      }

      return keyLookup(
        "unique key",
        names.map(
          (name) => table.columns.find((column) => column.name === name)!,
        ),
        names.map((name) =>
          names.length === 1 ? value : (value as Record<string, unknown>)[name],
        ),
      );
    };

    const uniqueKeys = schemaTables.uniqueKeys.get(table.name)!;

    const byId = (value: unknown) => {
      const keys = primaryKeyColumns(table);

      if (!keys.length) {
        throw new Error(
          `symmetria: byId() requires a primary key on "${table.name}"`,
        );
      }

      if (
        keys.length > 1 &&
        (!value ||
          typeof value !== "object" ||
          Object.keys(value).length !== keys.length ||
          keys.some((column) => !Object.hasOwn(value, column.name)))
      ) {
        throw new Error(
          `symmetria: byId() requires exactly these key fields: ${keys.map((column) => column.name).join(", ")}`,
        );
      }

      return keyLookup(
        "primary key",
        keys,
        keys.map((column) =>
          keys.length === 1
            ? value
            : (value as Record<string, unknown>)[column.name],
        ),
      );
    };

    /**
     * INSERT … ON CONFLICT (by) DO UPDATE: the row is inserted, or the row
     * with the same key takes the listed columns, by default every column the
     * rows carry except the key.
     */
    const upsert = (
      values: Record<string, unknown> | readonly Record<string, unknown>[],
      options: unknown,
    ) => {
      if (!plainRecord(options) || options.by === undefined) {
        throw new Error(
          `symmetria: upsert() on "${table.name}" needs the conflict key: upsert(values, { by: "column" })`,
        );
      }

      for (const name of Object.keys(options)) {
        if (name !== "by" && name !== "update") {
          throw new Error(`symmetria: unknown upsert() option "${name}"`);
        }
      }

      const by: readonly unknown[] = Array.isArray(options.by)
        ? options.by
        : [options.by];
      const keys = [
        primaryKeyColumns(table).map((column) => column.name),
        ...uniqueKeys.values(),
      ].filter((key) => key.length);

      if (
        !keys.some(
          (key) =>
            key.length === by.length && key.every((name) => by.includes(name)),
        )
      ) {
        throw new Error(
          `symmetria: upsert() by: ${by.map((name) => JSON.stringify(name)).join(", ")} is not the primary key or a unique key of "${table.name}"; its keys: ${keys.map((key) => (key.length > 1 ? `[${key.join(", ")}]` : key[0])).join(", ") || "none"}`,
        );
      }

      const rows = Array.isArray(values) ? values : [values];
      let update = options.update as readonly string[] | undefined;

      if (update === undefined) {
        const present = (row: Record<string, unknown>) =>
          Object.keys(row).filter(
            (name) => row[name] !== undefined && !by.includes(name),
          );
        const first = present(rows[0] ?? {});
        const shared = new Set(first);
        let uneven: string | undefined;

        for (const row of rows) {
          const names = present(row);

          uneven ??=
            names.find((name) => !shared.has(name)) ??
            (names.length < first.length
              ? first.find((name) => !names.includes(name))
              : undefined);
        }

        // A column some rows leave out would be overwritten with its default.
        if (uneven !== undefined) {
          throw new Error(
            `symmetria: upsert() rows carry different columns ("${uneven}" is not in every row); list the columns to overwrite: upsert(rows, { by, update: [...] })`,
          );
        }

        update = first;
      } else if (!Array.isArray(update)) {
        throw new Error("symmetria: upsert() update must be a list of columns");
      }

      const key = by as readonly string[];

      return (
        (
          createMutation(
            "insert",
            root,
            values,
            executor,
            mutationOptions,
          ) as WriteBuilder
        )
          .onConflict(...key)
          // Nothing to overwrite: the key assigns itself, so the row still comes back.
          .doUpdate(...(update.length ? update : key))
      );
    };

    /**
     * `get({ email })`: an object names the columns of the primary key or of
     * one unique key; any other value is the primary key itself.
     */
    const keyLookupOf = (value: unknown): object => {
      if (!plainRecord(value)) {
        return byId(value);
      }

      const names = Object.keys(value);
      const primary = primaryKeyColumns(table);
      const sameColumns = (columns: readonly string[]) =>
        columns.length === names.length &&
        columns.every((name) => Object.hasOwn(value, name));

      if (sameColumns(primary.map((column) => column.name))) {
        return keyLookup(
          "primary key",
          primary,
          primary.map((column) => value[column.name]),
        );
      }

      const unique = [...uniqueKeys.values()].find(sameColumns);

      if (!unique) {
        const keys = [
          primary.map((column) => column.name),
          ...uniqueKeys.values(),
        ].filter((key) => key.length);

        throw new Error(
          `symmetria: ${names.map((name) => JSON.stringify(name)).join(", ") || "{}"} is not the primary key or a unique key of "${table.name}"; its keys: ${keys.map((key) => (key.length > 1 ? `[${key.join(", ")}]` : key[0])).join(", ") || "none"}`,
        );
      }

      return keyLookup(
        "unique key",
        unique.map(
          (name) => table.columns.find((column) => column.name === name)!,
        ),
        unique.map((name) => value[name]),
      );
    };

    /** The row with this key, whole or through a shape. */
    const keyed = (value: unknown, shape?: ShapeCallback) => {
      const lookup = keyLookupOf(value) as LookupQuery;

      return shape === undefined ? lookup : lookup(shape);
    };

    return extendBuilder(createQuery(rootPlan, true, true), {
      shape: (callback: ShapeCallback) => {
        if (typeof callback !== "function") {
          throw new Error("symmetria: shape() requires a synchronous callback");
        }

        return freeze(
          Object.assign(
            (columns: RuntimeScope[string], tools: unknown) =>
              callback(columns, tools as Parameters<ShapeCallback>[1]),
            { [SHAPE_SOURCE]: table },
          ),
        );
      },
      by: freeze(
        Object.fromEntries(
          [...uniqueKeys].map(([name, columns]) => [
            name,
            (value: unknown) => uniqueLookup(columns, value),
          ]),
        ),
      ),
      byId,
      // async: a malformed key rejects like any other failure of the read.
      get: async (value: unknown, shape?: ShapeCallback) =>
        keyed(value, shape).one(),
      find: async (value: unknown, shape?: ShapeCallback) =>
        keyed(value, shape).maybeOne(),
      insert: (
        values: Record<string, unknown> | readonly Record<string, unknown>[],
      ) => createMutation("insert", root, values, executor, mutationOptions),
      upsert,
      update: (
        values:
          | Record<string, unknown>
          | ((row: RuntimeScope[string]) => Record<string, unknown>),
        options?: unknown,
      ) =>
        restricted(
          "update",
          createMutation("update", root, values, executor, mutationOptions),
          options,
        ),
      delete: (options?: unknown) =>
        restricted(
          "delete",
          createMutation("delete", root, {}, executor, mutationOptions),
          options,
        ),
    });
  };

  const handles = new Map<string, object>();

  return {
    table: (tableName) => {
      let handle = handles.get(tableName);

      if (!handle) {
        handle = createTable(registry.tablesByName.get(tableName)!);
        handles.set(tableName, handle);
      }

      return handle;
    },
    checkScope: (tableName) => {
      rootOf(tableName);
    },
  };
};
