import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  bigint,
  smallint,
  bool,
  text,
  varchar,
  numeric,
  timestamptz,
  oneOf,
  customType,
  index,
} from "../../../packages/runtime/src";
import {
  diffSchemas,
  generateMigration,
  lintMigration,
  lintMigrationSQL,
  type Migration,
} from "../../../packages/kit/src";
import { executionPlan } from "../../../packages/kit/src/migrations/execution";
import {
  formatMigrationSQL,
  parseMigrationSQL,
  splitMigrationSQL,
} from "../../../packages/kit/src/migrations/sql";
import { withMigrationDirectory } from "../../support/directories";

const bits = (length: number) =>
  customType<string>(`bit(${length})`, {
    encode: (value) => value,
    decode: (value) => String(value),
  });

const levels = (plan: ReturnType<typeof diffSchemas>) =>
  Object.fromEntries(
    lintMigration(plan).map((finding) => [
      finding.column,
      `${finding.level}: ${finding.message}`,
    ]),
  );

test("narrowing type changes never cut values and lint reports the lossy ones as destructive", () => {
  const before = schema({
    users: {
      id: int.auto,
      name: text,
      code: varchar(10),
      short: varchar(3),
      price: numeric(10, 4),
      amount: numeric(10, 2),
      big: bigint,
      at: timestamptz,
      day: timestamptz,
      state: oneOf("draft", "published"),
      mask: bits(8),
      flags: bits(4),
      total: bigint,
      rank: int,
      tiny: bigint,
      wide: smallint,
      done: int,
    },
  });
  const after = schema({
    users: {
      id: int.auto,
      name: varchar(5),
      code: varchar(3),
      short: varchar(10),
      price: numeric(10, 2),
      amount: int,
      big: customType<number>("double precision", {
        encode: (value) => value,
        decode: Number,
      }),
      at: timestamptz(3),
      day: customType<string>("date", {
        encode: (value) => value,
        decode: String,
      }),
      state: varchar(12),
      mask: bits(4),
      flags: bits(8),
      total: int,
      rank: smallint,
      tiny: smallint,
      wide: bigint,
      done: bool,
    },
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot());
  // The statement as it runs; a lossy one carries a note for lint above it.
  const retype = (column: string) =>
    plan.up
      .find((sql) => sql.includes(`ALTER COLUMN "${column}" TYPE`))
      ?.replace(/^-- symmetria: destructive: .*\n/, "");

  expect(
    plan.up.find((sql) => sql.includes(`ALTER COLUMN "name" TYPE`)),
  ).toStartWith(
    '-- symmetria: destructive: Column "name" narrows from text to varchar(5)',
  );

  // Length-limited strings use PostgreSQL's assignment cast, which refuses long values.
  expect(retype("name")).toBe(
    'ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5)',
  );
  expect(retype("code")).toBe(
    'ALTER TABLE "users" ALTER COLUMN "code" TYPE varchar(3)',
  );
  expect(retype("short")).toBe(
    'ALTER TABLE "users" ALTER COLUMN "short" TYPE varchar(10)',
  );
  expect(retype("state")).toBe(
    'ALTER TABLE "users" ALTER COLUMN "state" TYPE varchar(12)',
  );
  expect(retype("mask")).toBe(
    'ALTER TABLE "users" ALTER COLUMN "mask" TYPE bit(4)',
  );
  // A fixed bit(n) keeps its zero-padding cast when it gets longer.
  expect(retype("flags")).toContain('USING "flags"::bit(8)');
  expect(retype("price")).toContain('USING "price"::numeric(10,2)');
  // Rollback widens again and keeps refusing nothing.
  expect(plan.down).toContain(
    'ALTER TABLE "users" ALTER COLUMN "name" TYPE text USING "name"::text',
  );

  expect(levels(plan)).toEqual({
    name: 'destructive: Column "name" narrows from text to varchar(5): values longer than 5 characters make the migration fail, and trailing spaces past the limit are cut.',
    code: 'destructive: Column "code" narrows from varchar(10) to varchar(3): values longer than 3 characters make the migration fail, and trailing spaces past the limit are cut.',
    short:
      'caution: Column "short" changes type from varchar(3) to varchar(10).',
    price:
      'destructive: Column "price" narrows from numeric(10,4) to numeric(10,2): values are rounded to 2 decimal places.',
    amount:
      'destructive: Column "amount" narrows from numeric(10,2) to integer: values are rounded to whole numbers.',
    big: 'destructive: Column "big" narrows from bigint to double precision: values keep only about 15 significant digits.',
    at: 'destructive: Column "at" narrows from timestamptz to timestamptz(3): fractional seconds are rounded to 3 digits.',
    day: 'destructive: Column "day" narrows from timestamptz to date: the time of day is dropped.',
    state:
      'caution: Column "state" changes type from users_state_enum to varchar(12).',
    mask: 'destructive: Column "mask" narrows from bit(8) to bit(4): values longer than 4 bits make the migration fail.',
    flags: 'caution: Column "flags" changes type from bit(4) to bit(8).',
    // A smaller integer type refuses what does not fit, like a shorter string.
    total:
      'destructive: Column "total" narrows from bigint to integer: values outside the integer range make the migration fail.',
    rank: 'destructive: Column "rank" narrows from integer to smallint: values outside the smallint range make the migration fail.',
    tiny: 'destructive: Column "tiny" narrows from bigint to smallint: values outside the smallint range make the migration fail.',
    wide: 'caution: Column "wide" changes type from smallint to bigint.',
    done: 'destructive: Column "done" narrows from integer to boolean: every value other than 0 becomes true.',
  });
  expect(
    Object.fromEntries(
      lintMigration(plan).map((finding) => [finding.column, finding.advice]),
    ),
  ).toMatchObject({
    total:
      "Move or change the values that do not fit first, then generate with --allow-destructive; PostgreSQL refuses values that still do not fit.",
    done: "Copy the column or back up the table if the lost precision matters, then generate with --allow-destructive.",
  });

  // An explicit hint is used as written; lint still reports the loss.
  const hinted = diffSchemas(
    schema({ users: { id: int.auto, name: text } }).$snapshot(),
    schema({ users: { id: int.auto, name: varchar(5) } }).$snapshot(),
    {
      using: {
        users: { name: { up: 'left("name", 5)', down: '"name"::text' } },
      },
    },
  );
  expect(hinted.up).toEqual([
    '-- symmetria: destructive: Column "name" narrows from text to varchar(5) with the USING conversion given for it.\nALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5) USING left("name", 5)',
  ]);
  expect(levels(hinted).name).toStartWith("destructive:");
});

test("generation refuses a narrowing change unless destruction is allowed", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ users: { id: int.auto, name: text } }).$snapshot(),
    });
    const shorter = schema({
      users: { id: int.auto, name: varchar(5) },
    }).$snapshot();
    await expect(
      generateMigration({ directory, name: "shorten", snapshot: shorter }),
    ).rejects.toThrow(
      'users.name: Column "name" narrows from text to varchar(5)',
    );
    expect(
      (await generateMigration({
        directory,
        name: "shorten",
        snapshot: shorter,
        allowDestructive: true,
      }))!.up,
    ).not.toContain("USING");
  }));

