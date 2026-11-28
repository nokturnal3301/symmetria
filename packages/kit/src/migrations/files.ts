/**
 * Migration files on disk: manifest and state loading, SQL generation, squashing and file naming.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { SchemaSnapshot } from "symmetria";
import { diffSchemas, type MigrationDiffOptions } from "./diff";
import {
  canonicalJSON,
  checksum,
  commentText,
  compareNames,
  emptySnapshot,
  migrationSnapshot,
  parseMigrationSnapshot,
  snapshotHash,
  type MigrationSnapshot,
} from "./snapshot";
import { formatMigrationSQL, splitMigrationSQL } from "./sql";
import { lintMigration } from "./lint";
import {
  fileIdentity,
  generationLockName,
  recordGenerationOwner,
  rollbackPublication,
  savePublication,
  stagingPrefix,
  syncPath,
  type Publication,
} from "./publication";

export type MigrationManifest = {
  version: 1;
  id: string;
  parent: string | null;
  before: string;
  after: string;
  /** Omitted/batch preserves atomic execution of all pending transactional migrations. */
  transaction?: "batch" | "each" | "none";
  /** SHA-256 of up.sql as generate wrote it; squash refuses to drop SQL that differs. */
  generated?: string;
};
export type Migration = {
  id: string;
  manifest: MigrationManifest;
  up: string;
  down: string;
  checksum: string;
};
export type GeneratedMigration = Migration & { snapshot: MigrationSnapshot };
export type MigrationState = {
  migrations: Migration[];
  snapshot: MigrationSnapshot;
};
export type GenerateMigrationOptions = MigrationDiffOptions & {
  directory: string;
  name: string;
  snapshot?: SchemaSnapshot | MigrationSnapshot;
  empty?: boolean;
  allowDestructive?: boolean;
  transaction?: "batch" | "each" | "none";
  /**
   * Stops the generation while nothing has been published: it rejects with
   * the signal's reason and leaves no lock or staged files behind. Once the
   * files are being published, they are published.
   */
  signal?: AbortSignal | undefined;
};
export type SquashMigrationsOptions = {
  directory: string;
  name: string;
  /** Drop SQL that generate did not write (seeds, views, edited up.sql) instead of refusing. */
  allowCustomSQL?: boolean;
  /** Stops the squash while nothing has been published, as for generation. */
  signal?: AbortSignal | undefined;
};
type MigrationJournal = {
  version: 1;
  migrations: MigrationManifest[];
  /**
   * The snapshot before the latest migration, so `discard` can take that
   * migration back while no database has applied it. Releases that do not
   * know it ignore it.
   */
  undo?: { migration: string; snapshot: MigrationSnapshot };
};
export type DiscardMigrationOptions = {
  directory: string;
  /** The migration expected to be the latest; refused when another one is. */
  id?: string;
  /** Discard an up.sql edited after generation, losing the edits. */
  allowEdited?: boolean;
  /** Stops the discard while nothing has been published, as for generation. */
  signal?: AbortSignal | undefined;
};
export type DiscardedMigration = {
  /** The removed migration; undefined when only the snapshot was repaired. */
  id?: string;
  /** Where the earlier snapshot came from. */
  source: "journal" | "empty chain" | "git";
};
const migrationIdPattern = /^\d{6}_[a-z0-9][a-z0-9_]*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const metadataFiles = ["migration.json", "snapshot.json"];
const lockName = generationLockName;

/** Checksums ignore CRLF line endings, so an editor or Git setting cannot invalidate applied migrations. */
const lineFeeds = (sql: string): string => sql.replaceAll("\r\n", "\n");

const migrationChecksum = (
  manifest: MigrationManifest,
  up: string,
  down: string,
): string =>
  checksum(
    canonicalJSON({ manifest, up: lineFeeds(up), down: lineFeeds(down) }),
  );

/**
 * Whether a journal checksum belongs to this migration: the line-feed form, or
 * the exact bytes that releases before the normalization hashed for CRLF files.
 */
export const checksumMatches = (
  migration: Migration,
  recorded: string,
): boolean =>
  migration.checksum === recorded ||
  checksum(
    canonicalJSON({
      manifest: migration.manifest,
      up: migration.up,
      down: migration.down,
    }),
  ) === recorded;

