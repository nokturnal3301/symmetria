import type {
  ColumnInputType,
  ColumnMetadata as ColumnTypeMetadata,
  Column,
} from "./column";
import {
  TABLE,
  type TABLE_JUNCTION,
  type ColumnInput,
  type ReferenceFlags,
  type Table,
  type PrimaryKeyNames,
  type TABLE_RELATIONS,
  type TABLE_SEARCH,
  type ConditionRelation,
  type ReferenceBuilder,
  type SelfReference,
  type JunctionColumns,
} from "./table";
import type { ManyThrough, Marker, Slot } from "./slots";
import type { Omittable, Writable } from "./infer";
import type { LinkOptions, LinkMetadata, Link } from "./links";

export type TableReferences<
  TableNames extends string,
  Values extends Record<TableNames, unknown>,
  Shapes extends Record<TableNames, unknown> = Record<TableNames, unknown>,
> = {
  readonly [TableName in TableNames]: Link<
    TableName,
    false,
    false,
    undefined,
    Values[TableName],
    Shapes[TableName]
  >;
};
export type KeyInference<Value> =
  | {
      readonly id?: Column<{
        valueType: Value;
        notNull: boolean;
        hasDefault: boolean;
      }>;
      readonly [name: string]: unknown;
    }
  | {
      readonly [TABLE]: {
        readonly keyValue?: Value;
        readonly columns: Record<string, unknown>;
      };
    };
export type TableDefinition = Record<
  string,
  Column<ColumnTypeMetadata> | LinkMetadata
>;
export type SchemaDefinitions = Record<string, TableDefinition>;
export type InputDefinitions = Record<
  string,
  Record<string, Exclude<ColumnInput, undefined> | LinkMetadata>
>;
export type MatchingTable<Definition, Columns> = {
  [Name in keyof Definition & string]: [Definition[Name]] extends [Columns]
    ? [Columns] extends [Definition[Name]]
      ? Name
      : never
    : never;
}[keyof Definition & string];
/** Condition relations declared with `.relations()`, read from the table's phantom key. */
export type ConditionDeclarations<Columns> = Columns extends {
  readonly [TABLE_RELATIONS]: infer Declarations;
}
  ? Declarations
  : {};
/** A condition target is a schema name (keyed link) or a column record matched to its table. */
export type ConditionTargetName<Definition, Target> = Target extends string
  ? Target
  : MatchingTable<Definition, Target>;
export type NormalizedConditions<Definition, Columns> = Columns extends {
  readonly [TABLE_RELATIONS]: infer Declarations;
}
  ? {
      readonly [TABLE_RELATIONS]: {
        [Name in keyof Declarations]: Declarations[Name] extends ConditionRelation<
          infer Target,
          infer Many,
          infer Inverse
        >
          ? ConditionRelation<
              ConditionTargetName<Definition, Target>,
              Many,
              Inverse
            >
          : never;
      };
    }
  : {};
/** The slots a table body declares. */
export type SlotKeys<Columns> = {
  [Key in keyof Columns & string]: Columns[Key] extends Slot ? Key : never;
}[keyof Columns & string];
/** Slots of `Columns` that a reference or a many-to-many declaration in any table claims by name. */
export type ClaimedSlots<Definition, Columns> = {
  [Name in keyof Definition]: {
    [Key in keyof Definition[Name]]: Definition[Name][Key] extends ReferenceBuilder<
      infer Target,
      infer Flags
    >
      ? [Target] extends [Columns]
        ? [Columns] extends [Target]
          ?
              | (Flags extends { inverse: infer Inverse extends string }
                  ? Inverse
                  : never)
              | (Flags extends { through: infer Through extends string }
                  ? Through
                  : never)
          : never
        : never
      : Definition[Name][Key] extends ManyThrough<
            infer Target,
            infer SlotKey,
            unknown
          >
        ? [Target] extends [Columns]
          ? [Columns] extends [Target]
            ? SlotKey
            : never
          : never
        : never;
  }[keyof Definition[Name]];
}[keyof Definition];
/**
 * `maybe(self.children)`: the property name cannot be read from `self`, so the
 * claim takes the table's one slot that nothing else claims.
 */
export type SelfSlotFlags<
  Definition,
  Name extends keyof Definition,
  Flags,
