/**
 * `symmetria/better-auth`: a better-auth database adapter over a Symmetria
 * database: `betterAuth({ database: symmetriaAdapter(db) })`. The auth tables
 * are tables of your schema, keyed and named the way better-auth names its
 * models and fields (`user.emailVerified`), so they are migrated, related and
 * queried like the rest; `npx auth generate` writes them.
 */
import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type CleanedWhere,
  type DBAdapterDebugLogOption,
} from "better-auth/adapters";
import { and, coalesce, not, or } from "../query/expressions";

export type SymmetriaAdapterOptions = {
  /** Tables are keyed in the plural (`users`, `sessions`). */
  readonly usePlural?: boolean;
  readonly debugLogs?: DBAdapterDebugLogOption;
};

// better-auth names tables and fields at run time, so the adapter reaches
// them by key and leaves the typed API to the application.
type Loose = any;
type Tables = Record<
  string,
  {
    modelName: string;
    fields: Record<string, Field>;
    indexes?: readonly {
      fields: readonly string[];
      unique?: boolean | undefined;
    }[];
  }
>;
type Field = {
  type: string | readonly string[];
  required?: boolean | undefined;
  unique?: boolean | undefined;
  index?: boolean | undefined;
  bigint?: boolean | undefined;
  fieldName?: string | undefined;
  defaultValue?: unknown;
  references?:
    | { model: string; field: string; onDelete?: string | undefined }
    | undefined;
};

const escapeLike = (value: unknown): string =>
  String(value).replace(/[\\%_]/g, (character) => `\\${character}`);

/** A where clause whose field is already the table's key. */
type KeyedWhere = CleanedWhere & { readonly key: string };

/** `target[key]`, unless it is only what every object inherits (`constructor`). */
const member = (target: Loose, key: string): Loose => {
  const value = target[key];

  return value === (Object.prototype as Loose)[key] ? undefined : value;
};

/** The column `key` of a row, for better-auth's field `field`. */
const columnOf = (row: Loose, key: string, field: string): Loose => {
  const column = member(row, key);

  if (!column) {
    throw new Error(
      `symmetria: better-auth asked for field "${field}", which the table does not have`,
    );
  }

  return column;
};

/**
 * A where value in the form its field's column compares. better-auth passes
 * request values on as they come (the admin plugin's `filterValue: 1984` for
 * a text field): node-postgres sends a number untyped, which PostgreSQL reads
 * as text, while Bun.SQL binds it as an integer and the comparison fails, so a
 * string field gets a string on every driver. A list for a boolean field
 * reads "true" and "false" as better-auth reads a single value.
 */
const comparable = (
  type: Field["type"] | undefined,
  value: unknown,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => comparable(type, item));
  }

  if (
    (type === "string" || Array.isArray(type)) &&
    (typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean")
  ) {
    return String(value);
  }

  return type === "boolean" && (value === "true" || value === "false")
    ? value === "true"
    : value;
};

// A comparison without a value matches no row, as `= NULL` does in
// better-auth's SQL adapters: a request that names a filter field and no
// value (`listMembers?filterField=role`) passes `undefined`.
const none = (column: Loose) => column.in([]);

