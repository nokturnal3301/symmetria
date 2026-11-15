/**
 * The input of a nested insert, read before anything runs: values are
 * encoded and the graph is copied, so later changes to the caller's objects
 * cannot reach the statements, and the rows it connects are collected.
 */
import {
  primaryKeyColumns,
  uniqueColumnIndexes,
  type SchemaSnapshot,
  type TableSnapshot,
} from "../../schema/assembly";
import { cloneParameter, type SchemaCodecs } from "../codecs";
import {
  COLUMN_EXPRESSION,
  createExpression,
  readColumn,
  valueNode,
} from "../expressions";
import { freeze } from "../plan/freeze";

/** Keys a row can be found by: the primary key first, then unique columns and indexes. */
export const uniqueKeys = (table: TableSnapshot): string[][] => {
  const primary = primaryKeyColumns(table).map((column) => column.name);

  return [
    ...(primary.length ? [primary] : []),
    ...table.columns
      .filter((column) => column.unique)
      .map((column) => [column.name]),
    ...uniqueColumnIndexes(table).map(({ columns }) =>
      columns.map((column) => column.name),
    ),
  ];
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
export const conditionWrite = (table: string, field: string): Error =>
  new Error(
    `symmetria: "${table}.${field}" is a condition relation; it has no foreign key to write`,
  );

/** Readers of one nested insert's input, bound to its schema and root table. */
export const nestedInput = (
  snapshot: SchemaSnapshot,
  tableName: string,
  codecs: SchemaCodecs,
) => {
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

    const primary = primaryKeyColumns(table);

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

  /** The column values a connect names, as find() reads them. */
  const lookupFields = (
    name: string,
    selection: unknown,
    scalarColumn?: string,
  ): Record<string, unknown> => {
    const primary = primaryKeyColumns(tableByName.get(name)!);

    return selection !== null &&
      typeof selection === "object" &&
      !(COLUMN_EXPRESSION in selection) &&
      !Array.isArray(selection)
      ? (selection as Record<string, unknown>)
      : scalarColumn !== undefined
        ? { [scalarColumn]: selection }
        : primary.length === 1
          ? { [primary[0]!.name]: selection }
          : {};
  };

  /**
   * A key value as text, for telling lookups of one column apart: the value
   * as it is sent. Undefined for values without a plain form; those are
   * looked up one by one.
   */
  const lookupKey = (value: unknown): string | undefined => {
    const sent =
      value && typeof value === "object" && COLUMN_EXPRESSION in value
        ? (() => {
            const { node } = readColumn(value as never);

            return node.kind === "parameter" ? node.value : undefined;
          })()
        : value;

    if (sent instanceof Date) {
      return `date:${sent.getTime()}`;
    }

    return sent === null || sent === undefined || typeof sent === "object"
      ? undefined
      : `${typeof sent}:${String(sent)}`;
  };

  /**
   * Every row the input connects by one column, by table and column: they are
   * read together before the first write instead of one statement each.
   */
  const connected = (
    rows: readonly Record<string, unknown>[],
  ): Map<string, Map<string, Map<string, unknown>>> => {
    const wanted = new Map<string, Map<string, Map<string, unknown>>>();

    const walk = (name: string, data: unknown): void => {
      const table = tableByName.get(name);

      if (!table || !data || typeof data !== "object" || Array.isArray(data)) {
        return;
      }

      for (const [field, operations] of Object.entries(data)) {
        const relation = table.relations.find((entry) => entry.name === field);

        if (
          !relation ||
          relation.kind === "condition" ||
          !operations ||
          typeof operations !== "object" ||
          Array.isArray(operations)
        ) {
          continue;
        }

        for (const [operation, payload] of Object.entries(operations)) {
          for (const entry of Array.isArray(payload) ? payload : [payload]) {
            if (operation === "create") {
              walk(relation.target, entry);
            }

            if (operation !== "connect") {
              continue;
            }

            const fields = Object.entries(
              lookupFields(relation.target, entry, scalarKey(name, relation)),
            );
            const key =
              fields.length === 1 ? lookupKey(fields[0]![1]) : undefined;

            if (key === undefined) {
              continue;
            }

            let columns = wanted.get(relation.target);

            if (!columns) {
              wanted.set(relation.target, (columns = new Map()));
            }

            let keys = columns.get(fields[0]![0]);

            if (!keys) {
              columns.set(fields[0]![0], (keys = new Map()));
            }

            keys.set(key, fields[0]![1]);
          }
        }
      }
    };

    for (const row of rows) {
      walk(tableName, row);
    }

    return wanted;
  };

  return {
    tableByName,
    referencedName,
    scalarKey,
    capture,
    lookupFields,
    lookupKey,
    connected,
  };
};