> = Flags extends { selfSlot: true }
  ? Exclude<
      SlotKeys<Definition[Name]>,
      ClaimedSlots<Definition, Definition[Name]>
    > extends infer Key extends string
    ? [Key] extends [never]
      ? Flags
      : IsUnion<Key> extends true
        ? Flags
        : Flags & { inverse: Key } & (Definition[Name][Key &
              keyof Definition[Name]] extends Slot<"one">
              ? { unique: true }
              : {})
    : Flags
  : Flags;
/** `tags: many(tags.posts)` declarations: the junction tables schema() adds. */
export type ThroughEntries<Definition> = {
  [Name in keyof Definition & string]: {
    [Key in keyof Definition[Name] &
      string]: Definition[Name][Key] extends ManyThrough<
      infer Target,
      infer SlotKey,
      infer Extra
    >
      ? {
          source: Name;
          key: Key;
          target: MatchingTable<Definition, Target>;
          slot: SlotKey;
          extra: Extra;
        }
      : never;
  }[keyof Definition[Name] & string];
}[keyof Definition & string];
export type ThroughEntry = {
  source: string;
  key: string;
  target: string;
  slot: string;
  extra: unknown;
};
/**
 * The junction of `posts.tags: many(tags.posts)` is `postsTags`: a reference
 * to each table, keyed by the name the other side knows its rows by.
 */
export type AutoJunctions<Entries extends ThroughEntry> = {
  [Entry in Entries as `${Entry["source"]}${Capitalize<Entry["key"]>}`]: JunctionColumns<
    {
      [Key in Entry["slot"]]: LinkMetadata<
        Entry["source"],
        { through: Entry["key"] }
      >;
    } & {
      [Key in Entry["key"]]: LinkMetadata<
        Entry["target"],
        { through: Entry["slot"] }
      >;
    } & Entry["extra"]
  >;
};
export type NormalizeDefinitions<Definition extends InputDefinitions> =
  Definition extends SchemaDefinitions
    ? Definition
    : NormalizedTables<Definition> &
        ([ThroughEntries<Definition>] extends [never]
          ? unknown
          : AutoJunctions<ThroughEntries<Definition>>);
export type NormalizedTables<Definition extends InputDefinitions> = {
  [Name in keyof Definition]: {
    [ColumnName in keyof Definition[Name] &
      string as Definition[Name][ColumnName] extends Marker
      ? never
      : ColumnName]: Definition[Name][ColumnName] extends Column | LinkMetadata
      ? Definition[Name][ColumnName]
      : Definition[Name][ColumnName] extends SelfReference<infer Flags>
        ? LinkMetadata<Name & string, SelfSlotFlags<Definition, Name, Flags>>
        : Definition[Name][ColumnName] extends ReferenceBuilder<
              infer TargetColumns,
              infer Flags
            >
          ? LinkMetadata<MatchingTable<Definition, TargetColumns>, Flags>
          : Definition[Name][ColumnName] extends
                | Table<infer TargetColumns>
                | (() => Table<infer TargetColumns>)
            ? LinkMetadata<MatchingTable<Definition, TargetColumns>, {}>
            : never;
  } & Pick<
    Definition[Name],
    Exclude<Extract<keyof Definition[Name], symbol>, typeof TABLE_RELATIONS>
  > &
    NormalizedConditions<Definition, Definition[Name]>;
};
export type StringKeys<Value> = keyof Value & string;
export type Simplify<Value> = {
  [PropertyName in keyof Value]: Value[PropertyName];
} & {};
export type ReferenceColumnNames<Columns> = {
  [ColumnName in StringKeys<Columns>]: Columns[ColumnName] extends LinkMetadata
    ? ColumnName
    : never;
}[StringKeys<Columns>];
export type ReferenceTarget<Reference> =
  Reference extends LinkMetadata<infer TableName, LinkOptions>
    ? TableName
    : never;
export type ReferenceOptions<Reference> =
  Reference extends LinkMetadata<string, infer Options> ? Options : {};
export type ColumnMetadata<Definition> =
  Definition extends Column<infer Metadata> ? Metadata : never;
// A conditional (not a plain union alias) so editors print the resolved value
// type, such as `"cart" | "paid"`, instead of `ColumnValue<Column<…>>`.
export type ColumnValue<Definition> =
  Definition extends Column<infer Metadata>
    ? Metadata["notNull"] extends false
      ? Metadata["valueType"] | null
      : Metadata["valueType"]
    : never;
/** What a write accepts: a jsonb(schema)'s input type, otherwise the read type. */
export type ColumnWriteValue<Definition> =
  Definition extends Column<infer Metadata>
    ? Metadata["notNull"] extends false
      ? ColumnInputType<Metadata> | null
      : ColumnInputType<Metadata>
    : never;
