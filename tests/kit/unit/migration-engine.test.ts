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
  uuid,
  sql,
  type Column,
  type SchemaSnapshot,
} from "../../../packages/runtime/src";
import {
  diffSchemas,
  generateMigration,
  lintMigration,
  lintMigrationSQL,
  type Migration,
  type RenameHints,
} from "../../../packages/kit/src";
import {
  executionPlan,
  waitsWithoutBlocking,
} from "../../../packages/kit/src/migrations/execution";
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

test("a none migration lifts the default lock timeout only for statements whose waits block no reads or writes", () => {
  const waits = (statement: string) =>
    waitsWithoutBlocking(parseMigrationSQL(statement)[0]!.code);

  for (const statement of [
    'CREATE INDEX CONCURRENTLY "posts_title_idx" ON "posts" ("title")',
    "create unique index concurrently if not exists posts_slug_key on posts (slug)",
    'DROP INDEX CONCURRENTLY IF EXISTS "posts_title_idx"',
    "REINDEX (VERBOSE, CONCURRENTLY) TABLE posts",
    "REINDEX INDEX CONCURRENTLY posts_title_idx",
    'ALTER TABLE "users" VALIDATE CONSTRAINT "users_age_check"',
    "ALTER TABLE IF EXISTS ONLY app.validate VALIDATE CONSTRAINT validate",
  ]) {
    expect([statement, waits(statement)]).toEqual([statement, true]);
  }

  // Locks that reads and writes queue behind keep the timeout.
  for (const statement of [
    'ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK (age > 0) NOT VALID',
    'ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL',
    'ALTER TABLE "users" DROP CONSTRAINT "users_age_check"',
    "ALTER TABLE users VALIDATE CONSTRAINT a, ADD COLUMN note text",
    "ALTER TABLE events DETACH PARTITION events_2024 FINALIZE",
    // Its second transaction takes ACCESS EXCLUSIVE on the partition.
    'ALTER TABLE "events" DETACH PARTITION "events_2024" CONCURRENTLY',
    "REINDEX (CONCURRENTLY false) TABLE posts",
    "VACUUM FULL posts",
    "CREATE INDEX jobs_mode_idx ON jobs (concurrently)",
    "SELECT 'CREATE INDEX CONCURRENTLY x'",
  ]) {
    expect([statement, waits(statement)]).toEqual([statement, false]);
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
      "ALTER TABLE users ADD COLUMN note text, ALTER COLUMN score TYPE text USING score::text;",
    ),
  ).toEqual([
    [
      1,
      "caution",
      "Changing a column type rewrites the table under an ACCESS EXCLUSIVE lock unless the cast is binary-coercible.",
    ],
  ]);
  // USING NULL empties the column.
  expect(
    lint(
      "ALTER TABLE users ADD COLUMN note text, ALTER COLUMN score TYPE text USING NULL;",
    ),
  ).toEqual([
    [
      1,
      "destructive",
      "USING gives every row the same value (NULL or a constant): every existing value is lost.",
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

test("generate's review and lint of the saved SQL fail on the same generated changes", () => {
  const one = (columns: Record<string, Column>) =>
    schema({ t: table(columns) });
  const users = () => table({ id: int.auto, name: text });
  type Declared = { readonly $snapshot: () => SchemaSnapshot };
  const scenarios: [string, Declared, Declared, RenameHints?][] = [
    [
      "identity column",
      one({ code: text.primaryKey }),
      one({ code: text.primaryKey, n: int.auto }),
    ],
    [
      "unique column, constant default",
      one({ id: int.auto }),
      one({ id: int.auto, k: text.unique.default("x") }),
    ],
    [
      "unique column, nullable",
      one({ id: int.auto }),
      one({ id: int.auto, k: text.unique.nullable }),
    ],
    [
      "unique column, identity",
      one({ code: text.primaryKey }),
      one({ code: text.primaryKey, n: int.auto.unique }),
    ],
    [
      "enum reorder",
      one({ id: int.auto, s: oneOf("a", "b") }),
      one({ id: int.auto, s: oneOf("b", "a") }),
    ],
    [
      "enum reorder, unique",
      one({ id: int.auto, s: oneOf("a", "b").unique }),
      one({ id: int.auto, s: oneOf("b", "a").unique }),
    ],
    [
      "enum to text",
      one({ id: int.auto, s: oneOf("a", "b") }),
      one({ id: int.auto, s: text }),
    ],
    [
      "enum drops a label",
      one({ id: int.auto, s: oneOf("a", "b") }),
      one({ id: int.auto, s: oneOf("a") }),
    ],
    [
      "composite key reordered",
      schema({ t: table({ a: int, b: int }).primaryKey((t) => [t.a, t.b]) }),
      schema({ t: table({ a: int, b: int }).primaryKey((t) => [t.b, t.a]) }),
    ],
    [
      "key widened",
      schema({ t: table({ a: int, b: int }).primaryKey((t) => [t.a]) }),
      schema({ t: table({ a: int, b: int }).primaryKey((t) => [t.a, t.b]) }),
    ],
    [
      "key moves",
      one({ id: int.auto, code: text }),
      one({ id: int, code: text.primaryKey }),
    ],
    [
      "key moves to a new identity column",
      one({ code: text.primaryKey }),
      one({ id: int.auto, code: text }),
    ],
    [
      "key on a new uuid column",
      schema({ t: table({ a: int, b: int }).primaryKey((t) => [t.a, t.b]) }),
      one({ id: uuid.v4, a: int, b: int }),
    ],
    [
      "key on a new clock_timestamp() column",
      schema({ t: table({ a: int, b: int }).primaryKey((t) => [t.a, t.b]) }),
      one({
        at: timestamptz.default(sql`clock_timestamp()`).primaryKey,
        a: int,
        b: int,
      }),
    ],
    [
      "unique column, clock_timestamp() default",
      one({ id: int.auto }),
      one({
        id: int.auto,
        at: timestamptz.default(sql`clock_timestamp()`).unique,
      }),
    ],
    [
      "unique column, gen_random_uuid() default",
      one({ id: int.auto }),
      one({ id: int.auto, k: uuid.default(sql`gen_random_uuid()`).unique }),
    ],
    [
      "foreign key action",
      schema({ u: users(), t: ({ u }) => table({ id: int.auto, owner: u }) }),
      schema({
        u: users(),
        t: ({ u }) => table({ id: int.auto, owner: u.onDelete.cascade }),
      }),
    ],
    [
      "foreign key action, column renamed",
      schema({ u: users(), t: ({ u }) => table({ id: int.auto, owner: u }) }),
      schema({
        u: users(),
        t: ({ u }) => table({ id: int.auto, boss: u.onDelete.cascade }),
      }),
      { columns: { t: { owner_id: "boss_id" } } },
    ],
    [
      "foreign key dropped",
      schema({
        u: users(),
        t: ({ u }) => table({ id: int.auto, owner: u.noIndex }),
      }),
      schema({ u: users(), t: table({ id: int.auto, ownerId: int }) }),
    ],
    [
      "foreign key on a column",
      schema({ u: users(), t: table({ id: int.auto, uid: int }) }),
      schema({
        u: users(),
        t: ({ u }) => table({ id: int.auto, uid: u.column("uid").noIndex }),
      }),
    ],
    [
      "index dropped",
      one({ id: int.auto, a: text.index }),
      one({ id: int.auto, a: text }),
    ],
    [
      "unique dropped",
      one({ id: int.auto, a: text.unique }),
      one({ id: int.auto, a: text }),
    ],
    [
      "check dropped",
      schema({
        t: table({ id: int.auto, a: int }).checks((t) => ({
          pos: t.a.above(0),
        })),
      }),
      one({ id: int.auto, a: int }),
    ],
    [
      "check added",
      one({ id: int.auto, a: int }),
      schema({
        t: table({ id: int.auto, a: int }).checks((t) => ({
          pos: t.a.above(0),
        })),
      }),
    ],
    [
      "unique index dropped",
      schema({
        t: table({ id: int.auto, a: text }).indexes((t) => ({
          u: index(t.a).unique,
        })),
      }),
      one({ id: int.auto, a: text }),
    ],
    ["column dropped", one({ id: int.auto, a: text }), one({ id: int.auto })],
    [
      "becomes unique",
      one({ id: int.auto, a: text }),
      one({ id: int.auto, a: text.unique }),
    ],
    [
      "becomes not null",
      one({ id: int.auto, a: text.nullable }),
      one({ id: int.auto, a: text }),
    ],
  ];
  const fails = (levels: readonly string[]) =>
    levels.some((level) => level !== "caution");
  const rating = new Map<string, boolean>();

  for (const online of [false, true]) {
    for (const [label, before, after, renames] of scenarios) {
      const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
        online,
        ...(renames ? { renames } : {}),
      });
      const review = lintMigration(plan, renames).map(
        (finding) => finding.level,
      );
      const saved = lintMigrationSQL(
        plan.up.map((sql) => `${sql};`).join("\n"),
      ).map((finding) => finding.level);

      expect([label, online, fails(saved)]).toEqual([
        label,
        online,
        fails(review),
      ]);

      if (!online) {
        rating.set(label, fails(review));
      }
    }
  }

  // And both are right: what can fail or lose data fails, what cannot passes.
  expect(Object.fromEntries(rating)).toEqual({
    "identity column": false,
    "unique column, constant default": true,
    "unique column, nullable": false,
    "unique column, identity": false,
    "enum reorder": false,
    "enum reorder, unique": false,
    "enum to text": false,
    "enum drops a label": true,
    "composite key reordered": false,
    "key widened": false,
    "key moves": true,
    // Every existing row gets its own value.
    "key moves to a new identity column": false,
    "key on a new uuid column": false,
    // clock_timestamp() repeats across rows written in one microsecond.
    "key on a new clock_timestamp() column": true,
    "unique column, clock_timestamp() default": true,
    "unique column, gen_random_uuid() default": false,
    "foreign key action": false,
    "foreign key action, column renamed": false,
    "foreign key dropped": false,
    "foreign key on a column": true,
    "index dropped": false,
    "unique dropped": false,
    "check dropped": false,
    "check added": true,
    "unique index dropped": false,
    "column dropped": true,
    "becomes unique": true,
    "becomes not null": true,
  });
});

test("the --online review describes the SQL it writes, and lint of the saved file agrees", () => {
  const before = schema({
    users: { id: int.auto, name: text, email: text, n: int.nullable },
  });
  const after = schema({
    users: {
      id: int.auto,
      name: text.index,
      email: text.unique,
      n: int,
      code: text.nullable.unique,
    },
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
    online: true,
  });
  const failed =
    "If the build fails, it leaves an invalid index and an incomplete migration: drop the index (DROP INDEX CONCURRENTLY), then use repair.";

  expect(
    lintMigration(plan).map((finding) => [
      finding.level,
      finding.column ?? finding.table,
      finding.message,
      finding.advice,
    ]),
  ).toEqual([
    [
      "blocking",
      "email",
      'Column "email" becomes UNIQUE; the statement fails when existing rows contain duplicates.',
      `Deduplicate the data first, then add the constraint. ${failed}`,
    ],
    // Validated like an online CHECK; SET NOT NULL then scans nothing.
    [
      "caution",
      "n",
      'Column "n" becomes NOT NULL; a CHECK that it is not NULL is added NOT VALID and validated in a separate statement, which fails when an existing row holds NULL, and SET NOT NULL then uses it instead of scanning the table.',
      "Backfill NULL values before the migration runs.",
    ],
    [
      "caution",
      "code",
      'Column "code" is added with a UNIQUE constraint; existing rows hold distinct values or NULL, and the index is built CONCURRENTLY, outside a transaction, while reads and writes go on.',
      failed,
    ],
    [
      "caution",
      "users",
      'Index "users_name_idx" is built CONCURRENTLY, outside a transaction: reads and writes go on while it builds, which takes longer than a plain build.',
      failed,
    ],
  ]);
  // The temporary check is dropped, not rebuilt, and SET NOT NULL cannot fail.
  expect(lint(plan.up.map((statement) => `${statement};`).join("\n"))).toEqual([
    [
      2,
      "caution",
      "Adds a CHECK constraint NOT VALID: rows written from now on are checked, existing rows only when VALIDATE CONSTRAINT runs; adding it takes a brief lock.",
    ],
    [
      3,
      "caution",
      "Validates a constraint against every existing row under a SHARE UPDATE EXCLUSIVE lock, which lets reads and writes go on; the statement fails when a row violates it.",
    ],
    [6, "blocking", "Requires unique existing values."],
    [
      7,
      "caution",
      "Makes an existing unique index the UNIQUE constraint: a catalog change under a brief ACCESS EXCLUSIVE lock, with no table scan.",
    ],
    [
      8,
      "caution",
      "Builds a unique index CONCURRENTLY on columns added in this migration, whose existing rows hold distinct values or NULL; reads and writes go on while it builds.",
    ],
    [
      9,
      "caution",
      "Makes an existing unique index the UNIQUE constraint: a catalog change under a brief ACCESS EXCLUSIVE lock, with no table scan.",
    ],
  ]);
  // Without --online the review describes the transactional SQL.
  expect(
    lintMigration(diffSchemas(before.$snapshot(), after.$snapshot())).map(
      (finding) => [finding.level, finding.column ?? finding.table],
    ),
  ).toEqual([
    ["blocking", "email"],
    ["blocking", "n"],
    ["caution", "code"],
    ["caution", "users"],
  ]);
});

test("SQL lint passes SET NOT NULL only behind a valid CHECK of that column, and a drop only of what the migration made", () => {
  const levels = (sql: string) => lint(sql).map(([, level]) => level);

  // Never validated, dropped first, or on another column: the scan can fail.
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NOT NULL) NOT VALID;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;`),
  ).toEqual(["caution", "blocking"]);
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NOT NULL) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT c;
ALTER TABLE t DROP CONSTRAINT c;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;`),
  ).toEqual(["caution", "caution", "blocking"]);
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK (m IS NOT NULL) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT c;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;
ALTER TABLE u ALTER COLUMN m SET NOT NULL;`),
  ).toEqual(["caution", "caution", "blocking", "blocking"]);
  // The CHECK follows its column through a rename, and goes with a drop.
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NOT NULL) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT c;
ALTER TABLE t RENAME COLUMN n TO m;
ALTER TABLE t ADD COLUMN n int;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;
ALTER TABLE t ALTER COLUMN m SET NOT NULL;`),
  ).toEqual(["caution", "caution", "blocking"]);
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NOT NULL) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT c;
ALTER TABLE t DROP COLUMN n;
ALTER TABLE t ADD COLUMN n int;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;`),
  ).toEqual(["caution", "caution", "destructive", "blocking"]);
  // A CHECK added valid proves it at once (and is itself blocking).
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK ((n IS NOT NULL));
ALTER TABLE t ALTER COLUMN n SET NOT NULL;`),
  ).toEqual(["blocking"]);
  // A constraint or index made earlier in this file is dropped without loss;
  // one from before the migration, or of another table, is not.
  expect(
    lint(`ALTER TABLE t DROP CONSTRAINT old;
ALTER TABLE t ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE u DROP CONSTRAINT c;
ALTER TABLE t DROP CONSTRAINT c;
CREATE INDEX i ON t (n);
DROP INDEX i;`).map(([statement, level]) => [statement, level]),
  ).toEqual([
    [1, "destructive"],
    [2, "caution"],
    [3, "destructive"],
    [5, "caution"],
  ]);
  const drops = (sql: string) =>
    lint(sql)
      .filter(([, , message]) => /^(?:Removes|Rebuilds)/.test(String(message)))
      .map(([statement, level]) => [statement, level]);
  // A CREATE that does nothing when the name is taken, one in a schema that
  // may be another, or one after a drop of that name proves nothing new: the
  // drop may remove what was there before the migration.
  expect(
    drops(`CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON users (email);
DROP INDEX CONCURRENTLY i;`),
  ).toEqual([[2, "destructive"]]);
  for (const [create, drop] of [
    ["archive.users", "public.i"],
    ["users", "public.i"],
    ["public.users", "i"],
  ]) {
    expect(
      drops(`CREATE INDEX i ON ${create} (email);\nDROP INDEX ${drop};`),
    ).toEqual([[2, "destructive"]]);
  }
  expect(
    drops(`CREATE INDEX i ON users (email);
SET search_path = archive;
DROP INDEX i;`),
  ).toEqual([[3, "destructive"]]);
  expect(
    drops(`ALTER TABLE t DROP CONSTRAINT c;
ALTER TABLE t ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE t DROP CONSTRAINT c;
DROP INDEX i;
CREATE INDEX i ON t (n);
DROP INDEX i;`),
  ).toEqual([
    [1, "caution"],
    [3, "destructive"],
    [4, "caution"],
    [6, "destructive"],
  ]);
  // The same schema, written the same way, is the index made before.
  expect(
    drops(`CREATE INDEX "I" ON "Archive".users (email);
DROP INDEX "Archive"."I";
ALTER TABLE archive.t ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE ARCHIVE.t DROP CONSTRAINT c;
ALTER TABLE t ADD CONSTRAINT d CHECK (n > 0) NOT VALID;
ALTER TABLE archive.t DROP CONSTRAINT d;`),
  ).toEqual([[6, "destructive"]]);
  // Only a statement that changes search_path (or the role) counts, not the
  // words in a name, a comment or a string; and only between the two.
  for (const middle of [
    `ALTER TABLE t ADD COLUMN search_path text`,
    `COMMENT ON TABLE t IS 'search_path' -- search_path`,
    `SELECT set_config('lock_timeout', '1s', false)`,
    `CREATE FUNCTION f() RETURNS int LANGUAGE sql SET search_path = app AS $$ SELECT 1 $$`,
  ]) {
    expect(
      drops(`CREATE INDEX i ON t (n);\n${middle};\nDROP INDEX i;`),
    ).toEqual([]);
  }
  for (const middle of [
    `SET LOCAL search_path TO app`,
    `RESET search_path`,
    `SET ROLE app`,
    `SELECT pg_catalog.set_config('search_path', '', false)`,
    `SELECT set_config($$search_path$$, 'app', false)`,
  ]) {
    expect(
      drops(`CREATE INDEX i ON t (n);\n${middle};\nDROP INDEX i;`),
    ).toEqual([[3, "destructive"]]);
  }
  expect(
    drops(`SET search_path = app;\nCREATE INDEX i ON t (n);\nDROP INDEX i;`),
  ).toEqual([]);
  // A rebuild creates the object again on the same table, under its later name.
  expect(
    drops(`ALTER TABLE t DROP CONSTRAINT c;
ALTER TABLE u ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE v DROP CONSTRAINT c;
ALTER TABLE v RENAME TO w;
ALTER TABLE w ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE x DROP CONSTRAINT c;
SET search_path = app;
ALTER TABLE x ADD CONSTRAINT c CHECK (n > 0) NOT VALID;`),
  ).toEqual([
    [1, "destructive"],
    [3, "caution"],
    [6, "destructive"],
  ]);
  // The NOT NULL proof follows RENAME CONSTRAINT, and holds for an
  // unqualified table only while search_path stays as it was.
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NOT NULL);
ALTER TABLE t RENAME CONSTRAINT c TO d;
ALTER TABLE t DROP CONSTRAINT d;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;`),
  ).toEqual(["blocking", "destructive", "blocking"]);
  expect(
    levels(`ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NOT NULL);
