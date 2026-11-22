import { COLUMN_CODEC, isColumn, builderExample } from "./column";
import {
  inferredPrimaryKey,
  primaryKeyColumns,
  type ConditionRelationInput,
  type SchemaOverrides,
  type SchemaSnapshot,
} from "./assembly";
import {
  CONDITION,
  declaredConditions,
  type TableRelationCallback,
} from "./conditions";
import {
  isTable,
  isReferenceInput,
  tableState,
  type ColumnInput,
  type Table,
  type TableHandle,
  type TableIndexCallback,
  type TableCheckCallback,
  draftBinding,
  type TableState,
} from "./table";
import type { SlotState, ThroughInput } from "./slots";
import { createScope, type RuntimeScope } from "../query/select";
import {
  codecMap,
  encodeValue,
  type RuntimeCodec,
  type SchemaCodecs,
} from "../query/codecs";
import { quoteIdentifier } from "../query/compile";
import { applyIndexes, index, type IndexDefinition } from "./indexes";
import { applyChecks } from "./checks";
import { LINK, createLink, isLink } from "./links";
import type { SchemaDefinitions } from "./graph";

/**
 * Infer key values and complete definitions through separate reverse maps.
 * Callback references can then carry scalar types without a circular dependency
 * on the complete relation graph.
 */
/** A thunk in a table body must yield a table; columns are declared directly. */
export const resolveThunk = (
  tableName: string,
  name: string,
  thunk: () => unknown,
): Table<Record<string, unknown>> => {
  const result = thunk();

  if (isColumn(result)) {
    throw new Error(
      `symmetria: "${tableName}.${name}": a thunk must return a table; declare the column directly (${name}: ${describeValue(result)})`,
    );
  }

  if (!isTable(result)) {
    throw new Error(
      `symmetria: "${tableName}.${name}": a thunk must return a table (got ${describeValue(result)})`,
    );
  }

  return result as Table<Record<string, unknown>>;
};

export const describeValue = (value: unknown): string => {
  if (value === null) {
    return "null";
  }

  if (isColumn(value)) {
    return `a ${value.definition.sqlType} column`;
  }

  if (typeof value === "function") {
    return `function ${value.name || "(anonymous)"}`;
  }

  if (typeof value === "object") {
    const constructor = (value as object).constructor?.name;

    return constructor && constructor !== "Object"
      ? `an instance of ${constructor}`
      : "a plain object";
  }

  return typeof value;
};

export type TableHandles = Record<
  string,
  TableHandle<Record<string, ColumnInput>>
>;

/** A reference renamed on its target with `.inverse()`. */
export type InverseRelation = {
  target: string;
  name: string;
  source: string;
  column: string;
};

/**
 * Lowers table bodies to columns and keyed links: a table handle, a thunk or
 * `self` in a column position becomes a link to the schema key it stands for.
 */
export const linkDefinitions = (
  rawDefinitions: Record<string, Record<string, unknown>>,
  tableNamesByState: ReadonlyMap<TableState, readonly string[]>,
): SchemaDefinitions => {
  const tableDefinitions: SchemaDefinitions = {};

  for (const [tableName, columns] of Object.entries(rawDefinitions)) {
    tableDefinitions[tableName] = Object.fromEntries(
      Object.entries(columns).map(([name, value]) => {
        if (isColumn(value) || isLink(value)) {
          return [name, value];
        }

        const example = builderExample(value);

        if (example) {
          throw new Error(
            `symmetria: "${tableName}.${name}" is the ${(value as { name?: string }).name || "column"}() builder itself; call it: ${name}: ${example}`,
          );
        }

        const input = isReferenceInput(value) ? value : undefined;
        const target = input?.target ?? value;
        const state =
          target === "self"
            ? undefined
            : typeof target === "function"
              ? tableState(
                  resolveThunk(tableName, name, target as () => unknown),
                )
              : isTable(target)
                ? tableState(target)
                : target;
        const targets = tableNamesByState.get(state as TableState);

        if (targets && targets.length > 1) {
          throw new Error(
            `symmetria: ambiguous table reference "${tableName}.${name}"; use a keyed callback`,
          );
        }

        const targetName = target === "self" ? tableName : targets?.[0];

        if (!targetName) {
          if (!isTable(target)) {
            throw new Error(
              `symmetria: "${tableName}.${name}" is not a column, table or reference (got ${describeValue(target)})`,
            );
          }

          throw new Error(
            `symmetria: reference "${tableName}.${name}" points to a table outside this schema`,
          );
        }

        return [name, createLink(targetName, input?.flags ?? {})];
      }),
    );
  }

  return tableDefinitions;
};

