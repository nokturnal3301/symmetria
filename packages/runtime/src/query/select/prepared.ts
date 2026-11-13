/**
 * `prepare()`: named-parameter queries compiled once and executed with typed values.
 */
import { freeze } from "../plan/freeze";
import {
  COLUMN_CODEC,
  isColumn,
  type Column,
  type ColumnInputType,
  type IsDecimalText,
  type MetadataTraits,
  type Vector,
} from "../../schema/column";
import { codecFor, encodeValue, cloneParameter } from "../codecs";
import { throwDataErrors } from "../codecs/deferred";
import {
  compileTemplate,
  currentScopes,
  executeCompiled,
  type CompiledStatement,
} from "../compile";
import {
  createExpression,
  NAMED_PARAMETER,
  type Parameter,
  type PlaceholderNode,
} from "../expressions";
import type {
  CompiledQuery,
  MutationPlan,
  QueryExecutor,
  SelectPlan,
} from "../plan/types";
import type {
  InspectQueryOptions,
  QueryInspection,
} from "../../observability/inspection";
import { limitedPlan } from "./scope";
import {
  countPlan,
  existsPlan,
  readCount,
  readExists,
  rowCountError,
} from "./terminal";

export const PREPARE_QUERY = Symbol("symmetria.query.prepare");
/** The value a parameter handle stands for inside the query. */
type ParameterTypes<Definitions extends Record<string, Column>> = {
  [Name in keyof Definitions]: Definitions[Name] extends Column<infer Metadata>
    ? Metadata["valueType"] | (Metadata["notNull"] extends false ? null : never)
    : never;
};
/** How a parameter computes and compares, like a column of its type. */
type ParameterTraits<Definition> =
  Definition extends Column<infer Metadata> ? MetadataTraits<Metadata> : {};
/** What a parameter stores: a jsonb(schema)'s input, otherwise its value type. */
type ParameterInputs<Definitions extends Record<string, Column>> = {
  [Name in keyof Definitions]: Definitions[Name] extends Column<infer Metadata>
    ?
        | ColumnInputType<Metadata>
        | (Metadata["notNull"] extends false ? null : never)
    : never;
};
/**
 * Values passed at execution, encoded like writes: vectors accept plain number
 * arrays, decimals any string and a jsonb(schema) its input.
 */
type ParameterValues<Definitions extends Record<string, Column>> = {
  [Name in keyof Definitions]: NonNullable<
    ParameterInputs<Definitions>[Name]
  > extends Vector
    ? ParameterInputs<Definitions>[Name] | readonly number[]
    : IsDecimalText<
          NonNullable<ParameterInputs<Definitions>[Name]>
        > extends true
      ? ParameterInputs<Definitions>[Name] | string
      : ParameterInputs<Definitions>[Name];
};
type PreparedArguments<Values> = keyof Values extends never
  ? []
  : [values: Values];
/** SELECT preparables keep the query terminals; mutations only execute. */
export type PreparedKind = "select" | "mutation";
export type PreparedQuery<
  Result,
  Values extends Record<string, unknown> = Record<never, never>,
  Kind extends PreparedKind = "select",
> = {
  (...argumentsList: PreparedArguments<Values>): Promise<Result>;
  readonly toSQL: (
    ...argumentsList: PreparedArguments<Values>
  ) => CompiledQuery;
  readonly execute: (
    ...argumentsList: PreparedArguments<Values>
  ) => Promise<Result>;
} & (Kind extends "select"
  ? Result extends readonly (infer Row extends Record<string, unknown>)[]
    ? {
        readonly one: (
          ...argumentsList: PreparedArguments<Values>
        ) => Promise<Row>;
        readonly maybeOne: (
          ...argumentsList: PreparedArguments<Values>
        ) => Promise<Row | null>;
        readonly first: (
          ...argumentsList: PreparedArguments<Values>
        ) => Promise<Row | null>;
        readonly count: (
          ...argumentsList: PreparedArguments<Values>
        ) => Promise<number>;
        readonly exists: (
          ...argumentsList: PreparedArguments<Values>
        ) => Promise<boolean>;
        readonly inspect: (
          ...argumentsList: [
            ...PreparedArguments<Values>,
            options?: InspectQueryOptions,
          ]
        ) => Promise<QueryInspection<Row>>;
      }
    : {}
  : {});
declare const PREPARED_KIND: unique symbol;
export type Preparable<Result, Kind extends PreparedKind = "select"> = {
  readonly [PREPARE_QUERY]: (
    scope: object,
    names: readonly string[],
  ) => PreparedQuery<Result, Record<string, unknown>, Kind>;
  readonly execute: () => Promise<Result>;
  /** Type-only marker so prepare() infers which terminals the result offers. */
  readonly [PREPARED_KIND]?: Kind;
};

/** Construct a query once; only encoded parameter values change between executions. */
export const prepare = <
  const Definitions extends Record<string, Column>,
  Result,
  Kind extends PreparedKind = "select",
