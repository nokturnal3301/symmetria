/**
 * Nested inserts: writes a parent row and its related rows in one transaction, resolving generated keys.
 */
import { freeze } from "../plan/freeze";
import { cloneParameter, type SchemaCodecs } from "../codecs";
import { collectDataErrors } from "../codecs/deferred";
import { quoteIdentifier } from "../compile";
import {
  and,
  COLUMN_EXPRESSION,
  readColumn,
  createExpression,
  valueNode,
  type Predicate,
} from "../expressions";
import type { Projection, RuntimeScope } from "../select";
import type { SchemaSnapshot, TableSnapshot } from "../../schema/assembly";
import { returningProjection } from "../select/projections";

type RuntimeQuery = {
  (
    shape: (columns: RuntimeScope[string]) => Record<string, unknown>,
    options?: {
      readonly where?: (columns: RuntimeScope[string]) => Predicate;
      readonly limit?: number;
    },
  ): RuntimeQuery;
  execute: () => Promise<Record<string, unknown>[]>;
};

type RuntimeMutation = {
  returning: (
    selector: (row: RuntimeScope[string]) => Projection,
  ) => RuntimeMutation;
  where: (
    predicate: (row: RuntimeScope[string]) => Predicate,
  ) => RuntimeMutation;
  onConflict: (...names: string[]) => {
    doNothing: () => RuntimeMutation;
    doUpdate: (...names: string[]) => RuntimeMutation;
  };
  /** Single-object inserts resolve to one row; updates resolve to arrays. */
  execute: () => Promise<Record<string, unknown>>;
};

type RuntimeDatabase = Record<string, unknown>;
type RunTransaction = <Result>(
  callback: (database: RuntimeDatabase) => Promise<Result>,
) => Promise<Result>;
type Selector = (row: RuntimeScope[string]) => Projection;

const uniqueKeys = (table: TableSnapshot): string[][] => {
  const primary = table.columns
    .filter((column) => column.primaryKey)
    .map((column) => column.name);

  const keys = primary.length ? [primary] : [];

  keys.push(
    ...table.columns
      .filter((column) => column.unique)
      .map((column) => [column.name]),
  );

  for (const definition of table.indexes ?? []) {
    if (!definition.unique || definition.where) {
      continue;
    }

    const names = definition.keys.map(
      (key) =>
        table.columns.find((column) => quoteIdentifier(column.sqlName) === key)
          ?.name,
    );

    if (names.every((name) => name !== undefined)) {
      keys.push(names);
    }
  }

  return keys;
};

const copyInput = (value: unknown, ancestors = new Set<object>()): unknown => {
  if (!value || typeof value !== "object" || COLUMN_EXPRESSION in value) {
    return value;
  }

  if (
    value instanceof Date ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    return cloneParameter(value);
  }

  if (ancestors.has(value)) {
    throw new Error("symmetria: cyclic nested insert input");
  }

  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => copyInput(entry, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          copyInput(entry, ancestors),
        ]),
      );
  ancestors.delete(value);

  return freeze(result);
};

/** Write payloads treat `undefined` as an omitted field or operation. */
const definedEntries = (value: object): [string, unknown][] =>
  Object.entries(value).filter(([, entry]) => entry !== undefined);

/** Relational inserts are multi-statement operations and execute atomically. */
/** Condition relations have no foreign key, so nested writes cannot target them. */
const conditionWrite = (table: string, field: string): Error =>
  new Error(
    `symmetria: "${table}.${field}" is a condition relation; it has no foreign key to write`,
  );

