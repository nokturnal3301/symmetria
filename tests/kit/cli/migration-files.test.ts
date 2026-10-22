import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import {
  readFile,
  writeFile,
  readdir,
  realpath,
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { schema, int, text } from "../../../packages/runtime/src";
import {
  emptySnapshot,
  generateMigration,
  loadMigrations,
  loadMigrationState,
  squashMigrations,
  snapshotHash,
} from "../../../packages/kit/src";
import { splitMigrationSQL } from "../../../packages/kit/src/migrations/sql";
import { withMigrationDirectory } from "../../support/directories";

test("generation updates one snapshot and journal without changing earlier migration checksums", () =>
  withMigrationDirectory(async (directory) => {
    const first = schema({ records: { id: int.auto, value: text } });
    const second = schema({
      records: { id: int.auto, value: text, title: text.nullable },
    });
    const initial = (await generateMigration({
      directory,
      name: "Create Records",
      snapshot: first.$snapshot(),
    }))!;
    expect(initial.id).toBe("000001_create_records");
    expect((await readdir(join(directory, initial.id))).sort()).toEqual([
      "down.sql",
      "up.sql",
    ]);
    const originalSQL = await readFile(
      join(directory, initial.id, "up.sql"),
      "utf8",
    );
    const originalJournal = await readFile(
      join(directory, "meta", "migration.json"),
      "utf8",
    );
    const originalSnapshot = await readFile(
      join(directory, "meta", "snapshot.json"),
      "utf8",
    );
    expect(
      await generateMigration({
        directory,
        name: "No changes",
        snapshot: first.$snapshot(),
      }),
    ).toBeNull();
    expect(
      await readFile(join(directory, "meta", "migration.json"), "utf8"),
    ).toBe(originalJournal);
    expect(
      await readFile(join(directory, "meta", "snapshot.json"), "utf8"),
    ).toBe(originalSnapshot);

    const added = (await generateMigration({
      directory,
      name: "add title",
      snapshot: second.$snapshot(),
    }))!;
    expect(added.manifest.parent).toBe(initial.id);
    expect(added.up).toContain('ADD COLUMN "title"');
    expect((await readdir(join(directory, "meta"))).sort()).toEqual([
      "migration.json",
      "snapshot.json",
    ]);
    expect(
      JSON.parse(
        await readFile(join(directory, "meta", "snapshot.json"), "utf8"),
      ),
    ).toEqual(added.snapshot);
    expect(
      JSON.parse(
        await readFile(join(directory, "meta", "migration.json"), "utf8"),
      ),
    ).toEqual({
      version: 1,
      migrations: [initial.manifest, added.manifest],
    });
    expect(
      (await loadMigrations(directory)).map((migration) => migration.checksum),
    ).toEqual([initial.checksum, added.checksum]);
    expect(await readFile(join(directory, initial.id, "up.sql"), "utf8")).toBe(
      originalSQL,
    );

    const up = join(directory, added.id, "up.sql");
    await writeFile(
      up,
      `${await readFile(up, "utf8")}\n-- editable before applying\n`,
    );
    expect((await loadMigrations(directory))[1]?.checksum).not.toBe(
      added.checksum,
    );
    const snapshot = join(directory, "meta", "snapshot.json");
    const altered = JSON.parse(await readFile(snapshot, "utf8"));
    altered.tables[0].columns.find(
      (column: { name: string }) => column.name === "value",
    ).notNull = false;
    await writeFile(snapshot, JSON.stringify(altered));
    await expect(loadMigrations(directory)).rejects.toThrow(
      /snapshot checksum/,
    );
  }));

test("the shared journal rejects missing, reordered and inconsistent migration entries", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ records: { id: int } }).$snapshot(),
    });
    const second = (await generateMigration({
      directory,
      name: "second",
      empty: true,
    }))!;
    const journalPath = join(directory, "meta", "migration.json");
    const original = await readFile(journalPath, "utf8");

    for (const change of [
      (journal: { migrations: { parent: string | null; before: string }[] }) =>
        journal.migrations.pop(),
      (journal: { migrations: { parent: string | null; before: string }[] }) =>
        journal.migrations.reverse(),
      (journal: {
        migrations: { parent: string | null; before: string }[];
      }) => {
        journal.migrations[1]!.parent = null;
      },
      (journal: {
        migrations: { parent: string | null; before: string }[];
      }) => {
        journal.migrations[1]!.before = "0".repeat(64);
      },
    ]) {
      const journal = JSON.parse(original);
      change(journal);
      await writeFile(journalPath, JSON.stringify(journal));
      await expect(loadMigrations(directory)).rejects.toThrow(
        /journal|chain mismatch/,
      );
    }

    await writeFile(journalPath, original);
    await rename(
      join(directory, second.id),
      join(directory, ".hidden-migration"),
    );
    await expect(loadMigrations(directory)).rejects.toThrow(/journal/);
    await rename(
      join(directory, ".hidden-migration"),
      join(directory, second.id),
    );
    await mkdir(join(directory, "000003_orphan"));
    await expect(loadMigrations(directory)).rejects.toThrow(/journal/);
    await rm(join(directory, "000003_orphan"), { recursive: true });
    await rm(join(directory, second.id, "down.sql"));
    await expect(loadMigrations(directory)).rejects.toThrow();
  }));