test("generation refuses integer narrowing and integer-to-boolean changes unless destruction is allowed", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({
        users: { id: int.auto, visits: bigint, active: int },
      }).$snapshot(),
    });
    const narrower = schema({
      users: { id: int.auto, visits: int, active: bool },
    }).$snapshot();
    const refusal = await generateMigration({
      directory,
      name: "narrow",
      snapshot: narrower,
    }).catch((error: unknown) => String(error));
    expect(refusal).toContain(
      'users.visits: Column "visits" narrows from bigint to integer',
    );
    expect(refusal).toContain(
      'users.active: Column "active" narrows from integer to boolean',
    );
    expect(
      (await generateMigration({
        directory,
        name: "narrow",
        snapshot: narrower,
        allowDestructive: true,
      }))!.up,
    ).toContain('ALTER COLUMN "visits" TYPE integer');
  }));

test("a down migration retypes a renamed column before renaming it back", () => {
  const before = schema({ people: { id: int.auto, ageText: text } });
  const after = schema({ users: { id: int.auto, age: int } });
  const renames = {
    tables: { people: "users" },
    columns: { users: { age_text: "age" } },
  };
  const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
    renames,
    using: { users: { age: { up: '"age"::integer', down: '"age"::text' } } },
  });
  expect(plan.up).toEqual([
    'ALTER TABLE "people" RENAME TO "users"',
    'ALTER TABLE "users" RENAME COLUMN "age_text" TO "age"',
    'ALTER TABLE "users" RENAME CONSTRAINT "people_pkey" TO "users_pkey"',
    'ALTER TABLE "users" ALTER COLUMN "age" TYPE integer USING "age"::integer',
  ]);
  expect(plan.down).toEqual([
    'ALTER TABLE "users" RENAME TO "people"',
    'ALTER TABLE "people" RENAME CONSTRAINT "users_pkey" TO "people_pkey"',
    'ALTER TABLE "people" ALTER COLUMN "age" TYPE text USING "age"::text',
    'ALTER TABLE "people" RENAME COLUMN "age" TO "age_text"',
  ]);
  // Without a hint the generated conversion names the column as it is at that point.
  expect(
    diffSchemas(before.$snapshot(), after.$snapshot(), { renames }).down,
  ).toContain(
    'ALTER TABLE "people" ALTER COLUMN "age" TYPE text USING "age"::text',
  );
});

