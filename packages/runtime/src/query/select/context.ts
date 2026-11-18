/** createContext(): column views with relation navigation, nested shapes, aggregates and quantifiers. */
import { freeze } from "../plan/freeze";
import type { TableSnapshot } from "../../schema/assembly";
import { isSilentMember, unknownMember } from "./suggest";

import { booleanCodec } from "../codecs";
import { quoteIdentifier } from "../compile";
import { derivedBinding } from "../plan/derived";
import {
  and,
  average,
  count,
  createExpression,
  maximum,
  minimum,
  predicate,
  readColumn,
  readPredicate,
  sum,
  type Decimal,
  type Predicate,
  type SelectedColumn,
} from "../expressions";
import { jsonRowCodec } from "../codecs/json";
import { queryOccurrence } from "../plan/occurrence";
import {
  mergeBindings,
  type SelectPlan,
  type TableBinding,
} from "../plan/types";
import {
  joinRelation,
  readShapePredicates,
  type ShapeCallback,
  type ShapePredicate,
} from "./joins";
import type { QueryContext, TableRegistry } from "./registry";
import {
  bindingScope,
  createScope,
  emptyBindings,
  evaluateContext,
  initialPlan,
  presentSelection,
  readSelection,
  shapeFrame,
} from "./scope";
import { applyShape } from "./shape";
import { RELATION_SOURCE, type RuntimeScope } from "./types";

const memberNameCache = new WeakMap<TableSnapshot, readonly string[]>();
const aggregatePrototypes = new WeakMap<TableSnapshot, object>();

type AggregateOperation = (
  column: SelectedColumn<number | bigint | Decimal | null>,
) => SelectedColumn;

type RelationMethods = Record<string | symbol, unknown> & {
  readonly aggregate: (operation: AggregateOperation) => object;
};

/** What builds the methods of a relation handle, and the methods once built. */
const relationMethods = new WeakMap<
  object,
  (() => RelationMethods) | RelationMethods
>();

const methodsOf = (handle: object): RelationMethods | undefined => {
  const methods = relationMethods.get(handle);

  if (typeof methods !== "function") {
    return methods;
  }

  const built = methods();
  relationMethods.set(handle, built);

  return built;
};

const ABSENT: PropertyDescriptor = Object.freeze({ value: undefined });

const relationMember = (name: string | symbol): PropertyDescriptor => ({
  get(this: object) {
    return methodsOf(this)?.[name];
  },
});

const relationAggregate = (
  name: string,
  operation: AggregateOperation,
): PropertyDescriptor => ({
  get(this: object) {
    const methods = methodsOf(this);

    return methods && (methods[name] ??= methods.aggregate(operation));
  },
});

/**
 * Relation handles live only inside one shape callback and most are only
 * called, so a handle is a bare function: its methods sit on this prototype
 * and are built when the first one is read.
 */
const relationHandle: object = Object.freeze(
  Object.create(Function.prototype, {
    [RELATION_SOURCE]: relationMember(RELATION_SOURCE),
    as: relationMember("as"),
    count: relationMember("count"),
    exists: relationMember("exists"),
    some: relationMember("some"),
    none: relationMember("none"),
    every: relationMember("every"),
    sum: relationAggregate("sum", sum as AggregateOperation),
    average: relationAggregate("average", average as AggregateOperation),
    minimum: relationAggregate("minimum", minimum as AggregateOperation),
    maximum: relationAggregate("maximum", maximum as AggregateOperation),
  }),
);

/** The methods of an unfiltered to-one relation handle; a column of the same name is reached inside a shape. */
const RELATION_METHODS: ReadonlySet<string> = new Set([
  "as",
  "count",
  "sum",
  "average",
  "minimum",
  "maximum",
  "exists",
  "some",
  "none",
  "every",
]);

