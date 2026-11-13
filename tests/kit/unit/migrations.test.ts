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
  operatorClass,
  bool,
  sql,
  varchar,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";
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
import { expressionKey } from "../../../packages/kit/src/migrations/expressions";
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
    "destructive records_state_enum",
    "blocking users.email",
    "blocking users.nickname",
    "blocking users.score",
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
  expect(diffSchemas(build(false), build(true)).up).toEqual([
    'ALTER TABLE "posts" DROP CONSTRAINT "posts_author_id_fkey"',
    'ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE',
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
  // A cast to text of a column that is not text keeps its meaning, and so
  // does a real literal, which compares in single precision.
  different(`"score"::text = E'1'`, `"score" = E'1'`);
  different('"ratio" < 0.1::text::real', '"ratio" < 0.1');
  same('"ratio" < 0.1::text::real', "(ratio < ((0.1)::text)::real)");
  // SQL the parser does not model is compared as text.
  same("x SIMILAR TO 'a'", "x  SIMILAR TO 'a'");
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
    'ALTER TABLE "items" ADD CONSTRAINT "items_score_check" CHECK ("score" > -99)',
    `CREATE INDEX "items_live_idx" ON "items" USING btree ("score") WHERE "state" = E'closed'`,
  ]);
});