ALTER TABLE t RENAME CONSTRAINT c TO d;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;`),
  ).toEqual(["blocking"]);
  expect(
    lint(`ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NOT NULL);
SET search_path = app;
ALTER TABLE t ALTER COLUMN n SET NOT NULL;
ALTER TABLE public.t ADD CONSTRAINT d CHECK (m IS NOT NULL);
SET search_path = public;
ALTER TABLE public.t ALTER COLUMN m SET NOT NULL;`)
      .filter(([, , message]) => /non-null/.test(String(message)))
      .map(([statement]) => statement),
  ).toEqual([3]);
  // The proof belongs to the table, not to its name: a table renamed takes
  // it along, and a name another table is renamed into, or that is dropped
  // or created again, proves nothing. Code lint cannot read (DO, CALL,
  // EXECUTE), set_config('role', …) and a schema renamed or dropped may
  // change where names resolve; a view's query runs no set_config().
  const proof = `ALTER TABLE t ADD CONSTRAINT c CHECK (a IS NOT NULL) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT c;
`;
  const notNull = (sql: string) =>
    lint(sql)
      .filter(([, , message]) => /non-null/.test(String(message)))
      .map(([statement]) => statement);
  expect(
    notNull(`${proof}ALTER TABLE t RENAME TO t_old;