test("a changed default is replaced in one SET DEFAULT, also online", () => {
  const before = schema({ posts: { id: int.auto, state: text.default("a") } });
  const after = schema({ posts: { id: int.auto, state: text.default("b") } });

  for (const online of [false, true]) {
    const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
      online,
    });
    expect(plan.up).toEqual([
      `ALTER TABLE "posts" ALTER COLUMN "state" SET DEFAULT E'b'`,
    ]);
    expect(plan.down).toEqual([
      `ALTER TABLE "posts" ALTER COLUMN "state" SET DEFAULT E'a'`,
    ]);
  }

  expect(
    diffSchemas(
      before.$snapshot(),
      schema({ posts: { id: int.auto, state: text } }).$snapshot(),
    ).up,
  ).toEqual(['ALTER TABLE "posts" ALTER COLUMN "state" DROP DEFAULT']);
});

const migration = (
  id: string,
  sql: { up?: string; down?: string },
  transaction?: "each" | "none",
): Migration => ({
  id,
  manifest: {
    version: 1,
    id,
    parent: null,
    before: "",
    after: "",
    ...(transaction ? { transaction } : {}),
  },
  up: sql.up ?? "SELECT 1;",
  down: sql.down ?? "SELECT 1;",
  checksum: id,
});

test("a batch group ends after a migration that adds enum labels", () => {
  const adds = migration("000002_add", {
    up: `ALTER TYPE "state" ADD VALUE IF NOT EXISTS E'review';`,
    down: `ALTER TYPE "state" ADD VALUE E'draft';`,
  });
  const plan = (direction: "up" | "down", migrations: Migration[]) =>
    executionPlan(migrations, direction).map((step) => step.group);

  expect(
    plan("up", [
      migration("000001_initial", {}),
      adds,
      migration("000003_use", {}),
      migration("000004_more", {}),
    ]),
  ).toEqual([1, 1, 2, 2]);
  // The last migration of a run needs no boundary of its own.
  expect(plan("up", [migration("000001_initial", {}), adds])).toEqual([1, 1]);
  // Rollback runs newest first: a down that adds a label commits before the next one.
  expect(plan("down", [adds, migration("000001_initial", {})])).toEqual([1, 2]);
  expect(
    plan("up", [
      adds,
      migration("000003_each", {}, "each"),
      migration("x", {}),
    ]),
  ).toEqual([1, 2, 3]);
  // Labels mentioned only in comments or strings do not split the group.
  expect(
    plan("up", [
      migration("000001_comment", {
        up: "-- ALTER TYPE state ADD VALUE 'x'\nSELECT 'ALTER TYPE t ADD VALUE';",
      }),
      migration("000002_next", {}),
    ]),
  ).toEqual([1, 1]);
});

