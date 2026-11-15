import type { ReferenceFlags, ReferenceableColumnNames } from "./table";

export const LINK = Symbol("symmetria.schema.link");

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
    Shape,
    By
  >;
  readonly unique: Link<
    TableName,
    Nullable,
    true,
    InverseName,
    KeyValue,
    Shape,
    By
  >;
  readonly index: Link<
    TableName,
    Nullable,
    Unique,
    InverseName,
    KeyValue,
    Shape,
    By
  >;
  /** No index on the foreign key, after `one()` or `maybe()`. */
  readonly noIndex: Link<
    TableName,
    Nullable,
    Unique,
    InverseName,
    KeyValue,
    Shape,
    By
  >;
  /** `ON DELETE CASCADE`. */
  readonly cascade: Link<
    TableName,
    Nullable,
    Unique,
    InverseName,
    KeyValue,
    Shape,
    By
  >;
  /** `ON DELETE RESTRICT` (the default). */
  readonly restrict: Link<
    TableName,
    Nullable,
    Unique,
    InverseName,
    KeyValue,
    Shape,
    By
  >;
  /** `ON DELETE SET NULL`; the reference becomes optional. */
  readonly setNull: Link<
    TableName,
    true,
    Unique,
    InverseName,
    KeyValue,
    Shape,
    By
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

export const createLink = (
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
    // The short forms one() and maybe() chains have.
    noIndex: { get: () => withOptions({ index: false }) },
    cascade: { get: () => withOptions({ onDelete: "cascade" }) },
    restrict: { get: () => withOptions({ onDelete: "restrict" }) },
    setNull: {
      get: () => withOptions({ onDelete: "set null", nullable: true }),
    },
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

export const isLink = (value: unknown): value is LinkMetadata => {
  return typeof value === "object" && value !== null && LINK in value;
};