ALTER TABLE t_new RENAME TO t;
ALTER TABLE t ALTER COLUMN a SET NOT NULL;
ALTER TABLE t_old ALTER COLUMN a SET NOT NULL;`),
  ).toEqual([5]);
  for (const middle of [
    "DROP TABLE t;\nALTER TABLE t_new RENAME TO t",
    "DROP VIEW IF EXISTS v, t",
    "ALTER TABLE t SET SCHEMA archive",
    "CREATE TEMP TABLE t (a int);\nDROP TABLE t",
    "SELECT * INTO TEMPORARY t FROM u;\nDROP TABLE t",
    "DO $$ BEGIN PERFORM set_config('search_path', 'app', false); END $$",
    "DO $$ BEGIN EXECUTE 'SET search_path TO app'; END $$",
    "CALL swap_tables()",
    "EXECUTE swap(1)",
    "SELECT set_config('role', 'app_owner', false)",
    "ALTER SCHEMA public RENAME TO old",
  ]) {
    const sql = `${proof}${middle};\nALTER TABLE t ALTER COLUMN a SET NOT NULL;`;

    expect(notNull(sql)).toEqual([sql.split(";\n").length]);
  }
  for (const middle of [
    "CREATE VIEW v AS SELECT set_config('search_path', 'app', false)",
    "CREATE TABLE u (a int)",
    "DROP TABLE u",
    "ALTER TABLE t RENAME COLUMN b TO c",
  ]) {
    expect(
      notNull(`${proof}${middle};\nALTER TABLE t ALTER COLUMN a SET NOT NULL;`),
    ).toEqual([]);
  }
  // So do a dropped constraint or index proven new, and a table created in
  // this migration: renamed or dropped, its name stands for another.
  expect(
    drops(`ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID;
