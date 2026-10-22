import { expect, test } from "bun:test";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { schema, table, int, text, index } from "../../../packages/runtime/src";
import {
  migrationSnapshot,
  diffSchemas,
  emptySnapshot,
} from "../../../packages/kit/src";
import { initializeProject } from "../../../packages/kit/src/cli/init";
import { formatDiff, formatSchema } from "../../../packages/kit/src/cli/format";
import { resolveRenames } from "../../../packages/kit/src/cli/renames";
import { withMigrationDirectory } from "../../support/directories";

const run = async (directory: string, ...argumentsList: string[]) => {
  const child = Bun.spawn(
    [process.execPath, resolve("packages/kit/src/cli.ts"), ...argumentsList],
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
      "createDatabase({\n  schema: appSchema,\n  driver: postgres(url),\n})",
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
