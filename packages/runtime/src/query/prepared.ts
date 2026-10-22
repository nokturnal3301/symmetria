import { COLUMN_CODEC, isColumn, type Column } from "../schema/column";
import { codecFor, encodeValue, cloneParameter } from "./codecs";
import { compileQuery, executeCompiled } from "./compiler";
import {
  createExpression,
  NAMED_PARAMETER,
  type Parameter,
  type PlaceholderNode,
} from "./expressions";
import type {
  CompiledQuery,
  MutationPlan,
  QueryExecutor,
  SelectPlan,
} from "./state";

export const PREPARE_QUERY = Symbol("symmetria.query.prepare");
type ParameterValues<Definitions extends Record<string, Column>> = {
  [Name in keyof Definitions]: Definitions[Name] extends Column<infer Metadata>
    ? Metadata["valueType"] | (Metadata["notNull"] extends false ? null : never)
    : never;
};
export type PreparedQuery<
  Result,
  Values extends Record<string, unknown> = Record<never, never>,
> = {
  readonly toSQL: (
    ...argumentsList: keyof Values extends never ? [] : [values: Values]
  ) => CompiledQuery;
  readonly execute: (
    ...argumentsList: keyof Values extends never ? [] : [values: Values]
  ) => Promise<Result>;
};
export type Preparable<Result> = {
  readonly [PREPARE_QUERY]: (
    scope: object,
    names: readonly string[],
  ) => PreparedQuery<Result, Record<string, unknown>>;
  readonly execute: () => Promise<Result>;
};

/** Construct a query once; only encoded parameter values change between executions. */
export const prepare = <
  const Definitions extends Record<string, Column>,
  Result,
>(
  definitions: Definitions,
  factory: (
    parameters: {
      readonly [Name in keyof Definitions & string]: Parameter<
        ParameterValues<Definitions>[Name],
        Name
      >;
    },
  ) => Preparable<Result>,
): PreparedQuery<Result, ParameterValues<Definitions>> => {
  const scope = {};
  const parameters = Object.fromEntries(
    Object.entries(definitions).map(([name, column]) => {
      if (!name || !isColumn(column)) {
        throw new Error(
          "symmetria: prepared parameters require named column types",
        );
      }

      const codec = column[COLUMN_CODEC] ?? codecFor(column.definition.sqlType);
      const expression = createExpression({
        outputName: name,
        node: Object.freeze({
          kind: "placeholder",
          name,
          scope,
          nullable: !column.definition.notNull,
          sqlType: column.definition.sqlType,
          ...(codec ? { codec } : {}),
        }),
        ...(codec ? { codec } : {}),
      });

      return [
        name,
        Object.freeze(
          Object.defineProperty(Object.create(expression), NAMED_PARAMETER, {
            value: true,
          }),
        ),
      ];
    }),
  );
  const query = factory(
    Object.freeze(parameters) as unknown as Parameters<typeof factory>[0],
  );

  if (!query || !(PREPARE_QUERY in query)) {
    throw new Error("symmetria: prepare() expects a query or mutation");
  }

  return query[PREPARE_QUERY](scope, Object.keys(definitions)) as PreparedQuery<
    Result,
    ParameterValues<Definitions>
  >;
};

export const preparePlan = (
  plan: SelectPlan | MutationPlan,
  executor?: QueryExecutor,
  scope?: object,
  names: readonly string[] = [],
): PreparedQuery<unknown, Record<string, unknown>> => {
  const slots = new Set<unknown>();
  const compiled = compileQuery(plan, (node) => {
    if (node.scope !== scope) {
      throw new Error(
        `symmetria: parameter "${node.name}" belongs to another prepare() callback`,
      );
    }

    slots.add(node);

    return node;
  });

  const bind = (values: Record<string, unknown> = {}): CompiledQuery => {
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.keys(values).length !== names.length ||
      names.some((name) => !Object.hasOwn(values, name))
    ) {
      throw new Error(
        "symmetria: prepared query requires exactly its declared parameters",
      );
    }

    for (const name of names) {
      if (values[name] === undefined) {
        throw new Error(`symmetria: parameter "${name}" cannot be undefined`);
      }
    }

    return {
      sql: compiled.sql,
      parameters: compiled.parameters.map((value) => {
        if (!slots.has(value)) {
          return cloneParameter(value);
        }

        const node = value as PlaceholderNode;
        const bound = values[node.name];

        if (bound === null && !node.nullable) {
          throw new Error(`symmetria: parameter "${node.name}" cannot be null`);
        }

        if (
          node.count &&
          (typeof bound !== "number" ||
            !Number.isSafeInteger(bound) ||
            bound < 0)
        ) {
          throw new Error(
            `symmetria: parameter "${node.name}" must be a nonnegative safe integer`,
          );
        }

        return cloneParameter(encodeValue(bound, node.codec));
      }),
    };
  };

  return Object.freeze({
    toSQL: bind,
    execute: async (values: Record<string, unknown>) => {
      const result = await executeCompiled(plan, bind(values), executor);

      if (plan.kind === "select") {
        return result.rows;
      }

      if (!plan.selection.length) {
        return { affectedRows: result.affectedRows };
      }

      return plan.single ? (result.rows[0] ?? null) : result.rows;
    },
  });
};
