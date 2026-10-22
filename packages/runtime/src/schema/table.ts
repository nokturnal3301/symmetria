/**
 * Anonymous tables. `table({...})` takes no name — tables are named by their key
 * in schema(). `table({...}).indexes((columns) => ({ ... }))` keeps indexes
 * alongside the column declaration; callbacks run when the schema is assembled.
 *
 * A column value may be:
 *   - a Column            → scalar column
 *   - a keyed schema link → FK + relation, including cyclic references
 *   - another table       → FK + relation (`author: users`)
 *   - table.nullable/.unique/.onDelete.* → FK with flags
 *   - a thunk `() => users` → lazy FK (cross-file cycles)
 *   - `self` / `self.nullable` → self-reference
 */

import { isColumn, type ColumnMetadata, type Column } from "./column";
import type { LinkMetadata } from "./model";
import type { RowOf } from "./infer";
import {
  createScope,
  type Columns as QueryColumns,
  type RuntimeScope,
} from "../query/select";
import {
  readColumn,
  type Predicate,
  type SelectedColumn,
  type ExpressionValue,
} from "../query/expressions";
import type { ComputedCallback } from "./computed";
import type { TableSnapshot } from "./assembly";
import type { IndexDefinition } from "./indexes";

export const TABLE: unique symbol = Symbol("symmetria.table");
export const TABLE_PRIMARY_KEY: unique symbol = Symbol(
  "symmetria.table.primaryKey",
);
export declare const TABLE_UNIQUE_KEYS: unique symbol;
export declare const TABLE_JUNCTION: unique symbol;

export type OnDeleteAction = "cascade" | "restrict" | "set null" | "no action";

export type ReferenceFlags = {
  nullable?: boolean;
  unique?: boolean;
  onDelete?: OnDeleteAction;
  index?: boolean;
  inverse?: string;
};

export type TableState = {
  readonly columns: Record<string, unknown>;
  readonly indexCallbacks: readonly TableIndexCallback[];
  readonly checkCallbacks: readonly TableCheckCallback[];
  readonly computedCallbacks: readonly ComputedCallback[];
  readonly primaryKey?: readonly string[];
  /** Declared with junction(): both foreign keys form the primary key and expose M:N relations. */
  readonly junction: boolean;
  /** Assigned by the schema assembler; public schema() lowers declarations to fresh states. */
  key?: string;
  sqlName?: string;
};

export type ColumnReference = {
  readonly kind: "columnReference";
  readonly table: TableState;
  readonly key: string;
};

export type ReferenceInput = {
  readonly kind: "reference";
  readonly target: TableState | (() => unknown) | "self";
  readonly flags: ReferenceFlags;
};

// ---------------------------------------------------------------------------
// Type level
// ---------------------------------------------------------------------------

declare const REFERENCE: unique symbol;
declare const SELF: unique symbol;

export interface Table<Columns> {
  readonly [TABLE]: {
    readonly columns: Columns;
    readonly keyValue?: TableKeyValue<Columns>;
  };
}

/** Keyed references resolve their storage type when schema() assembles all tables. */
type KeyedReferenceNames<ColumnDefinitions> = {
  [ColumnName in keyof ColumnDefinitions &
    string]: ColumnDefinitions[ColumnName] extends LinkMetadata
    ? ColumnName
    : never;
}[keyof ColumnDefinitions & string];

export type TableIndexColumns<ColumnDefinitions> = QueryColumns<
  RowOf<Omit<ColumnDefinitions, KeyedReferenceNames<ColumnDefinitions>>> & {
    [ColumnName in KeyedReferenceNames<ColumnDefinitions> as `${ColumnName}Id`]: ColumnDefinitions[ColumnName] extends LinkMetadata<
      string,
      infer Options,
      infer Value
    >
      ? Value | (Options extends { nullable: true } ? null : never)
      : never;
  }
>;

export type TableIndexCallback = (
  columns: RuntimeScope[string],
) => Record<string, IndexDefinition>;
export type TableCheckCallback = (
  columns: RuntimeScope[string],
) => Record<string, Predicate>;

type MarkedPrimaryKeys<ColumnDefinitions> = {
  [ColumnName in keyof ColumnDefinitions &
    string]: ColumnDefinitions[ColumnName] extends Column<infer Metadata>
    ? Metadata extends { primaryKey: true }
      ? ColumnName
      : never
    : never;
}[keyof ColumnDefinitions & string];
export type PrimaryKeyNames<ColumnDefinitions> = ColumnDefinitions extends {
  readonly [TABLE_PRIMARY_KEY]: infer Names extends readonly string[];
}
  ? Names
  : [MarkedPrimaryKeys<ColumnDefinitions>] extends [never]
    ? "id" extends keyof ColumnDefinitions
      ? readonly ["id"]
      : readonly []
    : readonly MarkedPrimaryKeys<ColumnDefinitions>[];
