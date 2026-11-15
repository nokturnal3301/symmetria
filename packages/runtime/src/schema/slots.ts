/**
 * Relations declared on both sides. The referenced table names a slot
 * (`posts: many`, `profile: one`), a property of its handle that the other
 * table claims with `one(users.posts)` or `maybe(users.posts)`;
 * `many(tags.posts)` and `link()` declare many-to-many relations. Every form
 * lowers to the reference flags in table.ts, so the schema assembler sees
 * ordinary foreign keys.
 */
import type { Column, ColumnMetadata } from "./column";
import type { LinkMetadata } from "./links";
import {
  createTable,
  isColumnReference,
  isReferenceInput,
  isTable,
  junction,
  referenceChain,
  tableState,
  type ColumnInput,
  type JunctionHandle,
  type OnDeleteAction,
  type ReferenceBuilder,
  type ReferenceFlags,
  type ReferenceableColumnNames,
  type SelfReference,
  type Table,
  type TableState,
} from "./table";

/** Marks `many`, `one` and their delete variants. */
export const SLOT: unique symbol = Symbol("symmetria.table.slot");

/** A slot's declaration: which side it is and what deleting the parent does to the rows that claim it. */
export type SlotState = {
  readonly kind: "many" | "one";
  readonly onDelete?: OnDeleteAction;
};

/** `users.posts`: a slot named on its table, as `one()`, `maybe()`, `many()` and `link()` take it. */
export type SlotReferenceInput = {
  readonly kind: "slotReference";
  readonly table: TableState | "self";
  readonly key: string;
  readonly slot?: SlotState;
};

/** `many(tags.posts)`: a many-to-many relation whose junction table schema() creates. */
export type ThroughInput = {
  readonly kind: "through";
  readonly target: SlotReferenceInput;
  readonly columns: Readonly<Record<string, unknown>>;
  /** The junction table's SQL name, set with `.named()`. */
  readonly sqlName?: string;
  readonly onDelete: OnDeleteAction;
};

declare const SLOT_REFERENCE: unique symbol;
declare const THROUGH: unique symbol;

/** A slot in a table body: `posts: many`, `profile: one`, `comments: many.cascade`. */
export interface Slot<Kind extends "many" | "one" = "many" | "one"> {
  readonly [SLOT]: {
    readonly kind: Kind;
    readonly onDelete?: OnDeleteAction;
  };
}

/** `users.posts`: a slot named on its table. */
export interface SlotReference<
  Columns,
  Key extends string,
  Kind extends "many" | "one",
> {
  readonly [SLOT_REFERENCE]: { columns: Columns; key: Key; kind: Kind };
  readonly kind: "slotReference";
}

/** `self.children`: a slot of the table being declared. Its name is known only when the schema is built. */
export interface SelfSlotReference {
  readonly [SLOT_REFERENCE]: "self";
  readonly kind: "slotReference";
}

/** Any name on `self` that is not one of its modifiers. */
export type SelfSlots = { readonly [slot: string]: SelfSlotReference };

/** `many(tags.posts)`: a many-to-many relation whose junction table schema() creates. */
export interface ManyThrough<TargetColumns, SlotKey extends string, Extra> {
  readonly [THROUGH]: { target: TargetColumns; slot: SlotKey; extra: Extra };
  readonly kind: "through";
  /** Columns of the junction row itself, such as `addedAt: timestamptz.now`. */
  readonly with: <const Columns extends Record<string, Column<ColumnMetadata>>>(
    columns: Columns,
  ) => ManyThrough<TargetColumns, SlotKey, Extra & Columns>;
  /** The junction table's SQL name, instead of `<table>_<relation>`. */
  readonly named: (
    sqlName: string,
  ) => ManyThrough<TargetColumns, SlotKey, Extra>;
  /** Refuse to delete a row that is still linked, instead of removing its links. */
  readonly restrict: ManyThrough<TargetColumns, SlotKey, Extra>;
}