test("generation preserves incomplete or unsupported metadata instead of overwriting it", () =>
  withMigrationDirectory(async (directory) => {
    await mkdir(join(directory, "meta"));

    for (const filename of [
      "snapshot.json",
      "migration.json",
      "000001_initial.snapshot.json",
    ]) {
      const path = join(directory, "meta", filename);
      await writeFile(path, "preserve this file");
      await expect(
        generateMigration({ directory, name: "initial", empty: true }),
      ).rejects.toThrow(/migration metadata/);
      expect(await readFile(path, "utf8")).toBe("preserve this file");
      expect(await readdir(directory)).not.toContain(
        ".symmetria-generate.lock",
      );
      expect(await readdir(directory)).not.toContain("000001_initial");
      await rm(path);
    }
  }));

test("generation failures release the lock and empty migrations retain the latest snapshot", () =>
  withMigrationDirectory(async (directory) => {
    await expect(
      generateMigration({ directory, name: "missing snapshot" }),
    ).rejects.toThrow(/requires a schema/);
    expect(await readdir(directory)).not.toContain(".symmetria-generate.lock");
    const empty = (await generateMigration({
      directory,
      name: "empty",
      empty: true,
    }))!;
    expect(empty.snapshot).toEqual(emptySnapshot());
    const initial = (await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ records: { id: int } }).$snapshot(),
    }))!;
    const migration = (await generateMigration({
      directory,
      name: "backfill",
      empty: true,
    }))!;
    expect(migration.snapshot).toEqual(initial.snapshot);
    expect(splitMigrationSQL(migration.up)).toEqual([]);
    expect((await loadMigrationState(directory)).snapshot).toEqual(
      initial.snapshot,
    );
    expect((await loadMigrations(directory))[0]?.checksum).toBe(empty.checksum);
    await mkdir(join(directory, ".symmetria-generate.lock"));
    await expect(
      generateMigration({ directory, name: "locked", empty: true }),
    ).rejects.toThrow(/locked/);
    await expect(loadMigrations(directory)).rejects.toThrow(/locked/);
  }));

