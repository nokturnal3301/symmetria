/**
 * Snapshot assembler. The public schema() in model.ts lowers reusable declarations
 * into fresh table handles before calling this.
 * Tables get their names from the object keys,
 * relations are derived from FK shape:
 *   - `author: users`      → posts.author + reverse users.posts
 *   - `user: users.unique` → 1:1, reverse is a single object
 *   - `junction({ post, tag })` → composite PK over both FKs and M:N through relations
 *
 * Colliding reverse names require overrides; self-reference reverses are created
 * only when explicitly named. Public schema() translates .inverse() modifiers
 * into overrides before assembly.
 */

import {
  COLUMN_CODEC,
  isColumn,
  type ColumnDefinition,
  type ColumnDefault,
} from "./column";
import {
  TABLE,
  isColumnReference,
  isReferenceInput,
  isTable,
  tableState,
  type ColumnReference,
  type OnDeleteAction,
  type ReferenceFlags,
  type ReferenceInput,
  type TableState,
  type Table,
} from "./table";
import { applyIndexes, index, type IndexSnapshot } from "./indexes";
import { applyChecks, type CheckSnapshot } from "./checks";

export type ColumnSnapshot = {
  name: string;
  sqlName: string;
  sqlType: string;
  notNull: boolean;
  unique: boolean;
  primaryKey: boolean;
  default?: ColumnDefault;
  enumerationValues?: readonly string[];
  references?: { table: string; column: string; onDelete: OnDeleteAction };
};

export type RelationSnapshot =
  | {
      name: string;
      kind: "one";
      target: string;
      foreignKey: string;
      nullable: boolean;
      reverse?: false;
    }
  | {
      name: string;
      kind: "one" | "many";
      target: string;
      foreignKey: string;
      reverse: true;
    }
  | {
      name: string;
      kind: "through";
      target: string;
      junction: string;
      sourceForeignKey: string;
      targetForeignKey: string;
    };

export type TableSnapshot = {
  name: string;
  sqlName: string;
  junction: boolean;
  columns: ColumnSnapshot[];
  relations: RelationSnapshot[];
  indexes?: readonly IndexSnapshot[];
  checks?: readonly CheckSnapshot[];
  primaryKey?: readonly string[];
};

export type SchemaSnapshot = { tables: TableSnapshot[] };

export type SchemaOverrides<SchemaDefinition> = Partial<
  Record<keyof SchemaDefinition & string, Record<string, ColumnReference>>
>;

export const snakeCase = (name: string): string => {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
};

type ResolvedReference = {
  key: string;
  target: AnalyzedTable;
  flags: ReferenceFlags;
  self: boolean;
};

type AnalyzedTable = {
  key: string;
  state: TableState;
  scalars: Array<{ key: string; definition: ColumnDefinition }>;
  references: ResolvedReference[];
  isJunction: boolean;
  keys: readonly string[];
  primaryKey?: { key: string; sqlName: string; definition: ColumnDefinition };
};

export const assembleSchema = <
  const SchemaDefinition extends Record<string, Table<Record<string, unknown>>>,