/** What a table body holds besides columns and references. */
export type Marker = Slot | ManyThrough<any, string, any>;

type SlotVariants<Kind extends "many" | "one"> = Slot<Kind> & {
  /** Deleting the parent deletes the rows that reference it. */
  readonly cascade: Slot<Kind>;
  /** Deleting the parent is refused while rows reference it (the default). */
  readonly restrict: Slot<Kind>;
  /** Deleting the parent clears the reference; the other side must be `maybe()`. */
  readonly setNull: Slot<Kind>;
};

type ManySlot = SlotVariants<"many"> &
  (<TargetColumns, Key extends string>(
    slot: SlotReference<TargetColumns, Key, "many">,
  ) => ManyThrough<TargetColumns, Key, {}>);

type ClaimFlags<Nullable extends boolean> = Nullable extends true
  ? { index: true; nullable: true }
  : { index: true };

type SlotFlags<Key extends string, Kind> = Kind extends "one"
  ? { inverse: Key; unique: true }
  : { inverse: Key };

type OnUpdateRelation<Chain> = {
  readonly cascade: Chain;
  readonly restrict: Chain;
  readonly noAction: Chain;
};

/** The chain after `one()` / `maybe()`: a foreign key with the short modifiers. */
export type RelationChain<
  Columns,
  Flags extends ReferenceFlags,
> = ReferenceBuilder<Columns, Flags> & {
  /** `ON DELETE CASCADE`: the row goes with the one it references. */
  readonly cascade: RelationChain<Columns, Flags>;
  /** `ON DELETE RESTRICT` (the default). */
  readonly restrict: RelationChain<Columns, Flags>;
  /** No index on the foreign key. */
  readonly noIndex: RelationChain<Columns, Flags>;
  readonly unique: RelationChain<Columns, Flags & { unique: true }>;
  readonly onUpdate: OnUpdateRelation<RelationChain<Columns, Flags>>;
  /** Reference a unique column instead of the primary key. */
  readonly by: <const Name extends ReferenceableColumnNames<Columns>>(
    name: Name,
  ) => RelationChain<Columns, Flags & { by: Name }>;
  /** Name the foreign-key column in SQL; the TypeScript name stays `<key>Id`. */
  readonly column: (
    sqlName: string,
  ) => RelationChain<Columns, Flags & { column: string }>;
} & (Flags extends { nullable: true }
    ? {
        /** `ON DELETE SET NULL`. */
        readonly setNull: RelationChain<Columns, Flags>;
      }
    : {});

type SelfRelationChain<Flags extends ReferenceFlags> = SelfReference<Flags> & {
  readonly cascade: SelfRelationChain<Flags>;
  readonly restrict: SelfRelationChain<Flags>;
  readonly noIndex: SelfRelationChain<Flags>;
  readonly unique: SelfRelationChain<Flags & { unique: true }>;
  readonly onUpdate: OnUpdateRelation<SelfRelationChain<Flags>>;
  readonly column: (
    sqlName: string,
  ) => SelfRelationChain<Flags & { column: string }>;
} & (Flags extends { nullable: true }
    ? { readonly setNull: SelfRelationChain<Flags> }
    : {});

/** A keyed link from a schema callback, after `.index` and, for `maybe()`, `.nullable`. */
type ClaimedLink<
  Reference extends { readonly index: unknown },
  Nullable extends boolean,
> = Nullable extends true
  ? Reference["index"] extends { readonly nullable: infer Optional }
    ? Optional
    : never
  : Reference["index"];