type TableKeyValue<ColumnDefinitions> = string extends keyof ColumnDefinitions
  ? unknown
  : ColumnDefinitions[PrimaryKeyNames<ColumnDefinitions>[number] &
        keyof ColumnDefinitions] extends Column<infer Metadata>
    ? Metadata["valueType"]
    : unknown;
type SelectedKeyNames<Selection extends readonly SelectedColumn[]> = {
  readonly [Position in keyof Selection]: Selection[Position] extends SelectedColumn<
    unknown,
    infer Name
  >
    ? Name
    : never;
};

/** Phantom properties are *required* so ReferenceBuilder and SelfReference never match each other
 *  structurally; runtime objects are cast — users never construct these types. */
export interface ReferenceBuilder<Columns, Flags extends ReferenceFlags> {
  readonly [REFERENCE]: { columns: Columns; flags: Flags };
  readonly kind: "reference";
}

export interface SelfReference<Flags extends ReferenceFlags> {
  readonly [SELF]: Flags;
  readonly kind: "reference";
}

type OnDeleteChain<Columns, Flags extends ReferenceFlags> = {
  readonly cascade: ReferenceChain<Columns, Flags>;
  readonly restrict: ReferenceChain<Columns, Flags>;
  readonly setNull: ReferenceChain<Columns, Flags & { nullable: true }>;
  readonly noAction: ReferenceChain<Columns, Flags>;
};

type ReferenceChain<Columns, Flags extends ReferenceFlags> = ReferenceBuilder<
  Columns,
  Flags
> & {
  readonly nullable: ReferenceChain<Columns, Flags & { nullable: true }>;
  readonly unique: ReferenceChain<Columns, Flags & { unique: true }>;
  readonly index: ReferenceChain<Columns, Flags & { index: true }>;
  readonly onDelete: OnDeleteChain<Columns, Flags>;
  readonly inverse: <const Name extends string>(
    name: Name,
  ) => ReferenceChain<Columns, Flags & { inverse: Name }>;
};

/** Declaration references used by relation overrides during schema assembly. */
type ColumnReferences<Columns> = {
  readonly [ColumnName in Exclude<
    keyof Columns,
    "indexes" | "checks" | "primaryKey" | "index" | "inverse" | "computed"
  >]: ColumnReference;
};

export type TableHandle<Columns> = Table<Columns> &
  ColumnReferences<Columns> & {
    readonly computed: <const Selection extends Record<string, SelectedColumn>>(
      callback: (columns: TableIndexColumns<Columns>) => Selection,
    ) => TableHandle<
      Columns & {
        [Name in keyof Selection]: Column<{
          valueType: ExpressionValue<Selection[Name]>;
          notNull: true;
          hasDefault: false;
          computed: true;
        }>;
      }
    >;
    readonly indexes: <
      const Definitions extends Record<string, IndexDefinition>,
    >(
      callback: (columns: TableIndexColumns<Columns>) => Definitions,
    ) => TableHandle<
      Columns & {
        readonly [TABLE_UNIQUE_KEYS]: {
          [Name in keyof Definitions as Definitions[Name] extends IndexDefinition<
            infer Names,
            true,
            true
          >
            ? [Names] extends [never]
              ? never
              : Name
            : never]: Definitions[Name] extends IndexDefinition<
            infer Names,
            true,
            true
          >
            ? Names
            : never;
        };
      }
    >;
    readonly checks: (
      callback: (
        columns: TableIndexColumns<Columns>,
      ) => Record<string, Predicate>,
    ) => TableHandle<Columns>;
    readonly primaryKey: Columns extends { readonly [TABLE_JUNCTION]: true }
      ? never
      : <
          const Selection extends readonly [
            SelectedColumn,
            ...SelectedColumn[],
          ],
        >(
          callback: (columns: TableIndexColumns<Columns>) => Selection,
        ) => TableHandle<
          Omit<Columns, typeof TABLE_PRIMARY_KEY> & {
            readonly [TABLE_PRIMARY_KEY]: SelectedKeyNames<Selection>;
          }
        >;
    readonly index: ReferenceChain<Columns, { index: true }>;
    readonly nullable: ReferenceChain<Columns, { nullable: true }>;
    readonly unique: ReferenceChain<Columns, { unique: true }>;
    readonly onDelete: OnDeleteChain<Columns, {}>;
    readonly inverse: <const Name extends string>(
      name: Name,
    ) => ReferenceChain<Columns, { inverse: Name }>;
  };

/** Reference declarations of a junction: every non-column entry. */
type JunctionReferenceNames<ColumnDefinitions> = {
  [ColumnName in keyof ColumnDefinitions &
    string]: ColumnDefinitions[ColumnName] extends Column<ColumnMetadata>
    ? never
    : ColumnName;
}[keyof ColumnDefinitions & string];

