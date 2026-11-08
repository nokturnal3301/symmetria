/**
 * Table identity comes from object keys. References carry
 * only that key, so contextual typing does not depend on another table's body.
 * Runtime lowering reuses the snapshot assembler; queries use the typed graph.
 */
import { extendBuilder } from "../query/expressions/callable";
import {
  COLUMN_CODEC,
  isColumn,
  type ColumnMetadata as ColumnTypeMetadata,
  type Column,
  builderExample,
} from "./column";
import {
  assembleSchema,
  type Casing,
  type ConditionRelationInput,
  type SchemaOverrides,
  type SchemaSnapshot,
} from "./assembly";
import {
  CONDITION,
  conditionRelations,
  declaredConditions,
  type TableRelationCallback,
} from "./conditions";
import {
  table,
  junction,
  TABLE,
  type TABLE_JUNCTION,
  isTable,
  isReferenceInput,
  tableState,
  type ColumnInput,
  type ReferenceFlags,
  type Table,
  type TableHandle,
  type TableIndexCallback,
  type TableCheckCallback,
  type PrimaryKeyNames,
  type TABLE_UNIQUE_KEYS,
  type TABLE_RELATIONS,
  type ConditionRelation,
  type ReferenceableColumnNames,
  draftBinding,
  type ReferenceBuilder,
  type SelfReference,
  type TableState,
} from "./table";
import {
  and,
  createQueryTables,
  createScope,
  type QueryTable,
  type QueryExecutor,
  type Driver,
  type Columns,
  type Predicate,
  type RuntimeScope,
  type TableScopes,
} from "../query/select";
import { codecMap, encodeValue, type RuntimeCodec } from "../query/codecs";
import { quoteIdentifier } from "../query/compile";
import {
  applyIndexes,
  createIndexQuery,
  index,
  type IndexDefinition,
  type IndexQuery,
  type CreateIndexesOptions,
} from "./indexes";
import type {
  ConnectionHold,
  TransactionDriver,
  TransactionOptions,
} from "../query/plan/types";
import { applyChecks } from "./checks";
import { SCHEMA_BIND } from "./binding";
import { computedFields, type ComputedCallback } from "./computed";
import { createNestedInsert } from "../query/write/nested-inserts";
import type { NestedInsertQuery } from "../query/write/mutations";
import { executorProfiling } from "../observability/profiling";
import { isRetryableTransactionError } from "../driver/errors";
import type { Omittable, Writable } from "./infer";

const LINK = Symbol("symmetria.schema.link");
export type LinkOptions = {
  [OptionName in keyof ReferenceFlags]?: ReferenceFlags[OptionName] | undefined;
} & { inverse?: string | undefined };

export type LinkMetadata<
  TableName extends string = string,
  Options extends LinkOptions = LinkOptions,
  KeyValue = unknown,
  Shape = unknown,
> = {
  readonly [LINK]: {
    readonly target: TableName;
    readonly flags: Options;
    readonly keyValue?: KeyValue;
    /** The target's column record when it is declared without a callback; lets `to(link)` type its scope. */
    readonly shape?: Shape;
  };
};

export interface Link<
  TableName extends string,
  Nullable extends boolean = false,
  Unique extends boolean = false,
  InverseName extends string | undefined = undefined,
  KeyValue = unknown,
  Shape = unknown,
  By extends string | undefined = undefined,
> extends LinkMetadata<
    TableName,
    { nullable: Nullable; unique: Unique; inverse: InverseName; by: By },
    KeyValue,
    Shape
  > {
  readonly nullable: Link<
    TableName,
    true,
    Unique,
    InverseName,
    KeyValue,
    Shape
  >;
  readonly unique: Link<
    TableName,
    Nullable,
    true,
    InverseName,
    KeyValue,
    Shape
  >;
  readonly index: Link<
    TableName,
    Nullable,
    Unique,
    InverseName,
    KeyValue,
    Shape
  >;
  readonly inverse: <const RelationName extends string>(
    name: RelationName,
  ) => Link<TableName, Nullable, Unique, RelationName, KeyValue, Shape, By>;
  /** Reference a unique column instead of the primary key. */
  readonly by: <
    const Name extends unknown extends Shape
      ? string
      : ReferenceableColumnNames<Shape>,
  >(
    name: Name,
  ) => Link<TableName, Nullable, Unique, InverseName, KeyValue, Shape, Name>;
  /** Name the foreign-key column in SQL; the TypeScript name stays `<key>Id`. */
  readonly column: (
    sqlName: string,
  ) => Link<TableName, Nullable, Unique, InverseName, KeyValue, Shape, By>;
  readonly onDelete: {
    readonly cascade: Link<
      TableName,
      Nullable,
      Unique,
      InverseName,
      KeyValue,
      Shape,
      By
    >;
    readonly restrict: Link<
      TableName,
      Nullable,
      Unique,
      InverseName,
      KeyValue,
      Shape,
      By
    >;
    readonly noAction: Link<
      TableName,
      Nullable,
      Unique,
      InverseName,
      KeyValue,
      Shape,
      By
    >;
    readonly setNull: Link<
      TableName,
      true,
      Unique,
      InverseName,
      KeyValue,
      Shape,
      By
    >;
  };
  /** `ON UPDATE` action, for example `.onUpdate.cascade` as Prisma declares it. */
  readonly onUpdate: {
    readonly cascade: Link<
      TableName,
      Nullable,
      Unique,
      InverseName,
      KeyValue,
      Shape,
      By
    >;
    readonly restrict: Link<
      TableName,
      Nullable,
      Unique,
      InverseName,
      KeyValue,
      Shape,
      By
    >;
    readonly noAction: Link<
      TableName,
      Nullable,
      Unique,
      InverseName,
      KeyValue,
      Shape,
      By
    >;
  };
}

