/** JOIN construction: relation JOINs, explicit sources and the local join helpers of a shape. */
import type { PredicateList } from "./types";
import {
  COLUMN_EXPRESSION,
  predicate,
  readColumn,
  readPredicate,
  type Predicate,
  type PredicateDescription,
  type SelectedColumn,
  type ValueNode,
} from "../expressions";
import {
  TABLE_SOURCE,
  numberedAlias,
  type JoinDescription,
  type SelectPlan,
  type TableBinding,
  type TableSource,
} from "../plan/types";
import { shapeExpressions } from "./projections";
import { createScope, validatePredicate } from "./scope";
import {
  CONDITION,
  conditionRelations,
  declaredConditions,
} from "../../schema/conditions";
import type { QueryContext, TableRegistry } from "./registry";
import {
  RELATION_SOURCE,
  type JoinReference,
  type RelationReference,
  type RuntimeScope,
} from "./types";

export const columnNode = (
  binding: TableBinding,
  name: string,
  sqlName = false,
): ValueNode => {
  const column = binding.table.columns.find(
    (candidate) => (sqlName ? candidate.sqlName : candidate.name) === name,
  );

  if (!column) {
    throw new Error(
      `symmetria: unknown join column "${binding.alias}.${name}"`,
    );
  }

  return Object.freeze({
    kind: "column",
    description: Object.freeze({ binding, column }),
  });
};

export const joinRelation = (
  registry: TableRegistry,
  state: SelectPlan,
  kind: "LEFT" | "INNER",
  from: string,
  relationName: string,
  alias: string,
  outerAliases: readonly string[] = [],
): SelectPlan => {
  if (
    state.joins.some((join) => join.binding.alias === alias) ||
    Object.hasOwn(state.bindings, alias)
  ) {
    throw new Error(`symmetria: duplicate query alias "${alias}"`);
  }

  const source = state.bindings[from];

  if (!source) {
    throw new Error(`symmetria: unknown query alias "${from}"`);
  }

  const relation = source.table.relations.find(
    (candidate) => candidate.name === relationName,
  );

  if (!relation) {
    throw new Error(
      `symmetria: unknown relation "${source.alias}.${relationName}"`,
    );
  }

  const target = registry.bindingFor(relation.target, alias);
  const joins = [...state.joins];

  const equals = (left: ValueNode, right: ValueNode): PredicateDescription =>
    Object.freeze({ kind: "comparison", left, operator: "=", right });

  const addJoin = (
    binding: TableBinding,
    comparison: PredicateDescription,
  ): void => {
    const scope = registry.scopePredicates(binding);

    joins.push(
      Object.freeze({
        kind,
        binding,
        ...(binding === target
          ? { relation: Object.freeze({ from: source, name: relationName }) }
          : {}),
        condition: scope.length
          ? Object.freeze({
              kind: "group",
              operator: "AND",
              predicates: Object.freeze([comparison, ...scope]),
            })
          : comparison,
      }),
    );
  };

  const reference = (
    foreignKey: ValueNode,
    binding: TableBinding,
  ): ValueNode => {
    if (
      foreignKey.kind !== "column" ||
      !foreignKey.description.column.references
    ) {
      throw new Error("symmetria: missing foreign key metadata");
    }

    return columnNode(
      binding,
      foreignKey.description.column.references.column,
      true,
    );
  };

  if (relation.kind === "condition") {
    // The declaring table's callbacks run again with this query's bindings, so
    // the predicate refers to the real source and target aliases.
    const declaring = relation.reverse === true ? target : source;
    const other = relation.reverse === true ? source : target;
    const name = relation.reverse === true ? relation.inverseOf : relation.name;
    const scope = createScope({
      [declaring.alias]: declaring,
      [other.alias]: other,
    });
    const declared = declaredConditions(
      conditionRelations.get(declaring.table) ?? [],
      scope[declaring.alias]!,
      declaring.table.name,
    );
    const entry = declared[name];

    if (!entry) {
      throw new Error(
        `symmetria: condition relation "${declaring.table.name}.${name}" is not declared by relations()`,
      );
    }

    const condition = readPredicate(
      entry[CONDITION].predicate(scope[other.alias]!),
    );
    validatePredicate(condition, {
      [source.alias]: source,
      [target.alias]: target,
    });
    addJoin(target, condition);
  } else if (relation.kind === "through") {
    const reservedAliases = new Set([
      ...outerAliases,
      ...Object.keys(state.bindings),
      ...joins.map((join) => join.binding.alias),
      alias,
      ...registry.snapshot.tables.flatMap((table) =>
        table.relations.map((relation) => relation.name),
      ),
    ]);
    let junctionNumber = 0;

    while (reservedAliases.has(`__symmetria_junction_${junctionNumber}`)) {
      junctionNumber += 1;
    }

    const junction = registry.bindingFor(
      relation.junction,
      `__symmetria_junction_${junctionNumber}`,
    );
    const sourceForeignKey = columnNode(junction, relation.sourceForeignKey);
    const targetForeignKey = columnNode(junction, relation.targetForeignKey);
    addJoin(
      junction,
      equals(reference(sourceForeignKey, source), sourceForeignKey),
    );
    addJoin(
      target,
      equals(targetForeignKey, reference(targetForeignKey, target)),
    );
  } else if (relation.reverse === true) {
    const foreignKey = columnNode(target, relation.foreignKey);
    addJoin(target, equals(reference(foreignKey, source), foreignKey));
  } else {
    const foreignKey = columnNode(source, relation.foreignKey);
    addJoin(target, equals(foreignKey, reference(foreignKey, target)));
  }

  return Object.freeze({
    ...state,
    joins: Object.freeze(joins),
    bindings: Object.freeze({ ...state.bindings, [alias]: target }),
  });
};

