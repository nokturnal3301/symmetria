import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import {
  commentText,
  objectName,
} from "../../../packages/kit/src/migrations/snapshot";
import { renderSchema } from "../../../packages/kit/src/introspection/render";
import { interpolate } from "../../../packages/kit/src/introspection/constraints";
import {
  camelKey,
  escapeTemplate,
  MODULE_HELPERS,
  MODULE_IDENTIFIERS,
  quoteString,
  RESERVED_TABLE_KEYS,
  RUNTIME_IMPORTS,
  SEARCH_IMPORTS,
  VECTOR_IMPORTS,
} from "../../../packages/kit/src/introspection/names";
import { migrationSnapshot } from "../../../packages/kit/src";
import {
  int,
  schema,
  table as declaredTable,
} from "../../../packages/runtime/src";
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
  unique?: (
    | {
        name?: string;
        columns: string[];
        deferrable?: boolean;
        initiallyDeferred?: boolean;
        nullsNotDistinct?: boolean;
      }
    | string
  )[];
  foreignKeys?: {
    name?: string;
    column: string;
    table: string;
    reference?: string;
    onDelete?: string;
    onUpdate?: string;
    deferrable?: boolean;
    definition?: string;
  }[];
  checks?: { name: string; expression: string }[];
  indexes?: (Partial<IndexDetailRow> & { name: string; keys: string[] })[];
  partition?: boolean;
  partitioned?: boolean;
  /** Storage parameters, as pg_class.reloptions holds them. */
  storage?: string[];
};

/** A synthetic catalog in the shape readPullCatalog returns. */
const catalog = (
  tables: Table[],
  enumerations: { name: string; values: string[] }[] = [],
  undeclared: PullCatalog["undeclared"] = [],
  extra: Partial<Pick<PullCatalog, "sequences" | "otherSchemas">> = {},
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
        deferrable: entry.deferrable ?? false,
        initially_deferred: entry.initiallyDeferred ?? false,
        nulls_not_distinct: entry.nullsNotDistinct ?? false,
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
        ...(foreignKey.definition === undefined
          ? {}
          : { definition: foreignKey.definition }),
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
      ...(table.storage ? { reloptions: table.storage } : {}),
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
          generated: false,
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
          nulls_not_distinct: entry.nulls_not_distinct,
          method: "btree",
          keys: entry.columns,
          options: entry.columns.map(() => 0),
          included: [],
          opclasses: entry.columns.map(() => null),
          opclass_names: entry.columns.map(() => "default_ops"),
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
        opclass_names: (index.opclasses ?? index.keys.map(() => null)).map(
          (name) => name ?? "default_ops",
        ),
        collations: index.collations ?? index.keys.map(() => null),
        ...(index.opclass_options
          ? { opclass_options: index.opclass_options }
          : {}),
        reloptions: index.reloptions ?? null,
        predicate: index.predicate ?? null,
        definition: `CREATE INDEX ${index.name}`,
      })),
    ]),
    enumerations,
    extensions: [],
    // Every nextval() default reads as a serial column's own sequence.
    sequences:
      extra.sequences ??
      sorted.flatMap((table) =>
        table.columns.flatMap((column) => {
          const name = /^nextval\('(.*)'::regclass\)$/.exec(
            column.default ?? "",
          )?.[1];

          return name === undefined
            ? []
            : [
                {
                  name,
                  reference: name,
                  owner_table: table.name,
                  owner_column: column.name,
                  identity: false,
                  defaults: 1,
                },
              ];
        }),
      ),
    otherSchemas: extra.otherSchemas ?? [],
  };
};

const runtime = resolve("packages/runtime/src/index.ts");

/**
 * What the compiler says about rendered modules, under the repository's own
 * compiler options; empty when they type-check. The files are written below
 * `.build/`, inside the repository, where the compiler finds its type packages.
 */