/** `one()` and `maybe()`: what they accept and the foreign key each form declares. */
type Claim<Nullable extends boolean> = {
  /** Claims a slot of another table: `one(users.posts)`. */
  <Columns, Key extends string, Kind extends "many" | "one">(
    slot: SlotReference<Columns, Key, Kind>,
  ): RelationChain<Columns, ClaimFlags<Nullable> & SlotFlags<Key, Kind>>;
  /** A table without naming a slot: the reverse side is named after this table. */
  <Columns>(
    target: Table<Columns>,
  ): RelationChain<Columns, ClaimFlags<Nullable>>;
  /** A table from a schema callback: `({ users }) => table({ author: one(users) })`. */
  <Reference extends LinkMetadata & { readonly index: unknown }>(
    target: Reference,
  ): ClaimedLink<Reference, Nullable>;
  /** Claims a slot of the table being declared: `maybe(self.children)`. */
  (
    slot: SelfSlotReference | undefined,
  ): SelfRelationChain<ClaimFlags<Nullable> & { selfSlot: true }>;
};

type OneSlot = SlotVariants<"one"> & Claim<false>;

export const isSlot = (value: unknown): value is { [SLOT]: SlotState } =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  SLOT in value;

export const isSlotReference = (value: unknown): value is SlotReferenceInput =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "slotReference";

export const isThrough = (value: unknown): value is ThroughInput =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "through";

const slotMarker = (state: SlotState): object =>
  Object.freeze({ [SLOT]: Object.freeze(state) });

/** `many.cascade`, `one.restrict`, …: what deleting the parent does to the rows on the other side. */
const slotVariants = (kind: SlotState["kind"]): PropertyDescriptorMap => ({
  [SLOT]: { value: Object.freeze({ kind }) },
  cascade: { value: slotMarker({ kind, onDelete: "cascade" }) },
  restrict: { value: slotMarker({ kind, onDelete: "restrict" }) },
  setNull: { value: slotMarker({ kind, onDelete: "set null" }) },
});

const describeTarget = (value: unknown): string =>
  value === undefined
    ? "undefined: no such slot on that table"
    : isColumnReference(value)
      ? `the column "${value.key}"; a slot is declared as ${value.key}: many`
      : typeof value;

/** The foreign key behind `one()` and `maybe()`. */
const claim = (name: "one" | "maybe", target: unknown): unknown => {
  const flags: ReferenceFlags =
    name === "maybe" ? { nullable: true, index: true } : { index: true };

  if (isSlotReference(target)) {
    return referenceChain(target.table, {
      ...flags,
      inverse: target.key,
      ...(target.slot?.kind === "one" ? { unique: true } : {}),
      ...(target.table === "self" ? { selfSlot: true } : {}),
    });
  }

  if (isTable(target)) {
    return referenceChain(tableState(target), flags);
  }

  if (isReferenceInput(target)) {
    return referenceChain(target.target, { ...target.flags, ...flags });
  }

  // A keyed link inside a schema callback: its own chain carries the flags.
  if (target && typeof target === "object" && "index" in target) {
    const indexed = (target as { index: { nullable: unknown } }).index;

    return name === "maybe" ? indexed.nullable : indexed;
  }

  throw new Error(
    `symmetria: ${name}() expects a table or a slot such as users.posts (got ${describeTarget(target)})`,
  );
};

const through = (
  target: SlotReferenceInput,
  options: Pick<ThroughInput, "columns" | "sqlName" | "onDelete">,
): ThroughInput =>
  Object.freeze(
    Object.defineProperties(
      { kind: "through" as const, target, ...options },
      {
        with: {
          value: (columns: Record<string, unknown>) =>
            through(target, {
              ...options,
              columns: Object.freeze({ ...options.columns, ...columns }),
            }),
        },
        named: {
          value: (sqlName: string) => {
            if (typeof sqlName !== "string" || !sqlName) {
              throw new Error(
                "symmetria: named() expects the junction table's SQL name",
              );
            }

            return through(target, { ...options, sqlName });
          },
        },
        restrict: {
          get: () => through(target, { ...options, onDelete: "restrict" }),
        },
      },
    ),
  );

/**
 * The "many" side of a relation. Bare, it is a slot on the parent
 * (`posts: many`) that the child claims with `one(users.posts)`. Called with
 * another table's slot, it is a many-to-many relation
 * (`tags: many(tags.posts)`) and schema() creates the junction table.
 */
