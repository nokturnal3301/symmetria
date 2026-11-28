import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
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
  formatDashboard,
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
import { postgres } from "../../support/postgres";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

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

test(
  "a bad timeout or database URL names the config key or the flag it came from",
  () =>
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

      // Text with the `postgres://` forgotten is a URL to a parser too, with
      // `localhost:` or `app:` for a scheme; node-postgres would find no host
      // in it and connect to localhost, the wrong server.
      for (const text of [
        "localhost:55451/postgres",
        "db.example.invalid:6543/app",
        "app:secretpw@192.0.2.1:6543/app",
        "postgres:app",
        "postgres:/app",
        "mysql://app:secretpw@127.0.0.1:1/app",
      ]) {
        for (const [command, flag] of [
          ["status", "--database-url"],
          ["verify", "--verify-url"],
          ["adopt", "--verify-url"],
        ] as const) {
          const refused = await run(
            directory,
            command,
            flag,
            text,
            // For adopt, whose own database is not what is checked here.
            ...(command === "adopt"
              ? ["--database-url", "postgres://127.0.0.1:1/app"]
              : []),
            "--connect-timeout",
            "2000",
          );

          // Where the value came from, and never the value: it holds a password.
          expect(refused).toEqual({
            exitCode: 1,
            stdout: "",
            stderr: `symmetria: invalid database URL in ${flag}: expected postgres://user:password@host:5432/database\n`,
          });
        }
      }

      // Every form that names its server is still read: these get as far as
      // the connection, which nothing accepts.
      for (const text of [
        "postgres://app:p%40ss%2Fword@127.0.0.1:1/app",
        "postgresql://127.0.0.1:1/app",
        "POSTGRES://127.0.0.1:1/app",
        "postgres://[::1]:1/app",
        "postgres:///app?host=/nonexistent/socket/directory",
        "postgres://app:secretpw@/app?host=/nonexistent/socket/directory",
        "/nonexistent/socket/directory",
        "socket:/nonexistent/socket/directory?db=app",
      ]) {
        const tried = await run(
          directory,
          "status",
          "--database-url",
          text,
          "--connect-timeout",
          "2000",
        );

        expect(tried.exitCode).toBe(1);
        expect(tried.stderr).not.toContain("invalid database URL");
        expect(tried.stderr).toMatch(
          /ECONNREFUSED|ENOENT|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH/,
        );
        expect(tried.stderr).not.toContain("secretpw");
      }

      // Milliseconds are plain digits: 1e3 and 0x10 are not 1000 and 16.
      for (const flag of [
        "--lock-timeout",
        "--statement-timeout",
        "--advisory-lock-timeout",
        "--connect-timeout",
      ]) {
        for (const value of ["1e3", "0x10", "1.5", "2147483648"]) {
          const refused = await run(directory, "status", flag, value, "--json");
          expect(refused.exitCode).toBe(1);
          expect(JSON.parse(refused.stdout).error.message).toBe(
            `symmetria: invalid ${flag} "${value}": expected whole milliseconds from 0 to 2147483647`,
          );
        }
      }

      // So is a number of migrations; "abc" used to reach the runner as NaN.
      for (const value of ["abc", "1e1", "0", "1.0"]) {
        const refused = await run(
          directory,
          "rollback",
          "--plan",
          "--steps",
          value,
          "--json",
        );
        expect(JSON.parse(refused.stdout).error.message).toBe(
          `symmetria: invalid --steps "${value}": expected a whole number of migrations, 1 or more`,
        );
      }

      // After "--" a word is an argument, not the flag: the error is not JSON.
      const argument = await run(directory, "status", "--", "--json");
      expect(argument).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "symmetria: unexpected positional arguments\n",
      });
    }),
  30_000,
);

