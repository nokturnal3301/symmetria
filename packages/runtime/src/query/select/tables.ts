/** createQueryTables(): one callable per table with lookups, shapes and mutations. */
import { freeze } from "../plan/freeze";
import type { ColumnSnapshot, SchemaSnapshot } from "../../schema/assembly";
import { computedFields } from "../../schema/computed";
import type { SchemaCodecs } from "../codecs";
import { collectDataErrors, dataError } from "../codecs/deferred";
import { quoteIdentifier } from "../compile";
import {
  readColumn,
  readPredicate,
  valueNode,
  type ExpressionDescription,
  type PredicateDescription,
  type ValueNode,
} from "../expressions";
import {
  createMutation,
  type AtomicRunner,
  type MutationOptions,
} from "../write/mutations";
import { SHAPE_SOURCE } from "./projections";
import type { QueryExecutor, SelectPlan, ConnectionHold } from "../plan/types";
import { executorProfiling } from "../../observability/profiling";
import { boundMethodDescriptors, extendBuilder } from "../expressions/callable";
import { createContext } from "./context";
import type { ShapeCallback } from "./joins";
import { createQueryFactory } from "./query";
import { createTableRegistry, type TableScopes } from "./registry";
import {
  QUERY_STATE,
  createScope,
  initialPlan,
  type QueryHandle,
  shapeFrame,
} from "./scope";
import type { RuntimeScope } from "./types";

export type { TableScopes } from "./registry";

export const createQueryTables = (
  snapshot: SchemaSnapshot,
  executor?: QueryExecutor,
  codecs: SchemaCodecs = {},
  scopes: TableScopes = {},
  atomic?: AtomicRunner,
  hold?: ConnectionHold,
): Record<string, object> => {
  const profile = executorProfiling(executor);
  const registry = createTableRegistry(snapshot, codecs, scopes);
  const { createQuery, queryPrototype } = createQueryFactory(
    registry,
    executor,
    profile,
    hold,
  );

  return Object.fromEntries(
    snapshot.tables.map((table) => {
      const root = registry.bindingFor(table.name, table.name);
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
            ) {
              const plan = this[QUERY_STATE].plan;

              return createMutation("update", plan.root, values, executor, {
                ...mutationOptions,
                scope: () => plan.predicates,
                ...(plan.failure ? { failure: plan.failure } : {}),
              });
            },
            delete(this: QueryHandle) {
              const plan = this[QUERY_STATE].plan;

              return createMutation("delete", plan.root, {}, executor, {
                ...mutationOptions,
                scope: () => plan.predicates,
                ...(plan.failure ? { failure: plan.failure } : {}),
              });
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

        const predicates = keys.map(
          (column, position): PredicateDescription => {
            const right = valueNode(
              values[position],
              binding.codecs[column.name],
            );

            return freeze({
              kind: "comparison",
              left: columnNode(column),
              operator: "=",
              right,
              ...(right.kind === "placeholder" && right.nullable
                ? { nullableParameter: true as const }
                : {}),
            });
          },
        );
        const selection = table.columns.map((column): ExpressionDescription => {
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
            names.length === 1
              ? value
              : (value as Record<string, unknown>)[name],
          ),
        );
      };

      const uniqueKeys = new Map(
        table.columns
          .filter((column) => column.unique)
          .map((column) => [column.name, [column.name]]),
      );

      for (const definition of table.indexes ?? []) {
        if (!definition.unique || definition.where) {
          continue;
        }

        const columns = definition.keys.map(
          (key) =>
            table.columns.find(
              (column) => quoteIdentifier(column.sqlName) === key,
            )?.name,
        );

        if (columns.every((name) => name !== undefined)) {
          if (uniqueKeys.has(definition.name)) {
            throw new Error(
              `symmetria: duplicate unique lookup "${table.name}.${definition.name}"`,
            );
          }

          uniqueKeys.set(definition.name, columns);
        }
      }

      return [
        table.name,
        extendBuilder(createQuery(registry.scopedPlan(root), true, true), {
          shape: (callback: ShapeCallback) => {
            if (typeof callback !== "function") {
              throw new Error(
                "symmetria: shape() requires a synchronous callback",
              );
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
          byId: (value: unknown) => {
            const keys = table.primaryKey
              ? table.primaryKey.map(
                  (name) =>
                    table.columns.find((column) => column.sqlName === name)!,
                )
              : table.columns.filter((column) => column.primaryKey);

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
          },
          insert: (
            values:
              | Record<string, unknown>
              | readonly Record<string, unknown>[],
          ) =>
            createMutation("insert", root, values, executor, mutationOptions),
          update: (
            values:
              | Record<string, unknown>
              | ((row: RuntimeScope[string]) => Record<string, unknown>),
          ) =>
            createMutation("update", root, values, executor, mutationOptions),
          delete: () =>
            createMutation("delete", root, {}, executor, mutationOptions),
        }),
      ];
    }),
  );
};