>(
  tables: SchemaDefinition,
  overrides: SchemaOverrides<SchemaDefinition> = {},
): SchemaSnapshot => {
  // -- pass 1: claim names, index states ------------------------------------
  const analyzedTables: AnalyzedTable[] = [];
  const tablesByState = new Map<TableState, AnalyzedTable>();

  for (const [key, handle] of Object.entries(tables)) {
    const state = tableState(handle);

    if (state.key !== undefined) {
      throw new Error(
        `symmetria: table "${state.key}" is already part of a schema (passed as "${key}")`,
      );
    }

    state.key = key;
    state.sqlName = snakeCase(key);
    const analyzedTable: AnalyzedTable = {
      key,
      state,
      scalars: [],
      references: [],
      isJunction: state.junction,
      keys: [],
    };
    analyzedTables.push(analyzedTable);
    tablesByState.set(state, analyzedTable);
  }

  // -- pass 2: classify columns, resolve reference targets ------------------
  for (const analyzedTable of analyzedTables) {
    for (const [key, value] of Object.entries(analyzedTable.state.columns)) {
      if (isColumn(value)) {
        analyzedTable.scalars.push({ key, definition: value.definition });
      } else if (isTable(value)) {
        analyzedTable.references.push({
          key,
          target: resolveTarget(
            tablesByState,
            value[TABLE] as TableState,
            analyzedTable,
          ),
          flags: {},
          self: false,
        });
      } else if (isReferenceInput(value)) {
        const reference = value as ReferenceInput;

        if (reference.target === "self") {
          analyzedTable.references.push({
            key,
            target: analyzedTable,
            flags: reference.flags,
            self: true,
          });
        } else if (typeof reference.target === "function") {
          analyzedTable.references.push({
            key,
            target: resolveTarget(
              tablesByState,
              tableState(reference.target()),
              analyzedTable,
            ),
            flags: reference.flags,
            self: false,
          });
        } else {
          analyzedTable.references.push({
            key,
            target: resolveTarget(
              tablesByState,
              reference.target,
              analyzedTable,
            ),
            flags: reference.flags,
            self: false,
          });
        }
      } else if (typeof value === "function") {
        analyzedTable.references.push({
          key,
          target: resolveTarget(
            tablesByState,
            tableState(value()),
            analyzedTable,
          ),
          flags: {},
          self: false,
        });
      } else {
        throw new Error(
          `symmetria: "${analyzedTable.key}.${key}" is not a column, table reference or thunk`,
        );
      }
    }

    if (analyzedTable.isJunction && analyzedTable.references.length !== 2) {
      throw new Error(
        `symmetria: junction "${analyzedTable.key}" requires exactly two table references`,
      );
    }

    const marked = analyzedTable.scalars
      .filter((column) => column.definition.primaryKey)
      .map((column) => column.key);
    const keys =
      analyzedTable.state.primaryKey ??
      (analyzedTable.isJunction
        ? analyzedTable.references.map((reference) => `${reference.key}Id`)
        : marked.length
          ? marked
          : analyzedTable.scalars.some((column) => column.key === "id")
            ? ["id"]
            : []);
    analyzedTable.keys = keys;

    if (
      analyzedTable.state.primaryKey &&
      marked.some((name) => !keys.includes(name))
    ) {
      throw new Error("symmetria: conflicting primary-key declarations");
    }

    for (const name of keys) {
      const scalar = analyzedTable.scalars.find(
        (column) => column.key === name,
      );
      const reference = analyzedTable.references.find(
        (column) => `${column.key}Id` === name,
      );

      if (!scalar && !reference) {
        throw new Error(`symmetria: unknown primary-key column "${name}"`);
      }

      if ((scalar && !scalar.definition.notNull) || reference?.flags.nullable) {
        throw new Error("symmetria: primary-key columns cannot be nullable");
      }
    }

    for (const scalar of analyzedTable.scalars) {
      scalar.definition = {
        ...scalar.definition,
        primaryKey: keys.includes(scalar.key),
      };
    }

    const primaryKeyColumn =
      keys.length === 1
        ? analyzedTable.scalars.find((column) => column.key === keys[0])
        : undefined;

    if (primaryKeyColumn) {
      analyzedTable.primaryKey = {
        key: primaryKeyColumn.key,
        sqlName: snakeCase(primaryKeyColumn.key),
        definition: primaryKeyColumn.definition,
      };
    }
  }

  // -- pass 3: relations ----------------------------------------------------
  type RelationEntry = RelationSnapshot & { origin: string };
  const relations = new Map<string, RelationEntry[]>(
    analyzedTables.map((analyzedTable) => [analyzedTable.key, []]),
  );
  const namedRelations = new Set<string>(); // `${sourceKey}.${foreignKey}` edges already named via overrides

  const addRelation = (tableKey: string, relation: RelationEntry) => {
    const list = relations.get(tableKey)!;
    const clash = list.find(
      (existingRelation) => existingRelation.name === relation.name,
    );

    if (clash) {
      throw new Error(
        `symmetria: relation name "${relation.name}" on "${tableKey}" is ambiguous ` +
          `(${clash.origin} vs ${relation.origin}). Name it explicitly in schema overrides: ` +
          `schema({...}, { ${tableKey}: { <name>: <table>.<foreignKeyColumn> } })`,
      );
    }

    list.push(relation);
  };

  // forward relations + overrides first (explicit names win the namespace)
  for (const analyzedTable of analyzedTables) {
    for (const reference of analyzedTable.references) {
      addRelation(analyzedTable.key, {
        name: reference.key,
        kind: "one",
        target: reference.target.key,
        foreignKey: `${reference.key}Id`,
        nullable: reference.flags.nullable === true,
        origin: `${analyzedTable.key}.${reference.key}`,
      });
    }
  }

  for (const [tableKey, definitions] of Object.entries(overrides) as Array<
    [string, Record<string, ColumnReference>]
  >) {
    if (!relations.has(tableKey)) {
      throw new Error(
        `symmetria: overrides refer to unknown table "${tableKey}"`,
      );
    }

    for (const [relationName, columnReference] of Object.entries(definitions)) {
      if (!isColumnReference(columnReference)) {
        throw new Error(
          `symmetria: override "${tableKey}.${relationName}" must be a column reference`,
        );
      }

      const source = tablesByState.get(columnReference.table);

      if (!source) {
        throw new Error(
          `symmetria: override "${tableKey}.${relationName}" points outside this schema`,
        );
      }

      const reference = source.references.find(
        (candidate) => candidate.key === columnReference.key,
      );

      if (!reference) {
        throw new Error(
          `symmetria: override "${tableKey}.${relationName}": "${source.key}.${columnReference.key}" is not a reference column`,
        );
      }

      if (source.isJunction) {
        const other = source.references.find(
          (candidate) => candidate !== reference,
        );

        if (!other) {
          throw new Error(
            `symmetria: junction "${source.key}" needs two reference columns`,
          );
        }

        if (
          reference.target.key !== tableKey &&
          other.target.key !== tableKey
        ) {
          throw new Error(
            `symmetria: override "${tableKey}.${relationName}": junction "${source.key}" does not touch "${tableKey}"`,
          );
        }

        const [sourceReference, targetReference] =
          reference.target.key === tableKey
            ? [reference, other]
            : [other, reference];

        addRelation(tableKey, {
          name: relationName,
          kind: "through",
          target: targetReference.target.key,
          junction: source.key,
          sourceForeignKey: `${sourceReference.key}Id`,
          targetForeignKey: `${targetReference.key}Id`,
          origin: `override through ${source.key}`,
        });

        namedRelations.add(`${source.key}.${sourceReference.key}:through`);
      } else {
        if (reference.target.key !== tableKey) {
          throw new Error(
            `symmetria: override "${tableKey}.${relationName}": "${source.key}.${columnReference.key}" references "${reference.target.key}", not "${tableKey}"`,
          );
        }

        addRelation(tableKey, {
          name: relationName,
          kind: reference.flags.unique ? "one" : "many",
          target: source.key,
          foreignKey: `${reference.key}Id`,
          reverse: true,
          origin: `override reverse of ${source.key}.${reference.key}`,
        });

        namedRelations.add(`${source.key}.${reference.key}:reverse`);
      }
    }
  }

  // auto-derived reverse + through relations
  for (const analyzedTable of analyzedTables) {
    for (const reference of analyzedTable.references) {
      if (reference.self) {
        continue;
      } // self-reference reverses must be named explicitly

      if (namedRelations.has(`${analyzedTable.key}.${reference.key}:reverse`)) {
        continue;
      }

      addRelation(reference.target.key, {
        name: analyzedTable.key,
        kind: reference.flags.unique ? "one" : "many",
        target: analyzedTable.key,
        foreignKey: `${reference.key}Id`,
        reverse: true,
        origin: `reverse of ${analyzedTable.key}.${reference.key}`,
      });
    }

    if (analyzedTable.isJunction) {
      const [firstReference, secondReference] = analyzedTable.references as [
        ResolvedReference,
        ResolvedReference,
      ];

      for (const [sourceReference, targetReference] of [
        [firstReference, secondReference],
        [secondReference, firstReference],
      ] as const) {
        if (
          namedRelations.has(
            `${analyzedTable.key}.${sourceReference.key}:through`,
          )
        ) {
          continue;
        }

        addRelation(sourceReference.target.key, {
          name: targetReference.target.key,
          kind: "through",
          target: targetReference.target.key,
          junction: analyzedTable.key,
          sourceForeignKey: `${sourceReference.key}Id`,
          targetForeignKey: `${targetReference.key}Id`,
          origin: `M:N through ${analyzedTable.key}`,
        });
      }
    }
  }

  // -- pass 4: column snapshots ---------------------------------------------
  const tableSnapshots: TableSnapshot[] = analyzedTables.map(
    (analyzedTable) => {
      const columns: ColumnSnapshot[] = analyzedTable.scalars.map((column) => ({
        name: column.key,
        sqlName: snakeCase(column.key),
        sqlType: column.definition.sqlType,
        notNull: column.definition.notNull,
        unique: column.definition.unique,
        primaryKey: column.definition.primaryKey,
        ...(column.definition.default !== undefined
          ? { default: column.definition.default }
          : {}),
        ...(column.definition.enumerationValues !== undefined
          ? { enumerationValues: column.definition.enumerationValues }
          : {}),
      }));

      for (const reference of analyzedTable.references) {
        const targetPrimaryKey = reference.target.primaryKey;

        if (!targetPrimaryKey) {
          throw new Error(
            `symmetria: "${analyzedTable.key}.${reference.key}" references "${reference.target.key}", which has no primary key`,
          );
        }

        columns.push({
          name: `${reference.key}Id`,
          sqlName: `${snakeCase(reference.key)}_id`,
          sqlType: targetPrimaryKey.definition.sqlType,
          notNull: reference.flags.nullable !== true,
          unique: reference.flags.unique === true,
          primaryKey: analyzedTable.keys.includes(`${reference.key}Id`),
          references: {
            table: reference.target.state.sqlName!,
            column: targetPrimaryKey.sqlName,
            onDelete: reference.flags.onDelete ?? "restrict",
          },
        });
      }

      const tableRelations = relations
        .get(analyzedTable.key)!
        .map(({ origin: _origin, ...relation }) => relation);

      return {
        name: analyzedTable.key,
        sqlName: analyzedTable.state.sqlName!,
        junction: analyzedTable.isJunction,
        columns,
        relations: tableRelations,
        ...(analyzedTable.state.primaryKey
          ? { primaryKey: analyzedTable.state.primaryKey.map(snakeCase) }
          : {}),
      };
    },
  );

  // Codepoint sort — locale-independent, so snapshot diffs are stable everywhere.
  const snapshot: SchemaSnapshot = {
    tables: [...tableSnapshots].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  };

  for (const analyzedTable of analyzedTables) {
    const indexedColumns = [
      ...analyzedTable.scalars
        .filter(
          (column) =>
            column.definition.index &&
            !column.definition.unique &&
            !(column.definition.primaryKey && analyzedTable.primaryKey),
        )
        .map((column) => column.key),
      ...analyzedTable.references
        .filter(
          (reference, position) =>
            reference.flags.index &&
            !reference.flags.unique &&
            !(
              analyzedTable.state.primaryKey?.length === 1 &&
              analyzedTable.state.primaryKey[0] === `${reference.key}Id`
            ) &&
            // A junction's composite primary key already leads with its first foreign key.
            !(analyzedTable.isJunction && position === 0),
        )
        .map((reference) => `${reference.key}Id`),
    ];

    if (
      !analyzedTable.state.indexCallbacks.length &&
      !analyzedTable.state.checkCallbacks.length &&
      !indexedColumns.length
    ) {
      continue;
    }

    const codecs = Object.fromEntries(
      [
        ...analyzedTable.scalars.map(
          (column) =>
            [column.key, analyzedTable.state.columns[column.key]] as const,
        ),
        ...analyzedTable.references.map(
          (reference) =>
            [
              `${reference.key}Id`,
              reference.target.state.columns[reference.target.primaryKey!.key],
            ] as const,
        ),
      ].flatMap(([name, column]) =>
        isColumn(column) && column[COLUMN_CODEC]
          ? [[name, column[COLUMN_CODEC]]]
          : [],
      ),
    );

    for (const callback of analyzedTable.state.indexCallbacks) {
      applyIndexes(
        snapshot,
        { [analyzedTable.key]: codecs },
        (scope) => callback(scope[analyzedTable.key]!),
        analyzedTable.key,
      );
    }

    if (indexedColumns.length) {
      applyIndexes(
        snapshot,
        { [analyzedTable.key]: codecs },
        (scope) =>
          Object.fromEntries(
            indexedColumns.map((name) => [
              name,
              index(scope[analyzedTable.key]![name]!),
            ]),
          ),
        analyzedTable.key,
      );
    }

    for (const callback of analyzedTable.state.checkCallbacks) {
      applyChecks(
        snapshot,
        { [analyzedTable.key]: codecs },
        analyzedTable.key,
        callback,
      );
    }
  }

  return snapshot;
};

const resolveTarget = (
  tablesByState: Map<TableState, AnalyzedTable>,
  state: TableState,
  source: AnalyzedTable,
): AnalyzedTable => {
  const found = tablesByState.get(state);

  if (!found) {
    throw new Error(
      `symmetria: "${source.key}" references a table that is not part of this schema() call`,
    );
  }

  return found;
};