test("wrong input in a config or a flag's file is refused with a message that names it", () =>
  withMigrationDirectory(async (directory) => {
    const real = await realpath(directory);
    const config = (body: string) =>
      writeFile(join(directory, "symmetria.config.ts"), body);
    const failure = async (...argumentsList: string[]) => {
      const result = await run(directory, ...argumentsList, "--json");

      expect(result.exitCode).toBe(1);

      return JSON.parse(result.stdout).error.message as string;
    };
    const model = JSON.stringify(
      schema({ records: { id: int, name: text } }).$snapshot(),
    );

    await config(
      `export default { schema: ${model}, directory: "migrations" };`,
    );
    await writeFile(join(directory, "null.json"), "null");
    await writeFile(join(directory, "list.json"), "[]");
    await writeFile(join(directory, "broken.json"), "{ nope");
    expect(await failure("diff", "--diff", "null.json")).toBe(
      `symmetria: the --diff file ${join(real, "null.json")} must hold a JSON object with rename hints and USING conversions, such as {"renames": {"columns": {"posts": {"title": "headline"}}}}; it holds null`,
    );
    expect(await failure("generate", "x", "--diff", "list.json")).toEndWith(
      "; it holds an array",
    );
    expect(await failure("lint", "--diff", "broken.json")).toStartWith(
      `symmetria: the --diff file ${join(real, "broken.json")} is not valid JSON (`,
    );
    expect(await failure("diff", "--diff", "absent.json")).toStartWith(
      `symmetria: cannot read the --diff file ${join(real, "absent.json")} (`,
    );
    // Read before the first connection is opened.
    const repair = [
      "repair",
      "000001_initial",
      "--action",
      "retry",
      "--database-url",
      "postgres://127.0.0.1:1/app",
      "--dir",
      ".",
      "--snapshot",
    ];
    expect(await failure(...repair, "broken.json")).toStartWith(
      `symmetria: the --snapshot file ${join(real, "broken.json")} is not valid JSON (`,
    );
    expect(await failure(...repair, "null.json")).toStartWith(
      `symmetria: the --snapshot file ${join(real, "null.json")} is not a migration snapshot such as meta/snapshot.json (`,
    );

    await config("export default { directory: 5 };");
    expect(await failure("diff")).toBe(
      'symmetria: invalid directory in the config: expected a path such as "./migrations"',
    );
    // null is "not set", like undefined: the default directory.
    await config(
      `export default { schema: ${model}, directory: null, databaseUrl: null };`,
    );
    expect(await run(directory, "generate", "initial")).toMatchObject({
      exitCode: 0,
      stdout: "Generated 000001_initial\n",
    });
    expect(await readdir(join(directory, "migrations"))).toContain(
      "000001_initial",
    );
    await rm(join(directory, "migrations"), { recursive: true });
    await config('export default { databaseUrl: 5, directory: "migrations" };');
    expect(await failure("status")).toBe(
      "symmetria: invalid database URL in databaseUrl in the config: expected a string such as postgres://user:password@host:5432/database",
    );
    // A command that opens no connection does not read it.
    expect((await run(directory, "lint")).exitCode).toBe(0);
    await config('export default { schema: {}, directory: "migrations" };');

    for (const command of [["diff"], ["inspect"], ["generate", "x"]]) {
      expect(await failure(...command)).toBe(
        "symmetria: invalid schema in the config: expected a schema() value, or the snapshot its $snapshot() returns",
      );
    }

    // A Promise or an array is an object, and read as a config without a setting.
    for (const [body, found] of [
      [
        "export default Promise.resolve({});",
        "exports a Promise, which is not awaited",
      ],
      ["export default [];", "exports an array"],
      ["export default () => ({});", "exports a function"],
      ["export const config = {};", "has no default export"],
    ] as const) {
      await config(body);
      expect(await failure("diff")).toBe(
        `symmetria: ${join(real, "symmetria.config.ts")} must default-export a migration configuration object, as in "export default defineMigrationConfig({ schema, directory })"; it ${found}`,
      );
    }
  }));