const typeErrors = async (modules: Record<string, string>): Promise<string> => {
  const directory = resolve(`.build/pull-typecheck-${randomUUID()}`);
  await mkdir(directory, { recursive: true });

  try {
    for (const [name, source] of Object.entries(modules)) {
      await writeFile(join(directory, name), source);
    }

    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { noEmit: true },
        include: ["*.ts"],
        exclude: [],
      }),
    );
    const child = Bun.spawn(
      [resolve("node_modules/.bin/tsc"), "-p", directory],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [output, errors] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return `${output}${errors}`.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

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

/** PascalCase names, which every column declares with `.named()`, next to each default a builder has a shortcut for. */
const pascalCase = () =>
  catalog(
    [
      {
        name: "Customers",
        primaryKey: { name: "Customers_pkey", columns: ["Id"] },
        unique: [{ name: "Customers_Big_key", columns: ["Big"] }],
        columns: [
          { name: "Id", type: "integer", identity: "d" },
          { name: "Big", type: "bigint", identity: "a" },
          { name: "Small", type: "smallint", identity: "d" },
          {
            name: "CreatedAt",
            type: "timestamp with time zone",
            default: "now()",
          },
          {
            name: "SeenAt",
            type: "timestamp(3) without time zone",
            default: "now()",
            nullable: true,
          },
          { name: "Token", type: "uuid", default: "gen_random_uuid()" },
          {
            name: "Ordered",
            type: "uuid",
            default: "uuidv7()",
            nullable: true,
          },
          {
            name: "Status",
            type: "OrderStatus",
            enumeration: "OrderStatus",
            default: `'New'::"OrderStatus"`,
          },
          {
            name: "NickName",
            type: "character varying(40)",
            nullable: true,
            collation: "C",
          },
          { name: "Tags", type: "text[]", default: "'{}'::text[]" },
          { name: "Score", type: "integer", default: "0" },
        ],
      },
    ],
    [{ name: "OrderStatus", values: ["New", "Paid"] }],
  );

/** Divisions as PostgreSQL stores them, by the types of their operands. */
const DIVISIONS: Record<string, string> = {
  half: "((score / 2) = 3)",
  smallHalf: "((small / 2) > 10)",
  bigHalf: "((big / (2)::bigint) < (2)::bigint)",
  bigInteger: "((big / 2) < (2)::bigint)",
  pair: "((score / lower) >= 1)",
  mixed: "((big / score) > (1)::bigint)",
  nested: "(((score * 2) / 3) = 2)",
  price: "((price / (2)::numeric) > (1)::numeric)",
  share: "(((score)::numeric / price) > (1)::numeric)",
  weight: "((weight / (2)::double precision) > (0.5)::double precision)",
};

const divisions = () =>
  catalog([
    {
      name: "items",
      primaryKey: ["id"],
      columns: [
        { name: "id", type: "integer", identity: "a" },
        { name: "small", type: "smallint" },
        { name: "score", type: "integer" },
        { name: "lower", type: "integer" },
        { name: "big", type: "bigint" },
        { name: "price", type: "numeric(10,2)" },
        { name: "weight", type: "double precision" },
      ],
      checks: Object.entries(DIVISIONS).map(([key, expression]) => ({
        name: objectName(
          "items",
          key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          "check",
        ),
        expression,
      })),
      indexes: [{ name: "items_halves_idx", keys: ["(score / 2)"] }],
    },
  ]);

/** numeric(p,s) columns with a scale above the precision or below zero, which numeric() does not take. */
const oddNumerics = () =>
  catalog([
    {
      name: "rates",
      primaryKey: ["id"],
      columns: [
        { name: "id", type: "integer", identity: "a" },
        { name: "tiny", type: "numeric(3,5)", default: "0.00123" },
        { name: "rounded", type: "numeric(5,-2)", nullable: true },
        { name: "edge", type: "numeric(3,3)" },
        { name: "whole", type: "numeric(4,0)", nullable: true },
        { name: "tinies", type: "numeric(3,5)[]", nullable: true },
      ],
      checks: [
        { name: "rates_tiny_check", expression: "(tiny < 0.01)" },
        {
          name: "rates_twice_check",
          expression: "((tiny * (2)::numeric) < 0.5)",
        },
        {
          name: "rates_sum_check",
          expression: "((tiny + edge) > (0)::numeric)",
        },
        {
          name: "rates_edge_check",
          expression: "((edge * (2)::numeric) < (1)::numeric)",
        },
        // Compared with a numeric() column, on either side.
        { name: "rates_above_check", expression: "(edge > tiny)" },
        { name: "rates_below_check", expression: "(tiny < edge)" },
        {
          name: "rates_between_check",
          expression: "((edge >= tiny) AND (edge <= (1)::numeric))",
        },
        {
          name: "rates_in_check",
          expression: "(rounded = ANY (ARRAY[(100)::numeric, (200)::numeric]))",
        },
      ],
      indexes: [
        { name: "rates_double_idx", keys: ["(tiny * (2)::numeric)"] },
        { name: "rates_over_idx", keys: ["edge"], predicate: "(edge >= tiny)" },
      ],
    },
  ]);

/** Numbers at the edges of smallint, integer and bigint, in conditions as PostgreSQL stores them. */
const INTEGER_RANGES: Record<string, string> = {
  // PostgreSQL compares a smallint with any integer; the DSL would refuse 40000.
  over: "(s <= 40000)",
  top: "(s <= 32767)",
  bottom: "(s >= '-32768'::integer)",
  under: "(s >= '-32769'::integer)",
  sum: "((s + s2) <= 40000)",
  ratio: "((s / s2) <= 40000)",
  product: "((s * s2) < 100000)",
  ratioSmall: "((s / s2) <= 100)",
  listed: "(s = ANY (ARRAY[1, 40000]))",
  listedSmall: "(s = ANY (ARRAY[1, 2]))",
  range: "((s >= 1) AND (s <= 40000))",
  distinct: "(s IS DISTINCT FROM 40000)",
  reversed: "(40000 >= s)",
  // A literal or an integer column next to a smallint makes an integer.
  step: "((s + 1) <= 40000)",
  half: "((s / 2) <= 40000)",
  mixed: "((s + i) <= 40000)",
  shifted: "((s + 40000) > 0)",
  // The whole integer and bigint ranges are numbers the DSL takes.
  intTop: "(i <= 2147483647)",
  intBottom: "(i >= '-2147483648'::integer)",
  intSum: "((i + 2147483647) > 0)",
  intOver: "((i + j) < '3000000000'::bigint)",
  bigTop: "(b < '9223372036854775807'::bigint)",
  bigBottom: "(b >= '-9223372036854775808'::bigint)",
};

const integerRanges = () =>
  catalog([
    {
      name: "counts",
      primaryKey: ["id"],
      columns: [
        { name: "id", type: "integer", identity: "a" },
        { name: "s", type: "smallint" },
        { name: "s2", type: "smallint" },
        { name: "i", type: "integer" },
        { name: "j", type: "integer" },
        { name: "b", type: "bigint" },
      ],
      checks: Object.entries(INTEGER_RANGES).map(([key, expression]) => ({
        name: objectName(
          "counts",
          key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          "check",
        ),
        expression,
      })),
      indexes: [
        {
          name: "counts_wide_idx",
          keys: ["i"],
          predicate: "((s / s2) < 100000)",
        },
        {
          name: "counts_narrow_idx",
          keys: ["i"],
          predicate: "((s / s2) < 100)",
        },
      ],
    },
  ]);

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
    // Written a character at a time outside literals, `$` and `{` still
    // cannot meet as an interpolation.
    expect(interpolate("a ${b} 'c${d}'", new Map(), "t").template).toBe(
      "a \\${b} 'c\\${d}'",
    );
  });

  test("line breaks, control characters and direction marks are escaped in templates, strings and comments", () => {
    expect(escapeTemplate("a\rb\u2028c\u202ed\u0007e\nf\tg")).toBe(
      "a\\rb\\u2028c\\u202ed\\u0007e\nf\tg",
    );
    expect(quoteString("a\u2028b\u2029c\u202ed\ne")).toBe(
      '"a\\u2028b\\u2029c\\u202ed\\ne"',
    );
    expect(commentText("a\nb\rc\u2028d\u2029e\u001bf\u202eg\th")).toBe(
      "a\\nb\\rc\\u2028d\\u2029e\\u001bf\\u202eg\th",
    );
    // Ordinary text is written as it was.
    for (const text of ["users_email_key", 'a "quoted" name', "café"]) {
      expect(commentText(text)).toBe(text);
      expect(quoteString(text)).toBe(JSON.stringify(text));
      expect(escapeTemplate(text)).toBe(text);
    }
  });

  test("database names with line breaks stay inside the comments and strings of the module", () =>
    withMigrationDirectory(async (directory) => {
      // Each payload would run as code if it reached a line of its own.
      const payload = (n: number) => `x${n}:(globalThis.pulled${n}=1)&&text,//`;
      const model = buildPulledSchema(
        catalog([
          {
            name: "t1",
            primaryKey: ["id"],
            unique: [{ name: `odd\n${payload(1)}`, columns: ["code"] }],
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "code", type: "text" },
            ],
          },
          {
            name: "t2",
            primaryKey: ["id"],
            checks: [{ name: `chk\r${payload(2)}`, expression: "(n > 0)" }],
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "n", type: "integer" },
            ],
          },
          {
            name: "t3",
            primaryKey: ["id"],
            partitioned: true,
            columns: [{ name: "id", type: "integer", identity: "a" }],
          },
          {
            name: `p\u2028globalThis.pulled3=1;//`,
            partition: true,
            columns: [{ name: "id", type: "integer" }],
          },
          {
            name: `odd\u2029${payload(4)}`,
            primaryKey: ["id"],
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "note", type: "text", default: "'a\rb\u2028c'::text" },
              {
                name: "label",
                type: "text",
                default: "('x\r'::text || 'y\u2029'::text)",
              },
            ],
          },
          {
            name: "loose",
            columns: [
              { name: "id", type: "integer", nullable: true },
              { name: "label", type: "text", nullable: true },
            ],
          },
        ]),
      );
      const source = renderSchema(model, {
        module: runtime,
        header: [`from\n${payload(5)}`],
      });

      // Only the module's own line feeds break lines.
      expect(source).not.toMatch(/[\r\u2028\u2029]/);
      expect(source).toContain(
        `// pull: constraint "odd\\n${payload(1)}" is named "t1_code_key"`,
      );
      expect(source).toContain(
        '// pull: table "p\\u2028globalThis.pulled3=1;//" skipped',
      );

      const path = join(directory, "schema.ts");
      await writeFile(path, source);
      const loaded = await import(pathToFileURL(path).href);
      const ran = [1, 2, 3, 4, 5].filter(
        (n) => (globalThis as Record<string, unknown>)[`pulled${n}`],
      );

      expect(ran).toEqual([]);

      // The names and the texts of defaults are the database's, unchanged.
      const odd = migrationSnapshot(loaded.appSchema.$snapshot()).tables.find(
        (table) => table.name === `odd\u2029${payload(4)}`,
      )!;

      expect(
        odd.columns.map((column) => [column.name, column.default]),
      ).toEqual([
        ["id", undefined],
        ["note", "E'a\rb\u2028c'"],
        ["label", "('x\r'::text || 'y\u2029'::text)"],
      ]);
    }));

  test(
    "tables named after everything a module imports or declares, or after a key schema() reserves, load and type-check",
    () =>
      withMigrationDirectory(async (directory) => {
        // The SQL name whose key is the identifier: `as_number` for `asNumber`.
        const identifiers = MODULE_IDENTIFIERS.filter((name) =>
          /^[a-z]/.test(name),
        );
        const sqlNames = identifiers.map((name) =>
          name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        );
        expect(sqlNames.map((name) => camelKey(name))).toEqual(identifiers);

        // Every such table refers to itself, so its declaration is a callback
        // that binds the table next to the builders it uses, and carries a
        // check and an index, whose callbacks bind it again.
        const named = (name: string): Table => ({
          name,
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "label", type: "text" },
            { name: "score", type: "integer" },
            { name: "parent_id", type: "integer", nullable: true },
          ],
          foreignKeys: [
            {
              name: objectName(name, "parent_id", "fkey"),
              column: "parent_id",
              table: name,
              onDelete: "n",
            },
          ],
          checks: [
            {
              name: objectName(name, "label", "check"),
              expression:
                "((label !~~ 'x%'::text) AND ((score > 1) OR (score < 0)))",
            },
            {
              name: objectName(name, "length", "check"),
              expression: "(length(label) > 0)",
            },
          ],
          indexes: [
            {
              name: objectName(name, "pair", "idx"),
              keys: ["label", "score"],
              opclasses: ["text_pattern_ops", null],
            },
          ],
        });
        // One table that uses every builder and helper and refers to every
        // identifier-named table: all of them are bound in its callback.
        const referenced = sqlNames.filter(
          (name) => !["index", "named", "column"].includes(name),
        );
        const everything: Table = {
          name: "everything",
          primaryKey: ["id"],
          unique: ["one_id"],
          columns: [
            { name: "id", type: "bigint", identity: "d" },
            { name: "title", type: "text" },
            { name: "flag", type: "boolean" },
            { name: "blob", type: "bytea", nullable: true },
            { name: "day", type: "date", nullable: true },
            { name: "weight", type: "double precision", nullable: true },
            { name: "ratio", type: "real", nullable: true },
            { name: "ip", type: "inet", nullable: true },
            { name: "wait", type: "interval", nullable: true },
            { name: "settings", type: "jsonb", nullable: true },
            { name: "price", type: "numeric(10,2)", nullable: true },
            { name: "small", type: "smallint", nullable: true },
            { name: "at", type: "time without time zone", nullable: true },
            {
              name: "seen",
              type: "timestamp(3) without time zone",
              default: "now()",
            },
            {
              name: "made",
              type: "timestamp with time zone",
              default: "now()",
            },
            { name: "words", type: "tsvector", nullable: true },
            { name: "token", type: "uuid", default: "gen_random_uuid()" },
            { name: "ordered", type: "uuid", default: "uuidv7()" },
            { name: "nick", type: "character varying(20)", nullable: true },
            {
              name: "mood",
              type: "everything_mood_enum",
              enumeration: "everything_mood_enum",
            },
            { name: "cost", type: "money", nullable: true },
            { name: "ref", type: "oid", nullable: true },
            { name: "amount", type: "amount", nullable: true },
            { name: "near", type: "vector(3)", nullable: true },
            { name: "half", type: "halfvec(3)", nullable: true },
            {
              name: "about_words",
              type: "tsvector",
              nullable: true,
              generated: true,
              default: `setweight(to_tsvector('simple'::regconfig, COALESCE(title, ''::text)), 'A'::"char")`,
            },
            ...referenced.map((name) => ({
              name: `${name}_id`,
              type: "integer",
              nullable: name !== "one",
            })),
          ],
          foreignKeys: referenced.map((name) => ({
            name: objectName("everything", `${name}_id`, "fkey"),
            column: `${name}_id`,
            table: name,
          })),
          indexes: [
            {
              name: "everything_about_words_idx",
              keys: ["about_words"],
              method: "gin",
            },
          ],
        };
        const junctionOf = (
          name: string,
          [first, second]: [string, string],
          onDelete: string,
        ): Table => ({
          name,
          primaryKey: [`${first}_id`, `${second}_id`],
          columns: [
            { name: `${first}_id`, type: "integer" },
            { name: `${second}_id`, type: "integer" },
          ],
          foreignKeys: [first, second].map((target) => ({
            name: objectName(name, `${target}_id`, "fkey"),
            column: `${target}_id`,
            table: target,
            onDelete,
          })),
          indexes: [
            {
              name: objectName(name, `${second}_id`, "idx"),
              keys: [`${second}_id`],
            },
          ],
        });
        const model = buildPulledSchema({
          ...catalog(
            [
              ...sqlNames.map(named),
              ...[...RESERVED_TABLE_KEYS].map(named),
              everything,
              // link() where both keys cascade, junction() otherwise.
              junctionOf("pairs", ["link", "junction"], "c"),
              junctionOf("holds", ["table", "schema"], "a"),
            ],
            [{ name: "everything_mood_enum", values: ["happy", "sad"] }],
          ),
          domains: [{ name: "amount", base: "numeric(30,10)" }],
        });

        // Each identifier-named table is bound under another name ...
        expect(
          identifiers.map(
            (key) => model.tables.find((table) => table.key === key)?.binding,
          ),
        ).toEqual(identifiers.map((key) => `${key}Table`));
        // ... and no table takes a key the runtime refuses.
        expect(
          model.tables.filter((entry) => RESERVED_TABLE_KEYS.has(entry.key)),
        ).toEqual([]);

        // The list is the runtime's own: schema() refuses each of these
        // (`__proto__` it only names; no object literal holds that key).
        for (const key of [...RESERVED_TABLE_KEYS].filter(
          (name) => name !== "__proto__",
        )) {
          expect(() =>
            schema(
              Object.fromEntries([[key, declaredTable({ id: int })]]) as never,
            ),
          ).toThrow(`reserved table name "${key}"`);
        }
        expect(
          ["then", "constructor", "prototype"].map(
            (name) => model.tables.find((table) => table.sqlName === name)?.key,
          ),
        ).toEqual(["thenValue", "constructorValue", "prototypeValue"]);

        const source = renderSchema(model, {
          module: runtime,
          vectorModule: resolve("packages/runtime/src/entries/vector.ts"),
          searchModule: resolve("packages/runtime/src/entries/search.ts"),
        });
        // This module uses everything a module can import or declare, and
        // every name it imports or declares is one pull keeps bindings off.
        const imported = [
          ...source.matchAll(/^import \{([^}]*)\} from /gm),
        ].flatMap((match) =>
          match[1]!
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        );
        const declared = [...source.matchAll(/^const (\w+) = /gm)].map(
          (match) => match[1]!,
        );

        expect([...imported].sort()).toEqual(
          [...RUNTIME_IMPORTS, ...VECTOR_IMPORTS, ...SEARCH_IMPORTS].sort(),
        );
        expect(declared).toEqual([...MODULE_HELPERS]);
        expect(
          [...imported, ...declared]
            .map((name) => name.replace(/^type /, ""))
            .filter((name) => !MODULE_IDENTIFIERS.includes(name)),
        ).toEqual([]);

        const path = join(directory, "identifiers.ts");
        await writeFile(path, source);
        const loaded = await import(pathToFileURL(path).href);

        expect(
          migrationSnapshot(loaded.appSchema.$snapshot())
            .tables.map((table) => table.name)
            .sort(),
        ).toEqual(
          [
            ...sqlNames,
            ...RESERVED_TABLE_KEYS,
            "everything",
            "pairs",
            "holds",
          ].sort(),
        );
        expect(await typeErrors({ "identifiers.ts": source })).toBe("");
      }),
    30000,
  );
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
    // Both drivers deliver money as formatted text ("$12.50").
    expect(column(model, "users", "price").type).toEqual({
      kind: "custom",
      sqlType: "money",
      valueType: "string",
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
      'price: customType<string>("money", passthrough<string>()).nullable, // pull: no builder for money',
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
    // An array of enums is the element type's .array, whose codec reads it.
    expect(column(model, "events", "moods")).toMatchObject({
      type: { kind: "custom", sqlType: "mood", valueType: "string" },
      array: true,
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

  test("domain columns are declared over their base type; a domain without a builder stays driver-native", () =>
    withMigrationDirectory(async (directory) => {
      const model = buildPulledSchema({
        ...catalog([
          {
            name: "ledger",
            primaryKey: ["id"],
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "amount", type: "amount" },
              { name: "big", type: "big_id" },
              { name: "rate", type: "rate", default: "5" },
              { name: "at", type: "moment", nullable: true },
              { name: "amounts", type: "amount[]" },
              { name: "nested", type: "positive_amount" },
              { name: "label", type: "label", collation: "C" },
              { name: "price", type: "price" },
              { name: "payload", type: "payload" },
              { name: "ref", type: "ref" },
            ],
          },
        ]),
        domains: [
          { name: "amount", base: "numeric(30,10)" },
          { name: "big_id", base: "bigint" },
          { name: "rate", base: "integer" },
          { name: "moment", base: "timestamp with time zone" },
          { name: "positive_amount", base: "amount" },
          { name: "label", base: "text" },
          { name: "price", base: "money" },
          { name: "payload", base: "json" },
          { name: "ref", base: "oid" },
        ],
      });

      expect(column(model, "ledger", "nested").type).toEqual({
        kind: "custom",
        sqlType: "positive_amount",
        valueType: "Decimal",
        base: "numeric(30,10)",
      });
      expect(column(model, "ledger", "label").collation).toBe("C");

      const source = renderSchema(model, { module: runtime });
      for (const line of [
        'amount: customType<Decimal>("amount", { base: "numeric(30,10)" }), // pull: domain over numeric(30,10)',
        'big: customType<bigint>("big_id", { base: "bigint" }), // pull: domain over bigint',
        'rate: customType<number>("rate", { base: "integer" }).default(5), // pull: domain over integer',
        'at: customType<Date>("moment", { base: "timestamp with time zone" }).nullable, // pull: domain over timestamp with time zone',
        'amounts: customType<Decimal>("amount", { base: "numeric(30,10)" }).array, // pull: domain over numeric(30,10)',
        'label: customType<string>("label", { base: "text" }).collate("C"), // pull: domain over text',
        // No builder for the base: values stay as the driver delivers them.
        'price: customType<string>("price", passthrough<string>()), // pull: domain over money, no builder for it',
        // ... and like a plain column of the base type: json and oid.
        'payload: customType<unknown>("payload", passthrough<unknown>()), // pull: domain over json, no builder for it',
        'ref: customType<number>("ref", asNumber()), // pull: domain over oid, no builder for it',
      ]) {
        expect(source).toContain(line);
      }
      // Decimal, the numeric builder's value type, is imported as a type.
      expect(source).toMatch(
        /^import \{[^}]*customType,[^}]*type Decimal,?\s*\} from /m,
      );
      expect(model.warnings.map((warning) => warning.code)).toEqual(
        Array(10).fill("custom-type"),
      );

      const path = join(directory, "domains.ts");
      await writeFile(path, source);
      const loaded = await import(pathToFileURL(path).href);
      const ledger = migrationSnapshot(
        loaded.appSchema.$snapshot(),
      ).tables.find((table) => table.name === "ledger")!;

      // The declared SQL type is the domain: no DDL change.
      expect(
        Object.fromEntries(
          ledger.columns.map((entry) => [entry.name, entry.sqlType]),
        ),
      ).toMatchObject({
        amount: "amount",
        big: "big_id",
        amounts: "amount[]",
        nested: "positive_amount",
      });
    }));

  test("a column that needs .named() takes its builder's shortcut first: .auto, .now, .v4, .v7", () => {
    const source = renderSchema(buildPulledSchema(pascalCase()));

    // The shortcuts exist on the builders only: `int.named("Id").auto` does not type-check.
    for (const line of [
      'id: int.auto.byDefault.named("Id"),',
      'big: bigint.auto.named("Big").unique,',
      'small: smallint.auto.byDefault.named("Small"),',
      'createdAt: timestamptz.now.named("CreatedAt"),',
      'seenAt: timestamp(3).now.named("SeenAt").nullable,',
      'token: uuid.v4.named("Token"),',
      'ordered: uuid.v7.named("Ordered").nullable,',
      'status: oneOf("New", "Paid").typeName("OrderStatus").named("Status").default("New"),',
      'nickName: varchar(40).collate("C").named("NickName").nullable,',
      "tags: text.array.named(\"Tags\").default(sql`'{}'::text[]`),",
      'score: int.named("Score").default(0),',
    ]) {
      expect(source).toContain(`      ${line}\n`);
    }
  });

  test("a numeric whose scale is above its precision or below zero goes through customType() with numeric values", () => {
    const model = buildPulledSchema(oddNumerics());
    const source = renderSchema(model);

    // The values are numeric's, exact decimal text, so the column compares
    // and computes with numeric() columns and type-checks on either side.
    for (const name of ["tiny", "rounded", "tinies"]) {
      expect(column(model, "rates", name).type).toMatchObject({
        kind: "custom",
        valueType: "Decimal",
        base: "numeric",
      });
    }

    expect(column(model, "rates", "edge").type).toEqual({
      kind: "numeric",
      precision: 3,
      scale: 3,
    });
    expect(column(model, "rates", "whole").type).toEqual({
      kind: "numeric",
      precision: 4,
      scale: 0,
    });

    for (const line of [
      // numeric(3, 5) is refused by the builder: the module would not load.
      'tiny: customType<Decimal>("numeric(3,5)", { base: "numeric" }).default(sql`0.00123`), // pull: no builder for numeric(3,5)',
      'rounded: customType<Decimal>("numeric(5,-2)", { base: "numeric" }).nullable, // pull: no builder for numeric(5,-2)',
      'tinies: customType<Decimal>("numeric(3,5)", { base: "numeric" }).array.nullable, // pull: no builder for numeric(3,5)',
      "edge: numeric(3, 3),",
      'tiny: rates.tiny.below("0.01"),',
      'twice: rates.tiny.multiply("2").below("0.5"),',
      'sum: rates.tiny.plus(rates.edge).above("0"),',
      'edge: rates.edge.multiply("2").below("1"),',
      "above: rates.edge.above(rates.tiny),",
      "below: rates.tiny.below(rates.edge),",
      'between: rates.edge.between(rates.tiny, "1"),',
      'in: rates.rounded.in(["100", "200"]),',
      'double: index(rates.tiny.multiply("2")),',
      "over: index(rates.edge).where(rates.edge.atLeast(rates.tiny)),",
    ]) {
      expect(source).toContain(line);
    }

    expect(source).toMatch(/^import \{[^}]*type Decimal,?\s*\} from /m);
    expect(source).not.toContain("passthrough");
    expect(
      model.warnings.map((warning) => [warning.code, warning.message]),
    ).toEqual([
      [
        "custom-type",
        '"rates.tiny" uses numeric(3,5), whose scale numeric() does not take; it is declared through customType() with the values of numeric, exact decimal text',
      ],
      [
        "custom-type",
        '"rates.rounded" uses numeric(5,-2), whose scale numeric() does not take; it is declared through customType() with the values of numeric, exact decimal text',
      ],
      [
        "custom-type",
        '"rates.tinies" uses numeric(3,5), whose scale numeric() does not take; it is declared through customType() with the values of numeric, exact decimal text',
      ],
    ]);
  });

  test("a text default written as a bpchar or varchar(n) literal is declared with the value PostgreSQL stores", () => {
    const defaults: Record<string, [type: string, stored: string]> = {
      // A bpchar value loses its trailing spaces when it becomes text.
      padded: ["text", "'ab '::bpchar"],
      blank: ["text", "'  '::bpchar"],
      quoted: ["text", "'it''s  '::bpchar"],
      tabbed: ["text", "'ab\t '::bpchar"],
      short: ["character varying(10)", "'ab '::bpchar"],
      // A cast to varchar(n) keeps n characters.
      cut: ["text", "'abcdef'::character varying(3)"],
      cut_wide: ["text", "'a\u{1f600}bc'::character varying(2)"],
      limited: ["character varying(5)", "'abcdefgh'::character varying(5)"],
      // Text and varchar keep their spaces.
      kept: ["text", "'ab '::character varying(10)"],
      plain: ["text", "'ab '::text"],
      // A char(n) column's own default stays as PostgreSQL prints it.
      fixed: ["character(5)", "'ab'::bpchar"],
      fixed_text: ["text", "'ab '::character(5)"],
    };
    const model = buildPulledSchema(
      catalog([
        {
          name: "codes",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            ...Object.entries(defaults).map(([name, [type, stored]]) => ({
              name,
              type,
              default: stored,
            })),
          ],
        },
      ]),
    );

    expect(
      Object.fromEntries(
        Object.keys(defaults).map((name) => {
          const value = column(model, "codes", name).default;

          return [
            name,
            value?.kind === "value"
              ? value.source
              : value?.kind === "sql"
                ? `sql: ${value.sql}`
                : undefined,
          ];
        }),
      ),
    ).toEqual({
      padded: '"ab"',
      blank: '""',
      quoted: '"it\'s"',
      tabbed: '"ab\\t"',
      short: '"ab"',
      cut: '"abc"',
      cut_wide: '"a\u{1f600}"',
      limited: '"abcde"',
      kept: '"ab "',
      plain: '"ab "',
      fixed: "sql: 'ab'::bpchar",
      fixed_text: "sql: 'ab '::character(5)",
    });
  });

  test("a number default written as a literal of another type is a value only where that type keeps the number", () => {
    const defaults: Record<string, [type: string, stored: string]> = {
      // A real literal is the nearest real number: 0.10000000149011612.
      widened: ["double precision", "'0.1'::real"],
      widened_negative: ["double precision", "'-0.1'::real"],
      // 0.5 and -3 are the same number in both precisions.
      half: ["double precision", "'0.5'::real"],
      whole: ["double precision", "'-3'::integer"],
      narrowed: ["real", "'0.1'::double precision"],
      // A cast to numeric(10,2) rounds to two decimals: 1.01.
      rounded: ["numeric", "'-1.005'::numeric(10,2)"],
      truncated: ["numeric", "'-1.5'::numeric(10)"],
      exact: ["numeric", "'-1.50'::numeric(10,2)"],
      plain: ["numeric", "'-1.005'::numeric"],
      // ... and fills up to them: a fresh row holds 7.00 and -3.000.
      filled: ["numeric", "'7'::numeric(10,2)"],
      filled_negative: ["numeric", "'-3'::numeric(8,3)"],
      filled_zero: ["numeric", "'0'::numeric(2,2)"],
      integral: ["numeric", "'12'::numeric(4,0)"],
      // 12345 has more digits than numeric(4,2) holds: PostgreSQL fails.
      overflow: ["numeric", "'12345'::numeric(4,2)"],
      // The column's own scale rounds a value as it rounds the literal.
      scaled: ["numeric(10,2)", "1.005"],
    };
    const model = buildPulledSchema(
      catalog([
        {
          name: "rates",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            ...Object.entries(defaults).map(([name, [type, stored]]) => ({
              name,
              type,
              default: stored,
            })),
          ],
        },
      ]),
    );

    expect(
      Object.fromEntries(
        Object.keys(defaults).map((name) => {
          const value = column(model, "rates", name).default;

          return [
            name,
            value?.kind === "value"
              ? value.source
              : value?.kind === "sql"
                ? `sql: ${value.sql}`
                : undefined,
          ];
        }),
      ),
    ).toEqual({
      widened: "sql: '0.1'::real",
      widened_negative: "sql: '-0.1'::real",
      half: "0.5",
      whole: "-3",
      narrowed: "0.1",
      rounded: "sql: '-1.005'::numeric(10,2)",
      truncated: "sql: '-1.5'::numeric(10)",
      exact: '"-1.50"',
      plain: '"-1.005"',
      filled: '"7.00"',
      filled_negative: '"-3.000"',
      filled_zero: '"0.00"',
      integral: '"12"',
      overflow: "sql: '12345'::numeric(4,2)",
      scaled: '"1.005"',
    });
  });
});

