import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CatalogConstraint } from "../../../packages/kit/src/migrations/catalog";
import type {
  IndexDetailRow,
  PullCatalog,
} from "../../../packages/kit/src/introspection/catalog";
import {
  buildPulledSchema,
  withoutTruthComparison,
  type PulledColumn,
  type PulledReference,
} from "../../../packages/kit/src/introspection/model";
import { objectName } from "../../../packages/kit/src/migrations/snapshot";
import { renderSchema } from "../../../packages/kit/src/introspection/render";
import {
  camelKey,
  escapeTemplate,
} from "../../../packages/kit/src/introspection/names";
import { migrationSnapshot } from "../../../packages/kit/src";
import { withMigrationDirectory } from "../../support/directories";

type Column = {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string;
  identity?: "a" | "d";
  enumeration?: string;
  generated?: boolean;
  collation?: string;
};

type Table = {
  name: string;
  columns: Column[];
  primaryKey?: string[] | { name: string; columns: string[] };
  unique?: ({ name?: string; columns: string[] } | string)[];
  foreignKeys?: {
    name?: string;
    column: string;
    table: string;
    reference?: string;
    onDelete?: string;
    onUpdate?: string;
    deferrable?: boolean;
  }[];
  checks?: { name: string; expression: string }[];
  indexes?: (Partial<IndexDetailRow> & { name: string; keys: string[] })[];
  partition?: boolean;
  partitioned?: boolean;
};

/** A synthetic catalog in the shape readPullCatalog returns. */
const catalog = (
  tables: Table[],
  enumerations: { name: string; values: string[] }[] = [],
  undeclared: PullCatalog["undeclared"] = [],
): PullCatalog => {
  const constraints: CatalogConstraint[] = [];
  const constraint = (
    table: string,
    entry: Partial<CatalogConstraint> & {
      name: string;
      kind: string;
      columns: string[];
    },
  ) =>
    constraints.push({
      table_name: table,
      reference_table: null,
      reference_schema: null,
      reference_columns: [],
      on_delete: " ",
      on_update: " ",
      match: " ",
      deferrable: false,
      initially_deferred: false,
      no_inherit: false,
      nulls_not_distinct: false,
      validated: true,
      expression: null,
      definition: entry.name,
      ...entry,
    });

  for (const table of tables) {
    const key = table.primaryKey;

    if (key) {
      constraint(table.name, {
        name: Array.isArray(key) ? `${table.name}_pkey` : key.name,
        kind: "p",
        columns: Array.isArray(key) ? key : key.columns,
      });
    }

    for (const unique of table.unique ?? []) {
      const entry = typeof unique === "string" ? { columns: [unique] } : unique;
      constraint(table.name, {
        name: entry.name ?? `${table.name}_${entry.columns.join("_")}_key`,
        kind: "u",
        columns: entry.columns,
      });
    }

    for (const foreignKey of table.foreignKeys ?? []) {
      constraint(table.name, {
        name: foreignKey.name ?? `${table.name}_${foreignKey.column}_fkey`,
        kind: "f",
        columns: [foreignKey.column],
        reference_table: foreignKey.table,
        reference_columns: [foreignKey.reference ?? "id"],
        on_delete: foreignKey.onDelete ?? "a",
        on_update: foreignKey.onUpdate ?? "a",
        match: "s",
        deferrable: foreignKey.deferrable ?? false,
      });
    }

    for (const check of table.checks ?? []) {
      constraint(table.name, {
        name: check.name,
        kind: "c",
        columns: [],
        expression: check.expression,
      });
    }
  }

  const sorted = [...tables].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  return {
    schemaName: "public",
    undeclared,
    tables: sorted.map((table) => ({ name: table.name })),
    details: sorted.map((table) => ({
      name: table.name,
      kind: table.partitioned ? "p" : "r",
      partition: table.partition ?? false,
    })),
    columns: sorted.flatMap((table) =>
      [...table.columns]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((column) => ({
          table_name: table.name,
          column_name: column.name,
          data_type: column.type,
          enum_name: column.enumeration ?? null,
          enum_schema: null,
          not_null: !column.nullable,
          identity: column.identity ?? "",
          default: column.default ?? null,
          collation: column.collation ?? null,
        })),
    ),
    layout: sorted.flatMap((table) =>
      table.columns.map((column, position) => ({
        table_name: table.name,
        column_name: column.name,
        position: position + 1,
        generated: column.generated ? "s" : "",
      })),
    ),
    constraints,
    indexes: [
      ...constraints
        .filter((entry) => entry.kind === "p" || entry.kind === "u")
        .map((entry) => ({
          table_name: entry.table_name,
          name: entry.name,
          valid: true,
          ready: true,
          definition: entry.name,
          constraint: true,
        })),
      ...sorted.flatMap((table) =>
        (table.indexes ?? []).map((index) => ({
          table_name: table.name,
          name: index.name,
          valid: true,
          ready: true,
          definition: `CREATE INDEX ${index.name}`,
          constraint: false,
        })),
      ),
    ],
    indexDetails: sorted.flatMap((table) => [
      ...constraints
        .filter(
          (entry) => entry.table_name === table.name && entry.kind === "u",
        )
        .map((entry) => ({
          table_name: table.name,
          index_name: entry.name,
          is_unique: true,
          nulls_not_distinct: false,
          method: "btree",
          keys: entry.columns,
          options: entry.columns.map(() => 0),
          included: [],
          opclasses: entry.columns.map(() => null),
          collations: entry.columns.map(() => null),
          reloptions: null,
          predicate: null,
          definition: entry.name,
        })),
      ...(table.indexes ?? []).map((index) => ({
        table_name: table.name,
        index_name: index.name,
        is_unique: index.is_unique ?? false,
        nulls_not_distinct: false,
        method: index.method ?? "btree",
        keys: index.keys,
        options: index.options ?? index.keys.map(() => 0),
        included: index.included ?? [],
        opclasses: index.opclasses ?? index.keys.map(() => null),
        collations: index.collations ?? index.keys.map(() => null),
        reloptions: index.reloptions ?? null,
        predicate: index.predicate ?? null,
        definition: `CREATE INDEX ${index.name}`,
      })),
    ]),
    enumerations,
    extensions: [],
  };
};

