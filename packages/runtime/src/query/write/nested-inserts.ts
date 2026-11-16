/**
 * Nested inserts: writes a parent row and its related rows in one transaction, resolving generated keys.
 */
import { freeze } from "../plan/freeze";
import { NotFoundError } from "../../errors";
import { encodeValue, type SchemaCodecs } from "../codecs";
import { collectDataErrors } from "../codecs/deferred";
import { and, readColumn, type Predicate } from "../expressions";
import type { Projection, RuntimeScope } from "../select";
import {
  primaryKeyColumns,
  type SchemaSnapshot,
  type TableSnapshot,
} from "../../schema/assembly";
import { plainRecord } from "../select/shape";
import { returningProjection, returningSelector } from "../select/projections";
import { conditionWrite, nestedInput, uniqueKeys } from "./nested-input";

type RuntimeQuery = {
  (
    shape: (columns: RuntimeScope[string]) => Record<string, unknown>,
    options?: {
      readonly where?: (columns: RuntimeScope[string]) => Predicate;
      readonly limit?: number;
      readonly orderBy?: never;
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

export const createNestedInsert = (
  snapshot: SchemaSnapshot,
  tableName: string,
  input: Record<string, unknown> | readonly Record<string, unknown>[],
  transaction: RunTransaction,
  codecs: SchemaCodecs,
): object => {
  const {
    tableByName,
    referencedName,
    scalarKey,
    capture,
    lookupFields,
    lookupKey,
    connected,
  } = nestedInput(snapshot, tableName, codecs);

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
          data: Record<string, unknown> | readonly Record<string, unknown>[],
        ) => {
          // Use the transaction's table methods so codecs and transaction lifetime checks remain intact.
          const table = database[name] as Record<
            string,
            (
              value:
                | Record<string, unknown>
                | readonly Record<string, unknown>[],
            ) => RuntimeMutation
          >;

          return table[kind]!(data);
        };

        // Rows that several connects name, read once per table and column.
        // A row that is not here (created by this insert, or spelled
        // differently from how PostgreSQL returns it) is still looked up
        // by itself.
        const found = new Map<string, Map<string, Map<string, unknown>>>();

        for (const [name, columns] of connected(values)) {
          for (const [column, keys] of columns) {
            if (
              keys.size < 2 ||
              !uniqueKeys(tableByName.get(name)!).some(
                (key) => key.length === 1 && key[0] === column,
              )
            ) {
              continue;
            }

            const rows = await (database[name] as RuntimeQuery)(
              (scope) => ({ ...scope }),
              {
                where: (scope) =>
                  scope[column]!.in([...keys.values()] as never),
              },
            ).execute();
            const byKey = new Map<string, unknown>();

            for (const row of rows) {
              const key = lookupKey(
                encodeValue(row[column], codecs[name]?.[column]),
              );

              if (key !== undefined) {
                byKey.set(key, row);
              }
            }

            let cached = found.get(name);

            if (!cached) {
              found.set(name, (cached = new Map()));
            }

            cached.set(column, byKey);
          }
        }

        const find = async (
          name: string,
          selection: unknown,
          scalarColumn?: string,
        ): Promise<Record<string, unknown>> => {
          const table = tableByName.get(name)!;
          const fields = lookupFields(name, selection, scalarColumn);
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

          if (names.length === 1) {
            const key = lookupKey(fields[names[0]!]);
            const cached =
              key === undefined
                ? undefined
                : found.get(name)?.get(names[0]!)?.get(key);

            if (cached) {
              return cached as Record<string, unknown>;
            }
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
            throw new NotFoundError(
              `symmetria: connect on "${name}" expected one existing row`,
              name,
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
          const primary = primaryKeyColumns(tableByName.get(name)!);

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

        /** The fields `returning()` asked for, as an object of expressions. */
        const resultOf = (
          returning: Selector,
          row: RuntimeScope[string],
          table: TableSnapshot,
        ): Projection => {
          const selection = returningProjection(returning, row, table);

          return Array.isArray(selection)
            ? Object.fromEntries(
                selection.map((column) => [
                  readColumn(column).outputName,
                  column,
                ]),
              )
            : selection;
        };

        type WritableRelation = Exclude<
          TableSnapshot["relations"][number],
          { kind: "condition" }
        >;
        type RowParts = {
          /** Column values, to which resolved foreign keys are added. */
          readonly scalars: Record<string, unknown>;
          readonly relations: [WritableRelation, Record<string, unknown>][];
        };

        /** A row's own values apart from its nested operations, validated. */
        const split = (
          name: string,
          data: Record<string, unknown>,
        ): RowParts => {
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("symmetria: nested create requires a row object");
          }

          const table = tableByName.get(name)!;
          const scalars: Record<string, unknown> = Object.create(null);
          const relations: RowParts["relations"] = [];

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

          return { scalars, relations };
        };

        /**
         * True when the row's only nested operations connect rows it
         * references: it writes nothing but itself, so it can share a
         * multi-row INSERT with its neighbours.
         */
        const connectsOnly = ({ relations }: RowParts): boolean =>
          relations.every(
            ([relation, operations]) =>
              relation.kind === "one" &&
              !relation.reverse &&
              Object.hasOwn(operations, "connect"),
          );

        type ResolveRow = (
          target: string,
          operation: string,
          value: unknown,
          extra?: Record<string, unknown>,
          scalarColumn?: string,
        ) => Promise<Record<string, unknown>>;

        /** Resolves the rows a row references and stores their keys in its foreign-key columns. */
        const forwards = async (
          name: string,
          data: Record<string, unknown>,
          { scalars, relations }: RowParts,
          resolveRow: ResolveRow,
        ): Promise<void> => {
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
        };

        const insertRow = async (
          name: string,
          data: Record<string, unknown>,
          returning?: Selector,
        ): Promise<{
          row: Record<string, unknown>;
          result?: Record<string, unknown>;
        }> => {
          const table = tableByName.get(name)!;
          const { scalars, relations } = split(name, data);

          /** The row a create or connectOrCreate writes: its values and the parent's key. */
          const payloadOf = (
            operation: string,
            value: unknown,
            extra: Record<string, unknown>,
          ): Record<string, unknown> => {
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

            return { ...value, ...extra };
          };

          /** The unique key a connectOrCreate payload is looked up and upserted by. */
          const upsertKey = (
            target: string,
            payload: Record<string, unknown>,
          ): readonly string[] | undefined =>
            uniqueKeys(tableByName.get(target)!).find((names) =>
              names.every(
                (field) =>
                  payload[field] !== null && payload[field] !== undefined,
              ),
            );

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

            const payload = payloadOf(operation, value, extra);

            if (operation === "create") {
              return (await insertRow(target, payload)).row;
            }

            const key = upsertKey(target, payload);

            if (!key) {
              throw new Error(
                `symmetria: connectOrCreate on "${target}" requires a non-null unique key`,
              );
            }

            // A row that is already there is only read. The upsert below
            // locks the row it meets until the transaction ends, and two
            // inserts naming the same rows in opposite orders would then wait
            // on each other until PostgreSQL aborts one as a deadlock.
            const read =
              key.length === 1
                ? found
                    .get(target)
                    ?.get(key[0]!)
                    ?.get(lookupKey(payload[key[0]!]) as never)
                : undefined;

            if (read) {
              return read as Record<string, unknown>;
            }

            const [existing] = await (database[target] as RuntimeQuery)(
              (columns) => ({ ...columns }),
              {
                where: (columns) =>
                  and(
                    ...key.map((field) => columns[field]!.is(payload[field]!)),
                  ),
                limit: 1,
              },
            ).execute();

            if (existing) {
              return existing as Record<string, unknown>;
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

          await forwards(name, data, { scalars, relations }, resolveRow);

          // Returning both shapes in the INSERT avoids a second lookup and works for keyless roots.
          const mutation = mutate(name, "insert", scalars).returning((row) => {
            const result = returning
              ? resultOf(returning, row, table)
              : undefined;

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

              const related = tableByName.get(relation.target)!;
              // Children without relations of their own need nothing read
              // back, not even to tell them apart, so consecutive ones wait
              // here for one multi-row INSERT. Any other entry writes them
              // first: rows are inserted in the order they were given.
              let siblings: Record<string, unknown>[] = [];

              const insertSiblings = async () => {
                if (siblings.length) {
                  const rows = siblings;
                  siblings = [];
                  await mutate(relation.target, "insert", rows).execute();
                }
              };

              const links: Record<string, unknown>[] = [];
              // Rows that have to be created are created in key order, not
              // input order: two inserts that create the same rows then wait
              // for each other in one direction only, and cannot deadlock.
              const upserted = new Map<unknown, Record<string, unknown>>();

              if (operation === "connectOrCreate" && entries.length > 1) {
                const extra =
                  relation.kind === "through"
                    ? {}
                    : { [relation.foreignKey]: parentKey };
                const keyed = entries.map((entry) => {
                  const payload = plainRecord(entry)
                    ? { ...entry, ...extra }
                    : undefined;
                  const key = payload && upsertKey(relation.target, payload);

                  return {
                    entry,
                    text: key
                      ? JSON.stringify(
                          key.map((field: string) => String(payload![field])),
                        )
                      : undefined,
                  };
                });

                // An entry without a key fails where it stands, in the loop below.
                if (keyed.every(({ text }) => text !== undefined)) {
                  keyed.sort((left, right) =>
                    left.text! < right.text!
                      ? -1
                      : left.text! > right.text!
                        ? 1
                        : 0,
                  );

                  for (const { entry } of keyed) {
                    if (!upserted.has(entry)) {
                      upserted.set(
                        entry,
                        await resolveRow(
                          relation.target,
                          operation,
                          entry,
                          extra,
                          scalarKey(name, relation),
                        ),
                      );
                    }
                  }
                }
              }

              for (const entry of entries) {
                const extra =
                  relation.kind === "through"
                    ? {}
                    : { [relation.foreignKey]: parentKey };

                if (relation.kind !== "through" && operation === "create") {
                  const payload = payloadOf(operation, entry, extra);

                  if (
                    !related.relations.some((nested) =>
                      Object.hasOwn(payload, nested.name),
                    )
                  ) {
                    siblings.push(payload);
                    continue;
                  }

                  // A child that only connects rows it references (an order
                  // item and its product) joins the same INSERT.
                  const parts = split(relation.target, payload);

                  if (connectsOnly(parts)) {
                    await forwards(relation.target, payload, parts, resolveRow);
                    siblings.push(parts.scalars);
                    continue;
                  }
                }

                await insertSiblings();
                const target =
                  upserted.get(entry) ??
                  (await resolveRow(
                    relation.target,
                    operation,
                    entry,
                    operation === "connect" ? {} : extra,
                    scalarKey(name, relation),
                  ));

                if (relation.kind === "through") {
                  links.push({
                    [relation.sourceForeignKey]: parentKey,
                    [relation.targetForeignKey]:
                      target[
                        referencedName(
                          relation.junction,
                          relation.targetForeignKey,
                          relation.target,
                        )
                      ],
                  });
                } else if (operation !== "create") {
                  await attach(
                    relation.target,
                    target,
                    relation.foreignKey,
                    parentKey,
                  );
                }
              }

              await insertSiblings();

              // The junction rows of one operation are one INSERT, in input order.
              if (relation.kind === "through" && links.length) {
                await mutate(relation.junction, "insert", links)
                  .onConflict(
                    relation.sourceForeignKey,
                    relation.targetForeignKey,
                  )
                  .doNothing()
                  .execute();
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
        const rootTable = tableByName.get(tableName)!;
        // Consecutive roots that write nothing but themselves share one
        // multi-row INSERT; rows are still inserted in the order given.
        let roots: Record<string, unknown>[] = [];

        const insertRoots = async () => {
          if (!roots.length) {
            return;
          }

          const rows = roots;
          roots = [];
          const mutation = mutate(tableName, "insert", rows);

          if (selector) {
            results.push(
              ...((await mutation
                .returning((row) => resultOf(selector, row, rootTable))
                .execute()) as unknown as Record<string, unknown>[]),
            );
          } else {
            await mutation.execute();
          }
        };

        /** A connect of a batched root: nothing else is written for it. */
        const connectRow: ResolveRow = (
          target,
          _operation,
          value,
          _extra,
          column,
        ) => find(target, value, column);

        for (const value of values) {
          const parts = values.length > 1 ? split(tableName, value) : undefined;

          if (parts && connectsOnly(parts)) {
            await forwards(tableName, value, parts, connectRow);
            roots.push(parts.scalars);
            continue;
          }

          await insertRoots();

          const inserted = await insertRow(tableName, value, selector);

          if (selector) {
            results.push(inserted.result!);
          }
        }

        await insertRoots();

        if (!selector) {
          return { affectedRows: values.length };
        }

        return Array.isArray(input) ? results : results[0];
      });

    const run = () => (failure ? Promise.reject(failure.error) : execute());

    return freeze({
      returning: (next?: unknown, ...names: unknown[]) =>
        build(returningSelector(next, names) as Selector),
      execute: run,
      then: (
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) => run().then(onFulfilled, onRejected),
      catch: (onRejected?: ((reason: unknown) => unknown) | null) =>
        run().catch(onRejected),
      finally: (onFinally?: (() => void) | null) => run().finally(onFinally),
    });
  };

  return build();
};
