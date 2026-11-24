import { expect, test } from "bun:test";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { schema, table, int, text, index } from "../../../packages/runtime/src";
import {
  migrationSnapshot,
  diffSchemas,
  emptySnapshot,
} from "../../../packages/kit/src";
import {
  importClause,
  initializeProject,
} from "../../../packages/kit/src/cli/scaffold";
import {
  formatDiff,
  formatSchema,
} from "../../../packages/kit/src/cli/ui/format";
import { resolveRenames } from "../../../packages/kit/src/cli/screens/rename-prompt";
import {
  confirmRollback,
  databaseName,
  rollbackPreview,
  rollbackSummary,
} from "../../../packages/kit/src/cli/screens/rollback-prompt";
import { withMigrationDirectory } from "../../support/directories";

const run = async (directory: string, ...argumentsList: string[]) => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("packages/kit/src/cli/index.ts"),
      ...argumentsList,
    ],
    {
      cwd: directory,
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

test("noninteractive generation requires destructive opt-in and lint still fails after generation", () =>
  withMigrationDirectory(async (directory) => {
    const config = join(directory, "symmetria.config.ts");

    const save = (snapshot: unknown) =>
      writeFile(
        config,
        `export default ${JSON.stringify({ schema: snapshot, directory: "migrations" })};`,
      );

    await save(
      schema({ records: { id: int, email: text.nullable } }).$snapshot(),
    );
    expect(
      (await run(directory, "generate", "initial", "--no-interactive"))
        .exitCode,
    ).toBe(0);
    await save(
      schema({ records: { id: int, mail: text.nullable } }).$snapshot(),
    );
    expect(
      (await run(directory, "generate", "mail", "--no-interactive")).exitCode,
    ).toBe(1);
    expect(
      (await run(directory, "generate", "mail", "--allow-destructive"))
        .exitCode,
    ).toBe(0);
    const lint = await run(directory, "lint", "--json");
    expect(lint.exitCode).toBe(1);
    expect(JSON.parse(lint.stdout).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "destructive", table: "000002_mail" }),
      ]),
    );
    await writeFile(config, 'export default { directory: "migrations" };');
    expect((await run(directory, "lint")).exitCode).toBe(1);
  }));

test("strict lint passes a fresh initial migration with unique keys, indexes and foreign keys", () =>
  withMigrationDirectory(async (directory) => {
    const users = table({ id: int.auto, email: text.unique }).indexes(
      (users) => ({ byEmail: index(users.email) }),
    );
    const posts = table({
      id: int.auto,
      author: users.index,
      slug: text,
    }).indexes((posts) => ({ bySlug: index(posts.slug).unique }));
    await writeFile(
      join(directory, "symmetria.config.ts"),
      `export default ${JSON.stringify({
        schema: schema({ users, posts }).$snapshot(),
        directory: "migrations",
      })};`,
    );
    expect(
      (await run(directory, "generate", "initial", "--no-interactive"))
        .exitCode,
    ).toBe(0);
    const lint = await run(directory, "lint", "--strict", "--json");
    expect(JSON.parse(lint.stdout)).toEqual({ findings: [] });
    expect(lint.exitCode).toBe(0);
  }));

test("init scaffolds an importable offline schema and preserves existing files", () =>
  withMigrationDirectory(async (directory) => {
    expect((await run(directory, "init", "--json")).exitCode).toBe(0);
    // Use the workspace's source aliases in the generated test project.
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({ extends: resolve("tsconfig.json") }),
    );
    const inspected = await run(directory, "inspect", "users", "--json");
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout).tables[0].name).toBe("users");
    expect(
      await readFile(join(directory, "src/database/index.ts"), "utf8"),
    ).toContain(
      "createDatabase({\n  schema: appSchema,\n  driver: postgres({ url }),\n})",
    );
    const original = await readFile(
      join(directory, "symmetria.config.ts"),
      "utf8",
    );
    expect(await initializeProject(directory)).toEqual([]);
    const repeated = await run(directory, "init");
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toContain("nothing to create");
    expect(repeated.stderr).toBe("");
    expect(await readFile(join(directory, "symmetria.config.ts"), "utf8")).toBe(
      original,
    );
    expect(
      (await run(directory, "generate", "initial", "--json")).exitCode,
    ).toBe(0);
    expect((await run(directory, "diff")).stdout.trim()).toBe(
      "No schema changes.",
    );
  }));

