import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  and,
  bigint,
  bool,
  createDatabase,
  customType,
  date,
  doublePrecision,
  not,
  oneOf,
  or,
  real,
  schema,
  smallint,
  table,
  index,
  int,
  interval,
  many,
  numeric,
  one,
  sql,
  text,
  timestamp,
  timestamptz,
  uuid,
  varchar,
  time,
  inet,
  type Decimal,
} from "../../../packages/runtime/src";
import { fullText } from "../../../packages/runtime/src/entries/search";
import {
  normalizeResult,
  objectName,
} from "../../../packages/runtime/src/entries/internal";
import { postgres, type Driver } from "../../support/postgres";
import {
  createSchemaSQL,
  detectDrift,
  diffSchemas,
  generateMigration,
  loadMigrationState,
  migrator,
  pullSchema as pullWholeDatabase,
  type PullWarning,
} from "../../../packages/kit/src";
import { migrationDirectory } from "../../support/directories";

/**
 * The test database is shared: the schemas of other suites come and go, so the
 * `other-schema` entry is left out here and checked in a test of its own. A
 * server image may also ship extensions in schemas of their own (ParadeDB
 * does), which `pull` rightly mentions and no suite here is about.
 */
const ownSchema = <Warning extends Pick<PullWarning, "code">>(
  warnings: readonly Warning[],
): Warning[] =>
  warnings.filter(
    (warning) =>
      warning.code !== "other-schema" && warning.code !== "extension",
  );

const pullSchema = async (options: Parameters<typeof pullWholeDatabase>[0]) => {
  const result = await pullWholeDatabase(options);

  return { ...result, warnings: ownSchema(result.warnings) };
};

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
const runtime = resolve("packages/runtime/src/index.ts");

const sandbox = async (
  callback: (context: {
    driver: Driver;
    directory: string;
    namespace: string;
    address: string;
    run: (sql: string) => Promise<unknown>;
  }) => Promise<void>,
) => {
  const namespace = `pull_${randomUUID().replaceAll("-", "")}`;
  const directory = await migrationDirectory();
  const address = new URL(url!);
  address.searchParams.set("options", `-c search_path=${namespace}`);
  const driver = postgres({ url: address.toString(), max: 2 });
  const run = (statement: string) =>
    driver.execute({ sql: statement, parameters: [] });

  try {
    await run(`CREATE SCHEMA "${namespace}"`);
    await callback({
      driver,
      directory,
      namespace,
      address: address.toString(),
      run,
    });
  } finally {
    await run(`DROP SCHEMA "${namespace}" CASCADE`);
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
};

/**
 * What the compiler says about pulled modules, under the repository's own
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

/**
 * Builds a schema's tables in a schema of their own, `<namespace>_copy`, and
 * hands over a runner whose statements see that schema only.
 */
const rebuilt = async (
  namespace: string,
  model: { $snapshot: () => Parameters<typeof createSchemaSQL>[0] },
  callback: (run: (sql: string) => Promise<unknown>) => Promise<void>,
) => {
  const copy = `${namespace}_copy`;
  const address = new URL(url!);
  address.searchParams.set("options", `-c search_path=${copy}`);
  const driver = postgres({ url: address.toString(), max: 1 });
  const run = (statement: string) =>
    driver.execute({ sql: statement, parameters: [] });

  try {
    await run(`CREATE SCHEMA "${copy}"`);

    for (const statement of createSchemaSQL(model.$snapshot())) {
      await run(statement.sql);
    }

    await callback(run);
  } finally {
    await run(`DROP SCHEMA IF EXISTS "${copy}" CASCADE`);
    await driver.close();
  }
};

/** Whether a statement runs, or the constraint that refuses it. */
const outcome = async (
  run: (sql: string) => Promise<unknown>,
  statement: string,
): Promise<string> => {
  try {
    await run(statement);

    return "accepted";
  } catch (error) {
    return (
      /violates check constraint/.exec(String((error as Error).message))?.[0] ??
      String((error as Error).message)
    );
  }
};

const LEGACY = [
  `CREATE TYPE users_role_enum AS ENUM ('admin', 'member')`,
  `CREATE TYPE mood AS ENUM ('happy', 'sad')`,
  `CREATE TABLE users (
    id serial PRIMARY KEY,
    email text NOT NULL UNIQUE,
    role users_role_enum NOT NULL DEFAULT 'member',
    mood mood,
    other_mood mood,
    last_ip inet,
    born date,
    score smallint NOT NULL DEFAULT 0,
    tags text[] NOT NULL DEFAULT '{}'::text[],
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    balance numeric(12,2) NOT NULL DEFAULT 0.00,
    nick varchar(40),
    created_at timestamptz NOT NULL DEFAULT now(),
    token uuid NOT NULL DEFAULT gen_random_uuid(),
    big bigint GENERATED BY DEFAULT AS IDENTITY,
    active boolean NOT NULL DEFAULT true,
    "CamelCol" text,
    code text COLLATE "C",
    CONSTRAINT users_score_check CHECK ((score > -100) = true)
  )`,
  `CREATE INDEX users_settings_idx ON users USING gin (settings)`,
  `CREATE INDEX users_email_c_idx ON users (email COLLATE "C")`,
  `CREATE TABLE events (
    id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL,
    code text NOT NULL
  )`,
  `CREATE INDEX events_at_idx ON events (at DESC)`,
  `CREATE INDEX events_code_idx ON events (code) WITH (fillfactor = 50)`,
  `CREATE TABLE posts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    author_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    editor_id integer REFERENCES users(id) ON DELETE SET NULL,
    reviewer_id integer REFERENCES users(id),
    created_by integer REFERENCES users(id) ON DELETE CASCADE,
    author_email text NOT NULL REFERENCES users(email),
    title text NOT NULL,
    body text,
    document tsvector,
    published_at timestamptz,
    CONSTRAINT posts_title_not_empty_check CHECK (length(title) > 0),
    CONSTRAINT body_long CHECK (body IS NULL OR length(body) > 3)
  )`,
  `CREATE INDEX posts_author_id_idx ON posts (author_id)`,
  `CREATE INDEX posts_title_lower_idx ON posts (lower(title) DESC NULLS LAST)`,
  `CREATE INDEX posts_recent_idx ON posts (published_at DESC, id) INCLUDE (body) WHERE published_at IS NOT NULL AND title <> 'draft'`,
  `CREATE INDEX legacy_posts_by_editor ON posts (editor_id, published_at)`,
  `CREATE INDEX "Posts_Odd_Name" ON posts (body)`,
  `CREATE INDEX posts_title_pattern_idx ON posts (title text_pattern_ops)`,
  `CREATE UNIQUE INDEX posts_title_unique_idx ON posts (title)`,
  `CREATE INDEX posts_body_search_idx ON posts USING gin (to_tsvector('english', coalesce(body, '')))`,
  `CREATE TABLE tags (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label text NOT NULL,
    CONSTRAINT tags_label_unique UNIQUE (label)
  )`,
  `CREATE TABLE post_tags (
    post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag_id bigint NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, tag_id)
  )`,
  `CREATE TABLE categories (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    parent_id integer REFERENCES categories(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE profiles (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bio text
  )`,
  `CREATE TABLE audit (
    code text NOT NULL,
    seq integer NOT NULL,
    note text,
    PRIMARY KEY (code, seq),
    UNIQUE (code, note)
  )`,
  `CREATE TABLE loose (id integer, label text)`,
];

const cli = async (cwd: string, ...argumentsList: string[]) => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("packages/kit/src/cli/index.ts"),
      ...argumentsList,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DATABASE_URL: "", NO_COLOR: "1" },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, exitCode };
};