/**
 * `tags: many(tags.posts)` on `posts` adds the junction table `postsTags`:
 * a reference to each side, keyed by the name the other side knows its rows
 * by, so the columns are `posts_id` and `tags_id`.
 */
export const addJunctions = (
  rawDefinitions: Record<string, Record<string, unknown>>,
  tableThroughs: ReadonlyMap<string, Readonly<Record<string, ThroughInput>>>,
  tableNamesByState: ReadonlyMap<TableState, readonly string[]>,
  junctionTables: Set<string>,
  tableSqlNames: Map<string, string>,
  claimedSlots: Set<string>,
): void => {
  for (const [tableName, throughs] of tableThroughs) {
    for (const [key, declared] of Object.entries(throughs)) {
      const targets = tableNamesByState.get(
        declared.target.table as TableState,
      );
      const slotKey = declared.target.key;

      if (!targets || targets.length !== 1) {
        throw new Error(
          `symmetria: "${tableName}.${key}": many() takes a slot of a table in this schema${targets ? ", listed once" : ""}`,
        );
      }

      const target = targets[0]!;

      if (declared.target.slot?.kind !== "many") {
        throw new Error(
          `symmetria: "${tableName}.${key}": many(${target}.${slotKey}) needs a many slot; "${target}.${slotKey}" is declared as one`,
        );
      }

      if (slotKey === key) {
        throw new Error(
          `symmetria: "${tableName}.${key}" and "${target}.${slotKey}" have the same name, and the junction needs two different reference names; declare it with link({ ... })`,
        );
      }

      const junctionName = `${tableName}${key[0]!.toUpperCase()}${key.slice(1)}`;

      if (Object.hasOwn(rawDefinitions, junctionName)) {
        throw new Error(
          `symmetria: the junction table of "${tableName}.${key}" is "${junctionName}", a name this schema already uses; declare the junction yourself with link()`,
        );
      }

      rawDefinitions[junctionName] = {
        [slotKey]: createLink(tableName, {
          onDelete: declared.onDelete,
          through: key,
        }),
        [key]: createLink(target, {
          onDelete: declared.onDelete,
          through: slotKey,
        }),
        ...declared.columns,
      };
      junctionTables.add(junctionName);
      claimedSlots.add(`${target}.${slotKey}`);

      if (declared.sqlName !== undefined) {
        tableSqlNames.set(junctionName, declared.sqlName);
      }
    }
  }
};

/**
 * Pairs references with the slots they claim (by `.inverse()` name, or by the
 * referencing table's own key) and gives each reference what its slot says:
 * the delete action of `many.cascade`, uniqueness for a `one` slot on `self`.
 */
export const claimSlots = (
  tableDefinitions: SchemaDefinitions,
  tableSlots: ReadonlyMap<string, Readonly<Record<string, SlotState>>>,
  claimedSlots: Set<string>,
): void => {
  for (const [tableName, definition] of Object.entries(tableDefinitions)) {
    for (const [columnName, value] of Object.entries(definition)) {
      if (!isLink(value)) {
        continue;
      }

      const { target, flags } = value[LINK];

      if (flags.through !== undefined) {
        claimedSlots.add(`${target}.${flags.through}`);
        continue;
      }

      const slotName = flags.inverse ?? tableName;
      const slot = tableSlots.get(target)?.[slotName];
      const reference = `"${tableName}.${columnName}"`;
      const named = `"${target}.${slotName}"`;

      if (!slot) {
        if (flags.selfSlot) {
          throw new Error(
            `symmetria: ${reference} claims self.${slotName}, but "${tableName}" declares no such slot; add ${slotName}: many`,
          );
        }

        continue;
      }

      claimedSlots.add(`${target}.${slotName}`);
      let next = flags;

      if (slot.kind === "one" && !flags.unique) {
        if (!flags.selfSlot) {
          throw new Error(
            `symmetria: slot ${named} is one, so ${reference} must be unique; write one(${target}.${slotName}) or add .unique`,
          );
        }

        next = { ...next, unique: true };
      }

      if (slot.kind === "many" && flags.unique) {
        throw new Error(
          `symmetria: slot ${named} is many, but ${reference} is unique, so each row has at most one; declare the slot as ${slotName}: one`,
        );
      }

      if (slot.onDelete !== undefined) {
        if (flags.onDelete !== undefined && flags.onDelete !== slot.onDelete) {
          throw new Error(
            `symmetria: ${named} and ${reference} both say what a delete does (${slot.onDelete} and ${flags.onDelete}); keep one of them`,
          );
        }

        if (slot.onDelete === "set null" && !flags.nullable) {
          throw new Error(
            `symmetria: slot ${named} is setNull, so ${reference} must be optional: maybe(${target}.${slotName})`,
          );
        }

        next = { ...next, onDelete: slot.onDelete };
      }

      if (next !== flags) {
        definition[columnName] = createLink(target, next);
      }
    }
  }
};

