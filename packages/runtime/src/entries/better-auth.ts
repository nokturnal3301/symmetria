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
import { and, not, or } from "../query/expressions";

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

const predicate = (row: Loose, clause: KeyedWhere) => {
  const column = member(row, clause.key);

  if (!column) {
    throw new Error(
      `symmetria: better-auth asked for field "${clause.field}", which the table does not have`,
    );
  }

  const insensitive =
    clause.mode === "insensitive" && typeof clause.value === "string";
  // A list compared without case: one ILIKE per value, as a single value is.
  const insensitiveList =
    clause.mode === "insensitive" &&
    Array.isArray(clause.value) &&
    clause.value.length > 0 &&
    clause.value.every((value) => typeof value === "string");
  const pattern = (text: string) =>
    insensitive ? column.ilike(text) : column.like(text);

  switch (clause.operator) {
    case "ne":
      return insensitive
        ? not(column.ilike(escapeLike(clause.value)))
        : column.isNot(clause.value);
    case "in":
      return insensitiveList
        ? or(
            ...(clause.value as string[]).map((value) =>
              column.ilike(escapeLike(value)),
            ),
          )
        : column.in(clause.value);
    case "not_in":
      return insensitiveList
        ? and(
            ...(clause.value as string[]).map((value) =>
              not(column.ilike(escapeLike(value))),
            ),
          )
        : column.notIn(clause.value);
    case "gt":
      return column.above(clause.value);
    case "gte":
      return column.atLeast(clause.value);
    case "lt":
      return column.below(clause.value);
    case "lte":
      return column.atMost(clause.value);
    case "contains":
      return pattern(`%${escapeLike(clause.value)}%`);
    case "starts_with":
      return pattern(`${escapeLike(clause.value)}%`);
    case "ends_with":
      return pattern(`%${escapeLike(clause.value)}`);
    default:
      return insensitive
        ? column.ilike(escapeLike(clause.value))
        : column.is(clause.value);
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

const snakeCase = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The auth tables as a Symmetria schema module, for `npx auth generate`.
 * Tables come out in an order where each one follows the tables it
 * references; spread `authTables` into `schema({ ... })`. With `usePlural`
 * the tables are keyed in the plural (`users`), as the adapter then asks for
 * them.
 */
export const authSchemaSource = (
  input: Tables,
  options: { readonly usePlural?: boolean } = {},
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
    const targets = Object.values(entry.fields).flatMap((field) =>
      field.references ? [nameOf(field.references.model)] : [],
    );
    const lines = Object.entries(entry.fields).map(([key, field]) => {
      const named =
        field.fieldName &&
        field.fieldName !== key &&
        field.fieldName !== snakeCase(key)
          ? `.named(${JSON.stringify(field.fieldName)})`
          : "";
      const reference = field.references;

      if (reference && reference.field === "id" && key.endsWith("Id")) {
        const target = nameOf(reference.model);
        // A key column better-auth names its own way keeps that SQL name.
        const keyColumn = named
          ? `.column(${JSON.stringify(field.fieldName)})`
          : "";
        // better-auth's own migrations cascade when a reference names no action.
        const action =
          reference.onDelete === undefined || reference.onDelete === "cascade"
            ? "cascade"
            : reference.onDelete === "set null"
              ? "setNull"
              : undefined;
        const relation = key.slice(0, -2);
        const self = target === entry.modelName;

        // Two keys to one table need names for their reverse sides.
        if (targets.filter((name) => name === target).length > 1 || self) {
          if (self) {
            builders.add("self");
          }

          return `  ${relation}: ${self ? "self" : target}${keyColumn}${field.required === false || action === "setNull" ? ".nullable" : ""}${field.unique ? ".unique" : ".index"}${action ? `.onDelete.${action}` : ""}.inverse(${JSON.stringify(`${entry.modelName}By${relation[0]!.toUpperCase()}${relation.slice(1)}`)}),`;
        }

        const claim =
          field.required === false || action === "setNull" ? "maybe" : "one";

        builders.add(claim);

        return `  ${relation}: ${claim}(${target})${action ? `.${action}` : ""}${field.unique ? ".unique" : ""}${keyColumn},`;
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

      return `  ${key}: ${type}${named}${field.required === false ? ".nullable" : ""}${field.unique ? ".unique" : ""}${field.index && !field.unique ? ".index" : ""}${literal},`;
    });
    const indexes = (entry.indexes ?? []).filter(
      (definition) => definition.fields.length > 1,
    );

    if (indexes.length) {
      builders.add("index");
    }

    return [
      `export const ${entry.modelName} = table({`,
      "  id: text,",
      ...lines,
      indexes.length
        ? `}).indexes((${entry.modelName}) => ({\n${indexes
            .map(
              (definition) =>
                `  ${definition.fields.join("_").replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase())}: index(${definition.fields.map((name) => `${entry.modelName}.${name}`).join(", ")})${definition.unique ? ".unique" : ""},`,
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
    `export const authTables = { ${ordered.map((entry) => entry.modelName).join(", ")} };`,
    "",
  ].join("\n");
};

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
        // better-auth hands over rows and clauses by each field's database
        // name (`fields: { emailVerified: "email_verified" }`); the tables are
        // keyed by its field names (`emailVerified`) with that SQL name.
        const keyOf = (model: string, field: string): string => {
          try {
            return getDefaultFieldName({ model, field });
          } catch {
            return field;
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

          const entries = Object.entries(row);
          const own = entries.filter(([key]) => !isField(model, key));
          const fields = entries
            .filter(([key]) => isField(model, key))
            .map(([key, value]) => [
              getFieldName({ model, field: key }),
              value,
            ]);

          return Object.fromEntries([...own, ...fields]);
        };
        const where = (
          model: string,
          clauses: readonly CleanedWhere[] | undefined,
        ): KeyedWhere[] =>
          (clauses ?? []).map((clause) => ({
            ...clause,
            key: keyOf(model, clause.field),
          }));
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

        return {
          create: async ({ model, data }) =>
            fielded(
              model,
              await table(model).insert(keyed(model, data)).returning(),
            ) as never,

          findOne: async ({ model, where: clauses }) =>
            fielded(
              model,
              await table(model)({
                where: filter(where(model, clauses)),
                limit: 1,
              }).first(),
            ) as never,

          findMany: async ({ model, where: clauses, limit, offset, sortBy }) =>
            (
              await table(model)({
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
            const [row] = await filtered(
              model,
              table(model).update(
                keyed(model, update as Record<string, unknown>),
              ),
              clauses,
            ).returning();

            return fielded(model, row ?? null) as never;
          },

          updateMany: async ({ model, where: clauses, update }) =>
            (
              await filtered(
                model,
                table(model).update(keyed(model, update)),
                clauses,
              )
            ).affectedRows,

          delete: async ({ model, where: clauses }) => {
            await filtered(model, table(model).delete(), clauses);
          },

          deleteMany: async ({ model, where: clauses }) =>
            (await filtered(model, table(model).delete(), clauses))
              .affectedRows,

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

          incrementOne: async ({ model, where: clauses, increment, set }) => {
            const [row] = await filtered(
              model,
              table(model).update((current: Loose) => ({
                ...keyed(model, set ?? {}),
                ...Object.fromEntries(
                  Object.entries(increment).map(([field, delta]) => {
                    const key = keyOf(model, field);

                    return [key, current[key].plus(delta)];
                  }),
                ),
              })),
              clauses,
            ).returning();

            return fielded(model, row ?? null) as never;
          },

          createSchema: async ({ tables, file }) => ({
            code: authSchemaSource(tables as Tables, {
              usePlural: options.usePlural ?? false,
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