const runtime = resolve("packages/runtime/src/index.ts");

const members = (model: ReturnType<typeof buildPulledSchema>, table: string) =>
  model.tables.find((entry) => entry.sqlName === table)!.members;

const column = (
  model: ReturnType<typeof buildPulledSchema>,
  table: string,
  name: string,
) =>
  members(model, table).find(
    (member) => member.sqlName === name,
  ) as PulledColumn;

const reference = (
  model: ReturnType<typeof buildPulledSchema>,
  table: string,
  name: string,
) =>
  members(model, table).find(
    (member) => member.sqlName === name,
  ) as PulledReference;

describe("pull: names", () => {
  test("keys round-trip through snakeCase or are rejected", () => {
    expect(camelKey("created_at")).toBe("createdAt");
    expect(camelKey("id")).toBe("id");
    expect(camelKey("field2")).toBe("field2");
    expect(camelKey("CamelCol")).toBeUndefined();
    expect(camelKey("weird__name")).toBeUndefined();
    expect(camelKey("_private")).toBeUndefined();
    expect(camelKey("trailing_")).toBeUndefined();
    expect(camelKey("field_2")).toBeUndefined();
    expect(camelKey("2fa")).toBeUndefined();
  });

  test("template escaping keeps backticks, interpolations and backslashes literal", () => {
    expect(escapeTemplate("a`b${c}\\d")).toBe("a\\`b\\${c}\\\\d");
  });
});

