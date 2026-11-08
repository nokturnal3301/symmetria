/**
 * Condition relations: `table({...}).relations((post, { to }) => ({
 *   author: to(users).one((user) => post.authorName.is(user.name)),
 * }))` declares a relation by a join predicate instead of a foreign key.
 * Only the relation's name, target and cardinality enter the snapshot. The
 * callbacks stay here, outside serializable snapshots, and run again for every
 * JOIN with the query's own bindings (the same side channel as computed fields).
 */
import type { Predicate } from "../query/expressions";
import type { RuntimeScope } from "../query/select";
import type { TableSnapshot } from "./assembly";

export const CONDITION: unique symbol = Symbol("symmetria.relation.condition");

/** A relation declared inside `.relations()`, before schema() resolves its target. */
export type ConditionState = {
  /** A table, a thunk returning one, a plain column record or a keyed schema link. */
  readonly target: unknown;
  readonly many: boolean;
  readonly inverse?: string;
  readonly predicate: (target: RuntimeScope[string]) => Predicate;
};

export type ConditionDeclaration = {
  readonly [CONDITION]: ConditionState;
  readonly inverse: (name: string) => ConditionDeclaration;
};

type ConditionBuilder = {
  readonly one: (
    predicate: ConditionState["predicate"],
  ) => ConditionDeclaration;
  readonly many: (
    predicate: ConditionState["predicate"],
  ) => ConditionDeclaration;
};

export type RuntimeRelationTools = {
  readonly to: (target: unknown) => ConditionBuilder;
};

export type TableRelationCallback = (
  columns: RuntimeScope[string],
  tools: RuntimeRelationTools,
) => Record<string, ConditionDeclaration>;

const declaration = (state: ConditionState): ConditionDeclaration =>
  Object.freeze({
    [CONDITION]: Object.freeze(state),
    inverse: (name: string) => {
      if (typeof name !== "string" || !name) {
        throw new Error("symmetria: inverse() expects a relation name");
      }

      return declaration({ ...state, inverse: name });
    },
  });

export const relationTools: RuntimeRelationTools = Object.freeze({
  to: (target: unknown): ConditionBuilder => {
    if (target === null || target === undefined) {
      throw new Error(
        "symmetria: to() expects a table, a thunk returning one or a schema reference",
      );
    }

    const build =
      (many: boolean) =>
      (predicate: ConditionState["predicate"]): ConditionDeclaration => {
        if (typeof predicate !== "function") {
          throw new Error(
            `symmetria: ${many ? "many" : "one"}() expects a predicate callback`,
          );
        }

        return declaration({ target, many, predicate });
      };

    return Object.freeze({ one: build(false), many: build(true) });
  },
});

export const isConditionDeclaration = (
  value: unknown,
): value is ConditionDeclaration =>
  typeof value === "object" && value !== null && CONDITION in value;

/** Relation callbacks per table snapshot; they never enter the snapshot itself. */
export const conditionRelations = new WeakMap<
  TableSnapshot,
  readonly TableRelationCallback[]
>();

/** Runs a table's relation callbacks against a scope and collects the declarations by name. */
export const declaredConditions = (
  callbacks: readonly TableRelationCallback[],
  columns: RuntimeScope[string],
  tableName: string,
): Record<string, ConditionDeclaration> => {
  const result: Record<string, ConditionDeclaration> = {};

  for (const callback of callbacks) {
    const declared = callback(columns, relationTools);

    if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
      throw new Error(
        `symmetria: relations() of "${tableName}" must return an object of to(...) declarations`,
      );
    }

    for (const [name, entry] of Object.entries(declared)) {
      if (!isConditionDeclaration(entry)) {
        throw new Error(
          `symmetria: relation "${tableName}.${name}" must be declared with to(<table>).one(...) or to(<table>).many(...)`,
        );
      }

      if (Object.hasOwn(result, name)) {
        throw new Error(
          `symmetria: relation "${tableName}.${name}" is declared twice in relations()`,
        );
      }

      result[name] = entry;
    }
  }

  return result;
};