test("init preserves existing files while creating the missing scaffold", () =>
  withMigrationDirectory(async (directory) => {
    const environment = "DATABASE_URL=postgres://localhost/existing\n";
    const users = "export const users = { existing: true };\n";
    await mkdir(join(directory, "src/database/tables"), { recursive: true });
    await writeFile(join(directory, ".env.example"), environment);
    await writeFile(join(directory, "src/database/tables/users.ts"), users);
    const result = await run(directory, "init", "--json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual([
      "src/database/schema.ts",
      "src/database/index.ts",
      "symmetria.config.ts",
    ]);
    expect(await readFile(join(directory, ".env.example"), "utf8")).toBe(
      environment,
    );
    expect(
      await readFile(join(directory, "src/database/tables/users.ts"), "utf8"),
    ).toBe(users);
  }));

test("init wires the config to an existing schema module's export, or creates nothing when it has none", () =>
  withMigrationDirectory(async (directory) => {
    const wired = join(directory, "wired");
    await mkdir(join(wired, "src/database"), { recursive: true });
    await writeFile(
      join(wired, "tsconfig.json"),
      JSON.stringify({ extends: resolve("tsconfig.json") }),
    );
    // The application's own schema module, exported under another name.
    const own = `import { schema, table, int, text } from "symmetria";\nexport const schemaV1 = schema({ accounts: table({ id: int.auto, name: text }) });\n`;
    await writeFile(join(wired, "src/database/schema.ts"), own);

    const result = await run(wired, "init", "--json");
    expect(result.exitCode, result.stderr).toBe(0);
    // The starter table only serves the starter schema: not written.
    expect(JSON.parse(result.stdout).files).toEqual([
      "src/database/index.ts",
      "symmetria.config.ts",
      ".env.example",
    ]);
    expect(
      await readFile(join(wired, "symmetria.config.ts"), "utf8"),
    ).toContain(
      'import { schemaV1 as appSchema } from "./src/database/schema";',
    );
    expect(await readFile(join(wired, "src/database/schema.ts"), "utf8")).toBe(
      own,
    );
    const inspected = await run(wired, "inspect", "--json");
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout).tables[0].name).toBe("accounts");

    // No schema to import: nothing is created, and the message says what to add.
    const unusable = join(directory, "unusable");
    await mkdir(join(unusable, "src/database"), { recursive: true });
    await writeFile(
      join(unusable, "src/database/schema.ts"),
      "export const tables = {};\n",
    );
    const refused = await run(unusable, "init", "--json");
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.message).toContain(
      "nothing was created. Export your schema as appSchema",
    );
    expect(await readdir(unusable)).toEqual(["src"]);
    expect(await readdir(join(unusable, "src/database"))).toEqual([
      "schema.ts",
    ]);
  }));

test("init reads an existing schema module as code: strings and comments do not hide or invent exports", () => {
  const clause = (source: string) =>
    importClause(source, "appSchema", "schema");

  // A string holding "/*" opens no comment.
  expect(
    clause(
      'export const pattern = "tables/*.ts";\nexport const appSchema = schema({});\n/* old */\nexport const legacy = schema({});\n',
    ),
  ).toBe("{ appSchema }");
  // A template mentioning the export is not the export.
  expect(
    clause(
      "export const hint = `export const appSchema = schema(...)`;\nexport const db = schema({});\n",
    ),
  ).toBe("{ db as appSchema }");
  expect(
    clause("// export const appSchema\nexport const v1 = schema({});"),
  ).toBe("{ v1 as appSchema }");
  expect(
    clause('const re = /\\/*"/;\nexport const appSchema = schema({});'),
  ).toBe("{ appSchema }");
  // A default export, also through a binding; one value exported twice is one.
  expect(clause("const db = schema({});\nexport default db;\n")).toBe(
    "appSchema",
  );
  expect(clause("export default schema({});")).toBe("appSchema");
  expect(clause("export const db = schema({});\nexport default db;")).toBe(
    "{ db as appSchema }",
  );
  expect(clause("const x = schema({});\nexport { x as main };")).toBe(
    "{ main as appSchema }",
  );
  // A declaration without an initializer is not the next one's type.
  expect(
    clause(
      "export let current: string | undefined;\n\nexport const db = schema({});\n",
    ),
  ).toBe("{ db as appSchema }");
  // Only top-level forms count: a namespace or `declare module` holds none.
  expect(
    clause(
      "export namespace legacy { export const appSchema = schema({}); }\nexport const db = schema({});",
    ),
  ).toBe("{ db as appSchema }");
  expect(
    clause(
      'declare module "x" { export const appSchema: unknown; }\nexport const db = schema({});',
    ),
  ).toBe("{ db as appSchema }");
  // Types and ambient declarations hold no value.
  expect(
    clause(
      "export interface appSchema { x: 1 }\nexport declare const build: string;\nexport const db = schema({});",
    ),
  ).toBe("{ db as appSchema }");
  expect(clause("export const схема = schema({});")).toBe(
    "{ схема as appSchema }",
  );
  // Unsure: two schemas, or a literal that does not end.
  expect(
    clause("export const a = schema({}), b = schema({});"),
  ).toBeUndefined();
  expect(
    clause("export const схема = schema({});\nexport const db = schema({});"),
  ).toBeUndefined();
  expect(
    clause('const s = schema({});\nexport { s as "appSchema" };'),
  ).toBeUndefined();
  expect(
    clause('export * from "./more";\nexport const db = schema({});'),
  ).toBeUndefined();
  expect(
    clause("export const config = { appSchema: schema({}) };"),
  ).toBeUndefined();
  expect(
    clause(
      "const schema = (x: unknown) => x;\nexport const fake = schema({});",
    ),
  ).toBeUndefined();
  expect(
    clause("export enum appSchema { A }\nexport const db = schema({});"),
  ).toBeUndefined();
  expect(
    clause("export const a = schema({});\nexport const b = schema({});"),
  ).toBeUndefined();
  expect(
    clause("export const s = 'open\nexport const appSchema = schema({});"),
  ).toBeUndefined();
});

