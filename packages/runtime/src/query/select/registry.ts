/** Per-schema table registry: snapshots, codecs and $scope() predicates for bindings. */
import { freeze } from "../plan/freeze";
import type { SchemaSnapshot, TableSnapshot } from "../../schema/assembly";
import { codecFor, codecMap, type SchemaCodecs } from "../codecs";
import { collectDataErrors } from "../codecs/deferred";
import { quoteIdentifier } from "../compile";
import {
  readPredicate,
  type Predicate,
  type PredicateDescription,
  type ScopePredicate,
} from "../expressions";
import type { SelectPlan, TableBinding } from "../plan/types";
import { EMPTY, createScope, initialPlan } from "./scope";
import { columnsOnly } from "./suggest";
import type { RuntimeScope } from "./types";

export type TableScopes = Readonly<
  Record<string, (columns: RuntimeScope[string]) => Predicate>
>;

export type TableRegistry = {
  readonly snapshot: SchemaSnapshot;
  readonly tablesByName: ReadonlyMap<string, TableSnapshot>;
  readonly scopes: TableScopes;
  readonly bindingFor: (tableName: string, alias: string) => TableBinding;
  readonly scopePredicates: (
    binding: TableBinding,
  ) => readonly PredicateDescription[];
  readonly scopedPlan: (binding: TableBinding) => SelectPlan;
};

/** State of one shape callback: the plan it builds, its column views and merged bindings. */
export type QueryContext = {
  readonly registry: TableRegistry;
  plan: SelectPlan;
  scope: () => RuntimeScope;
  columns: (binding: TableBinding) => RuntimeScope[string];
  bindings: () => SelectPlan["bindings"];
  reservedAliases: Set<string>;
};

export const createTableRegistry = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs = {},
  scopes: TableScopes = {},
): TableRegistry => {
  const tablesByName = new Map(
    snapshot.tables.map((table) => [table.name, table]),
  );
  const tableCodecs = new Map<string, TableBinding["codecs"]>();
  // One evaluator per table, so equal scope filters compare as equal.
  const evaluators = new Map<string, ScopePredicate["evaluate"]>();

  /**
   * $scope() predicates apply wherever a scoped table enters a plan. Callbacks
   * may read changing values (a tenant id): they run when a query is built,
   * which fixes the SQL, and again at every execution, which binds the values
   * current then (see the compiler's scope refresh).
   */
  const scopePredicates = (
    binding: TableBinding,
  ): readonly PredicateDescription[] => {
    const scope = scopes[binding.table.name];

    if (!scope) {
      return EMPTY;
    }

    let evaluate = evaluators.get(binding.table.name);

    if (!evaluate) {
      evaluate = (occurrence: TableBinding) =>
        readPredicate(
          scope(
            columnsOnly(
              occurrence.table,
              createScope({ [occurrence.alias]: occurrence })[
                occurrence.alias
              ]!,
              "$scope() predicates",
            ),
          ),
        );
      evaluators.set(binding.table.name, evaluate);
    }

    return [
      freeze({
        kind: "scope",
        binding,
        evaluate,
        // A value the codecs reject now fails each execution, which runs the
        // callback again; the build only needs the predicate's SQL.
        predicate: collectDataErrors(() => evaluate(binding), false)[0],
      }),
    ];
  };

  const scopedPlan = (binding: TableBinding): SelectPlan => {
    const plan = initialPlan(binding);
    const predicates = scopePredicates(binding);

    return predicates.length
      ? freeze({ ...plan, predicates: freeze(predicates) })
      : plan;
  };

  const bindingFor = (tableName: string, alias: string): TableBinding => {
    quoteIdentifier(alias);
    const table = tablesByName.get(tableName);

    if (!table) {
      throw new Error(`symmetria: unknown table "${tableName}"`);
    }

    let resolvedCodecs = tableCodecs.get(tableName);

    if (!resolvedCodecs) {
      resolvedCodecs = freeze(
        codecMap(
          Object.fromEntries(
            table.columns.flatMap((column) => {
              const codec =
                codecs[tableName]?.[column.name] ?? codecFor(column.sqlType);

              return codec ? [[column.name, codec]] : [];
            }),
          ),
        ),
      );
      tableCodecs.set(tableName, resolvedCodecs);
    }

    return freeze({
      table,
      alias,
      codecs: resolvedCodecs,
    });
  };

  return Object.freeze({
    snapshot,
    tablesByName,
    scopes,
    bindingFor,
    scopePredicates,
    scopedPlan,
  });
};
