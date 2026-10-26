import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  uuid,
  bigint,
  jsonb,
  timestamptz,
  oneOf,
  index,
  customType,
} from "../../../packages/runtime/src";
import {
  migrationSnapshot,
  parseMigrationSnapshot,
  snapshotHash,
  emptySnapshot,
  diffSchemas,
  createSchemaSQL,
  lintMigration,
  formatLintFindings,
  normalizeSqlType,
} from "../../../packages/kit/src";
import { splitMigrationSQL } from "../../../packages/kit/src/migrations/sql";
import { objectName } from "../../../packages/kit/src/migrations/snapshot";

test("migration snapshots normalize physical names, defaults and ordering without losing bigint or Date", () => {
  const model = schema({
    records: {
      id: int.auto,
      value: bigint.default(9007199254740993n),
      createdAt: timestamptz.default(new Date("2026-01-01T00:00:00Z")),
      details: jsonb<{ second: number; first: string }>().default({
        second: 2,
        first: "hello'\\world",
      }),
    },
  });
  const snapshot = migrationSnapshot(model.$snapshot());
  expect(
    snapshot.tables[0]?.columns.find((column) => column.name === "value")
      ?.default,
  ).toBe("9007199254740993");
  expect(
    snapshot.tables[0]?.columns.find((column) => column.name === "created_at")
      ?.default,
  ).toContain("2026-01-01T00:00:00.000Z");
  expect(
    snapshot.tables[0]?.columns.find((column) => column.name === "details")
      ?.default,
  ).toContain('{"first":');
  expect(parseMigrationSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
    snapshot,
  );
  const reordered = model.$snapshot();
  reordered.tables[0]!.columns.reverse();
  expect(snapshotHash(migrationSnapshot(reordered))).toBe(
    snapshotHash(snapshot),
  );
  expect(diffSchemas(model.$snapshot(), reordered).up).toEqual([]);
  expect(() => parseMigrationSnapshot({ ...snapshot, version: 2 })).toThrow(
    /version 1/,
  );
});

test("custom default codecs produce storage defaults in migration snapshots", () => {
  const amount = customType<{ cents: bigint }>("bigint", {
    encode: (value) => value.cents.toString(),
    decode: (value) => ({ cents: BigInt(value as string) }),
  });
  const model = schema({
    wallets: { id: int.auto, balance: amount.default({ cents: 123n }) },
  });
  expect(
    migrationSnapshot(model.$snapshot()).tables[0]?.columns.find(
      (column) => column.name === "balance",
    )?.default,
  ).toBe("E'123'");
  const optional = customType<string | null>("text", {
    encode: (value) => value ?? "sentinel",
    decode: (value) => value as string | null,
  });
  const nullableModel = schema({
    records: { id: int.auto, label: optional.nullable.default(null) },
  });
  expect(
    migrationSnapshot(nullableModel.$snapshot()).tables[0]?.columns.find(
      (column) => column.name === "label",
    )?.default,
  ).toBe("NULL");
});

test("JSON defaults follow JSON serialization semantics and enum ownership is unambiguous", () => {
  const model = schema({
    records: {
      id: int,
      details: jsonb<unknown>().default({
        date: new Date("2026-01-01T00:00:00Z"),
        absent: undefined,
      }),
    },
  });
  expect(
    migrationSnapshot(model.$snapshot()).tables[0]?.columns.find(
      (column) => column.name === "details",
    )?.default,
  ).toBe(`E'{"date":"2026-01-01T00:00:00.000Z"}'::jsonb`);
  const conflicting = schema({
    firstSecond: { id: int, status: oneOf("a") },
    first: { id: int, secondStatus: oneOf("a") },
  });
  expect(() => migrationSnapshot(conflicting.$snapshot())).toThrow(
    /duplicate enum name/,
  );
});

