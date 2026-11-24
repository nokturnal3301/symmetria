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
  timestamp,
  oneOf,
  index,
  customType,
  operatorClass,
  bool,
  sql,
  varchar,
  numeric,
  interval,
  date,
  time,
  inet,
  bytea,
  smallint,
  real,
  doublePrecision,
  type Column,
} from "../../../packages/runtime/src";
import { vector, halfvec } from "../../../packages/runtime/src/entries/vector";
import {
  migrationSnapshot,
  parseMigrationSnapshot,
  snapshotHash,
  emptySnapshot,
  diffSchemas,
  createSchemaSQL,
  lintMigration,
  lintMigrationSQL,
  formatLintFindings,
  normalizeSqlType,
} from "../../../packages/kit/src";
import {
  formatMigrationSQL,
  parseMigrationSQL,
  splitMigrationSQL,
} from "../../../packages/kit/src/migrations/sql";
import {
  expressionKey,
  readExpression,
} from "../../../packages/kit/src/migrations/expressions";
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
  // Dropping a type no column uses loses no data, and the saved SQL says so.
  expect(diffSchemas(model.$snapshot(), emptySnapshot()).up.at(-1)).toBe(
    '-- symmetria: caution: type "users_status_enum" is no longer used; dropping it loses no data.\nDROP TYPE "users_status_enum"',
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
  expect(plan.up.at(-1)).toMatch(
    /^-- symmetria: caution: type "records_status_enum_previous_\w+" held the previous labels of "records_status_enum" and is no longer used; dropping it loses no data\.\nDROP TYPE "records_status_enum_previous_/,
  );
  // lint of the saved file rates the drop of the old type as generate does.
  expect(
    lintMigrationSQL(plan.up.map((sql) => `${sql};`).join("\n")).filter(
      (finding) => finding.level !== "caution",
    ),
  ).toEqual([]);
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
  // A carriage return ends a comment, as in PostgreSQL: what follows is SQL,
  // and lint sees it.
  expect(splitMigrationSQL("-- note\rDROP TABLE victim; SELECT 1;")).toEqual([
    "-- note\rDROP TABLE victim",
    "SELECT 1",
  ]);
  expect(lintMigrationSQL("-- note\rDROP TABLE victim;")).toEqual([
    expect.objectContaining({ level: "destructive", statement: 1 }),
  ]);
});

