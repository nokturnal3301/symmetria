import { expect, test } from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { schema, int, text } from "../../../packages/runtime/src";
import {
  generateMigration,
  loadMigrationState,
  lintMigrationSQL,
  migrationSnapshot,
  snapshotHash,
  recoverMigrationFiles,
} from "../../../packages/kit/src";
import {
  fileIdentity,
  rollbackPublication,
  savePublication,
  type Publication,
} from "../../../packages/kit/src/migrations/publication";
import { withMigrationDirectory } from "../../support/directories";

test("generation preserves column declaration order and refuses implicit destructive renames", () =>
  withMigrationDirectory(async (directory) => {
    const before = schema({
      records: { id: int, zeta: text.nullable, alpha: text },
    }).$snapshot();
    const after = schema({
      records: { id: int, mail: text.nullable, alpha: text },
    }).$snapshot();
    const initial = (await generateMigration({
      directory,
      name: "initial",
      snapshot: before,
    }))!;
    expect(initial.up.indexOf('"id"')).toBeLessThan(
      initial.up.indexOf('"zeta"'),
    );
    expect(initial.up.indexOf('"zeta"')).toBeLessThan(
      initial.up.indexOf('"alpha"'),
    );
    const original = await readFile(
      join(directory, "meta", "snapshot.json"),
      "utf8",
    );
    await expect(
      generateMigration({ directory, name: "mail", snapshot: after }),
    ).rejects.toThrow(/explicit rename hints/);
    expect(
      await readFile(join(directory, "meta", "snapshot.json"), "utf8"),
    ).toBe(original);
    expect(
      (await generateMigration({
        directory,
        name: "mail",
        snapshot: after,
        renames: { columns: { records: { zeta: "mail" } } },
      }))!.up,
    ).toContain('RENAME COLUMN "zeta" TO "mail"');
    await generateMigration({
      directory,
      name: "remove",
      snapshot: schema({ records: { id: int, alpha: text } }).$snapshot(),
      allowDestructive: true,
    });
    expect((await loadMigrationState(directory)).migrations).toHaveLength(3);
    const reordered = migrationSnapshot(before);
    reordered.tables[0]!.columns.reverse();
    expect(snapshotHash(reordered)).toBe(
      snapshotHash(migrationSnapshot(before)),
    );
  }));

test("SQL lint inspects real statements, including optional COLUMN syntax, without treating quotes as SQL", () => {
  const findings = lintMigrationSQL(`
    -- DROP TABLE ignored;
    CREATE TABLE "drop" ("drop column" text DEFAULT 'DELETE FROM anything');
    ALTER TABLE "drop" DROP "drop column";
    WITH removed AS (DELETE FROM "drop" RETURNING *) SELECT * FROM removed;
    DO $body$ BEGIN EXECUTE 'DROP TABLE secret'; END $body$;
    ALTER TABLE "drop" ADD label text DEFAULT 'x' NOT NULL, ADD required text NOT NULL;
  `);
  expect(findings.map((finding) => [finding.statement, finding.level])).toEqual(
    [
      [2, "destructive"],
      [3, "destructive"],
      [4, "caution"],
      [5, "blocking"],
    ],
  );
});

test("publication recovery is idempotent across interrupted forward and reverse renames", () =>
  withMigrationDirectory(async (directory) => {
    const lock = join(directory, ".symmetria-generate.lock");
    const temporary = join(directory, ".symmetria-crash");
    await mkdir(lock);
    await mkdir(temporary);
    await mkdir(join(directory, "meta"));
    // Obtain a PID known to have exited rather than guessing whether a system PID exists.
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: child.pid, host: hostname() }),
    );
    const original = join(directory, "meta", "snapshot.json");
    const backup = join(temporary, "backup");
    const staged = join(temporary, "staged");
    await writeFile(original, "original");
    await writeFile(staged, "replacement");
    const publication: Publication = {
      temporary,
      hadMetadata: true,
      committed: false,
      moves: [
        {
          source: original,
          destination: backup,
          identity: (await fileIdentity(original))!,
        },
        {
          source: staged,
          destination: original,
          identity: (await fileIdentity(staged))!,
        },
      ],
    };
    await savePublication(directory, publication);
    await rename(original, backup);
    await rename(staged, original);
    await rollbackPublication(publication);
    // Simulate a second crash after undoing moves but before clearing the durable journal.
    await recoverMigrationFiles(directory);
    expect(await readFile(original, "utf8")).toBe("original");
  }));

test("recovery refuses to steal a live generator's lock", () =>
  withMigrationDirectory(async (directory) => {
    const lock = join(directory, ".symmetria-generate.lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, host: hostname() }),
    );
    await expect(recoverMigrationFiles(directory)).rejects.toThrow(
      /still running/,
    );
  }));