test("CLI generate, diff, lint and squash use the shared metadata without a database", () =>
  withMigrationDirectory(async (directory) => {
    const entrypoint = resolve("packages/runtime/src/index.ts");
    await writeFile(
      join(directory, "symmetria.config.ts"),
      `import { schema, int, text } from ${JSON.stringify(entrypoint)};
import { defineMigrationConfig } from ${JSON.stringify(resolve("packages/kit/src/index.ts"))};
export default defineMigrationConfig({ schema: schema({ records: { id: int.auto, name: text } }), directory: "generated" });\n`,
    );

    const run = async (...argumentsList: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve("packages/kit/src/cli.ts"),
          ...argumentsList,
        ],
        {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, DATABASE_URL: "" },
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { stdout, stderr, exitCode };
    };

    expect(await run("generate", "initial")).toMatchObject({
      exitCode: 0,
      stdout: "Generated 000001_initial\n",
    });
    expect(await run("generate", "unchanged")).toMatchObject({
      exitCode: 0,
      stdout: "No schema changes.\n",
    });
    expect((await run("unknown")).exitCode).toBe(1);
    expect((await run("--help")).stdout).toContain("rollback");
    expect(
      await readdir(join(directory, "generated", "000001_initial")),
    ).toContain("down.sql");
    const generated = await run("generate", "backfill", "--empty", "--json");
    expect(generated.exitCode).toBe(0);
    expect(JSON.parse(generated.stdout)).toMatchObject({
      id: "000002_backfill",
      metadataDirectory: await realpath(join(directory, "generated", "meta")),
    });
    const diff = await run("diff", "--json");
    expect(diff.exitCode).toBe(0);
    expect(JSON.parse(diff.stdout)).toMatchObject({ up: [], down: [] });
    expect(await run("lint", "--json", "--strict")).toMatchObject({
      exitCode: 0,
      stdout: "[]\n",
    });
    await rm(join(directory, "symmetria.config.ts"));
    expect(
      await run("squash", "baseline", "--dir", "generated", "--json"),
    ).toMatchObject({ exitCode: 0, stdout: '{"id":"000001_baseline"}\n' });
    expect(
      (await readdir(join(directory, "generated", "meta"))).sort(),
    ).toEqual(["migration.json", "snapshot.json"]);
  }));

test("squash replaces the journal and SQL chain while keeping the current schema snapshot", () =>
  withMigrationDirectory(async (directory) => {
    const first = schema({ records: { id: int.auto, value: text } });
    const second = schema({
      records: { id: int.auto, value: text, title: text.nullable },
      tags: { id: int.auto, label: text },
    });
    expect(await squashMigrations({ directory, name: "nothing" })).toBeNull();
    await generateMigration({
      directory,
      name: "one",
      snapshot: first.$snapshot(),
    });
    expect(await squashMigrations({ directory, name: "single" })).toBeNull();
    const latest = (await generateMigration({
      directory,
      name: "two",
      snapshot: second.$snapshot(),
    }))!;
    const squashed = (await squashMigrations({
      directory,
      name: "Base Line",
    }))!;
    expect(squashed.id).toBe("000001_base_line");
    expect(squashed.manifest).toEqual({
      version: 1,
      id: "000001_base_line",
      parent: null,
      before: snapshotHash(emptySnapshot()),
      after: latest.manifest.after,
    });
    expect(squashed.up).toContain('CREATE TABLE "tags"');
    expect(squashed.up).toContain('"title" text');
    expect(squashed.down).toContain('DROP TABLE "records"');
    expect((await readdir(directory)).sort()).toEqual([
      "000001_base_line",
      "meta",
    ]);
    expect((await readdir(join(directory, "meta"))).sort()).toEqual([
      "migration.json",
      "snapshot.json",
    ]);
    expect((await loadMigrationState(directory)).snapshot).toEqual(
      latest.snapshot,
    );
    expect(
      JSON.parse(
        await readFile(join(directory, "meta", "migration.json"), "utf8"),
      ).migrations,
    ).toEqual([squashed.manifest]);
    const chain = await loadMigrations(directory);
    expect(chain.map((migration) => migration.id)).toEqual([squashed.id]);
    expect(chain[0]?.checksum).toBe(squashed.checksum);
    expect(
      await generateMigration({
        directory,
        name: "same",
        snapshot: second.$snapshot(),
      }),
    ).toBeNull();
  }));