ALTER TABLE t RENAME TO t_old;
ALTER TABLE t_new RENAME TO t;
ALTER TABLE t DROP CONSTRAINT c;
ALTER TABLE t_old DROP CONSTRAINT c;
CREATE INDEX i ON t (a);
ALTER INDEX i RENAME TO j;
ALTER INDEX old RENAME TO i;
DROP INDEX i;
DROP INDEX j;
CREATE INDEX k ON t (a);
DO $$ BEGIN NULL; END $$;
DROP INDEX k;`),
  ).toEqual([
    [4, "destructive"],
    [9, "destructive"],
    [13, "destructive"],
  ]);
  expect(
    notNull(`CREATE TABLE t (a int);
ALTER TABLE t RENAME TO t_old;
ALTER TABLE big RENAME TO t;
ALTER TABLE t ALTER COLUMN a SET NOT NULL;
ALTER TABLE t_old ALTER COLUMN a SET NOT NULL;`),
  ).toEqual([4]);
});

test("SQL lint follows a renamed or moved object only in its own schema", () => {
  const drops = (sql: string) =>
    lint(sql)
      .filter(([, , message]) => /^(?:Removes|Rebuilds)/.test(String(message)))
      .map(([statement, level]) => [statement, level]);

  // A rename in another schema leaves the table, and its constraint, as
  // they were: s.u is another table, s.t still the one the CHECK went on.
  expect(
    drops(`ALTER TABLE s.t ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE r.t RENAME TO u;
