import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createProfiler,
  schema,
  table,
  int,
  text,
  index,
  operatorClass,
} from "../../../packages/runtime/src";
import {
  generateMigration,
  loadMigrations,
  recoverMigrationFiles,
  squashMigrations,
} from "../../../packages/kit/src";
import { checksumMatches } from "../../../packages/kit/src/migrations/files";
import {
  canonicalJSON,
  checksum,
} from "../../../packages/kit/src/migrations/snapshot";
import { formatSchema } from "../../../packages/kit/src/cli/ui/format";
import { FLAGS, help } from "../../../packages/kit/src/cli/options";
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

/** A chain with a seed written into an --empty migration and an edited generated migration. */
const customChain = async (directory: string) => {
  await generateMigration({
    directory,
    name: "initial",
    snapshot: schema({ users: { id: int.auto, name: text } }).$snapshot(),
  });
  const seed = (await generateMigration({
    directory,
    name: "seed",
    empty: true,
  }))!;
  await writeFile(
    join(directory, seed.id, "up.sql"),
    "INSERT INTO users (name) VALUES ('admin');\n",
  );
  const note = (await generateMigration({
    directory,
    name: "note",
    snapshot: schema({
      users: { id: int.auto, name: text, note: text.nullable },
    }).$snapshot(),
  }))!;
  const up = join(directory, note.id, "up.sql");
  await writeFile(
    up,
    `${await readFile(up, "utf8")}UPDATE users SET note = 'imported';\n`,
  );
  // An untouched empty migration has nothing to lose.
  await generateMigration({ directory, name: "placeholder", empty: true });

  return { seed, note };
};

test("squash refuses to drop SQL that generate did not write unless allowed", () =>
  withMigrationDirectory(async (directory) => {
    const { seed, note } = await customChain(directory);
    const before = await readdir(directory);

    await expect(
      squashMigrations({ directory, name: "baseline" }),
    ).rejects.toThrow(`squash would drop SQL that generate did not write, so new installations would never run it:
  - ${seed.id}: SQL written into an empty migration
  - ${note.id}: up.sql edited after generation
Copy that SQL into a migration after the baseline (generate <name> --empty), or pass --allow-custom-sql (allowCustomSQL: true) to drop it.`);
    expect(await readdir(directory)).toEqual(before);

    // The CLI flag belongs to squash and confirms the loss.
    expect(
      await run(directory, "squash", "baseline", "--dir", "."),
    ).toMatchObject({ exitCode: 1 });
    expect(
      (await run(directory, "lint", "--allow-custom-sql", "--dir", ".")).stderr,
    ).toContain("--allow-custom-sql is a squash option");
    expect(
      await run(
        directory,
        "squash",
        "baseline",
        "--allow-custom-sql",
        "--dir",
        ".",
      ),
    ).toMatchObject({ exitCode: 0 });
    expect(
      (await loadMigrations(directory)).map((migration) => migration.id),
    ).toEqual(["000001_baseline"]);
  }));

test("squash still finds hand-written SQL in empty migrations of older journals", () =>
  withMigrationDirectory(async (directory) => {
    const { seed } = await customChain(directory);
    // Journals written before generate recorded its SQL checksum.
    const path = join(directory, "meta", "migration.json");
    const journal = JSON.parse(await readFile(path, "utf8"));

    for (const manifest of journal.migrations) {
      delete manifest.generated;
    }

    await writeFile(path, JSON.stringify(journal));
    await expect(
      squashMigrations({ directory, name: "baseline" }),
    ).rejects.toThrow(`
  - ${seed.id}: SQL written into an empty migration
Copy`);
    expect(
      await squashMigrations({
        directory,
        name: "baseline",
        allowCustomSQL: true,
      }),
    ).toMatchObject({ id: "000001_baseline" });
  }));