const sqlChecksum = (up: string): string => checksum(lineFeeds(up));

const parseMetadata = (directory: string, name: string, text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `symmetria: ${join(directory, "meta", name)} is not valid JSON (${error instanceof Error ? error.message : String(error)}); restore it from version control`,
      { cause: error },
    );
  }
};

const missing = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    (error: unknown) => {
      if (missing(error)) {
        return false;
      }

      throw error;
    },
  );

const readDirectory = (directory: string) =>
  readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (missing(error)) {
      return [];
    }

    throw error;
  });

const readMigrationState = async (
  directory: string,
  options: { readonly snapshotMismatch?: "throw" | "keep" } = {},
): Promise<
  MigrationState & {
    readonly undo?: MigrationJournal["undo"];
    /** The snapshot is not the schema after the journal's last migration. */
    readonly mismatch?: true;
    /** The journal's last migration, whose directory was deleted by hand. */
    readonly removed?: MigrationManifest;
  }
> => {
  const entries = await readDirectory(directory);
  const directories = entries
    .filter(
      (entry) =>
        entry.name !== "meta" &&
        !entry.name.startsWith(".") &&
        entry.isDirectory(),
    )
    .map((entry) => entry.name)
    .sort(compareNames);
  // Dot-files (a .DS_Store that Finder writes, an editor's swap file) are
  // skipped here as they are beside the migration directories.
  const metadata = (await readDirectory(join(directory, "meta"))).filter(
    (entry) => !entry.name.startsWith("."),
  );

  if (!directories.length && !metadata.length) {
    return { migrations: [], snapshot: emptySnapshot() };
  }

  // What is wrong with the directory, one finding each. A name is quoted
  // with its line breaks and control characters escaped, so it cannot split
  // the message or draw on the terminal.
  const stray = metadata
    .filter((entry) => !metadataFiles.includes(entry.name))
    .map((entry) => entry.name)
    .sort(compareNames);
  const problems = [
    ...stray
      .slice(0, 5)
      .map(
        (name) => `${commentText(JSON.stringify(name))} does not belong there`,
      ),
    ...(stray.length > 5 ? [`nor do ${stray.length - 5} more entries`] : []),
    ...metadataFiles.flatMap((name) => {
      const entry = metadata.find((candidate) => candidate.name === name);

      return entry
        ? entry.isFile()
          ? []
          : [
              `${name} is ${entry.isDirectory() ? "a directory" : entry.isSymbolicLink() ? "a symbolic link" : "not a regular file"}, not a file`,
            ]
        : [`${name} is missing`];
    }),
  ];

  if (problems.length) {
    throw new Error(
      `symmetria: migration metadata must contain only the files meta/snapshot.json and meta/migration.json; in ${join(directory, "meta")}: ${problems.join("; ")}`,
    );
  }

  const [journalText, snapshotText] = await Promise.all(
    metadataFiles.map((name) =>
      readFile(join(directory, "meta", name), "utf8"),
    ),
  );
  const journal = parseMetadata(
    directory,
    "migration.json",
    journalText!,
  ) as MigrationJournal;
  const snapshot = parseMigrationSnapshot(
    parseMetadata(directory, "snapshot.json", snapshotText!),
  );

  const listed = Array.isArray(journal?.migrations)
    ? journal.migrations.map((manifest) => String(manifest?.id))
    : [];
  // Only the latest directory is gone: the usual way to delete a migration
  // by hand, which discard repairs.
  const latestRemoved =
    listed.length === directories.length + 1 &&
    directories.every((id, position) => listed[position] === id);
  let removed: MigrationManifest | undefined;

  if (latestRemoved && options.snapshotMismatch === "keep") {
    removed = journal.migrations.pop();
  }

  if (
    !journal ||
    journal.version !== 1 ||
    !Array.isArray(journal.migrations) ||
    journal.migrations.length !== directories.length
  ) {
    const unlisted = directories.filter((id) => !listed.includes(id));
    const absent = listed.filter((id) => !directories.includes(id));

    throw new Error(
      `symmetria: migration journal ${join(directory, "meta", "migration.json")} does not match the SQL directories in ${directory} (${listed.length} listed, ${directories.length} found${absent.length ? `; missing directories: ${absent.join(", ")}` : ""}${unlisted.length ? `; directories not in the journal: ${unlisted.join(", ")}` : ""})${latestRemoved ? `. If "${listed.at(-1)}" was deleted by hand, "symmetria discard" takes it out of the journal and puts the snapshot back` : ""}`,
    );
  }

  const migrations: Migration[] = [];
  let previousHash = snapshotHash(emptySnapshot());
  let previousOrdinal = 0;

  for (const [position, id] of directories.entries()) {
    const manifest = journal.migrations[position];

    if (
      !migrationIdPattern.test(id) ||
      Number(id.slice(0, 6)) <= previousOrdinal ||
      !manifest ||
      manifest.version !== 1 ||
      manifest.id !== id ||
      manifest.parent !== (migrations.at(-1)?.id ?? null) ||
      manifest.before !== previousHash ||
      typeof manifest.after !== "string" ||
      !hashPattern.test(manifest.after) ||
      (manifest.transaction !== undefined &&
        !["batch", "each", "none"].includes(manifest.transaction)) ||
      (manifest.generated !== undefined &&
        (typeof manifest.generated !== "string" ||
          !hashPattern.test(manifest.generated)))
    ) {
      throw new Error(`symmetria: migration chain mismatch at "${id}"`);
    }

    const location = join(directory, id);

    if (
      (await readDirectory(location)).some((entry) =>
        metadataFiles.includes(entry.name),
      )
    ) {
      throw new Error(
        `symmetria: unexpected per-migration metadata in "${id}"`,
      );
    }

    const [up, down] = await Promise.all([
      readFile(join(location, "up.sql"), "utf8"),
      readFile(join(location, "down.sql"), "utf8"),
    ]);
    splitMigrationSQL(up);
    splitMigrationSQL(down);
    migrations.push({
      id,
      manifest,
      up,
      down,
      checksum: migrationChecksum(manifest, up, down),
    });
    previousHash = manifest.after;
    previousOrdinal = Number(id.slice(0, 6));
  }

  const undo =
    journal.undo &&
    typeof journal.undo.migration === "string" &&
    journal.undo.snapshot
      ? {
          migration: journal.undo.migration,
          snapshot: parseMigrationSnapshot(journal.undo.snapshot),
        }
      : undefined;

  if (snapshotHash(snapshot) !== previousHash) {
    if (options.snapshotMismatch === "keep") {
      return {
        migrations,
        snapshot,
        ...(undo ? { undo } : {}),
        ...(removed ? { removed } : {}),
        mismatch: true,
      };
    }

    throw new Error(
      `symmetria: latest snapshot checksum does not match the migration journal: ${join(directory, "meta", "snapshot.json")} is not the schema after ${migrations.at(-1) ? `"${migrations.at(-1)!.id}"` : "an empty chain"} in ${join(directory, "meta", "migration.json")}. If a migration was removed by hand, "symmetria discard" puts the snapshot back; to remove a migration no database applied, run "symmetria discard" instead of deleting files.`,
    );
  }

  return {
    migrations,
    snapshot,
    ...(undo ? { undo } : {}),
    ...(removed ? { removed } : {}),
  };
};