test("a migrations directory that does not exist is a wrong path, or a project before its first generate", () =>
  withMigrationDirectory(async (directory) => {
    const real = await realpath(directory);
    const failure = async (...argumentsList: string[]) => {
      const result = await run(directory, ...argumentsList, "--json");

      expect(result.exitCode).toBe(1);

      return JSON.parse(result.stdout).error.message as string;
    };

    // No config file and no ./migrations: the command runs in the wrong place.
    for (const command of [
      ["migrate"],
      ["status"],
      ["lint", "--strict"],
      ["recover"],
      ["squash", "base"],
    ]) {
      expect(await failure(...command)).toBe(
        `symmetria: no config file was found in the current directory (looked for ${join(real, "symmetria.config.ts")}), and there is no migrations directory at ${join(real, "migrations")} either; run the command in the project's directory, or pass --config <file> or --dir <directory>`,
      );
    }

    const config = join(directory, "symmetria.config.ts");
    await writeFile(
      config,
      `export default { schema: ${JSON.stringify(schema({ records: { id: int } }).$snapshot())}, directory: "migrations" };`,
    );

    // A directory named with --dir must be there for whatever reads it.
    for (const command of [
      ["migrate"],
      ["status"],
      ["rollback", "--yes"],
      ["verify"],
      ["adopt"],
      ["drift"],
      ["lint"],
      ["squash", "base"],
      ["discard"],
      ["recover"],
    ]) {
      expect(await failure(...command, "--dir", "migratoins")).toBe(
        `symmetria: the migrations directory ${join(real, "migratoins")} (--dir) does not exist`,
      );
    }

    // Under a config file the project is new: exit 0, and the reason is said.
    const note = `No migrations yet: the migrations directory ${join(real, "migrations")} does not exist. "symmetria generate <name>" creates the first migration.\n`;

    for (const command of [["recover"], ["squash", "base"]]) {
      expect(await run(directory, ...command)).toEqual({
        exitCode: 0,
        stdout: note,
        stderr: "",
      });
    }

    expect(
      JSON.parse((await run(directory, "squash", "base", "--json")).stdout),
    ).toEqual({ id: null, missingDirectory: join(real, "migrations") });
    expect(
      JSON.parse((await run(directory, "recover", "--json")).stdout),
    ).toEqual({ recovered: false, missingDirectory: join(real, "migrations") });
    expect(await failure("discard", "--force")).toBe(
      `symmetria: there is no migration to discard: the migrations directory ${join(real, "migrations")} does not exist`,
    );
    // Asking created nothing.
    expect(await readdir(directory)).toEqual(["symmetria.config.ts"]);

    // What needs no migrations works without the directory, also a named one.
    expect((await run(directory, "lint", "--strict")).exitCode).toBe(0);

    for (const command of [["diff"], ["inspect", "--json"], ["graph"]]) {
      expect(
        (await run(directory, ...command, "--dir", "migratoins")).exitCode,
      ).toBe(0);
    }

    expect(
      (await run(directory, "generate", "initial", "--dir", "made")).exitCode,
    ).toBe(0);
    expect(await readdir(join(directory, "made"))).toContain("000001_initial");

    // Without a config file an existing ./migrations is the project, as before.
    await rm(config);
    await mkdir(join(directory, "migrations"));
    expect(await run(directory, "recover")).toMatchObject({
      exitCode: 0,
      stdout: "Nothing to recover: no generation lock was left behind.\n",
    });
  }));

test("a database that does not answer ends the command at the connection timeout, and Ctrl-C before any connection exits at once", async () => {
  // Accepts connections and never answers, as a host behind a firewall that
  // drops packets looks to the client.
  const silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {} },
  });
  const url = `postgres://user:secret@127.0.0.1:${silent.port}/app`;

  try {
    await withMigrationDirectory(async (directory) => {
      await mkdir(join(directory, "migrations"));

      for (const command of [
        ["status"],
        ["migrate"],
        ["lint", "--pending"],
        ["pull", "pulled.ts"],
      ]) {
        const started = performance.now();
        const result = await run(
          directory,
          ...command,
          "--database-url",
          url,
          "--connect-timeout",
          "300",
          "--json",
        );

        expect(result.exitCode).toBe(1);
        // The host and the port, never the password.
        expect(JSON.parse(result.stdout).error.message).toBe(
          `symmetria: no connection to the database: 127.0.0.1:${silent.port} did not answer within 300ms (--connect-timeout <ms> sets the limit; 0 waits as long as the operating system does)`,
        );
        expect(performance.now() - started).toBeLessThan(4000);
      }

      // The server of the disposable verification databases has the same limit.
      const started = performance.now();
      const verified = await run(
        directory,
        "verify",
        "--verify-url",
        url,
        "--connect-timeout",
        "300",
        "--json",
      );

      expect(verified.exitCode).toBe(1);
      expect(JSON.parse(verified.stdout).error.message).toBe(
        `symmetria: no connection to the verification server: 127.0.0.1:${silent.port} did not answer within 300ms`,
      );
      expect(performance.now() - started).toBeLessThan(4000);

      // No limit, and the first connection never opens: nothing has reached
      // the server, so the interrupt has nothing to wait for (work under way
      // gets five seconds to stop). The same for either server.
      for (const [command, flag, server] of [
        ["status", "--database-url", "database"],
        ["verify", "--verify-url", "verification server"],
      ] as const) {
        const child = Bun.spawn(
          [
            process.execPath,
            resolve("packages/kit/src/cli/index.ts"),
            command,
            flag,
            url,
            "--connect-timeout",
            "0",
          ],
          {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, DATABASE_URL: "", NO_COLOR: "1" },
          },
        );

        await Bun.sleep(800);
        const interrupted = performance.now();
        child.kill("SIGINT");
        const [stderr, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);

        expect(exitCode).toBe(130);
        expect(stderr).toBe(
          `symmetria: interrupted: exited before a connection to the ${server} was made; nothing was sent\n`,
        );
        expect(performance.now() - interrupted).toBeLessThan(2500);
      }
    });
  } finally {
    silent.stop(true);
  }
}, 30000);