test("array and Standard Schema JSON defaults become typed literals", () => {
  const settings = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
    },
  } as const;
  const model = schema({
    records: {
      id: int,
      tags: text.array.default([]),
      labels: text.array.default(['a "b"', "c\\d", "e'f"]),
      counters: bigint.array.default([9007199254740993n]),
      seen: timestamptz.array.default([new Date("2026-01-01T00:00:00Z")]),
      settings: jsonb(settings).default({ theme: "dark" }),
    },
  });
  const defaults = Object.fromEntries(
    migrationSnapshot(model.$snapshot()).tables[0]!.columns.map((column) => [
      column.name,
      column.default,
    ]),
  );
  expect(defaults).toMatchObject({
    tags: "E'{}'::text[]",
    labels: String.raw`E'{"a \\"b\\"","c\\\\d","e''f"}'::text[]`,
    counters: `E'{"9007199254740993"}'::bigint[]`,
    seen: `E'{"2026-01-01T00:00:00.000Z"}'::timestamptz[]`,
    settings: `E'{"theme":"dark"}'::jsonb`,
  });
  expect(() =>
    migrationSnapshot(
      schema({
        grid: { id: int, cells: int.array.default([[1]] as never) },
      }).$snapshot(),
    ),
  ).toThrow(/unsupported default for "grid.cells"/);
});

test("DDL creates enum types and tables before foreign keys, including cyclic references", () => {
  const model = schema({
    users: ({ teams }) => ({
      id: uuid.v4,
      status: oneOf("active", "disabled").default("active"),
      team: teams.nullable,
    }),
    teams: ({ users }) => ({ id: int.auto, owner: users }),
  });
  const statements = createSchemaSQL(model.$snapshot()).map(
    (query) => query.sql,
  );
  expect(statements[0]).toBe(
    "CREATE TYPE \"users_status_enum\" AS ENUM (E'active', E'disabled')",
  );
  expect(
    statements.find((sql) => sql.startsWith('CREATE TABLE "teams"')),
  ).toContain("GENERATED ALWAYS AS IDENTITY");
  expect(
    statements.findIndex((sql) =>
      sql.includes('ADD CONSTRAINT "teams_owner_id_fkey"'),
    ),
  ).toBeGreaterThan(
    statements.findIndex((sql) => sql.startsWith('CREATE TABLE "users"')),
  );
  expect(diffSchemas(model.$snapshot(), emptySnapshot()).up.at(-1)).toBe(
    'DROP TYPE "users_status_enum"',
  );
});

test("explicit renames preserve tables and columns and rename dependent constraints", () => {
  const before = schema({
    users: { id: int.auto, name: text.unique },
    posts: ({ users }) => ({ id: int.auto, author: users }),
  });
  const after = schema({
    members: { id: int.auto, displayName: text.unique },
    posts: ({ members }) => ({ id: int.auto, author: members }),
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
    renames: {
      tables: { users: "members" },
      columns: { members: { name: "display_name" } },
    },
  });
  expect(plan.up).toContain('ALTER TABLE "users" RENAME TO "members"');
  expect(plan.up).toContain(
    'ALTER TABLE "members" RENAME COLUMN "name" TO "display_name"',
  );
  expect(plan.up.some((sql) => sql.startsWith("DROP TABLE"))).toBe(false);
  expect(plan.down).toContain('ALTER TABLE "members" RENAME TO "users"');
  expect(plan.down).toContain(
    'ALTER TABLE "users" RENAME COLUMN "display_name" TO "name"',
  );
  // Keys, unique constraints and foreign keys follow the rename instead of being rebuilt.
  expect(
    plan.up.filter((sql) => /DROP CONSTRAINT|ADD CONSTRAINT/.test(sql)),
  ).toEqual([]);
  expect(plan.up).toContain(
    'ALTER TABLE "members" RENAME CONSTRAINT "users_pkey" TO "members_pkey"',
  );
  expect(plan.up).toContain(
    'ALTER TABLE "members" RENAME CONSTRAINT "users_name_key" TO "members_display_name_key"',
  );
  expect(plan.down).toContain(
    'ALTER TABLE "users" RENAME CONSTRAINT "members_display_name_key" TO "users_name_key"',
  );
  expect(() =>
    diffSchemas(before.$snapshot(), after.$snapshot(), {
      renames: { tables: { typo: "members" } },
    }),
  ).toThrow(/invalid table rename/);
});