ALTER TABLE s.u DROP CONSTRAINT c;
ALTER TABLE s.t DROP CONSTRAINT c;`),
  ).toEqual([[3, "destructive"]]);
  expect(
    drops(`CREATE INDEX i ON s.t (n);
ALTER INDEX r.i RENAME TO j;
DROP INDEX s.j;
DROP INDEX s.i;`),
  ).toEqual([[3, "destructive"]]);
  // Nor is a name another schema's object is renamed into taken.
  expect(
    drops(`CREATE INDEX i ON s.t (n);
ALTER INDEX r.old RENAME TO i;
DROP INDEX s.i;`),
  ).toEqual([]);
  // A table moved to another schema takes its indexes along: s.i is then
  // another index, or none.
  expect(
    drops(`CREATE INDEX i ON s.t (n);
ALTER TABLE s.t RENAME TO u;
ALTER TABLE s.u SET SCHEMA r;
DROP INDEX s.i;`),
  ).toEqual([[4, "destructive"]]);
  // A rebuild creates the constraint again on its own table.
  expect(
    drops(`ALTER TABLE s.t DROP CONSTRAINT c;
ALTER TABLE r.t RENAME TO u;
ALTER TABLE s.u ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE s.v DROP CONSTRAINT d;
ALTER TABLE r.w RENAME TO v;
ALTER TABLE s.v ADD CONSTRAINT d CHECK (n > 0) NOT VALID;
ALTER TABLE s.x DROP CONSTRAINT e;
ALTER TABLE s.x SET SCHEMA r;
ALTER TABLE s.x ADD CONSTRAINT e CHECK (n > 0) NOT VALID;`),
  ).toEqual([
    [1, "destructive"],
    [4, "caution"],
    [7, "destructive"],
  ]);
  // A rename that may or may not be of the object (one name written with
  // its schema, the other without) loses it: the drop may remove what was
  // there before, and a creation after it may be on another table.
  expect(
    drops(`CREATE INDEX i ON t (n);