test.skipIf(!databaseUrl)(
  "with a database: a new project is not reported as up to date, rollback --plan with nothing applied succeeds, and discard repairs a deleted migration",
  async () => {
    const name = `cli_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const admin = postgres({ url: databaseUrl!, max: 1 });
    const address = new URL(databaseUrl!);

    address.pathname = `/${name}`;
    await admin.execute({ sql: `CREATE DATABASE "${name}"`, parameters: [] });

    try {
      await withMigrationDirectory(async (directory) => {
        const real = await realpath(directory);
        const save = (model: { $snapshot: () => unknown }) =>
          writeFile(
            join(directory, "symmetria.config.ts"),
            `export default ${JSON.stringify({ schema: model.$snapshot(), directory: "migrations", databaseUrl: address.toString() })};`,
          );
        const note = `No migrations yet: the migrations directory ${join(real, "migrations")} does not exist. "symmetria generate <name>" creates the first migration.\n`;

        await save(schema({ records: { id: int } }));

        // The commands run as before, so an applied chain of another project
        // would still be reported; only "nothing to do" reads differently.
        for (const command of [
          ["migrate"],
          ["migrate", "--plan"],
          ["status"],
          ["rollback", "--yes"],
          ["rollback", "--plan"],
        ]) {
          expect(await run(directory, ...command)).toEqual({
            exitCode: 0,
            stdout: note,
            stderr: "",
          });
        }

        expect(
          JSON.parse((await run(directory, "migrate", "--json")).stdout),
        ).toEqual({
          applied: [],
          durationMs: expect.any(Number),
          missingDirectory: join(real, "migrations"),
        });
        expect(
          JSON.parse((await run(directory, "status", "--json")).stdout),
        ).toEqual({
          migrations: [],
          missingDirectory: join(real, "migrations"),
        });
        expect(
          (await run(directory, "migrate", "--dir", "migratoins")).stderr,
        ).toBe(
          `symmetria: the migrations directory ${join(real, "migratoins")} (--dir) does not exist\n`,
        );

        expect((await run(directory, "generate", "initial")).exitCode).toBe(0);
        // With migrations and nothing applied the plan is empty, as the
        // rollback itself is.
        expect(await run(directory, "rollback", "--plan")).toMatchObject({
          exitCode: 0,
          stdout: "No applied migrations.\n",
        });
        expect(
          JSON.parse(
            (await run(directory, "rollback", "--plan", "--json")).stdout,
          ),
        ).toEqual({ steps: [] });
        expect(await run(directory, "rollback", "--yes")).toMatchObject({
          exitCode: 0,
          stdout: "No applied migrations.\n",
        });
        expect(await run(directory, "migrate")).toMatchObject({
          exitCode: 0,
          stdout: "Applied 000001_initial\n",
        });
        expect((await run(directory, "rollback", "--plan")).stdout).toContain(
          'DROP TABLE "records"',
        );

        // A second migration that no database has applied, deleted by hand.
        await save(schema({ records: { id: int, note: text.nullable } }));
        expect((await run(directory, "generate", "note")).exitCode).toBe(0);
        await rm(join(directory, "migrations", "000002_note"), {
          recursive: true,
        });
        expect((await run(directory, "status")).stderr).toContain(
          '"symmetria discard" takes it out of the journal',
        );
        // The database is configured and has not applied it: discard repairs.
        expect(await run(directory, "discard")).toEqual({
          exitCode: 0,
          stdout:
            "Discarded 000002_note; the snapshot is the schema before it.\n",
          stderr: "",
        });
        expect((await run(directory, "status")).stdout).toBe(
          "applied 000001_initial\n",
        );

        // One the database has applied stays, with or without its directory.
        expect((await run(directory, "discard", "--force")).stderr).toBe(
          'symmetria: "000001_initial" is applied in the configured database; roll it back first (symmetria rollback), then discard it\n',
        );
        expect((await run(directory, "generate", "note")).exitCode).toBe(0);
        expect((await run(directory, "migrate")).exitCode).toBe(0);
        await rm(join(directory, "migrations", "000002_note"), {
          recursive: true,
        });
        expect((await run(directory, "discard", "--force")).stderr).toBe(
          'symmetria: "000002_note" is applied in the configured database, and its directory is gone: restore the directory (from version control), roll the migration back (symmetria rollback), then discard it\n',
        );
        expect(
          JSON.parse(
            await readFile(
              join(directory, "migrations", "meta", "migration.json"),
              "utf8",
            ),
          ).migrations,
        ).toHaveLength(2);
      });
    } finally {
      await admin.execute({
        sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
        parameters: [],
      });
      await admin.close();
    }
  },
  60000,
);

test.skipIf(!databaseUrl)(
  "with a database: discard refuses while another process is applying migrations, also with --force",
  async () => {
    const name = `cli_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const admin = postgres({ url: databaseUrl!, max: 1 });
    const address = new URL(databaseUrl!);

    address.pathname = `/${name}`;
    await admin.execute({ sql: `CREATE DATABASE "${name}"`, parameters: [] });

    const inside = postgres({ url: address.toString(), max: 1 });

    try {
      await withMigrationDirectory(async (directory) => {
        const save = (model: { $snapshot: () => unknown }) =>
          writeFile(
            join(directory, "symmetria.config.ts"),
            `export default ${JSON.stringify({ schema: model.$snapshot(), directory: "migrations", databaseUrl: address.toString() })};`,
          );

        await save(schema({ records: { id: int } }));
        expect((await run(directory, "generate", "initial")).exitCode).toBe(0);
        expect((await run(directory, "migrate")).exitCode).toBe(0);
        await save(schema({ records: { id: int, note: text.nullable } }));
        expect((await run(directory, "generate", "note")).exitCode).toBe(0);

        // A slow step before the generated SQL: the migration's transaction
        // stays open, and its journal row is in it, unseen by other sessions.
        const up = join(directory, "migrations", "000002_note", "up.sql");
        await writeFile(
          up,
          `SELECT pg_sleep(3);\n\n${await readFile(up, "utf8")}`,
        );
        const migrating = run(directory, "migrate");

        // Until the run holds the migration lock.
        for (let attempt = 0; ; attempt += 1) {
          const result = await inside.execute({
            sql: "SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 1937339476::oid",
            parameters: [],
          });
          const [row] = (Array.isArray(result) ? result : result.rows) as {
            held: number;
          }[];

          if (row!.held > 0) {
            break;
          }

          expect(attempt).toBeLessThan(200);
          await Bun.sleep(50);
        }

        // --force is needed for the edited up.sql, and overrides nothing else.
        const refused = await run(directory, "discard", "--force");
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toMatch(
          /^symmetria: another process holds the migration lock of the configured database \(PostgreSQL process \d+\): a migrate, rollback, adopt or repair is running there and may be applying "000002_note" right now\. Run discard again when it has finished and status shows the migration as pending\n$/,
        );

        expect(await migrating).toMatchObject({
          exitCode: 0,
          stdout: "Applied 000002_note\n",
        });
        // What the database applied is still there.
        expect(await readdir(join(directory, "migrations"))).toContain(
          "000002_note",
        );
        expect((await run(directory, "status")).stdout).toBe(
          "applied 000001_initial\napplied 000002_note\n",
        );
        expect((await run(directory, "discard", "--force")).stderr).toBe(
          'symmetria: "000002_note" is applied in the configured database; roll it back first (symmetria rollback), then discard it\n',
        );
      });
    } finally {
      await inside.close();
      await admin.execute({
        sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
        parameters: [],
      });
      await admin.close();
    }
  },
  60000,
);