describe.skipIf(!url)("pull", () => {
  test("raw predicates, with or without .is(true), are drift-clean", () =>
    sandbox(async ({ driver, run }) => {
      await run(
        `CREATE TABLE products (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, price numeric NOT NULL, published_at timestamptz,
          CONSTRAINT products_positive_check CHECK (price > 0::numeric))`,
      );
      await run(
        `CREATE INDEX products_published_idx ON products (published_at DESC) WHERE published_at IS NOT NULL`,
      );
      const model = (compared: boolean) =>
        schema({
          products: table({
            id: int.auto,
            price: numeric(),
            publishedAt: timestamptz.nullable,
          })
            .checks((products) => {
              const positive = sql<boolean>`${products.price} > 0`;

              return { positive: compared ? positive.is(true) : positive };
            })
            .indexes((products) => {
              const published = sql<boolean>`${products.publishedAt} IS NOT NULL`;

              return {
                published: index(products.publishedAt.descending).where(
                  compared ? published.is(true) : published,
                ),
              };
            }),
        });

      for (const compared of [true, false]) {
        expect(
          await detectDrift({
            execute: driver.execute,
            snapshot: model(compared).$snapshot(),
          }),
        ).toEqual([]);
      }
    }));

  test("the pulled schema loads and drifts only where the warnings said it would", () =>
    sandbox(async ({ driver, directory, namespace, run }) => {
      for (const statement of LEGACY) {
        await run(statement);
      }

      const result = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      const path = join(directory, "schema.ts");
      await writeFile(path, result.source);
      const loaded = await import(pathToFileURL(path).href);
      const findings = await detectDrift({
        execute: driver.execute,
        snapshot: loaded.appSchema.$snapshot(),
      });

      expect(result.schemaName).toBe(namespace);
      expect(result.tables).toEqual([
        "audit",
        "categories",
        "events",
        "loose",
        "post_tags",
        "posts",
        "profiles",
        "tags",
        "users",
      ]);
      expect(result.enumerations).toEqual(["mood", "users_role_enum"]);
      // A shared enum keeps its name on each column; the owned one stays derived.
      expect(result.source).toContain(
        'role: oneOf("admin", "member").default("member"),',
      );
      expect(result.source).toContain(
        'mood: oneOf("happy", "sad").typeName("mood").nullable,',
      );
      expect(result.source).toContain(
        'otherMood: oneOf("happy", "sad").typeName("mood").nullable,',
      );
      // Collations of columns and index keys are declared.
      expect(result.source).toContain('code: text.collate("C").nullable,');
      expect(result.source).toContain(
        'emailC: index(sql<string>`${users.email} COLLATE "C"`),',
      );
      // Conventionally named indexes keep their ordering and storage options.
      expect(result.source).toContain("at: index(events.at.descending),");
      expect(result.source).toContain(
        "code: index(events.code).with({ fillfactor: 50 }),",
      );
      expect(result.source).toContain("id: int.auto.byDefault,");
      // A check stored as `(expr) = true` is declared without the comparison,
      // and as a predicate rather than SQL text.
      expect(result.source).toContain("score: users.score.above(-100),");
      expect(result.source).toContain(
        'editor: maybe(users.inverse("postsByEditor")).noIndex.setNull,',
      );
      expect(result.source).toContain(
        'reviewer: maybe(users.inverse("postsByReviewer")).noIndex.onDelete.noAction,',
      );
      expect(result.source).toContain(
        'createdBy: maybe(users.column("created_by").inverse("postsByCreatedBy")).noIndex.cascade,',
      );
      expect(result.source).toContain(
        'authorEmail: one(users.by("email").column("author_email").inverse("postsByAuthorEmail")).noIndex.onDelete.noAction,',
      );
      expect(result.source).toContain("postTags: ({ posts, tags }) =>");
      // Both keys cascade: a link.
      expect(result.source).toContain("link({");
      expect(result.source).toContain("        post: posts,\n");
      expect(result.source).toContain("author: one(users).cascade,");
      // Each referenced table lists its reverse sides, a self reference too.
      expect(result.source).toContain("postsByEditor: many,");
      expect(result.source).toContain(
        'parent: maybe(categories.inverse("categoriesByParent")).noIndex.cascade,\n        categoriesByParent: many,',
      );
      expect(result.source).toContain(
        ".primaryKey((audit) => [audit.code, audit.seq])",
      );
      expect(result.source).toContain(
        ".primaryKey((profiles) => [profiles.userId])",
      );
      expect(result.source).toContain("big: bigint.auto.byDefault,");
      expect(result.source).toContain(
        'camelCol: text.named("CamelCol").nullable,',
      );
      expect(result.source).toContain(
        "titleLower: index(sql<string>`lower(${posts.title})`.descending.nullsLast),",
      );
      expect(result.source).toContain(
        'recent: index(posts.publishedAt.descending, posts.id).include(posts.body).where(and(posts.publishedAt.isNot(null), posts.title.isNot("draft"))),',
      );
      expect(result.source).toContain(
        "titleUnique: index(posts.title).unique,",
      );
      expect(result.source).toContain("document: tsvector.nullable,");
      expect(result.source).toContain(
        "bodySearch: index(sql<string>`to_tsvector('english'::regconfig, COALESCE(${posts.body}, ''::text))`).using(\"gin\"),",
      );
      expect(result.source).toContain(
        'settings: index(users.settings).using("gin"),',
      );
      expect(result.source).toContain(
        "legacy_posts_by_editor: index(posts.editorId, posts.publishedAt), // pull: name kept exactly",
      );
      expect(result.source).toContain(
        "audit_code_note_key: index(audit.code, audit.note).unique,",
      );
      expect(result.source).toContain(
        "titleNotEmpty: sql<boolean>`(length(${posts.title}) > 0)`,",
      );

      // Every finding is predicted by a warning; nothing representable drifts.
      expect(
        findings.map((finding) =>
          `${finding.kind} ${finding.table}${finding.column ? `.${finding.column}` : ""} ${finding.expected ?? finding.actual ?? ""}`.trim(),
        ),
      ).toEqual([
        "extra-constraint audit audit_code_note_key",
        "extra-column loose.id",
        "missing-index post_tags post_tags_tag_id_idx",
        "missing-constraint posts posts_body_long_check",
        "extra-constraint posts body_long",
        "extra-index posts Posts_Odd_Name",
        "missing-constraint tags tags_label_key",
        "extra-constraint tags tags_label_unique",
      ]);
      expect(
        result.warnings.map((warning) => String(warning.code)).sort(),
      ).toEqual(
        [
          "unique-constraint",
          "primary-key",
          "junction-index",
          "constraint-name",
          "index",
          "constraint-name",
          "serial",
        ].sort(),
      );

      // Applying every suggested fix removes the drift the warnings predicted.
      for (const fix of result.warnings.flatMap((warning) =>
        warning.fix ? [warning.fix] : [],
      )) {
        await run(fix);
      }

      const repulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      // Bun caches file imports by path, so the fixed schema gets its own module.
      const fixed = join(directory, "schema-fixed.ts");
      await writeFile(fixed, repulled.source);
      const reloaded = await import(pathToFileURL(fixed).href);
      const remaining = await detectDrift({
        execute: driver.execute,
        snapshot: reloaded.appSchema.$snapshot(),
      });

      expect(remaining.map((finding) => String(finding.kind))).toEqual([
        "extra-index", // "Posts_Odd_Name" cannot be named by the schema
      ]);
      expect(
        repulled.warnings.map((warning) => String(warning.code)).sort(),
      ).toEqual(["index"]);

      // Drift sees collation changes of columns and index keys.
      await run(
        `ALTER TABLE users ALTER COLUMN code TYPE text COLLATE "POSIX"`,
      );
      await run(`DROP INDEX users_email_c_idx`);
      await run(`CREATE INDEX users_email_c_idx ON users (email)`);
      expect(
        (
          await detectDrift({
            execute: driver.execute,
            snapshot: reloaded.appSchema.$snapshot(),
          })
        ).map((finding) =>
          [finding.kind, finding.column, finding.expected, finding.actual]
            .filter(Boolean)
            .join(" | "),
        ),
      ).toEqual([
        "extra-index | Posts_Odd_Name",
        "collation-mismatch | code | C | POSIX",
        `index-mismatch | CREATE INDEX "users_email_c_idx" ON "users" USING btree (("email" COLLATE "C")) | CREATE INDEX users_email_c_idx ON ${namespace}.users USING btree (email)`,
      ]);
    }));

  test("tables named like builders or reserved words get bindings that shadow nothing", () =>
    sandbox(async ({ driver, directory, run }) => {
      for (const statement of [
        `CREATE TABLE "date" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, day date NOT NULL UNIQUE)`,
        `CREATE TABLE "text" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL)`,
        `CREATE TABLE "sql" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL, CONSTRAINT sql_label_check CHECK (length(label) > 0))`,
        `CREATE INDEX sql_lower_idx ON "sql" (lower(label))`,
        `CREATE TABLE "delete" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, sql_id integer NOT NULL REFERENCES "sql"(id), note text)`,
        `CREATE TABLE "index" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at time NOT NULL, uuid uuid NOT NULL)`,
        `CREATE INDEX index_at_uuid_idx ON "index" (at, uuid)`,
        `CREATE INDEX legacy_index_lookup ON "index" (uuid, at)`,
        `CREATE TABLE "passthrough" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL)`,
        `CREATE TABLE sales (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          date_id integer NOT NULL REFERENCES "date"(id),
          text_id integer REFERENCES "text"(id),
          passthrough_id integer REFERENCES "passthrough"(id),
          sold_on date NOT NULL,
          at time,
          amount money
        )`,
      ]) {
        await run(statement);
      }

      const result = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      expect(result.source).toContain(
        "sales: ({ date: dateTable, passthrough: passthroughTable, text: textTable }) =>",
      );
      expect(result.source).toContain("date: dateTable,");
      expect(result.source).toContain("soldOn: date,");
      expect(result.source).toContain(
        'amount: customType<string>("money", passthrough<string>()).nullable,',
      );
      expect(result.source).toContain("delete: ({ sql: sqlTable }) =>");
      expect(result.source).toContain(".checks((sqlTable) => ({");
      expect(result.source).toContain(
        "lower: index(sql<string>`lower(${sqlTable.label})`),",
      );
      expect(result.source).toContain(
        "atUuid: index(indexTable.at, indexTable.uuid),",
      );
      expect(result.source).toContain("indexes: ({ index: indexTable }) => ({");
      // The money column is the only approximation.
      expect(result.warnings.map((warning) => warning.code)).toEqual([
        "custom-type",
      ]);

      const path = join(directory, "builders.ts");
      await writeFile(path, result.source);
      const loaded = await import(pathToFileURL(path).href);

      expect(
        loaded.appSchema
          .$snapshot()
          .tables.find((table: { name: string }) => table.name === "sales")
          .columns.map((column: { sqlName: string; sqlType: string }) => [
            column.sqlName,
            column.sqlType,
          ]),
      ).toEqual([
        ["id", "integer"],
        ["date_id", "integer"],
        ["text_id", "integer"],
        ["passthrough_id", "integer"],
        ["sold_on", "date"],
        ["at", "time"],
        ["amount", "money"],
      ]);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: loaded.appSchema.$snapshot(),
        }),
      ).toEqual([]);
    }));

  test("pulling a database built from a pulled schema gives the same schema", () =>
    sandbox(async ({ driver, directory, namespace, run }) => {
      const longTable = "customer_subscription_billing_adjustments";
      const longIndex = objectName(
        longTable,
        "previous_invoice_reference",
        "idx",
      );

      for (const statement of [
        `CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN')`,
        `CREATE TABLE accounts (
          id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          role "Role" NOT NULL DEFAULT 'USER',
          previous_role "Role",
          code text COLLATE "C" NOT NULL,
          small smallint NOT NULL,
          label text NOT NULL,
          deleted_at timestamptz,
          CONSTRAINT accounts_small_check CHECK (small > -100),
          CONSTRAINT accounts_wrapped_check CHECK ((small < 100) = true)
        )`,
        `CREATE INDEX accounts_live_idx ON accounts (label) WHERE deleted_at IS NULL`,
        `CREATE INDEX accounts_code_idx ON accounts (code DESC) WITH (fillfactor = 70)`,
        `CREATE INDEX accounts_label_c_idx ON accounts (label COLLATE "C")`,
        `CREATE TABLE ${longTable} (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, previous_invoice_reference text NOT NULL)`,
        `CREATE INDEX "${longIndex}" ON ${longTable} (previous_invoice_reference)`,
      ]) {
        await run(statement);
      }

      const first = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      expect(first.warnings).toEqual([]);
      expect(first.source).toContain("previousInvoiceReference: text.index,");
      expect(first.source).toContain("wrapped: accounts.small.below(100),");

      const firstPath = join(directory, "first.ts");
      await writeFile(firstPath, first.source);
      const { appSchema: firstSchema } = await import(
        pathToFileURL(firstPath).href
      );
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: firstSchema.$snapshot(),
        }),
      ).toEqual([]);

      // Build a second database from the pulled schema's own DDL and pull it.
      const copy = `${namespace}_copy`;
      await run(`CREATE SCHEMA "${copy}"`);

      try {
        for (const statement of createSchemaSQL(firstSchema.$snapshot())) {
          await run(`SET search_path TO "${copy}", public`);
          await run(statement.sql);
        }

        await run(`SET search_path TO "${copy}", public`);
        const second = await pullSchema({
          execute: driver.execute,
          schemaName: copy,
          module: runtime,
        });
        const secondPath = join(directory, "second.ts");
        await writeFile(secondPath, second.source);
        const { appSchema: secondSchema } = await import(
          pathToFileURL(secondPath).href
        );

        expect(second.warnings).toEqual([]);
        expect(second.source.replaceAll(copy, namespace)).toBe(first.source);
        expect(
          diffSchemas(firstSchema.$snapshot(), secondSchema.$snapshot()).up,
        ).toEqual([]);
        expect(
          await detectDrift({
            execute: driver.execute,
            schemaName: copy,
            snapshot: firstSchema.$snapshot(),
          }),
        ).toEqual([]);
      } finally {
        await run(`SET search_path TO "${namespace}"`);
        await run(`DROP SCHEMA "${copy}" CASCADE`);
      }
    }));

  test("the serial fix keeps ids unique on a table with rows", () =>
    sandbox(async ({ driver, directory, run }) => {
      await run(
        `CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL)`,
      );
      await run(`INSERT INTO items (label) VALUES ('a'), ('b'), ('c')`);
      await run(`INSERT INTO items (id, label) VALUES (10, 'explicit')`);
      // Rows were deleted after the sequence moved on; their ids stay unused.
      await run(`SELECT setval('items_id_seq', 20)`);

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      const [serial] = pulled.warnings;
      expect(serial).toMatchObject({ code: "serial", table: "items" });
      await run(serial!.fix!);

      const fixed = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      expect(fixed.warnings).toEqual([]);
      expect(fixed.source).toContain("id: int.auto.byDefault,");

      const path = join(directory, "items.ts");
      await writeFile(path, fixed.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);

      const database = createDatabase({ schema: appSchema, driver });
      const next = await database.items
        .insert({ label: "new" })
        .returning((item: { id: unknown }) => ({ id: item.id }));
      const explicit = await database.items
        .insert({ id: 5, label: "chosen" })
        .returning((item: { id: unknown }) => ({ id: item.id }));

      expect([next, explicit]).toEqual([{ id: 21 }, { id: 5 }]);
      // The old sequence is gone.
      expect(
        normalizeResult(
          await driver.execute({
            sql: `SELECT to_regclass('items_id_seq')::text AS sequence`,
            parameters: [],
          }),
        ).rows,
      ).toEqual([{ sequence: null }]);
    }));

  test("inheritance, row-level security, routines, loose and shared sequences and other schemas are reported", () =>
    sandbox(async ({ driver, namespace, run }) => {
      const neighbour = `${namespace}_neighbour`;

      for (const statement of [
        `CREATE TABLE people (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL)`,
        `CREATE TABLE staff (salary integer NOT NULL, PRIMARY KEY (id)) INHERITS (people)`,
        `CREATE TABLE events (id integer NOT NULL, at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at)`,
        `CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`,
        `ALTER TABLE people ENABLE ROW LEVEL SECURITY`,
        `CREATE POLICY people_read ON people FOR SELECT USING (true)`,
        `CREATE POLICY staff_all ON staff USING (true)`,
        `CREATE FUNCTION full_name(first text, last text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT first || ' ' || last $$`,
        `CREATE FUNCTION full_name(single text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT single $$`,
        `CREATE PROCEDURE cleanup() LANGUAGE sql AS $$ DELETE FROM staff WHERE salary < 0 $$`,
        `CREATE SEQUENCE invoice_numbers`,
        `CREATE SEQUENCE document_ids`,
        `CREATE TABLE invoices (id integer PRIMARY KEY DEFAULT nextval('document_ids'), number integer NOT NULL DEFAULT nextval('invoice_numbers'))`,
        `CREATE TABLE receipts (id integer PRIMARY KEY DEFAULT nextval('document_ids'))`,
        `CREATE TABLE tickets (id serial PRIMARY KEY)`,
        `CREATE TABLE refunds (id serial PRIMARY KEY, ticket integer NOT NULL DEFAULT nextval('tickets_id_seq'))`,
        `CREATE SCHEMA "${neighbour}"`,
        `CREATE TABLE "${neighbour}".audit_log (id integer PRIMARY KEY)`,
        `CREATE TABLE "${neighbour}".audit_users (id integer PRIMARY KEY)`,
      ]) {
        await run(statement);
      }

      try {
        const result = await pullWholeDatabase({
          execute: driver.execute,
          module: runtime,
        });
        const summary = result.warnings
          // Extensions the server image ships are not this test's subject.
          .filter((warning) => warning.code !== "extension")
          .map((warning) =>
            [
              warning.code,
              warning.table ?? "",
              warning.column ?? "",
              warning.fix === undefined ? "" : "fix",
            ]
              .join(" ")
              .trim(),
          );

        expect(summary.sort()).toEqual(
          [
            "inheritance staff",
            "row-security people",
            "row-security staff",
            "function",
            "sequence",
            "other-schema",
            "partition events",
            "partition events_2024",
            // Borrowed or free-standing sequences keep their default, unfixed.
            "sequence invoices id",
            "sequence invoices number",
            "sequence receipts id",
            "sequence tickets id",
            "sequence refunds ticket",
            // Only a sequence nothing else draws from becomes an identity.
            "serial refunds id fix",
          ].sort(),
        );

        const message = (code: string, table?: string) =>
          result.warnings.find(
            (warning) => warning.code === code && warning.table === table,
          )!.message;

        expect(message("function")).toContain(
          '2 functions and procedures "cleanup", "full_name" are not declared',
        );
        expect(message("sequence")).toContain(
          '2 sequences "document_ids", "invoice_numbers" are not owned by a column',
        );
        expect(message("row-security", "people")).toContain(
          'row-level security enabled with policy "people_read"',
        );
        expect(message("row-security", "staff")).toContain(
          'has policy "staff_all" but row-level security is not enabled',
        );
        expect(message("inheritance", "staff")).toContain(
          '"staff" inherits from "people"',
        );
        expect(message("sequence", "tickets")).toContain(
          "is also the default of 1 other column",
        );
        expect(message("other-schema")).toMatch(
          /^\d+ tables? in (?:another schema was|other schemas were) not read: /,
        );
        expect(message("other-schema")).toContain(`"${neighbour}" (2)`);
        expect(message("other-schema")).toEndWith(
          `pull reads one schema, here "${namespace}"`,
        );

        // The one fix leaves the shared sequences and their defaults alone.
        await run(
          result.warnings.find((warning) => warning.fix !== undefined)!.fix!,
        );
        await run(`INSERT INTO invoices DEFAULT VALUES`);
        await run(`INSERT INTO receipts DEFAULT VALUES`);
        await run(`INSERT INTO refunds DEFAULT VALUES`);
        const again = await pullSchema({
          execute: driver.execute,
          module: runtime,
        });
        expect(again.source).toContain("id: int.auto.byDefault,");
        expect(
          again.warnings.filter((warning) => warning.code === "serial"),
        ).toEqual([]);
        expect(
          again.warnings.filter((warning) => warning.fix !== undefined),
        ).toEqual([]);
      } finally {
        await run(`DROP SCHEMA "${neighbour}" CASCADE`);
      }
    }));

  test("uuid.v7 needs PostgreSQL 18, where it generates, drifts clean and pulls back", () =>
    sandbox(async ({ driver, directory, run }) => {
      const appSchema = schema({
        tokens: table({ id: uuid.v7, label: text }),
      });
      const version = Number(
        normalizeResult(
          await driver.execute({
            sql: "SHOW server_version_num",
            parameters: [],
          }),
        ).rows[0]!.server_version_num,
      );
      const create = async () => {
        for (const statement of createSchemaSQL(appSchema.$snapshot())) {
          await run(statement.sql);
        }
      };

      if (version < 180000) {
        // Older servers lack the function; the DDL fails before any table exists.
        await expect(create()).rejects.toMatchObject({
          message: expect.stringContaining("uuidv7()"),
        });

        return;
      }

      await create();
      const database = createDatabase({ schema: appSchema, driver });
      const { id } = await database.tokens
        .insert({ label: "first" })
        .returning((tokens) => [tokens.id]);
      // The version nibble of a UUIDv7.
      expect(id[14]).toBe("7");
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      expect(pulled.warnings).toEqual([]);
      expect(pulled.source).toContain("id: uuid.v7,");
      const path = join(directory, "uuid-v7.ts");
      await writeFile(path, pulled.source);
      const { appSchema: back } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: back.$snapshot(),
        }),
      ).toEqual([]);
    }));

  test("the migration journal is never pulled", () =>
    sandbox(async ({ driver, namespace, run }) => {
      await run(`CREATE TABLE _symmetria_migrations (id text PRIMARY KEY)`);
      await run(`CREATE TABLE items (id integer PRIMARY KEY)`);

      const result = await pullSchema({
        execute: driver.execute,
        metadataSchema: namespace,
      });

      expect(result.tables).toEqual(["items"]);
    }));

  test("the CLI writes the file, refuses to overwrite without --force and reports JSON", () =>
    sandbox(async ({ directory, address, run }) => {
      await run(
        `CREATE TABLE users (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL UNIQUE)`,
      );
      await run(
        `CREATE TABLE posts (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, author_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, title text NOT NULL)`,
      );
      const target = join(directory, "db", "schema.ts");

      const first = await cli(
        directory,
        "pull",
        target,
        "--database-url",
        address,
      );
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("Created");
      // Other suites' schemas may be listed; nothing of this schema is.
      expect(first.stdout).not.toMatch(/^ +\[(?!other-schema\]|extension\])/m);
      expect(await readFile(target, "utf8")).toContain(
        "author: one(users).noIndex.cascade,",
      );

      const second = await cli(
        directory,
        "pull",
        target,
        "--database-url",
        address,
      );
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("--force");

      const third = await cli(
        directory,
        "pull",
        target,
        "--database-url",
        address,
        "--force",
        "--json",
      );
      expect(third.exitCode).toBe(0);
      const report = JSON.parse(third.stdout);
      expect({ ...report, warnings: ownSchema(report.warnings) }).toMatchObject(
        {
          path: target,
          tables: ["posts", "users"],
          enumerations: [],
          warnings: [],
        },
      );
    }));
});