ALTER INDEX public.i RENAME TO j;
DROP INDEX j;`),
  ).toEqual([[3, "destructive"]]);
  expect(
    drops(`ALTER TABLE s.t ADD CONSTRAINT c CHECK (n > 0) NOT VALID;
ALTER TABLE t RENAME TO u;
ALTER TABLE s.t DROP CONSTRAINT c;
ALTER TABLE v DROP CONSTRAINT d;
ALTER TABLE public.v RENAME TO w;
ALTER TABLE w ADD CONSTRAINT d CHECK (n > 0) NOT VALID;`),
  ).toEqual([
    [3, "destructive"],
    [4, "destructive"],
  ]);
});

test("SQL lint takes time in step with the size of the file", () => {
  const range = (count: number) => Array.from({ length: count }, (_, k) => k);
  const files = [
    // An online index swap per index: build, drop the old one, rename.
    range(7000)
      .map(
        (k) =>
          `CREATE INDEX CONCURRENTLY i_${k}_new ON t_${k % 20} (c${k});\nDROP INDEX CONCURRENTLY i_${k};\nALTER INDEX i_${k}_new RENAME TO i_${k};`,
      )
      .join("\n"),
    // Indexes created, renamed, then dropped; the same CHECK name on many
    // tables; the same names in many schemas.
    [
      ...range(7000).map((k) => `CREATE INDEX i_${k} ON t (c${k});`),
      ...range(7000).map((k) => `ALTER INDEX i_${k} RENAME TO j_${k};`),
      ...range(7000).map((k) => `DROP INDEX j_${k};`),
    ].join("\n"),
    [
      ...range(10000).map(
        (k) => `ALTER TABLE t_${k} ADD CONSTRAINT c CHECK (n > 0);`,
      ),
      ...range(10000).map((k) => `ALTER TABLE t_${k} DROP CONSTRAINT c;`),
    ].join("\n"),
    [
      ...range(5000).map((k) => `CREATE INDEX i ON s_${k}.t (n);`),
      ...range(5000).map((k) => `ALTER TABLE s_${k}.t RENAME TO u;`),
      ...range(5000).map((k) => `ALTER TABLE u RENAME TO t;`),
      ...range(5000).map((k) => `DROP INDEX s_${k}.i;`),
    ].join("\n"),
    // CHECKs that prove NOT NULL on a table renamed back and forth.
    [
      ...range(10000).map(
        (k) =>
          `ALTER TABLE t ADD CONSTRAINT n_${k} CHECK (c_${k} IS NOT NULL);`,
      ),
      ...range(10000).map((k) =>
        k % 2 ? "ALTER TABLE u RENAME TO t;" : "ALTER TABLE t RENAME TO u;",
      ),
    ].join("\n"),
  ];
  const started = performance.now();

  for (const sql of files) {
    lintMigrationSQL(sql);
  }

  // About 0.5 s in all; in 3.6.0 candidates before this, minutes.
  expect(performance.now() - started).toBeLessThan(5000);
});

test("SQL lint rates column constraints in ADD COLUMN, spelled-out truncating casts and USING NULL", () => {
  expect(
    lint(`ALTER TABLE t ADD COLUMN x int NOT NULL DEFAULT 99 REFERENCES u(id);
ALTER TABLE t ADD COLUMN y int DEFAULT 5 CHECK (y > 10);
ALTER TABLE t ADD COLUMN z int PRIMARY KEY;
ALTER TABLE t ADD COLUMN k text DEFAULT 'x' UNIQUE;
ALTER TABLE t ALTER COLUMN name TYPE varchar(2) USING name::pg_catalog.varchar(2);
ALTER TABLE t ALTER COLUMN name TYPE varchar(2) USING CAST(name AS "varchar"(2));
ALTER TABLE t ALTER COLUMN name TYPE text USING NULL::text;`).map(
      ([statement, level]) => [statement, level],
    ),
  ).toEqual([
    [1, "blocking"],
    [2, "blocking"],
    [3, "blocking"],
    [4, "blocking"],
    [5, "destructive"],
    [6, "destructive"],
    [7, "destructive"],
  ]);
  // Without a value for existing rows, REFERENCES, CHECK and UNIQUE see only
  // NULL and pass; an identity gives each row its own value.
  expect(
    lint(`ALTER TABLE t ADD COLUMN x int REFERENCES u(id);