test("only definitions and keys that use changed columns are rebuilt", () => {
  const version = (renamed: boolean, wide: boolean) =>
    schema({
      accounts: table({
        id: int.auto,
        code: text.unique,
        ...(renamed ? { displayName: text } : { name: text }),
        score: wide ? bigint : int,
        slug: text,
      })
        .indexes((accounts) => ({
          bySlug: index(accounts.slug).unique,
          byScore: index(accounts.score),
        }))
        .checks((accounts) => ({
          slugShape: accounts.slug.isNot(""),
          positive: accounts.score.above(0),
        })),
    }).$snapshot();

  const plan = diffSchemas(version(false, false), version(true, true), {
    renames: { columns: { accounts: { name: "display_name" } } },
  });
  const rebuilds = plan.up.filter((sql) => /INDEX|CONSTRAINT/.test(sql));
  expect(rebuilds).toEqual([
    'DROP INDEX "accounts_by_score_idx"',
    'ALTER TABLE "accounts" DROP CONSTRAINT "accounts_positive_check"',
    'ALTER TABLE "accounts" ADD CONSTRAINT "accounts_positive_check" CHECK ("score" > E\'0\')',
    'CREATE INDEX "accounts_by_score_idx" ON "accounts" USING btree ("score")',
  ]);
});

test("column type conversions, defaults, nullability and indexes are reversible", () => {
  const before = schema(
    { records: { id: int.auto, value: text.nullable } },
    { indexes: ({ records }) => ({ byValue: index(records.value) }) },
  );
  const after = schema(
    { records: { id: int.auto, value: int.default(0), label: text.nullable } },
    {
      indexes: ({ records }) => ({ byValue: index(records.value.descending) }),
    },
  );
  const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
    using: {
      records: {
        value: {
          up: "COALESCE(\"value\", '0')::integer",
          down: '"value"::text',
        },
      },
    },
  });
  expect(plan.up).toContain(
    'ALTER TABLE "records" ALTER COLUMN "value" TYPE integer USING COALESCE("value", \'0\')::integer',
  );
  expect(plan.up).toContain(
    'ALTER TABLE "records" ALTER COLUMN "value" SET NOT NULL',
  );
  expect(plan.up).toContain(
    'ALTER TABLE "records" ALTER COLUMN "value" SET DEFAULT 0',
  );
  expect(plan.down).toContain('ALTER TABLE "records" DROP COLUMN "label"');
  expect(plan.up[0]).toBe('DROP INDEX "by_value"');
  expect(plan.up.at(-1)).toContain('("value" DESC)');
});

test("enum changes rebuild the type and dependent indexes instead of ADD VALUE inside a transaction", () => {
  const before = schema(
    {
      records: {
        id: int,
        status: oneOf("draft", "published").default("draft"),
      },
    },
    { indexes: ({ records }) => ({ byStatus: index(records.status) }) },
  );
  const after = schema(
    {
      records: {
        id: int,
        status: oneOf("draft", "published", "archived").default("archived"),
      },
    },
    { indexes: ({ records }) => ({ byStatus: index(records.status) }) },
  );
  const plan = diffSchemas(before.$snapshot(), after.$snapshot());
  expect(
    plan.up.some((sql) =>
      sql.startsWith('ALTER TYPE "records_status_enum" RENAME TO'),
    ),
  ).toBe(true);
  expect(plan.up).toContain(
    'ALTER TABLE "records" ALTER COLUMN "status" TYPE "records_status_enum" USING "status"::text::"records_status_enum"',
  );
  expect(plan.up).toContain(
    'ALTER TABLE "records" ALTER COLUMN "status" SET DEFAULT E\'archived\'',
  );
  expect(plan.up.at(-1)).toStartWith(
    'DROP TYPE "records_status_enum_previous_',
  );
});