const joinSource = (
  registry: TableRegistry,
  state: SelectPlan,
  kind: "LEFT" | "INNER" | "CROSS",
  input: TableSource<Record<string, unknown>, string>,
  condition?: (scope: RuntimeScope) => Predicate,
  context?: QueryContext,
  occurrence?: TableBinding,
): SelectPlan => {
  if (input[TABLE_SOURCE].schema !== registry.snapshot) {
    throw new Error("symmetria: cannot join a table from another schema");
  }

  const source = occurrence ?? input[TABLE_SOURCE].binding;

  if (
    Object.hasOwn(state.bindings, source.alias) ||
    state.joins.some((join) => join.binding.alias === source.alias)
  ) {
    throw new Error(`symmetria: duplicate query alias "${source.alias}"`);
  }

  if (kind !== "CROSS" && !condition) {
    throw new Error("symmetria: an explicit join requires an ON callback");
  }

  const binding = Object.freeze({ ...source });
  const scope = registry.scopePredicates(binding);
  const joinCondition = condition
    ? readPredicate(
        condition(createScope({ ...state.bindings, [binding.alias]: binding })),
      )
    : undefined;
  // Reading an outer relation path inside ON can add dependency joins.
  const current = context?.plan ?? state;

  if (
    Object.hasOwn(current.bindings, source.alias) ||
    current.joins.some((join) => join.binding.alias === source.alias)
  ) {
    throw new Error(`symmetria: duplicate query alias "${source.alias}"`);
  }

  const bindings = Object.freeze({
    ...current.bindings,
    [binding.alias]: binding,
  });
  const description: JoinDescription = Object.freeze({
    kind,
    binding,
    ...(joinCondition
      ? {
          condition: scope.length
            ? Object.freeze({
                kind: "group" as const,
                operator: "AND" as const,
                predicates: Object.freeze([joinCondition, ...scope]),
              })
            : joinCondition,
        }
      : {}),
  });

  return Object.freeze({
    ...current,
    bindings,
    joins: Object.freeze([...current.joins, description]),
    predicates:
      joinCondition || !scope.length
        ? current.predicates
        : Object.freeze([...current.predicates, ...scope]),
  });
};

export type ShapeCallback = (
  columns: RuntimeScope[string],
  tools: typeof shapeExpressions & {
    join: LocalJoin;
    innerJoin: LocalJoin;
    leftJoin: LocalJoin;
    crossJoin: LocalJoin;
    whereNotNull: (column: SelectedColumn) => SelectedColumn;
  },
) => Record<string, unknown>;

export type LocalJoinInput =
  | JoinReference
  | TableSource<Record<string, unknown>, string>;
export type ShapePredicate = Predicate | PredicateList;
type LocalJoin = (
  input: LocalJoinInput,
  condition?: (columns: RuntimeScope[string]) => ShapePredicate,
) => RuntimeScope[string];

/** Reads one predicate or a list; `undefined`, `null` and `false` entries are skipped. */
export const readShapePredicates = (
  value: ShapePredicate,
): readonly PredicateDescription[] =>
  Object.freeze(
    (Array.isArray(value) ? value : [value])
      .filter(
        (entry): entry is Predicate =>
          entry !== undefined && entry !== null && entry !== false,
      )
      .map(readPredicate),
  );