const predicate = (row: Loose, clause: KeyedWhere) => {
  const column = columnOf(row, clause.key, clause.field);
  const { value } = clause;
  const missing = value === undefined || value === null;
  const insensitive =
    clause.mode === "insensitive" && typeof value === "string";
  const pattern = (text: string) =>
    insensitive ? column.ilike(text) : column.like(text);

  switch (clause.operator) {
    case "ne":
      if (value === null) {
        return column.isNot(null);
      }

      return value === undefined
        ? none(column)
        : insensitive
          ? not(column.ilike(escapeLike(value)))
          : column.isNot(value);
    case "in":
    case "not_in": {
      const list: unknown[] = Array.isArray(value) ? value : [value];
      const present = list.filter(
        (item) => item !== undefined && item !== null,
      );
      // A list compared without case: one ILIKE per value, as a single value is.
      const insensitiveList =
        clause.mode === "insensitive" &&
        present.length > 0 &&
        present.every((item) => typeof item === "string");

      if (clause.operator === "in") {
        // NULL is in no list, as in SQL.
        return insensitiveList
          ? or(...present.map((item) => column.ilike(escapeLike(item))))
          : column.in(present);
      }

      // `NOT IN (…, NULL)` holds for no row, as in SQL.
      if (present.length < list.length) {
        return none(column);
      }

      return insensitiveList
        ? and(...present.map((item) => not(column.ilike(escapeLike(item)))))
        : column.notIn(present);
    }
    case "gt":
      return missing ? none(column) : column.above(value);
    case "gte":
      return missing ? none(column) : column.atLeast(value);
    case "lt":
      return missing ? none(column) : column.below(value);
    case "lte":
      return missing ? none(column) : column.atMost(value);
    case "contains":
      return missing ? none(column) : pattern(`%${escapeLike(value)}%`);
    case "starts_with":
      return missing ? none(column) : pattern(`${escapeLike(value)}%`);
    case "ends_with":
      return missing ? none(column) : pattern(`%${escapeLike(value)}`);
    default:
      if (value === null) {
        return column.is(null);
      }

      return value === undefined
        ? none(column)
        : insensitive
          ? column.ilike(escapeLike(value))
          : column.is(value);
  }
};

/** better-auth's flat clause list: every AND clause, and at least one of the OR clauses. */
const filter = (where: readonly KeyedWhere[] | undefined) => (row: Loose) => {
  const clauses = where ?? [];
  const all = clauses
    .filter((clause) => clause.connector !== "OR")
    .map((clause) => predicate(row, clause));
  const any = clauses
    .filter((clause) => clause.connector === "OR")
    .map((clause) => predicate(row, clause));

  return and(...all, any.length > 0 ? or(...any) : undefined);
};

const COLUMN_TYPES: Readonly<Record<string, string>> = {
  string: "text",
  boolean: "bool",
  date: "timestamptz",
  json: "jsonb()",
  "string[]": "text.array",
  "number[]": "int.array",
};

/** A key's SQL name under schema()'s default casing (`requestedBy` → `requested_by`). */
const snakeCase = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Names a module cannot declare: JavaScript's reserved words and what it imports. */
const TAKEN: ReadonlySet<string> = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "Infinity",
  "NaN",
  "authTables",
  "bigint",
  "bool",
  "index",
  "int",
  "jsonb",
  "maybe",
  "one",
  "oneOf",
  "self",
  "table",
  "text",
  "timestamptz",
]);

/** A JavaScript name for a model: `auth-user` → `authUser`, `default` → `defaultTable`. */
const identifierOf = (name: string): string => {
  const joined = name
    .split(/[^\p{ID_Continue}$]+/u)
    .filter(Boolean)
    .map((word, position) =>
      position ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word,
    )
    .join("");
  const named = /^[\p{ID_Start}$_]/u.test(joined) ? joined : `_${joined}`;

  return TAKEN.has(named) ? `${named}Table` : named;
};

/** The relation a reference field becomes: `userId` → `user`, `requestedBy` stays. */
const relationOf = (key: string): string =>
  key.length > 2 && key.endsWith("Id") ? key.slice(0, -2) : key;

/**
 * The auth tables as a Symmetria schema module, for `npx auth generate`.
 * Tables come out in an order where each one follows the tables it
 * references; spread `authTables` into `schema({ ... })`. With `usePlural`
 * the tables are keyed in the plural (`users`), as the adapter then asks for
 * them; `casing` is the schema's (`"preserve"` keeps a reference key such as
 * `requestedBy` as its SQL name).
 */
