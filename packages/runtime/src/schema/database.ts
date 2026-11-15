import type { TraitedRow } from "../query/expressions";
import type { Column } from "./column";
import type { Casing, SchemaSnapshot } from "./assembly";
import type { PrimaryKeyNames, TABLE_UNIQUE_KEYS } from "./table";
import type {
  QueryTable,
  QueryExecutor,
  Driver,
  Columns,
  Predicate,
} from "../query/select";
import type {
  IndexDefinition,
  IndexQuery,
  CreateIndexesOptions,
} from "./indexes";
import type { TransactionOptions } from "../query/plan/types";
import { SCHEMA_BIND } from "./binding";
import type { NestedInsertQuery } from "../query/write/types";
import type { TableTraits } from "./infer";
import type { LinkMetadata } from "./links";
import type {
  SchemaDefinitions,
  StringKeys,
  ReferenceColumnNames,
  ReferenceTarget,
  ReferenceBy,
  ThroughBy,
  Row,
  OptionalColumnNames,
  Insert,
  IsUnion,
  RelationMap,
  RelationGraph,
} from "./graph";

/** Read rows carrying their columns' query traits (float and jsonb columns, stored jsonb(schema) input). */
export type QueryRows<Definition extends SchemaDefinitions> = {
  [TableName in StringKeys<Definition>]: TraitedRow<
    Row<Definition, TableName>,
    TableTraits<Definition[TableName]>
  >;
};

export type UniqueColumnNames<Columns> = {
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

export type UniqueKeys<Columns> = {
  [Name in UniqueColumnNames<Columns>]: Name;
} & (Columns extends { readonly [TABLE_UNIQUE_KEYS]: infer Keys } ? Keys : {});

export type KeyFields<Row, Names extends keyof Row> = {
  [Name in Names]: NonNullable<Row[Name]>;
};
export type PrimaryConnect<
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

export type ConnectValue<
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

export type NestedOne<
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

export type ForwardInputs<
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

export type NestedInsert<
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
    columns: Columns<QueryRows<Definition>[TableName]>,
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
  /**
   * Several reads as one statement: one round trip, one snapshot of the data.
   * The callback returns them at once, as an array or an object:
   * `db.$batch((db) => [db.users.get(1), db.posts({ limit: 10 }), db.posts.count()])`.
   */
  $batch: <
    const Reads extends readonly unknown[] | Readonly<Record<string, unknown>>,
  >(
    callback: (database: Database<Definition, Relations>) => Reads,
  ) => Promise<{ -readonly [Key in keyof Reads]: Awaited<Reads[Key]> }>;
  $snapshot: () => SchemaSnapshot;
  $close: () => Promise<void>;
  $createIndexes: (options?: CreateIndexesOptions) => IndexQuery;
  $transaction: <Result>(
    callback: (
      transaction: TransactionDatabase<Definition, Relations>,
    ) => PromiseLike<Result>,
    options?: TransactionOptions,
  ) => Promise<Result>;
};

export declare const TRANSACTION_SCOPE: unique symbol;

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
    ) => PromiseLike<Result>,
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
) => PromiseLike<unknown>
  ? TransactionScope
  : never;