export type PrimaryKeyValue<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
> = ColumnMetadata<
  Definition[TableName][PrimaryKeyNames<Definition[TableName]>[number] &
    keyof Definition[TableName]]
>["valueType"];

/** The value a reference column stores: the target's primary key or its `by()` column. */
export type ReferencedValue<Definition extends SchemaDefinitions, Reference> =
  ReferenceOptions<Reference> extends { by: infer By extends string }
    ? ColumnMetadata<
        Definition[ReferenceTarget<Reference> & StringKeys<Definition>][By &
          keyof Definition[ReferenceTarget<Reference> & StringKeys<Definition>]]
      >["valueType"]
    : PrimaryKeyValue<
        Definition,
        ReferenceTarget<Reference> & StringKeys<Definition>
      >;
/** The `by()` column of a reference, or undefined when it targets the primary key. */
export type ReferenceBy<Reference> =
  ReferenceOptions<Reference> extends { by: infer By extends string }
    ? By
    : undefined;
/** For an M:N relation, the `by()` column of the junction's reference to the target. */
export type ThroughBy<
  Definition extends SchemaDefinitions,
  Origin,
> = Origin extends `through:${infer Junction}.${infer ColumnName}`
  ? ReferenceBy<
      Definition[Junction & StringKeys<Definition>][Exclude<
        ReferenceColumnNames<Definition[Junction & StringKeys<Definition>]>,
        ColumnName
      > &
        keyof Definition[Junction & StringKeys<Definition>]]
    >
  : undefined;

/** The row a read returns; with `Write`, the values a write accepts (a jsonb(schema)'s input). */
export type Row<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
  Write extends boolean = false,
> = Simplify<
  {
    [ColumnName in Exclude<
      StringKeys<Definition[TableName]>,
      ReferenceColumnNames<Definition[TableName]>
    >]: Write extends true
      ? ColumnWriteValue<Definition[TableName][ColumnName]>
      : ColumnValue<Definition[TableName][ColumnName]>;
  } & {
    [ColumnName in ReferenceColumnNames<
      Definition[TableName]
    > as `${ColumnName}Id`]:
      | ReferencedValue<Definition, Definition[TableName][ColumnName]>
      | (ReferenceOptions<Definition[TableName][ColumnName]> extends {
          nullable: true;
        }
          ? null
          : never);
  }
>;

export type OptionalColumnNames<Columns> = {
  [ColumnName in StringKeys<Columns>]: Columns[ColumnName] extends LinkMetadata
    ? ReferenceOptions<Columns[ColumnName]> extends { nullable: true }
      ? `${ColumnName}Id`
      : never
    : ColumnMetadata<Columns[ColumnName]>["hasDefault"] extends true
      ? ColumnName
      : ColumnMetadata<Columns[ColumnName]>["notNull"] extends false
        ? ColumnName
        : never;
}[StringKeys<Columns>];

export type GeneratedColumns<Columns> = {
  [ColumnName in StringKeys<Columns>]: Columns[ColumnName] extends Column<
    infer Metadata
  >
    ? Metadata extends { generated: true } | { computed: true }
      ? ColumnName
      : never
    : never;
}[StringKeys<Columns>];
/** Writes accept safe integers wherever a column stores bigint, including bigint arrays. */
export type Insert<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
> = Writable<
  Omit<
    Row<Definition, TableName, true>,
    | OptionalColumnNames<Definition[TableName]>
    | GeneratedColumns<Definition[TableName]>
  > &
    Omittable<
      Pick<
        Row<Definition, TableName, true>,
        Exclude<
          OptionalColumnNames<Definition[TableName]>,
          GeneratedColumns<Definition[TableName]>
        > &
          keyof Row<Definition, TableName, true>
      >
    > & { [ColumnName in GeneratedColumns<Definition[TableName]>]?: undefined }
> &
  SearchEmbeddings<Definition[TableName]>;

/** The embedding of each search that matches meaning; computed by its model unless given. */
type SearchEmbeddings<Columns> = Columns extends {
  readonly [TABLE_SEARCH]: infer Searches;
}
  ? {
      [Name in keyof Searches as Searches[Name] extends {
        readonly meaning: true;
      }
        ? Name
        : never]?: readonly number[] | null | undefined;
    }
  : {};

export type IsUnion<Member, EntireUnion = Member> = Member extends EntireUnion
  ? [EntireUnion] extends [Member]
    ? false
    : true
  : never;