>(
  definitions: Definitions,
  factory: (
    parameters: {
      readonly [Name in keyof Definitions & string]: Parameter<
        ParameterTypes<Definitions>[Name],
        Name,
        ParameterTraits<Definitions[Name]>
      >;
    },
  ) => Preparable<Result, Kind>,
): PreparedQuery<Result, ParameterValues<Definitions>, Kind> => {
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
        node: freeze({
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
        freeze(
          Object.defineProperty(Object.create(expression), NAMED_PARAMETER, {
            value: true,
          }),
        ),
      ];
    }),
  );
  const query = factory(
    freeze(parameters) as unknown as Parameters<typeof factory>[0],
  );

  if (!query || !(PREPARE_QUERY in query)) {
    throw new Error("symmetria: prepare() expects a query or mutation");
  }

  return query[PREPARE_QUERY](
    scope,
    Object.keys(definitions),
  ) as unknown as PreparedQuery<Result, ParameterValues<Definitions>, Kind>;
};

export const preparePlan = (
  plan: SelectPlan | MutationPlan,
  executor?: QueryExecutor,
  scope?: object,
  names: readonly string[] = [],
  run?: (compile: (plan: MutationPlan) => CompiledQuery) => Promise<unknown>,
): PreparedQuery<unknown, Record<string, unknown>, PreparedKind> => {
  const slots = new Set<unknown>();

  const placeholder = (node: PlaceholderNode) => {
    if (node.scope !== scope) {
      throw new Error(
        `symmetria: parameter "${node.name}" belongs to another prepare() callback`,
      );
    }

    slots.add(node);

    return node;
  };

  const templates = new WeakMap<SelectPlan | MutationPlan, CompiledStatement>();

  const template = (state: SelectPlan | MutationPlan): CompiledStatement => {
    let compiled = templates.get(state);

    if (!compiled) {
      compiled = compileTemplate(state, placeholder);
      templates.set(state, compiled);
    }

    return compiled;
  };

  const primary =
    plan.kind !== "insert" || plan.values.length ? template(plan) : undefined;

  const validate = (values: Record<string, unknown>) => {
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
  };

  const bindValues = (
    state: SelectPlan | MutationPlan,
    values: Record<string, unknown>,
  ): CompiledQuery => {
    const statement = state === plan && primary ? primary : template(state);
    // $scope() filters bind the values current at this execution.
    const compiled = statement.scopes
      ? currentScopes(
          state,
          statement,
          statement.parameters.slice(),
          placeholder,
        )
      : statement;

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

        return cloneParameter(
          encodeValue(
            node.cap === undefined
              ? bound
              : Math.min(bound as number, node.cap),
            node.codec,
          ),
        );
      }),
    };
  };

  const bind = (
    state: SelectPlan | MutationPlan,
    values: Record<string, unknown>,
  ): CompiledQuery =>
    // Values bound at execution fail it, even when bound inside a builder.
    throwDataErrors(() => bindValues(state, values));

  const execute = async (values: Record<string, unknown> = {}) => {
    validate(values);

    if (run) {
      return run((state) => bind(state, values));
    }

    const result = await executeCompiled(plan, bind(plan, values), executor);

    if (plan.kind === "select") {
      return result.rows;
    }

    if (!plan.selection.length) {
      return { affectedRows: result.affectedRows };
    }

    return plan.single ? (result.rows[0] ?? null) : result.rows;
  };

  const toSQL = (values: Record<string, unknown> = {}) => {
    validate(values);

    return bind(plan, values);
  };

  if (plan.kind !== "select" || run) {
    return Object.freeze(Object.assign(execute, { execute, toSQL }));
  }

  // SELECT terminals: every derived plan is compiled once with the placeholders.
  const rowsOf = async (
    state: SelectPlan,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    validate(values);

    return (await executeCompiled(state, bind(state, values), executor)).rows;
  };
  // A parameterized root LIMIT keeps its SQL and binds min(value, cap), so a
  // LIMIT of 1 still reads at most one row and one() never sees a false second.
  const capped: (SelectPlan | undefined)[] = [];
  const limited = (limit: 1 | 2): SelectPlan =>
    typeof plan.limit === "object"
      ? (capped[limit] ??= freeze({
          ...plan,
          limit: freeze({ ...plan.limit, cap: limit }),
        }))
      : limitedPlan(plan, limit);
  const single = async (
    values: Record<string, unknown>,
    required: boolean,
  ): Promise<Record<string, unknown> | null> => {
    const rows = await rowsOf(limited(2), values);

    if (rows.length > 1 || (required && !rows.length)) {
      throw rowCountError(plan, rows.length, required);
    }

    return rows[0] ?? null;
  };

  return Object.freeze(
    Object.assign(execute, {
      execute,
      toSQL,
      one: (values: Record<string, unknown> = {}) => single(values, true),
      maybeOne: (values: Record<string, unknown> = {}) => single(values, false),
      first: async (values: Record<string, unknown> = {}) =>
        (await rowsOf(limited(1), values))[0] ?? null,
      count: async (values: Record<string, unknown> = {}) =>
        readCount(await rowsOf(countPlan(plan), values)),
      exists: async (values: Record<string, unknown> = {}) =>
        readExists(await rowsOf(existsPlan(plan, true), values)),
      inspect: async (...argumentsList: unknown[]) => {
        // Without parameters the first argument is the options object.
        const [values, options] = names.length
          ? [argumentsList[0] as Record<string, unknown>, argumentsList[1]]
          : [{}, argumentsList[0]];
        validate(values ?? {});

        return (await import("../../observability/inspection")).inspectQuery(
          plan,
          executor,
          options as InspectQueryOptions | undefined,
          bind(plan, values ?? {}),
        );
      },
    }),
  );
};