export const authSchemaSource = (
  input: Tables,
  options: {
    readonly usePlural?: boolean;
    readonly casing?: "snake_case" | "preserve";
  } = {},
): string => {
  const tables: Tables = options.usePlural
    ? Object.fromEntries(
        Object.entries(input).map(([model, entry]) => [
          model,
          { ...entry, modelName: `${entry.modelName}s` },
        ]),
      )
    : input;
  const builders = new Set<string>(["table", "text"]);
  const models = Object.values(tables);
  const nameOf = (model: string): string =>
    tables[model]?.modelName ??
    models.find((entry) => entry.modelName === model)?.modelName ??
    model;
  // Each table's export name: its model name where that is a free JavaScript
  // name, otherwise one made from it (`"auth-user": authUser`).
  const identifiers = new Map<string, string>();
  const used = new Set<string>();

  for (const plain of [true, false]) {
    for (const { modelName } of models) {
      const base = identifierOf(modelName);

      if ((base === modelName) !== plain || identifiers.has(modelName)) {
        continue;
      }

      let name = base;

      for (let count = 2; used.has(name); count++) {
        name = `${base}${count}`;
      }

      used.add(name);
      identifiers.set(modelName, name);
    }
  }

  const identifier = (modelName: string): string =>
    identifiers.get(modelName) ?? modelName;
  const ordered: typeof models = [];
  const pending = [...models];

  // References first; a cycle keeps the order better-auth gave.
  while (pending.length) {
    const next =
      pending.find((entry) =>
        Object.values(entry.fields).every(
          (field) =>
            !field.references ||
            nameOf(field.references.model) === entry.modelName ||
            ordered.some(
              (done) => done.modelName === nameOf(field.references!.model),
            ),
        ),
      ) ?? pending[0]!;

    ordered.push(next);
    pending.splice(pending.indexOf(next), 1);
  }

  const declarations = ordered.map((entry) => {
    const name = identifier(entry.modelName);
    const fields = entry.fields;
    // A reference is a relation, whose key column is `<relation>Id`.
    const columnKey = (key: string): string =>
      fields[key]?.references ? `${relationOf(key)}Id` : key;
    // A single-field index the table declares (device-authorization's
    // unique `userCode`) is the column's own `.unique` or `.index`.
    const single = new Map<string, boolean>();
    const composite: NonNullable<Tables[string]["indexes"]>[number][] = [];

    for (const definition of entry.indexes ?? []) {
      const [only, ...others] = definition.fields;

      if (only !== undefined && !others.length && Object.hasOwn(fields, only)) {
        single.set(
          only,
          single.get(only) === true || definition.unique === true,
        );
      } else {
        composite.push(definition);
      }
    }

    const targets = Object.values(fields).flatMap((field) =>
      field.references ? [nameOf(field.references.model)] : [],
    );
    const lines = Object.entries(fields).map(([key, field]) => {
      // The SQL name better-auth was given, whenever it is not the key: it
      // is the column's name under either casing.
      const sqlName =
        field.fieldName && field.fieldName !== key
          ? field.fieldName
          : undefined;
      const unique = field.unique === true || single.get(key) === true;
      const reference = field.references;

      if (reference) {
        const target = nameOf(reference.model);
        const relation = relationOf(key);

        const clash = [relation, `${relation}Id`].find(
          (other) => other !== key && Object.hasOwn(fields, other),
        );

        if (clash) {
          throw new Error(
            `symmetria: ${entry.modelName}.${key} references ${target} and becomes the relation "${relation}" with the key "${relation}Id", but ${entry.modelName} has another field "${clash}"; rename one of the two`,
          );
        }

        // A key that does not end in `Id` keeps its own SQL name; the
        // relation would otherwise call it `<relation>_id`.
        const column =
          sqlName ??
          (relation === key
            ? options.casing === "preserve"
              ? key
              : snakeCase(key)
            : undefined);
        const keyColumn =
          column === undefined ? "" : `.column(${JSON.stringify(column)})`;
        // A reference to a field other than the id names it.
        const targetFields = models.find(
          (model) => model.modelName === target,
        )?.fields;
        const targetKey =
          reference.field === "id" ||
          !targetFields ||
          Object.hasOwn(targetFields, reference.field)
            ? reference.field
            : (Object.entries(targetFields).find(
                ([, candidate]) => candidate.fieldName === reference.field,
              )?.[0] ?? reference.field);
        const by =
          targetKey === "id"
            ? ""
            : `.by(${JSON.stringify(targetFields?.[targetKey]?.references ? `${relationOf(targetKey)}Id` : targetKey)})`;
        // better-auth's own migrations cascade when a reference names no
        // action. They give a key no default, so its SET DEFAULT sets NULL:
        // SET NULL for an optional key, a refused delete for a required one.
        const action =
          reference.onDelete === undefined || reference.onDelete === "cascade"
            ? "cascade"
            : reference.onDelete === "set null" ||
                (reference.onDelete === "set default" &&
                  field.required === false)
              ? "setNull"
              : reference.onDelete === "no action" ||
                  reference.onDelete === "set default"
                ? "noAction"
                : undefined;
        const nullable = field.required === false || action === "setNull";
        const self = target === entry.modelName;
        const shared = targets.filter((other) => other === target).length > 1;

        // Two keys to one table need names for their reverse sides; NO
        // ACTION is spelled on the reference itself.
        if (shared || self || action === "noAction") {
          if (self) {
            builders.add("self");
          }

          const inverse =
            shared || self
              ? `.inverse(${JSON.stringify(`${name}By${relation[0]!.toUpperCase()}${relation.slice(1)}`)})`
              : "";

          return `  ${relation}: ${self ? "self" : identifier(target)}${by}${keyColumn}${nullable ? ".nullable" : ""}${unique ? ".unique" : ".index"}${action ? `.onDelete.${action}` : ""}${inverse},`;
        }

        const claim = nullable ? "maybe" : "one";

        builders.add(claim);

        return `  ${relation}: ${claim}(${identifier(target)})${action ? `.${action}` : ""}${unique ? ".unique" : ""}${by}${keyColumn},`;
      }

      let type: string;

      if (Array.isArray(field.type)) {
        builders.add("oneOf");
        type = `oneOf(${field.type.map((value) => JSON.stringify(value)).join(", ")})`;
      } else if (field.type === "number") {
        type = field.bigint ? "bigint" : "int";
      } else {
        type = COLUMN_TYPES[field.type as string] ?? "text";
      }

      builders.add(type.split(/[.(]/)[0]!);

      const fallback = field.defaultValue;
      const literal =
        typeof fallback === "string" ||
        typeof fallback === "number" ||
        typeof fallback === "boolean"
          ? `.default(${field.bigint ? `${fallback}n` : JSON.stringify(fallback)})`
          : "";
      const indexed = (field.index === true || single.has(key)) && !unique;

      return `  ${key}: ${type}${sqlName ? `.named(${JSON.stringify(sqlName)})` : ""}${field.required === false ? ".nullable" : ""}${unique ? ".unique" : ""}${indexed ? ".index" : ""}${literal},`;
    });

    if (composite.length) {
      builders.add("index");
    }

    return [
      `export const ${name} = table({`,
      "  id: text,",
      ...lines,
      composite.length
        ? `}).indexes((${name}) => ({\n${composite
            .map(
              (definition) =>
                `  ${definition.fields.join("_").replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase())}: index(${definition.fields.map((field) => `${name}.${columnKey(field)}`).join(", ")})${definition.unique ? ".unique" : ""},`,
            )
            .join("\n")}\n}));`
        : "});",
    ].join("\n");
  });

  return [
    "// Written by `auth generate` through symmetria/better-auth.",
    "// Spread `authTables` into your schema: schema({ ...authTables, posts, … }).",
    `import { ${[...builders].sort().join(", ")} } from "symmetria";`,
    "",
    declarations.join("\n\n"),
    "",
    `export const authTables = { ${ordered
      .map((entry) => {
        const name = identifier(entry.modelName);

        return name === entry.modelName
          ? name
          : `${JSON.stringify(entry.modelName)}: ${name}`;
      })
      .join(", ")} };`,
    "",
  ].join("\n");
};