test("a bad timeout or database URL names the config key or the flag it came from", () =>
  withMigrationDirectory(async (directory) => {
    await writeFile(
      join(directory, "symmetria.config.ts"),
      `export default { directory: "migrations", lockTimeoutMs: -5 };\n`,
    );
    const fromConfig = await run(directory, "status", "--json");
    expect(fromConfig.exitCode).toBe(1);
    expect(JSON.parse(fromConfig.stdout).error.message).toBe(
      "symmetria: invalid lockTimeoutMs in the config: expected whole milliseconds from 0 to 2147483647",
    );

    await writeFile(
      join(directory, "symmetria.config.ts"),
      `export default { directory: "migrations" };\n`,
    );
    // An empty flag is not 0, which would disable the timeout.
    const empty = await run(
      directory,
      "status",
      "--lock-timeout=",
      "--database-url",
      "postgres://127.0.0.1:1/app",
      "--json",
    );
    expect(JSON.parse(empty.stdout).error.message).toBe(
      "symmetria: --lock-timeout needs a value",
    );
    // So does every flag that takes one: `--to ""` is not "no --to".
    for (const flags of [
      ["migrate", "--to", ""],
      ["rollback", "--yes", "--steps", ""],
      ["status", "--ignore-table", ""],
    ]) {
      const refused = await run(directory, ...flags, "--json");
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout).error.message).toBe(
        `symmetria: ${flags.at(-2)} needs a value`,
      );
    }

    const url = await run(
      directory,
      "status",
      "--database-url",
      "not a url",
      "--json",
    );
    expect(JSON.parse(url.stdout).error.message).toBe(
      "symmetria: invalid database URL in --database-url: expected postgres://user:password@host:5432/database",
    );
  }));

test("init does not introduce a second schema into a configured project or migration history", () =>
  withMigrationDirectory(async (directory) => {
    for (const name of [
      "symmetria.config.ts",
      "migrations.config.ts",
      "migrations",
    ]) {
      const project = join(directory, name.replaceAll(".", "_"));
      await mkdir(project);

      if (name === "migrations") {
        await mkdir(join(project, "migrations/000001_initial"), {
          recursive: true,
        });
      } else {
        await writeFile(
          join(project, name),
          "export default { schema: existingSchema };\n",
        );
      }

      const result = await run(project, "init", "--json");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).files).toEqual([]);
      expect(await readdir(project)).toEqual([name]);
    }
  }));

test("init prints portable commands for the official CLI package", () =>
  withMigrationDirectory(async (directory) => {
    const result = await run(directory, "init");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "bunx --package symmetria-kit symmetria generate initial",
    );
    expect(result.stdout).toContain(
      "bunx --package symmetria-kit symmetria migrate",
    );
  }));