type TableReferences<
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
type KeyInference<Value> =
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
type TableDefinition = Record<
  string,
  Column<ColumnTypeMetadata> | LinkMetadata
>;
type SchemaDefinitions = Record<string, TableDefinition>;
type InputDefinitions = Record<
  string,
  Record<string, Exclude<ColumnInput, undefined> | LinkMetadata>
>;
type MatchingTable<Definition, Columns> = {
  [Name in keyof Definition & string]: [Definition[Name]] extends [Columns]
    ? [Columns] extends [Definition[Name]]
      ? Name
      : never
    : never;
}[keyof Definition & string];
/** Condition relations declared with `.relations()`, read from the table's phantom key. */
type ConditionDeclarations<Columns> = Columns extends {
  readonly [TABLE_RELATIONS]: infer Declarations;
}
  ? Declarations
  : {};
/** A condition target is a schema name (keyed link) or a column record matched to its table. */
type ConditionTargetName<Definition, Target> = Target extends string
  ? Target
  : MatchingTable<Definition, Target>;
type NormalizedConditions<Definition, Columns> = Columns extends {
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
type NormalizeDefinitions<Definition extends InputDefinitions> =
  Definition extends SchemaDefinitions
    ? Definition
    : {
        [Name in keyof Definition]: {
          [ColumnName in keyof Definition[Name] &
            string]: Definition[Name][ColumnName] extends Column | LinkMetadata
            ? Definition[Name][ColumnName]
            : Definition[Name][ColumnName] extends SelfReference<infer Flags>
              ? LinkMetadata<Name & string, Flags>
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
          Exclude<
            Extract<keyof Definition[Name], symbol>,
            typeof TABLE_RELATIONS
          >
        > &
          NormalizedConditions<Definition, Definition[Name]>;
      };
type StringKeys<Value> = keyof Value & string;
type Simplify<Value> = {
  [PropertyName in keyof Value]: Value[PropertyName];
} & {};
type ReferenceColumnNames<Columns> = {
  [ColumnName in StringKeys<Columns>]: Columns[ColumnName] extends LinkMetadata
    ? ColumnName
    : never;
}[StringKeys<Columns>];
type ReferenceTarget<Reference> =
  Reference extends LinkMetadata<infer TableName, LinkOptions>
    ? TableName
    : never;
type ReferenceOptions<Reference> =
  Reference extends LinkMetadata<string, infer Options> ? Options : {};
type ColumnMetadata<Definition> =
  Definition extends Column<infer Metadata> ? Metadata : never;
// A conditional (not a plain union alias) so editors print the resolved value
// type, such as `"cart" | "paid"`, instead of `ColumnValue<Column<…>>`.
type ColumnValue<Definition> =
  Definition extends Column<infer Metadata>
    ? Metadata["notNull"] extends false
      ? Metadata["valueType"] | null
      : Metadata["valueType"]
    : never;
type PrimaryKeyValue<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
> = ColumnMetadata<
  Definition[TableName][PrimaryKeyNames<Definition[TableName]>[number] &
    keyof Definition[TableName]]
>["valueType"];

/** The value a reference column stores: the target's primary key or its `by()` column. */
type ReferencedValue<Definition extends SchemaDefinitions, Reference> =
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
type ReferenceBy<Reference> =
  ReferenceOptions<Reference> extends { by: infer By extends string }
    ? By
    : undefined;
/** For an M:N relation, the `by()` column of the junction's reference to the target. */
type ThroughBy<
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

export type Row<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
> = Simplify<
  {
    [ColumnName in Exclude<
      StringKeys<Definition[TableName]>,
      ReferenceColumnNames<Definition[TableName]>
    >]: ColumnValue<Definition[TableName][ColumnName]>;
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

type OptionalColumnNames<Columns> = {
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

type GeneratedColumns<Columns> = {
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
    Row<Definition, TableName>,
    | OptionalColumnNames<Definition[TableName]>
    | GeneratedColumns<Definition[TableName]>
  > &
    Omittable<
      Pick<
        Row<Definition, TableName>,
        Exclude<
          OptionalColumnNames<Definition[TableName]>,
          GeneratedColumns<Definition[TableName]>
        > &
          keyof Row<Definition, TableName>
      >
    > & { [ColumnName in GeneratedColumns<Definition[TableName]>]?: undefined }
>;

type IsUnion<Member, EntireUnion = Member> = Member extends EntireUnion
  ? [EntireUnion] extends [Member]
    ? false
    : true
  : never;
type DirectReferenceErrors<Definition extends InputDefinitions> = {
  [Name in keyof Definition & string]: {
    [ColumnName in keyof Definition[Name] &
      string]: Definition[Name][ColumnName] extends
      | Column
      | LinkMetadata
      | SelfReference<ReferenceFlags>
      ? never
      : NormalizeDefinitions<Definition>[Name][ColumnName] extends LinkMetadata<
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
type ValidateDirectReferences<Definition extends InputDefinitions> =
  Definition extends SchemaDefinitions
    ? unknown
    : [DirectReferenceErrors<Definition>] extends [never]
      ? unknown
      : {
          readonly "Ambiguous or missing table reference; use a keyed callback or branded primary keys": DirectReferenceErrors<Definition>;
        };
/** Only junction() declarations expose M:N through relations. */
type IsJunctionTable<Columns> = Columns extends {
  readonly [TABLE_JUNCTION]: true;
}
  ? true
  : false;

type RelationDefinition<Name, Target, Many, Nullable, Origin> = {
  name: Name;
  target: Target;
  many: Many;
  nullable: Nullable;
  origin: Origin;
};

type ForwardRelations<
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

type ReverseRelationName<Reference, Source, Destination> =
  ReferenceOptions<Reference> extends { inverse: infer Name extends string }
    ? Name
    : Source extends Destination
      ? never
      : Source;

type ReverseEdges<
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

type JunctionEdges<
  Definition extends SchemaDefinitions,
  JunctionName extends StringKeys<Definition>,
> =
  IsJunctionTable<Definition[JunctionName]> extends true
    ? {
        [ColumnName in ReferenceColumnNames<
          Definition[JunctionName]
        >]: RelationDefinition<
          ReferenceTarget<
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
type ConditionEdges<
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

type RelationEdges<Definition extends SchemaDefinitions> = {
  [TableName in StringKeys<Definition>]:
    | (ForwardRelations<Definition, TableName> & { owner: TableName })
    | ReverseEdges<Definition, TableName>
    | JunctionEdges<Definition, TableName>
    | ConditionEdges<Definition, TableName>;
}[StringKeys<Definition>];
type EdgesByOwner<Definition extends SchemaDefinitions> = {
  [Edge in RelationEdges<Definition> as Edge["owner"] & string]: Edge;
};
type RelationMap = Record<
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
type GraphFromGroups<
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
type RelationGraph<Definition extends SchemaDefinitions> = GraphFromGroups<
  StringKeys<Definition>,
  EdgesByOwner<Definition> & {
    [TableName in Exclude<
      StringKeys<Definition>,
      keyof EdgesByOwner<Definition>
    >]: never;
  }
>;

type AmbiguousRelationNames<Relations extends RelationMap> = {
  [TableName in StringKeys<Relations>]: {
    [RelationName in StringKeys<Relations[TableName]>]: IsUnion<
      Relations[TableName][RelationName]
    > extends true
      ? `${TableName}.${RelationName}`
      : never;
  }[StringKeys<Relations[TableName]>];
}[StringKeys<Relations>];

type ValidateSchema<Definition extends SchemaDefinitions> = [
  AmbiguousRelationNames<RelationGraph<Definition>>,
] extends [never]
  ? unknown
  : {
      readonly "Name ambiguous inverse relations with .inverse()": AmbiguousRelationNames<
        RelationGraph<Definition>
      >;
    };

type QueryRows<Definition extends SchemaDefinitions> = {
  [TableName in StringKeys<Definition>]: Row<Definition, TableName>;
};

type UniqueColumnNames<Columns> = {
  [Name in keyof Columns & string]: Columns[Name] extends Column<infer Metadata>
    ? Metadata extends { unique: true }
      ? Name
      : never
    : Columns[Name] extends LinkMetadata<string, infer Options>
      ? Options extends { unique: true }
        ? `${Name}Id`
        : never
      : never;
}[keyof Columns & string];

type UniqueKeys<Columns> = {
  [Name in UniqueColumnNames<Columns>]: Name;
} & (Columns extends { readonly [TABLE_UNIQUE_KEYS]: infer Keys } ? Keys : {});

type KeyFields<Row, Names extends keyof Row> = {
  [Name in Names]: NonNullable<Row[Name]>;
};
type PrimaryConnect<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
  Names extends keyof Row<Definition, TableName> = PrimaryKeyNames<
    Definition[TableName]
  >[number] &
    keyof Row<Definition, TableName>,
> = [Names] extends [never]
  ? never
  :
      | KeyFields<Row<Definition, TableName>, Names>
      | (IsUnion<Names> extends true
          ? never
          : NonNullable<Row<Definition, TableName>[Names]>);

type ConnectValue<
  Definition extends SchemaDefinitions,
  TableName extends StringKeys<Definition>,
  By extends string | undefined = undefined,
> =
  | (By extends string
      ? // A reference through by(): the scalar is the referenced column's value.
          | NonNullable<
              Row<Definition, TableName>[By & keyof Row<Definition, TableName>]
            >
          | KeyFields<
              Row<Definition, TableName>,
              PrimaryKeyNames<Definition[TableName]>[number] &
                keyof Row<Definition, TableName>
            >
      : PrimaryConnect<Definition, TableName>)
  | {
      [Name in keyof UniqueKeys<Definition[TableName]>]: KeyFields<
        Row<Definition, TableName>,
        UniqueKeys<Definition[TableName]>[Name] &
          keyof Row<Definition, TableName>
      >;
    }[keyof UniqueKeys<Definition[TableName]>];

type NestedOne<
  Definition extends SchemaDefinitions,
  Relations extends RelationMap,
  TableName extends StringKeys<Definition> & StringKeys<Relations>,
  Omitted extends string = never,
  By extends string | undefined = undefined,
> =
  | {
      connect: ConnectValue<Definition, TableName, By>;
      create?: undefined;
      connectOrCreate?: undefined;
    }
  | {
      create: NestedInsert<Definition, Relations, TableName, Omitted>;
      connect?: undefined;
      connectOrCreate?: undefined;
    }
  | {
      connectOrCreate: Omit<Insert<Definition, TableName>, Omitted>;
      connect?: undefined;
      create?: undefined;
    };

type ForwardInputs<
  Definition extends SchemaDefinitions,
  Relations extends RelationMap,
  TableName extends StringKeys<Definition> & StringKeys<Relations>,
  Omitted extends string,
> = {
  [Name in ReferenceColumnNames<Definition[TableName]>]: (
    value: `${Name}Id` extends Omitted
      ? {}
      :
          | (Pick<
              Insert<Definition, TableName>,
              `${Name}Id` & keyof Insert<Definition, TableName>
            > & { [RelationName in Name]?: undefined })
          | ((`${Name}Id` extends OptionalColumnNames<Definition[TableName]>
              ? {
                  // A nullable reference may be omitted or `undefined` in the nested form too.
                  [RelationName in Name]?:
                    | NestedOne<
                        Definition,
                        Relations,
                        ReferenceTarget<Definition[TableName][Name]> &
                          StringKeys<Definition> &
                          StringKeys<Relations>,
                        never,
                        ReferenceBy<Definition[TableName][Name]>
                      >
                    | undefined;
                }
              : {
                  [RelationName in Name]: NestedOne<
                    Definition,
                    Relations,
                    ReferenceTarget<Definition[TableName][Name]> &
                      StringKeys<Definition> &
                      StringKeys<Relations>,
                    never,
                    ReferenceBy<Definition[TableName][Name]>
                  >;
                }) & { [ColumnName in `${Name}Id`]?: undefined }),
  ) => void;
}[ReferenceColumnNames<Definition[TableName]>] extends (
  value: infer Fields,
) => void
  ? Fields
  : never;

type NestedInsert<
  Definition extends SchemaDefinitions,
  Relations extends RelationMap,
  TableName extends StringKeys<Definition> & StringKeys<Relations>,
  Omitted extends string = never,
> = Omit<
  Insert<Definition, TableName>,
  `${ReferenceColumnNames<Definition[TableName]>}Id` | Omitted
> &
  ([ReferenceColumnNames<Definition[TableName]>] extends [never]
    ? {}
    : ForwardInputs<Definition, Relations, TableName, Omitted>) & {
    // Condition relations have no foreign key, so nested writes skip them.
    [Name in Exclude<
      keyof Relations[TableName] & string,
      ReferenceColumnNames<Definition[TableName]>
    > as Relations[TableName][Name] extends { origin: `condition${string}` }
      ? never
      : Name]?:
      | undefined
      | (Relations[TableName][Name] extends {
          target: infer Target extends StringKeys<Definition> &
            StringKeys<Relations>;
          many: infer Many;
          origin: infer Origin;
        }
          ? Many extends true
            ? {
                connect?:
                  | readonly ConnectValue<
                      Definition,
                      Target,
                      ThroughBy<Definition, Origin>
                    >[]
                  | undefined;
                create?:
                  | readonly NestedInsert<
                      Definition,
                      Relations,
                      Target,
                      Origin extends `reverse:${string}.${infer ReferenceName}`
                        ? `${ReferenceName}Id`
                        : never
                    >[]
                  | undefined;
                connectOrCreate?:
                  | readonly Omit<
                      Insert<Definition, Target>,
                      Origin extends `reverse:${string}.${infer ReferenceName}`
                        ? `${ReferenceName}Id`
                        : never
                    >[]
                  | undefined;
              }
            : NestedOne<
                Definition,
                Relations,
                Target,
                Origin extends `reverse:${string}.${infer ReferenceName}`
                  ? `${ReferenceName}Id`
                  : never
              >
          : never);
  };

export type SchemaOptions<
  Rows extends Record<string, Record<string, unknown>> = Record<
    string,
    Record<string, unknown>
  >,
> = {
  readonly executor?: QueryExecutor;
  readonly driver?: Driver;
  /** PostgreSQL extensions the schema needs (for example `["vector"]`); migrations create them first. */
  readonly extensions?: readonly string[];
  /**
   * How keys become SQL names. `"snake_case"` (default): `createdAt` →
   * `created_at`, `author` → `author_id`. `"preserve"`: keys are used as written,
   * `author` → `authorId`, the convention of databases created by Prisma.
   * `.named()` on a table or column overrides either rule.
   */
  readonly casing?: Casing;
  readonly indexes?: (
    scope: {
      readonly [TableName in keyof Rows]: Columns<Rows[TableName]>;
    },
  ) => Record<string, IndexDefinition>;
};

/** Per-table predicates applied to every read, update and delete of a scoped database. */
export type ScopeDefinitions<Definition extends SchemaDefinitions> = {
  readonly [TableName in StringKeys<Definition>]?: (
    columns: Columns<Row<Definition, TableName>>,
  ) => Predicate;
};

export type Database<
  Definition extends SchemaDefinitions,
  Relations extends RelationMap = RelationGraph<Definition>,
> = {
  readonly [TableName in StringKeys<Definition> &
    StringKeys<Relations>]: QueryTable<
    QueryRows<Definition>,
    Relations,
    TableName,
    Insert<Definition, TableName>,
    PrimaryKeyNames<Definition[TableName]>[number] &
      keyof QueryRows<Definition>[TableName] &
      string,
    UniqueKeys<Definition[TableName]>
  > & {
    readonly insert: {
      (
        values: readonly NestedInsert<Definition, Relations, TableName>[],
      ): NestedInsertQuery<QueryRows<Definition>[TableName], TableName, false>;
      (
        values: NestedInsert<Definition, Relations, TableName>,
      ): NestedInsertQuery<QueryRows<Definition>[TableName], TableName, true>;
    };
    readonly $name: string;
    /** Type-only row and insert shapes. */
    readonly $row: Row<Definition, TableName>;
    readonly $insert: Insert<Definition, TableName>;
  };
} & {
  readonly [SCHEMA_BIND]: (driver: Driver) => Database<Definition, Relations>;
  /** Tenant or visibility filters that follow the tables into joins, paths, collections and writes. */
  $scope: (
    scopes: ScopeDefinitions<Definition>,
  ) => Database<Definition, Relations>;
  $snapshot: () => SchemaSnapshot;
  $close: () => Promise<void>;
  $createIndexes: (options?: CreateIndexesOptions) => IndexQuery;
  $transaction: <Result>(
    callback: (
      transaction: TransactionDatabase<Definition, Relations>,
    ) => Promise<Result>,
    options?: TransactionOptions,
  ) => Promise<Result>;
};

declare const TRANSACTION_SCOPE: unique symbol;

export type TransactionDatabase<
  Definition extends SchemaDefinitions,
  Relations extends RelationMap = RelationGraph<Definition>,
> = Omit<
  Database<Definition, Relations>,
  "$close" | "$transaction" | "$createIndexes" | "$scope" | typeof SCHEMA_BIND
> & {
  /** Type-only distinction between a reserved transaction and a pool-bound database. */
  readonly [TRANSACTION_SCOPE]: true;
  readonly $scope: (
    scopes: ScopeDefinitions<Definition>,
  ) => TransactionDatabase<Definition, Relations>;
  readonly $transaction: <Result>(
    callback: (
      transaction: TransactionDatabase<Definition, Relations>,
    ) => Promise<Result>,
  ) => Promise<Result>;
  readonly $createIndexes: (
    options?: Omit<CreateIndexesOptions, "concurrently"> & {
      readonly concurrently?: false;
    },
  ) => IndexQuery;
};

/** Infer the transaction or savepoint context from a schema or connected database. */
export type Transaction<
  DatabaseInstance extends {
    readonly $transaction: (...argumentsList: never[]) => Promise<unknown>;
  },
> = Parameters<DatabaseInstance["$transaction"]>[0] extends (
  transaction: infer TransactionScope,
) => Promise<unknown>
  ? TransactionScope
  : never;

const createLink = (
  target: string,
  flags: LinkOptions,
): Link<string, boolean, boolean, string | undefined> => {
  const withOptions = (options: LinkOptions) =>
    createLink(target, { ...flags, ...options });

  const link = {
    [LINK]: Object.freeze({
      target,
      flags: Object.freeze({
        nullable: false,
        unique: false,
        inverse: undefined,
        ...flags,
      }),
    }),
    inverse: (name: string) => withOptions({ inverse: name }),
    by: (name: string) => withOptions({ by: name }),
    column: (sqlName: string) => withOptions({ column: sqlName }),
  };
  Object.defineProperties(link, {
    nullable: { enumerable: true, get: () => withOptions({ nullable: true }) },
    unique: { enumerable: true, get: () => withOptions({ unique: true }) },
    index: { enumerable: true, get: () => withOptions({ index: true }) },
    onDelete: {
      enumerable: true,
      get: () =>
        Object.freeze(
          Object.defineProperties(
            {},
            {
              cascade: {
                enumerable: true,
                get: () => withOptions({ onDelete: "cascade" }),
              },
              restrict: {
                enumerable: true,
                get: () => withOptions({ onDelete: "restrict" }),
              },
              noAction: {
                enumerable: true,
                get: () => withOptions({ onDelete: "no action" }),
              },
              setNull: {
                enumerable: true,
                get: () =>
                  withOptions({ onDelete: "set null", nullable: true }),
              },
            },
          ),
        ),
    },
    onUpdate: {
      enumerable: true,
      get: () =>
        Object.freeze(
          Object.defineProperties(
            {},
            {
              cascade: {
                enumerable: true,
                get: () => withOptions({ onUpdate: "cascade" }),
              },
              restrict: {
                enumerable: true,
                get: () => withOptions({ onUpdate: "restrict" }),
              },
              noAction: {
                enumerable: true,
                get: () => withOptions({ onUpdate: "no action" }),
              },
            },
          ),
        ),
    },
  });

  return Object.freeze(link) as Link<
    string,
    boolean,
    boolean,
    string | undefined
  >;
};

const isLink = (value: unknown): value is LinkMetadata => {
  return typeof value === "object" && value !== null && LINK in value;
};

/**
 * Infer key values and complete definitions through separate reverse maps.
 * Callback references can then carry scalar types without a circular dependency
 * on the complete relation graph.
 */
/** A thunk in a table body must yield a table; columns are declared directly. */
const resolveThunk = (
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

const describeValue = (value: unknown): string => {
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

const createSchema = <
  const TableNames extends string,
  const KeyValues extends Record<TableNames, unknown>,
  const Shapes extends Record<TableNames, unknown>,
  const Definition extends Record<
    TableNames,
    Record<string, Exclude<ColumnInput, undefined> | LinkMetadata>
  >,
>(
  definitions: Record<TableNames, unknown> & {
    // Column records of tables declared without a callback; keyed links carry them.
    [TableName in keyof Shapes]:
      | Shapes[TableName]
      | Table<Shapes[TableName]>
      | ((
          references: TableReferences<TableNames, KeyValues, Shapes>,
        ) => unknown);
  } & {
    [TableName in keyof KeyValues]:
      | KeyInference<KeyValues[TableName]>
      | ((
          references: TableReferences<TableNames, KeyValues, Shapes>,
        ) => KeyInference<KeyValues[TableName]>);
  } & {
    [TableName in keyof Definition]:
      | Definition[TableName]
      | Table<Definition[TableName]>
      | ((
          references: TableReferences<TableNames, KeyValues, Shapes>,
        ) => Definition[TableName] | Table<Definition[TableName]>);
  } & ValidateSchema<NormalizeDefinitions<NoInfer<Definition>>> &
    ValidateDirectReferences<NoInfer<Definition>>,
  options: SchemaOptions<
    NoInfer<QueryRows<NormalizeDefinitions<Definition>>>
  > = {},
): Database<NormalizeDefinitions<Definition>> => {
  const tableNames = Object.keys(definitions);
  const references = Object.freeze(
    Object.fromEntries(
      tableNames.map((tableName) => [tableName, createLink(tableName, {})]),
    ),
  );
  const tableIndexes = new Map<string, readonly TableIndexCallback[]>();
  const tableChecks = new Map<string, readonly TableCheckCallback[]>();
  const tableComputed = new Map<string, readonly ComputedCallback[]>();
  const tableSqlNames = new Map<string, string>();
  const tableRelations = new Map<string, readonly TableRelationCallback[]>();
  const primaryKeys = new Map<string, readonly string[]>();
  const junctionTables = new Set<string>();
  const tableNamesByState = new Map<TableState, string[]>();
  // Plain column records are tracked by identity so to(users) can name them too.
  const tableNamesByRecord = new Map<object, string[]>();
  const rawDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([tableName, definition]) => {
      const resolved =
        typeof definition === "function"
          ? definition(references as TableReferences<TableNames, KeyValues>)
          : definition;

      if (!isTable(resolved)) {
        if (resolved && typeof resolved === "object") {
          tableNamesByRecord.set(resolved, [
            ...(tableNamesByRecord.get(resolved) ?? []),
            tableName,
          ]);
        }

        return [tableName, resolved];
      }

      const state = tableState(resolved);
      tableNamesByState.set(state, [
        ...(tableNamesByState.get(state) ?? []),
        tableName,
      ]);
      tableIndexes.set(tableName, state.indexCallbacks);
      tableChecks.set(tableName, state.checkCallbacks);
      tableComputed.set(tableName, state.computedCallbacks);

      if (state.named !== undefined) {
        tableSqlNames.set(tableName, state.named);
      }
      tableRelations.set(tableName, state.relationCallbacks);

      if (state.primaryKey) {
        primaryKeys.set(tableName, state.primaryKey);
      }

      if (state.junction) {
        junctionTables.add(tableName);
      }

      return [tableName, state.columns];
    }),
  ) as Record<string, Record<string, unknown>>;
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

  for (const [tableName, definition] of Object.entries(tableDefinitions)) {
    if (!primaryKeys.has(tableName)) {
      const explicit = Object.entries(definition)
        .filter(
          ([, column]) => isColumn(column) && column.definition.primaryKey,
        )
        .map(([name]) => name);
      primaryKeys.set(
        tableName,
        junctionTables.has(tableName)
          ? Object.entries(definition)
              .filter(([, column]) => isLink(column))
              .map(([name]) => `${name}Id`)
          : explicit.length
            ? explicit
            : isColumn(definition.id)
              ? ["id"]
              : [],
      );
    }
  }

  const tableHandles: Record<
    string,
    TableHandle<Record<string, ColumnInput>>
  > = Object.create(null);
  const inverseRelations: Array<{
    target: string;
    name: string;
    source: string;
    column: string;
  }> = [];

  for (const [tableName, tableDefinition] of Object.entries(tableDefinitions)) {
    if (
      [
        "$snapshot",
        "$close",
        "$transaction",
        "$createIndexes",
        "__proto__",
        "constructor",
        "prototype",
      ].includes(tableName)
    ) {
      throw new Error(
        `symmetria experiment: reserved table name "${tableName}"`,
      );
    }

    const columns: Record<string, ColumnInput> = Object.create(null);
    const columnEntries = Object.entries(tableDefinition);
    const isJunction = junctionTables.has(tableName);

    for (const [columnName, value] of columnEntries) {
      if (isColumn(value)) {
        if (
          primaryKeys.get(tableName)!.includes(columnName) &&
          !value.definition.notNull
        ) {
          throw new Error(
            `symmetria: primary key "${tableName}.${columnName}" cannot be nullable`,
          );
        }

        columns[columnName] = value;
        continue;
      }

      if (!isLink(value)) {
        throw new Error(
          `symmetria experiment: invalid column "${tableName}.${columnName}"`,
        );
      }

      const { target, flags } = value[LINK];
      const targetDefinition = tableDefinitions[target];
      const targetKeys = primaryKeys.get(target) ?? [];

      if (!targetDefinition) {
        throw new Error(
          `symmetria: "${tableName}.${columnName}" references unknown table "${target}"`,
        );
      }

      if (flags.by !== undefined) {
        const referenced = targetDefinition[flags.by];

        if (
          !isColumn(referenced) ||
          !(
            referenced.definition.unique ||
            (targetKeys.length === 1 && targetKeys[0] === flags.by)
          )
        ) {
          throw new Error(
            `symmetria: "${tableName}.${columnName}" references "${target}.${flags.by}", which must be a unique column or the primary key`,
          );
        }
      } else if (
        targetKeys.length !== 1 ||
        !isColumn(targetDefinition[targetKeys[0]!])
      ) {
        throw new Error(
          `symmetria: "${tableName}.${columnName}" must reference a table with a single scalar primary key`,
        );
      }

      if (flags.inverse !== undefined) {
        if (isJunction) {
          throw new Error(
            "symmetria experiment: junction inverse renaming is not implemented",
          );
        }

        inverseRelations.push({
          target,
          name: flags.inverse,
          source: tableName,
          column: columnName,
        });
      }

      // Resolve all handles only after every table body has been evaluated.
      columns[columnName] = Object.freeze({
        kind: "reference",
        target: target === tableName ? "self" : () => tableHandles[target]!,
        flags: Object.freeze({ ...flags }),
      }) as unknown as ColumnInput;
    }

    tableHandles[tableName] = (
      isJunction ? junction(columns) : table(columns)
    ) as TableHandle<Record<string, ColumnInput>>;
    const named = tableSqlNames.get(tableName);

    if (named !== undefined) {
      tableHandles[tableName] = tableHandles[tableName]!.named(named);
    }
    const explicitKeys = primaryKeys.get(tableName)!;

    if (!isJunction && explicitKeys.length) {
      tableHandles[tableName] = tableHandles[tableName]!.primaryKey(
        (columns) => {
          const scope =
            columns as unknown as import("../query/select").RuntimeScope[string];

          return [
            scope[explicitKeys[0]!]!,
            ...explicitKeys.slice(1).map((name) => scope[name]!),
          ];
        },
      );
    }
  }

  const overrides: SchemaOverrides<typeof tableHandles> = Object.create(null);

  for (const inverseRelation of inverseRelations) {
    const tableOverrides = (overrides[inverseRelation.target] ??=
      Object.create(null));

    if (Object.hasOwn(tableOverrides, inverseRelation.name)) {
      throw new Error(
        `symmetria experiment: duplicate inverse "${inverseRelation.target}.${inverseRelation.name}"`,
      );
    }

    tableOverrides[inverseRelation.name] =
      tableHandles[inverseRelation.source]![inverseRelation.column]!;
  }

  // Condition relations: run the callbacks once against a draft binding to learn
  // names, targets and cardinality; the predicates themselves run per JOIN.
  const conditionTargetName = (
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
        target: conditionTargetName(tableName, name, state.target),
        many: state.many,
        ...(state.inverse !== undefined ? { inverse: state.inverse } : {}),
      };
    });
  }

  if (
    options.casing !== undefined &&
    options.casing !== "snake_case" &&
    options.casing !== "preserve"
  ) {
    throw new Error('symmetria: casing must be "snake_case" or "preserve"');
  }

  const snapshot = assembleSchema(
    tableHandles,
    overrides,
    conditions,
    options.casing,
  );

  if (options.extensions?.length) {
    for (const extension of options.extensions) {
      if (!/^[a-z_][a-z0-9_]*$/.test(extension)) {
        throw new Error(
          `symmetria: extension names are lowercase identifiers, not "${extension}"`,
        );
      }
    }

    snapshot.extensions = Object.freeze(
      [...new Set(options.extensions)].sort(),
    );
  }

  for (const table of snapshot.tables) {
    computedFields.set(table, tableComputed.get(table.name) ?? []);
    conditionRelations.set(table, tableRelations.get(table.name) ?? []);
  }

  if (options.executor && options.driver) {
    throw new Error("symmetria: supply either driver or executor");
  }

  const codecs: Record<
    string,
    Record<string, RuntimeCodec>
  > = Object.fromEntries(
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

  // Persist storage defaults; codecs themselves remain outside the snapshot.
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

  if (options.indexes) {
    applyIndexes(
      snapshot,
      codecs,
      options.indexes as unknown as (
        scope: import("../query/select").RuntimeScope,
      ) => Record<string, IndexDefinition>,
    );
  }

  // Junctions are traversed from both sides: unless a declared index already
  // leads with it, the second key column (not covered by the PK) gets its own index.
  for (const table of snapshot.tables) {
    const second = table.junction
      ? (table.primaryKey ??
          table.columns
            .filter((column) => column.primaryKey)
            .map((column) => column.name))[1]
      : undefined;
    const column = table.columns.find((column) => column.name === second);

    if (!second || !column) {
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
        (scope) => ({ [second]: index(scope[table.name]![second]!) }),
        table.name,
      );
    }
  }

  const bindDatabase = (
    executor?: QueryExecutor,
    transactionDriver?: TransactionDriver,
    driver: Driver | undefined = options.driver,
    scopes: TableScopes = {},
  ): object => {
    // Atomic multi-statement work (chunked bulk inserts): a savepoint inside a
    // transaction, otherwise a transaction of the configured driver.
    const atomicDriver = transactionDriver ?? driver;
    // Streams hold a connection for the whole iteration: the current
    // transaction's connection when there is one (a savepoint would block the
    // caller), otherwise a transaction of the configured driver.
    const hold: ConnectionHold | undefined = transactionDriver
      ? (run) => run(transactionDriver.execute)
      : driver?.transaction
        ? (run) => driver.transaction!((connection) => run(connection.execute))
        : undefined;
    const queryTables = createQueryTables(
      snapshot,
      executor,
      codecs,
      scopes,
      atomicDriver?.transaction
        ? (run) =>
            atomicDriver.transaction!((connection) => run(connection.execute))
        : undefined,
      hold,
    );
    const profile = executorProfiling(executor);

    const runTransaction = async <Result>(
      callback: (database: Record<string, unknown>) => Promise<Result>,
      options?: TransactionOptions,
    ): Promise<Result> => {
      const run = async (connection: TransactionDriver) =>
        callback(
          bindDatabase(
            connection.execute,
            connection,
            driver,
            scopes,
          ) as Record<string, unknown>,
        );

      if (transactionDriver) {
        if (options !== undefined) {
          throw new Error(
            "symmetria: transaction options cannot be changed inside a savepoint",
          );
        }

        return transactionDriver.transaction(run);
      }

      if (!driver?.transaction) {
        throw new Error(
          "symmetria: the configured driver does not support transactions",
        );
      }

      const { retries = 0, retryDelayMs = 10, ...settings } = options ?? {};

      if (!Number.isSafeInteger(retries) || retries < 0 || retries > 20) {
        throw new Error(
          "symmetria: retries must be an integer between 0 and 20",
        );
      }

      if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
        throw new Error(
          "symmetria: retryDelayMs must be a non-negative number",
        );
      }

      // Each attempt gets a fresh connection, BEGIN and bound database; the
      // callback must therefore be safe to run again.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await driver.transaction(
            run,
            options === undefined ? undefined : settings,
          );
        } catch (error) {
          if (attempt >= retries || !isRetryableTransactionError(error)) {
            throw error;
          }

          const delay = Math.random() * retryDelayMs * 2 ** attempt;

          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    };

    const databaseTables = Object.fromEntries(
      snapshot.tables.map((tableSnapshot) => {
        const relationNames = tableSnapshot.relations.map(
          (relation) => relation.name,
        );
        const table = extendBuilder(queryTables[tableSnapshot.name]!, {
          $name: tableSnapshot.sqlName,
          insert: (
            values:
              | Record<string, unknown>
              | readonly Record<string, unknown>[],
          ) => {
            const rows = Array.isArray(values) ? values : [values];

            if (
              rows.some(
                (row) =>
                  row &&
                  relationNames.some(
                    (name) =>
                      (row as Record<string, unknown>)[name] !== undefined,
                  ),
              )
            ) {
              return createNestedInsert(
                snapshot,
                tableSnapshot.name,
                values,
                runTransaction,
                codecs,
              );
            }

            // An omitted (undefined) relation keeps the flat, single-statement INSERT.
            const flat = (row: Record<string, unknown>) =>
              row && relationNames.some((name) => name in row)
                ? Object.fromEntries(
                    Object.entries(row).filter(
                      ([name]) => !relationNames.includes(name),
                    ),
                  )
                : row;

            return (
              queryTables[tableSnapshot.name] as {
                insert: (values: unknown) => object;
              }
            ).insert(
              Array.isArray(values)
                ? rows.map(flat)
                : flat(values as Record<string, unknown>),
            );
          },
        });

        return [
          tableSnapshot.name,
          profile ? profile.trackBuilder(table) : table,
        ];
      }),
    );

    type ScopeInput = Readonly<
      Record<string, ((columns: never) => Predicate) | undefined>
    >;

    const mergeScopes = (next: ScopeInput): TableScopes =>
      Object.fromEntries(
        [...new Set([...Object.keys(scopes), ...Object.keys(next)])].map(
          (tableName) => {
            if (!snapshot.tables.some((table) => table.name === tableName)) {
              throw new Error(
                `symmetria: $scope() received unknown table "${tableName}"`,
              );
            }

            const previous = scopes[tableName];
            const added = next[tableName] as TableScopes[string] | undefined;

            if (added !== undefined && typeof added !== "function") {
              throw new Error(
                `symmetria: $scope() expects a predicate callback for "${tableName}"`,
              );
            }

            return [
              tableName,
              previous && added
                ? (columns: RuntimeScope[string]) =>
                    and(previous(columns), added(columns))
                : (previous ?? added)!,
            ];
          },
        ),
      );

    return Object.freeze({
      ...databaseTables,
      ...(!transactionDriver
        ? {
            [SCHEMA_BIND]: (connection: Driver) =>
              bindDatabase(connection.execute, undefined, connection, scopes),
          }
        : {}),
      $scope: (next: ScopeInput) =>
        bindDatabase(executor, transactionDriver, driver, mergeScopes(next)),
      $snapshot: () => structuredClone(snapshot),
      $createIndexes: (settings?: CreateIndexesOptions) =>
        createIndexQuery(snapshot, executor, settings, !!transactionDriver),
      $transaction: runTransaction,
      ...(transactionDriver
        ? {}
        : {
            $close: async () => {
              await driver?.close();
            },
          }),
    });
  };

  return bindDatabase(options.executor ?? options.driver?.execute) as Database<
    NormalizeDefinitions<Definition>
  >;
};

type KeyValuesOf<Keys extends Record<string, Column<ColumnTypeMetadata>>> = {
  [Name in keyof Keys]: ColumnMetadata<Keys[Name]>["valueType"];
};

/** Anchor key types before checking mutually recursive table callbacks. */
const withKeys =
  <const Keys extends Record<string, Column<ColumnTypeMetadata>>>(keys: Keys) =>
  <const Definition extends Record<keyof Keys & string, TableDefinition>>(
    definitions: {
      [Name in keyof Definition]:
        | Definition[Name]
        | Table<Definition[Name]>
        | ((
            references: TableReferences<keyof Keys & string, KeyValuesOf<Keys>>,
          ) => Definition[Name] | Table<Definition[Name]>);
    } & ValidateSchema<NoInfer<Definition>>,
    options: SchemaOptions<NoInfer<QueryRows<Definition>>> = {},
  ): Database<Definition> => {
    for (const [name, key] of Object.entries(keys)) {
      if (!isColumn(key)) {
        throw new Error(
          "symmetria: schema.keys() expects primary-key column types",
        );
      }

      if (!Object.hasOwn(definitions, name)) {
        throw new Error(`symmetria: unknown schema.keys() table "${name}"`);
      }
    }

    const anchored = Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        (
          references: TableReferences<keyof Keys & string, KeyValuesOf<Keys>>,
        ) => {
          const resolved =
            typeof definition === "function"
              ? definition(references)
              : definition;
          const key = keys[name];

          if (key) {
            const state = isTable(resolved) ? tableState(resolved) : undefined;
            const columns = state?.columns ?? (resolved as TableDefinition);
            const marked = Object.entries(columns)
              .filter(
                ([, column]) =>
                  isColumn(column) && column.definition.primaryKey,
              )
              .map(([name]) => name);
            const names =
              state?.primaryKey ?? (marked.length ? marked : ["id"]);
            const primary = names.length === 1 ? columns[names[0]!] : undefined;

            if (
              !isColumn(primary) ||
              primary.definition.sqlType !== key.definition.sqlType ||
              primary[COLUMN_CODEC] !== key[COLUMN_CODEC] ||
              JSON.stringify(primary.definition.enumerationValues) !==
                JSON.stringify(key.definition.enumerationValues)
            ) {
              throw new Error(
                `symmetria: primary key for "${name}" does not match schema.keys()`,
              );
            }
          }

          return resolved;
        },
      ]),
    );

    return createSchema(
      anchored as never,
      options as never,
    ) as unknown as Database<Definition>;
  };

export const schema = Object.assign(createSchema, { keys: withKeys });