export const createContext = (
  registry: TableRegistry,
  state: SelectPlan,
  ancestors: () => SelectPlan["bindings"] = shapeFrame.bindings ??
    emptyBindings,
  depth = shapeFrame.depth,
): QueryContext => {
  let previousOuter: SelectPlan["bindings"] | undefined;
  let previousLocal: SelectPlan["bindings"] | undefined;
  let merged: SelectPlan["bindings"];

  const context: QueryContext = {
    registry,
    plan: state,
    scope: () => {
      const bindings = Object.entries(state.bindings);

      if (bindings.length === 1) {
        const [name, binding] = bindings[0]!;

        return freeze({ [name]: columnsFor(binding) });
      }

      return freeze(
        Object.defineProperties(
          {},
          Object.fromEntries(
            bindings.map(([name, binding]) => [
              name,
              {
                enumerable: true,
                get: () => columnsFor(binding),
              },
            ]),
          ),
        ),
      ) as RuntimeScope;
    },
    columns: (binding) => columnsFor(binding),
    bindings: () => {
      const outer = ancestors();
      const local = context.plan.bindings;

      if (outer !== previousOuter || local !== previousLocal) {
        previousOuter = outer;
        previousLocal = local;
        merged = Object.keys(outer).length
          ? freeze(mergeBindings(outer, local))
          : local;
      }

      return merged;
    },
    reservedAliases: new Set(),
  };
  const views = new Map<TableBinding, RuntimeScope[string]>();

  const uniqueAlias = (prefix: string): string => {
    const bindings = context.bindings();

    let ordinal = 0;
    let alias: string;

    do {
      alias = `${prefix}${ordinal++}`;
    } while (
      Object.hasOwn(bindings, alias) ||
      context.reservedAliases.has(alias) ||
      context.plan.joins.some((join) => join.binding.alias === alias)
    );

    return alias;
  };

  /** Column and computed-field keys of a table, for membership checks and hints. */
  const memberNames = (table: TableSnapshot): readonly string[] => {
    let names = memberNameCache.get(table);

    if (!names) {
      const source = registry.bindingFor(table.name, table.name);
      names = freeze(
        Object.keys(createScope({ [source.alias]: source })[source.alias]!),
      );
      memberNameCache.set(table, names);
    }

    return names;
  };

  const columnsFor = (binding: TableBinding): RuntimeScope[string] => {
    const existing = views.get(binding);

    if (existing) {
      return existing;
    }

    const columns = bindingScope(binding, { [binding.alias]: binding });
    const relationships = new Map<string, object>();
    const view = new Proxy(columns, {
      get: (target, property) => {
        if (typeof property !== "string" || Object.hasOwn(target, property)) {
          return Reflect.get(target, property);
        }

        if (relationships.has(property)) {
          return relationships.get(property);
        }

        const relation = binding.table.relations.find(
          (relation) => relation.name === property,
        );

        if (!relation) {
          if (isSilentMember(property)) {
            return undefined;
          }

          throw unknownMember(binding.table, property, Object.keys(target));
        }

        const many =
          relation.kind === "many" ||
          relation.kind === "through" ||
          (relation.kind === "condition" && relation.many);
        const nullable =
          context.plan.joins.some(
            (join) => join.binding === binding && join.kind === "LEFT",
          ) ||
          relation.kind !== "one" ||
          relation.reverse === true ||
          relation.nullable ||
          // The scope may hide the row a required key points at; the row that
          // points at it stays, with the path's fields NULL.
          Object.hasOwn(registry.scopes, relation.target);
        let base: SelectPlan | undefined;
        let shaped = false;
        let related: TableBinding;

        const nestedPlan = (): SelectPlan => {
          if (base) {
            return base;
          }

          const alias = uniqueAlias("__symmetria_aggregate_");
          const joined = joinRelation(
            registry,
            initialPlan(binding),
            "INNER",
            binding.alias,
            property,
            alias,
            Object.keys(context.bindings()),
          );

          const first = joined.joins[0]!;
          related = joined.bindings[alias]!;

          base = freeze({
            ...initialPlan(first.binding),
            bindings: freeze(
              Object.fromEntries(
                joined.joins.map((join) => [join.binding.alias, join.binding]),
              ),
            ),
            joins: freeze(joined.joins.slice(1)),
            // first.condition already carries the related table's scope from addJoin.
            predicates: freeze([first.condition!]),
          });

          return base;
        };

        const pathColumns = (
          selectedAlias: string,
          customAlias: boolean,
        ): RuntimeScope[string] => {
          const previous = context.plan.joins.find(
            (join) =>
              join.relation?.from === binding &&
              join.relation.name === property &&
              (!customAlias || join.binding.alias === selectedAlias),
          );

          if (previous) {
            return columnsFor(previous.binding);
          }

          // A later outer callback may add paths after this subquery has been built.
          const alias = customAlias
            ? selectedAlias
            : uniqueAlias(
                depth ? `__symmetria_path_${depth}_` : "__symmetria_path_",
              );
          context.plan = joinRelation(
            registry,
            context.plan,
            nullable ? "LEFT" : "INNER",
            binding.alias,
            property,
            alias,
          );

          return columnsFor(context.plan.bindings[alias]!);
        };

        const build = (
          plan?: SelectPlan,
          selectedAlias = property,
          filtered = false,
          customAlias = false,
        ): object => {
          const current = () => plan ?? nestedPlan();

          const evaluate = <Result>(
            callback: (columns: RuntimeScope[string]) => Result,
          ) => {
            const nested = createContext(
              registry,
              current(),
              context.bindings,
              depth + 1,
            );
            const result = evaluateContext(nested, () =>
              callback(nested.columns(nested.plan.bindings[related.alias]!)),
            );

            return { nested, result };
          };

          const quantified = (
            mode: "some" | "none" | "every",
            callback?: (columns: RuntimeScope[string]) => ShapePredicate,
          ): Predicate => {
            let query = current();

            if (query.limit !== undefined || query.offset !== undefined) {
              throw new Error(
                "symmetria: relation quantifiers must precede limit()/offset()",
              );
            }

            if (mode === "every" && !callback) {
              throw new Error("symmetria: every() requires a predicate");
            }

            if (callback) {
              const { nested, result } = evaluate(callback);
              // A list is its predicates joined by AND, as in `where`.
              const conditions =
                mode === "every"
                  ? [
                      {
                        kind: "notTrue" as const,
                        predicate: readPredicate(
                          Array.isArray(result)
                            ? and(...result)
                            : (result as Predicate),
                        ),
                      },
                    ]
                  : readShapePredicates(result);
              query = freeze({
                ...nested.plan,
                predicates: freeze([...nested.plan.predicates, ...conditions]),
              });
            }

            return predicate({
              kind: "exists",
              query: freeze({
                ...query,
                ordering: freeze([]),
                selection: presentSelection,
              }),
              negated: mode !== "some",
            });
          };

          const aggregate = (
            operation: (
              column: SelectedColumn<number | bigint | Decimal | null>,
            ) => SelectedColumn,
            callback: (columns: RuntimeScope[string]) => SelectedColumn,
          ) => {
            const { nested, result } = evaluate(callback);
            const expression = readColumn(result);
            const query = nested.plan;
            const wrapped =
              query.limit !== undefined ||
              query.offset !== undefined ||
              query.grouping.length > 0 ||
              query.distinct;

            const source = wrapped
              ? derivedBinding(
                  freeze({
                    ...query,
                    selection: freeze([{ ...expression, outputName: "value" }]),
                  }),
                  "__symmetria_aggregate",
                )
              : undefined;

            const selected = readColumn(
              operation(
                (source
                  ? createScope({ [source.alias]: source })[source.alias]!
                      .value!
                  : result) as SelectedColumn<number | bigint | Decimal | null>,
              ),
            );

            return createExpression({
              ...selected,
              node: freeze({
                kind: "subquery",
                query: freeze({
                  ...(source ? initialPlan(source) : query),
                  ordering: freeze([]),
                  selection: freeze([selected]),
                }),
              }),
            });
          };

          const aggregateMethod = (
            invoke: (
              callback: Parameters<typeof aggregate>[1],
            ) => SelectedColumn,
          ) => {
            const target = registry.tablesByName.get(relation.target)!;
            let prototype = aggregatePrototypes.get(target);

            if (!prototype) {
              const source = registry.bindingFor(target.name, target.name);
              const names = Object.keys(
                createScope({ [source.alias]: source })[source.alias]!,
              );
              prototype = Object.freeze(
                Object.create(
                  Function.prototype,
                  Object.fromEntries(
                    names.map((name) => [
                      name,
                      {
                        get(this: typeof invoke) {
                          return this((columns) => columns[name]!);
                        },
                      },
                    ]),
                  ),
                ),
              ) as object;
              aggregatePrototypes.set(target, prototype);
            }

            Object.setPrototypeOf(invoke, prototype);

            for (const name of ["name", "length"]) {
              const descriptor = Object.getOwnPropertyDescriptor(
                prototype,
                name,
              );

              if (descriptor) {
                Object.defineProperty(invoke, name, descriptor);
              }
            }

            return invoke;
          };

          const createMethods = () => {
            const handle = (
              callback: ShapeCallback | Record<string, unknown>,
              options?: Record<string, unknown>,
            ) => {
              // The first shape reads the relation's own sources; a second one
              // in the same callback needs sources of its own.
              const occurrence = shaped
                ? queryOccurrence(current())
                : current();
              shaped = true;
              const nested = createContext(
                registry,
                occurrence,
                context.bindings,
                depth + 1,
              );
              const query = applyShape(
                nested,
                occurrence.bindings[related.alias]!,
                callback,
                options,
              );

              if (!query.selection.length) {
                return build(query, selectedAlias, true);
              }

              return createExpression({
                outputName: selectedAlias,
                node: freeze({ kind: "jsonRows", query, many }),
                codec: jsonRowCodec(query.selection, many),
              });
            };

            // `name` and `length` answer as a missing column would, not as a function does.
            Object.defineProperty(handle, "name", ABSENT);
            Object.defineProperty(handle, "length", ABSENT);
            relationMethods.set(
              Object.setPrototypeOf(handle, relationHandle),
              (): RelationMethods => ({
                ...(!filtered
                  ? {
                      [RELATION_SOURCE]: freeze({
                        from: binding.alias,
                        relation: property,
                        target: relation.target,
                        alias: selectedAlias,
                        owner: binding,
                        nullable,
                        explicitAlias: customAlias,
                      }),
                      as: (alias: string) => {
                        quoteIdentifier(alias);

                        return build(plan, alias, false, true);
                      },
                    }
                  : {}),
                count: () => {
                  const query = current();
                  const counted =
                    query.limit !== undefined ||
                    query.offset !== undefined ||
                    query.grouping.length > 0 ||
                    query.having.length > 0 ||
                    query.distinct;

                  return createExpression({
                    ...readColumn(count()),
                    node: freeze({
                      kind: counted ? "rowCount" : "subquery",
                      query: freeze({
                        ...query,
                        ...(counted ? {} : { ordering: freeze([]) }),
                        selection: counted
                          ? query.distinct
                            ? query.grouping.length
                              ? query.grouping
                              : readSelection(
                                  createScope({
                                    [query.root.alias]: query.root,
                                  })[query.root.alias]!,
                                  query.bindings,
                                )
                            : presentSelection
                          : freeze([readColumn(count())]),
                      }),
                    }),
                  });
                },
                exists: () =>
                  createExpression({
                    outputName: "exists",
                    codec: booleanCodec,
                    node: freeze({
                      kind: "raw",
                      sqlType: "boolean",
                      parts: freeze([
                        "EXISTS ",
                        {
                          kind: "subquery" as const,
                          query: freeze({
                            ...current(),
                            selection: presentSelection,
                          }),
                        },
                      ]),
                    }),
                  }),
                some: (
                  callback?: (columns: RuntimeScope[string]) => Predicate,
                ) => quantified("some", callback),
                none: (
                  callback?: (columns: RuntimeScope[string]) => Predicate,
                ) => quantified("none", callback),
                every: (
                  callback: (columns: RuntimeScope[string]) => Predicate,
                ) => quantified("every", callback),
                // sum, average, minimum and maximum are built when first read.
                aggregate: (operation: AggregateOperation) =>
                  aggregateMethod((callback) => aggregate(operation, callback)),
              }),
            );

            return handle;
          };

          if (filtered || many) {
            return createMethods();
          }

          // A to-one relation is mostly read as a path (`post.author.name`),
          // which needs none of the methods: they are built when one is asked
          // for or the relation is called.
          let methods: object | undefined;
          const materialized = (): object => (methods ??= createMethods());

          return new Proxy((() => {}) as object, {
            apply: (_target, _receiver, argumentsList) =>
              Reflect.apply(
                materialized() as (...values: unknown[]) => unknown,
                undefined,
                argumentsList,
              ),
            has: (_target, name) => Reflect.has(materialized(), name),
            get: (target, name) => {
              if (typeof name !== "string") {
                return name === RELATION_SOURCE
                  ? Reflect.get(materialized(), name)
                  : Reflect.get(target, name);
              }

              if (RELATION_METHODS.has(name)) {
                return Reflect.get(materialized(), name);
              }

              const table = registry.tablesByName.get(relation.target)!;
              const members = memberNames(table);

              if (
                !members.includes(name) &&
                !table.relations.some((relation) => relation.name === name)
              ) {
                if (isSilentMember(name)) {
                  return undefined;
                }

                // Checked before pathColumns(), which would add the JOIN for a typo.
                throw unknownMember(table, name, members);
              }

              return pathColumns(selectedAlias, customAlias)[name];
            },
          });
        };

        const result = build();
        relationships.set(property, result);

        return result;
      },
    });
    views.set(binding, view);

    return view;
  };

  return context;
};