test("an enum value nothing in the migration uses is appended with ADD VALUE, even transactionally", () => {
  const before = schema({
    records: {
      id: int,
      status: oneOf("draft", "published").default("draft"),
    },
  });
  const after = schema({
    records: {
      id: int,
      status: oneOf("draft", "archived", "published").default("draft"),
    },
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot());
  expect(plan.up).toEqual([
    "ALTER TYPE \"records_status_enum\" ADD VALUE E'archived' BEFORE E'published'",
  ]);
  // Removing it again needs the rewrite.
  expect(
    plan.down.some((sql) =>
      sql.startsWith('ALTER TYPE "records_status_enum" RENAME TO'),
    ),
  ).toBe(true);
});

test("generated object names respect PostgreSQL's byte limit and reject collisions", () => {
  const name = objectName("я".repeat(30), "long_column_name", "fkey");
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  expect(name).toBe(objectName("я".repeat(30), "long_column_name", "fkey"));
  const invalid = schema({ records: { id: int } }).$snapshot();
  invalid.tables.push(structuredClone(invalid.tables[0]!));
  expect(() => migrationSnapshot(invalid)).toThrow(/duplicate/);
});

test("SQL splitting preserves escaped strings, quoted identifiers, nested comments and dollar bodies", () => {
  const script = `-- header ;\nCREATE TABLE "semi;colon" (value text DEFAULT E'a\\';b');
/* outer ; /* inner ; */ still outer */
DO $body$ BEGIN PERFORM 'a;b'; PERFORM 2; END $body$;
SELECT 'one'';two', 'backslash\\', $$three;four$$; -- tail
`;
  const statements = splitMigrationSQL(script);
  expect(statements).toHaveLength(3);
  expect(statements[1]).toContain("PERFORM 'a;b'; PERFORM 2;");
  expect(statements[2]).toContain("$$three;four$$");
  expect(splitMigrationSQL("-- comments only\n/* ; */")).toEqual([]);
  expect(() => splitMigrationSQL("/* comment */ COMMIT;")).toThrow(
    /transaction boundaries/,
  );
  expect(() => splitMigrationSQL("SELECT 'unterminated")).toThrow(
    /unterminated/,
  );
  expect(() => splitMigrationSQL("DO $$unterminated")).toThrow(/unterminated/);
});

test("lintMigration flags destructive, blocking and cautionary changes with advice", () => {
  const before = schema({
    users: { id: int.auto, email: text, nickname: text.nullable, age: int },
    posts: { id: int.auto, title: text },
    legacy: { id: int.auto },
    records: {
      id: int.auto,
      state: oneOf("draft", "published", "archived"),
    },
  });
  const after = schema({
    users: table({
      id: int.auto,
      email: text.unique,
      nickname: text,
      age: bigint,
      score: int,
      slug: text.unique.default("x"),
    }).indexes((users) => ({ byAge: index(users.age) })),
    articles: { id: int.auto, title: text },
    records: { id: int.auto, state: oneOf("draft", "published") },
  });
  const renames = { tables: { posts: "articles" } };
  const findings = lintMigration(
    diffSchemas(before.$snapshot(), after.$snapshot(), { renames }),
    renames,
  );
  const summary = findings.map(
    (finding) =>
      `${finding.level} ${finding.table}${finding.column ? `.${finding.column}` : ""}`,
  );
  expect(summary).toEqual([
    "destructive legacy",
    "blocking records_state_enum",
    "blocking users.email",
    "blocking users.nickname",
    "blocking users.score",
    "caution articles",
    "caution users.age",
    "caution users.slug",
    "caution users",
  ]);
  expect(
    findings.find((finding) => finding.table === "legacy")?.advice,
  ).toMatch(/later migration/);
  expect(formatLintFindings(findings)).toContain("DESTRUCTIVE legacy");
  expect(formatLintFindings([])).toBe("No risky operations found.");
  expect(
    lintMigration(diffSchemas(before.$snapshot(), before.$snapshot())),
  ).toEqual([]);
});

test("normalizeSqlType resolves PostgreSQL aliases for drift comparison", () => {
  expect(normalizeSqlType("timestamptz")).toBe("timestamp with time zone");
  expect(normalizeSqlType("timestamptz[]")).toBe("timestamp with time zone[]");
  expect(normalizeSqlType("varchar(40)[]")).toBe("character varying(40)[]");
  // Custom types may spell modifiers with spaces; format_type() never does.
  expect(normalizeSqlType("numeric(12, 2)")).toBe("numeric(12,2)");
  expect(normalizeSqlType("Numeric( 12 , 2 )[]")).toBe("numeric(12,2)[]");
  expect(normalizeSqlType("int4[][]")).toBe("integer[][]");
  expect(normalizeSqlType("int")).toBe("integer");
  expect(normalizeSqlType("varchar(255)")).toBe("character varying(255)");
  expect(normalizeSqlType("numeric(20,2)")).toBe("numeric(20,2)");
  expect(normalizeSqlType("my_schema.post_state")).toBe("post_state");
  expect(normalizeSqlType("Timestamp With Time Zone")).toBe(
    "timestamp with time zone",
  );
});

test("a renamed table keeps its indexes and checks under their new names", () => {
  const version = (name: "categories" | "topics") =>
    schema({
      [name]: table({ id: int.auto, slug: text, rank: int })
        .indexes((rows) => ({ bySlug: index(rows.slug).unique }))
        .checks((rows) => ({ positive: rows.rank.above(0) })),
    });

  const plan = diffSchemas(
    version("categories").$snapshot(),
    version("topics").$snapshot(),
    { renames: { tables: { categories: "topics" } } },
  );
  expect(plan.up).toEqual([
    'ALTER TABLE "categories" RENAME TO "topics"',
    'ALTER TABLE "topics" RENAME CONSTRAINT "categories_pkey" TO "topics_pkey"',
    'ALTER TABLE "topics" RENAME CONSTRAINT "categories_positive_check" TO "topics_positive_check"',
    'ALTER INDEX "categories_by_slug_idx" RENAME TO "topics_by_slug_idx"',
  ]);
  expect(plan.down).toEqual([
    'ALTER TABLE "topics" RENAME TO "categories"',
    'ALTER TABLE "categories" RENAME CONSTRAINT "topics_pkey" TO "categories_pkey"',
    'ALTER TABLE "categories" RENAME CONSTRAINT "topics_positive_check" TO "categories_positive_check"',
    'ALTER INDEX "topics_by_slug_idx" RENAME TO "categories_by_slug_idx"',
  ]);
});

test("a NOT NULL column without a default is added in two steps around a backfill marker", () => {
  const before = schema({ comments: { id: int.auto, body: text } });
  const after = schema({
    comments: {
      id: int.auto,
      body: text,
      authorId: int,
      score: int.default(0),
    },
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot());
  expect(plan.up).toEqual([
    'ALTER TABLE "comments" ADD COLUMN "author_id" integer',
    '-- Backfill "comments"."author_id" for existing rows before this statement.\nALTER TABLE "comments" ALTER COLUMN "author_id" SET NOT NULL',
    'ALTER TABLE "comments" ADD COLUMN "score" integer DEFAULT 0 NOT NULL',
  ]);
  expect(plan.down).toEqual([
    'ALTER TABLE "comments" DROP COLUMN "author_id"',
    'ALTER TABLE "comments" DROP COLUMN "score"',
  ]);
});