test("squash preserves conflicting files and can reuse the first migration name", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ records: { id: int } }).$snapshot(),
    });
    await generateMigration({
      directory,
      name: "next",
      snapshot: schema({ records: { id: int, name: text } }).$snapshot(),
    });
    const original = await loadMigrationState(directory);
    const location = join(directory, "000001_baseline");
    await writeFile(location, "keep this file");
    await expect(
      squashMigrations({ directory, name: "baseline" }),
    ).rejects.toThrow(/already exists/);
    expect(await loadMigrationState(directory)).toEqual(original);
    expect(await readFile(location, "utf8")).toBe("keep this file");
    expect(await readdir(directory)).not.toContain(".symmetria-generate.lock");
    await rm(location);
    const squashed = (await squashMigrations({ directory, name: "initial" }))!;
    expect(
      (await loadMigrations(directory)).map((entry) => entry.checksum),
    ).toEqual([squashed.checksum]);
    expect(squashed.snapshot).toEqual(original.snapshot);
  }));

test("failed generation restores both shared files on initial publication and append", () =>
  withMigrationDirectory(async (directory) => {
    const originalRename = filesystem.rename;

    for (const existing of [false, true]) {
      if (existing) {
        await generateMigration({
          directory,
          name: "initial",
          snapshot: schema({ records: { id: int } }).$snapshot(),
        });
      }

      const original = await loadMigrationState(directory);
      const listing = (await readdir(directory)).sort();
      const metadata = existing
        ? await Promise.all(
            ["migration.json", "snapshot.json"].map((file) =>
              readFile(join(directory, "meta", file), "utf8"),
            ),
          )
        : [];
      const id = existing ? "000002_next" : "000001_next";

      for (const destinationName of [
        "meta/migration.json",
        "meta/snapshot.json",
        id,
      ]) {
        const renameSpy = spyOn(filesystem, "rename").mockImplementation(
          async (source, destination) => {
            if (
              String(source).includes("/staged/") &&
              destination === join(directory, destinationName)
            ) {
              throw new Error("publication failed");
            }

            await originalRename(source, destination);
          },
        );

        try {
          await expect(
            generateMigration({
              directory,
              name: "next",
              snapshot: schema({
                records: { id: int, title: text },
              }).$snapshot(),
            }),
          ).rejects.toThrow(/publication failed/);
        } finally {
          renameSpy.mockRestore();
        }

        expect(await loadMigrationState(directory)).toEqual(original);
        expect((await readdir(directory)).sort()).toEqual(listing);

        if (existing) {
          expect(
            await Promise.all(
              ["migration.json", "snapshot.json"].map((file) =>
                readFile(join(directory, "meta", file), "utf8"),
              ),
            ),
          ).toEqual(metadata);
        }
      }
    }
  }));

test("failed squash restores the SQL chain and both shared metadata files", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: schema({ records: { id: int } }).$snapshot(),
    });
    await generateMigration({ directory, name: "next", empty: true });
    const original = await loadMigrationState(directory);
    const originalRename = filesystem.rename;

    for (const destinationName of [
      "meta/migration.json",
      "meta/snapshot.json",
      "000001_initial",
    ]) {
      const renameSpy = spyOn(filesystem, "rename").mockImplementation(
        async (source, destination) => {
          if (
            String(source).includes("/staged/") &&
            destination === join(directory, destinationName)
          ) {
            throw new Error("simulated publication failure");
          }

          await originalRename(source, destination);
        },
      );

      try {
        await expect(
          squashMigrations({ directory, name: "initial" }),
        ).rejects.toThrow(/publication failure/);
      } finally {
        renameSpy.mockRestore();
      }

      expect(await loadMigrationState(directory)).toEqual(original);
      expect((await readdir(directory)).sort()).toEqual([
        "000001_initial",
        "000002_next",
        "meta",
      ]);
      expect((await readdir(join(directory, "meta"))).sort()).toEqual([
        "migration.json",
        "snapshot.json",
      ]);
    }
  }));