test("diff and inspect are offline, support SQL and JSON, and expose relations and constraints", () =>
  withMigrationDirectory(async (directory) => {
    const model = schema({
      users: { id: int, name: text },
      posts: ({ users }) =>
        table({ id: int, author: users, title: text })
          .indexes((posts) => ({ title: index(posts.title) }))
          .checks((posts) => ({ title: posts.title.isNot("") })),
    });
    await writeFile(
      join(directory, "symmetria.config.ts"),
      `export default { schema: ${JSON.stringify(model.$snapshot())}, directory: "migrations" };`,
    );
    const diff = await run(directory, "diff");
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain("+ posts");
    expect(diff.stdout).toContain("CHECK");
    const sql = await run(directory, "diff", "--sql");
    expect(sql.stdout).toContain('CREATE TABLE "posts"');
    expect(sql.stdout).toContain('REFERENCES "users" ("id")');
    expect(
      JSON.parse((await run(directory, "diff", "--json")).stdout).up,
    ).toEqual(diffSchemas(emptySnapshot(), model.$snapshot()).up);
    expect(
      (await run(directory, "inspect", "posts", "--relations")).stdout,
    ).toContain("posts.author ── users");
    expect((await run(directory, "inspect", "missing")).exitCode).toBe(1);
    expect((await run(directory, "diff", "--sql", "--json")).exitCode).toBe(1);
    expect((await run(directory)).stdout).toContain("inspect [table]");

    // Every --json success is one object, never a bare array.
    expect(
      JSON.parse(
        (await run(directory, "inspect", "posts", "--relations", "--json"))
          .stdout,
      ),
    ).toMatchObject({ tables: [{ name: "posts", relations: {} }] });
    expect(
      JSON.parse((await run(directory, "lint", "--json")).stdout),
    ).toMatchObject({ findings: expect.any(Array) });

    // --online previews the online SQL in diff, as generate writes it.
    expect(
      (await run(directory, "diff", "--sql", "--online")).stdout,
    ).toContain('CREATE INDEX CONCURRENTLY "posts_title_idx"');
    expect((await run(directory, "squash", "x", "--online")).stderr).toContain(
      "--online is a generate/diff/lint option",
    );
  }));

test("interactive rename decisions generate actual renames and support cancellation", async () => {
  const before = migrationSnapshot(
    schema({ posts: { id: int, name: text } }).$snapshot(),
  );
  const after = migrationSnapshot(
    schema({ posts: { id: int, title: text } }).$snapshot(),
  );
  const options = await resolveRenames(
    before,
    after,
    async (question, choices) => {
      expect(question).toContain("posts.name");
      expect(choices[0]).toBe("Rename name → title");

      return 0;
    },
  );
  expect(diffSchemas(before, after, options).up).toEqual([
    'ALTER TABLE "posts" RENAME COLUMN "name" TO "title"',
  ]);
  expect(
    formatDiff(diffSchemas(before, after, options), false, options.renames),
  ).toContain("~ name → title");
  const separate = await resolveRenames(
    before,
    after,
    async (_question, choices) => choices.length - 1,
  );
  expect(diffSchemas(before, after, separate).up.join("\n")).toContain(
    "DROP COLUMN",
  );
  await expect(
    resolveRenames(before, after, async () => undefined),
  ).rejects.toThrow(/cancelled/);
  const renamedTable = migrationSnapshot(
    schema({ articles: { id: int, name: text } }).$snapshot(),
  );
  const tables = await resolveRenames(before, renamedTable, async () => 0);
  expect(diffSchemas(before, renamedTable, tables).up.join("\n")).toContain(
    'RENAME TO "articles"',
  );
});

