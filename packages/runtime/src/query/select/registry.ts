/** Per-schema table registry: snapshots, codecs and $scope() predicates for bindings. */
import { freeze } from "../plan/freeze";
import {
  uniqueColumnIndexes,
  type SchemaSnapshot,
  type TableSnapshot,
} from "../../schema/assembly";
import { codecFor, codecMap, type SchemaCodecs } from "../codecs";
import { collectDataErrors } from "../codecs/deferred";
import { quoteIdentifier } from "../compile";
import {
  and,
  readPredicate,
  type Predicate,
  type PredicateDescription,
  type ScopePredicate,
} from "../expressions";
import type {
  SelectPlan,
  SourceDescription,
  TableBinding,
} from "../plan/types";
import { truth } from "../write/mutations";
import { EMPTY, createScope, initialPlan } from "./scope";
import { columnsOnly } from "./suggest";
import type { RuntimeScope } from "./types";

type TableScope = (columns: RuntimeScope[string]) => Predicate;

/** Scopes by table name; without a prototype, so a table named `toString` has none. */
export type TableScopes = Readonly<Record<string, TableScope>>;

export const NO_SCOPES: TableScopes = Object.freeze(Object.create(null));

/** The callbacks a scope narrowed by `$scope()` again ANDs, in order. */
const scopeParts = new WeakMap<TableScope, readonly TableScope[]>();

const partsOf = (scope: TableScope): readonly TableScope[] =>
  scopeParts.get(scope) ?? [scope];

/** `previous` narrowed by `added`, as `$scope()` on a scoped database does. */
export const narrowedScope = (
  previous: TableScope,
  added: TableScope,
): TableScope => {
  const narrowed: TableScope = (columns) =>
    and(previous(columns), added(columns));

  scopeParts.set(narrowed, [...partsOf(previous), ...partsOf(added)]);

  return narrowed;
};

/** Whether `outer` already ANDs every callback of `inner`, so `inner` adds nothing to it. */
export const coversScope = (outer: TableScope, inner: TableScope): boolean => {
  const parts = partsOf(outer);

  return partsOf(inner).every((part) => parts.includes(part));
};

/**
 * A `$scope()` filter that holds for every row, such as `and()` of
 * conditions that were all skipped (`tenant && …` without a tenant), would
 * read and write every tenant's rows: it fails closed. An emptied list is a
 * condition here: `notIn(blocked)` with nobody blocked, or `contains(required)`
 * with nothing required, admits the rows it asks for.
 */
export const restrictingScope = (
  predicate: PredicateDescription,
  binding: TableBinding,
): PredicateDescription => {
  if (truth(predicate, binding, { scope: true }) === true) {
    throw new Error(
      `symmetria: the $scope() filter of "${binding.table.name}" holds for every row, so it restricts nothing (such as and() or a list whose conditions were all skipped, like \`tenant && …\` without a tenant, isNot(null) of a NOT NULL column, or a condition together with its opposite); nothing is read or written through it`,
    );
  }

  return predicate;
};

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

/** A join source with the registry, and so the `$scope()`, of the database it came from. */
export type ScopedSource = SourceDescription & {
  readonly registry?: TableRegistry;
};

/**
 * What the query tables need from the schema alone. Built once per schema:
 * every bound database (each transaction, each `$scope()`) shares it.
 */
export type SchemaTables = {
  readonly snapshot: SchemaSnapshot;
  readonly tablesByName: ReadonlyMap<string, TableSnapshot>;
  /** A table's codecs by column name, resolved on first use. */
  readonly codecsFor: (table: TableSnapshot) => TableBinding["codecs"];
  /** `by` lookups per table: a unique column or index name and its columns. */
  readonly uniqueKeys: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >;
};

export const createSchemaTables = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs = {},
): SchemaTables => {
  const tableCodecs = new Map<string, TableBinding["codecs"]>();

  const codecsFor = (table: TableSnapshot): TableBinding["codecs"] => {
    let resolved = tableCodecs.get(table.name);

    if (!resolved) {
      resolved = freeze(
        codecMap(
          Object.fromEntries(
            table.columns.flatMap((column) => {
              const codec =
                codecs[table.name]?.[column.name] ?? codecFor(column.sqlType);

              return codec ? [[column.name, codec]] : [];
            }),
          ),
        ),
      );
      tableCodecs.set(table.name, resolved);
    }

    return resolved;
  };

  // Resolved up front, so a duplicate lookup name fails schema() itself.
  const uniqueKeys = new Map(
    snapshot.tables.map((table) => {
      const keys = new Map<string, readonly string[]>(
        table.columns
          .filter((column) => column.unique)
          .map((column) => [column.name, [column.name]]),
      );

      for (const { name, columns } of uniqueColumnIndexes(table)) {
        if (keys.has(name)) {
          throw new Error(
            `symmetria: duplicate unique lookup "${table.name}.${name}"`,
          );
        }

        keys.set(
          name,
          columns.map((column) => column.name),
        );
      }

      return [table.name, keys];
    }),
  );

  return Object.freeze({
    snapshot,
    tablesByName: new Map(snapshot.tables.map((table) => [table.name, table])),
    codecsFor,
    uniqueKeys,
  });
};

/** State of one shape callback: the plan it builds, its column views and merged bindings. */
export type QueryContext = {
  readonly registry: TableRegistry;
  plan: SelectPlan;
  scope: () => RuntimeScope;
  columns: (binding: TableBinding) => RuntimeScope[string];
  bindings: () => SelectPlan["bindings"];
  reservedAliases: Set<string>;
  /**
   * While option callbacks run: a relation joined without a name reaches the
   * JOIN the projection made of it, where in the projection each call is a
   * JOIN of its own.
   */
  options?: boolean;
};

export const createTableRegistry = (
  { snapshot, tablesByName, codecsFor }: SchemaTables,
  scopes: TableScopes = NO_SCOPES,
): TableRegistry => {
  // One evaluator per table, so equal scope filters compare as equal.
  const evaluators = new Map<string, ScopePredicate["evaluate"]>();

  const scopeResult = (
    scope: TableScope,
    occurrence: TableBinding,
  ): PredicateDescription =>
    readPredicate(
      scope(
        columnsOnly(
          occurrence.table,
          createScope({ [occurrence.alias]: occurrence })[occurrence.alias]!,
          "$scope() predicates",
        ),
      ),
    );

  /**
   * $scope() predicates apply wherever a scoped table enters a plan. Callbacks
   * may read changing values (a tenant id): they run when a query is built,
   * which fixes the SQL, and again at every execution, which binds the values
   * current then (see the compiler's scope refresh). A result that holds for
   * every row fails that execution.
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
        restrictingScope(scopeResult(scope, occurrence), occurrence);
      evaluators.set(binding.table.name, evaluate);
    }

    return [
      freeze({
        kind: "scope",
        binding,
        evaluate,
        // The build only needs the predicate's SQL: a value the codecs
        // reject while the query is built fails each execution instead,
        // which runs the callback again, and a result that admits every row
        // at build time is refused when the query runs.
        predicate: collectDataErrors(
          () => scopeResult(scope, binding),
          false,
        )[0],
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

    return freeze({
      table,
      alias,
      codecs: codecsFor(table),
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