/**
 * Why a command stops while the generation lock exists. A generator that was
 * killed leaves its lock behind, so the message names the way out.
 */
const lockedError = (directory: string): Error =>
  new Error(
    `symmetria: migration generation is already locked: ${join(directory, lockName)} exists, so a generate, squash or discard is running in this directory. If that process was interrupted or killed, "symmetria recover" removes what it left`,
  );

/** Reads the files while no generator is publishing into the directory. */
const readUnlocked = async (
  directory: string,
  options?: Parameters<typeof readMigrationState>[1],
) => {
  const assertUnlocked = async () => {
    if (await exists(join(directory, lockName))) {
      throw lockedError(directory);
    }
  };

  await assertUnlocked();
  const state = await readMigrationState(directory, options);
  await assertUnlocked();

  return state;
};

/** One current schema snapshot and a compact journal for the entire SQL chain. */
export const loadMigrationState = (
  directory: string,
): Promise<MigrationState> => readUnlocked(directory);

export const loadMigrations = async (directory: string): Promise<Migration[]> =>
  (await loadMigrationState(directory)).migrations;

const normalizeName = (name: string): string => {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  if (!normalized || normalized.length > 100) {
    throw new Error(
      "symmetria: migration names must contain 1–100 letters/digits after normalization",
    );
  }

  return normalized;
};

