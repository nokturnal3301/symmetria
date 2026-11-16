/**
 * Anonymous tables. `table({...})` takes no name — tables are named by their key
 * in schema(). `table({...}).indexes((columns) => ({ ... }))` keeps indexes
 * alongside the column declaration; callbacks run when the schema is assembled.
 * `.relations((post, { to }) => ({ ... }))` declares condition relations: JOINs
 * by a predicate without a foreign key (see conditions.ts).
 *
 * A column value may be:
 *   - a Column            → scalar column
 *   - a keyed schema link → FK + relation, including cyclic references
 *   - another table       → FK + relation (`author: users`)
 *   - table.nullable, .unique, .onDelete.<action>, .onUpdate.<action> → FK with flags
 *   - a thunk `() => users` → lazy FK (cross-file cycles)
 *   - `self` (with the same chain as tables, e.g. `self.nullable.inverse("children")`) → self-reference
 *   - `many` / `one` → a slot: the reverse side of a relation, declared on the parent
 *   - `one(users.posts)` / `maybe(users.edited)` → FK that claims a slot
 *   - `many(tags.posts)` → many-to-many through a junction table schema() creates
 */

import {
  isColumn,
  type ColumnMetadata,
  type Column,
  type TraitsMetadata,
} from "./column";
import type { LinkMetadata, LinkOptions } from "./links";
import {
  SLOT,
  isSlot,
  isThrough,
  type Marker,
  type SelfSlots,
  type Slot,
  type SlotReference,
  type SlotReferenceInput,
  type SlotState,
  type ThroughInput,
} from "./slots";
import type { RowOf, TableTraits } from "./infer";
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
  type TraitedRow,
  type TraitsOf,
} from "../query/expressions";
import type { ComputedCallback } from "./computed";
import type { CONDITION, TableRelationCallback } from "./conditions";
import type { TableBinding } from "../query/plan/types";
import type { IndexDefinition, SchemaCondition } from "./indexes";
import type {
  MeaningSearch,
  SearchCallback,
  SearchDeclaration,
  WordsSearch,
} from "./search";

export const TABLE: unique symbol = Symbol("symmetria.table");
const TABLE_PRIMARY_KEY: unique symbol = Symbol("symmetria.table.primaryKey");
export declare const TABLE_UNIQUE_KEYS: unique symbol;
export declare const TABLE_JUNCTION: unique symbol;
/** Phantom key carrying the condition relations declared with `.relations()`. */
export declare const TABLE_RELATIONS: unique symbol;
/** Phantom key carrying the searches declared with `.search()`. */
export declare const TABLE_SEARCH: unique symbol;

export type OnDeleteAction = "cascade" | "restrict" | "set null" | "no action";
/** `ON UPDATE` of a foreign key; PostgreSQL's default is `no action`. */
export type OnUpdateAction = "cascade" | "restrict" | "no action";

export type ReferenceFlags = {
  nullable?: boolean;
  unique?: boolean;
  onDelete?: OnDeleteAction;
  onUpdate?: OnUpdateAction;
  index?: boolean;
  inverse?: string;
  /** Key of the referenced column when it is not the primary key (`users.by("email")`); must be unique. */
  by?: string;
  /** SQL name of the foreign-key column (`users.column("created_by")`); the TS name stays `<key>Id`. */
  column?: string;
  /** On a junction's reference: the name of the many-to-many relation its target gets. */
  through?: string;
  /** A claim written against `self`: the slot is on the declaring table itself. */
  selfSlot?: boolean;
};