export type JunctionColumns<ColumnDefinitions> = ColumnDefinitions & {
  readonly [TABLE_JUNCTION]: true;
  readonly [TABLE_PRIMARY_KEY]: readonly `${JunctionReferenceNames<ColumnDefinitions>}Id`[];
};

/** A junction's primary key is fixed to its two foreign keys, so primaryKey() is unavailable. */
export type JunctionHandle<ColumnDefinitions> = TableHandle<
  JunctionColumns<ColumnDefinitions>
>;

/** The input type permits indexed optional values; schema assembly rejects undefined. */
export type ColumnInput =
  | Column<ColumnMetadata>
  | Table<Record<string, unknown>>
  | ReferenceBuilder<Record<string, unknown>, ReferenceFlags>
  | SelfReference<ReferenceFlags>
  | (() => Table<Record<string, unknown>>)
  | undefined;

const referenceChain = (
  target: ReferenceInput["target"],
  flags: ReferenceFlags,
): ReferenceInput => {
  const reference: Record<string, unknown> = {
    kind: "reference",
    target,
    flags: Object.freeze({ ...flags }),
  };

  const getter = (name: string, nextFlags: ReferenceFlags) =>
    Object.defineProperty(reference, name, {
      get: () => referenceChain(target, { ...flags, ...nextFlags }),
      enumerable: false,
    });

  getter("nullable", { nullable: true });
  getter("unique", { unique: true });
  getter("index", { index: true });

  Object.defineProperty(reference, "onDelete", {
    get: () => onDeleteChain(target, flags),
    enumerable: false,
  });
  Object.defineProperty(reference, "inverse", {
    value: (name: string) =>
      referenceChain(target, { ...flags, inverse: name }),
  });

  return Object.freeze(reference) as ReferenceInput;
};

const ON_DELETE_ACTIONS = new Map<string, OnDeleteAction>([
  ["cascade", "cascade"],
  ["restrict", "restrict"],
  ["setNull", "set null"],
  ["noAction", "no action"],
]);

const onDeleteChain = (
  target: ReferenceInput["target"],
  flags: ReferenceFlags,
): Record<string, ReferenceInput> => {
  return new Proxy({} as Record<string, ReferenceInput>, {
    get: (_target, key) => {
      if (typeof key !== "string") {
        return undefined;
      }

      const action = ON_DELETE_ACTIONS.get(key);

      if (!action) {
        return undefined;
      }

      const extraFlags: ReferenceFlags =
        key === "setNull" ? { nullable: true } : {};

      return referenceChain(target, {
        ...flags,
        ...extraFlags,
        onDelete: action,
      });
    },
  });
};

const REFERENCE_MODIFIERS = new Set([
  "nullable",
  "unique",
  "index",
  "onDelete",
  "inverse",
]);

