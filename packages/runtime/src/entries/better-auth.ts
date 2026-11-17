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

const predicate = (row: Loose, clause: CleanedWhere) => {
  const column = row[clause.field];

  if (!column) {
    throw new Error(
      `symmetria: better-auth asked for field "${clause.field}", which the table does not have`,
    );
  }

  const insensitive =
    clause.mode === "insensitive" && typeof clause.value === "string";
  const pattern = (text: string) =>
    insensitive ? column.ilike(text) : column.like(text);

  switch (clause.operator) {
    case "ne":
      return insensitive
        ? not(column.ilike(escapeLike(clause.value)))
        : column.isNot(clause.value);
    case "in":
      return column.in(clause.value);
    case "not_in":
      return column.notIn(clause.value);
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
const filter = (where: readonly CleanedWhere[] | undefined) => (row: Loose) => {
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
  json: "jsonb",
  "string[]": "text.array",
  "number[]": "int.array",
};

const snakeCase = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The auth tables as a Symmetria schema module, for `npx auth generate`.
 * Tables come out in an order where each one follows the tables it
 * references; spread `authTables` into `schema({ ... })`.
 */
export const authSchemaSource = (tables: Tables): string => {
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

          return `  ${relation}: ${self ? "self" : target}${field.required === false || action === "setNull" ? ".nullable" : ""}${field.unique ? ".unique" : ".index"}${action ? `.onDelete.${action}` : ""}.inverse(${JSON.stringify(`${entry.modelName}By${relation[0]!.toUpperCase()}${relation.slice(1)}`)}),`;
        }

        const claim =
          field.required === false || action === "setNull" ? "maybe" : "one";

        builders.add(claim);

        return `  ${relation}: ${claim}(${target})${action ? `.${action}` : ""}${field.unique ? ".unique" : ""},`;
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
        transaction: (callback) =>
          connection.$transaction((transaction: Loose) =>
            callback(build(transaction)(authOptions ?? {}) as never),
          ),
      },
      adapter: () => {
        const table = (model: string) => {
          const handle = connection[model];

          if (!handle) {
            throw new Error(
              `symmetria: better-auth uses a table "${model}" that the schema does not have; run \`npx auth generate\` and add it`,
            );
          }

          return handle;
        };
        // An UPDATE or DELETE without a filter is refused unless spelled
        // out; better-auth means every row when it sends none.
        const filtered = (
          mutation: Loose,
          where: readonly CleanedWhere[] | undefined,
        ) => (where?.length ? mutation.where(filter(where)) : mutation.all());

        return {
          create: ({ model, data }) => table(model).insert(data).returning(),

          findOne: ({ model, where }) =>
            table(model)({ where: filter(where), limit: 1 }).first(),

          findMany: ({ model, where, limit, offset, sortBy }) =>
            table(model)({
              where: filter(where),
              limit,
              offset,
              orderBy: sortBy
                ? { [sortBy.field]: sortBy.direction }
                : undefined,
            }),

          count: ({ model, where }) =>
            table(model)({ where: filter(where) }).count(),

          update: async ({ model, where, update }) => {
            const [row] = await filtered(
              table(model).update(update),
              where,
            ).returning();

            return row ?? null;
          },

          updateMany: async ({ model, where, update }) =>
            (await filtered(table(model).update(update), where)).affectedRows,

          delete: async ({ model, where }) => {
            await filtered(table(model).delete(), where);
          },

          deleteMany: async ({ model, where }) =>
            (await filtered(table(model).delete(), where)).affectedRows,

          // One row at most: the DELETE by key decides which of two
          // concurrent callers gets it.
          consumeOne: async ({ model, where }) => {
            const found = await table(model)({
              where: filter(where),
              limit: 1,
            }).first();

            if (!found) {
              return null;
            }

            const [row] = await table(model)
              .byId(found.id)
              .delete()
              .returning();

            return row ?? null;
          },

          incrementOne: async ({ model, where, increment, set }) => {
            const [row] = await filtered(
              table(model).update((current: Loose) => ({
                ...set,
                ...Object.fromEntries(
                  Object.entries(increment).map(([field, delta]) => [
                    field,
                    current[field].plus(delta),
                  ]),
                ),
              })),
              where,
            ).returning();

            return row ?? null;
          },

          createSchema: async ({ tables, file }) => ({
            code: authSchemaSource(tables as Tables),
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