export type DirectReferenceErrors<Definition extends InputDefinitions> = {
  [Name in keyof Definition & string]: {
    [ColumnName in keyof Definition[Name] &
      string]: Definition[Name][ColumnName] extends
      | Column
      | LinkMetadata
      | SelfReference<ReferenceFlags>
      | Marker
      ? never
      : NormalizedTables<Definition>[Name][ColumnName &
            keyof NormalizedTables<Definition>[Name]] extends LinkMetadata<
            infer Target
          >
        ? [Target] extends [never]
          ? `${Name}.${ColumnName}`
          : IsUnion<Target> extends true
            ? `${Name}.${ColumnName}`
            : never
        : never;
  }[keyof Definition[Name] & string];
}[keyof Definition & string];
export type ValidateDirectReferences<Definition extends InputDefinitions> =
  Definition extends SchemaDefinitions
    ? unknown
    : [DirectReferenceErrors<Definition>] extends [never]
      ? unknown
      : {
          readonly "Ambiguous or missing table reference; use a keyed callback or branded primary keys": DirectReferenceErrors<Definition>;
        };
/** Only junction() declarations expose M:N through relations. */
export type IsJunctionTable<Columns> = Columns extends {
  readonly [TABLE_JUNCTION]: true;
}
  ? true
  : false;

export type RelationDefinition<Name, Target, Many, Nullable, Origin> = {
  name: Name;
  target: Target;
  many: Many;
  nullable: Nullable;
  origin: Origin;
};

export type ForwardRelations<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
> = {
  [ColumnName in ReferenceColumnNames<
    Definition[TableName]
  >]: RelationDefinition<
    ColumnName,
    ReferenceTarget<Definition[TableName][ColumnName]>,
    false,
    ReferenceOptions<Definition[TableName][ColumnName]> extends {
      nullable: true;
    }
      ? true
      : false,
    `forward:${TableName}.${ColumnName}`
  >;
}[ReferenceColumnNames<Definition[TableName]>];

export type ReverseRelationName<Reference, Source, Destination> =
  ReferenceOptions<Reference> extends { inverse: infer Name extends string }
    ? Name
    : Source extends Destination
      ? never
      : Source;

/**
 * A junction of a table with itself (followers / following): both keys point
 * at one table, so their reverse collections would share the junction's name
 * there. It has none; its rows are read through the junction table.
 */
export type IsSelfJunction<Columns> =
  IsJunctionTable<Columns> extends true
    ? IsUnion<
        ReferenceTarget<Columns[ReferenceColumnNames<Columns>]>
      > extends true
      ? false
      : true
    : false;

export type ReverseEdges<
  Definition extends SchemaDefinitions,
  SourceName extends StringKeys<Definition>,
> =
  IsSelfJunction<Definition[SourceName]> extends true
    ? never
    : PlainReverseEdges<Definition, SourceName>;

export type PlainReverseEdges<
  Definition extends SchemaDefinitions,
  SourceName extends StringKeys<Definition>,
> = {
  [ColumnName in ReferenceColumnNames<Definition[SourceName]>]: [
    ReverseRelationName<
      Definition[SourceName][ColumnName],
      SourceName,
      ReferenceTarget<Definition[SourceName][ColumnName]>
    >,
  ] extends [never]
    ? never
    : RelationDefinition<
        ReverseRelationName<
          Definition[SourceName][ColumnName],
          SourceName,
          ReferenceTarget<Definition[SourceName][ColumnName]>
        >,
        SourceName,
        ReferenceOptions<Definition[SourceName][ColumnName]> extends {
          unique: true;
        }
          ? false
          : true,
        ReferenceOptions<Definition[SourceName][ColumnName]> extends {
          unique: true;
        }
          ? true
          : false,
        `reverse:${SourceName}.${ColumnName}`
      > & { owner: ReferenceTarget<Definition[SourceName][ColumnName]> };
}[ReferenceColumnNames<Definition[SourceName]>];

export type JunctionEdges<
  Definition extends SchemaDefinitions,
  JunctionName extends StringKeys<Definition>,