const createTable = (
  columns: Record<string, unknown>,
  indexCallbacks: readonly TableIndexCallback[],
  checkCallbacks: readonly TableCheckCallback[] = [],
  primaryKey?: readonly string[],
  computedCallbacks: readonly ComputedCallback[] = [],
  junction = false,
): object => {
  const state: TableState = {
    columns: Object.freeze({ ...columns }),
    indexCallbacks: Object.freeze([...indexCallbacks]),
    checkCallbacks: Object.freeze([...checkCallbacks]),
    computedCallbacks: Object.freeze([...computedCallbacks]),
    junction,
    ...(primaryKey ? { primaryKey: Object.freeze([...primaryKey]) } : {}),
  };
  const target = { [TABLE]: state };

  return new Proxy(target, {
    get: (proxyTarget, key) => {
      if (key === TABLE) {
        return state;
      }

      if (typeof key !== "string") {
        return Reflect.get(proxyTarget, key);
      }

      if (key === "indexes") {
        return (callback: TableIndexCallback) => {
          if (typeof callback !== "function") {
            throw new Error("symmetria: indexes() expects a callback");
          }

          return createTable(
            state.columns,
            [...state.indexCallbacks, callback],
            state.checkCallbacks,
            state.primaryKey,
            state.computedCallbacks,
            state.junction,
          );
        };
      }

      if (key === "checks") {
        return (callback: TableCheckCallback) => {
          if (typeof callback !== "function") {
            throw new Error("symmetria: checks() expects a callback");
          }

          return createTable(
            state.columns,
            state.indexCallbacks,
            [...state.checkCallbacks, callback],
            state.primaryKey,
            state.computedCallbacks,
            state.junction,
          );
        };
      }

      if (key === "computed") {
        return (callback: ComputedCallback) => {
          if (typeof callback !== "function") {
            throw new Error("symmetria: computed() expects a callback");
          }

          return createTable(
            state.columns,
            state.indexCallbacks,
            state.checkCallbacks,
            state.primaryKey,
            [...state.computedCallbacks, callback],
            state.junction,
          );
        };
      }

      if (key === "primaryKey") {
        return (
          callback: (
            columns: RuntimeScope[string],
          ) => readonly SelectedColumn[],
        ) => {
          if (state.junction) {
            throw new Error(
              "symmetria: junction tables use both foreign keys as the primary key",
            );
          }

          if (state.primaryKey) {
            throw new Error("symmetria: primaryKey() is already defined");
          }

          const snapshot: TableSnapshot = {
            name: "table",
            sqlName: "table",
            junction: false,
            relations: [],
            columns: Object.entries(state.columns).map(([name, value]) => ({
              name: isColumn(value) ? name : `${name}Id`,
              sqlName: name,
              sqlType: isColumn(value) ? value.definition.sqlType : "reference",
              notNull: true,
              unique: false,
              primaryKey: false,
            })),
          };

          const binding = { table: snapshot, alias: "table", codecs: {} };
          const selection = callback(createScope({ table: binding }).table!);

          if (!Array.isArray(selection) || !selection.length) {
            throw new Error("symmetria: primaryKey() requires columns");
          }

          const names = selection.map((selected) => {
            const expression = readColumn(selected);

            if (
              expression.node.kind !== "column" ||
              expression.node.description.binding !== binding ||
              expression.outputName !== expression.node.description.column.name
            ) {
              throw new Error(
                "symmetria: primaryKey() requires plain columns from its callback",
              );
            }

            return expression.node.description.column.name;
          });

          if (new Set(names).size !== names.length) {
            throw new Error("symmetria: duplicate primary-key column");
          }

          return createTable(
            state.columns,
            state.indexCallbacks,
            state.checkCallbacks,
            names,
            state.computedCallbacks,
            state.junction,
          );
        };
      }

      // Reserved reference modifiers win over same-named columns (documented).
      if (REFERENCE_MODIFIERS.has(key)) {
        if (key === "onDelete") {
          return onDeleteChain(state, {});
        }

        if (key === "inverse") {
          return (name: string) => referenceChain(state, { inverse: name });
        }

        return referenceChain(state, { [key]: true });
      }

      if (key in state.columns) {
        return {
          kind: "columnReference",
          table: state,
          key,
        } satisfies ColumnReference;
      }

      return undefined;
    },
    has: (proxyTarget, key) => {
      return (
        key === TABLE ||
        key === "indexes" ||
        key === "checks" ||
        key === "primaryKey" ||
        key === "computed" ||
        (typeof key === "string" && key in state.columns) ||
        Reflect.has(proxyTarget, key)
      );
    },
  });
};

/** Names come from schema keys; index callbacks run after all references are resolved. */
export const table = <
  const ColumnDefinitions extends Record<string, ColumnInput | LinkMetadata>,
>(
  columns: ColumnDefinitions,
): TableHandle<ColumnDefinitions> =>
  createTable(columns, []) as TableHandle<ColumnDefinitions>;

/**
 * Explicit many-to-many link table: exactly two references form a composite primary
 * key and both sides receive through relations. Extra data columns are allowed.
 */
export const junction = <
  const ColumnDefinitions extends Record<string, ColumnInput | LinkMetadata>,
>(
  columns: ColumnDefinitions,
): JunctionHandle<ColumnDefinitions> => {
  const entries = Object.entries(columns);
  const references = entries.filter(([, value]) => !isColumn(value));

  if (references.length !== 2) {
    throw new Error(
      "symmetria: junction() requires exactly two table references",
    );
  }

  if (
    entries.some(
      ([name, value]) =>
        name === "id" || (isColumn(value) && value.definition.primaryKey),
    )
  ) {
    throw new Error(
      "symmetria: junction tables use both foreign keys as the primary key; remove id and primaryKey columns",
    );
  }

  return createTable(
    columns,
    [],
    [],
    undefined,
    [],
    true,
  ) as JunctionHandle<ColumnDefinitions>;
};

/** Self-reference marker: `parent: self.nullable`. */
export const self: SelfReference<{}> & {
  readonly nullable: SelfReference<{ nullable: true }>;
  readonly onDelete: OnDeleteChain<never, {}>;
} = referenceChain("self", {}) as never;

export const isTable = (
  value: unknown,
): value is TableHandle<Record<string, ColumnInput>> => {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    TABLE in value
  );
};

export const isReferenceInput = (value: unknown): value is ReferenceInput => {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "reference"
  );
};

export const isColumnReference = (value: unknown): value is ColumnReference => {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "columnReference"
  );
};

export const tableState = (value: unknown): TableState => {
  if (!isTable(value)) {
    throw new Error("symmetria: expected a table");
  }

  return (value as unknown as Record<symbol, TableState>)[TABLE]!;
};