describe("pull: what the schema cannot declare", () => {
  test("inheritance, row-level security, routines, loose sequences and other schemas are listed", () => {
    const model = buildPulledSchema(
      catalog(
        [
          {
            name: "people",
            primaryKey: ["id"],
            columns: [{ name: "id", type: "integer", identity: "a" }],
          },
          {
            name: "staff",
            primaryKey: ["id"],
            columns: [{ name: "id", type: "integer", identity: "a" }],
          },
          {
            name: "notes",
            primaryKey: ["id"],
            columns: [{ name: "id", type: "integer", identity: "a" }],
          },
        ],
        [],
        [
          {
            kind: "inheritance",
            name: "staff",
            table_name: "staff",
            definition: "people",
          },
          {
            kind: "row security",
            name: "notes",
            table_name: "notes",
            definition: "enabled\nnotes_owner\nnotes_read",
          },
          {
            kind: "row security",
            name: "people",
            table_name: "people",
            definition: "enabled",
          },
          {
            kind: "row security",
            name: "staff",
            table_name: "staff",
            definition: "disabled\nstaff_all",
          },
          ...Array.from({ length: 12 }, (_, position) => ({
            kind: "function" as const,
            name: `fn_${String(position + 1).padStart(2, "0")}`,
            table_name: null,
            definition: "function",
          })),
          // Overloads share a name and are listed once.
          {
            kind: "function",
            name: "fn_01",
            table_name: null,
            definition: "procedure",
          },
        ],
        {
          sequences: [
            {
              name: "invoice_numbers",
              reference: "invoice_numbers",
              owner_table: null,
              owner_column: null,
              identity: false,
              defaults: 0,
            },
            {
              name: "people_id_seq",
              reference: "people_id_seq",
              owner_table: "people",
              owner_column: "id",
              identity: true,
              defaults: 0,
            },
          ],
          otherSchemas: [
            { schema: "audit", tables: 2 },
            { schema: "billing", tables: 1 },
          ],
        },
      ),
    );

    expect(
      model.warnings.map((warning) => [
        warning.code,
        warning.table ?? "",
        warning.message,
      ]),
    ).toEqual([
      [
        "inheritance",
        "staff",
        '"staff" inherits from "people"; the schema has no inheritance, so both are declared as separate plain tables: a database built from this schema does not show the rows of "staff" in "people"',
      ],
      [
        "row-security",
        "notes",
        '"notes" has row-level security enabled with policies "notes_owner", "notes_read"; the schema declares neither, so a database built from this schema leaves every row of the table visible and writable',
      ],
      [
        "row-security",
        "people",
        '"people" has row-level security enabled without policies; the schema declares neither, so a database built from this schema leaves every row of the table visible and writable',
      ],
      [
        "row-security",
        "staff",
        '"staff" has policy "staff_all" but row-level security is not enabled; the schema does not declare policies and migrations neither create nor drop them',
      ],
      [
        "function",
        "",
        '12 functions and procedures "fn_01", "fn_02", "fn_03", "fn_04", "fn_05", "fn_06", "fn_07", "fn_08", "fn_09", "fn_10" and 2 more are not declared; the schema does not manage routines, so migrations neither create nor drop them and a database built from this schema lacks them',
      ],
      [
        "sequence",
        "",
        'sequence "invoice_numbers" is not owned by a column and not declared; migrations neither create nor drop it and a database built from this schema lacks it',
      ],
      [
        "other-schema",
        "",
        '3 tables in other schemas were not read: "audit" (2), "billing" (1); pull reads one schema, here "public"',
      ],
    ]);
    // Both tables of an inheritance pair are still declared.
    expect(model.tables.map((table) => table.sqlName)).toEqual([
      "notes",
      "people",
      "staff",
    ]);
  });

  test("a sequence shared between columns keeps its default and gets no identity fix", () => {
    const sequenced = (name: string) => ({
      name,
      primaryKey: ["id"],
      columns: [
        {
          name: "id",
          type: "integer",
          default: "nextval('document_ids'::regclass)",
        },
      ],
    });
    const warnings = (sequences: PullCatalog["sequences"]) => {
      const model = buildPulledSchema(
        catalog([sequenced("invoices"), sequenced("receipts")], [], [], {
          sequences,
        }),
      );

      expect(column(model, "invoices", "id").default).toEqual({
        kind: "sql",
        sql: "nextval('document_ids'::regclass)",
      });

      return model.warnings.map((warning) => [
        warning.code,
        warning.table ?? "",
        warning.fix === undefined ? warning.message : "fix",
      ]);
    };
    const shared = {
      name: "document_ids",
      reference: "document_ids",
      identity: false,
      defaults: 2,
    };

    // Created on its own and used by two tables.
    expect(
      warnings([{ ...shared, owner_table: null, owner_column: null }]),
    ).toEqual([
      [
        "sequence",
        "",
        'sequence "document_ids" is not owned by a column and not declared; migrations neither create nor drop it and a database built from this schema lacks it',
      ],
      [
        "sequence",
        "invoices",
        '"invoices.id" takes its default from sequence document_ids, which is not owned by the column; the schema keeps the nextval() default but migrations from this schema will not create the sequence, and no identity fix is offered because it would drop a sequence something else may use',
      ],
      [
        "sequence",
        "receipts",
        '"receipts.id" takes its default from sequence document_ids, which is not owned by the column; the schema keeps the nextval() default but migrations from this schema will not create the sequence, and no identity fix is offered because it would drop a sequence something else may use',
      ],
    ]);

    // A serial column whose sequence a second table borrowed.
    expect(
      warnings([{ ...shared, owner_table: "invoices", owner_column: "id" }]),
    ).toEqual([
      [
        "sequence",
        "invoices",
        '"invoices.id" takes its default from sequence document_ids, which is also the default of 1 other column; the schema keeps the nextval() default but migrations from this schema will not create the sequence, and no identity fix is offered because it would drop a sequence something else may use',
      ],
      [
        "sequence",
        "receipts",
        '"receipts.id" takes its default from sequence document_ids, which is not owned by the column; the schema keeps the nextval() default but migrations from this schema will not create the sequence, and no identity fix is offered because it would drop a sequence something else may use',
      ],
    ]);

    // Owned by its column alone: the ordinary serial, with the fix.
    expect(
      warnings([
        { ...shared, defaults: 1, owner_table: "invoices", owner_column: "id" },
      ]),
    ).toEqual([
      ["serial", "invoices", "fix"],
      expect.arrayContaining(["sequence", "receipts"]),
    ]);
  });

  test("rules, foreign tables, storage parameters, operator class parameters and a deferrable multi-column UNIQUE are listed", () => {
    const pair = (
      name: string,
      unique: NonNullable<Table["unique"]>[number],
    ): Table => ({
      name,
      primaryKey: ["id"],
      unique: [unique],
      columns: [
        { name: "id", type: "integer", identity: "a" },
        { name: "a", type: "integer" },
        { name: "b", type: "integer" },
      ],
    });
    const model = buildPulledSchema(
      catalog(
        [
          {
            name: "docs",
            primaryKey: ["id"],
            storage: ["fillfactor=70", "toast.autovacuum_enabled=false"],
            columns: [
              { name: "id", type: "integer", identity: "a" },
              { name: "title", type: "text" },
              { name: "body", type: "tsvector", nullable: true },
            ],
            indexes: [
              {
                name: "docs_body_idx",
                keys: ["body"],
                method: "gist",
                opclass_options: ["siglen=500"],
              },
              {
                name: "docs_title_trgm",
                keys: ["title"],
                method: "gist",
                opclasses: ["gist_trgm_ops"],
                opclass_options: ["siglen=64"],
              },
            ],
          },
          pair("held", {
            columns: ["a", "b"],
            deferrable: true,
            initiallyDeferred: true,
          }),
          pair("late", { columns: ["a", "b"], deferrable: true }),
          pair("nulls", { columns: ["a", "b"], nullsNotDistinct: true }),
          pair("plain", { columns: ["a", "b"] }),
        ],
        [],
        [
          {
            kind: "foreign table",
            name: "remote_docs",
            table_name: null,
            definition: "files",
          },
          {
            kind: "rule",
            name: "docs_keep",
            table_name: "docs",
            definition:
              "CREATE RULE docs_keep AS\n    ON DELETE TO docs DO INSTEAD NOTHING;",
          },
        ],
      ),
    );

    expect(
      model.warnings.map((warning) => [
        warning.code,
        warning.object ?? warning.table ?? "",
        warning.message,
        ...(warning.fix === undefined ? [] : [warning.fix]),
      ]),
    ).toEqual([
      [
        "foreign-table",
        "remote_docs",
        'foreign table "remote_docs" of server "files" is not declared; queries cannot reach it through the schema and migrations neither create nor drop it',
      ],
      [
        "rule",
        "docs_keep",
        'rule "docs_keep" on "docs" is not declared; the schema does not manage rules, so migrations neither create nor drop it and a database built from this schema lacks it (CREATE RULE docs_keep AS ON DELETE TO docs DO INSTEAD NOTHING;)',
      ],
      [
        "storage-parameters",
        "docs",
        '"docs" has storage parameters the schema cannot declare (fillfactor=70, toast.autovacuum_enabled=false); a database built from this schema creates the table with the defaults',
      ],
      [
        "index",
        "docs_body_idx",
        'index "docs_body_idx" is declared without its operator class parameters, which the schema cannot declare: body (siglen=500); a database built from this schema creates the index with the operator class\'s defaults (CREATE INDEX docs_body_idx)',
      ],
      [
        "index",
        "docs_title_trgm",
        'index "docs_title_trgm" is declared without its operator class parameters, which the schema cannot declare: title (siglen=64); a database built from this schema creates the index with the operator class\'s defaults (CREATE INDEX docs_title_trgm)',
      ],
      // No fix for these three: a plain unique index in the constraint's
      // place would make the database check at once, or let NULLs repeat.
      [
        "unique-constraint",
        "held_a_b_key",
        'multi-column unique constraint "held_a_b_key" (a, b) is DEFERRABLE INITIALLY DEFERRED, which the schema cannot declare. It is declared as a unique index of the same name, and an index refuses a duplicate at once, where this constraint waits for the end of the transaction: a database built from this schema fails writes that hold a duplicate only for a moment, such as two rows swapping their values. The constraint itself stays undeclared',
      ],
      [
        "unique-constraint",
        "late_a_b_key",
        'multi-column unique constraint "late_a_b_key" (a, b) is DEFERRABLE, which the schema cannot declare. It is declared as a unique index of the same name, and an index refuses a duplicate at once, where this constraint waits for the end of the statement (or of the transaction, after SET CONSTRAINTS): a database built from this schema fails writes that hold a duplicate only for a moment, such as two rows swapping their values. The constraint itself stays undeclared',
      ],
      [
        "unique-constraint",
        "nulls_a_b_key",
        'multi-column unique constraint "nulls_a_b_key" (a, b) is NULLS NOT DISTINCT, which the schema cannot declare; the constraint stays undeclared, and a database built from this schema lacks it',
      ],
      [
        "index",
        "nulls_a_b_key",
        'index "nulls_a_b_key" is not declared: NULLS NOT DISTINCT is not supported (nulls_a_b_key)',
      ],
      [
        "unique-constraint",
        "plain_a_b_key",
        'multi-column unique constraint "plain_a_b_key" (a, b) is declared as a unique index of the same name; the constraint itself stays undeclared',
        'ALTER TABLE "plain" DROP CONSTRAINT "plain_a_b_key"; CREATE UNIQUE INDEX "plain_a_b_key" ON "plain" ("a", "b");',
      ],
    ]);
    expect(model.skippedTables).toEqual([
      {
        sqlName: "remote_docs",
        reason:
          'a foreign table of server "files"; the schema declares ordinary tables',
      },
    ]);

    const source = renderSchema(model);

    for (const line of [
      '// pull: table "remote_docs" skipped: a foreign table of server "files"; the schema declares ordinary tables',
      '    // pull: rule "docs_keep" is not declared',
      "    // pull: storage parameters are not declared: fillfactor=70, toast.autovacuum_enabled=false",
      'body: index(docs.body).using("gist"), // pull: operator class parameters are not declared: body (siglen=500)',
      'docs_title_trgm: index(operatorClass(docs.title, "gist_trgm_ops")).using("gist"), // pull: operator class parameters are not declared: title (siglen=64); name kept exactly',
      "held_a_b_key: index(held.a, held.b).unique, // pull: the constraint is DEFERRABLE INITIALLY DEFERRED; the index checks at once; name kept exactly",
      "late_a_b_key: index(late.a, late.b).unique, // pull: the constraint is DEFERRABLE; the index checks at once; name kept exactly",
      "plain_a_b_key: index(plain.a, plain.b).unique, // pull: name kept exactly",
    ]) {
      expect(source).toContain(line);
    }

    expect(source).not.toContain("nulls_a_b_key:");
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
      'editor: one(users.inverse("loginsByEditor")).noIndex.onDelete.noAction.onUpdate.cascade,',
    );
    expect(renderSchema(model)).toContain(
      'owner: one(users.column("owner")).noIndex.onDelete.noAction,',
    );
    expect(renderSchema(model)).toContain(
      'email: one(users.by("email").column("email").inverse("loginsByEmail")).noIndex.onDelete.noAction,',
    );
    // The referenced table names the other side of each key.
    expect(renderSchema(model)).toContain(
      "    logins: many,\n    loginsByEmail: many,\n    loginsByEditor: many,\n",
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
    expect(source).toContain("author: one(user).onUpdate.cascade,");
    expect(source).toContain("post: many,");
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

  test("a division is quotient() between integers and divide() where PostgreSQL divides exactly", () => {
    const model = buildPulledSchema(divisions());
    const items = model.tables.find((table) => table.sqlName === "items")!;

    expect(
      Object.fromEntries(
        items.checks.map((check) => [
          check.key,
          check.condition.kind === "predicate"
            ? check.condition.source
            : `sql: ${check.condition.template}`,
        ]),
      ),
    ).toEqual({
      // 7 / 2 is 3 between integers; divide() would make it 3.5.
      half: "items.score.quotient(2).is(3)",
      smallHalf: "items.small.quotient(2).above(10)",
      bigHalf: "items.big.quotient(2n).below(2n)",
      // A bigint over an integer literal is another operator than quotient(2n).
      bigInteger: "sql: ((${items.big} / 2) < (2)::bigint)",
      pair: "items.score.quotient(items.lower).atLeast(1)",
      mixed: "items.big.quotient(items.score).above(1n)",
      nested: "items.score.multiply(2).quotient(3).is(2)",
      // numeric and double precision divide exactly, as divide() does.
      price: 'items.price.divide("2").above("1")',
      share: 'items.score.divide(items.price).above("1")',
      weight: "items.weight.divide(2).above(0.5)",
    });
    expect(renderSchema(model)).toContain(
      "halves: index(items.score.quotient(2)),",
    );
  });

  test("a number the DSL refuses for a smallint value keeps the condition as SQL, and the module loads", () =>
    withMigrationDirectory(async (directory) => {
      const model = buildPulledSchema(integerRanges());
      const counts = model.tables.find((table) => table.sqlName === "counts")!;

      expect(
        Object.fromEntries(
          counts.checks.map((check) => [
            check.key,
            check.condition.kind === "predicate"
              ? check.condition.source
              : `sql: ${check.condition.template}`,
          ]),
        ),
      ).toEqual({
        over: "sql: (${counts.s} <= 40000)",
        top: "counts.s.atMost(32767)",
        bottom: "counts.s.atLeast(-32768)",
        under: "sql: (${counts.s} >= '-32769'::integer)",
        // Two smallints make a smallint, whatever the operator.
        sum: "sql: ((${counts.s} + ${counts.s2}) <= 40000)",
        ratio: "sql: ((${counts.s} / ${counts.s2}) <= 40000)",
        product: "sql: ((${counts.s} * ${counts.s2}) < 100000)",
        ratioSmall: "counts.s.quotient(counts.s2).atMost(100)",
        listed: "sql: (${counts.s} = ANY (ARRAY[1, 40000]))",
        listedSmall: "counts.s.in([1, 2])",
        range: "sql: ((${counts.s} >= 1) AND (${counts.s} <= 40000))",
        distinct: "sql: (${counts.s} IS DISTINCT FROM 40000)",
        reversed: "sql: (40000 >= ${counts.s})",
        step: "counts.s.plus(1).atMost(40000)",
        half: "counts.s.quotient(2).atMost(40000)",
        mixed: "counts.s.plus(counts.i).atMost(40000)",
        shifted: "counts.s.plus(40000).above(0)",
        intTop: "counts.i.atMost(2147483647)",
        intBottom: "counts.i.atLeast(-2147483648)",
        intSum: "counts.i.plus(2147483647).above(0)",
        intOver: "sql: ((${counts.i} + ${counts.j}) < '3000000000'::bigint)",
        bigTop: "counts.b.below(9223372036854775807n)",
        bigBottom: "counts.b.atLeast(-9223372036854775808n)",
      });

      const source = renderSchema(model, { module: runtime });

      expect(source).toContain(
        "wide: index(counts.i).where(sql<boolean>`((${counts.s} / ${counts.s2}) < 100000)`),",
      );
      expect(source).toContain(
        "narrow: index(counts.i).where(counts.s.quotient(counts.s2).below(100)),",
      );

      // schema() checks every number against its column when the module loads.
      const path = join(directory, "ranges.ts");
      await writeFile(path, source);
      const loaded = await import(pathToFileURL(path).href);

      expect(
        migrationSnapshot(loaded.appSchema.$snapshot()).tables[0]!.checks,
      ).toHaveLength(Object.keys(INTEGER_RANGES).length);
    }));

  test("two foreign keys on one column: one is declared and every other one is listed", () => {
    const model = buildPulledSchema(
      catalog([
        {
          name: "accounts",
          primaryKey: ["id"],
          columns: [{ name: "id", type: "integer", identity: "a" }],
        },
        {
          name: "people",
          primaryKey: ["id"],
          columns: [{ name: "id", type: "integer", identity: "a" }],
        },
        {
          name: "memberships",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "owner_id", type: "integer" },
          ],
          foreignKeys: [
            {
              name: "memberships_account_fk",
              column: "owner_id",
              table: "accounts",
              onDelete: "c",
              definition:
                "FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE",
            },
            {
              name: "memberships_person_fk",
              column: "owner_id",
              table: "people",
              definition: "FOREIGN KEY (owner_id) REFERENCES people(id)",
            },
          ],
        },
        {
          name: "notes",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "integer", identity: "a" },
            { name: "account_id", type: "integer", nullable: true },
          ],
          foreignKeys: [
            {
              name: "fk_notes_account",
              column: "account_id",
              table: "accounts",
              definition: "FOREIGN KEY (account_id) REFERENCES accounts(id)",
            },
            {
              name: "notes_account_id_fkey",
              column: "account_id",
              table: "accounts",
              onDelete: "c",
            },
            {
              name: "notes_account_late_fkey",
              column: "account_id",
              table: "accounts",
              deferrable: true,
            },
          ],
        },
      ]),
    );

    // Neither key of memberships.owner_id has the schema's name: the first by name is declared.
    expect(reference(model, "memberships", "owner_id")).toMatchObject({
      target: "accounts",
      onDelete: "cascade",
      comments: [
        'foreign key "memberships_person_fk" is not declared: FOREIGN KEY (owner_id) REFERENCES people(id)',
        'constraint "memberships_account_fk" is named "memberships_owner_id_fkey"',
      ],
    });
    // The key named as the schema names it is declared, wherever it sorts.
    expect(reference(model, "notes", "account_id")).toMatchObject({
      target: "accounts",
      onDelete: "cascade",
      comments: [
        'foreign key "fk_notes_account" is not declared: FOREIGN KEY (account_id) REFERENCES accounts(id)',
      ],
    });
    expect(
      model.warnings.map((warning) => [
        warning.code,
        warning.object ?? "",
        warning.message,
      ]),
    ).toEqual([
      [
        "foreign-key",
        "memberships_person_fk",
        'foreign key "memberships_person_fk" is not declared: "memberships.owner_id" has more than one foreign key and the schema declares one per column, here "memberships_account_fk" (the first by name); migrations neither create nor drop "memberships_person_fk", and a database built from this schema lacks it (FOREIGN KEY (owner_id) REFERENCES people(id))',
      ],
      [
        "foreign-key",
        "notes_account_late_fkey",
        'foreign key "notes_account_late_fkey" is kept as a plain column: deferrable constraints are not supported',
      ],
      [
        "foreign-key",
        "fk_notes_account",
        'foreign key "fk_notes_account" is not declared: "notes.account_id" has more than one foreign key and the schema declares one per column, here "notes_account_id_fkey" (the one with the name the schema gives the key); migrations neither create nor drop "fk_notes_account", and a database built from this schema lacks it (FOREIGN KEY (account_id) REFERENCES accounts(id))',
      ],
      [
        "constraint-name",
        "memberships_account_fk",
        'foreign key "memberships_account_fk" will be expected as "memberships_owner_id_fkey"',
      ],
    ]);
    expect(renderSchema(model)).toContain(
      'owner: one(accounts).noIndex.cascade, // pull: foreign key "memberships_person_fk" is not declared: FOREIGN KEY (owner_id) REFERENCES people(id); constraint "memberships_account_fk" is named "memberships_owner_id_fkey"',
    );
  });

  test("rendered modules type-check: shortcuts next to .named(), divisions, numerics outside the builder's range", async () => {
    const render = (source: PullCatalog) =>
      renderSchema(buildPulledSchema(source), { module: runtime });

    expect(
      await typeErrors({
        "named.ts": render(pascalCase()),
        "divisions.ts": render(divisions()),
        "numerics.ts": render(oddNumerics()),
        "ranges.ts": render(integerRanges()),
      }),
    ).toBe("");
  }, 30000);

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
