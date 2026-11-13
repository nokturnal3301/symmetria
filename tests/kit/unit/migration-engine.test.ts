import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  bigint,
  text,
  varchar,
  numeric,
  timestamptz,
  oneOf,
  customType,
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
    },
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot());
  const retype = (column: string) =>
    plan.up.find((sql) => sql.includes(`ALTER COLUMN "${column}" TYPE`));

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
    'ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(5) USING left("name", 5)',
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