/** Gives every table without `.primaryKey()` the key the assembler infers for it. */
export const inferPrimaryKeys = (
  tableDefinitions: SchemaDefinitions,
  primaryKeys: Map<string, readonly string[]>,
  junctionTables: ReadonlySet<string>,
): void => {
  for (const [tableName, definition] of Object.entries(tableDefinitions)) {
    if (primaryKeys.has(tableName)) {
      continue;
    }

    const entries = Object.entries(definition);

    primaryKeys.set(
      tableName,
      inferredPrimaryKey(
        junctionTables.has(tableName),
        entries.flatMap(([key, column]) =>
          isColumn(column) ? [{ key, definition: column.definition }] : [],
        ),
        entries.filter(([, column]) => isLink(column)).map(([key]) => key),
      ),
    );
  }
};

/** `.inverse()` names as assembler overrides: the reference each reverse relation is named after. */
export const inverseOverrides = (
  inverseRelations: readonly InverseRelation[],
  tableHandles: TableHandles,
): SchemaOverrides<TableHandles> => {
  const overrides: SchemaOverrides<TableHandles> = Object.create(null);

  for (const inverseRelation of inverseRelations) {
    const tableOverrides = (overrides[inverseRelation.target] ??=
      Object.create(null));

    if (Object.hasOwn(tableOverrides, inverseRelation.name)) {
      throw new Error(
        `symmetria: duplicate inverse "${inverseRelation.target}.${inverseRelation.name}"`,
      );
    }

    tableOverrides[inverseRelation.name] =
      tableHandles[inverseRelation.source]![inverseRelation.column]!;
  }

  return overrides;
};

/** The schema key of the table a condition relation's `to()` names. */
export const conditionTargetName = (
  tableNamesByState: ReadonlyMap<TableState, readonly string[]>,
  tableNamesByRecord: ReadonlyMap<object, readonly string[]>,
  tableName: string,
  relationName: string,
  target: unknown,
): string => {
  if (isLink(target)) {
    return target[LINK].target;
  }

  if (isReferenceInput(target)) {
    throw new Error(
      `symmetria: relation "${tableName}.${relationName}": to() expects a table, not a reference chain; write to(<table>) and compare the key column in the predicate`,
    );
  }

  const resolved =
    typeof target === "function"
      ? resolveThunk(tableName, relationName, target as () => unknown)
      : target;
  const names = isTable(resolved)
    ? tableNamesByState.get(tableState(resolved))
    : resolved && typeof resolved === "object"
      ? tableNamesByRecord.get(resolved)
      : undefined;

  if (names && names.length > 1) {
    throw new Error(
      `symmetria: ambiguous table reference in relation "${tableName}.${relationName}"; use a keyed callback`,
    );
  }

  if (!names?.[0]) {
    throw new Error(
      `symmetria: relation "${tableName}.${relationName}" points to a table outside this schema (got ${describeValue(target)})`,
    );
  }

  return names[0];
};

/**
 * Condition relations: run the callbacks once against a draft binding to learn
 * names, targets and cardinality; the predicates themselves run per JOIN.
 */
export const declareConditions = (
  tableRelations: ReadonlyMap<string, readonly TableRelationCallback[]>,
  tableHandles: TableHandles,
  tableDefinitions: SchemaDefinitions,
  tableNamesByState: ReadonlyMap<TableState, readonly string[]>,
  tableNamesByRecord: ReadonlyMap<object, readonly string[]>,
): Record<string, ConditionRelationInput[]> => {
  const conditions: Record<string, ConditionRelationInput[]> =
    Object.create(null);

  for (const [tableName, callbacks] of tableRelations) {
    if (!callbacks.length) {
      continue;
    }

    const draft = draftBinding(tableState(tableHandles[tableName]!));
    const declared = declaredConditions(
      callbacks,
      createScope({ [draft.alias]: draft })[draft.alias]!,
      tableName,
    );
    const definition = tableDefinitions[tableName]!;
    conditions[tableName] = Object.entries(declared).map(([name, entry]) => {
      const state = entry[CONDITION];

      if (
        Object.hasOwn(definition, name) ||
        Object.keys(definition).some((column) => `${column}Id` === name)
      ) {
        throw new Error(
          `symmetria: relation "${tableName}.${name}" clashes with a column of the same name`,
        );
      }

      return {
        name,
        target: conditionTargetName(
          tableNamesByState,
          tableNamesByRecord,
          tableName,
          name,
          state.target,
        ),
        many: state.many,
        ...(state.inverse !== undefined ? { inverse: state.inverse } : {}),
      };
    });
  }

  return conditions;
};