test("rollback asks before down.sql runs and wants the database name before dropping tables", async () => {
  const column = rollbackSummary([
    {
      id: "000002_reference",
      statements: [
        'ALTER TABLE "products" RENAME COLUMN "name" TO "title"',
        'ALTER TABLE "orders" DROP COLUMN "reference"',
      ],
    },
  ]);

  expect(column).toEqual({
    migrations: ["000002_reference"],
    statements: 2,
    destructive: ['ALTER TABLE "orders" DROP COLUMN "reference"'],
    droppedTables: 0,
    emptiedTables: 0,
  });
  expect(rollbackPreview(column, "shop")).toContain(
    'Rollback on "shop": 000002_reference',
  );

  const written: string[] = [];
  const prompts = (choice: number | undefined, typed = "") => ({
    write: (text: string) => void written.push(text),
    select: async (question: string, choices: readonly string[]) => {
      expect(question).toBe('Roll back 1 migration on "shop"?');
      // Cancel comes first, so Enter alone changes nothing.
      expect(choices).toEqual(["Cancel", "Roll back"]);

      return choice;
    },
    ask: async () => typed,
  });

  expect(await confirmRollback(column, "shop", prompts(1))).toBe(true);
  expect(await confirmRollback(column, "shop", prompts(0))).toBe(false);
  expect(await confirmRollback(column, "shop", prompts(undefined))).toBe(false);
  expect(written.join("")).toContain('DROP COLUMN "reference"');

  const baseline = rollbackSummary([
    {
      id: "000001_baseline",
      statements: ['DROP TABLE "orders"', 'DROP TABLE "users"'],
    },
  ]);

  expect(baseline.droppedTables).toBe(2);
  // A comment in front of the statement does not hide it.
  expect(
    rollbackSummary([
      {
        id: "000001_baseline",
        statements: ['-- remove orders\nDROP TABLE "orders"'],
      },
    ]).droppedTables,
  ).toBe(1);
  // TRUNCATE and DROP SCHEMA remove whole tables too.
  const emptied = rollbackSummary([
    {
      id: "000003_reset",
      statements: ['TRUNCATE "orders"', 'DROP SCHEMA "archive" CASCADE'],
    },
  ]);

  expect(emptied).toMatchObject({ droppedTables: 0, emptiedTables: 2 });
  expect(
    await confirmRollback(emptied, "shop", {
      write: () => {},
      select: async () => {
        throw new Error("the menu must not be used");
      },
      ask: async (question) => {
        expect(question).toContain("This drops or empties whole tables");

        return "shop";
      },
    }),
  ).toBe(true);
  // Dropping tables never goes through the two-item menu.
  const typed = (answer: string) =>
    confirmRollback(baseline, "shop", {
      write: () => {},
      select: async () => {
        throw new Error("the menu must not be used");
      },
      ask: async (question) => {
        expect(question).toContain('Type the database name "shop"');

        return answer;
      },
    });

  expect(await typed("shop")).toBe(true);
  expect(await typed("")).toBe(false);
  expect(await typed("yes")).toBe(false);
  expect(
    databaseName("postgres://u:p@127.0.0.1:5432/shop?sslmode=require"),
  ).toBe("shop");
});

test("schema display includes physical names and expression index details", () => {
  const model = schema({
    userProfiles: table({ id: int, displayName: text }).indexes((profiles) => ({
      name: index(profiles.displayName).unique,
    })),
  });
  expect(formatSchema(model.$snapshot())).toContain(
    "userProfiles (user_profiles)",
  );
  expect(formatDiff(diffSchemas(emptySnapshot(), model.$snapshot()))).toContain(
    "UNIQUE btree",
  );
});

test("pull needs a connection and keeps --force to itself", () =>
  withMigrationDirectory(async (directory) => {
    const missing = await run(directory, "pull");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(
      "no database: set databaseUrl in the config, DATABASE_URL or --database-url",
    );

    const scoped = await run(directory, "drift", "--force");
    expect(scoped.exitCode).toBe(1);
    expect(scoped.stderr).toContain("--force is a pull/graph/discard option");
  }));

test("graph prints a Mermaid diagram offline and writes fenced Markdown", () =>
  withMigrationDirectory(async (directory) => {
    const model = schema({
      users: { id: int, name: text.unique },
      posts: ({ users }) =>
        table({
          id: int,
          author: users,
          editor: users.nullable.inverse("edited"),
          title: text,
        }),
    });
    await writeFile(
      join(directory, "symmetria.config.ts"),
      `export default { schema: ${JSON.stringify(model.$snapshot())}, directory: "migrations" };`,
    );
    const printed = await run(directory, "graph");
    expect(printed.exitCode, printed.stderr).toBe(0);
    expect(printed.stdout).toContain("erDiagram");
    expect(printed.stdout).toContain("users ||..o{ posts : author");
    expect(printed.stdout).toContain("users |o..o{ posts : editor");
    expect(printed.stdout).toContain("text name UK");

    const compact = await run(directory, "graph", "--compact");
    expect(compact.stdout).not.toContain("UK");

    const written = await run(directory, "graph", "docs/schema.md");
    expect(written.exitCode, written.stderr).toBe(0);
    const file = await readFile(join(directory, "docs/schema.md"), "utf8");
    expect(file.startsWith("```mermaid\nerDiagram")).toBe(true);
    expect(file.endsWith("```\n")).toBe(true);
    expect((await run(directory, "graph", "docs/schema.md")).exitCode).toBe(1);
    expect(
      (await run(directory, "graph", "docs/schema.md", "--force")).exitCode,
    ).toBe(0);
    expect(
      JSON.parse((await run(directory, "graph", "--json")).stdout).edges,
    ).toHaveLength(2);
  }));