test("checksums ignore CRLF line endings and still accept those recorded from CRLF files", () =>
  withMigrationDirectory(async (directory) => {
    const generated = (await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({
        users: { id: int.auto, name: text, email: text.unique },
      }).$snapshot(),
    }))!;

    for (const file of ["up.sql", "down.sql"]) {
      const path = join(directory, generated.id, file);
      await writeFile(
        path,
        (await readFile(path, "utf8")).replaceAll("\n", "\r\n"),
      );
    }

    const [loaded] = await loadMigrations(directory);
    expect(loaded!.up).toContain("\r\n");
    expect(loaded!.checksum).toBe(generated.checksum);
    // A journal row written by a release that hashed the CRLF bytes still matches.
    const legacy = checksum(
      canonicalJSON({
        manifest: loaded!.manifest,
        up: loaded!.up,
        down: loaded!.down,
      }),
    );
    expect(checksumMatches(loaded!, legacy)).toBe(true);
    expect(checksumMatches(loaded!, "0".repeat(64))).toBe(false);
    // Squash compares the generated SQL the same way.
    await generateMigration({ directory, name: "empty", empty: true });
    expect(
      await squashMigrations({ directory, name: "baseline" }),
    ).not.toBeNull();
  }));

test("recover reports when nothing was left behind", () =>
  withMigrationDirectory(async (directory) => {
    expect(await recoverMigrationFiles(directory)).toBe(false);
    expect(await run(directory, "recover", "--dir", ".")).toMatchObject({
      exitCode: 0,
      stdout: "Nothing to recover: no generation lock was left behind.\n",
    });
    expect(
      (await run(directory, "recover", "--dir", ".", "--json")).stdout,
    ).toBe('{"recovered":false}\n');

    const lock = join(directory, ".symmetria-generate.lock");
    await mkdir(lock);
    await expect(recoverMigrationFiles(directory)).rejects.toThrow(
      `generation lock ${lock} has no readable owner.json`,
    );
  }));

test("broken metadata errors name the file or folder", () =>
  withMigrationDirectory(async (directory) => {
    const first = (await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ users: { id: int.auto } }).$snapshot(),
    }))!;
    const snapshotPath = join(directory, "meta", "snapshot.json");
    const snapshot = await readFile(snapshotPath, "utf8");
    await writeFile(snapshotPath, snapshot.slice(0, 20));
    await expect(loadMigrations(directory)).rejects.toThrow(
      `${snapshotPath} is not valid JSON`,
    );
    await writeFile(snapshotPath, snapshot);

    await mkdir(join(directory, "000002_orphan"));
    await expect(loadMigrations(directory)).rejects.toThrow(
      `does not match the SQL directories in ${directory} (1 listed, 2 found; directories not in the journal: 000002_orphan)`,
    );
    await rm(join(directory, "000002_orphan"), { recursive: true });
    await rm(join(directory, first.id), { recursive: true });
    await expect(loadMigrations(directory)).rejects.toThrow(
      `missing directories: ${first.id}`,
    );
  }));

test("failures print JSON with --json and flags stay with their commands", () =>
  withMigrationDirectory(async (directory) => {
    const failed = await run(directory, "migrate", "--json");
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout)).toEqual({
      error: {
        message:
          "symmetria: no database: set databaseUrl in the config, DATABASE_URL or --database-url",
      },
    });
    expect(failed.stderr).toBe("");
    expect(
      (await run(directory, "lint", "--ignore-table", "x")).stderr,
    ).toContain("--ignore-table is a pull/drift/adopt/repair/verify option");
  }));

test("the plain schema listing shows index operator classes, INCLUDE and WHERE", () => {
  const model = schema({
    posts: table({ id: int.auto, title: text, slug: text }).indexes(
      (posts) => ({
        live: index(operatorClass(posts.title, "text_pattern_ops"))
          .include(posts.slug)
          .where(posts.slug.isNot("")),
      }),
    ),
  });
  expect(formatSchema(model.$snapshot())).toContain(
    `posts_live_idx  btree ("title" text_pattern_ops) INCLUDE ("slug") WHERE "slug" <> E''`,
  );
});

test("--help, the README and the reference list every flag", async () => {
  const readme = await readFile(resolve("packages/kit/README.md"), "utf8");
  const reference = await readFile(resolve("docs/reference.md"), "utf8");

  for (const flag of Object.keys(FLAGS)) {
    expect(help).toContain(`--${flag}`);
    expect(readme).toContain(`\`--${flag}`);
    expect(reference).toContain(`\`--${flag}`);
  }
});

test("profile without a terminal prints its requests as one JSON object", () =>
  withMigrationDirectory(async (directory) => {
    const profiler = createProfiler();
    const server = await profiler.serve({ port: 0 });

    try {
      const result = await run(
        directory,
        "profile",
        "--profile-url",
        String(server.url),
        "--profile-token",
        server.token,
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ requests: [] });
    } finally {
      await server.stop(true);
    }
  }));