test("the dashboard header names a migrations directory that does not exist instead of counting it as up to date", () => {
  const header = (missing?: string) =>
    formatDashboard({
      address: "PostgreSQL · 127.0.0.1:5432/app",
      connection: "connected",
      snapshot: undefined,
      migrations: "0 applied · 0 pending",
      applied: 0,
      local: 0,
      pending: 0,
      changes: undefined,
      config: "No config · symmetria init to get started",
      ...(missing ? { missing } : {}),
    });
  const note =
    "No config file was found in the current directory, and there is no migrations directory either";
  const { columns } = process.stdout;

  try {
    // The three cards, and the framed list of a narrow terminal.
    for (const width of [100, 60]) {
      Object.assign(process.stdout, { columns: width });
      expect(header()).toContain(
        width === 100 ? "✓ Up to date" : "0 applied · 0 pending",
      );

      const shown = header(note);

      expect(shown).not.toContain("Up to date");
      expect(shown).not.toContain("0 applied");
      // Wrapped or cut to the width; its start is always there.
      expect(shown).toContain("No config file was found");

      if (width === 100) {
        expect(shown).toContain("No directory");
        expect(shown.replace(/\s+/g, " ")).toContain(note);
      }
    }
  } finally {
    Object.assign(process.stdout, { columns });
  }
});

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