/**
 * A schema written with the DSL: checks and predicates of every shape `pull`
 * reads back. It declares the extensions the server has, which `pull` declares.
 */
const handWritten = (extensions: string[]) =>
  schema(
    {
      accounts: table({
        id: int.auto,
        small: smallint,
        big: bigint,
        score: int,
        lower: int,
        upper: int,
        price: numeric(10, 2),
        ratio: real,
        dbl: doublePrecision,
        name: text,
        nick: varchar(20).nullable,
        code: text.collate("C"),
        status: oneOf("active", "banned", "pending").default("pending"),
        role: oneOf("admin", "member").typeName("Role").default("member"),
        previousRole: oneOf("admin", "member").typeName("Role").nullable,
        active: bool.default(true),
        born: date.nullable,
        at: timestamptz.nullable,
        stamp: timestamp(3).nullable,
        deletedAt: timestamptz.nullable,
      })
        .checks((accounts) => ({
          small: accounts.small.above(-100),
          bigPositive: accounts.big.atLeast(0n),
          price: accounts.price.above("0"),
          ratio: accounts.ratio.below(1.5),
          dbl: accounts.dbl.atMost(2.5),
          range: accounts.score.between(1, 10),
          status: accounts.status.in(["active", "pending"]),
          statusNot: accounts.status.notIn(["banned"]),
          statusOne: accounts.status.in(["active"]),
          role: accounts.role.isNot("admin"),
          nameLike: accounts.name.like("a%"),
          nameIlike: not(accounts.name.ilike("%b")),
          nick: or(accounts.nick.is(null), accounts.nick.isNot("")),
          nickPresent: not(accounts.nick.is(null)),
          nickIn: accounts.nick.in(["a", "b"]),
          ordered: accounts.lower.atMost(accounts.upper),
          arithmetic: accounts.score.plus(1).above(accounts.lower.multiply(2)),
          total: accounts.price.plus("1").above("2"),
          active: accounts.active,
          activeTrue: accounts.active.is(true),
          complex: and(
            accounts.score.above(0),
            or(accounts.small.below(5), accounts.name.isNot("x")),
          ),
          raw: sql<boolean>`${accounts.score} > 0`,
          rawLength: sql<boolean>`length(${accounts.name}) > 0`,
          born: accounts.born.above("2000-01-01"),
          at: accounts.at.above(new Date("2020-01-01T00:00:00Z")),
          stamp: accounts.stamp.below(new Date("2030-06-01T12:30:00.250Z")),
          code: accounts.code.isNot("zz"),
          distinct: accounts.score.isDistinctFrom(3),
          outside: not(accounts.upper.between(100, 200)),
          roles: accounts.previousRole.isDistinctFrom(accounts.role),
        }))
        .indexes((accounts) => ({
          live: index(accounts.name).where(accounts.deletedAt.is(null)),
          partial: index(accounts.score).where(
            and(accounts.status.is("active"), accounts.score.above(5)),
          ),
          flagged: index(accounts.code).where(accounts.active),
          lowerName: index(sql<string>`lower(${accounts.name})`.descending),
          next: index(accounts.score.plus(1)),
          collated: index(sql<string>`${accounts.name} COLLATE "C"`),
        })),
      entries: ({ accounts }) =>
        table({
          id: int.auto,
          account: accounts.onDelete.cascade,
          amount: int,
        }).checks((entries) => ({
          positive: entries.amount.above(0),
          owner: entries.accountId.above(0),
        })),
    },
    { extensions },
  );