/** The declared extensions, checked, without duplicates and sorted. */
export const declaredExtensions = (
  extensions: readonly string[],
): readonly string[] => {
  // Lowercase names, with the hyphen of "uuid-ossp"; DDL quotes them.
  for (const extension of extensions) {
    if (!/^[a-z_][a-z0-9_-]*$/.test(extension)) {
      throw new Error(
        `symmetria: extension names are lowercase identifiers such as "pg_trgm" or "uuid-ossp", not "${extension}"`,
      );
    }
  }

  return Object.freeze([...new Set(extensions)].sort());
};

/** Codecs by table and column name; a foreign key takes the codec of the column it references. */
export const columnCodecs = (
  tableDefinitions: SchemaDefinitions,
  primaryKeys: ReadonlyMap<string, readonly string[]>,
): Record<string, Record<string, RuntimeCodec>> =>
  Object.fromEntries(
    Object.entries(tableDefinitions).map(([tableName, definition]) => [
      tableName,
      codecMap(
        Object.fromEntries(
          Object.entries(definition).flatMap(([columnName, value]) => {
            const column = isColumn(value)
              ? value
              : tableDefinitions[value[LINK].target]?.[
                  value[LINK].flags.by ??
                    primaryKeys.get(value[LINK].target)?.[0] ??
                    "id"
                ];
            const codec =
              column && isColumn(column) ? column[COLUMN_CODEC] : undefined;

            return codec
              ? [[isColumn(value) ? columnName : `${columnName}Id`, codec]]
              : [];
          }),
        ),
      ),
    ]),
  );

/** Persist storage defaults; codecs themselves remain outside the snapshot. */
export const encodeDefaults = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs,
): void => {
  for (const table of snapshot.tables) {
    for (const column of table.columns) {
      const codec = codecs[table.name]?.[column.name];

      if (codec && column.default?.kind === "value") {
        const encoded = encodeValue(column.default.value, codec);

        column.default = {
          kind: "value",
          // JSON codecs validate and serialize; keep the JSON value itself, as plain jsonb() does.
          value:
            ["json", "jsonb"].includes(column.sqlType) &&
            typeof encoded === "string"
              ? JSON.parse(encoded)
              : encoded,
        };
      }
    }
  }
};

/** Adds the indexes and checks declared on tables, then the indexes of the schema options. */
export const applyDeclarations = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs,
  tableIndexes: ReadonlyMap<string, readonly TableIndexCallback[]>,
  tableChecks: ReadonlyMap<string, readonly TableCheckCallback[]>,
  schemaIndexes:
    | ((scope: RuntimeScope) => Record<string, IndexDefinition>)
    | undefined,
): void => {
  for (const [tableName, callbacks] of tableIndexes) {
    for (const callback of callbacks) {
      applyIndexes(
        snapshot,
        codecs,
        (scope) => callback(scope[tableName]!),
        tableName,
      );
    }
  }

  for (const [tableName, callbacks] of tableChecks) {
    for (const callback of callbacks) {
      applyChecks(snapshot, codecs, tableName, callback);
    }
  }

  if (schemaIndexes) {
    applyIndexes(snapshot, codecs, schemaIndexes);
  }
};

/**
 * Junctions are traversed from both sides: unless a declared index already
 * leads with it, the second key column (not covered by the PK) gets its own index.
 */
export const indexJunctionSecondKeys = (
  snapshot: SchemaSnapshot,
  codecs: SchemaCodecs,
): void => {
  for (const table of snapshot.tables) {
    const column = table.junction ? primaryKeyColumns(table)[1] : undefined;

    if (!column) {
      continue;
    }

    const leading = quoteIdentifier(column.sqlName);

    if (
      !table.indexes?.some(
        ({ keys: [first] }) =>
          first === leading || first?.startsWith(`${leading} `),
      )
    ) {
      applyIndexes(
        snapshot,
        codecs,
        (scope) => ({
          [column.name]: index(scope[table.name]![column.name]!),
        }),
        table.name,
        true,
      );
    }
  }
};