const joinReference = (
  context: QueryContext,
  input: JoinReference,
): RelationReference[typeof RELATION_SOURCE] => {
  if (!input || (typeof input !== "object" && typeof input !== "function")) {
    throw new Error(
      "symmetria: JOIN requires a foreign-key column or an unfiltered relation",
    );
  }

  if (COLUMN_EXPRESSION in input) {
    const node = readColumn(input).node;

    if (node.kind !== "column" || !node.description.column.references) {
      throw new Error(
        "symmetria: JOIN requires a foreign-key column or an unfiltered relation",
      );
    }

    const { binding, column } = node.description;
    const relation = binding.table.relations.find(
      (relation) =>
        relation.kind === "one" &&
        !relation.reverse &&
        relation.foreignKey === column.name,
    );

    if (context.plan.bindings[binding.alias] !== binding || !relation) {
      throw new Error(
        "symmetria: JOIN foreign-key column belongs to another query scope",
      );
    }

    return {
      from: binding.alias,
      relation: relation.name,
      target: relation.target,
      alias: relation.name,
      owner: binding,
      nullable:
        !column.notNull ||
        context.plan.joins.some(
          (join) => join.binding === binding && join.kind === "LEFT",
        ),
    };
  }

  const relation = input?.[RELATION_SOURCE];

  if (!relation || context.plan.bindings[relation.from] !== relation.owner) {
    throw new Error(
      "symmetria: JOIN expects an unfiltered relation from its query scope",
    );
  }

  return relation;
};

const joinAlias = (
  context: QueryContext,
  preferred: string,
  explicit = false,
): string => {
  let alias = preferred;
  let ordinal = 2;

  while (
    Object.hasOwn(context.plan.bindings, alias) ||
    context.plan.joins.some((join) => join.binding.alias === alias) ||
    context.reservedAliases.has(alias)
  ) {
    if (explicit) {
      throw new Error(`symmetria: duplicate query alias "${preferred}"`);
    }

    alias = numberedAlias(preferred, ordinal++);
  }

  return alias;
};

export const localJoin = (
  context: QueryContext,
  kind: "LEFT" | "INNER" | "AUTO" | "CROSS",
  input: LocalJoinInput,
  condition?: (columns: RuntimeScope[string]) => ShapePredicate,
): RuntimeScope[string] => {
  if (!input || (typeof input !== "object" && typeof input !== "function")) {
    throw new Error(
      "symmetria: local JOIN expects a foreign-key column, relation or table source",
    );
  }

  if (TABLE_SOURCE in input) {
    if (kind === "AUTO" || (kind === "CROSS" && condition)) {
      throw new Error(
        "symmetria: join() requires a relation; crossJoin() accepts a source without ON",
      );
    }

    const source = input[TABLE_SOURCE].binding;

    if (!condition && (kind !== "CROSS" || source.explicitAlias)) {
      const matches = context.plan.joins.filter((join) =>
        source.explicitAlias
          ? join.binding.alias === source.alias
          : join.binding.table === source.table &&
            join.binding.derived === source.derived &&
            join.binding.cteReference?.identity ===
              source.cteReference?.identity,
      );

      if (matches.length === 1) {
        return context.columns(matches[0]!.binding);
      }

      if (matches.length > 1) {
        throw new Error(
          `symmetria: "${source.alias}" is joined more than once; name the JOIN with .as() to refer to it`,
        );
      }
    }

    const alias = joinAlias(context, source.alias, source.explicitAlias);
    context.reservedAliases.add(alias);

    try {
      context.plan = joinSource(
        context.registry,
        context.plan,
        kind,
        input,
        condition
          ? (scope) =>
              predicate({
                kind: "group",
                operator: "AND",
                predicates: readShapePredicates(condition(scope[alias]!)),
              })
          : undefined,
        context,
        Object.freeze({ ...source, alias }),
      );
    } finally {
      context.reservedAliases.delete(alias);
    }

    return context.columns(context.plan.bindings[alias]!);
  }

  const relation = joinReference(context, input);

  if (condition) {
    throw new Error(
      "symmetria: inferred JOIN sources do not take an ON callback",
    );
  }

  if (relation.explicitAlias) {
    const existing = context.plan.joins.find(
      (join) =>
        join.binding.alias === relation.alias &&
        join.relation?.from === relation.owner &&
        join.relation.name === relation.relation,
    );

    if (existing) {
      return context.columns(existing.binding);
    }
  }

  const alias = joinAlias(context, relation.alias, relation.explicitAlias);

  if (kind === "CROSS") {
    const joined = joinSource(context.registry, context.plan, kind, {
      [TABLE_SOURCE]: {
        binding: context.registry.bindingFor(relation.target, alias),
        schema: context.registry.snapshot,
      },
    });
    const last = joined.joins.at(-1)!;

    context.plan = Object.freeze({
      ...joined,
      joins: Object.freeze([
        ...joined.joins.slice(0, -1),
        Object.freeze({
          ...last,
          relation: Object.freeze({
            from: relation.owner,
            name: relation.relation,
          }),
        }),
      ]),
    });

    return context.columns(context.plan.bindings[alias]!);
  }

  context.plan = joinRelation(
    context.registry,
    context.plan,
    kind === "AUTO" ? (relation.nullable ? "LEFT" : "INNER") : kind,
    relation.from,
    relation.relation,
    alias,
    Object.keys(context.bindings()),
  );

  return context.columns(context.plan.bindings[alias]!);
};
