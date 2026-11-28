import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { schema, table, int, text } from "../../../packages/runtime/src";
import {
  discardMigration,
  generateMigration,
  loadMigrationState,
  snapshotHash,
} from "../../../packages/kit/src";
import { discardTarget } from "../../../packages/kit/src/migrations/files";
import { withMigrationDirectory } from "../../support/directories";

const version = (step: number) =>
  schema({
    messages: table({
      id: int.auto,
      body: text,
      ...(step >= 2 ? { reply: text.nullable } : {}),
      ...(step >= 3 ? { mood: text.nullable } : {}),
    }),
  }).$snapshot();

const journal = async (directory: string) =>
  JSON.parse(await readFile(join(directory, "meta", "migration.json"), "utf8"));

test("discard takes back the latest migration and the snapshot before it", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: version(1),
    });
    const before = (await loadMigrationState(directory)).snapshot;

    await generateMigration({ directory, name: "reply", snapshot: version(2) });
    // The journal remembers the way back while no database has applied it.
    expect((await journal(directory)).undo.migration).toBe("000002_reply");

    await expect(
      discardMigration({ directory, id: "000001_initial" }),
    ).rejects.toThrow(
      'only the latest migration can be discarded; it is "000002_reply"',
    );
    expect(await discardMigration({ directory })).toEqual({
      id: "000002_reply",
      source: "journal",
    });

    const state = await loadMigrationState(directory);

    expect(state.migrations.map((migration) => migration.id)).toEqual([
      "000001_initial",
    ]);
    expect(snapshotHash(state.snapshot)).toBe(snapshotHash(before));
    expect((await readdir(directory)).sort()).toEqual([
      "000001_initial",
      "meta",
    ]);

    // Generated again, under the same number, as if never generated before.
    expect(
      (
        await generateMigration({
          directory,
          name: "reply",
          snapshot: version(2),
        })
      )?.id,
    ).toBe("000002_reply");

    // Only one step back is remembered; the first migration leaves an empty chain.
    await discardMigration({ directory });
    expect(await discardMigration({ directory })).toEqual({
      id: "000001_initial",
      source: "empty chain",
    });
    await expect(discardMigration({ directory })).rejects.toThrow(
      "there is no migration to discard",
    );
  }));

test("discard keeps a hand-edited up.sql unless allowed", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: version(1),
    });
    await generateMigration({ directory, name: "reply", snapshot: version(2) });
    await writeFile(
      join(directory, "000002_reply", "up.sql"),
      `${await readFile(join(directory, "000002_reply", "up.sql"), "utf8")}-- backfill\n`,
    );

    await expect(discardMigration({ directory })).rejects.toThrow(
      "000002_reply/up.sql was edited after it was generated",
    );
    expect((await discardMigration({ directory, allowEdited: true })).id).toBe(
      "000002_reply",
    );
  }));

test("a migration removed by hand: discard puts the snapshot back from the journal or Git", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: version(1),
    });
    await generateMigration({ directory, name: "reply", snapshot: version(2) });

    const removeByHand = async (keepUndo: boolean) => {
      const entries = await journal(directory);
      const gone = entries.migrations.pop();

      if (!keepUndo) {
        delete entries.undo;
      }

      await writeFile(
        join(directory, "meta", "migration.json"),
        JSON.stringify(entries, null, 2),
      );
      await rm(join(directory, gone.id), { recursive: true });
    };

    await removeByHand(true);
    await expect(loadMigrationState(directory)).rejects.toThrow(
      '"symmetria discard" puts the snapshot back',
    );
    expect(await discardMigration({ directory })).toEqual({
      source: "journal",
    });
    expect((await loadMigrationState(directory)).migrations).toHaveLength(1);

    // The journal no longer knows; the committed snapshot does.
    const git = (...argumentsList: string[]) =>
      execFileSync("git", argumentsList, { cwd: directory, stdio: "pipe" });

    git("init", "-q");
    git("-c", "user.email=t@example.test", "-c", "user.name=t", "add", "-A");
    git(
      "-c",
      "user.email=t@example.test",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "initial",
    );
    await generateMigration({ directory, name: "reply", snapshot: version(2) });
    await removeByHand(false);
    await expect(
      discardMigration({ directory, id: "000002_reply" }),
    ).rejects.toThrow("does not match the journal");
    expect(await discardMigration({ directory })).toEqual({ source: "git" });
    expect(
      (
        await generateMigration({
          directory,
          name: "reply",
          snapshot: version(2),
        })
      )?.up,
    ).toContain('ADD COLUMN "reply" text');
  }));

test("a migration deleted by removing its directory: discard takes it out of the journal", () =>
  withMigrationDirectory(async (directory) => {
    await generateMigration({
      directory,
      name: "initial",
      snapshot: version(1),
    });
    const before = (await loadMigrationState(directory)).snapshot;

    await generateMigration({ directory, name: "reply", snapshot: version(2) });
    await rm(join(directory, "000002_reply"), { recursive: true });

    // Every command refuses the chain and names the way out.
    await expect(loadMigrationState(directory)).rejects.toThrow(
      'If "000002_reply" was deleted by hand, "symmetria discard" takes it out of the journal and puts the snapshot back',
    );
    await expect(
      discardMigration({ directory, id: "000001_initial" }),
    ).rejects.toThrow('it is "000002_reply" (its directory is already gone)');
    expect(await discardMigration({ directory })).toEqual({
      id: "000002_reply",
      source: "journal",
    });

    const state = await loadMigrationState(directory);

    expect(state.migrations.map((migration) => migration.id)).toEqual([
      "000001_initial",
    ]);
    expect(snapshotHash(state.snapshot)).toBe(snapshotHash(before));
  }));

test("the migration discard would take out of the journal is known while the chain does not load", () =>
  withMigrationDirectory(async (directory) => {
    // Nothing to discard, in a directory that need not exist.
    expect(await discardTarget(directory)).toBeUndefined();
    expect(await discardTarget(join(directory, "absent"))).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);

    await generateMigration({
      directory,
      name: "initial",
      snapshot: version(1),
    });
    await generateMigration({ directory, name: "reply", snapshot: version(2) });
    expect(await discardTarget(directory)).toEqual({
      id: "000002_reply",
      removed: false,
    });

    // Its directory deleted by hand: no command loads the chain, and the
    // migration is still the one the database is asked about before discard
    // takes it out of the journal.
    await rm(join(directory, "000002_reply"), { recursive: true });
    await expect(loadMigrationState(directory)).rejects.toThrow(
      '"symmetria discard" takes it out of the journal',
    );
    const before = await journal(directory);
    expect(await discardTarget(directory)).toEqual({
      id: "000002_reply",
      removed: true,
    });
    // Asking changes nothing.
    expect(await journal(directory)).toEqual(before);
    expect((await readdir(directory)).sort()).toEqual([
      "000001_initial",
      "meta",
    ]);

    // Its journal entry removed as well: discard only puts the snapshot back,
    // and no migration leaves the journal, so there is nothing to ask about.
    before.migrations.pop();
    await writeFile(
      join(directory, "meta", "migration.json"),
      JSON.stringify(before, null, 2),
    );
    expect(await discardTarget(directory)).toBeUndefined();
    expect(await discardMigration({ directory })).toEqual({
      source: "journal",
    });
    expect(await discardTarget(directory)).toEqual({
      id: "000001_initial",
      removed: false,
    });
  }));
