/** createQueryTables(): one callable per table with lookups, shapes and mutations. */
import type { ColumnSnapshot, SchemaSnapshot } from "../../schema/assembly";
import { computedFields } from "../../schema/computed";
import type { SchemaCodecs } from "../codecs";
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
      const mutationOptions: MutationOptions = Object.freeze({
        ...(atomic ? { atomic } : {}),
        scope: registry.scopePredicates(root),
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
                scope: plan.predicates,
              });
            },
            delete(this: QueryHandle) {
              const plan = this[QUERY_STATE].plan;

              return createMutation("delete", plan.root, {}, executor, {
                ...mutationOptions,
                scope: plan.predicates,
              });
            },
          }),
        ),
      );

      /**
       * Key lookups build their plan directly instead of materializing a column
       * scope; scoped tables and computed fields still need the full scope.
       */
      const keyLookup = (
        keys: readonly ColumnSnapshot[],
        values: readonly unknown[],
      ): object => {
        const binding = Object.freeze({ ...root });

        if (registry.scopes[table.name] || computedFields.get(table)?.length) {
          const columns = createScope({ [binding.alias]: binding })[
            binding.alias
          ]!;

          return createQuery(
            Object.freeze({
              ...initialPlan(binding),
              predicates: Object.freeze([
                ...registry.scopePredicates(binding),
                ...keys.map((column, position) =>
                  readPredicate(
                    columns[column.name]!.is(values[position] as never),
                  ),
                ),
              ]),
              selection: Object.freeze(Object.values(columns).map(readColumn)),
            }),
            false,
            false,
            lookupPrototype,
          );
        }

        const columnNode = (column: ColumnSnapshot): ValueNode =>
          Object.freeze({
            kind: "column",
            description: Object.freeze({ binding, column }),
          });

        const predicates = keys.map(
          (column, position): PredicateDescription => {
            const right = valueNode(
              values[position],
              binding.codecs[column.name],
            );

            return Object.freeze({
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

          return Object.freeze({
            node: columnNode(column),
            outputName: column.name,
            ...(codec ? { codec } : {}),
          });
        });

        return createQuery(
          Object.freeze({
            ...initialPlan(binding),
            predicates: Object.freeze(predicates),
            selection: Object.freeze(selection),
          }),
          false,
          false,
          lookupPrototype,
        );
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

        const values = names.map((name) => {
          const selected =
            names.length === 1
              ? value
              : (value as Record<string, unknown>)[name];

          if (selected === null || selected === undefined) {
            throw new Error(
              `symmetria: unique key "${name}" cannot be null or undefined`,
            );
          }

          return selected;
        });

        return keyLookup(
          names.map(
            (name) => table.columns.find((column) => column.name === name)!,
          ),
          values,
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

            return Object.freeze(
              Object.assign(
                (columns: RuntimeScope[string], tools: unknown) =>
                  callback(columns, tools as Parameters<ShapeCallback>[1]),
                { [SHAPE_SOURCE]: table },
              ),
            );
          },
          by: Object.freeze(
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

            const values = keys.map((column) => {
              const selected =
                keys.length === 1
                  ? value
                  : (value as Record<string, unknown>)[column.name];

              if (selected === null || selected === undefined) {
                throw new Error(
                  `symmetria: primary key "${column.name}" cannot be null or undefined`,
                );
              }

              return selected;
            });

            return keyLookup(keys, values);
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