export type TableState = {
  readonly columns: Record<string, unknown>;
  /** Reverse sides declared in the body (`posts: many`); not columns. */
  readonly slots: Readonly<Record<string, SlotState>>;
  /** Many-to-many relations declared in the body (`tags: many(tags.posts)`); not columns. */
  readonly throughs: Readonly<Record<string, ThroughInput>>;
  readonly indexCallbacks: readonly TableIndexCallback[];
  readonly checkCallbacks: readonly TableCheckCallback[];
  readonly computedCallbacks: readonly ComputedCallback[];
  readonly relationCallbacks: readonly TableRelationCallback[];
  /** Searches declared with `.search()`; their columns and indexes are already in the state. */
  readonly searchCallbacks: readonly SearchCallback[];
  /** PostgreSQL extensions the table's declarations need (`vector`, `pg_search`). */
  readonly extensions: readonly string[];
  readonly primaryKey?: readonly string[];
  /** SQL name set with `.named()`; otherwise the schema key decides it. */
  readonly named?: string;
  /** Declared with junction(): both foreign keys form the primary key and expose M:N relations. */
  readonly junction: boolean;
  /** Declared with link(): the delete action of references that name none. */
  readonly defaultDelete?: OnDeleteAction;
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

/** The value a keyed link stores: the target's primary key, or the `by()` column when its shape is known. */
type LinkValue<Options, Value, Shape> = Options extends {
  by: infer By extends string;
}
  ? unknown extends Shape
    ? unknown
    : Shape[By & keyof Shape] extends Column<infer Metadata>
      ? Metadata["valueType"]
      : unknown
  : Value;

export type TableIndexColumns<ColumnDefinitions> = QueryColumns<
  TraitedRow<
    RowOf<Omit<ColumnDefinitions, KeyedReferenceNames<ColumnDefinitions>>> & {
      [ColumnName in KeyedReferenceNames<ColumnDefinitions> as `${ColumnName}Id`]: ColumnDefinitions[ColumnName] extends LinkMetadata<
        string,
        infer Options,
        infer Value,
        infer Shape
      >
        ?
            | LinkValue<Options, Value, Shape>
            | (Options extends { nullable: true } ? null : never)
        : never;
    },
    TableTraits<ColumnDefinitions>
  >
>;

export type TableIndexCallback = (
  columns: RuntimeScope[string],
) => Record<string, IndexDefinition>;
export type TableCheckCallback = (
  columns: RuntimeScope[string],
) => Record<string, SchemaCondition>;

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

type OnUpdateChain<Columns, Flags extends ReferenceFlags> = {
  readonly cascade: ReferenceChain<Columns, Flags>;
  readonly restrict: ReferenceChain<Columns, Flags>;
  readonly noAction: ReferenceChain<Columns, Flags>;
};

/** Columns a reference may target: the primary key or a unique column. */
export type ReferenceableColumnNames<Columns> = {
  [ColumnName in keyof Columns & string]: NonNullable<
    Columns[ColumnName]
  > extends Column<infer Metadata>
    ? Metadata extends { unique: true } | { primaryKey: true }
      ? ColumnName
      : ColumnName extends "id"
        ? ColumnName
        : never
    : never;
}[keyof Columns & string];

type ReferenceChain<Columns, Flags extends ReferenceFlags> = ReferenceBuilder<
  Columns,
  Flags
> & {
  readonly nullable: ReferenceChain<Columns, Flags & { nullable: true }>;
  readonly unique: ReferenceChain<Columns, Flags & { unique: true }>;
  readonly index: ReferenceChain<Columns, Flags & { index: true }>;
  readonly onDelete: OnDeleteChain<Columns, Flags>;
  /** `ON UPDATE` action, for example `.onUpdate.cascade` as Prisma declares it. */
  readonly onUpdate: OnUpdateChain<Columns, Flags>;
  readonly inverse: <const Name extends string>(
    name: Name,
  ) => ReferenceChain<Columns, Flags & { inverse: Name }>;
  /** Reference a unique column instead of the primary key. */
  readonly by: <const Name extends ReferenceableColumnNames<Columns>>(
    name: Name,
  ) => ReferenceChain<Columns, Flags & { by: Name }>;
  /** Name the foreign-key column in SQL; the TypeScript name stays `<key>Id`. */
  readonly column: (
    sqlName: string,
  ) => ReferenceChain<Columns, Flags & { column: string }>;
};

type SelfOnDeleteChain<Flags extends ReferenceFlags> = {
  readonly cascade: SelfChain<Flags>;
  readonly restrict: SelfChain<Flags>;
  readonly setNull: SelfChain<Flags & { nullable: true }>;
  readonly noAction: SelfChain<Flags>;
};

type SelfOnUpdateChain<Flags extends ReferenceFlags> = {
  readonly cascade: SelfChain<Flags>;
  readonly restrict: SelfChain<Flags>;
  readonly noAction: SelfChain<Flags>;
};

/** The reference chain for `self`; every step stays a SelfReference so the target resolves to its own table. */
type SelfChain<Flags extends ReferenceFlags> = SelfReference<Flags> & {
  readonly nullable: SelfChain<Flags & { nullable: true }>;
  readonly unique: SelfChain<Flags & { unique: true }>;
  readonly index: SelfChain<Flags & { index: true }>;
  readonly onDelete: SelfOnDeleteChain<Flags>;
  readonly onUpdate: SelfOnUpdateChain<Flags>;
  readonly inverse: <const Name extends string>(
    name: Name,
  ) => SelfChain<Flags & { inverse: Name }>;
  readonly by: <const Name extends string>(
    name: Name,
  ) => SelfChain<Flags & { by: Name }>;
  readonly column: (sqlName: string) => SelfChain<Flags & { column: string }>;
};

/**
 * A relation declared by a join predicate. `Target` is the target table's column
 * record (standalone tables) or its schema name (keyed links); schema() resolves
 * both to a table name when it builds the relation graph.
 */
export interface ConditionRelation<
  Target,
  Many extends boolean,
  Inverse extends string | undefined,
> {
  readonly [CONDITION]: {
    readonly target: Target;
    readonly many: Many;
    readonly inverse: Inverse;
  };
  /** Also expose the relation from the target table, always as a collection. */
  readonly inverse: <const Name extends string>(
    name: Name,
  ) => ConditionRelation<Target, Many, Name>;
}

type ConditionRelationBuilder<TargetScope, Target> = {
  /** A to-one relation; always optional (LEFT JOIN) because no key guarantees a match. */
  readonly one: (
    predicate: (target: TargetScope) => Predicate,
  ) => ConditionRelation<Target, false, undefined>;
  /** A to-many relation. */
  readonly many: (
    predicate: (target: TargetScope) => Predicate,
  ) => ConditionRelation<Target, true, undefined>;
};

/**
 * Keyed links carry no column types, so their target scope is loosely typed;
 * thunks to standalone tables give fully typed targets.
 */
// `any` on purpose: the scope of a callback-declared target has no column types yet.
type LooseColumns = any;

export type RelationTools = {
  readonly to: {
    <Name extends string, Shape>(
      target: LinkMetadata<Name, LinkOptions, unknown, Shape>,
    ): ConditionRelationBuilder<
      unknown extends Shape ? LooseColumns : TableIndexColumns<Shape>,
      Name
    >;
    <TargetColumns extends Record<string, unknown>>(
      target:
        | Table<TargetColumns>
        | (() => Table<TargetColumns>)
        | TargetColumns,
    ): ConditionRelationBuilder<
      TableIndexColumns<TargetColumns>,
      TargetColumns
    >;
  };
};

/** Declaration references used by relation overrides during schema assembly. */
type ColumnReferences<Columns> = {
  readonly [ColumnName in Exclude<
    keyof Columns,
    | "indexes"
    | "checks"
    | "primaryKey"
    | "index"
    | "inverse"
    | "computed"
    | "relations"
    | "named"
    | "nullable"
    | "unique"
    | "onDelete"
    | "onUpdate"
    | "by"
    | "column"
  >]: Columns[ColumnName] extends Slot<infer Kind>
    ? SlotReference<Columns, ColumnName & string, Kind>
    : ColumnReference;
};

export type TableHandle<Columns> = Table<Columns> &
  ColumnReferences<Columns> & {
    readonly computed: <const Selection extends Record<string, SelectedColumn>>(
      callback: (columns: TableIndexColumns<Columns>) => Selection,
    ) => TableHandle<
      Columns & {
        [Name in keyof Selection]: Column<
          {
            valueType: ExpressionValue<Selection[Name]>;
            notNull: true;
            hasDefault: false;
            computed: true;
          } & TraitsMetadata<TraitsOf<Selection[Name]>>
        >;
      }
    >;
    /**
     * The table's SQL name when the schema key should not decide it, such as
     * `"User"` for a table created by Prisma.
     */
    readonly named: (sqlName: string) => TableHandle<Columns>;
    readonly relations: <
      const Declarations extends Record<
        string,
        ConditionRelation<unknown, boolean, string | undefined>
      >,
    >(
      callback: (
        columns: TableIndexColumns<Columns>,
        tools: RelationTools,
      ) => Declarations,
    ) => TableHandle<Columns & { readonly [TABLE_RELATIONS]: Declarations }>;
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
    /**
     * What the table is searched by: words, meaning, or both under one name.
     * `search((chunk) => ({ about: { words: bm25(chunk.content), meaning: voyage4(chunk.content) } }))`
     * creates the indexes and, for a meaning, a hidden column for its embedding.
     */
    readonly search: <const Declared extends Record<string, SearchDeclaration>>(
      callback: (columns: TableIndexColumns<Columns>) => Declared,
    ) => TableHandle<
      Columns & {
        readonly [TABLE_SEARCH]: (Columns extends {
          readonly [TABLE_SEARCH]: infer Earlier;
        }
          ? Earlier
          : {}) & {
          readonly [Name in keyof Declared]: {
            readonly words: Declared[Name] extends { words: WordsSearch }
              ? true
              : false;
            readonly meaning: Declared[Name] extends { meaning: MeaningSearch }
              ? true
              : false;
          };
        };
      }
    >;
    /** CHECK constraints: predicates, or boolean expressions such as ``sql<boolean>`${t.price} > 0` ``. */
    readonly checks: (
      callback: (
        columns: TableIndexColumns<Columns>,
      ) => Record<string, SchemaCondition>,
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
    readonly onUpdate: OnUpdateChain<Columns, {}>;
    readonly inverse: <const Name extends string>(
      name: Name,
    ) => ReferenceChain<Columns, { inverse: Name }>;
    readonly by: <const Name extends ReferenceableColumnNames<Columns>>(
      name: Name,
    ) => ReferenceChain<Columns, { by: Name }>;
    readonly column: (
      sqlName: string,
    ) => ReferenceChain<Columns, { column: string }>;
  };

/** Reference declarations of a junction: every non-column entry. */
type JunctionReferenceNames<ColumnDefinitions> = {
  [ColumnName in keyof ColumnDefinitions &
    string]: ColumnDefinitions[ColumnName] extends
    | Column<ColumnMetadata>
    | Marker
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
  | Marker
  | undefined;

export const referenceChain = (
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
  Object.defineProperty(reference, "onUpdate", {
    get: () => onUpdateChain(target, flags),
    enumerable: false,
  });
  Object.defineProperty(reference, "inverse", {
    value: (name: string) =>
      referenceChain(target, { ...flags, inverse: name }),
  });
  Object.defineProperty(reference, "by", {
    value: (name: string) => referenceChain(target, { ...flags, by: name }),
  });
  Object.defineProperty(reference, "column", {
    value: (sqlName: string) =>
      referenceChain(target, { ...flags, column: sqlName }),
  });
  // The short forms one() and maybe() chains are typed with.
  getter("cascade", { onDelete: "cascade" });
  getter("restrict", { onDelete: "restrict" });
  getter("setNull", { onDelete: "set null", nullable: true });
  getter("noIndex", { index: false });

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

const ON_UPDATE_ACTIONS = new Map<string, OnUpdateAction>([
  ["cascade", "cascade"],
  ["restrict", "restrict"],
  ["noAction", "no action"],
]);

const onUpdateChain = (
  target: ReferenceInput["target"],
  flags: ReferenceFlags,
): Record<string, ReferenceInput> =>
  new Proxy({} as Record<string, ReferenceInput>, {
    get: (_target, key) => {
      const action =
        typeof key === "string" ? ON_UPDATE_ACTIONS.get(key) : undefined;

      return action
        ? referenceChain(target, { ...flags, onUpdate: action })
        : undefined;
    },
  });

/**
 * A binding over a table that is not assembled yet: references appear as
 * `${name}Id` columns. primaryKey() and relations() discovery run their
 * callbacks against it before the schema exists.
 */
export const draftBinding = (state: TableState): TableBinding => ({
  table: {
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
  },
  alias: "table",
  codecs: Object.create(null),
});

const REFERENCE_MODIFIERS = new Set([
  "nullable",
  "unique",
  "index",
  "onDelete",
  "onUpdate",
  "inverse",
  "by",
  "column",
]);

/**
 * Everything a table handle answers to by itself. A slot becomes a property
 * of its table (`users.posts`), so it cannot take one of these names.
 */
export const HANDLE_KEYS: ReadonlySet<string> = new Set([
  "indexes",
  "checks",
  "computed",
  "relations",
  "search",
  "named",
  "primaryKey",
  ...REFERENCE_MODIFIERS,
]);

/**
 * Splits a table body into what is stored (columns and references, in
 * `columns` as before) and what only describes relations: slots and
 * many-to-many declarations.
 */
export const tableBody = (
  body: Record<string, unknown>,
): Pick<TableState, "columns" | "slots" | "throughs"> => {
  // No prototype: a column may be named `__proto__` or `constructor`.
  const columns: Record<string, unknown> = Object.create(null);
  const slots: Record<string, SlotState> = Object.create(null);
  const throughs: Record<string, ThroughInput> = Object.create(null);

  for (const [key, value] of Object.entries(body)) {
    if (isSlot(value)) {
      if (HANDLE_KEYS.has(key)) {
        throw new Error(
          `symmetria: a slot cannot be named "${key}": every table has .${key} of its own; choose another name`,
        );
      }

      slots[key] = value[SLOT];
    } else if (isThrough(value)) {
      throughs[key] = value;
    } else {
      columns[key] = value;
    }
  }

  return { columns, slots, throughs };
};

/**
 * `.search()` is lowered by schema/search.ts, which builds on the query
 * expressions this module is loaded before; it registers itself here.
 */
export const searchLowering: {
  lower?: (
    callback: SearchCallback,
    draft: TableBinding,
    state: TableState,
  ) => Partial<TableState>;
} = {};

/** The declaration part of a table's state; the assembler adds key and sqlName. */
type TableInit = Omit<
  TableState,
  "key" | "sqlName" | "searchCallbacks" | "extensions"
> &
  Partial<Pick<TableState, "searchCallbacks" | "extensions">>;

export const createTable = (init: TableInit): object => {
  const state: TableState = {
    columns: Object.freeze({ ...init.columns }),
    slots: Object.freeze({ ...init.slots }),
    throughs: Object.freeze({ ...init.throughs }),
    indexCallbacks: Object.freeze([...init.indexCallbacks]),
    checkCallbacks: Object.freeze([...init.checkCallbacks]),
    computedCallbacks: Object.freeze([...init.computedCallbacks]),
    relationCallbacks: Object.freeze([...init.relationCallbacks]),
    searchCallbacks: Object.freeze([...(init.searchCallbacks ?? [])]),
    extensions: Object.freeze([...(init.extensions ?? [])]),
    junction: init.junction,
    ...(init.defaultDelete ? { defaultDelete: init.defaultDelete } : {}),
    ...(init.primaryKey
      ? { primaryKey: Object.freeze([...init.primaryKey]) }
      : {}),
    ...(init.named !== undefined ? { named: init.named } : {}),
  };
  const target = { [TABLE]: state };
  const next = (changes: Partial<TableInit>) =>
    createTable({ ...state, ...changes });
  const callbackMethod =
    (name: string, add: (callback: never) => Partial<TableInit>) =>
    (callback: never) => {
      if (typeof callback !== "function") {
        throw new Error(`symmetria: ${name}() expects a callback`);
      }

      return next(add(callback));
    };

  return new Proxy(target, {
    get: (proxyTarget, key) => {
      if (key === TABLE) {
        return state;
      }

      if (typeof key !== "string") {
        return Reflect.get(proxyTarget, key);
      }

      if (key === "indexes") {
        return callbackMethod("indexes", (callback: TableIndexCallback) => ({
          indexCallbacks: [...state.indexCallbacks, callback],
        }));
      }

      if (key === "checks") {
        return callbackMethod("checks", (callback: TableCheckCallback) => ({
          checkCallbacks: [...state.checkCallbacks, callback],
        }));
      }

      if (key === "computed") {
        return callbackMethod("computed", (callback: ComputedCallback) => ({
          computedCallbacks: [...state.computedCallbacks, callback],
        }));
      }

      if (key === "relations") {
        return callbackMethod(
          "relations",
          (callback: TableRelationCallback) => ({
            relationCallbacks: [...state.relationCallbacks, callback],
          }),
        );
      }

      if (key === "search") {
        return callbackMethod("search", (callback: SearchCallback) =>
          searchLowering.lower!(callback, draftBinding(state), state),
        );
      }

      if (key === "named") {
        return (sqlName: string) => {
          if (typeof sqlName !== "string" || !sqlName) {
            throw new Error("symmetria: named() expects the table's SQL name");
          }

          return next({ named: sqlName });
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

          const binding = draftBinding(state);
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

          return next({ primaryKey: names });
        };
      }

      // Reserved reference modifiers win over same-named columns (documented).
      if (REFERENCE_MODIFIERS.has(key)) {
        if (key === "onDelete") {
          return onDeleteChain(state, {});
        }

        if (key === "onUpdate") {
          return onUpdateChain(state, {});
        }

        if (key === "inverse") {
          return (name: string) => referenceChain(state, { inverse: name });
        }

        if (key === "by") {
          return (name: string) => referenceChain(state, { by: name });
        }

        if (key === "column") {
          return (sqlName: string) =>
            referenceChain(state, { column: sqlName });
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

      if (Object.hasOwn(state.slots, key)) {
        return Object.freeze({
          kind: "slotReference",
          table: state,
          key,
          slot: state.slots[key]!,
        } satisfies SlotReferenceInput);
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
        key === "relations" ||
        key === "named" ||
        (typeof key === "string" &&
          (key in state.columns || Object.hasOwn(state.slots, key))) ||
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
  createTable({
    ...tableBody(columns),
    indexCallbacks: [],
    checkCallbacks: [],
    computedCallbacks: [],
    relationCallbacks: [],
    junction: false,
  }) as TableHandle<ColumnDefinitions>;

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

  if (entries.some(([, value]) => isSlot(value) || isThrough(value))) {
    throw new Error(
      "symmetria: a junction table holds two references and columns; many and one belong to the tables it links",
    );
  }

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

  return createTable({
    columns,
    slots: {},
    throughs: {},
    indexCallbacks: [],
    checkCallbacks: [],
    computedCallbacks: [],
    relationCallbacks: [],
    junction: true,
  }) as JunctionHandle<ColumnDefinitions>;
};

/** Self-reference marker: `parent: self.nullable.onDelete.cascade.inverse("children")`. */
export const self: SelfChain<{}> & SelfSlots = new Proxy(
  referenceChain("self", {}),
  {
    // Any other name is a slot of the table being declared: `self.children`.
    get: (target, key) =>
      typeof key !== "string" || key in target
        ? Reflect.get(target, key)
        : Object.freeze({
            kind: "slotReference",
            table: "self",
            key,
          } satisfies SlotReferenceInput),
  },
) as never;

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