describe("pull: columns", () => {
  test("builders, modifiers and defaults", () => {
    const model = buildPulledSchema(
      catalog(
        [
          {
            name: "users",
            primaryKey: ["id"],
            unique: ["email"],
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "email", type: "text" },
              {
                name: "role",
                type: "users_role_enum",
                enumeration: "users_role_enum",
                default: "'member'::users_role_enum",
              },
              { name: "nick", type: "character varying(40)", nullable: true },
              { name: "balance", type: "numeric(12,2)", default: "0.00" },
              { name: "ratio", type: "numeric", nullable: true },
              { name: "settings", type: "jsonb", default: "'{}'::jsonb" },
              { name: "tags", type: "text[]", default: "'{}'::text[]" },
              {
                name: "created_at",
                type: "timestamp with time zone",
                default: "now()",
              },
              { name: "token", type: "uuid", default: "gen_random_uuid()" },
              { name: "visits", type: "bigint", default: "0" },
              { name: "active", type: "boolean", default: "true" },
              { name: "label", type: "text", default: "'it''s'::text" },
              { name: "born", type: "date", nullable: true },
              { name: "score", type: "smallint", default: "'-1'::integer" },
              { name: "ratio_f", type: "real", default: "0.5" },
              {
                name: "started",
                type: "time without time zone",
                default: "'09:00:00'::time without time zone",
              },
              { name: "ttl", type: "interval", default: "'1 day'::interval" },
              { name: "ip", type: "inet", nullable: true },
              { name: "blob", type: "bytea", default: "'\\x00'::bytea" },
              { name: "price", type: "money", nullable: true },
              { name: "note", type: "text", default: "upper('x'::text)" },
              { name: "document", type: "tsvector", nullable: true },
              { name: "code", type: "character varying", nullable: true },
            ],
            indexes: [{ name: "users_nick_idx", keys: ["nick"] }],
          },
        ],
        [{ name: "users_role_enum", values: ["admin", "member"] }],
      ),
    );
    const source = renderSchema(model);

    expect(column(model, "users", "id")).toMatchObject({
      type: { kind: "builder", name: "int" },
      default: { kind: "auto" },
      primaryKey: false,
    });
    expect(column(model, "users", "email").unique).toBe(true);
    expect(column(model, "users", "role")).toMatchObject({
      type: { kind: "enum", values: ["admin", "member"] },
      default: { kind: "value", source: '"member"' },
    });
    expect(column(model, "users", "nick")).toMatchObject({
      type: { kind: "varchar", length: 40 },
      nullable: true,
      index: true,
    });
    expect(column(model, "users", "balance")).toMatchObject({
      type: { kind: "numeric", precision: 12, scale: 2 },
      default: { kind: "value", source: '"0.00"' },
    });
    expect(column(model, "users", "ratio").type).toEqual({ kind: "numeric" });
    expect(column(model, "users", "settings").default).toEqual({
      kind: "value",
      source: "{}",
    });
    expect(column(model, "users", "tags")).toMatchObject({
      array: true,
      default: { kind: "sql", sql: "'{}'::text[]" },
    });
    expect(column(model, "users", "created_at").default).toEqual({
      kind: "now",
    });
    expect(column(model, "users", "token").default).toEqual({ kind: "v4" });
    expect(column(model, "users", "visits").default).toEqual({
      kind: "value",
      source: "0n",
    });
    expect(column(model, "users", "active").default).toEqual({
      kind: "value",
      source: "true",
    });
    expect(column(model, "users", "label").default).toEqual({
      kind: "value",
      source: '"it\'s"',
    });
    expect(column(model, "users", "born").type).toEqual({
      kind: "builder",
      name: "date",
    });
    expect(column(model, "users", "score")).toMatchObject({
      type: { kind: "builder", name: "smallint" },
      default: { kind: "value", source: "-1" },
    });
    expect(column(model, "users", "ratio_f")).toMatchObject({
      type: { kind: "builder", name: "real" },
      default: { kind: "value", source: "0.5" },
    });
    expect(column(model, "users", "started")).toMatchObject({
      type: { kind: "builder", name: "time" },
      default: { kind: "value", source: '"09:00:00"' },
    });
    expect(column(model, "users", "ttl")).toMatchObject({
      type: { kind: "builder", name: "interval" },
      default: { kind: "value", source: '"1 day"' },
    });
    expect(column(model, "users", "ip")).toMatchObject({
      type: { kind: "builder", name: "inet" },
      nullable: true,
    });
    expect(column(model, "users", "blob")).toMatchObject({
      type: { kind: "builder", name: "bytea" },
      default: { kind: "sql", sql: "'\\x00'::bytea" },
    });
    expect(column(model, "users", "price").type).toEqual({
      kind: "custom",
      sqlType: "money",
      valueType: "number",
    });
    expect(column(model, "users", "note").default).toEqual({
      kind: "sql",
      sql: "upper('x'::text)",
    });
    expect(column(model, "users", "document")).toMatchObject({
      type: { kind: "builder", name: "tsvector" },
      nullable: true,
    });
    expect(column(model, "users", "code").type).toEqual({ kind: "varchar" });
    expect(column(model, "users", "ratio").type).toEqual({ kind: "numeric" });
    expect(source).toContain("code: varchar.nullable,");
    expect(source).toContain("ratio: numeric.nullable,");
    expect(source).toContain("document: tsvector.nullable,");
    expect(source).toMatch(/import \{[^}]*tsvector[^}]*\} from/);
    expect(model.warnings.map((warning) => warning.code)).toEqual([
      "custom-type",
    ]);
    expect(source).toContain(
      'role: oneOf("admin", "member").default("member"),',
    );
    expect(source).toContain("tags: text.array.default(sql`'{}'::text[]`),");
    expect(source).toContain("born: date.nullable,");
    expect(source).toContain("score: smallint.default(-1),");
    expect(source).toContain("blob: bytea.default(sql`'\\\\x00'::bytea`),");
    expect(source).toContain(
      'price: customType<number>("money", passthrough<number>()).nullable, // pull: no builder for money',
    );
    expect(source).toMatch(
      /import \{[^}]*bytea,\s+customType,\s+date,[^}]*\} from/,
    );
    expect(source).toContain("nick: varchar(40).nullable.index,");
    expect(source).toContain("const passthrough = <Value>() => ({");
  });

  test("identities and shared enums are declared; serial and generated columns are approximated with warnings", () => {
    const model = buildPulledSchema(
      catalog(
        [
          {
            name: "events",
            primaryKey: ["id"],
            columns: [
              {
                name: "id",
                type: "integer",
                default: "nextval('events_id_seq'::regclass)",
              },
              { name: "big", type: "bigint", identity: "d" },
              { name: "small", type: "smallint", identity: "a" },
              {
                name: "total",
                type: "integer",
                default: "(a + b)",
                generated: true,
              },
              {
                name: "mood",
                type: "mood",
                enumeration: "mood",
                default: "'sad'::mood",
              },
              {
                name: "other",
                type: "mood",
                enumeration: "mood",
                nullable: true,
              },
              { name: "moods", type: "mood[]", nullable: true },
            ],
          },
        ],
        [{ name: "mood", values: ["happy", "sad"] }],
      ),
    );

    expect(column(model, "events", "id").default).toEqual({
      kind: "sql",
      sql: "nextval('events_id_seq'::regclass)",
    });
    expect(column(model, "events", "big").default).toEqual({
      kind: "auto",
      byDefault: true,
    });
    expect(column(model, "events", "small")).toMatchObject({
      type: { kind: "builder", name: "smallint" },
      default: { kind: "auto" },
    });
    expect(column(model, "events", "total").default).toBeUndefined();
    // A shared enum keeps its own name on every column that uses it.
    expect(column(model, "events", "mood")).toMatchObject({
      type: { kind: "enum", values: ["happy", "sad"], name: "mood" },
      default: { kind: "value", source: '"sad"' },
    });
    expect(column(model, "events", "other").type).toEqual({
      kind: "enum",
      values: ["happy", "sad"],
      name: "mood",
    });
    expect(column(model, "events", "moods").type).toEqual({
      kind: "custom",
      sqlType: "mood[]",
      valueType: "string[]",
    });
    expect(model.enumerations).toEqual(["mood"]);
    expect(
      model.warnings.map((warning) => String(warning.code)).sort(),
    ).toEqual(["serial", "generated-column", "custom-type"].sort());

    // The serial fix keeps explicit ids working and continues the sequence.
    const fix = model.warnings.find(
      (warning) => warning.code === "serial",
    )?.fix;
    expect(fix).toBe(
      `ALTER TABLE "events" ALTER COLUMN "id" DROP DEFAULT; ALTER SEQUENCE events_id_seq OWNED BY NONE; ALTER TABLE "events" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY; SELECT setval(pg_get_serial_sequence('"events"', 'id'), GREATEST(COALESCE(MAX("id"), 0), (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM events_id_seq)) + 1, false) FROM "events"; DROP SEQUENCE events_id_seq;`,
    );

    const source = renderSchema(model);
    expect(source).toContain("small: smallint.auto,");
    expect(source).toContain("big: bigint.auto.byDefault,");
    expect(source).toContain(
      'mood: oneOf("happy", "sad").typeName("mood").default("sad"),',
    );
    expect(source).toContain(
      'other: oneOf("happy", "sad").typeName("mood").nullable,',
    );
  });
});