const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * `betterAuth({ database: symmetriaAdapter(db) })`. `db` is the database (or a
 * `$scope()` of it) whose schema holds the auth tables; better-auth's own
 * transactions run inside `db.$transaction`.
 */
export const symmetriaAdapter = (
  db: object,
  options: SymmetriaAdapterOptions = {},
) => {
  // What better-auth hands the adapter, kept for the adapters built around a transaction.
  let authOptions: BetterAuthOptions | undefined;
  // Each table's column keys, read once: they tell a reference written as a
  // relation (`requestedById`) from one written as a plain column
  // (`requestedBy`), as modules that earlier versions of `auth generate`
  // wrote declare it, so those modules keep working.
  let columns: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  const columnsOf = (model: string): ReadonlySet<string> | undefined => {
    columns ??= new Map(
      ((db as Loose).$snapshot?.()?.tables ?? []).map((table: Loose) => [
        table.name,
        new Set(table.columns.map((column: Loose) => column.name)),
      ]),
    );

    return columns.get(model);
  };

  const build = (connection: Loose): ReturnType<typeof createAdapterFactory> =>
    createAdapterFactory({
      config: {
        adapterId: "symmetria",
        adapterName: "Symmetria",
        usePlural: options.usePlural ?? false,
        debugLogs: options.debugLogs ?? false,
        supportsDates: true,
        supportsBooleans: true,
        supportsJSON: true,
        supportsArrays: true,
        // Ids are text columns better-auth fills; `generateId: "serial"` is
        // refused when better-auth starts rather than at the first insert.
        supportsNumericIds: false,
        transaction: (callback) =>
          connection.$transaction((transaction: Loose) =>
            callback(build(transaction)(authOptions ?? {}) as never),
          ),
      },
      adapter: ({
        getDefaultFieldName,
        getDefaultModelName,
        getFieldAttributes,
        getFieldName,
        schema,
      }) => {
        const table = (model: string) => {
          const handle = member(connection, model);

          if (!handle) {
            throw new Error(
              `symmetria: better-auth uses a table "${model}" that the schema does not have; run \`npx auth generate\` and add it`,
            );
          }

          return handle;
        };
        // A reference field the table holds as a relation's key column
        // `<field>Id`: `requestedBy` is the relation `requestedBy` and the
        // column `requestedById`. (`userId` is the relation `user` and keeps
        // its key.)
        const relationKeys = new Map<string, ReadonlyMap<string, string>>();
        const relationKeysOf = (model: string): ReadonlyMap<string, string> => {
          let keys = relationKeys.get(model);

          if (!keys) {
            const present = columnsOf(model);
            let fields: Record<string, Loose> = {};

            try {
              fields = schema[getDefaultModelName(model)]?.fields ?? {};
            } catch {
              // Not one of better-auth's models.
            }

            keys = new Map(
              Object.entries(fields).flatMap(([key, field]) =>
                field.references &&
                present &&
                !present.has(key) &&
                present.has(`${key}Id`)
                  ? [[key, `${key}Id`] as const]
                  : [],
              ),
            );
            relationKeys.set(model, keys);
          }

          return keys;
        };
        // better-auth hands over rows and clauses by each field's database
        // name (`fields: { emailVerified: "email_verified" }`); the tables are
        // keyed by its field names (`emailVerified`) with that SQL name.
        const keyOf = (model: string, field: string): string => {
          let key: string;

          try {
            key = getDefaultFieldName({ model, field });
          } catch {
            return field;
          }

          return relationKeysOf(model).get(key) ?? key;
        };
        const typeOf = (
          model: string,
          field: string,
        ): Field["type"] | undefined => {
          try {
            return getFieldAttributes({ model, field }).type;
          } catch {
            return undefined;
          }
        };
        const keyed = (model: string, data: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(data).map(([field, value]) => [
              keyOf(model, field),
              value,
            ]),
          );
        // A key of the table that is one of better-auth's fields (`name`, `userId`).
        const isField = (model: string, key: string): boolean => {
          if (key === "id") {
            return true;
          }

          try {
            const fields = schema[getDefaultModelName(model)]?.fields;

            return fields !== undefined && Object.hasOwn(fields, key);
          } catch {
            return false;
          }
        };
        // The better-auth field a key of the table holds, if any.
        const fieldOf = (model: string, key: string): string | undefined => {
          if (isField(model, key)) {
            return key;
          }

          const field = key.slice(0, -2);

          return key.endsWith("Id") && relationKeysOf(model).get(field) === key
            ? field
            : undefined;
        };
        // A `bigint` column (`rateLimit.lastRequest`) reads as a bigint;
        // better-auth types its number fields as numbers, so a safe integer
        // goes back as one.
        const output = (model: string, field: string, value: unknown) =>
          typeof value === "bigint" &&
          value >= SAFE_MIN &&
          value <= SAFE_MAX &&
          typeOf(model, field) === "number"
            ? Number(value)
            : value;
        // Rows go back under better-auth's database names. A column of the
        // application's own (`plan`) is not a better-auth field: it keeps its
        // key, and a field's value wins over it when the two names meet
        // (`fields: { name: "nickname" }` next to an app column `nickname`).
        const fielded = (
          model: string,
          row: Record<string, unknown> | null,
        ) => {
          if (!row) {
            return null;
          }

          const own: [string, unknown][] = [];
          const fields: [string, unknown][] = [];

          for (const [key, value] of Object.entries(row)) {
            const field = fieldOf(model, key);

            if (field === undefined) {
              own.push([key, value]);
            } else {
              fields.push([
                getFieldName({ model, field }),
                output(model, field, value),
              ]);
            }
          }

          return Object.fromEntries([...own, ...fields]);
        };
        const where = (
          model: string,
          clauses: readonly CleanedWhere[] | undefined,
        ): KeyedWhere[] =>
          (clauses ?? []).map((clause) => ({
            ...clause,
            key: keyOf(model, clause.field),
            value: comparable(
              typeOf(model, clause.field),
              clause.value,
            ) as CleanedWhere["value"],
          }));
        // A read of the whole row, or of the fields better-auth selects.
        const read = (
          model: string,
          select: readonly string[] | undefined,
          query: object,
        ) =>
          select?.length
            ? table(model)(
                (row: Loose) =>
                  Object.fromEntries(
                    select.map((field) => {
                      const key = keyOf(model, field);

                      return [key, columnOf(row, key, field)];
                    }),
                  ),
                query,
              )
            : table(model)(query);
        // An UPDATE or DELETE without a filter is refused unless spelled
        // out; better-auth means every row when it sends none.
        const filtered = (
          model: string,
          mutation: Loose,
          clauses: readonly CleanedWhere[] | undefined,
        ) =>
          clauses?.length
            ? mutation.where(filter(where(model, clauses)))
            : mutation.all();
        // A filter that holds for every row (`not_in` an empty list, `ne`
        // null on a required field) is refused like a missing where().
        const refusing = async (
          method: string,
          model: string,
          run: () => Loose,
        ): Promise<Loose> => {
          try {
            return await run();
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes("leaves no condition")
            ) {
              throw new Error(
                `symmetria: better-auth's ${method}() on "${model}" has a where that holds for every row (such as not_in an empty list, or ne null on a required field), so the adapter refuses it rather than write every row; call ${method}() without a where to write every row`,
                { cause: error },
              );
            }

            throw error;
          }
        };

        return {
          create: async ({ model, data }) =>
            fielded(
              model,
              await table(model).insert(keyed(model, data)).returning(),
            ) as never,

          findOne: async ({ model, where: clauses, select }) =>
            fielded(
              model,
              await read(model, select, {
                where: filter(where(model, clauses)),
                limit: 1,
              }).first(),
            ) as never,

          findMany: async ({
            model,
            where: clauses,
            limit,
            offset,
            sortBy,
            select,
          }) =>
            (
              await read(model, select, {
                where: filter(where(model, clauses)),
                limit,
                offset,
                orderBy: sortBy
                  ? { [keyOf(model, sortBy.field)]: sortBy.direction }
                  : undefined,
              })
            ).map((row: Record<string, unknown>) => fielded(model, row)),

          count: ({ model, where: clauses }) =>
            table(model)({ where: filter(where(model, clauses)) }).count(),

          update: async ({ model, where: clauses, update }) => {
            const [row] = await refusing("update", model, () =>
              filtered(
                model,
                table(model).update(
                  keyed(model, update as Record<string, unknown>),
                ),
                clauses,
              ).returning(),
            );

            return fielded(model, row ?? null) as never;
          },

          updateMany: async ({ model, where: clauses, update }) =>
            (
              await refusing("updateMany", model, () =>
                filtered(
                  model,
                  table(model).update(keyed(model, update)),
                  clauses,
                ),
              )
            ).affectedRows,

          delete: async ({ model, where: clauses }) => {
            await refusing("delete", model, () =>
              filtered(model, table(model).delete(), clauses),
            );
          },

          deleteMany: async ({ model, where: clauses }) =>
            (
              await refusing("deleteMany", model, () =>
                filtered(model, table(model).delete(), clauses),
              )
            ).affectedRows,

          // One row at most: the DELETE by key decides which of two
          // concurrent callers gets it.
          consumeOne: async ({ model, where: clauses }) => {
            const found = await table(model)({
              where: filter(where(model, clauses)),
              limit: 1,
            }).first();

            if (!found) {
              return null;
            }

            const [row] = await table(model)
              .byId(found.id)
              .delete()
              .returning();

            return fielded(model, row ?? null) as never;
          },

          // One row, as better-auth's SQL adapters change it: the first the
          // filter finds, written only while the filter still holds for it,
          // so a concurrent change that breaks the filter leaves it alone. A
          // NULL counter counts from 0, as better-auth's own fallback does.
          incrementOne: async ({ model, where: clauses, increment, set }) => {
            const handle = table(model);
            const keyedWhere = where(model, clauses);
            const condition = keyedWhere.length
              ? filter(keyedWhere)
              : undefined;
            const [row] = await handle
              .update((current: Loose) => ({
                ...keyed(model, set ?? {}),
                ...Object.fromEntries(
                  Object.entries(increment).map(([field, delta]) => {
                    const key = keyOf(model, field);

                    return [
                      key,
                      (coalesce as Loose)(
                        columnOf(current, key, field),
                        0,
                      ).plus(delta),
                    ];
                  }),
                ),
              }))
              .where((target: Loose) => [
                ...(condition ? [condition(target)] : []),
                columnOf(target, "id", "id").in(
                  handle((first: Loose) => ({ id: first.id }), {
                    where: condition,
                    limit: 1,
                  }),
                ),
              ])
              .returning();

            return fielded(model, row ?? null) as never;
          },

          createSchema: async ({ tables, file }) => ({
            code: authSchemaSource(tables as Tables, {
              usePlural: options.usePlural ?? false,
              casing: (db as Loose).$snapshot?.()?.casing,
            }),
            path: file ?? "./auth-schema.ts",
            overwrite: true,
          }),
        };
      },
    });

  const adapter = build(db);

  return (betterAuthOptions: BetterAuthOptions) => {
    authOptions = betterAuthOptions;

    return adapter(betterAuthOptions);
  };
};
