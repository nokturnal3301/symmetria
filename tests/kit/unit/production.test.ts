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
    ALTER TABLE "legacy" ADD label text DEFAULT 'x' NOT NULL, ADD required text NOT NULL;
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

test("SQL lint treats tables created earlier in the migration as new and empty", () => {
  const findings = lintMigrationSQL(`
    CREATE TABLE "users" ("id" integer NOT NULL, "email" text NOT NULL);
    CREATE TABLE app.events ("id" integer NOT NULL);
    CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
    CREATE INDEX "events_id_idx" ON app.events ("id");
    ALTER TABLE "users" ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");
    ALTER TABLE ONLY users ADD COLUMN "name" text NOT NULL;
    ALTER TABLE "users" ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "accounts" ("id");
    CREATE UNIQUE INDEX "accounts_email_idx" ON "accounts" ("email");
    ALTER TABLE "Users" ADD COLUMN "flag" boolean NOT NULL;
    DROP TABLE "users";
  `);
  expect(findings.map((finding) => [finding.statement, finding.level])).toEqual(
    [
      [8, "blocking"],
      [9, "blocking"],
      [10, "destructive"],
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

test("SQL lint passes safe column additions and renames, and downgrades rebuilt objects to cautions", () => {
  const findings = lintMigrationSQL(`
    ALTER TABLE "posts" ADD COLUMN "published_at" timestamptz;
    ALTER TABLE "posts" ADD COLUMN "score" numeric(6, 2) DEFAULT 0 NOT NULL;
    ALTER TABLE "posts" ADD COLUMN "seen_at" timestamptz DEFAULT now() NOT NULL;
    ALTER TABLE "posts" ADD COLUMN "author_id" integer NOT NULL;
    ALTER TABLE "categories" RENAME TO "topics";
    ALTER TABLE "topics" RENAME CONSTRAINT "categories_pkey" TO "topics_pkey";
    ALTER INDEX "categories_by_slug_idx" RENAME TO "topics_by_slug_idx";
    ALTER TABLE "posts" DROP CONSTRAINT "posts_views_check";
    ALTER TABLE "posts" ALTER COLUMN "views" TYPE bigint USING "views"::bigint;
    ALTER TABLE "posts" ADD CONSTRAINT "posts_views_check" CHECK ("views" >= 0);
    DROP INDEX "posts_old_idx";
  `);
  expect(findings.map((finding) => [finding.statement, finding.level])).toEqual(
    [
      [3, "caution"],
      [4, "blocking"],
      [8, "caution"],
      [9, "caution"],
      [10, "caution"],
      [11, "destructive"],
    ],
  );
});