const withGenerationLock = async <Result>(
  directory: string,
  callback: () => Promise<Result>,
): Promise<Result> => {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, lockName);
  await mkdir(lock).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw lockedError(directory);
    }

    throw error;
  });

  try {
    await recordGenerationOwner(directory);

    return await callback();
  } finally {
    if (!(await exists(join(lock, "publication.json")))) {
      await rm(lock, { recursive: true, force: true });
    }
  }
};

/**
 * Publishes the metadata and, when given, a new migration's SQL; the
 * migrations in `replaced` leave the directory. Every step can be rolled
 * back, and `recover` finishes one a crash interrupted.
 */
const writeMigrationFiles = async (
  directory: string,
  migration:
    | GeneratedMigration
    | { readonly id?: undefined; readonly snapshot: MigrationSnapshot },
  manifests: MigrationManifest[],
  {
    replaced = [],
    undo,
    signal,
  }: {
    readonly replaced?: string[];
    readonly undo?: MigrationJournal["undo"];
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<void> => {
  if (
    migration.id !== undefined &&
    !replaced.includes(migration.id) &&
    (await exists(join(directory, migration.id)))
  ) {
    throw new Error(`symmetria: migration "${migration.id}" already exists`);
  }

  const temporary = await mkdtemp(join(directory, stagingPrefix));
  const staged = join(temporary, "staged");
  const backup = join(temporary, "backup");
  const moved: Publication["moves"] = [];
  let preserveBackup = false;
  const hadMetadata = await exists(join(directory, "meta"));
  const publication: Publication = {
    temporary,
    hadMetadata,
    moves: moved,
    committed: false,
  };

  const move = async (source: string, destination: string): Promise<void> => {
    moved.push({
      source,
      destination,
      identity: (await fileIdentity(source))!,
    });
    await savePublication(directory, publication);
    await rename(source, destination);
    await syncPath(resolve(source, ".."));
    await syncPath(resolve(destination, ".."));
  };

  try {
    await Promise.all([
      ...(migration.id === undefined
        ? []
        : [mkdir(join(staged, migration.id), { recursive: true })]),
      mkdir(join(staged, "meta"), { recursive: true }),
      mkdir(join(backup, "meta"), { recursive: true }),
    ]);
    const journal: MigrationJournal = {
      version: 1,
      migrations: manifests,
      ...(undo ? { undo } : {}),
    };
    await Promise.all([
      ...("up" in migration
        ? [
            writeFile(join(staged, migration.id, "up.sql"), migration.up),
            writeFile(join(staged, migration.id, "down.sql"), migration.down),
          ]
        : []),
      writeFile(
        join(staged, "meta", "migration.json"),
        `${JSON.stringify(journal, null, 2)}\n`,
      ),
      writeFile(
        join(staged, "meta", "snapshot.json"),
        `${JSON.stringify(migration.snapshot, null, 2)}\n`,
      ),
    ]);

    for (const path of [
      ...(migration.id === undefined
        ? []
        : [
            join(staged, migration.id, "up.sql"),
            join(staged, migration.id, "down.sql"),
          ]),
      ...metadataFiles.map((name) => join(staged, "meta", name)),
      ...(migration.id === undefined ? [] : [join(staged, migration.id)]),
      join(staged, "meta"),
      staged,
      backup,
      temporary,
    ]) {
      await syncPath(path);
    }

    // The last point where stopping costs nothing: no file of the directory
    // has moved, so the staged copy and the lock are all there is to remove.
    signal?.throwIfAborted();
    await savePublication(directory, publication);
    await mkdir(join(directory, "meta"), { recursive: true });

    // Retain the old pair and SQL until every replacement has been published.
    for (const id of replaced) {
      await move(join(directory, id), join(backup, id));
    }

    for (const name of metadataFiles) {
      const path = join(directory, "meta", name);

      if (await exists(path)) {
        await move(path, join(backup, "meta", name));
      }

      await move(join(staged, "meta", name), path);
    }

    if (migration.id !== undefined) {
      await move(join(staged, migration.id), join(directory, migration.id));
    }

    publication.committed = true;
    await savePublication(directory, publication);
  } catch (error) {
    if (publication.committed) {
      preserveBackup = true;
      throw new Error(
        "symmetria: publication commit could not be confirmed; use recover after this process exits",
        { cause: error },
      );
    }

    const failures: unknown[] = [error];

    try {
      await rollbackPublication(publication);
    } catch (rollbackError) {
      failures.push(rollbackError);
    }

    if (failures.length > 1) {
      preserveBackup = true;
      throw new AggregateError(
        failures,
        `symmetria: migration publication rollback failed; original files retained in ${backup}`,
      );
    }

    if (!hadMetadata) {
      await rm(join(directory, "meta"), { recursive: true, force: true });
    }

    preserveBackup = true;
    publication.moves = [];
    await savePublication(directory, publication);
    preserveBackup = false;

    throw error;
  } finally {
    if (!preserveBackup) {
      await rm(temporary, { recursive: true, force: true });
      await rm(join(directory, lockName, "publication.json"), { force: true });
    }
  }
};

/** Replace the SQL chain and journal with a baseline for the current snapshot. */
export const squashMigrations = async (
  options: SquashMigrationsOptions,
): Promise<GeneratedMigration | null> => {
  const directory = resolve(options.directory);
  const name = normalizeName(options.name);

  return withGenerationLock(directory, async () => {
    const { migrations, snapshot } = await readMigrationState(directory);

    if (migrations.length < 2) {
      return null;
    }

    // The baseline is generated from the snapshot alone, so a new installation
    // never runs SQL that generate did not write.
    const custom = migrations.flatMap((migration) => {
      const { manifest } = migration;
      const empty = manifest.before === manifest.after;
      const edited =
        manifest.generated === undefined
          ? // Journals from before the recorded checksum: only empty migrations are known to be hand-written.
            empty && splitMigrationSQL(migration.up).length > 0
          : manifest.generated !== sqlChecksum(migration.up);

      return edited
        ? [
            `  - ${migration.id}: ${empty ? "SQL written into an empty migration" : "up.sql edited after generation"}`,
          ]
        : [];
    });

    if (custom.length && !options.allowCustomSQL) {
      throw new Error(
        `symmetria: squash would drop SQL that generate did not write, so new installations would never run it:\n${custom.join("\n")}\nCopy that SQL into a migration after the baseline (generate <name> --empty), or pass --allow-custom-sql (allowCustomSQL: true) to drop it.`,
      );
    }

    const plan = diffSchemas(emptySnapshot(), snapshot);
    const id = `000001_${name}`;
    const up = formatMigrationSQL(plan.up);
    const down = formatMigrationSQL(plan.down);
    const manifest: MigrationManifest = {
      version: 1,
      id,
      parent: null,
      before: snapshotHash(emptySnapshot()),
      after: snapshotHash(snapshot),
      generated: sqlChecksum(up),
    };
    const squashed: GeneratedMigration = {
      id,
      manifest,
      snapshot,
      up,
      down,
      checksum: migrationChecksum(manifest, up, down),
    };
    await writeMigrationFiles(directory, squashed, [manifest], {
      replaced: migrations.map((migration) => migration.id),
      signal: options.signal,
    });

    return squashed;
  });
};

/** SQL files are editable before application; applied checksums include both directions. */
export const generateMigration = async (
  options: GenerateMigrationOptions,
): Promise<GeneratedMigration | null> => {
  const directory = resolve(options.directory);
  const name = normalizeName(options.name);

  if (
    options.transaction !== undefined &&
    !["batch", "each", "none"].includes(options.transaction)
  ) {
    throw new Error("symmetria: transaction must be batch, each, or none");
  }

  if (options.online && options.transaction && options.transaction !== "none") {
    throw new Error(
      'symmetria: online generation requires transaction: "none"',
    );
  }

  return withGenerationLock(directory, async () => {
    const { migrations, snapshot: before } =
      await readMigrationState(directory);
    const previous = migrations.at(-1);

    if (!options.empty && !options.snapshot) {
      throw new Error("symmetria: generation requires a schema snapshot");
    }

    const next = options.empty ? before : options.snapshot!;
    const after =
      "version" in next
        ? parseMigrationSnapshot(next)
        : migrationSnapshot(next);
    const plan = diffSchemas(before, after, options);

    const destructive = options.allowDestructive
      ? []
      : lintMigration(plan, options.renames).filter(
          (finding) => finding.level === "destructive",
        );

    if (destructive.length) {
      throw new Error(
        `symmetria: destructive migration requires explicit rename hints or allowDestructive (--allow-destructive):\n${destructive
          .map(
            (finding) =>
              `  - ${finding.table}${finding.column ? `.${finding.column}` : ""}: ${finding.message}`,
          )
          .join("\n")}`,
      );
    }

    if (!options.empty && !plan.up.length && !plan.down.length) {
      return null;
    }

    const ordinal = Number(previous?.id.slice(0, 6) ?? 0) + 1;

    if (ordinal > 999999) {
      throw new Error("symmetria: migration sequence exhausted");
    }

    const id = `${String(ordinal).padStart(6, "0")}_${name}`;
    const up = formatMigrationSQL(plan.up);
    const down = formatMigrationSQL(plan.down);
    const manifest: MigrationManifest = {
      version: 1,
      id,
      parent: previous?.id ?? null,
      before: snapshotHash(before),
      after: snapshotHash(after),
      ...(options.online
        ? { transaction: "none" as const }
        : options.transaction && options.transaction !== "batch"
          ? { transaction: options.transaction }
          : {}),
      generated: sqlChecksum(up),
    };
    const migration: GeneratedMigration = {
      id,
      manifest,
      snapshot: after,
      up,
      down,
      checksum: migrationChecksum(manifest, up, down),
    };
    await writeMigrationFiles(
      directory,
      migration,
      [...migrations.map((entry) => entry.manifest), manifest],
      {
        // The way back while no database has applied it: `discard`.
        undo: { migration: id, snapshot: before },
        signal: options.signal,
      },
    );

    return migration;
  });
};

const execute = promisify(execFile);

/**
 * The snapshot with a hash from the history of `meta/snapshot.json` in Git:
 * the working tree's last commit first, then older ones. Undefined outside a
 * repository or when no version has it.
 */
const snapshotFromHistory = async (
  directory: string,
  hash: string,
): Promise<MigrationSnapshot | undefined> => {
  // Git names files by their real path; a temporary directory may be a link.
  const path = await realpath(join(directory, "meta", "snapshot.json")).catch(
    () => join(directory, "meta", "snapshot.json"),
  );
  const git = (from: string, ...argumentsList: string[]) =>
    execute("git", ["-C", from, ...argumentsList], {
      maxBuffer: 64 * 1024 * 1024,
    }).then((result) => result.stdout);

  try {
    const root = (
      await git(dirname(path), "rev-parse", "--show-toplevel")
    ).trim();
    const file = relative(root, path).split("\\").join("/");
    const commits = (
      await git(root, "log", "--format=%H", "-n", "200", "--", file)
    )
      .split("\n")
      .filter(Boolean);

    for (const commit of commits) {
      try {
        const snapshot = parseMigrationSnapshot(
          JSON.parse(await git(root, "show", `${commit}:${file}`)),
        );

        if (snapshotHash(snapshot) === hash) {
          return snapshot;
        }
      } catch {
        // A version that does not parse is not the one looked for.
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
};

/** The snapshot whose hash a chain expects: from the journal, the empty chain or Git. */
const knownSnapshot = async (
  directory: string,
  hash: string,
  undo: MigrationJournal["undo"],
): Promise<
  | { snapshot: MigrationSnapshot; source: DiscardedMigration["source"] }
  | undefined
> => {
  if (undo && snapshotHash(undo.snapshot) === hash) {
    return { snapshot: undo.snapshot, source: "journal" };
  }

  if (snapshotHash(emptySnapshot()) === hash) {
    return { snapshot: emptySnapshot(), source: "empty chain" };
  }

  const remembered = await snapshotFromHistory(directory, hash);

  return remembered ? { snapshot: remembered, source: "git" } : undefined;
};

/**
 * The migration `discardMigration` would take out of the journal, read
 * without changing anything: the latest one, also when its directory was
 * deleted by hand (`removed`), which is why the chain does not load. Undefined
 * when discard would only put the snapshot back, or has nothing to discard.
 * The CLI asks the configured database about this migration first.
 */
export const discardTarget = async (
  directory: string,
): Promise<{ id: string; removed: boolean } | undefined> => {
  const state = await readUnlocked(resolve(directory), {
    snapshotMismatch: "keep",
  });

  if (state.removed) {
    return { id: state.removed.id, removed: true };
  }

  const latest = state.mismatch ? undefined : state.migrations.at(-1);

  return latest ? { id: latest.id, removed: false } : undefined;
};

/**
 * Takes back the latest migration: its SQL leaves the directory, and the
 * journal and the snapshot are what they were before it was generated. Only
 * for a migration no database has applied; the CLI checks the configured one.
 * With the files already removed by hand, it puts the snapshot back.
 */
export const discardMigration = async (
  options: DiscardMigrationOptions,
): Promise<DiscardedMigration> => {
  const directory = resolve(options.directory);

  return withGenerationLock(directory, async () => {
    const state = await readMigrationState(directory, {
      snapshotMismatch: "keep",
    });
    const latest = state.migrations.at(-1);
    const { removed } = state;

    if (removed && options.id !== undefined && options.id !== removed.id) {
      throw new Error(
        `symmetria: only the latest migration can be discarded; it is "${removed.id}" (its directory is already gone), not "${options.id}"`,
      );
    }

    // Its directory deleted, a migration that changed nothing leaves only
    // its journal entry behind.
    if (removed && !state.mismatch) {
      await writeMigrationFiles(
        directory,
        { snapshot: state.snapshot },
        state.migrations.map((entry) => entry.manifest),
        { signal: options.signal },
      );

      return { id: removed.id, source: "journal" };
    }

    // A migration removed by hand left a snapshot of what it made.
    if (state.mismatch) {
      if (options.id !== undefined && !removed) {
        throw new Error(
          `symmetria: ${join(directory, "meta", "snapshot.json")} does not match the journal, so "${options.id}" cannot be discarded; run discard without an ID to put the snapshot back first`,
        );
      }

      const expected = latest?.manifest.after ?? snapshotHash(emptySnapshot());
      const found = await knownSnapshot(directory, expected, state.undo);

      if (!found) {
        throw new Error(
          `symmetria: the snapshot after ${latest ? `"${latest.id}"` : "an empty chain"} is not in the journal or in the Git history of ${join(directory, "meta", "snapshot.json")}; restore that file from a backup`,
        );
      }

      await writeMigrationFiles(
        directory,
        { snapshot: found.snapshot },
        state.migrations.map((entry) => entry.manifest),
        { signal: options.signal },
      );

      return removed
        ? { id: removed.id, source: found.source }
        : { source: found.source };
    }

    if (!latest) {
      throw new Error("symmetria: there is no migration to discard");
    }

    if (options.id !== undefined && options.id !== latest.id) {
      throw new Error(
        `symmetria: only the latest migration can be discarded; it is "${latest.id}", not "${options.id}"`,
      );
    }

    if (
      !options.allowEdited &&
      latest.manifest.generated !== undefined &&
      latest.manifest.generated !== sqlChecksum(latest.up)
    ) {
      throw new Error(
        `symmetria: ${latest.id}/up.sql was edited after it was generated; discard would lose the edits, so it needs --force (allowEdited)`,
      );
    }

    const found = await knownSnapshot(
      directory,
      latest.manifest.before,
      state.undo?.migration === latest.id ? state.undo : undefined,
    );

    if (!found) {
      throw new Error(
        `symmetria: the snapshot before "${latest.id}" is not in the journal or in the Git history of ${join(directory, "meta", "snapshot.json")}; restore that file as it was before the migration was generated, then delete the "${latest.id}" directory and its journal entry`,
      );
    }

    await writeMigrationFiles(
      directory,
      { snapshot: found.snapshot },
      state.migrations.slice(0, -1).map((entry) => entry.manifest),
      { replaced: [latest.id], signal: options.signal },
    );

    return { id: latest.id, source: found.source };
  });
};