> =
  IsJunctionTable<Definition[JunctionName]> extends true
    ? {
        [ColumnName in ReferenceColumnNames<
          Definition[JunctionName]
        >]: RelationDefinition<
          // Named by the declaration (`tags: many(tags.posts)`), else after the other table.
          ReferenceOptions<Definition[JunctionName][ColumnName]> extends {
            through: infer Through extends string;
          }
            ? Through
            : ReferenceTarget<
                Definition[JunctionName][Exclude<
                  ReferenceColumnNames<Definition[JunctionName]>,
                  ColumnName
                >]
              >,
          ReferenceTarget<
            Definition[JunctionName][Exclude<
              ReferenceColumnNames<Definition[JunctionName]>,
              ColumnName
            >]
          >,
          true,
          false,
          `through:${JunctionName}.${ColumnName}`
        > & { owner: ReferenceTarget<Definition[JunctionName][ColumnName]> };
      }[ReferenceColumnNames<Definition[JunctionName]>]
    : never;

/** Edges of `.relations()` declarations: the forward side and, with `.inverse()`, a collection on the target. */
export type ConditionEdges<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
> = {
  [Name in keyof ConditionDeclarations<Definition[TableName]> &
    string]: ConditionDeclarations<
    Definition[TableName]
  >[Name] extends ConditionRelation<infer Target, infer Many, infer Inverse>
    ?
        | (RelationDefinition<
            Name,
            ConditionTargetName<Definition, Target>,
            Many,
            true,
            `condition:${TableName}.${Name}`
          > & { owner: TableName })
        | (Inverse extends string
            ? RelationDefinition<
                Inverse,
                TableName,
                true,
                true,
                `condition-reverse:${TableName}.${Name}`
              > & { owner: ConditionTargetName<Definition, Target> }
            : never)
    : never;
}[keyof ConditionDeclarations<Definition[TableName]> & string];

export type RelationEdges<Definition extends SchemaDefinitions> = {
  [TableName in StringKeys<Definition>]:
    | (ForwardRelations<Definition, TableName> & { owner: TableName })
    | ReverseEdges<Definition, TableName>
    | JunctionEdges<Definition, TableName>
    | ConditionEdges<Definition, TableName>;
}[StringKeys<Definition>];
export type EdgesByOwner<Definition extends SchemaDefinitions> = {
  [Edge in RelationEdges<Definition> as Edge["owner"] & string]: Edge;
};
export type RelationMap = Record<
  string,
  Record<
    string,
    {
      target: string;
      many: boolean;
      nullable: boolean;
    }
  >
>;
export type GraphFromGroups<
  TableNames extends string,
  Groups extends Record<
    string,
    RelationDefinition<string, string, boolean, boolean, string>
  >,
> = {
  [TableName in TableNames]: {
    [Relation in Groups[TableName] as Relation["name"] & string]: Relation &
      RelationDefinition<string, string, boolean, boolean, string>;
  };
};
// Pad absent owners once; a conditional inside each table's mapped type makes
// contextual schema inference re-evaluate the entire graph quadratically.
export type RelationGraph<Definition extends SchemaDefinitions> =
  GraphFromGroups<
    StringKeys<Definition>,
    EdgesByOwner<Definition> & {
      [TableName in Exclude<
        StringKeys<Definition>,
        keyof EdgesByOwner<Definition>
      >]: never;
    }
  >;

export type AmbiguousRelationNames<Relations extends RelationMap> = {
  [TableName in StringKeys<Relations>]: {
    [RelationName in StringKeys<Relations[TableName]>]: IsUnion<
      Relations[TableName][RelationName]
    > extends true
      ? `${TableName}.${RelationName}`
      : never;
  }[StringKeys<Relations[TableName]>];
}[StringKeys<Relations>];

export type ValidateSchema<Definition extends SchemaDefinitions> = [
  AmbiguousRelationNames<RelationGraph<Definition>>,
] extends [never]
  ? unknown
  : {
      readonly "Name ambiguous inverse relations with .inverse()": AmbiguousRelationNames<
        RelationGraph<Definition>
      >;
    };

/** Slots no table claims: `${table}.${slot}`. */
export type UnclaimedSlots<Definition extends InputDefinitions> = {
  [Name in keyof Definition & string]: {
    [Key in SlotKeys<Definition[Name]>]: Key extends keyof RelationGraph<
      NormalizeDefinitions<Definition>
    >[Name & StringKeys<NormalizeDefinitions<Definition>>]
      ? never
      : `${Name}.${Key}`;
  }[SlotKeys<Definition[Name]>];
}[keyof Definition & string];
export type ValidateSlots<Definition extends InputDefinitions> =
  Definition extends SchemaDefinitions
    ? unknown
    : [UnclaimedSlots<Definition>] extends [never]
      ? unknown
      : {
          readonly "A slot is never claimed; on the other table write one(<table>.<slot>), maybe(...) or many(...)": UnclaimedSlots<Definition>;
        };