test("only statements PostgreSQL refuses in a transaction require transaction none", () => {
  const plan = (up: string, transaction?: "each" | "none") =>
    executionPlan([migration("000001_step", { up }, transaction)], "up");

  for (const statement of [
    'CREATE INDEX CONCURRENTLY "posts_title_idx" ON "posts" ("title")',
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS posts_slug_key ON posts (slug)",
    "create index concurrently on posts (title)",
    'DROP INDEX CONCURRENTLY IF EXISTS "posts_title_idx"',
    "REINDEX INDEX CONCURRENTLY posts_title_idx",
    "REINDEX (VERBOSE, CONCURRENTLY) TABLE posts",
    "REINDEX (CONCURRENTLY true) TABLE posts",
    "REINDEX (TABLESPACE fast) TABLE CONCURRENTLY posts",
    'ALTER TABLE "events" DETACH PARTITION "events_2024" CONCURRENTLY',
    "ALTER TABLE events DETACH PARTITION archive.events_2024 CONCURRENTLY",
    "VACUUM",
    "VACUUM (ANALYZE) posts",
    "CREATE DATABASE reports",
    'DROP DATABASE IF EXISTS "reports"',
    "CREATE TABLESPACE fast LOCATION '/mnt/fast'",
    "DROP TABLESPACE fast",
    "ALTER SYSTEM SET work_mem = '64MB'",
  ]) {
    expect(() => plan(`${statement};`)).toThrow(
      'symmetria: migration "000001_step" requires transaction: "none"',
    );
    expect(() => plan(`SELECT 1;\n${statement};`, "each")).toThrow(
      /requires transaction: "none"/,
    );
    expect(plan(`${statement};`, "none")[0]!.transaction).toBe("none");
  }

  // The word alone decides nothing: it may be a name, and a materialized
  // view refreshes concurrently inside a transaction.
  for (const statement of [
    "ALTER TABLE jobs ADD COLUMN concurrently boolean NOT NULL DEFAULT false",
    "CREATE TABLE concurrently (id integer PRIMARY KEY)",
    "CREATE INDEX concurrently_idx ON jobs (concurrently)",
    "CREATE INDEX jobs_mode_idx ON jobs (concurrently)",
    "DROP INDEX concurrently_idx",
    "ALTER TABLE events DETACH PARTITION concurrently",
    "ALTER TABLE concurrently DETACH PARTITION events_2024",
    "ALTER TABLE events RENAME COLUMN vacuum TO concurrently",
    "REINDEX TABLE posts",
    "REINDEX (CONCURRENTLY false) TABLE posts",
    "REFRESH MATERIALIZED VIEW CONCURRENTLY daily_totals",
    "UPDATE jobs SET vacuum = true WHERE concurrently",
    "COMMENT ON TABLE jobs IS 'CREATE INDEX CONCURRENTLY later'",
    "CREATE TABLE tablespace_notes (database text)",
  ]) {
    expect(plan(`${statement};`)[0]!.transaction).toBe("batch");
  }
});