ALTER TABLE t ADD COLUMN y int CHECK (y > 10);
ALTER TABLE t ADD COLUMN k text UNIQUE;
ALTER TABLE t ADD COLUMN n int GENERATED ALWAYS AS IDENTITY NOT NULL;
ALTER TABLE t ADD CONSTRAINT t_n_key UNIQUE (n);
CREATE UNIQUE INDEX t_k_idx ON t (k);
SET TIME ZONE 'UTC';
RESET TIME ZONE;`).map(([statement, level]) => [statement, level]),
  ).toEqual([
    [4, "caution"],
    [5, "caution"],
    [6, "caution"],
  ]);
});

test("a caution note counts only on the statements generate writes it on", () => {
  const NOTE = "-- symmetria: caution: generate knew better.\n";
  const levels = (sql: string) => lint(sql).map(([, level]) => level);
  const noted = (statement: string) => levels(`${NOTE}${statement};`);

  expect(noted('DROP INDEX "t_a_idx"')).toEqual(["caution"]);
  expect(noted('DROP INDEX CONCURRENTLY "t_a_idx"')).toEqual(["caution"]);
  expect(noted('ALTER TABLE "t" DROP CONSTRAINT "t_a_key"')).toEqual([
    "caution",
  ]);
  expect(noted('DROP TYPE "t_s_enum"')).toEqual(["caution"]);
  // A key added back after its drop in the same migration (a primary key,
  // also on a renamed table; a foreign key of the same name).
  expect(
    levels(`ALTER TABLE "t" DROP CONSTRAINT "t_pkey";
ALTER TABLE "t" RENAME TO "v";
${NOTE}ALTER TABLE "v" ADD CONSTRAINT "v_pkey" PRIMARY KEY ("b", "a");`).at(-1),
  ).toBe("caution");
  expect(
    levels(`ALTER TABLE "t" DROP CONSTRAINT "t_u_fkey";
${NOTE}ALTER TABLE "t" ADD CONSTRAINT "t_u_fkey" FOREIGN KEY ("u") REFERENCES "u" ("id") ON DELETE CASCADE;`),
  ).toEqual(["caution", "caution"]);
  // Anywhere else the note is a comment: a key with no drop on its table
  // before it, CHECK, UNIQUE, or what loses data.
  expect(
    noted('ALTER TABLE "t" ADD CONSTRAINT "t_pkey" PRIMARY KEY ("a")'),
  ).toEqual(["blocking"]);
  expect(
    levels(`ALTER TABLE "other" DROP CONSTRAINT "other_u_fkey";
${NOTE}ALTER TABLE "t" ADD CONSTRAINT "t_u_fkey" FOREIGN KEY ("u") REFERENCES "u" ("id");`).at(
      -1,
    ),
  ).toBe("blocking");
  expect(
    noted('ALTER TABLE "t" ADD CONSTRAINT "t_c_check" CHECK ("a" > 0)'),
  ).toEqual(["blocking"]);
  expect(
    noted('ALTER TABLE "t" ADD CONSTRAINT "t_a_key" UNIQUE ("a")'),
  ).toEqual(["blocking"]);
  expect(noted('DROP TABLE "t"')).toEqual(["destructive"]);
  expect(noted('ALTER TABLE "t" DROP COLUMN "a"')).toEqual(["destructive"]);
  expect(noted('DROP INDEX "t_a_idx" CASCADE')).toEqual(["destructive"]);
  expect(
    noted('ALTER TABLE "t" DROP CONSTRAINT "t_a_key", DROP COLUMN "a"'),
  ).toEqual(["destructive"]);
  expect(
    noted('ALTER TABLE "t" ALTER COLUMN "a" TYPE text USING NULL'),
  ).toEqual(["destructive"]);
});

test("a note counts only as a comment line, never inside a quoted name or a string", () => {
  const hidden = (note: string) => `\n-- symmetria: ${note}: hidden.\n`;

  // A name or a string that holds a line break and a note is no comment:
  // these statements lowered their own rating to a caution, or rated
  // themselves destructive with their own message.
  for (const statement of [
    `DROP INDEX "t_a_idx${hidden("caution")}"`,
    `DROP TYPE "t_s_enum${hidden("caution")}"`,
    `ALTER TABLE "t" DROP CONSTRAINT "t_a_key${hidden("caution")}"`,
  ]) {
    expect(lint(`${statement};`)).toEqual([
      [1, "destructive", "Removes data or a database object."],
    ]);
  }
  expect(lint(`UPDATE "t" SET "a" = '${hidden("destructive")}';`)).toEqual([
    [1, "caution", expect.stringContaining("Contains a schema change")],
  ]);
  // A comment line counts, also after another comment or a statement on the
  // line before it.
  expect(
    lint('-- dropped\n-- symmetria: caution: real.\nDROP INDEX "t_a_idx";'),
  ).toEqual([[1, "caution", "real."]]);
  expect(
    lint('SELECT 1;\n-- symmetria: caution: real.\nDROP TYPE "t_s_enum";').at(
      -1,
    ),
  ).toEqual([2, "caution", "real."]);
  expect(
    lint('-- symmetria: destructive: real.\nUPDATE "t" SET "a" = NULL;')[0],
  ).toEqual([1, "destructive", "real."]);
});

test("SQL lint takes only a whole constant in USING as emptying the column", () => {
  const retyped = (using: string) =>
    lint(`ALTER TABLE t ALTER COLUMN c TYPE text USING ${using};`).map(
      ([, level]) => level,
    );

  for (const constant of [
    "NULL",
    "(NULL)::text",
    "0",
    "'{}'::jsonb",
    "jsonb '{}'",
    "CAST(NULL AS text)",
    "timestamp with time zone '2024-01-01'",
  ]) {
    expect([constant, retyped(constant)]).toEqual([constant, ["destructive"]]);
  }

  // A column compared or converted with a literal keeps its values.
  for (const conversion of [
    "c AT TIME ZONE 'Europe/Paris'",
    "c LIKE 'y%'",
    "c IS DISTINCT FROM 'n'",
    "c SIMILAR TO 'x%'",
    "date AT TIME ZONE 'UTC'",
    "NULLIF(c, '')",
    "c || ''",
  ]) {
    expect([conversion, retyped(conversion)]).toEqual([
      conversion,
      ["caution"],
    ]);
  }
});

test("SQL lint forgets what it knew of an added column once a statement may write it", () => {
  const last = (sql: string) => lint(sql).at(-1)?.slice(1, 2)[0];

  // The backfill between ADD COLUMN and the key can make duplicates.
  expect(
    last(`ALTER TABLE t ADD COLUMN s text;