test("names and labels with line breaks stay inside the comments of generated SQL and on their line of the review", () => {
  // Each name would drop the table if it ended its comment.
  const drop = (name: string) => `${name}\nDROP TABLE victim; --`;
  const before = schema({
    victim: table({ id: int.auto }),
    items: table({
      id: int.auto,
      a: text,
      mood: oneOf("kept", drop("gone")).nullable,
      score: int.named("s\u2028DROP TABLE victim; --"),
    }).indexes((t) => ({ [drop("old")]: index(t.a) })),
  });
  const after = schema({
    victim: table({ id: int.auto }),
    items: table({
      id: int.auto,
      a: text,
      mood: oneOf("kept").nullable,
      score: smallint.named("s\u2028DROP TABLE victim; --"),
      added: int.named("n\rDROP TABLE victim; --"),
    }),
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot());
  const statements = parseMigrationSQL(formatMigrationSQL(plan.up));
  const comments = plan.up.flatMap((statement) =>
    statement.split("\n").filter((line) => line.startsWith("--")),
  );

  // The names reach the comments of the drop, the label removal, the
  // narrowing and the backfill, escaped; no DROP TABLE is SQL.
  expect(comments).toEqual([
    `-- symmetria: caution: index "items_old\\ndrop table victim; --_idx" is no longer declared; dropping it loses no data, but queries that used it can get slower.`,
    `-- symmetria: destructive: Enum "items_mood_enum" drops 'gone\\nDROP TABLE victim; --'; rows using those labels make the rebuild fail.`,
    `-- Backfill "items"."n\\rDROP TABLE victim; --" for existing rows before this statement.`,
    expect.stringMatching(
      /^-- symmetria: destructive: Column "s\\u2028DROP TABLE victim; --" narrows from integer to smallint/,
    ),
    expect.stringMatching(
      /^-- symmetria: caution: type "items_mood_enum_previous_/,
    ),
  ]);
  expect(statements).toHaveLength(plan.up.length);
  expect(
    statements.filter((statement) => statement.words[0] === "DROP"),
  ).toEqual([
    expect.objectContaining({ words: ["DROP", "INDEX"] }),
    expect.objectContaining({ words: ["DROP", "TYPE"] }),
  ]);

  // The review generate and lint print: one line per finding, one for its advice.
  const review = formatLintFindings(lintMigration(plan));

  expect(review).not.toMatch(/[\r\u2028\u2029]/);
  expect(
    review
      .split("\n")
      .every((line) => /^(DESTRUCTIVE|BLOCKING|CAUTION) | {12}\S/.test(line)),
  ).toBe(true);
  expect(review).toContain("drops 'gone\\nDROP TABLE victim; --'");
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
    "destructive records_state_enum",
    "blocking users.email",
    "blocking users.nickname",
    "blocking users.score",
    // Every existing row gets the same default, so the UNIQUE key fails.
    "blocking users.slug",
    "caution users.age",
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

test("lintMigration follows renames into indexes and checks like the diff does", () => {
  const version = (
    name: "posts" | "articles",
    column: "views" | "hits",
    extra: boolean,
  ) =>
    schema({
      [name]: table({ id: int.auto, slug: text, [column]: int })
        .checks((posts) => ({
          positive: sql<boolean>`${posts[column]!} >= 0`,
          ...(extra ? { small: sql<boolean>`${posts[column]!} < 100` } : {}),
        }))
        .indexes((posts) => ({
          slug: index(posts.slug!).unique,
          popular: index(posts[column]!),
          ...(extra ? { both: index(posts.slug!, posts[column]!) } : {}),
        })),
    }).$snapshot();
  const lint = (
    after: ReturnType<typeof version>,
    renames: NonNullable<Parameters<typeof lintMigration>[1]>,
  ) => {
    const plan = diffSchemas(version("posts", "views", false), after, {
      renames,
    });

    return {
      up: plan.up,
      findings: lintMigration(plan, renames).map(
        (finding) => `${finding.level}: ${finding.message}`,
      ),
    };
  };

  // A table rename changes the derived index and check names only.
  const table_ = lint(version("articles", "views", false), {
    tables: { posts: "articles" },
  });
  expect(table_.up.join("\n")).not.toMatch(/CREATE|ADD CONSTRAINT/);
  expect(table_.findings).toEqual([]);

  // A column rename is followed into index keys and check expressions.
  const column = lint(version("posts", "hits", false), {
    columns: { posts: { views: "hits" } },
  });
  expect(column.up.join("\n")).not.toMatch(/CREATE|ADD CONSTRAINT/);
  expect(column.findings).toEqual([]);

  // What is really new next to the renames is still reported.
  const added = lint(version("articles", "hits", true), {
    tables: { posts: "articles" },
    columns: { articles: { views: "hits" } },
  });
  expect(added.findings).toEqual([
    'blocking: CHECK constraint "articles_small_check" is added; the statement fails when an existing row violates it.',
    'caution: Index "articles_both_idx" is created inside the migration transaction and blocks writes while it builds.',
  ]);

  // The same check written the way PostgreSQL prints it is no new check.
  const rendered = migrationSnapshot(version("posts", "views", false));
  expect(
    lintMigration(
      diffSchemas(version("posts", "views", false), {
        ...rendered,
        tables: rendered.tables.map((entry) => ({
          ...entry,
          checks: (entry.checks ?? []).map((check) => ({
            ...check,
            expression: "(views >= 0)",
          })),
        })),
      }),
    ),
  ).toEqual([]);
});

test("normalizeSqlType resolves PostgreSQL aliases for drift comparison", () => {
  expect(normalizeSqlType("timestamptz")).toBe("timestamp with time zone");
  expect(normalizeSqlType("timestamptz[]")).toBe("timestamp with time zone[]");
  expect(normalizeSqlType("varchar(40)[]")).toBe("character varying(40)[]");
  // The spellings PostgreSQL prints back differently.
  expect(normalizeSqlType("char(5)")).toBe("character(5)");
  expect(normalizeSqlType("decimal(8, 2)")).toBe("numeric(8,2)");
  expect(normalizeSqlType("dec(8,2)[]")).toBe("numeric(8,2)[]");
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

test("extensions, operator classes and storage options round-trip through snapshots and DDL", () => {
  const documents = table({
    id: int.auto,
    embedding: vector(3),
  }).indexes((documents) => ({
    embedding: index(operatorClass(documents.embedding, "vector_cosine_ops"))
      .using("hnsw")
      .with({ m: 16, ef_construction: 64 }),
  }));
  const model = schema({ documents }, { extensions: ["vector"] });
  const snapshot = migrationSnapshot(model.$snapshot());
  const roundTrip = parseMigrationSnapshot(
    JSON.parse(JSON.stringify(snapshot)),
  );

  expect(roundTrip).toEqual(snapshot);
  expect(snapshot.extensions).toEqual(["vector"]);
  expect(snapshot.tables[0]!.indexes[0]).toMatchObject({
    method: "hnsw",
    opclasses: ["vector_cosine_ops"],
    with: { ef_construction: 64, m: 16 },
  });

  // Schemas without the new features serialize exactly as before.
  const plain = migrationSnapshot(
    schema({ rows: { id: int, name: text } }).$snapshot(),
  );
  const serialized = JSON.stringify(plain);
  expect(serialized).not.toContain("opclasses");
  expect(serialized).not.toContain('"with"');
  expect(serialized).not.toContain("extensions");
  expect(snapshotHash(plain)).toBe(
    snapshotHash(parseMigrationSnapshot(JSON.parse(serialized))),
  );

  const statements = createSchemaSQL(model.$snapshot()).map(
    (entry) => entry.sql,
  );
  expect(statements[0]).toBe('CREATE EXTENSION IF NOT EXISTS "vector"');
  expect(statements.at(-1)).toBe(
    `CREATE INDEX "documents_embedding_idx" ON "documents" USING hnsw ("embedding" vector_cosine_ops) WITH (ef_construction = 64, m = 16)`,
  );

  const withoutExtension = schema({ documents }).$snapshot();
  const removal = diffSchemas(model.$snapshot(), withoutExtension);
  expect(removal.up).toEqual([
    '-- extension "vector" is kept; drop it manually once nothing else uses it',
  ]);
  expect(removal.down).toEqual(['CREATE EXTENSION IF NOT EXISTS "vector"']);

  const retuned = schema(
    {
      documents: table({ id: int.auto, embedding: vector(3) }).indexes(
        (documents) => ({
          embedding: index(
            operatorClass(documents.embedding, "vector_cosine_ops"),
          )
            .using("hnsw")
            .with({ m: 32, ef_construction: 64 }),
        }),
      ),
    },
    { extensions: ["vector"] },
  );
  expect(diffSchemas(model.$snapshot(), retuned.$snapshot()).up).toEqual([
    'DROP INDEX "documents_embedding_idx"',
    `CREATE INDEX "documents_embedding_idx" ON "documents" USING hnsw ("embedding" vector_cosine_ops) WITH (ef_construction = 64, m = 32)`,
  ]);

  const broken = JSON.parse(JSON.stringify(snapshot));
  broken.tables[0].indexes[0].opclasses = ["vector_cosine_ops", "extra"];
  expect(() => parseMigrationSnapshot(broken)).toThrow(
    /invalid migration snapshot/,
  );
  const badExtension = { ...snapshot, extensions: ["Vector"] };
  expect(() => parseMigrationSnapshot(badExtension)).toThrow(
    /invalid migration snapshot/,
  );
});

test("changing ON UPDATE recreates the foreign key; keeping it changes nothing", () => {
  const build = (cascade: boolean) => {
    const users = table({ id: int.auto });

    return schema({
      users,
      posts: table({
        id: int.auto,
        author: cascade ? users.onUpdate.cascade : users,
      }),
    }).$snapshot();
  };

  expect(diffSchemas(build(true), build(true)).up).toEqual([]);
  const changed = diffSchemas(build(false), build(true));
  // The key held with the same column and target, so adding it again cannot
  // fail; the saved SQL says so, and lint rates it as generate does.
  expect(changed.up).toEqual([
    'ALTER TABLE "posts" DROP CONSTRAINT "posts_author_id_fkey"',
    '-- symmetria: caution: the foreign key held with the same column and target; only its actions change, so existing rows still match.\nALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE',
  ]);
  expect(
    lintMigrationSQL(changed.up.map((sql) => `${sql};`).join("\n")).map(
      (finding) => finding.level,
    ),
  ).toEqual(["caution", "caution"]);
  expect(lintMigration(changed).map((finding) => finding.level)).toEqual([
    "caution",
  ]);
  // NO ACTION stays out of snapshots, so earlier snapshots compare unchanged.
  expect(
    migrationSnapshot(build(false))
      .tables.find((table) => table.name === "posts")!
      .columns.find((column) => column.name === "author_id")!.references,
  ).toEqual({ table: "users", column: "id", onDelete: "restrict" });
});

test("a named enum shared by several columns is one type that changes and renames in place", () => {
  const build = (name: string, labels: [string, ...string[]]) => {
    const role = oneOf(...labels).typeName(name);

    return schema({
      users: { id: int.auto, role: role.default("USER") },
      invites: { id: int.auto, role },
    }).$snapshot();
  };

  const created = createSchemaSQL(build("Role", ["USER", "ADMIN"])).map(
    (statement) => statement.sql,
  );
  expect(created.filter((sql) => sql.startsWith("CREATE TYPE"))).toEqual([
    "CREATE TYPE \"Role\" AS ENUM (E'USER', E'ADMIN')",
  ]);
  expect(
    migrationSnapshot(build("Role", ["USER", "ADMIN"])).enumerations,
  ).toEqual([{ name: "Role", values: ["USER", "ADMIN"] }]);

  // A label nothing in the migration uses is added in place.
  expect(
    diffSchemas(
      build("Role", ["USER", "ADMIN"]),
      build("Role", ["USER", "EDITOR", "ADMIN"]),
    ).up,
  ).toEqual(["ALTER TYPE \"Role\" ADD VALUE E'EDITOR' BEFORE E'ADMIN'"]);

  // Removing or reordering labels rebuilds the type once for both columns.
  const reordered = diffSchemas(
    build("Role", ["USER", "ADMIN"]),
    build("Role", ["ADMIN", "USER"]),
  ).up;
  expect(reordered.filter((sql) => sql.startsWith("CREATE TYPE"))).toEqual([
    "CREATE TYPE \"Role\" AS ENUM (E'ADMIN', E'USER')",
  ]);
  expect(reordered.filter((sql) => / TYPE "Role" USING /.test(sql))).toEqual([
    'ALTER TABLE "invites" ALTER COLUMN "role" TYPE "Role" USING "role"::text::"Role"',
    'ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING "role"::text::"Role"',
  ]);

  // A new name with the same labels and columns is a rename, not a rebuild.
  const renamed = diffSchemas(
    build("Role", ["USER", "ADMIN"]),
    build("UserRole", ["USER", "ADMIN"]),
  );
  expect(renamed.up).toEqual(['ALTER TYPE "Role" RENAME TO "UserRole"']);
  expect(renamed.down).toEqual(['ALTER TYPE "UserRole" RENAME TO "Role"']);
  // The rename rewrites nothing, so lint has nothing to report.
  expect(lintMigration(renamed)).toEqual([]);

  // A derived name follows its table.
  const version = (name: "accounts" | "members") =>
    schema({ [name]: { id: int.auto, state: oneOf("on", "off") } }).$snapshot();
  expect(
    diffSchemas(version("accounts"), version("members"), {
      renames: { tables: { accounts: "members" } },
    }).up,
  ).toContain(
    'ALTER TYPE "accounts_state_enum" RENAME TO "members_state_enum"',
  );

  // Two columns cannot share a derived name, and a named type needs one label list.
  expect(() =>
    migrationSnapshot({
      tables: [
        {
          name: "a",
          sqlName: "a",
          junction: false,
          relations: [],
          columns: [
            {
              name: "role",
              sqlName: "role",
              sqlType: "enum",
              notNull: true,
              unique: false,
              primaryKey: false,
              enumerationValues: ["x"],
              enumerationName: "Role",
            },
            {
              name: "kind",
              sqlName: "kind",
              sqlType: "enum",
              notNull: true,
              unique: false,
              primaryKey: false,
              enumerationValues: ["y"],
              enumerationName: "Role",
            },
          ],
        },
      ],
    }),
  ).toThrow(/enum type "Role" is declared with different labels/);
});

test("collations are part of the column type and change with ALTER COLUMN TYPE", () => {
  const build = (collation?: string) =>
    schema({
      codes: {
        id: int.auto,
        code: collation ? text.collate(collation).unique : text.unique,
      },
    }).$snapshot();

  expect(
    createSchemaSQL(build("C")).map((statement) => statement.sql)[0],
  ).toContain('"code" text COLLATE "C" NOT NULL');
  expect(diffSchemas(build("C"), build("C")).up).toEqual([]);

  const plan = diffSchemas(build(), build("C"));
  expect(plan.up).toContain(
    'ALTER TABLE "codes" ALTER COLUMN "code" TYPE text COLLATE "C" USING "code"::text COLLATE "C"',
  );
  expect(plan.down).toContain(
    'ALTER TABLE "codes" ALTER COLUMN "code" TYPE text USING "code"::text',
  );
  expect(
    migrationSnapshot(build("C")).tables[0]!.columns.find(
      (column) => column.name === "code",
    ),
  ).toMatchObject({ collation: "C" });
  // Snapshots without collations keep their hashes.
  expect(snapshotHash(migrationSnapshot(build()))).toBe(
    snapshotHash(parseMigrationSnapshot(migrationSnapshot(build()))),
  );
});

test("identity generation changes in place between ALWAYS and BY DEFAULT", () => {
  const build = (byDefault: boolean) =>
    schema({
      items: { id: byDefault ? int.auto.byDefault : int.auto, label: text },
    }).$snapshot();

  expect(
    createSchemaSQL(build(true)).map((statement) => statement.sql)[0],
  ).toContain('"id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL');
  expect(migrationSnapshot(build(true)).tables[0]!.columns[0]).toMatchObject({
    identity: true,
    identityByDefault: true,
  });
  expect(diffSchemas(build(false), build(true))).toMatchObject({
    up: ['ALTER TABLE "items" ALTER COLUMN "id" SET GENERATED BY DEFAULT'],
    down: ['ALTER TABLE "items" ALTER COLUMN "id" SET GENERATED ALWAYS'],
  });

  const plain = schema({ items: { id: int, label: text } }).$snapshot();
  expect(diffSchemas(plain, build(true)).up).toEqual([
    'ALTER TABLE "items" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY',
    'SELECT setval(pg_get_serial_sequence(E\'"items"\', E\'id\'), GREATEST(COALESCE(MAX("id"), 0), 0) + 1, false) FROM "items"',
  ]);
});

test("checks and partial indexes accept boolean expressions without = true", () => {
  const model = schema({
    products: table({
      id: int.auto,
      price: int,
      active: bool,
      deletedAt: timestamptz.nullable,
    })
      .checks((products) => ({
        positive: sql<boolean>`${products.price} > 0`,
        compared: sql<boolean>`${products.price} < 1000`.is(true),
      }))
      .indexes((products) => ({
        live: index(products.price).where(
          sql<boolean>`${products.deletedAt} IS NULL`,
        ),
        enabled: index(products.price).where(products.active),
      })),
  });
  const table_ = model.$snapshot().tables[0]!;

  expect(table_.checks).toEqual([
    {
      name: "positive",
      sqlName: "products_positive_check",
      expression: '"price" > 0',
    },
    {
      name: "compared",
      sqlName: "products_compared_check",
      expression: '("price" < 1000) = TRUE',
    },
  ]);
  expect(
    Object.fromEntries(
      table_.indexes!.map((entry) => [entry.name, entry.where]),
    ),
  ).toEqual({ live: '"deleted_at" IS NULL', enabled: '"active"' });
});

test("timestamptz and timestamp convert at UTC, not in the migrating session's time zone", () => {
  const build = (zoned: boolean) =>
    schema({
      events: { id: int.auto, at: zoned ? timestamptz : timestamp(3) },
    }).$snapshot();

  expect(diffSchemas(build(true), build(false))).toMatchObject({
    up: [
      // Rounding to milliseconds loses digits; the saved SQL says so for lint.
      `-- symmetria: destructive: Column "at" narrows from timestamptz to timestamp(3): fractional seconds are rounded to 3 digits.\nALTER TABLE "events" ALTER COLUMN "at" TYPE timestamp(3) USING "at" AT TIME ZONE 'UTC'`,
    ],
    down: [
      `ALTER TABLE "events" ALTER COLUMN "at" TYPE timestamptz USING "at" AT TIME ZONE 'UTC'`,
    ],
  });

  // An array has no AT TIME ZONE: the cast runs with the zone set to UTC.
  const arrays = (zoned: boolean) =>
    schema({
      events: { id: int.auto, at: zoned ? timestamptz.array : timestamp.array },
    }).$snapshot();

  expect(diffSchemas(arrays(true), arrays(false))).toMatchObject({
    up: [
      "SET TIME ZONE 'UTC'",
      'ALTER TABLE "events" ALTER COLUMN "at" TYPE timestamp[] USING "at"::timestamp[]',
      "RESET TIME ZONE",
    ],
    down: [
      "SET TIME ZONE 'UTC'",
      'ALTER TABLE "events" ALTER COLUMN "at" TYPE timestamptz[] USING "at"::timestamptz[]',
      "RESET TIME ZONE",
    ],
  });
});

test("expression keys ignore rendering and keep meaning", () => {
  const types = new Map([
    ["score", "integer"],
    ["label", "varchar(10)"],
    ["code", "text"],
    ["active", "boolean"],
  ]);
  const same = (left: string, right: string) =>
    expect(expressionKey(left, types)).toBe(expressionKey(right, types));
  const different = (left: string, right: string) =>
    expect(expressionKey(left, types)).not.toBe(expressionKey(right, types));

  same('"score" > -100', "(score > '-100'::integer)");
  same('"score" BETWEEN 1 AND 10', "((score >= 1) AND (score <= 10))");
  same('NOT ("score" BETWEEN 1 AND 10)', "((score < 1) OR (score > 10))");
  same(
    `"label" IN (E'a', E'b')`,
    "((label)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))",
  );
  same(`"label" NOT IN (E'a')`, "((label)::text <> 'a'::text)");
  same(`"code" LIKE E'a%'`, "(code ~~ 'a%'::text)");
  same(`NOT ("code" ILIKE E'%b')`, "(code !~~* '%b'::text)");
  same('"active" = TRUE', "active");
  same('"active" = FALSE', "(NOT active)");
  same('NOT ("label" IS NULL)', "(label IS NOT NULL)");
  same('0 < "score"', "(score > 0)");
  same(
    '("score" > 0 AND ("score" < 5 OR "code" <> E\'x\'))',
    "((score > 0) AND ((score < 5) OR (code <> 'x'::text)))",
  );
  same('length("label") > 0', "(length((label)::text) > 0)");
  same("/* note */ score   >  0 -- trailing", "score > 0");

  different('"score" > 0', '"score" >= 0');
  different(`"code" = E'007'`, `"code" = E'7'`);
  different(`"code" LIKE E'a%'`, `"code" ILIKE E'a%'`);
  different('"score" / 2 > 1', '"score"::numeric / 2 > 1');
  different(`"label" IN (E'a', E'b')`, `"label" IN (E'a', E'c')`);
  // A number and a string select different operators, and a date or JSON
  // type decides what the text means.
  different(`"doc" -> 0 IS NOT NULL`, `"doc" -> '0' IS NOT NULL`);
  different(
    `"at" > '2026-01-01 00:00:00+00'::timestamptz`,
    `"at" > '2026-01-01 00:00:00+00'::timestamp`,
  );
  different(
    `"doc" = '{"a":1}'::jsonb`,
    `"doc"::json::text = '{"a":1}'::json::text`,
  );
  // A cast to text of a column that is not text keeps its meaning, and so
  // does a real literal, which compares in single precision.
  different(`"score"::text = E'1'`, `"score" = E'1'`);
  different('"ratio" < 0.1::text::real', '"ratio" < 0.1');
  same('"ratio" < 0.1::text::real', "(ratio < ((0.1)::text)::real)");
  // A cast that changes the value is part of the expression: a length
  // truncates, an integer type rounds and a scale rounds too.
  different(`"code"::varchar(3) = E'abc'`, `"code" = E'abc'`);
  different(`"label"::varchar(3) = E'abc'`, `"label" = E'abc'`);
  different(`"code" = 'abc'::varchar(2)`, `"code" = 'abc'`);
  different(`"code" = 'abc'::char(2)`, `"code" = 'abc'`);
  different('"score" > 1.9::integer', '"score" > 1.9');
  different(`"score" > '1.9'::integer`, '"score" > 1.9');
  different('"score" > 1.25::numeric(3,1)', '"score" > 1.25');
  // The same casts over a value they leave alone are still rendering.
  same(`"code" = 'ab'::varchar(2)`, `"code" = 'ab'`);
  same('"score" > 1.50::numeric(3,1)', '"score" > 1.50');
  same('"score" > 2.0::integer', '"score" > 2.0');
  same(`"label"::varchar(10) = E'a'`, `"label" = E'a'`);
  // As PostgreSQL prints them back.
  same(
    `"code" = 'abc'::varchar(2)`,
    "(code = ('abc'::character varying(2))::text)",
  );
  same(`"code" = 'abc'::char(2)`, "(code = ('abc'::character(2))::text)");
  same(
    `"label"::varchar(3) = E'abc'`,
    "(((label)::character varying(3))::text = 'abc'::text)",
  );
  same('"ratio" > 1.25::numeric(3,1)', "(ratio > 1.25::numeric(3,1))");
  same('"score" > 1.9::integer', "(score > (1.9)::integer)");
  same(
    `"code"::varchar(3) = E'abc'`,
    "(((code)::character varying(3))::text = 'abc'::text)",
  );
  // SQL the parser does not model is compared as text.
  same("x SIMILAR TO 'a'", "x  SIMILAR TO 'a'");
  // There, a negative number and a bytea value read the same in the
  // spellings of 3.5.0 (`-5`, `'\x01'::bytea`) and 3.6.0 (`(-5)`, `E'\\x01'::bytea`).
  same(`"s"[1] > -5`, `"s"[1] > (-5)`);
  same(`"s"[1] - -5 > -1e+21`, `"s"[1] - (-5) > (-1e+21)`);
  same(`"s"[1]>-5`, `"s"[1]>(-5)`);
  same(`f("s"[1], -5) IN (-1)`, `f("s"[1], (-5)) IN ((-1))`);
  same(
    `ARRAY[-1] && "s" AND "s"[-1] BETWEEN -2 AND 0`,
    `ARRAY[(-1)] && "s" AND "s"[(-1)] BETWEEN (-2) AND 0`,
  );
  same(`"s"[1] >= -1::numeric(10,2)`, `"s"[1] >= (-1)::numeric(10,2)`);
  same(
    String.raw`"b" <> '\x0102'::bytea OR "s"[1] > 0`,
    String.raw`"b" <> E'\\x0102'::bytea OR "s"[1] > 0`,
  );
  // Elsewhere the parentheses mean something.
  different(`"s"[1]::text = -5::text`, `"s"[1]::text = (-5)::text`);
  different(`"s"[1] - -5 > 0`, `"s"[1]--5 > 0`);
  different(`"s"[1] @-5`, `"s"[1] @(-5)`);
  different(`g (-5) > "s"[1]`, `g -5 > "s"[1]`);
  different(`"s"[1] > '(-5)'`, `"s"[1] > '-5'`);
  different(`"s"[1] > $q$(-5)$q$`, `"s"[1] > $q$-5$q$`);
  different(
    String.raw`"b" <> E'\\x01'::text OR "s"[1] > 0`,
    String.raw`"b" <> '\x01'::text OR "s"[1] > 0`,
  );
  // A negative number cast through text to a number type, as a real[]
  // element compared with one and arithmetic on array elements write it.
  same(`"r"[1] > -0.5::text::real`, `"r"[1] > (-0.5)::text::real`);
  same(
    `("s"[1])::double precision + -1::text::double precision > 0`,
    `("s"[1])::double precision + (-1)::text::double precision > 0`,
  );
  same(
    `CASE "e" WHEN E'a' THEN -2147483647::text::integer END > "s"[1]`,
    `CASE "e" WHEN E'a' THEN (-2147483647)::text::integer END > "s"[1]`,
  );
  // Not where the minus and the casts give another value: text negated,
  // the sign of a float zero, a rounding to zero before a float, the most
  // negative integer.
  different(`"s"[1]::text <> -5::int::text`, `"s"[1]::text <> (-5)::int::text`);
  different(
    `"s"[1] > 0 OR "x" <> (-0::float8)::text`,
    `"s"[1] > 0 OR "x" <> ((-0)::float8)::text`,
  );
  different(`"r"[1] > -0::text::real`, `"r"[1] > (-0)::text::real`);
  different(`"r"[1] > -0.4::int::real`, `"r"[1] > (-0.4)::int::real`);
  different(`"s"[1] > -2147483648::int4`, `"s"[1] > (-2147483648)::int4`);
  different(
    `"s"[1] > -32768::text::smallint`,
    `"s"[1] > (-32768)::text::smallint`,
  );
  // The parser keeps these apart too.
  different(`"x" <> (-0::float8)::text`, `"x" <> ((-0)::float8)::text`);
  different(`"ratio" > -0::real`, `"ratio" > (-0)::real`);
  different(`"code" <> -5::text`, `"code" <> (-5)::text`);
  different(`"score" > -2147483648::int4`, `"score" > (-2147483648)::int4`);
  same(`"ratio" > -0.5::text::real`, `"ratio" > (-0.5)::text::real`);
  same(`"ratio" > -0::real`, `"ratio" > '-0'::real`);
  // Each cast of a chain keeps what it does to a literal: a number out of
  // an integer type's range or a numeric(p,s)'s digits fails, an exponent is
  // a number like any other, and a float rounds half to even where a
  // numeric rounds half away from zero (2.5::float8::integer is 2,
  // 2.5::integer is 3).
  different(
    `"score" > -32768::smallint::integer`,
    `"score" > (-32768)::smallint::integer`,
  );
  different(`"score" > 32768::smallint::integer`, `"score" > 32768::integer`);
  different(`"score" > 32768::smallint`, `"score" > 32768`);
  different(`"score" > 1e3::numeric(4,1)`, `"score" > 1e3`);
  different(`"score" > 2.5e0::integer`, `"score" > 2.5e0`);
  different(`"score" > 25e-1::smallint`, `"score" > 25e-1`);
  different(`"score" > 2.5::float8::integer`, `"score" > 2.5::integer`);
  different(`"score" > 2.5::real::integer`, `"score" > 2.5::integer`);
  different(`"score" > 0.1::real::float8`, `"score" > 0.1::float8`);
  same(`"score" > (-32768)::smallint::integer`, `"score" > -32768`);
  same(`"score" > 1.5e1::integer`, `"score" > 1.5e1`);
  same(`"score" > 2::float8::integer`, `"score" > 2`);
  same(
    `"score" > 2.5::numeric::float8::integer`,
    `"score" > 2.5::float8::integer`,
  );
  // As PostgreSQL prints them back; it drops a second cast to one type.
  same(
    `"score" > -32768::smallint::integer`,
    "(score > (- ((32768)::smallint)::integer))",
  );
  same(
    `"score" > 2.5::float8::integer`,
    "(score > ((2.5)::double precision)::integer)",
  );
  same(
    `"score" > 2147483647::real::bigint::bigint`,
    "(score > ((2147483647)::real)::bigint)",
  );
  same(
    `"score" > '2147483649'::numeric::numeric(3,0)::smallint`,
    "(score > ('2147483649'::numeric(3,0))::smallint)",
  );
});

test("checks, predicates and computed keys written either way need no migration", () => {
  const build = (raw: boolean) =>
    schema({
      items: table({
        id: int.auto,
        score: int,
        label: varchar(10).nullable,
        active: bool,
        state: oneOf("open", "closed"),
      })
        .checks((items) =>
          raw
            ? {
                score: sql<boolean>`(${items.score} > '-100'::integer)`,
                range: sql<boolean>`((${items.score} >= 1) AND (${items.score} <= 10))`,
                label: sql<boolean>`((${items.label})::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))`,
                active: sql<boolean>`(${items.active} = true)`,
              }
            : {
                score: items.score.above(-100),
                range: items.score.between(1, 10),
                label: items.label.in(["a", "b"]),
                active: items.active,
              },
        )
        .indexes((items) => ({
          live: index(items.score).where(
            raw
              ? sql<boolean>`${items.state} = 'open'::items_state_enum`
              : items.state.is("open"),
          ),
          next: index(
            (raw ? sql<number>`(${items.score} + 1)` : items.score.plus(1))
              .descending,
          ),
        })),
    });
  const dsl = migrationSnapshot(build(false).$snapshot());
  const raw = migrationSnapshot(build(true).$snapshot());

  expect(diffSchemas(dsl, raw)).toMatchObject({ up: [], down: [] });
  expect(diffSchemas(raw, dsl)).toMatchObject({ up: [], down: [] });

  // A real change is still a migration, in checks and in predicates.
  const changed = migrationSnapshot(
    schema({
      items: table({
        id: int.auto,
        score: int,
        label: varchar(10).nullable,
        active: bool,
        state: oneOf("open", "closed"),
      })
        .checks((items) => ({
          score: items.score.above(-99),
          range: items.score.between(1, 10),
          label: items.label.in(["a", "b"]),
          active: items.active,
        }))
        .indexes((items) => ({
          live: index(items.score).where(items.state.is("closed")),
          next: index(items.score.plus(1).descending),
        })),
    }).$snapshot(),
  );

  expect(diffSchemas(raw, changed).up).toEqual([
    'DROP INDEX "items_live_idx"',
    'ALTER TABLE "items" DROP CONSTRAINT "items_score_check"',
    'ALTER TABLE "items" ADD CONSTRAINT "items_score_check" CHECK ("score" > (-99))',
    `CREATE INDEX "items_live_idx" ON "items" USING btree ("score") WHERE "state" = E'closed'`,
  ]);
});

test("a minus before a cast that changes the number is the cast of the negated number where PostgreSQL gives both one value", () => {
  const types = new Map([
    ["f", "double precision"],
    ["x", "real"],
    ["n", "integer"],
  ]);
  const same = (left: string, right: string) =>
    expect(expressionKey(left, types)).toBe(expressionKey(right, types));
  const different = (left: string, right: string) =>
    expect(expressionKey(left, types)).not.toBe(expressionKey(right, types));

  // PostgreSQL reads `-0.5::integer` (3.5.0's spelling) as `-(0.5::integer)`,
  // -1 like `(-0.5)::integer`: an integer, numeric or float rounds the same
  // on either side of zero.
  for (const [number, casts] of [
    ["0.5", "::integer"],
    ["0.25", "::real::float8"],
    ["5", "::real::float8"],
    ["1.5", "::smallint"],
    ["2.5", "::float8::integer"],
    ["0.81743454", "::text::numeric(5,2)"],
    ["2147483520", "::real::integer"],
    ["1e2", "::float8::bigint"],
    ["0.0", "::bigint"],
  ]) {
    same(`"f" > -${number}${casts}`, `"f" > (-${number})${casts}`);
    // SQL the parser does not model (a subscript) is compared as text.
    same(`"s"[1] > -${number}${casts}`, `"s"[1] > (-${number})${casts}`);
  }

  same(`("f" + -0.1::real::float8)`, `("f" + (-0.1)::real::float8)`);

  // Not where the positive number reaches an integer type's most negative
  // value on the way, which PostgreSQL refuses, nor where a float comes out
  // zero, whose sign only the minus outside the casts keeps.
  for (const [number, casts] of [
    ["32767.5", "::smallint"],
    ["2147483647", "::real::integer"],
    ["2147483647.5", "::float8::integer"],
    ["9223372036854775807", "::float8::bigint"],
    ["1e-7", "::integer::float8"],
    ["0.5", "::real::integer::float8"],
    ["0.04", "::numeric(2,1)::float8"],
    ["0", "::real::float8"],
    ["1", "::numeric(2,-3)::float8"],
  ]) {
    different(`"f" > -${number}${casts}`, `"f" > (-${number})${casts}`);
    different(`"s"[1] > -${number}${casts}`, `"s"[1] > (-${number})${casts}`);
  }
});

test("checks and indexes 3.5.0 saved with a minus before a value-changing cast need no migration", () => {
  const current = migrationSnapshot(
    schema({
      items: table({ id: int.auto, n: int, f: doublePrecision, x: real })
        .checks((t) => ({
          a: sql<boolean>`${t.f} > ${-0.5}::integer`,
          b: sql<boolean>`${t.x} <> ${-0.25}::real::float8`,
          c: sql<boolean>`${t.n} <> ${-5}::real::float8`,
          refused: sql<boolean>`${t.n} > ${-32767.5}::smallint`,
        }))
        .indexes((t) => ({
          p: index(t.n).where(sql<boolean>`${t.f} > ${-1.5}::smallint`),
          e: index(sql<number>`(${t.f} + ${-0.1}::real::float8)`),
        })),
    }).$snapshot(),
  );
  // 3.5.0 wrote the numbers without parentheses.
  const saved = parseMigrationSnapshot(
    JSON.parse(
      JSON.stringify(current).replace(/\((-\d[\d.]*)\)/g, "$1"),
    ) as typeof current,
  );

  expect(saved.tables[0]!.checks!.map((check) => check.expression)).toEqual([
    '"f" > -0.5::integer',
    '"x" <> -0.25::real::float8',
    '"n" <> -5::real::float8',
    '"n" > -32767.5::smallint',
  ]);
  // Only the check PostgreSQL refused in 3.5.0's spelling is written again.
  expect(diffSchemas(saved, current).up).toEqual([
    'ALTER TABLE "items" DROP CONSTRAINT "items_refused_check"',
    'ALTER TABLE "items" ADD CONSTRAINT "items_refused_check" CHECK ("n" > (-32767.5)::smallint)',
  ]);
});

test("a default or index predicate 3.5.0 saved ending in a -- comment needs no migration, and SQL restoring it ends the comment", () => {
  const current = migrationSnapshot(
    schema({
      items: table({
        id: int.auto,
        n: int.default(sql`1 -- one`).nullable,
        m: int.nullable,
      }).indexes((t) => ({
        m: index(t.m).where(sql<boolean>`${t.m} > 0 -- positive`),
      })),
    }).$snapshot(),
  );
  // 3.5.0 saved them without the line break after the comment.
  const saved = parseMigrationSnapshot(
    JSON.parse(JSON.stringify(current).replaceAll("\\n", "")) as typeof current,
  );

  expect(saved.tables[0]!.columns[1]!.default).toBe("1 -- one");
  expect(saved.tables[0]!.indexes[0]!.where).toBe('"m" > 0 -- positive');
  expect(diffSchemas(saved, current)).toMatchObject({ up: [], down: [] });

  // A later migration that changes both restores them on the way down, each
  // statement apart: the comment does not take in the semicolon after it.
  const later = migrationSnapshot(
    schema({
      items: table({
        id: int.auto,
        n: int.default(2).nullable,
        m: int.nullable,
      }),
    }).$snapshot(),
  );
  const plan = diffSchemas(saved, later);
  const down = splitMigrationSQL(formatMigrationSQL(plan.down));

  expect(plan.before.tables[0]!.columns[1]!.default).toBe("1 -- one");
  expect(down).toHaveLength(plan.down.length);
  expect(down).toContain(
    'ALTER TABLE "items" ALTER COLUMN "n" SET DEFAULT 1 -- one',
  );
  expect(down).toContain(
    'CREATE INDEX "items_m_idx" ON "items" USING btree ("m") WHERE "m" > 0 -- positive',
  );
});

test("a type change PostgreSQL has no cast for asks for the conversion", () => {
  const number = schema({
    items: table({ id: int.auto, value: int }),
  }).$snapshot();
  const identifier = schema({
    items: table({ id: int.auto, value: uuid }),
  }).$snapshot();
  const list = schema({
    items: table({ id: int.auto, value: int.array }),
  }).$snapshot();
  const words = schema({
    items: table({ id: int.auto, value: text }),
  }).$snapshot();

  expect(() => diffSchemas(number, identifier)).toThrow(
    'PostgreSQL has no cast from integer to uuid for "items"."value"',
  );
  expect(() => diffSchemas(number, list)).toThrow(
    "PostgreSQL has no cast from integer to integer[]",
  );
  // Text reads as any type, and a supplied conversion is used as written.
  expect(diffSchemas(words, identifier).up).toEqual([
    'ALTER TABLE "items" ALTER COLUMN "value" TYPE uuid USING "value"::uuid',
  ]);
  expect(
    diffSchemas(number, identifier, {
      using: {
        items: { value: { up: "gen_random_uuid()", down: "0" } },
      },
    }).up,
  ).toEqual([
    'ALTER TABLE "items" ALTER COLUMN "value" TYPE uuid USING gen_random_uuid()',
  ]);
});

test("an SQL default longer than one value is written in parentheses", () => {
  const model = schema({
    items: table({
      id: int.auto,
      code: text.default(sql`'a' COLLATE "C"`),
      ok: bool.default(sql`NOT false`),
      at: timestamp.default(sql`now() AT TIME ZONE 'UTC'`),
      created: timestamptz.default(sql`now()`),
      label: text.default(sql`'x'::text`),
    }),
  });
  const [create] = createSchemaSQL(model.$snapshot()).map(
    (statement) => statement.sql,
  );

  // Unparenthesized, COLLATE would collate the column itself and the
  // others would not parse.
  expect(create).toContain(`"code" text DEFAULT ('a' COLLATE "C") NOT NULL`);
  expect(create).toContain('"ok" boolean DEFAULT (NOT false) NOT NULL');
  expect(create).toContain(
    `"at" timestamp DEFAULT (now() AT TIME ZONE 'UTC') NOT NULL`,
  );
  expect(create).toContain('"created" timestamptz DEFAULT now() NOT NULL');
  expect(create).toContain(`"label" text DEFAULT 'x'::text NOT NULL`);
});

test("vector to halfvec is a caution that says what half precision does", () => {
  const embeddings = (column: ReturnType<typeof vector>) =>
    schema(
      { documents: table({ id: int.auto, embedding: column }) },
      { extensions: ["vector"] },
    ).$snapshot();
  const findings = lintMigration(
    diffSchemas(embeddings(vector(3)), embeddings(halfvec(3) as never)),
  );

  expect(findings.map((finding) => [finding.level, finding.message])).toEqual([
    [
      "caution",
      'Column "embedding" changes from vector(3) to halfvec(3): every stored number is rounded to half precision, about 3 significant digits, and a number beyond ±65504 makes the migration fail.',
    ],
  ]);
});

test("spellings PostgreSQL treats as one value are no migration", () => {
  const none = (
    before: { $snapshot(): Parameters<typeof diffSchemas>[0] },
    after: typeof before,
  ) =>
    expect(diffSchemas(before.$snapshot(), after.$snapshot()).up).toEqual([]);

  // numeric(6) is numeric(6,0).
  none(
    schema({ items: { id: int.auto, n: numeric(6) } }),
    schema({ items: { id: int.auto, n: numeric(6, 0) } }),
  );

  // An index's default ordering, and storage values as PostgreSQL keeps them.
  const names = table({ id: int.auto, name: text });

  none(
    schema({ items: names.indexes((t) => ({ byName: index(t.name) })) }),
    schema({
      items: names.indexes((t) => ({ byName: index(t.name.ascending) })),
    }),
  );
  none(
    schema({
      items: names.indexes((t) => ({ byName: index(t.name.descending) })),
    }),
    schema({
      items: names.indexes((t) => ({
        byName: index(t.name.descending.nullsFirst),
      })),
    }),
  );
  none(
    schema({
      items: names.indexes((t) => ({
        byName: index(t.name).with({ fillfactor: "50" }),
      })),
    }),
    schema({
      items: names.indexes((t) => ({
        byName: index(t.name).with({ fillfactor: 50 }),
      })),
    }),
  );

  // A quoted literal compared with a column has the column's type.
  const measured = table({ id: int.auto, n: numeric(10, 2), day: date });

  none(
    schema({ items: measured.checks((t) => ({ k: t.n.above("0") })) }),
    schema({
      items: measured.checks((t) => ({
        k: sql<boolean>`${t.n} > '0'::numeric`,
      })),
    }),
  );
  none(
    schema({
      items: measured.checks((t) => ({ k: t.day.above("1999-01-01") })),
    }),
    schema({
      items: measured.checks((t) => ({
        k: sql<boolean>`${t.day} > '1999-01-01'::date`,
      })),
    }),
  );

  // Value defaults in PostgreSQL's printed form, as pull writes them.
  none(
    schema({
      items: {
        id: int.auto,
        tags: text.array.default(["a b", "c"]),
        meta: jsonb<{ a: number }>().default({ a: 1 }),
        at: timestamptz.default(new Date("2026-01-01T00:00:00Z")),
        wait: interval.default("90 minutes"),
      },
    }),
    schema({
      items: {
        id: int.auto,
        tags: text.array.default(sql`'{"a b",c}'::text[]`),
        meta: jsonb<{ a: number }>().default(sql`'{"a": 1}'::jsonb`),
        at: timestamptz.default(
          sql`'2026-01-01 00:00:00+00'::timestamp with time zone`,
        ),
        wait: interval.default("01:30:00"),
      },
    }),
  );
  // A different value is still a change.
  expect(
    diffSchemas(
      schema({
        items: { id: int.auto, wait: interval.default("90 minutes") },
      }).$snapshot(),
      schema({
        items: { id: int.auto, wait: interval.default("2 hours") },
      }).$snapshot(),
    ).up,
  ).toEqual([`ALTER TABLE "items" ALTER COLUMN "wait" SET DEFAULT E'2 hours'`]);
});

test("an extension name may have a hyphen, as uuid-ossp does", () => {
  const model = schema(
    { items: { id: int.auto } },
    { extensions: ["uuid-ossp", "pg_trgm"] },
  );

  expect(model.$snapshot().extensions).toEqual(["pg_trgm", "uuid-ossp"]);
  expect(
    createSchemaSQL(model.$snapshot()).map((entry) => entry.sql),
  ).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  expect(() =>
    schema({ items: { id: int.auto } }, { extensions: ["Bad Name"] }),
  ).toThrow('extension names are lowercase identifiers such as "pg_trgm"');
});

test("tables and columns named like Object.prototype members are no change and follow rename hints", () => {
  const names = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "isPrototypeOf",
  ];
  const version = (extra: boolean) =>
    schema({
      a: table(
        Object.fromEntries([
          ["id", int.auto],
          ...names.map((name, position) => [
            `c${position}`,
            text.nullable.named(name),
          ]),
          ...(extra ? [["extra", text.nullable]] : []),
        ]),
      ).named("constructor"),
      b: table({ id: int.auto, n: int.nullable.named("valueOf") }).named(
        "__proto__",
      ),
    }).$snapshot();

  // Before: `{}["constructor"]` was a function, so every such table and
  // column looked renamed to nothing and was dropped and added again.
  expect(diffSchemas(version(false), version(false))).toMatchObject({
    up: [],
    down: [],
  });
  expect(diffSchemas(version(false), version(true)).up).toEqual([
    'ALTER TABLE "constructor" ADD COLUMN "extra" text',
  ]);
  expect(
    lintMigration(diffSchemas(version(false), version(true))).filter(
      (finding) => finding.level === "destructive",
    ),
  ).toEqual([]);

  // Hints keyed by such names, as a --diff file gives them (JSON keeps
  // `__proto__` as an own key).
  const renamed = schema({
    a: table({ id: int.auto, toString: text.nullable }).named("constructor"),
    b: table({ id: int.auto, n: bigint.nullable.named("toString") }).named(
      "valueOf",
    ),
  }).$snapshot();
  const original = schema({
    a: table({ id: int.auto, toString: text.nullable }).named("constructor"),
    b: table({ id: int.auto, n: int.nullable.named("__proto__") }).named(
      "__proto__",
    ),
  }).$snapshot();
  const options = JSON.parse(`{
    "renames": { "tables": { "__proto__": "valueOf" }, "columns": { "valueOf": { "__proto__": "toString" } } },
    "using": { "valueOf": { "toString": { "up": "\\"toString\\"::bigint", "down": "\\"toString\\"::integer" } } }
  }`);
  const plan = diffSchemas(original, renamed, options);

  expect(plan.up).toEqual([
    'ALTER TABLE "__proto__" RENAME TO "valueOf"',
    'ALTER TABLE "valueOf" RENAME COLUMN "__proto__" TO "toString"',
    'ALTER TABLE "valueOf" RENAME CONSTRAINT "__proto___pkey" TO "valueOf_pkey"',
    'ALTER TABLE "valueOf" ALTER COLUMN "toString" TYPE bigint USING "toString"::bigint',
  ]);
  expect(plan.down).toContain('ALTER TABLE "valueOf" RENAME TO "__proto__"');
  expect(
    plan.down.some((sql) =>
      sql.endsWith(
        'ALTER TABLE "__proto__" ALTER COLUMN "toString" TYPE integer USING "toString"::integer',
      ),
    ),
  ).toBe(true);
  expect(plan.down.at(-1)).toBe(
    'ALTER TABLE "__proto__" RENAME COLUMN "toString" TO "__proto__"',
  );
  expect(
    lintMigration(plan, options.renames).map((finding) => finding.level),
  ).toEqual(["caution"]);
});

test("date and time conversions where a time zone enters convert at UTC, up and down", () => {
  const timetz = customType<string>("timetz", {
    encode: (value) => value,
    decode: (value) => String(value),
  });
  const change = (from: Column, to: Column) =>
    diffSchemas(
      schema({ items: table({ id: int.auto, at: from }) }).$snapshot(),
      schema({ items: table({ id: int.auto, at: to }) }).$snapshot(),
    );
  const statement = (sql: readonly string[]) =>
    sql.map((entry) => entry.replace(/^-- symmetria: .*\n/, ""));

  // A plain cast reads the session's zone: the stored values would depend on
  // who runs the migration.
  const day = change(date, timestamptz);
  expect(statement(day.up)).toEqual([
    `ALTER TABLE "items" ALTER COLUMN "at" TYPE timestamptz USING "at"::timestamp AT TIME ZONE 'UTC'`,
  ]);
  expect(statement(day.down)).toEqual([
    `ALTER TABLE "items" ALTER COLUMN "at" TYPE date USING ("at" AT TIME ZONE 'UTC')::date`,
  ]);
  // A value to timetz takes the session's offset, and a string has no zone
  // of its own: the statement runs with the zone set to UTC.
  expect(change(time, timetz).up).toEqual([
    "SET TIME ZONE 'UTC'",
    'ALTER TABLE "items" ALTER COLUMN "at" TYPE timetz USING "at"::timetz',
    "RESET TIME ZONE",
  ]);
  const words = change(text, timestamptz);
  expect(words.up).toEqual([
    "SET TIME ZONE 'UTC'",
    'ALTER TABLE "items" ALTER COLUMN "at" TYPE timestamptz USING "at"::timestamptz',
    "RESET TIME ZONE",
  ]);
  expect(words.down).toEqual([
    "SET TIME ZONE 'UTC'",
    'ALTER TABLE "items" ALTER COLUMN "at" TYPE text USING "at"::text',
    "RESET TIME ZONE",
  ]);
  // Lint passes the zone statements.
  expect(
    lintMigrationSQL(words.up.map((sql) => `${sql};`).join("\n")).map(
      (finding) => finding.level,
    ),
  ).toEqual(["caution"]);
  // timestamp to date reads no zone.
  expect(statement(change(timestamp, date).up)).toEqual([
    'ALTER TABLE "items" ALTER COLUMN "at" TYPE date USING "at"::date',
  ]);
});

test("type changes between built-in types without a cast are refused, in either direction", () => {
  const change = (from: Column, to: Column) => () =>
    diffSchemas(
      schema({ items: table({ id: int.auto, value: from }) }).$snapshot(),
      schema({ items: table({ id: int.auto, value: to }) }).$snapshot(),
    );

  for (const [from, to, message] of [
    [int, date, "PostgreSQL has no cast from integer to date"],
    [bool, numeric(10, 2), "PostgreSQL has no cast from boolean to numeric"],
    [date, int, "PostgreSQL has no cast from date to integer"],
    [int, timestamptz, "PostgreSQL has no cast from integer to timestamptz"],
    [interval, int, "PostgreSQL has no cast from interval to integer"],
    // integer and bytea cast into each other from PostgreSQL 18 only.
    [int, bytea, "PostgreSQL has no cast from integer to bytea"],
  ] as const) {
    expect(change(from, to)).toThrow(message);
  }

  // up.sql runs, down.sql never could: the migration could not be rolled back.
  expect(change(jsonb(), int)).toThrow(
    'PostgreSQL has no cast from integer back to jsonb for "items"."value", so the migration could not be rolled back',
  );
  expect(change(timestamptz, time)).toThrow(
    "PostgreSQL has no cast from time back to timestamptz",
  );

  // Casts PostgreSQL has, element by element for arrays, and text both ways.
  for (const [from, to] of [
    [int, bool],
    [jsonb(), text],
    [text, date],
    [date, timestamp],
    [time, interval],
    [int.array, bigint.array],
    [text.array, uuid.array],
  ] as const) {
    expect(change(from, to)).not.toThrow();
  }

  // A conversion given for both directions is used.
  expect(
    diffSchemas(
      schema({ items: table({ id: int.auto, value: int }) }).$snapshot(),
      schema({ items: table({ id: int.auto, value: date }) }).$snapshot(),
      {
        using: {
          items: {
            value: {
              up: "date '2000-01-01' + \"value\"",
              down: "\"value\" - date '2000-01-01'",
            },
          },
        },
      },
    ).up,
  ).toEqual([
    `ALTER TABLE "items" ALTER COLUMN "value" TYPE date USING date '2000-01-01' + "value"`,
  ]);
});

test("numeric to an integer type narrows when its digits before the point can exceed the target", () => {
  const destructive = (from: Column, to: Column) =>
    lintMigration(
      diffSchemas(
        schema({ t: table({ id: int.auto, n: from }) }).$snapshot(),
        schema({ t: table({ id: int.auto, n: to }) }).$snapshot(),
      ),
    )
      .filter((finding) => finding.level === "destructive")
      .map((finding) => finding.message);

  expect(destructive(numeric(20, 0), int)).toEqual([
    'Column "n" narrows from numeric(20,0) to integer: values outside the integer range make the migration fail.',
  ]);
  expect(destructive(numeric(12, 2), int)).toEqual([
    'Column "n" narrows from numeric(12,2) to integer: values are rounded to whole numbers, and values outside the integer range make the migration fail.',
  ]);
  expect(destructive(numeric(10, 2), numeric(8, 2))).toEqual([
    'Column "n" narrows from numeric(10,2) to numeric(8,2): values with more than 6 digits before the decimal point make the migration fail.',
  ]);
  expect(destructive(int, numeric(9, 0))).toHaveLength(1);
  // Every value fits.
  expect(destructive(numeric(9, 0), int)).toEqual([]);
  expect(destructive(numeric(4, 0), smallint)).toEqual([]);
  expect(destructive(int, numeric(10, 0))).toEqual([]);
  expect(destructive(numeric(18, 0), bigint)).toEqual([]);
});

test("CHECK literals PostgreSQL stores in another spelling compare as the same", () => {
  const timetz = customType<string>("timetz", {
    encode: (value) => value,
    decode: (value) => String(value),
  });
  const version = (spelling: "dsl" | "stored") =>
    schema({
      t: table({
        id: int.auto,
        tm: time,
        tz: timetz,
        iv: interval,
        key: uuid,
        ip: inet,
      }).checks((t) =>
        spelling === "dsl"
          ? {
              late: t.tm.below("23:00"),
              zoned: t.tz.isNot("7:00+02"),
              long: t.iv.below("24 hours"),
              key: t.key.isNot("{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}"),
              host: t.ip.isNot("10.0.0.1/32"),
            }
          : {
              late: sql<boolean>`${t.tm} < '23:00:00'::time without time zone`,
              zoned: sql<boolean>`${t.tz} <> '07:00:00+02'::time with time zone`,
              long: sql<boolean>`${t.iv} < '24:00:00'::interval`,
              key: sql<boolean>`${t.key} <> 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid`,
              host: sql<boolean>`${t.ip} <> '10.0.0.1'::inet`,
            },
      ),
    }).$snapshot();

  expect(diffSchemas(version("dsl"), version("stored")).up).toEqual([]);
  // Another value is still a change.
  expect(
    diffSchemas(
      version("dsl"),
      schema({
        t: table({
          id: int.auto,
          tm: time,
          tz: timetz,
          iv: interval,
          key: uuid,
          ip: inet,
        }).checks((t) => ({
          late: t.tm.below("22:00"),
          zoned: t.tz.isNot("7:00+02"),
          long: t.iv.below("24 hours"),
          key: t.key.isNot("{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}"),
          host: t.ip.isNot("10.0.0.0/32"),
        })),
      }).$snapshot(),
    ).up,
  ).toHaveLength(4);
});

test("interval literals compare as PostgreSQL keeps them: months, days and time apart", () => {
  const check = (bound: string) =>
    schema({
      t: table({ id: int.auto, iv: interval }).checks((t) => ({
        short: t.iv.below(bound),
      })),
    }).$snapshot();
  const changes = (from: string, to: string) =>
    diffSchemas(check(from), check(to)).up.length;

  // One value, other spellings.
  expect(changes("24 hours", "24:00:00")).toBe(0);
  expect(changes("1440 minutes", "24:00:00")).toBe(0);
  expect(changes("1.5 days", "1 day 12:00:00")).toBe(0);
  expect(changes("1 year 2 mons", "14 mons")).toBe(0);
  // Another value: a day is not always 24 hours, a month not always 30 days.
  expect(changes("1 day", "24 hours")).toBe(2);
  expect(changes("1.5 days", "36 hours")).toBe(2);
  expect(changes("1 mon", "30 days")).toBe(2);
});

test("typed literals and IN lists compare the way PostgreSQL stores them", () => {
  const version = (spelling: "dsl" | "stored") =>
    schema({
      t: table({ id: int.auto, iv: interval, tm: time, ip: inet }).checks(
        (t) =>
          spelling === "dsl"
            ? {
                list: t.iv.in(["1440 minutes", "1 day"]),
                times: t.tm.in(["7:05"]),
                host: sql<boolean>`${t.ip} <> inet '10.0.0.01/32'`,
              }
            : {
                list: sql<boolean>`${t.iv} = ANY (ARRAY['24:00:00'::interval, '1 day'::interval])`,
                times: sql<boolean>`${t.tm} = '07:05:00'::time without time zone`,
                host: sql<boolean>`${t.ip} <> '10.0.0.1'::inet`,
              },
      ),
    }).$snapshot();

  expect(diffSchemas(version("dsl"), version("stored")).up).toEqual([]);
  // A different value in a list is still a change.
  expect(
    diffSchemas(
      version("dsl"),
      schema({
        t: table({ id: int.auto, iv: interval, tm: time, ip: inet }).checks(
          (t) => ({
            list: t.iv.in(["1440 minutes", "24 hours"]),
            times: t.tm.in(["7:05"]),
            host: sql<boolean>`${t.ip} <> inet '10.0.0.01/32'`,
          }),
        ),
      }).$snapshot(),
    ).up,
  ).toHaveLength(2);
});

test("pull renders a condition's literals as PostgreSQL stored them, not as their comparison key", () => {
  const node = readExpression(
    `(iv > '-1000 years'::interval) AND (at < '23:00:00'::time without time zone)`,
    new Map([
      ["iv", "interval"],
      ["at", "time"],
    ]),
  );

  expect(JSON.stringify(node)).toContain('"value":"-1000 years"');
  expect(JSON.stringify(node)).toContain('"value":"23:00:00"');
});

test("a USING conversion without one of its directions is refused with its name", () => {
  const before = schema({ items: table({ id: int.auto, v: int }) }).$snapshot();
  const after = schema({ items: table({ id: int.auto, v: date }) }).$snapshot();

  expect(() =>
    diffSchemas(before, after, {
      using: { items: { v: { up: "date '2000-01-01' + v" } as never } },
    }),
  ).toThrow(
    'symmetria: the USING conversion for "items.v" needs both directions, and "down" is missing',
  );
});