test("the splitter keeps BEGIN ATOMIC bodies and parenthesized rule actions whole", () => {
  const script = `CREATE OR REPLACE FUNCTION label(amount integer) RETURNS text LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN amount > 1 THEN 'many' ELSE 'one' END;
  SELECT 'end;';
END;
CREATE PROCEDURE touch() LANGUAGE sql BEGIN ATOMIC INSERT INTO audit VALUES (1); END;
CREATE RULE audit_insert AS ON INSERT TO records DO ALSO (
  INSERT INTO audit VALUES (NEW.id);
  INSERT INTO audit VALUES (NEW.id + 1)
);
CREATE FUNCTION plain() RETURNS integer LANGUAGE sql RETURN CASE WHEN true THEN 1 END;
SELECT 1;`;
  const statements = splitMigrationSQL(script);
  expect(statements).toHaveLength(5);
  expect(statements[0]).toEndWith("END");
  expect(statements[0]).toContain("SELECT 'end;';");
  expect(statements[1]).toContain("VALUES (1); END");
  expect(statements[2]).toContain("(NEW.id);\n  INSERT");
  expect(statements[3]).toEndWith("END");
  expect(statements[4]).toBe("SELECT 1");

  for (const boundary of [
    "BEGIN; SELECT 1;",
    "BEGIN ATOMIC; SELECT 1;",
    "SELECT 1; COMMIT;",
    "SAVEPOINT before;",
    "END;",
    "START TRANSACTION;",
  ]) {
    expect(() => splitMigrationSQL(boundary)).toThrow(/transaction boundaries/);
  }

  // Comments and literals never reach the code used for classification.
  expect(
    parseMigrationSQL(
      `/* DROP TABLE a */ COMMENT ON TABLE "t" IS 'ADD CONSTRAINT x'; -- tail`,
    )[0]?.code,
  ).toBe(`COMMENT ON TABLE "t" IS ''`);
  // SQL lint treats the function as one statement to review.
  expect(
    lintMigrationSQL(statements.slice(0, 1).join("")).map(
      (finding) => finding.statement,
    ),
  ).toEqual([1]);
});

const lint = (sql: string) =>
  lintMigrationSQL(sql).map((finding) => [
    finding.statement,
    finding.level,
    finding.message.replace(/^Statement \d+: /, ""),
  ]);

test("SQL lint ignores comments and strings when deciding that a drop is a rebuild", () => {
  expect(
    lint(`ALTER TABLE users DROP CONSTRAINT "users_pkey";
COMMENT ON TABLE users IS 'TODO: ADD CONSTRAINT "users_pkey" again later';`),
  ).toEqual([[1, "destructive", "Removes data or a database object."]]);
  expect(
    lint(`DROP INDEX "users_email_idx";
/* CREATE INDEX "users_email_idx" ON users (email) */ SELECT 1;`),
  ).toEqual([
    [1, "destructive", "Removes data or a database object."],
    [
      2,
      "caution",
      "Contains a schema change, data operation or executable SQL requiring review.",
    ],
  ]);
  // A real re-creation still downgrades the drop.
  expect(
    lint(`DROP INDEX "users_email_idx";
CREATE INDEX "users_email_idx" ON users (email);`).map(([, level]) => level),
  ).toEqual(["caution", "caution"]);
});

test("SQL lint reviews every action of a multi-action ALTER TABLE", () => {
  expect(
    lint(
      "ALTER TABLE users ADD COLUMN note text, ALTER COLUMN score TYPE text USING NULL;",
    ),
  ).toEqual([
    [
      1,
      "caution",
      "Changing a column type rewrites the table under an ACCESS EXCLUSIVE lock unless the cast is binary-coercible.",
    ],
  ]);
  expect(
    lint(
      "ALTER TABLE users ADD COLUMN note text, DROP COLUMN legacy, ALTER COLUMN email SET NOT NULL;",
    ).map(([, level]) => level),
  ).toEqual(["destructive", "blocking"]);
  // A column whose name looks like a keyword is not mistaken for a type change.
  expect(lint('ALTER TABLE users ALTER COLUMN "type" SET NOT NULL;')).toEqual([
    [1, "blocking", "Requires non-null values in existing rows."],
  ]);
});

test("SQL lint passes catalog-only default and enum label changes", () => {
  expect(
    lint(`ALTER TABLE tickets ALTER COLUMN "state" SET DEFAULT E'archived';
ALTER TABLE tickets ALTER COLUMN code DROP DEFAULT, ALTER COLUMN note SET DEFAULT now();
ALTER TYPE "ticket_state" ADD VALUE E'archived';
ALTER TYPE ticket_state ADD VALUE IF NOT EXISTS 'held' BEFORE 'closed';`),
  ).toEqual([]);
  // Other actions in the same statement are still reviewed.
  expect(
    lint(
      "ALTER TABLE tickets ALTER COLUMN code SET DEFAULT 'x', ALTER COLUMN code SET NOT NULL;",
    ),
  ).toEqual([[1, "blocking", "Requires non-null values in existing rows."]]);
});