describe("pull: tables and relations", () => {
  const legacy = () =>
    catalog([
      {
        name: "users",
        primaryKey: ["id"],
        columns: [{ name: "id", type: "integer", identity: "a" }],
      },
      {
        name: "posts",
        primaryKey: ["id"],
        columns: [
          { name: "id", type: "integer", identity: "a" },
          { name: "author_id", type: "integer" },
          { name: "editor_id", type: "integer", nullable: true },
          { name: "title", type: "text" },
        ],
        foreignKeys: [
          { column: "author_id", table: "users", onDelete: "c" },
          {
            column: "editor_id",
            table: "users",
            onDelete: "n",
            name: "fk_editor",
          },
        ],
        indexes: [{ name: "posts_author_id_idx", keys: ["author_id"] }],
        checks: [
          {
            name: "posts_title_not_empty_check",
            expression: "(length(title) > 0)",
          },
          { name: "title_short", expression: "(length(title) < 100)" },
        ],
      },
      {
        name: "tags",
        primaryKey: ["id"],
        columns: [
          { name: "id", type: "bigint", identity: "a" },
          { name: "label", type: "text" },
        ],
        unique: [{ name: "tags_label_unique", columns: ["label"] }],
      },
      {
        name: "post_tags",
        primaryKey: ["post_id", "tag_id"],
        columns: [
          { name: "post_id", type: "integer" },
          { name: "tag_id", type: "bigint" },
          {
            name: "added_at",
            type: "timestamp with time zone",
            default: "now()",
          },
        ],
        foreignKeys: [
          { column: "post_id", table: "posts", onDelete: "c" },
          { column: "tag_id", table: "tags", onDelete: "c" },
        ],
        indexes: [{ name: "post_tags_tag_id_idx", keys: ["tag_id"] }],
      },
      {
        name: "categories",
        primaryKey: ["id"],
        columns: [
          { name: "id", type: "integer", identity: "a" },
          { name: "parent_id", type: "integer", nullable: true },
        ],
        foreignKeys: [
          { column: "parent_id", table: "categories", onDelete: "c" },
        ],
      },
      {
        name: "profiles",
        primaryKey: ["user_id"],
        columns: [
          { name: "user_id", type: "integer" },
          { name: "bio", type: "text", nullable: true },
        ],
        foreignKeys: [{ column: "user_id", table: "users", onDelete: "c" }],
      },
      {
        name: "audit",
        primaryKey: { name: "audit_pk", columns: ["code", "seq"] },
        columns: [
          { name: "code", type: "text" },
          { name: "seq", type: "integer" },
        ],
        unique: [{ columns: ["code", "seq"] }],
      },
    ]);

  test("foreign keys become relations with flags, inverses and junctions", () => {
    const model = buildPulledSchema(legacy());

    expect(reference(model, "posts", "author_id")).toMatchObject({
      key: "author",
      target: "users",
      nullable: false,
      index: true,
      onDelete: "cascade",
    });
    expect(reference(model, "posts", "author_id").inverse).toBeUndefined();
    expect(reference(model, "posts", "editor_id")).toMatchObject({
      key: "editor",
      nullable: true,
      onDelete: "setNull",
      inverse: "postsByEditor",
    });
    expect(reference(model, "categories", "parent_id").inverse).toBe(
      "categoriesByParent",
    );

    const junction = model.tables.find(
      (table) => table.sqlName === "post_tags",
    )!;
    expect(junction.junction).toBe(true);
    expect(junction.members.map((member) => member.key)).toEqual([
      "post",
      "tag",
      "addedAt",
    ]);
    expect((junction.members[1] as PulledReference).index).toBe(false);

    const profiles = model.tables.find(
      (table) => table.sqlName === "profiles",
    )!;
    expect(profiles.primaryKey).toEqual(["userId"]);
    const audit = model.tables.find((table) => table.sqlName === "audit")!;
    expect(audit.primaryKey).toEqual(["code", "seq"]);
    expect(column(model, "tags", "label").unique).toBe(true);

    const posts = model.tables.find((table) => table.sqlName === "posts")!;
    expect(posts.checks.map((check) => check.key)).toEqual([
      "titleNotEmpty",
      "titleShort",
    ]);
    expect(
      model.warnings
        .filter((warning) => warning.code === "constraint-name")
        .map((warning) => warning.fix),
    ).toEqual([
      'ALTER TABLE "audit" RENAME CONSTRAINT "audit_pk" TO "audit_pkey";',
      'ALTER TABLE "posts" RENAME CONSTRAINT "fk_editor" TO "posts_editor_id_fkey";',
      'ALTER TABLE "posts" RENAME CONSTRAINT "title_short" TO "posts_title_short_check";',
      'ALTER TABLE "tags" RENAME CONSTRAINT "tags_label_unique" TO "tags_label_key";',
    ]);
    expect(
      model.warnings.filter((warning) => warning.code === "unique-constraint"),
    ).toHaveLength(1);
  });

  test("ineligible foreign keys stay plain columns", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "users",
          primaryKey: ["id"],
          unique: ["email"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "email", type: "text" },
          ],
        },
        {
          name: "logins",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "owner", type: "integer" },
            { name: "email", type: "text" },
            { name: "user_id", type: "bigint" },
            { name: "editor_id", type: "integer" },
            { name: "other_id", type: "integer" },
          ],
          foreignKeys: [
            { column: "owner", table: "users" },
            { column: "email", table: "users", reference: "email" },
            { column: "user_id", table: "users" },
            { column: "editor_id", table: "users", onUpdate: "c" },
            { column: "other_id", table: "users", deferrable: true },
          ],
        },
      ]),
    );
    const reasons = model.warnings
      .filter((warning) => warning.code === "foreign-key")
      .map((warning) => warning.message);

    // Non-conventional column names and unique-column targets are declared with column() / by().
    expect(
      members(model, "logins").find((member) => member.key === "owner"),
    ).toMatchObject({ kind: "reference", target: "users", column: "owner" });
    expect(
      members(model, "logins").find((member) => member.key === "email"),
    ).toMatchObject({
      kind: "reference",
      target: "users",
      by: "email",
      column: "email",
    });
    expect(
      members(model, "logins")
        .filter((member) => member.kind === "column")
        .map((member) => member.key),
    ).toEqual(["id", "userId", "otherId"]);
    expect(reasons).toEqual([
      expect.stringContaining("differs from the referenced key"),
      expect.stringContaining("deferrable"),
    ]);
    // ON UPDATE CASCADE, Prisma's default, is declared.
    expect(renderSchema(model)).toContain(
      'editor: users.onDelete.noAction.onUpdate.cascade.inverse("loginsByEditor"),',
    );
    expect(renderSchema(model)).toContain(
      'owner: users.column("owner").onDelete.noAction,',
    );
    expect(renderSchema(model)).toContain(
      'email: users.by("email").column("email").onDelete.noAction.inverse("loginsByEmail"),',
    );
  });

  test("foreign keys to non-unique columns or clashing keys stay plain columns", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "users",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "name", type: "text" },
          ],
        },
        {
          name: "logins",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "owner", type: "integer" },
            { name: "owner_id", type: "integer" },
            { name: "name", type: "text" },
          ],
          foreignKeys: [
            { column: "owner", table: "users" },
            { column: "name", table: "users", reference: "name" },
          ],
        },
      ]),
    );

    expect(
      members(model, "logins").every((member) => member.kind === "column"),
    ).toBe(true);
    expect(
      model.warnings
        .filter((warning) => warning.code === "foreign-key")
        .map((warning) => warning.message),
    ).toEqual([
      expect.stringContaining('a column already uses the key "ownerId"'),
      expect.stringContaining("single-column primary key or UNIQUE constraint"),
    ]);
  });

  test("relation names that would clash get inverses; a second junction between the same tables stays a plain table", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "users",
          primaryKey: ["id"],
          columns: [{ name: "id", type: "integer", identity: "a" }],
        },
        {
          name: "groups",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "owner_id", type: "integer" },
          ],
          foreignKeys: [{ column: "owner_id", table: "users" }],
        },
        {
          name: "memberships",
          primaryKey: ["user_id", "group_id"],
          columns: [
            { name: "user_id", type: "integer" },
            { name: "group_id", type: "integer" },
          ],
          foreignKeys: [
            { column: "user_id", table: "users" },
            { column: "group_id", table: "groups" },
          ],
          indexes: [{ name: "memberships_group_id_idx", keys: ["group_id"] }],
        },
        {
          name: "admins",
          primaryKey: ["user_id", "group_id"],
          columns: [
            { name: "user_id", type: "integer" },
            { name: "group_id", type: "integer" },
          ],
          foreignKeys: [
            { column: "user_id", table: "users" },
            { column: "group_id", table: "groups" },
          ],
          indexes: [{ name: "admins_group_id_idx", keys: ["group_id"] }],
        },
      ]),
    );
    const table = (name: string) =>
      model.tables.find((entry) => entry.sqlName === name)!;

    // The first junction (by name) claims users.groups and groups.users; the
    // reverse of groups.owner moves to an explicit inverse.
    expect(table("admins").junction).toBe(true);
    expect(reference(model, "groups", "owner_id").inverse).toBe(
      "groupsByOwner",
    );
    expect(table("memberships").junction).toBe(false);
    expect(table("memberships").primaryKey).toEqual(["userId", "groupId"]);
    expect(
      model.warnings.some(
        (warning) =>
          warning.code === "foreign-key" && warning.message.includes("clash"),
      ),
    ).toBe(true);
  });

  test("partitions, undeclarable names and tables without keys are reported", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "Measurements",
          primaryKey: ["id"],
          columns: [{ name: "id", type: "integer", identity: "a" }],
        },
        {
          name: "events",
          primaryKey: ["id"],
          partitioned: true,
          columns: [{ name: "id", type: "integer", identity: "a" }],
        },
        {
          name: "events_2026",
          partition: true,
          columns: [{ name: "id", type: "integer" }],
        },
        {
          name: "loose",
          columns: [
            { name: "id", type: "integer", nullable: true },
            { name: "label", type: "text", nullable: true },
          ],
        },
        {
          name: "strict",
          columns: [{ name: "id", type: "integer" }],
        },
      ]),
    );

    // Names a key cannot produce are declared with .named().
    expect(model.tables.map((table) => table.sqlName)).toEqual([
      "events",
      "loose",
      "Measurements",
      "strict",
    ]);
    expect(model.skippedTables.map((table) => table.sqlName).sort()).toEqual([
      "events_2026",
    ]);
    expect(renderSchema(model)).toContain('.named("Measurements")');
    expect(members(model, "loose").map((member) => member.key)).toEqual([
      "label",
    ]);
    expect(
      model.tables.find((table) => table.sqlName === "loose")!.skipped,
    ).toHaveLength(1);
    expect(
      model.warnings.map((warning) => String(warning.code)).sort(),
    ).toEqual(["partition", "partition", "primary-key", "primary-key"].sort());
  });

  test("indexes are declared with ordering, INCLUDE, predicates, methods and exact names", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "posts",
          primaryKey: ["id"],
          unique: [{ columns: ["code", "seq"] }],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "title", type: "text" },
            { name: "body", type: "text", nullable: true },
            { name: "meta", type: "jsonb" },
            {
              name: "published_at",
              type: "timestamp with time zone",
              nullable: true,
            },
            { name: "code", type: "text" },
            { name: "seq", type: "integer" },
            { name: "Odd", type: "text", nullable: true },
          ],
          indexes: [
            {
              name: "posts_title_lower_idx",
              keys: ["lower(title)"],
              options: [3],
            },
            {
              name: "posts_recent_idx",
              keys: ["published_at", "id"],
              options: [1, 0],
              included: ["body"],
              predicate: "(published_at IS NOT NULL)",
            },
            { name: "posts_meta_idx", keys: ["meta"], method: "gin" },
            {
              name: "posts_title_pattern_idx",
              keys: ["title"],
              opclasses: ["text_pattern_ops"],
            },
            { name: "posts_code_unique_idx", keys: ["code"], is_unique: true },
            { name: "legacy_title", keys: ["title", "code"] },
            { name: "Posts_Odd", keys: ["title"] },
            { name: "posts_odd_idx", keys: ['"Odd"'] },
            {
              name: "posts_hash_two_idx",
              keys: ["title", "code"],
              method: "hash",
            },
            { name: "posts_next_seq_idx", keys: ["(seq + 1)"] },
          ],
        },
      ]),
    );
    const posts = model.tables.find((table) => table.sqlName === "posts")!;
    const source = renderSchema(model);

    expect(posts.indexes.map((index) => index.key)).toEqual([
      "titleLower",
      "recent",
      "meta",
      "titlePattern",
      "codeUnique",
      "odd",
      "nextSeq",
    ]);
    expect(posts.indexes[0]).toMatchObject({
      keys: [
        {
          kind: "expression",
          source: "lower(${posts.title})",
          descending: true,
        },
      ],
    });
    expect(posts.indexes[0]!.keys[0]!.nulls).toBeUndefined();
    expect(posts.indexes[1]).toMatchObject({
      keys: [
        {
          kind: "column",
          source: "publishedAt",
          descending: true,
          nulls: "last",
        },
        { kind: "column", source: "id", descending: false },
      ],
      include: ["body"],
      where: {
        kind: "predicate",
        source: "posts.publishedAt.isNot(null)",
        imports: [],
      },
    });
    // Arithmetic over columns is a DSL key, not SQL text.
    expect(posts.indexes[6]!.keys).toEqual([
      { kind: "value", source: "posts.seq.plus(1)", descending: false },
    ]);
    expect(model.schemaIndexes.map(({ index }) => index.key)).toEqual([
      "posts_code_seq_key",
      "legacy_title",
    ]);
    expect(source).toContain(
      "titleLower: index(sql<string>`lower(${posts.title})`.descending),",
    );
    expect(source).toContain(
      "recent: index(posts.publishedAt.descending.nullsLast, posts.id).include(posts.body).where(posts.publishedAt.isNot(null)),",
    );
    expect(source).toContain("nextSeq: index(posts.seq.plus(1)),");
    expect(source).toContain('meta: index(posts.meta).using("gin"),');
    expect(source).toContain(
      'titlePattern: index(operatorClass(posts.title, "text_pattern_ops")),',
    );
    expect(source).toContain("codeUnique: index(posts.code).unique,");
    expect(source).toContain(
      "posts_code_seq_key: index(posts.code, posts.seq).unique,",
    );
    expect(source).toContain(
      "legacy_title: index(posts.title, posts.code), // pull: name kept exactly",
    );
    expect(source).toContain("indexes: ({ posts }) => ({");
    expect(
      model.warnings
        .filter((warning) => warning.code === "index")
        .map((warning) => warning.object),
    ).toEqual(["Posts_Odd", "posts_hash_two_idx"]);
    expect(
      model.warnings.find((warning) => warning.code === "unique-constraint")
        ?.fix,
    ).toBe(
      'ALTER TABLE "posts" DROP CONSTRAINT "posts_code_seq_key"; CREATE UNIQUE INDEX "posts_code_seq_key" ON "posts" ("code", "seq");',
    );
  });

  test("the rendered module loads and snapshots like a hand-written schema", () =>
    withMigrationDirectory(async (directory) => {
      const model = buildPulledSchema(legacy());
      const source = renderSchema(model, { module: runtime });
      const path = join(directory, "schema.ts");
      await writeFile(path, source);
      const loaded = await import(pathToFileURL(path).href);
      const snapshot = migrationSnapshot(loaded.appSchema.$snapshot());
      const table = (name: string) =>
        snapshot.tables.find((entry) => entry.name === name)!;

      expect(renderSchema(model, { module: runtime })).toBe(source);
      expect(
        table("posts").columns.find((column) => column.name === "author_id"),
      ).toMatchObject({
        notNull: true,
        references: { table: "users", column: "id", onDelete: "cascade" },
      });
      expect(
        table("posts").columns.find((column) => column.name === "editor_id"),
      ).toMatchObject({
        notNull: false,
        references: { table: "users", column: "id", onDelete: "set null" },
      });
      expect(table("posts").indexes.map((index) => index.sqlName)).toEqual([
        "posts_author_id_idx",
      ]);
      expect(table("posts").checks?.map((check) => check.sqlName)).toEqual([
        "posts_title_not_empty_check",
        "posts_title_short_check",
      ]);
      expect(table("post_tags").primaryKey).toEqual(["post_id", "tag_id"]);
      expect(table("post_tags").indexes.map((index) => index.sqlName)).toEqual([
        "post_tags_tag_id_idx",
      ]);
      expect(
        table("tags").columns.find((column) => column.name === "id"),
      ).toMatchObject({
        sqlType: "bigint",
        identity: true,
      });
      expect(table("profiles").primaryKey).toEqual(["user_id"]);
      expect(table("audit").primaryKey).toEqual(["code", "seq"]);
      expect(
        table("categories").columns.find(
          (column) => column.name === "parent_id",
        )?.references,
      ).toEqual({
        table: "categories",
        column: "id",
        onDelete: "cascade",
      });
    }));

  test("a Prisma database keeps its names, keys and timestamps", () => {
    const model = buildPulledSchema(
      catalog(
        [
          {
            name: "_prisma_migrations",
            primaryKey: ["id"],
            columns: [{ name: "id", type: "character varying(36)" }],
          },
          {
            name: "User",
            primaryKey: { name: "User_pkey", columns: ["id"] },
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "email", type: "text" },
              {
                name: "createdAt",
                type: "timestamp(3) without time zone",
                default: "CURRENT_TIMESTAMP",
              },
              { name: "updatedAt", type: "timestamp(3) without time zone" },
            ],
            indexes: [
              { name: "User_email_key", keys: ["email"], is_unique: true },
            ],
          },
          {
            name: "Post",
            primaryKey: { name: "Post_pkey", columns: ["id"] },
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "authorId", type: "integer" },
              { name: "viewCount", type: "integer", default: "0" },
            ],
            foreignKeys: [
              {
                name: "Post_authorId_fkey",
                column: "authorId",
                table: "User",
                onDelete: "r",
                onUpdate: "c",
              },
            ],
            indexes: [{ name: "Post_authorId_idx", keys: ['"authorId"'] }],
          },
        ],
        [],
        [
          {
            kind: "view",
            name: "PublishedPost",
            table_name: null,
            definition: "SELECT 1",
          },
          {
            kind: "trigger",
            name: "User_touch",
            table_name: "User",
            definition: "CREATE TRIGGER …",
          },
        ],
      ),
    );
    const source = renderSchema(model);

    expect(model.casing).toBe("preserve");
    expect(model.tables.map((table) => [table.key, table.sqlName])).toEqual([
      ["post", "Post"],
      ["user", "User"],
    ]);
    expect(source).toContain('    casing: "preserve",');
    expect(source).toContain('.named("User")');
    expect(source).toContain(
      "createdAt: timestamp(3).default(sql`CURRENT_TIMESTAMP`),",
    );
    expect(source).toContain("updatedAt: timestamp(3),");
    expect(source).toContain(
      'email: text.unique, // pull: unique index "User_email_key" becomes a constraint',
    );
    expect(source).toContain("author: user.index.onUpdate.cascade,");
    expect(source).toContain("viewCount: int.default(0),");
    expect(model.skippedTables).toEqual([
      {
        sqlName: "_prisma_migrations",
        reason: "Prisma's migration history; Symmetria keeps its own",
      },
    ]);
    expect(
      model.warnings.map((warning) => [warning.code, warning.object ?? ""]),
    ).toEqual([
      ["view", "PublishedPost"],
      ["trigger", "User_touch"],
      ["migration-table", ""],
      ["unique-index", "User_email_key"],
    ]);
    expect(
      model.warnings.find((warning) => warning.code === "unique-index")?.fix,
    ).toBe(
      'ALTER TABLE "User" ADD CONSTRAINT "User_email_key" UNIQUE USING INDEX "User_email_key";',
    );
  });

  test("mixed names fall back to .named() under either casing", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "order_items",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "unit_price", type: "numeric(10,2)" },
            { name: "LegacyCode", type: "text", nullable: true },
            { name: "index", type: "integer" },
          ],
        },
      ]),
    );

    expect(model.casing).toBe("snake_case");
    expect(renderSchema(model)).toContain(
      'legacyCode: text.named("LegacyCode").nullable,',
    );
    expect(renderSchema(model)).toContain("unitPrice: numeric(10, 2),");
    // A key shared with a table method stays usable inside shape callbacks.
    expect(renderSchema(model)).toContain("index: int,");
  });

  test("conditions stored as (expr) = true are declared without the comparison", () => {
    expect(withoutTruthComparison("((small > '-100'::integer) = true)")).toBe(
      "(small > '-100'::integer)",
    );
    expect(withoutTruthComparison("((((a > 0) = true) = true))")).toBe(
      "(a > 0)",
    );
    // Only a whole parenthesized operand compared with true is unwrapped.
    for (const kept of [
      "(flag = true)",
      "((a > 0) AND (b = true))",
      "((a > 0) >= true)",
      "(note = ') = true')",
      "(length(title) > 0)",
    ]) {
      expect(withoutTruthComparison(kept)).toBe(kept);
    }
  });

  test("conditions become predicates when PostgreSQL stored the form the DSL writes", () => {
    const checks: Record<string, string> = {
      small: "(small > '-100'::integer)",
      big: "(big >= '0'::bigint)",
      bigInteger: "(big < 10)",
      price: "((price > '0'::numeric) AND (price <> 0.5))",
      ratio: "(ratio < ((1.5)::text)::real)",
      ratioDouble: "(ratio < (1.5)::double precision)",
      range: "((score >= 1) AND (score <= 10))",
      state:
        "(state = ANY (ARRAY['open'::items_state_enum, 'held'::items_state_enum]))",
      stateUnknown: "(state <> 'gone'::items_state_enum)",
      label: "((label IS NULL) OR ((label)::text !~~ 'x%'::text))",
      active: "active",
      inactive: "(active = false)",
      sum: "((score + 1) > (score * 2))",
      at: "(at > '2020-01-01 10:00:00.5+02'::timestamp with time zone)",
      atMicro:
        "(at > '2020-01-01 10:00:00.123456+00'::timestamp with time zone)",
      atDate: "(at > '2020-01-01'::date)",
      call: "(length((label)::text) > 0)",
    };
    const model = buildPulledSchema({
      ...catalog(
        [
          {
            name: "items",
            primaryKey: ["id"],
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "small", type: "smallint" },
              { name: "big", type: "bigint" },
              { name: "score", type: "integer" },
              { name: "price", type: "numeric(10,2)" },
              { name: "ratio", type: "real" },
              { name: "label", type: "character varying(10)", nullable: true },
              {
                name: "state",
                type: "items_state_enum",
                enumeration: "items_state_enum",
              },
              { name: "active", type: "boolean" },
              { name: "at", type: "timestamp with time zone" },
              { name: "srid", type: "integer" },
            ],
            foreignKeys: [
              { column: "srid", table: "spatial_ref_sys", reference: "srid" },
            ],
            checks: Object.entries(checks).map(([key, expression]) => ({
              name: objectName(
                "items",
                key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
                "check",
              ),
              expression,
            })),
          },
        ],
        [{ name: "items_state_enum", values: ["open", "held"] }],
      ),
      ignored: ["spatial_ref_sys"],
    });
    const items = model.tables.find((table) => table.sqlName === "items")!;
    const declared = Object.fromEntries(
      items.checks.map((check) => [
        check.key,
        check.condition.kind === "predicate"
          ? check.condition.source
          : `sql: ${check.condition.template}`,
      ]),
    );

    expect(declared).toEqual({
      small: "items.small.above(-100)",
      big: "items.big.atLeast(0n)",
      // An integer literal next to a bigint uses another operator than 10n.
      bigInteger: "sql: (${items.big} < 10)",
      price: 'and(items.price.above("0"), items.price.isNot("0.5"))',
      ratio: "items.ratio.below(1.5)",
      ratioDouble: "sql: (${items.ratio} < (1.5)::double precision)",
      range: "items.score.between(1, 10)",
      state: 'items.state.in(["open", "held"])',
      // Not a label of the enum, so not a value the column's type accepts.
      stateUnknown: "sql: (${items.state} <> 'gone'::items_state_enum)",
      label: 'or(items.label.is(null), not(items.label.like("x%")))',
      active: "items.active",
      inactive: "items.active.is(false)",
      sum: "items.score.plus(1).above(items.score.multiply(2))",
      at: 'items.at.above(new Date("2020-01-01T08:00:00.500Z"))',
      atMicro:
        "sql: (${items.at} > '2020-01-01 10:00:00.123456+00'::timestamp with time zone)",
      atDate: "sql: (${items.at} > '2020-01-01'::date)",
      call: "sql: (length((${items.label})::text) > 0)",
    });
    expect(
      items.checks.find((check) => check.key === "label")?.condition,
    ).toMatchObject({ imports: ["not", "or"] });

    const source = renderSchema(model);
    // and(), not() and or() are imported in order with the builders.
    expect(source).toContain(
      "import {\n  and,\n  bigint,\n  bool,\n  int,\n  not,\n  numeric,\n  oneOf,\n  or,\n",
    );
    expect(
      model.warnings.find((warning) => warning.code === "foreign-key"),
    ).toMatchObject({
      column: "srid",
      message:
        'foreign key "items_srid_fkey" is kept as a plain column: the referenced table "spatial_ref_sys" is ignored (ignoreTables)',
    });
  });

  test("long names: hashed derived names are recognized, truncated ones are declared exactly", () => {
    const longTable = "customer_subscription_billing_adjustments";
    const hashedIndex = objectName(
      longTable,
      "previous_invoice_reference",
      "idx",
    );
    // What PostgreSQL keeps of a name over 63 bytes: its first 63 bytes.
    const truncatedIndex =
      `${longTable}_previous_invoice_reference_amount_idx`.slice(0, 63);
    const model = buildPulledSchema(
      catalog([
        {
          name: longTable,
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "previous_invoice_reference", type: "text" },
            { name: "amount", type: "integer" },
          ],
          checks: [
            {
              name: objectName(
                longTable,
                "amount_is_positive_and_bounded",
                "check",
              ),
              expression: "((amount > 0) AND (amount < 1000))",
            },
          ],
          indexes: [
            { name: hashedIndex, keys: ["previous_invoice_reference"] },
            {
              name: truncatedIndex,
              keys: ["previous_invoice_reference", "amount"],
            },
          ],
        },
      ]),
    );
    const source = renderSchema(model);

    expect(source).toContain("previousInvoiceReference: text.index,");
    expect(source).toContain(
      `${truncatedIndex}: index(customerSubscriptionBillingAdjustments.previousInvoiceReference, customerSubscriptionBillingAdjustments.amount), // pull: name kept exactly`,
    );
    // A hashed check name cannot give back its key: the readable part stands in,
    // and the rename it suggests leads to a name the next pull keeps.
    const check = model.warnings.find(
      (warning) => warning.code === "constraint-name",
    );
    expect(check?.fix).toBe(
      `ALTER TABLE "${longTable}" RENAME CONSTRAINT "${objectName(longTable, "amount_is_positive_and_bounded", "check")}" TO "${longTable}_amount_i_check";`,
    );
    expect(model.warnings.map((warning) => warning.code)).toEqual([
      "constraint-name",
    ]);
  });

  test("collations are declared on text columns; relation columns take the referenced key's", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "codes",
          primaryKey: ["code"],
          columns: [
            { name: "code", type: "text", collation: "C" },
            {
              name: "label",
              type: "character varying(20)",
              collation: "POSIX",
            },
          ],
        },
        {
          name: "uses",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "code_id", type: "text", collation: "C" },
            { name: "fallback_id", type: "text", nullable: true },
          ],
          foreignKeys: [
            { column: "code_id", table: "codes", reference: "code" },
            { column: "fallback_id", table: "codes", reference: "code" },
          ],
          indexes: [
            {
              name: "uses_code_id_idx",
              keys: ["code_id"],
              collations: ["POSIX"],
            },
          ],
        },
      ]),
    );
    const source = renderSchema(model);

    expect(source).toContain('code: text.collate("C").primaryKey,');
    expect(source).toContain('label: varchar(20).collate("POSIX"),');
    // A key collation makes the key an expression; a plain `.index` has none.
    expect(source).toContain(
      'codeId: index(sql<string>`${uses.codeId} COLLATE "POSIX"`),',
    );
    expect(
      model.warnings.map((warning) => [warning.code, warning.column]),
    ).toEqual([["collation", "fallback_id"]]);
  });
});