UPDATE t SET s = 'x';
ALTER TABLE t ADD CONSTRAINT t_s_key UNIQUE (s);`),
  ).toBe("blocking");
  expect(
    last(`ALTER TABLE t ADD COLUMN s text;
UPDATE t SET s = 'x';
CREATE UNIQUE INDEX t_s_idx ON t (s);`),
  ).toBe("blocking");
  expect(
    last(`ALTER TABLE t ADD COLUMN n serial;
UPDATE t SET n = 1;
ALTER TABLE t ADD PRIMARY KEY (n);`),
  ).toBe("blocking");
  // So can a type change with USING, and a DO block anywhere.
  expect(
    last(`ALTER TABLE t ADD COLUMN s text;
ALTER TABLE t ALTER COLUMN s TYPE varchar(10) USING 'x';
ALTER TABLE t ADD CONSTRAINT t_s_key UNIQUE (s);`),
  ).toBe("blocking");
  expect(
    last(`ALTER TABLE t ADD COLUMN s text;
DO $$ BEGIN UPDATE t SET s = 'x'; END $$;
ALTER TABLE t ADD CONSTRAINT t_s_key UNIQUE (s);`),
  ).toBe("blocking");
  // A foreign key on a column backfilled first checks the values it got.
  expect(
    last(`ALTER TABLE t ADD COLUMN u int;
UPDATE t SET u = 5;
ALTER TABLE t ADD CONSTRAINT t_u_fkey FOREIGN KEY (u) REFERENCES v (id);`),
  ).toBe("blocking");
  // An index, a default or another table's DDL write nothing.
  expect(
    last(`ALTER TABLE t ADD COLUMN s text;
CREATE INDEX t_id_idx ON t (id);
ALTER TABLE t ALTER COLUMN s SET DEFAULT 'x';
ALTER TABLE t ADD CONSTRAINT t_s_key UNIQUE (s);`),
  ).toBe("caution");
});

test("SQL lint counts only sequences and uuid generators as giving each existing row its own value", () => {
  const key = (definition: string) =>
    lint(`ALTER TABLE t ADD COLUMN k ${definition};
ALTER TABLE t ADD CONSTRAINT t_pkey PRIMARY KEY (k);`)
      .filter(([statement]) => statement === 2)
      .map(([, level]) => level);

  for (const distinct of [
    "uuid DEFAULT gen_random_uuid() NOT NULL",
    "uuid DEFAULT uuidv7() NOT NULL",
    "uuid DEFAULT public.uuid_generate_v4() NOT NULL",
    "bigint DEFAULT nextval('t_k_seq'::regclass) NOT NULL",
    "bigserial",
    "integer GENERATED ALWAYS AS IDENTITY NOT NULL",
  ]) {
    expect([distinct, key(distinct)]).toEqual([distinct, ["caution"]]);
  }

  // Evaluated per row, but the values repeat: rows written within one
  // microsecond share a clock_timestamp(), and a key over them fails.
  for (const repeating of [
    "timestamptz DEFAULT clock_timestamp() NOT NULL",
    "text DEFAULT timeofday() NOT NULL",
    "double precision DEFAULT random() NOT NULL",
    "text DEFAULT left(gen_random_uuid()::text, 2) NOT NULL",
    "bigint DEFAULT nextval('t_k_seq') % 2 NOT NULL",
  ]) {
    expect([repeating, key(repeating)]).toEqual([repeating, ["blocking"]]);
  }
});