test("SQL lint blocks CHECK and FOREIGN KEY constraints that validate existing rows", () => {
  const findings = lintMigrationSQL(`
    ALTER TABLE users ADD CONSTRAINT score_positive CHECK (score > 0);
    ALTER TABLE users ADD CONSTRAINT users_team_fkey FOREIGN KEY (team_id) REFERENCES teams (id);
    ALTER TABLE users ADD CONSTRAINT score_positive CHECK (score > 0) NOT VALID;
    ALTER TABLE users VALIDATE CONSTRAINT score_positive;
    ALTER TABLE users ADD COLUMN editor_id integer, ADD CONSTRAINT users_editor_fkey FOREIGN KEY (editor_id) REFERENCES users (id);
  `);
  expect(findings.map((finding) => [finding.statement, finding.level])).toEqual(
    [
      [1, "blocking"],
      [2, "blocking"],
      [3, "caution"],
      [4, "caution"],
      [5, "caution"],
    ],
  );
  expect(findings[0]?.message).toContain("CHECK constraint");
  expect(findings[1]?.message).toContain("foreign key");
  expect(findings[0]?.advice).toContain("NOT VALID");
});

test("schema lint blocks a pending CHECK or foreign key on an existing table", () => {
  const before = schema({
    teams: { id: int.auto },
    users: table({ id: int.auto, teamId: int, score: int }).checks((users) => ({
      known: users.score.atLeast(0),
    })),
  });
  const after = schema({
    teams: { id: int.auto },
    members: ({ teams }) =>
      table({ id: int.auto, team: teams, points: int }).checks((members) => ({
        known: members.points.atLeast(0),
        positive: members.points.above(0),
      })),
  });
  const renames = {
    tables: { users: "members" },
    columns: { members: { score: "points" } },
  };
  const findings = lintMigration(
    diffSchemas(before.$snapshot(), after.$snapshot(), { renames }),
    renames,
  );
  expect(
    findings.map((finding) => `${finding.level}: ${finding.message}`),
  ).toEqual([
    'blocking: Column "team_id" gains a foreign key to teams.id; the statement fails when an existing value has no match.',
    'blocking: CHECK constraint "members_positive_check" is added; the statement fails when an existing row violates it.',
  ]);
});

test("SQL lint flags every volatile default that rewrites the table", () => {
  for (const expression of [
    "uuidv7()",
    "uuidv4()",
    "uuid_generate_v1()",
    "uuid_generate_v1mc()",
    "uuid_generate_v4()",
    "gen_random_uuid()",
    "random()",
    "clock_timestamp()",
    "nextval('users_seq')",
  ]) {
    expect(
      lint(`ALTER TABLE users ADD COLUMN value text DEFAULT ${expression};`),
    ).toEqual([
      [1, "caution", "A volatile default rewrites every existing row."],
    ]);
  }

  expect(
    lint(
      "ALTER TABLE users ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN v3 uuid DEFAULT uuid_generate_v3(uuid_nil(), 'x');",
    ),
  ).toEqual([]);
});

test("SQL lint treats a key rebuilt after its columns change type as a rebuild, not a uniqueness risk", () => {
  const keyed = (type: typeof int | typeof bigint) =>
    schema({
      users: table({ id: type === int ? int.auto : bigint.auto, code: text }),
      posts: ({ users }) => ({ id: int.auto, author: users }),
    });
  const retyped = diffSchemas(
    keyed(int).$snapshot(),
    keyed(bigint).$snapshot(),
  );
  expect(
    lintMigrationSQL(formatMigrationSQL(retyped.up)).filter(
      (finding) => finding.level !== "caution",
    ),
  ).toEqual([]);

  const unique = diffSchemas(
    schema({ users: { id: int.auto, code: text.unique } }).$snapshot(),
    schema({ users: { id: int.auto, code: varchar(20).unique } }).$snapshot(),
  );
  expect(
    lintMigrationSQL(formatMigrationSQL(unique.up)).map(
      (finding) => finding.level,
    ),
  ).not.toContain("blocking");

  // Adding a key without a type change still needs unique values.
  expect(
    lint(`ALTER TABLE users DROP CONSTRAINT users_pkey;
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (tenant_id);`).map(
      ([, level]) => level,
    ),
  ).toEqual(["caution", "blocking"]);
});