export const createNestedInsert = (
  snapshot: SchemaSnapshot,
  tableName: string,
  input: Record<string, unknown> | readonly Record<string, unknown>[],
  transaction: RunTransaction,
  codecs: SchemaCodecs,
): object => {
  const tableByName = new Map(
    snapshot.tables.map((table) => [table.name, table]),
  );

  // Capture encoded scalar values before cloning the graph, including custom
  // class instances whose prototypes/private state structuredClone cannot retain.
  const scalar = (name: string, column: string, value: unknown): unknown => {
    const codec = codecs[name]?.[column];

    if (
      !codec ||
      value === null ||
      value === undefined ||
      typeof value === "symbol"
    ) {
      return copyInput(value);
    }

    return createExpression({
      outputName: column,
      node: valueNode(value, codec),
    });
  };

  /** The target column a foreign key points at, by TypeScript name. */
  const referencedName = (
    sourceName: string,
    foreignKey: string,
    targetName: string,
  ): string => {
    const column = tableByName
      .get(sourceName)!
      .columns.find((entry) => entry.name === foreignKey);
    const target = tableByName
      .get(targetName)!
      .columns.find((entry) => entry.sqlName === column?.references?.column);

    if (!target) {
      throw new Error(
        `symmetria: missing foreign key metadata for "${sourceName}.${foreignKey}"`,
      );
    }

    return target.name;
  };

  /**
   * The column a scalar connect value names: the referenced column of a forward
   * reference or of the junction's target key; children of reverse relations
   * connect by their primary key.
   */
  const scalarKey = (
    sourceName: string,
    relation: TableSnapshot["relations"][number],
  ): string | undefined =>
    relation.kind === "through"
      ? referencedName(
          relation.junction,
          relation.targetForeignKey,
          relation.target,
        )
      : relation.kind === "one" && !relation.reverse
        ? referencedName(sourceName, relation.foreignKey, relation.target)
        : undefined;

  const connect = (
    name: string,
    value: unknown,
    scalarColumn?: string,
  ): unknown => {
    const table = tableByName.get(name)!;

    if (
      value &&
      typeof value === "object" &&
      !(COLUMN_EXPRESSION in value) &&
      uniqueKeys(table).some(
        (key) =>
          key.length === definedEntries(value).length &&
          key.every(
            (column) =>
              (value as Record<string, unknown>)[column] !== undefined,
          ),
      )
    ) {
      return Object.fromEntries(
        definedEntries(value).map(([column, entry]) => [
          column,
          scalar(name, column, entry),
        ]),
      );
    }

    const primary = table.columns.filter((column) => column.primaryKey);

    if (scalarColumn !== undefined) {
      return scalar(name, scalarColumn, value);
    }

    return primary.length === 1
      ? scalar(name, primary[0]!.name, value)
      : copyInput(value);
  };

  const ancestors = new Set<object>();

  const capture = (name: string, value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return copyInput(value);
    }

    if (ancestors.has(value)) {
      throw new Error("symmetria: cyclic nested insert input");
    }

    ancestors.add(value);
    const table = tableByName.get(name)!;
    const result = Object.fromEntries(
      definedEntries(value).map(([field, entry]) => {
        const relation = table.relations.find(
          (relation) => relation.name === field,
        );

        if (relation?.kind === "condition") {
          throw conditionWrite(name, field);
        }

        if (
          !relation ||
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry)
        ) {
          return [field, scalar(name, field, entry)];
        }

        const operations = Object.fromEntries(
          definedEntries(entry).map(([operation, payload]) => {
            const target = (row: unknown) =>
              operation === "connect"
                ? connect(relation.target, row, scalarKey(name, relation))
                : capture(relation.target, row);

            return [
              operation,
              relation.kind === "one" || !Array.isArray(payload)
                ? target(payload)
                : payload.map(target),
            ];
          }),
        );

        return [field, operations];
      }),
    );
    ancestors.delete(value);

    return freeze(result);
  };

  // A value the codecs reject fails the insert when it runs.
  const [values, failure] = collectDataErrors(
    () =>
      (Array.isArray(input) ? input : [input]).map((row) =>
        capture(tableName, row),
      ) as readonly Record<string, unknown>[],
  );

  const build = (selector?: Selector): object => {
    const execute = () =>
      transaction(async (database) => {
        const mutate = (
          name: string,
          kind: "insert" | "update",
          data: Record<string, unknown>,
        ) => {
          // Use the transaction's table methods so codecs and transaction lifetime checks remain intact.
          const table = database[name] as Record<
            string,
            (value: Record<string, unknown>) => RuntimeMutation
          >;

          return table[kind]!(data);
        };

        const find = async (
          name: string,
          selection: unknown,
          scalarColumn?: string,
        ): Promise<Record<string, unknown>> => {
          const table = tableByName.get(name)!;
          const primary = table.columns.filter((column) => column.primaryKey);
          const fields =
            selection !== null &&
            typeof selection === "object" &&
            !(COLUMN_EXPRESSION in selection) &&
            !Array.isArray(selection)
              ? (selection as Record<string, unknown>)
              : scalarColumn !== undefined
                ? { [scalarColumn]: selection }
                : primary.length === 1
                  ? { [primary[0]!.name]: selection }
                  : {};
          const names = Object.keys(fields);

          if (
            !uniqueKeys(table).some(
              (key) =>
                key.length === names.length &&
                key.every((column) => names.includes(column)),
            ) ||
            names.some(
              (column) =>
                fields[column] === null || fields[column] === undefined,
            )
          ) {
            throw new Error(
              `symmetria: connect on "${name}" requires a complete non-null unique key`,
            );
          }

          const rows = await (database[name] as RuntimeQuery)(
            (columns) => ({
              ...columns,
            }),
            {
              where: (columns) =>
                and(
                  ...names.map((column) =>
                    columns[column]!.is(fields[column]!),
                  ),
                ),
              limit: 2,
            },
          ).execute();

          if (rows.length !== 1) {
            throw Object.assign(
              new Error(
                `symmetria: connect on "${name}" expected one existing row`,
              ),
              { code: "SYMMETRIA_RECORD_NOT_FOUND" },
            );
          }

          return rows[0]!;
        };

        const attach = async (
          name: string,
          row: Record<string, unknown>,
          foreignKey: string,
          value: unknown,
        ) => {
          const primary = tableByName
            .get(name)!
            .columns.filter((column) => column.primaryKey);

          if (!primary.length) {
            throw new Error(
              `symmetria: connect on "${name}" requires a primary key`,
            );
          }

          await mutate(name, "update", { [foreignKey]: value })
            .where((rowColumns) =>
              and(
                ...primary.map((column) =>
                  rowColumns[column.name]!.is(row[column.name]!),
                ),
              ),
            )
            .execute();
        };

        const insertRow = async (
          name: string,
          data: Record<string, unknown>,
          returning?: Selector,
        ): Promise<{
          row: Record<string, unknown>;
          result?: Record<string, unknown>;
        }> => {
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("symmetria: nested create requires a row object");
          }

          const table = tableByName.get(name)!;
          const scalars: Record<string, unknown> = Object.create(null);
          const relations: [
            Exclude<TableSnapshot["relations"][number], { kind: "condition" }>,
            Record<string, unknown>,
          ][] = [];

          for (const [field, value] of Object.entries(data)) {
            const relation = table.relations.find(
              (entry) => entry.name === field,
            );

            if (!relation) {
              scalars[field] = value;
              continue;
            }

            if (relation.kind === "condition") {
              throw conditionWrite(name, field);
            }

            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).some(
                (operation) =>
                  !["connect", "create", "connectOrCreate"].includes(operation),
              )
            ) {
              throw new Error(
                `symmetria: invalid nested operation "${name}.${field}"`,
              );
            }

            const operations = value as Record<string, unknown>;

            if (
              relation.kind === "one" &&
              Object.keys(operations).length !== 1
            ) {
              throw new Error(
                `symmetria: "${name}.${field}" requires exactly one nested operation`,
              );
            }

            relations.push([relation, operations]);
          }

          const resolveRow = async (
            target: string,
            operation: string,
            value: unknown,
            extra: Record<string, unknown> = {},
            scalarColumn?: string,
          ) => {
            if (operation === "connect") {
              return find(target, value, scalarColumn);
            }

            if (!value || typeof value !== "object" || Array.isArray(value)) {
              throw new Error(`symmetria: ${operation} requires a row object`);
            }

            if (
              Object.keys(extra).some((field) => Object.hasOwn(value, field))
            ) {
              throw new Error(
                "symmetria: nested reverse create cannot supply its parent foreign key",
              );
            }

            const payload = { ...value, ...extra };

            if (operation === "create") {
              return (await insertRow(target, payload)).row;
            }

            const key = uniqueKeys(tableByName.get(target)!).find((names) =>
              names.every(
                (field) =>
                  payload[field] !== null && payload[field] !== undefined,
              ),
            );

            if (!key) {
              throw new Error(
                `symmetria: connectOrCreate on "${target}" requires a non-null unique key`,
              );
            }

            // Under $scope() the upsert throws SYMMETRIA_OUT_OF_SCOPE when the
            // existing row lies outside the scope, so nothing links to it; like
            // every row of a nested insert, the upserted row is checked too.
            return mutate(target, "insert", payload)
              .onConflict(...key)
              .doUpdate(...key)
              .returning((row) => row)
              .execute();
          };

          for (const [relation, operations] of relations) {
            if (relation.kind !== "one" || relation.reverse) {
              continue;
            }

            if (Object.hasOwn(data, relation.foreignKey)) {
              throw new Error(
                `symmetria: supply either "${relation.name}" or "${relation.foreignKey}"`,
              );
            }

            const [operation, value] = Object.entries(operations)[0]!;
            const referenced = referencedName(
              name,
              relation.foreignKey,
              relation.target,
            );
            const row = await resolveRow(
              relation.target,
              operation,
              value,
              {},
              referenced,
            );
            scalars[relation.foreignKey] = row[referenced];
          }

          // Returning both shapes in the INSERT avoids a second lookup and works for keyless roots.
          const mutation = mutate(name, "insert", scalars).returning((row) => {
            const selection = returning
              ? returningProjection(returning, row, table)
              : undefined;
            const result = Array.isArray(selection)
              ? Object.fromEntries(
                  selection.map((column) => [
                    readColumn(column).outputName,
                    column,
                  ]),
                )
              : selection;

            return {
              row,
              ...(result ? { result } : {}),
            } as Projection;
          });
          const inserted = await mutation.execute();
          const row = inserted.row as Record<string, unknown>;

          for (const [relation, operations] of relations) {
            if (relation.kind === "one" && !relation.reverse) {
              continue;
            }

            // The parent value the child foreign key stores: the primary key or a by() column.
            const parentKey =
              row[
                relation.kind === "through"
                  ? referencedName(
                      relation.junction,
                      relation.sourceForeignKey,
                      name,
                    )
                  : referencedName(relation.target, relation.foreignKey, name)
              ];

            for (const [operation, value] of Object.entries(operations)) {
              const entries = relation.kind === "one" ? [value] : value;

              if (!Array.isArray(entries)) {
                throw new Error(
                  `symmetria: collection "${name}.${relation.name}" requires arrays`,
                );
              }

              for (const entry of entries) {
                const extra =
                  relation.kind === "through"
                    ? {}
                    : { [relation.foreignKey]: parentKey };
                const target = await resolveRow(
                  relation.target,
                  operation,
                  entry,
                  operation === "connect" ? {} : extra,
                  scalarKey(name, relation),
                );

                if (relation.kind === "through") {
                  await mutate(relation.junction, "insert", {
                    [relation.sourceForeignKey]: parentKey,
                    [relation.targetForeignKey]:
                      target[
                        referencedName(
                          relation.junction,
                          relation.targetForeignKey,
                          relation.target,
                        )
                      ],
                  })
                    .onConflict(
                      relation.sourceForeignKey,
                      relation.targetForeignKey,
                    )
                    .doNothing()
                    .execute();
                } else if (operation !== "create") {
                  await attach(
                    relation.target,
                    target,
                    relation.foreignKey,
                    parentKey,
                  );
                }
              }
            }
          }

          return {
            row,
            ...(returning
              ? { result: inserted!.result as Record<string, unknown> }
              : {}),
          };
        };

        const results: Record<string, unknown>[] = [];

        for (const value of values) {
          const inserted = await insertRow(tableName, value, selector);

          if (selector) {
            results.push(inserted.result!);
          }
        }

        if (!selector) {
          return { affectedRows: values.length };
        }

        return Array.isArray(input) ? results : results[0];
      });

    const run = () => (failure ? Promise.reject(failure.error) : execute());

    return freeze({
      returning: (next: Selector) => build(next),
      execute: run,
      then: (
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) => run().then(onFulfilled, onRejected),
    });
  };

  return build();
};