export const many: ManySlot = Object.freeze(
  Object.defineProperties((slot: unknown) => {
    if (!isSlotReference(slot) || slot.table === "self") {
      throw new Error(
        `symmetria: many() expects the other table's slot, such as tags.posts (got ${describeTarget(slot)})`,
      );
    }

    return through(slot, { columns: Object.freeze({}), onDelete: "cascade" });
  }, slotVariants("many")),
) as never;

/**
 * A required reference: `author: one(users.posts)` is a NOT NULL foreign key
 * with an index, `post.author`, and `user.posts` on the other side. Bare, it
 * is the slot of a one-to-one (`profile: one`).
 */
export const one: OneSlot = Object.freeze(
  Object.defineProperties(
    (target: unknown) => claim("one", target),
    slotVariants("one"),
  ),
) as never;

/** An optional reference: `editor: maybe(users.edited)` is a nullable foreign key with an index. */
export const maybe: Claim<true> = ((target: unknown) =>
  claim("maybe", target)) as never;

type LinkTables = {
  /** The junction of two slots: `link(posts.tags, tags.posts, { addedAt: timestamptz.now })`. */
  <
    FirstColumns,
    FirstKey extends string,
    SecondColumns,
    SecondKey extends string,
    const Extra extends Record<string, Column<ColumnMetadata>> = {},
  >(
    first: SlotReference<FirstColumns, FirstKey, "many">,
    second: SlotReference<SecondColumns, SecondKey, "many">,
    columns?: Extra,
  ): JunctionHandle<
    {
      readonly [Key in SecondKey]: ReferenceBuilder<
        FirstColumns,
        { through: FirstKey }
      >;
    } & {
      readonly [Key in FirstKey]: ReferenceBuilder<
        SecondColumns,
        { through: SecondKey }
      >;
    } & Extra
  >;
  /** Named references, as `junction()` takes them: `link({ follower: users, followed: users })`. */
  <
    const References extends Record<string, ColumnInput | LinkMetadata>,
    const Extra extends Record<string, Column<ColumnMetadata>> = {},
  >(
    references: References,
    columns?: Extra,
  ): JunctionHandle<References & Extra>;
};

/**
 * A many-to-many link table: two references form its primary key, and its
 * rows go when either side is deleted. `junction()` is the same table with
 * PostgreSQL's stricter default (a linked row cannot be deleted).
 */
export const link: LinkTables = ((
  first: unknown,
  second?: unknown,
  third?: Record<string, unknown>,
) => {
  if (isSlotReference(first)) {
    if (
      !isSlotReference(second) ||
      first.table === "self" ||
      second.table === "self"
    ) {
      throw new Error(
        "symmetria: link() joins two slots of two tables: link(posts.tags, tags.posts)",
      );
    }

    for (const slot of [first, second]) {
      if (slot.slot?.kind !== "many") {
        throw new Error(
          `symmetria: link() needs many slots; "${slot.key}" is declared as one`,
        );
      }
    }

    if (first.key === second.key) {
      throw new Error(
        `symmetria: both slots of link() are named "${first.key}"; the junction needs two different reference names, use link({ ... })`,
      );
    }

    return junction({
      // Each reference is keyed by the name the other side knows its rows by.
      [second.key]: referenceChain(first.table, {
        onDelete: "cascade",
        through: first.key,
      }),
      [first.key]: referenceChain(second.table, {
        onDelete: "cascade",
        through: second.key,
      }),
      ...third,
    } as never);
  }

  if (!first || typeof first !== "object") {
    throw new Error(
      "symmetria: link() takes two slots or an object of two references",
    );
  }

  // junction() with the delete action links want; schema() applies it to
  // the references that name none, keyed links included.
  return createTable({
    ...tableState(
      junction({
        ...(first as Record<string, never>),
        ...(second as Record<string, never> | undefined),
      }),
    ),
    defaultDelete: "cascade",
  });
}) as never;