test("SQL lint reports an explicit cast that cuts strings in USING", () => {
  expect(
    lint(
      'ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5) USING "name"::varchar(5);',
    ),
  ).toEqual([
    [
      1,
      "destructive",
      "USING casts explicitly to a length-limited string type, which cuts longer values instead of failing.",
    ],
  ]);
  expect(
    lint('ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5);').map(
      ([, level]) => level,
    ),
  ).toEqual(["caution"]);
});

test("schema lint passes renames like SQL lint does", () => {
  const before = schema({ people: { id: int.auto, fullName: text } });
  const after = schema({ users: { id: int.auto, name: text } });
  const renames = {
    tables: { people: "users" },
    columns: { users: { full_name: "name" } },
  };
  const plan = diffSchemas(before.$snapshot(), after.$snapshot(), { renames });
  expect(lintMigration(plan, renames)).toEqual([]);
  expect(lintMigrationSQL(formatMigrationSQL(plan.up))).toEqual([]);
});

test("a widened column keeps its indexes and checks; a narrowed one rebuilds them", () => {
  const narrow = schema({
    orders: table({ id: int.auto, total: numeric(14, 2), code: varchar(10) })
      .indexes((order) => ({
        total: index(order.total),
        code: index(order.code),
      }))
      .checks((order) => ({ positive: order.total.atLeast("0") })),
  }).$snapshot();
  const wide = schema({
    orders: table({ id: int.auto, total: numeric(16, 2), code: text })
      .indexes((order) => ({
        total: index(order.total),
        code: index(order.code),
      }))
      .checks((order) => ({ positive: order.total.atLeast("0") })),
  }).$snapshot();
  const rescaled = schema({
    orders: table({ id: int.auto, total: numeric(16, 4), code: varchar(10) })
      .indexes((order) => ({
        total: index(order.total),
        code: index(order.code),
      }))
      .checks((order) => ({ positive: order.total.atLeast("0") })),
  }).$snapshot();
  const plan = diffSchemas(narrow, wide);

  // PostgreSQL changes the declaration in place: nothing is rebuilt.
  expect(plan.up).toEqual([
    'ALTER TABLE "orders" ALTER COLUMN "total" TYPE numeric(16,2) USING "total"::numeric(16,2)',
    'ALTER TABLE "orders" ALTER COLUMN "code" TYPE text USING "code"::text',
  ]);
  // The way back narrows, which every index and check has to follow.
  expect(plan.down.filter((sql) => sql.startsWith("DROP INDEX"))).toEqual([
    'DROP INDEX "orders_code_idx"',
    'DROP INDEX "orders_total_idx"',
  ]);
  expect(plan.down).toContain(
    'ALTER TABLE "orders" DROP CONSTRAINT "orders_positive_check"',
  );
  // A change of scale moves every value.
  expect(diffSchemas(narrow, rescaled).up).toContain(
    'DROP INDEX "orders_total_idx"',
  );
});

test("lint of a saved migration rates a narrowing change as generate did", () => {
  const plan = diffSchemas(
    schema({ users: { id: int.auto, name: text } }).$snapshot(),
    schema({ users: { id: int.auto, name: varchar(5) } }).$snapshot(),
  );
  const saved = `${plan.up.join(";\n\n")};\n`;

  // The SQL alone does not show the previous type; the note does.
  expect(
    lintMigrationSQL(saved).map((finding) => [finding.level, finding.message]),
  ).toContainEqual([
    "destructive",
    'Statement 1: Column "name" narrows from text to varchar(5): values longer than 5 characters make the migration fail, and trailing spaces past the limit are cut.',
  ]);
  // A hand-written ALTER without the note is the caution it always was.
  expect(
    lintMigrationSQL(
      'ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5);',
    ).map((finding) => finding.level),
  ).not.toContain("destructive");
});