describe.skipIf(!url)("pull round trip", () => {
  test(
    "a DSL schema, migrated and pulled back, needs no migration and pulls again unchanged",
    () =>
      sandbox(async ({ driver, directory, namespace, run }) => {
        const extensions = normalizeResult(
          await driver.execute({
            sql: "SELECT extname AS name FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname",
            parameters: [],
          }),
        ).rows.map((row) => String(row.name));
        await generateMigration({
          directory,
          name: "initial",
          snapshot: handWritten(extensions).$snapshot(),
        });
        await migrator({
          driver,
          directory,
          metadataSchema: namespace,
        }).migrate();

        const pulled = await pullSchema({
          execute: driver.execute,
          metadataSchema: namespace,
          module: runtime,
        });
        expect(pulled.warnings).toEqual([]);

        // Conditions come back as predicates; only the function call stays SQL.
        for (const line of [
          "small: accounts.small.above(-100),",
          "bigPositive: accounts.big.atLeast(0n),",
          'price: accounts.price.above("0"),',
          "ratio: accounts.ratio.below(1.5),",
          "range: accounts.score.between(1, 10),",
          'status: accounts.status.in(["active", "pending"]),',
          'statusNot: accounts.status.isNot("banned"),',
          'nameIlike: not(accounts.name.ilike("%b")),',
          'nick: or(accounts.nick.is(null), accounts.nick.isNot("")),',
          'nickIn: accounts.nick.in(["a", "b"]),',
          "arithmetic: accounts.score.plus(1).above(accounts.lower.multiply(2)),",
          'total: accounts.price.plus("1").above("2"),',
          "activeTrue: accounts.active,",
          'at: accounts.at.above(new Date("2020-01-01T00:00:00.000Z")),',
          'stamp: accounts.stamp.below(new Date("2030-06-01T12:30:00.250Z")),',
          "outside: or(accounts.upper.below(100), accounts.upper.above(200)),",
          "roles: accounts.previousRole.isDistinctFrom(accounts.role),",
          "rawLength: sql<boolean>`(length(${accounts.name}) > 0)`,",
          "live: index(accounts.name).where(accounts.deletedAt.is(null)),",
          'partial: index(accounts.score).where(and(accounts.status.is("active"), accounts.score.above(5))),',
          "flagged: index(accounts.code).where(accounts.active),",
          "next: index(accounts.score.plus(1)),",
          "owner: entries.accountId.above(0),",
        ]) {
          expect(pulled.source).toContain(line);
        }

        const path = join(directory, "pulled.ts");
        await writeFile(path, pulled.source);
        const { appSchema } = await import(pathToFileURL(path).href);
        const { snapshot } = await loadMigrationState(directory);
        const plan = diffSchemas(snapshot, appSchema.$snapshot());

        expect([plan.up, plan.down]).toEqual([[], []]);
        expect(
          await generateMigration({
            directory,
            name: "pulled",
            snapshot: appSchema.$snapshot(),
          }),
        ).toBeNull();
        expect(
          await detectDrift({
            execute: driver.execute,
            snapshot: appSchema.$snapshot(),
            metadataSchema: namespace,
          }),
        ).toEqual([]);

        // The CLI with the pulled module as its schema agrees.
        const config = join(directory, "symmetria.config.ts");
        await writeFile(
          config,
          `import { appSchema } from "./pulled.ts";\nexport default { schema: appSchema, directory: ".", metadataSchema: ${JSON.stringify(namespace)} };\n`,
        );
        expect(await cli(directory, "diff")).toMatchObject({
          exitCode: 0,
          stdout: "No schema changes.\n",
        });
        expect(
          await cli(directory, "generate", "pulled", "--no-interactive"),
        ).toMatchObject({ exitCode: 0, stdout: "No schema changes.\n" });

        // Pulling a database built from the pulled module gives the same module.
        const again = await pullSchema({
          execute: driver.execute,
          metadataSchema: namespace,
          module: runtime,
        });
        expect(again.source).toBe(pulled.source);
        const copy = `${namespace}_copy`;
        await run(`CREATE SCHEMA "${copy}"`);

        try {
          await run(`SET search_path TO "${copy}", public`);

          for (const statement of createSchemaSQL(appSchema.$snapshot())) {
            await run(statement.sql);
          }

          const rebuilt = await pullSchema({
            execute: driver.execute,
            schemaName: copy,
            module: runtime,
          });
          expect(rebuilt.source.replaceAll(copy, namespace)).toBe(
            pulled.source,
          );
        } finally {
          await run(`SET search_path TO "${namespace}"`);
          await run(`DROP SCHEMA "${copy}" CASCADE`);
        }

        // A real change to a check is still a migration.
        const changed = join(directory, "changed.ts");
        await writeFile(
          changed,
          pulled.source.replace(
            "accounts.small.above(-100)",
            "accounts.small.above(-99)",
          ),
        );
        const { appSchema: edited } = await import(pathToFileURL(changed).href);
        expect(diffSchemas(snapshot, edited.$snapshot()).up).toEqual([
          'ALTER TABLE "accounts" DROP CONSTRAINT "accounts_small_check"',
          'ALTER TABLE "accounts" ADD CONSTRAINT "accounts_small_check" CHECK ("small" > (-99))',
        ]);
      }),
    30000,
  );

  test("hand-written conditions become predicates only where PostgreSQL stored the DSL's form", () =>
    sandbox(async ({ driver, directory, run }) => {
      const cutoff = "TIMESTAMPTZ '2020-01-01 00:00:00+00'";
      await run(`CREATE TABLE readings (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        big bigint NOT NULL,
        ratio real NOT NULL,
        dbl double precision NOT NULL,
        price numeric(10, 2) NOT NULL,
        label varchar(10) NOT NULL,
        active boolean NOT NULL,
        at timestamptz,
        CONSTRAINT readings_big_check CHECK (big < 10),
        CONSTRAINT readings_big_typed_check CHECK (big < 10::bigint),
        CONSTRAINT readings_ratio_check CHECK (ratio < 1.5),
        CONSTRAINT readings_dbl_check CHECK (dbl BETWEEN 0 AND 1),
        CONSTRAINT readings_price_check CHECK (price > 0 AND price <> 0.5),
        CONSTRAINT readings_label_check CHECK (label NOT LIKE 'x%' AND label IN ('a', 'b', 'c')),
        CONSTRAINT readings_active_check CHECK (active = false OR big IS NOT NULL),
        CONSTRAINT readings_at_check CHECK (at > ${cutoff} AND at < now())
      )`);

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      // PostgreSQL prints the stored instant in the session's time zone.
      const [{ literal }] = normalizeResult(
        await driver.execute({
          sql: `SELECT quote_literal(${cutoff}) AS literal`,
          parameters: [],
        }),
      ).rows as [{ literal: string }];
      for (const line of [
        // A bigint compared with an integer literal uses another operator than the DSL's.
        "big: sql<boolean>`(${readings.big} < 10)`,",
        "bigTyped: readings.big.below(10n),",
        // The literal is double precision, where the DSL compares as real.
        "ratio: sql<boolean>`(${readings.ratio} < (1.5)::double precision)`,",
        "dbl: readings.dbl.between(0, 1),",
        'price: and(readings.price.above("0"), readings.price.isNot("0.5")),',
        'label: and(not(readings.label.like("x%")), readings.label.in(["a", "b", "c"])),',
        "active: or(readings.active.is(false), readings.big.isNot(null)),",
        `at: sql<boolean>\`((\${readings.at} > ${literal}::timestamp with time zone) AND (\${readings.at} < now()))\`,`,
      ]) {
        expect(pulled.source).toContain(line);
      }

      const path = join(directory, "readings.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);
    }));

  test("a division pulls back as PostgreSQL computes it, and the rebuilt checks hold for the same rows", () =>
    sandbox(async ({ driver, directory, namespace, run }) => {
      await run(`CREATE TABLE boxes (
        id integer PRIMARY KEY,
        items integer NOT NULL,
        big bigint,
        small smallint,
        price numeric(10, 2),
        weight double precision,
        CONSTRAINT boxes_items_check CHECK (items / 2 = 3),
        CONSTRAINT boxes_big_check CHECK (big / 2::bigint < 2::bigint),
        CONSTRAINT boxes_small_check CHECK (small / items >= 1),
        CONSTRAINT boxes_price_check CHECK (price / 2 > 1),
        CONSTRAINT boxes_share_check CHECK (items / price > 1),
        CONSTRAINT boxes_weight_check CHECK (weight / 2 > 0.5)
      )`);
      await run(`CREATE INDEX boxes_half_idx ON boxes ((items / 2))`);

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      for (const line of [
        // Integers divide as integers: quotient(), not divide().
        "items: boxes.items.quotient(2).is(3),",
        "big: boxes.big.quotient(2n).below(2n),",
        "small: boxes.small.quotient(boxes.items).atLeast(1),",
        "half: index(boxes.items.quotient(2)),",
        // numeric and double precision divide exactly.
        'price: boxes.price.divide("2").above("1"),',
        'share: boxes.items.divide(boxes.price).above("1"),',
        "weight: boxes.weight.divide(2).above(0.5),",
      ]) {
        expect(pulled.source).toContain(line);
      }

      expect(pulled.warnings).toEqual([]);
      expect(await typeErrors({ "boxes.ts": pulled.source })).toBe("");

      const path = join(directory, "boxes.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);

      await rebuilt(namespace, appSchema, async (second) => {
        for (const [row, expected] of [
          // 7 / 2 is 3 between integers and 3.5 as an exact division.
          ["(1, 7, 3, 7, 3, 3)", "accepted"],
          ["(2, 6, 3, 11, 3, 3)", "accepted"],
          // 5 / 2 is 2, which is not below 2; 2.5 is not either.
          ["(3, 6, 5, 6, 3, 3)", "violates check constraint"],
          // 9 / 6 is 1 and 5 / 6 is 0.
          ["(4, 6, 3, 9, 4, 3)", "accepted"],
          ["(5, 6, 3, 5, 4, 3)", "violates check constraint"],
          // 3 / 2 is 1.5 for a numeric, 2 / 2 is not above 1.
          ["(6, 6, 3, 6, 2, 3)", "violates check constraint"],
          ["(7, 6, 3, 6, 3, 1)", "violates check constraint"],
        ] as const) {
          const insert = `INSERT INTO boxes (id, items, big, small, price, weight) VALUES ${row}`;

          expect([row, await outcome(run, insert)]).toEqual([row, expected]);
          expect([row, await outcome(second, insert)]).toEqual([row, expected]);
        }
      });
    }));

  test("ignoreTables leaves tables out of pull; foreign keys to them stay columns", () =>
    sandbox(async ({ directory, address, driver, run }) => {
      await run(`CREATE TYPE legacy_state AS ENUM ('on', 'off')`);
      await run(
        `CREATE TABLE spatial_ref_sys (srid integer PRIMARY KEY, state legacy_state)`,
      );
      await run(
        `CREATE TRIGGER noop BEFORE UPDATE ON spatial_ref_sys FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
      );
      await run(
        `CREATE TABLE places (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, srid integer NOT NULL REFERENCES spatial_ref_sys(srid))`,
      );
      await run(`CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY)`);

      const result = await pullSchema({
        execute: driver.execute,
        module: runtime,
        ignoreTables: ["spatial_ref_sys"],
      });

      expect(result.tables).toEqual(["places"]);
      expect(result.enumerations).toEqual([]);
      expect(result.source).not.toContain("spatialRefSys");
      expect(result.source).toContain("srid: int,");
      expect(
        result.warnings.map((warning) => [warning.code, warning.message]),
      ).toEqual([
        [
          "migration-table",
          '"_prisma_migrations" is Prisma\'s migration history and is not declared; drop it once Symmetria manages the migrations',
        ],
        [
          "foreign-key",
          'foreign key "places_srid_fkey" is kept as a plain column: the referenced table "spatial_ref_sys" is ignored (ignoreTables)',
        ],
      ]);

      // The CLI takes the same list from the config and --ignore-table, and
      // still reports Prisma's history table.
      await writeFile(
        join(directory, "symmetria.config.ts"),
        `export default { ignoreTables: ["spatial_ref_sys"] };\n`,
      );
      const pulled = await cli(
        directory,
        "pull",
        "--database-url",
        address,
        "--json",
      );
      expect(pulled.exitCode).toBe(0);
      const report = JSON.parse(pulled.stdout);
      expect({ ...report, warnings: ownSchema(report.warnings) }).toMatchObject(
        {
          tables: ["places"],
          warnings: [{ code: "migration-table" }, { code: "foreign-key" }],
        },
      );
      const flagged = await cli(
        directory,
        "pull",
        "flagged.ts",
        "--database-url",
        address,
        "--ignore-table",
        "places",
        "--json",
      );
      expect(JSON.parse(flagged.stdout)).toMatchObject({ tables: [] });
    }));

  test("a schema's own database pulls back to no migration", () =>
    sandbox(async ({ driver, directory, run }) => {
      const declared = schema(
        {
          items: table({
            id: int.auto,
            name: text,
            amount: numeric(6),
            tags: text.array.default(["a b", "c"]),
            wait: interval.default("90 minutes"),
          })
            .indexes((t) => ({
              // A capital in the name only casing: "preserve" gives.
              byName: index(t.name.ascending),
              byAmount: index(t.amount).with({ fillfactor: "50" }),
            }))
            .checks((t) => ({ positive: t.amount.above("0") })),
        },
        { casing: "preserve" },
      );

      for (const statement of createSchemaSQL(declared.$snapshot())) {
        await run(statement.sql);
      }

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      const path = join(directory, "own.ts");

      await writeFile(path, pulled.source);

      const { appSchema } = await import(pathToFileURL(path).href);

      // Extensions are the database's: other suites install vector.
      const { extensions: _extensions, ...tables } = appSchema.$snapshot();

      expect(pulled.warnings).toEqual([]);
      expect(pulled.source).toContain(`casing: "preserve"`);
      expect(diffSchemas(declared.$snapshot(), tables).up).toEqual([]);
    }));

  /** Builds the database from `declared`, pulls it and loads the module. */
  const roundTrip = async (
    context: {
      driver: Driver;
      directory: string;
      run: (sql: string) => Promise<unknown>;
    },
    declared: {
      $snapshot: () => ReturnType<ReturnType<typeof schema>["$snapshot"]>;
    },
    name: string,
  ) => {
    for (const statement of createSchemaSQL(declared.$snapshot())) {
      await context.run(statement.sql);
    }

    const pulled = await pullSchema({
      execute: context.driver.execute,
      module: runtime,
      searchModule: resolve("packages/runtime/src/entries/search.ts"),
    });
    const path = join(context.directory, `${name}.ts`);

    await writeFile(path, pulled.source);

    const { appSchema } = await import(pathToFileURL(path).href);
    const { extensions: _extensions, ...tables } = appSchema.$snapshot();

    return { pulled, tables, snapshot: appSchema.$snapshot() };
  };

  test("a full-text search pulls back as its .search() declaration", () =>
    sandbox(async (context) => {
      const declared = schema({
        notes: table({
          id: int.auto,
          title: varchar(80),
          body: text.nullable,
        }).search((note) => ({
          about: {
            words: fullText(
              { A: note.title, B: note.body },
              { language: "english" },
            ),
          },
          quick: { words: fullText(note.title) },
        })),
      });
      const { pulled, tables, snapshot } = await roundTrip(
        context,
        declared,
        "search",
      );

      expect(pulled.source).toContain(
        `about: { words: fullText({ A: notes.title, B: notes.body }, { language: "english" }) },`,
      );
      expect(pulled.source).toContain(
        "quick: { words: fullText(notes.title) },",
      );
      expect(pulled.warnings).toEqual([]);
      expect(diffSchemas(declared.$snapshot(), tables).up).toEqual([]);
      expect(
        await detectDrift({ execute: context.driver.execute, snapshot }),
      ).toEqual([]);
    }));

  test("tables, columns and CHECK literals PostgreSQL spells its own way pull back to no migration", () =>
    sandbox(async (context) => {
      const declared = schema({
        cars: table({
          id: int.auto,
          maker: text.nullable.named("constructor"),
          label: text.nullable.named("__proto__"),
          tm: time,
          iv: interval,
          key: uuid,
          ip: inet,
        })
          .checks((t) => ({
            late: t.tm.below("23:00"),
            long: t.iv.below("24 hours"),
            ancient: t.iv.above("-1000 years"),
            key: t.key.isNot("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"),
            host: t.ip.isNot("10.0.0.1/32"),
          }))
          .indexes((t) => ({ week: index(t.id).where(t.iv.below("7 days")) })),
        labels: table({ id: int.auto, label: text }).named("toString"),
      });
      const { pulled, tables, snapshot } = await roundTrip(
        context,
        declared,
        "spelled",
      );

      expect(diffSchemas(declared.$snapshot(), tables).up).toEqual([]);
      // Pull writes the literals PostgreSQL stored, which it reads again.
      expect(pulled.source).toContain('above("-1000 years")');
      expect(pulled.source).toContain('below("7 days")');
      expect(pulled.source).toContain('below("24:00:00")');
      expect(
        await detectDrift({ execute: context.driver.execute, snapshot }),
      ).toEqual([]);
    }));

  test("names and texts with line breaks, and negative numbers in expressions, pull back to no migration", () =>
    sandbox(async (context) => {
      const offset = -5;
      const declared = schema({
        odd: table({
          id: int.auto,
          n: int.named("n\rx"),
          note: text.default("a\rb\u2028c\nd").named("note\u2028x"),
          mood: oneOf("kept", "two\nlines").nullable,
        })
          .named("odd\ntable\u2029")
          .checks((t) => ({
            label: t.note.isNot("x\ry\u2028"),
            shifted: sql<boolean>`${t.n}-${offset} > 0`,
            negative: t.n.between(-100, -1),
          }))
          .indexes((t) => ({ low: index(t.n).where(t.n.below(-1)) })),
      });
      const { pulled, tables, snapshot } = await roundTrip(
        context,
        declared,
        "lines",
      );

      // Line breaks reach the module only as escapes.
      expect(pulled.source).not.toMatch(/[\r\u2028\u2029]/);
      expect(pulled.source).toContain('.named("odd\\ntable\\u2029")');
      expect(diffSchemas(declared.$snapshot(), tables).up).toEqual([]);
      expect(
        await detectDrift({ execute: context.driver.execute, snapshot }),
      ).toEqual([]);
    }));

  test("domain columns pull back over their base type: no migration, values of the declared type at every depth", () =>
    sandbox(async (context) => {
      for (const statement of [
        "CREATE DOMAIN amount AS numeric(30,10)",
        "CREATE DOMAIN big_id AS bigint",
        "CREATE DOMAIN moment AS timestamptz",
        "CREATE DOMAIN flag AS boolean",
        "CREATE DOMAIN positive AS amount CHECK (VALUE > 0)",
      ]) {
        await context.run(statement);
      }

      const owners = table({ id: int.auto, ledger: many });
      const ledger = table({
        id: int.auto,
        owner: one(owners.ledger),
        amount: customType<Decimal>("amount", { base: "numeric(30,10)" }),
        big: customType<bigint>("big_id", { base: "bigint" }),
        at: customType<Date>("moment", { base: "timestamp with time zone" }),
        flag: customType<boolean>("flag", { base: "boolean" }),
        positive: customType<Decimal>("positive", { base: "numeric(30,10)" }),
      });
      const declared = schema({ owners, ledger });
      const { pulled, tables, snapshot } = await roundTrip(
        context,
        declared,
        "domains",
      );

      expect(pulled.source).toContain(
        'big: customType<bigint>("big_id", { base: "bigint" }), // pull: domain over bigint',
      );
      expect(pulled.source).toContain(
        'positive: customType<Decimal>("positive", { base: "numeric(30,10)" }), // pull: domain over numeric(30,10)',
      );
      expect(diffSchemas(declared.$snapshot(), tables).up).toEqual([]);
      expect(
        await detectDrift({ execute: context.driver.execute, snapshot }),
      ).toEqual([]);

      await context.run(
        "INSERT INTO owners DEFAULT VALUES; INSERT INTO ledger (owner_id, amount, big, at, flag, positive) VALUES (1, 1234567890.0123456789, 9007199254740993, '2026-01-02T03:04:05Z', true, 5.5)",
      );
      const { appSchema } = await import(
        pathToFileURL(join(context.directory, "domains.ts")).href
      );
      const database = createDatabase({
        schema: appSchema,
        driver: context.driver,
      }) as unknown as ReturnType<typeof createDatabase<typeof declared>>;
      const expected = {
        amount: "1234567890.0123456789",
        big: 9007199254740993n,
        at: new Date("2026-01-02T03:04:05Z"),
        flag: true,
        positive: "5.5000000000",
      } as const;

      // Top level, nested (read from JSON) and in $batch.
      expect(
        await database.ledger((entry) => ({
          amount: entry.amount,
          big: entry.big,
          at: entry.at,
          flag: entry.flag,
          positive: entry.positive,
        })),
      ).toEqual([expected]);
      expect(
        await database.owners((owner) => ({
          ledger: owner.ledger((entry) => ({
            amount: entry.amount,
            big: entry.big,
            at: entry.at,
            flag: entry.flag,
            positive: entry.positive,
          })),
        })),
      ).toEqual([{ ledger: [expected] }]);
      expect(
        await database.$batch((batch) => [
          batch
            .ledger((entry) => ({
              amount: entry.amount,
              big: entry.big,
              at: entry.at,
              flag: entry.flag,
              positive: entry.positive,
            }))
            .first(),
        ]),
      ).toEqual([expected]);
    }));

  test("a search-shaped tsvector that is NOT NULL or used by another index stays a column with its warning", () =>
    sandbox(async ({ driver, run }) => {
      // `.search()` creates the column nullable and only its own GIN index on it.
      await run(
        `CREATE TABLE posts (id int PRIMARY KEY, title text NOT NULL, doc_words tsvector NOT NULL GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A')) STORED)`,
      );
      await run(
        "CREATE INDEX posts_doc_words_idx ON posts USING gin (doc_words)",
      );
      await run(
        `CREATE TABLE notes (id int PRIMARY KEY, title text NOT NULL, about_words tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A')) STORED)`,
      );
      await run(
        "CREATE INDEX notes_about_words_idx ON notes USING gin (about_words)",
      );
      await run("CREATE INDEX notes_extra ON notes USING gist (about_words)");

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      expect(pulled.source).not.toContain("fullText");
      expect(pulled.source).toContain("notes_extra");
      expect(
        pulled.warnings
          .filter((warning) => warning.code === "generated-column")
          .map((warning) => warning.table)
          .sort(),
      ).toEqual(["notes", "posts"]);
    }));

  test("UNLOGGED tables and identity sequence options are reported", () =>
    sandbox(async ({ driver, run }) => {
      await run(
        "CREATE TABLE numbered (id int GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 10) PRIMARY KEY)",
      );
      await run("CREATE UNLOGGED TABLE scratch (id int PRIMARY KEY)");
      await run(
        "CREATE TABLE plain (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY)",
      );

      const { warnings } = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      expect(
        warnings.map(({ code, table, column }) => ({ code, table, column })),
      ).toEqual([
        { code: "sequence", table: "numbered", column: "id" },
        { code: "unlogged", table: "scratch", column: undefined },
      ]);
      expect(
        warnings.find((warning) => warning.code === "sequence")!.message,
      ).toContain("(START 1000 INCREMENT 10)");
    }));

  test("a PascalCase database pulls to a module that type-checks, loads and has no drift", () =>
    sandbox(async ({ driver, directory, run }) => {
      for (const statement of [
        `CREATE TYPE "OrderStatus" AS ENUM ('New', 'Paid')`,
        `CREATE TABLE "Customers" (
          "Id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          "Name" text NOT NULL,
          "Email" text NOT NULL UNIQUE,
          "NickName" varchar(40) COLLATE "C",
          "CreatedAt" timestamptz NOT NULL DEFAULT now(),
          "UpdatedAt" timestamp(3) DEFAULT now(),
          "Token" uuid NOT NULL DEFAULT gen_random_uuid(),
          "OptionalToken" uuid DEFAULT gen_random_uuid() UNIQUE,
          "Tags" text[] NOT NULL DEFAULT '{}',
          "Score" integer NOT NULL DEFAULT 0,
          "Balance" numeric(12,2) NOT NULL DEFAULT 0,
          "Status" "OrderStatus" NOT NULL DEFAULT 'New',
          "Settings" jsonb NOT NULL DEFAULT '{}',
          "Big" bigint GENERATED ALWAYS AS IDENTITY,
          "Small" smallint GENERATED BY DEFAULT AS IDENTITY UNIQUE,
          "Code" text NOT NULL
        )`,
        `CREATE INDEX "Customers_Code_idx" ON "Customers" ("Code")`,
        `CREATE TABLE "Orders" (
          "Id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "CustomerId" integer NOT NULL REFERENCES "Customers"("Id") ON DELETE CASCADE,
          "ApproverId" integer REFERENCES "Customers"("Id") ON DELETE SET NULL,
          "BuyerEmail" text REFERENCES "Customers"("Email") ON UPDATE CASCADE,
          "PlacedAt" timestamp(3) NOT NULL DEFAULT now(),
          "Ref" uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
          "Status" "OrderStatus" NOT NULL
        )`,
        `CREATE INDEX "Orders_CustomerId_idx" ON "Orders" ("CustomerId")`,
        `CREATE TABLE "Events" (
          "EventKey" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          "At" timestamptz DEFAULT now() NOT NULL
        )`,
        `CREATE TABLE "Lines" (
          "OrderId" bigint NOT NULL REFERENCES "Orders"("Id") ON DELETE CASCADE,
          "LineNo" integer NOT NULL,
          "Made" timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY ("OrderId", "LineNo")
        )`,
      ]) {
        await run(statement);
      }

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      // A shortcut of the builder comes before .named(), which returns a
      // column typed without it.
      for (const line of [
        'id: int.auto.byDefault.named("Id"),',
        'createdAt: timestamptz.now.named("CreatedAt"),',
        'updatedAt: timestamp(3).now.named("UpdatedAt").nullable,',
        'token: uuid.v4.named("Token"),',
        'optionalToken: uuid.v4.named("OptionalToken").nullable.unique,',
        'big: bigint.auto.named("Big"),',
        'small: smallint.auto.byDefault.named("Small").unique,',
        'eventKey: uuid.v4.named("EventKey").primaryKey,',
        'placedAt: timestamp(3).now.named("PlacedAt"),',
        'nickName: varchar(40).collate("C").named("NickName").nullable,',
        'status: oneOf("New", "Paid").typeName("OrderStatus").named("Status").default("New"),',
        'customer: one(customers.column("CustomerId")).cascade,',
        'buyerEmail: maybe(customers.by("email").column("BuyerEmail").inverse("ordersByBuyerEmail")).noIndex.onDelete.noAction.onUpdate.cascade,',
      ]) {
        expect(pulled.source).toContain(line);
      }

      expect(pulled.warnings).toEqual([]);
      expect(await typeErrors({ "pascal.ts": pulled.source })).toBe("");

      const path = join(directory, "pascal.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);
    }));

  test("two foreign keys on one column: one is declared, the other is listed with its definition", () =>
    sandbox(async ({ driver, directory, run }) => {
      for (const statement of [
        `CREATE TABLE accounts (id integer PRIMARY KEY)`,
        `CREATE TABLE people (id integer PRIMARY KEY)`,
        `CREATE TABLE memberships (id integer PRIMARY KEY, owner_id integer NOT NULL,
          CONSTRAINT memberships_account_fk FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE,
          CONSTRAINT memberships_person_fk FOREIGN KEY (owner_id) REFERENCES people(id))`,
        `CREATE TABLE notes (id integer PRIMARY KEY, account_id integer REFERENCES accounts(id) ON DELETE CASCADE,
          CONSTRAINT fk_notes_account FOREIGN KEY (account_id) REFERENCES accounts(id))`,
      ]) {
        await run(statement);
      }

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      expect(pulled.source).toContain(
        'owner: one(accounts).noIndex.cascade, // pull: foreign key "memberships_person_fk" is not declared: FOREIGN KEY (owner_id) REFERENCES people(id); constraint "memberships_account_fk" is named "memberships_owner_id_fkey"',
      );
      expect(pulled.source).toContain(
        'account: maybe(accounts).noIndex.cascade, // pull: foreign key "fk_notes_account" is not declared: FOREIGN KEY (account_id) REFERENCES accounts(id)',
      );
      expect(
        pulled.warnings.map((warning) => [
          warning.code,
          warning.object,
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
          "fk_notes_account",
          'foreign key "fk_notes_account" is not declared: "notes.account_id" has more than one foreign key and the schema declares one per column, here "notes_account_id_fkey" (the one with the name the schema gives the key); migrations neither create nor drop "fk_notes_account", and a database built from this schema lacks it (FOREIGN KEY (account_id) REFERENCES accounts(id))',
        ],
        [
          "constraint-name",
          "memberships_account_fk",
          'foreign key "memberships_account_fk" will be expected as "memberships_owner_id_fkey"',
        ],
      ]);

      // Drift names what the entries announced, and nothing else.
      const path = join(directory, "keys.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        (
          await detectDrift({
            execute: driver.execute,
            snapshot: appSchema.$snapshot(),
          })
        )
          .map((finding) =>
            [finding.kind, finding.table, finding.expected ?? finding.actual]
              .join(" ")
              .trim(),
          )
          .sort(),
      ).toEqual([
        "extra-constraint memberships memberships_account_fk",
        "extra-constraint memberships memberships_person_fk",
        "extra-constraint notes fk_notes_account",
        "missing-constraint memberships memberships_owner_id_fkey",
      ]);
    }));

  test("defaults written as a literal of another type keep the value PostgreSQL stores", () =>
    sandbox(async ({ driver, directory, namespace, run }) => {
      await run(`CREATE TABLE codes (
        id integer PRIMARY KEY,
        padded text NOT NULL DEFAULT 'ab '::bpchar,
        short varchar(10) DEFAULT 'ab '::bpchar,
        cut text DEFAULT 'abcdef'::varchar(3),
        kept text DEFAULT 'ab '::varchar(10),
        fixed char(4) DEFAULT 'ab',
        widened double precision DEFAULT '-0.1'::real,
        price numeric DEFAULT '-1.005'::numeric(10,2),
        filled numeric DEFAULT '7'::numeric(10,2)
      )`);

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      for (const line of [
        // PostgreSQL drops a bpchar's trailing spaces and cuts at varchar(3).
        'padded: text.default("ab"),',
        'short: varchar(10).default("ab").nullable,',
        'cut: text.default("abc").nullable,',
        'kept: text.default("ab ").nullable,',
        "fixed: customType<string>(\"character(4)\", passthrough<string>()).default(sql`'ab'::bpchar`).nullable, // pull: no builder for character(4)",
        // A real is not the number its text reads as, and numeric(10,2) rounds.
        "widened: doublePrecision.default(sql`'-0.1'::real`).nullable,",
        "price: numeric.default(sql`'-1.005'::numeric(10,2)`).nullable,",
        // ... and fills a number up to two decimals: a fresh row holds 7.00.
        'filled: numeric.default("7.00").nullable,',
      ]) {
        expect(pulled.source).toContain(line);
      }

      const path = join(directory, "codes.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);

      // A row of defaults is the same row in a database built from the module.
      const defaults = async (execute: (sql: string) => Promise<unknown>) => {
        await execute("INSERT INTO codes (id) VALUES (1)");

        return normalizeResult(
          (await execute(
            `SELECT '[' || padded || ']' AS padded, '[' || short || ']' AS short, cut, '[' || kept || ']' AS kept, '[' || fixed::text || ']' AS fixed, widened::text, price::text, filled::text FROM codes`,
          )) as Parameters<typeof normalizeResult>[0],
        ).rows[0];
      };
      const original = await defaults(run);

      expect(original).toEqual({
        padded: "[ab]",
        short: "[ab]",
        cut: "abc",
        kept: "[ab ]",
        fixed: "[ab]",
        widened: "-0.10000000149011612",
        price: "-1.01",
        filled: "7.00",
      });
      await rebuilt(namespace, appSchema, async (second) => {
        expect(await defaults(second)).toEqual(original);
      });
    }));

  test("a numeric with a scale above its precision or below zero (PostgreSQL 15+) loads, type-checks and has no drift", () =>
    sandbox(async ({ driver, directory, namespace, run }) => {
      const version = Number(
        normalizeResult(
          await driver.execute({
            sql: "SHOW server_version_num",
            parameters: [],
          }),
        ).rows[0]!.server_version_num,
      );

      // Older servers take a scale from zero to the precision only.
      if (version < 150000) {
        return;
      }

      await run(`CREATE TABLE rates (
        id integer PRIMARY KEY,
        fee numeric(10,4) NOT NULL DEFAULT 1,
        tiny numeric(3,5) NOT NULL DEFAULT 0.00123,
        rounded numeric(5,-2) DEFAULT 12345,
        CONSTRAINT rates_tiny_check CHECK (tiny < 0.01),
        CONSTRAINT rates_twice_check CHECK (tiny * 2 < 0.5),
        CONSTRAINT rates_above_check CHECK (fee > tiny),
        CONSTRAINT rates_below_check CHECK (tiny < fee),
        CONSTRAINT rates_between_check CHECK (fee BETWEEN tiny AND 100),
        CONSTRAINT rates_in_check CHECK (rounded IN (12300, 200))
      )`);
      await run(`CREATE INDEX rates_over_idx ON rates (fee) WHERE fee >= tiny`);

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      for (const line of [
        // numeric(3, 5) is refused by the builder: the module would not load.
        'tiny: customType<Decimal>("numeric(3,5)", { base: "numeric" }).default(sql`0.00123`), // pull: no builder for numeric(3,5)',
        'rounded: customType<Decimal>("numeric(5,-2)", { base: "numeric" }).default(sql`12345`).nullable, // pull: no builder for numeric(5,-2)',
        // Declared with numeric's values, it compares and computes with
        // numeric() columns on either side.
        'tiny: rates.tiny.below("0.01"),',
        'twice: rates.tiny.multiply("2").below("0.5"),',
        "above: rates.fee.above(rates.tiny),",
        "below: rates.tiny.below(rates.fee),",
        'between: rates.fee.between(rates.tiny, "100"),',
        'in: rates.rounded.in(["12300", "200"]),',
        "over: index(rates.fee).where(rates.fee.atLeast(rates.tiny)),",
      ]) {
        expect(pulled.source).toContain(line);
      }

      expect(await typeErrors({ "rates.ts": pulled.source })).toBe("");

      const path = join(directory, "rates.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);

      const stored = async (execute: (sql: string) => Promise<unknown>) => {
        await execute("INSERT INTO rates (id) VALUES (1)");

        return normalizeResult(
          (await execute(
            "SELECT tiny::text, rounded::text FROM rates",
          )) as Parameters<typeof normalizeResult>[0],
        ).rows[0];
      };
      const original = await stored(run);

      expect(original).toEqual({ tiny: "0.00123", rounded: "12300" });
      await rebuilt(namespace, appSchema, async (second) => {
        expect(await stored(second)).toEqual(original);
      });

      // Through the module the values are exact decimal text, written and read.
      const database = createDatabase({ schema: appSchema, driver });
      await database.rates.insert({
        id: 2,
        fee: "1.5",
        tiny: "0.00999",
        rounded: "12345",
      });
      expect(
        await database.rates(
          (rates: Record<string, unknown>) => ({
            fee: rates.fee,
            tiny: rates.tiny,
            rounded: rates.rounded,
          }),
          {
            where: (rates: { tiny: { is: (value: string) => unknown } }) =>
              rates.tiny.is("0.00999"),
          },
        ),
      ).toEqual([{ fee: "1.5000", tiny: "0.00999", rounded: "12300" }]);
    }));

  test("a number outside a smallint value's range keeps the condition as SQL, and the module loads", () =>
    sandbox(async ({ driver, directory, namespace, run }) => {
      await run(`CREATE TABLE stock (
        id integer PRIMARY KEY,
        boxes smallint NOT NULL,
        per_box smallint NOT NULL,
        total integer NOT NULL,
        CONSTRAINT stock_ratio_check CHECK (boxes / per_box <= 40000),
        CONSTRAINT stock_ratio_small_check CHECK (boxes / per_box <= 100),
        CONSTRAINT stock_boxes_check CHECK (boxes <= 40000),
        CONSTRAINT stock_floor_check CHECK (boxes >= -32768 AND boxes <= 32767),
        CONSTRAINT stock_sum_check CHECK (boxes + per_box <= 40000),
        CONSTRAINT stock_listed_check CHECK (boxes NOT IN (7, 40000)),
        CONSTRAINT stock_range_check CHECK (boxes BETWEEN 0 AND 40000),
        CONSTRAINT stock_reversed_check CHECK (40000 >= boxes * per_box),
        CONSTRAINT stock_step_check CHECK (boxes + 1 <= 40000),
        CONSTRAINT stock_half_check CHECK (boxes / 2 <= 40000),
        CONSTRAINT stock_total_check CHECK (boxes + total <= 2147483647)
      )`);
      await run(
        `CREATE INDEX stock_ratio_idx ON stock (id) WHERE boxes / per_box < 100000`,
      );

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      for (const line of [
        // PostgreSQL compares a smallint with any integer; the DSL refuses
        // a number outside the smallint range when the module loads.
        "ratio: sql<boolean>`((${stock.boxes} / ${stock.perBox}) <= 40000)`,",
        "boxes: sql<boolean>`(${stock.boxes} <= 40000)`,",
        "sum: sql<boolean>`((${stock.boxes} + ${stock.perBox}) <= 40000)`,",
        "listed: sql<boolean>`(${stock.boxes} <> ALL (ARRAY[7, 40000]))`,",
        "range: sql<boolean>`((${stock.boxes} >= 0) AND (${stock.boxes} <= 40000))`,",
        "reversed: sql<boolean>`(40000 >= (${stock.boxes} * ${stock.perBox}))`,",
        "ratio: index(stock.id).where(sql<boolean>`(${stock.boxes} / ${stock.perBox}) < 100000`),",
        // Inside the range, and where a literal or an integer column makes
        // the left side an integer, the condition is a predicate.
        "ratioSmall: stock.boxes.quotient(stock.perBox).atMost(100),",
        "floor: stock.boxes.between(-32768, 32767),",
        "step: stock.boxes.plus(1).atMost(40000),",
        "half: stock.boxes.quotient(2).atMost(40000),",
        "total: stock.boxes.plus(stock.total).atMost(2147483647),",
      ]) {
        expect(pulled.source).toContain(line);
      }

      expect(pulled.warnings).toEqual([]);
      expect(await typeErrors({ "stock.ts": pulled.source })).toBe("");

      const path = join(directory, "stock.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);
      expect(
        await detectDrift({
          execute: driver.execute,
          snapshot: appSchema.$snapshot(),
        }),
      ).toEqual([]);

      await rebuilt(namespace, appSchema, async (second) => {
        for (const [row, expected] of [
          ["(1, 100, 2, 5)", "accepted"],
          // 300 / 2 is 150, above the 100 of the small ratio check.
          ["(2, 300, 2, 5)", "violates check constraint"],
          ["(3, 7, 1, 5)", "violates check constraint"],
        ] as const) {
          const insert = `INSERT INTO stock (id, boxes, per_box, total) VALUES ${row}`;

          expect([row, await outcome(run, insert)]).toEqual([row, expected]);
          expect([row, await outcome(second, insert)]).toEqual([row, expected]);
        }
      });
    }));

  test("rules, foreign tables, storage and operator class parameters and a deferrable UNIQUE are reported", () =>
    sandbox(async ({ driver, namespace, run }) => {
      // Servers and their wrappers belong to the database, not to a schema.
      const wrapper = `${namespace}_wrapper`;
      const server = `${namespace}_server`;

      try {
        for (const statement of [
          `CREATE TABLE docs (id integer PRIMARY KEY, title text, body tsvector, a integer, b integer,
            CONSTRAINT docs_a_b_key UNIQUE (a, b) DEFERRABLE INITIALLY DEFERRED) WITH (fillfactor = 70, autovacuum_enabled = false)`,
          `CREATE INDEX docs_body_idx ON docs USING gist (body tsvector_ops (siglen = 500))`,
          `CREATE RULE docs_keep AS ON DELETE TO docs DO INSTEAD NOTHING`,
          `CREATE FOREIGN DATA WRAPPER "${wrapper}"`,
          `CREATE SERVER "${server}" FOREIGN DATA WRAPPER "${wrapper}"`,
          `CREATE FOREIGN TABLE remote_docs (id integer, title text) SERVER "${server}"`,
        ]) {
          await run(statement);
        }

        const pulled = await pullSchema({
          execute: driver.execute,
          module: runtime,
        });

        expect(
          pulled.warnings.map((warning) => [warning.code, warning.message]),
        ).toEqual([
          [
            "foreign-table",
            `foreign table "remote_docs" of server "${server}" is not declared; queries cannot reach it through the schema and migrations neither create nor drop it`,
          ],
          [
            "rule",
            'rule "docs_keep" on "docs" is not declared; the schema does not manage rules, so migrations neither create nor drop it and a database built from this schema lacks it (CREATE RULE docs_keep AS ON DELETE TO docs DO INSTEAD NOTHING;)',
          ],
          [
            "storage-parameters",
            '"docs" has storage parameters the schema cannot declare (fillfactor=70, autovacuum_enabled=false); a database built from this schema creates the table with the defaults',
          ],
          [
            "unique-constraint",
            'multi-column unique constraint "docs_a_b_key" (a, b) is DEFERRABLE INITIALLY DEFERRED, which the schema cannot declare. It is declared as a unique index of the same name, and an index refuses a duplicate at once, where this constraint waits for the end of the transaction: a database built from this schema fails writes that hold a duplicate only for a moment, such as two rows swapping their values. The constraint itself stays undeclared',
          ],
          [
            "index",
            `index "docs_body_idx" is declared without its operator class parameters, which the schema cannot declare: body (siglen=500); a database built from this schema creates the index with the operator class's defaults (CREATE INDEX docs_body_idx ON ${namespace}.docs USING gist (body tsvector_ops (siglen='500')))`,
          ],
        ]);
        // Replacing the constraint by an index would make the check immediate.
        expect(pulled.warnings.filter((warning) => warning.fix)).toEqual([]);

        for (const line of [
          `// pull: table "remote_docs" skipped: a foreign table of server "${server}"; the schema declares ordinary tables`,
          '// pull: rule "docs_keep" is not declared',
          "// pull: storage parameters are not declared: fillfactor=70, autovacuum_enabled=false",
          'body: index(docs.body).using("gist"), // pull: operator class parameters are not declared: body (siglen=500)',
          "docs_a_b_key: index(docs.a, docs.b).unique, // pull: the constraint is DEFERRABLE INITIALLY DEFERRED; the index checks at once; name kept exactly",
        ]) {
          expect(pulled.source).toContain(line);
        }
      } finally {
        await run(`DROP FOREIGN DATA WRAPPER IF EXISTS "${wrapper}" CASCADE`);
      }
    }));
});
