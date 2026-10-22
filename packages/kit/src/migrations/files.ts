import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SchemaSnapshot } from "symmetria";
import { diffSchemas, type MigrationDiffOptions } from "./diff";
import {
  canonicalJSON,
  checksum,
  compareNames,
  emptySnapshot,
  migrationSnapshot,
  parseMigrationSnapshot,
  snapshotHash,
  type MigrationSnapshot,
} from "./snapshot";
import { formatMigrationSQL, splitMigrationSQL } from "./sql";

export type MigrationManifest = {
  version: 1;
  id: string;
  parent: string | null;
  before: string;
  after: string;
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
};
export type SquashMigrationsOptions = {
  directory: string;
  name: string;
};
type MigrationJournal = {
  version: 1;
  migrations: MigrationManifest[];
};
const migrationIdPattern = /^\d{6}_[a-z0-9][a-z0-9_]*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const metadataFiles = ["migration.json", "snapshot.json"];
const lockName = ".symmetria-generate.lock";

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
): Promise<MigrationState> => {
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
  const metadata = await readDirectory(join(directory, "meta"));

  if (!directories.length && !metadata.length) {
    return { migrations: [], snapshot: emptySnapshot() };
  }

  if (
    metadata.length !== metadataFiles.length ||
    metadata.some(
      (entry) => !entry.isFile() || !metadataFiles.includes(entry.name),
    )
  ) {
    throw new Error(
      "symmetria: migration metadata must contain only meta/snapshot.json and meta/migration.json",
    );
  }

  const [journalText, snapshotText] = await Promise.all(
    metadataFiles.map((name) =>
      readFile(join(directory, "meta", name), "utf8"),
    ),
  );
  const journal = JSON.parse(journalText!) as MigrationJournal;
  const snapshot = parseMigrationSnapshot(JSON.parse(snapshotText!));

  if (
    !journal ||
    journal.version !== 1 ||
    !Array.isArray(journal.migrations) ||
    journal.migrations.length !== directories.length
  ) {
    throw new Error(
      "symmetria: migration journal does not match SQL directories",
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
      !hashPattern.test(manifest.after)
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
      checksum: checksum(canonicalJSON({ manifest, up, down })),
    });
    previousHash = manifest.after;
    previousOrdinal = Number(id.slice(0, 6));
  }

  if (snapshotHash(snapshot) !== previousHash) {
    throw new Error(
      "symmetria: latest snapshot checksum does not match the migration journal",
    );
  }

  return { migrations, snapshot };
};

/** One current schema snapshot and a compact journal for the entire SQL chain. */
export const loadMigrationState = async (
  directory: string,
): Promise<MigrationState> => {
  const assertUnlocked = async () => {
    if (await exists(join(directory, lockName))) {
      throw new Error("symmetria: migration generation is already locked");
    }
  };

  await assertUnlocked();
  const state = await readMigrationState(directory);
  await assertUnlocked();

  return state;
};

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
      throw new Error("symmetria: migration generation is already locked");
    }

    throw error;
  });

  try {
    return await callback();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

const writeMigrationFiles = async (
  directory: string,
  migration: GeneratedMigration,
  manifests: MigrationManifest[],
  replaced: string[] = [],
): Promise<void> => {
  if (
    !replaced.includes(migration.id) &&
    (await exists(join(directory, migration.id)))
  ) {
    throw new Error(`symmetria: migration "${migration.id}" already exists`);
  }

  const temporary = await mkdtemp(join(directory, ".symmetria-"));
  const staged = join(temporary, "staged");
  const backup = join(temporary, "backup");
  const moved: { source: string; destination: string }[] = [];
  let preserveBackup = false;
  const hadMetadata = await exists(join(directory, "meta"));

  const move = async (source: string, destination: string): Promise<void> => {
    await rename(source, destination);
    moved.push({ source, destination });
  };

  try {
    await Promise.all([
      mkdir(join(staged, migration.id), { recursive: true }),
      mkdir(join(staged, "meta"), { recursive: true }),
      mkdir(join(backup, "meta"), { recursive: true }),
    ]);
    const journal: MigrationJournal = { version: 1, migrations: manifests };
    await Promise.all([
      writeFile(join(staged, migration.id, "up.sql"), migration.up),
      writeFile(join(staged, migration.id, "down.sql"), migration.down),
      writeFile(
        join(staged, "meta", "migration.json"),
        `${JSON.stringify(journal, null, 2)}\n`,
      ),
      writeFile(
        join(staged, "meta", "snapshot.json"),
        `${JSON.stringify(migration.snapshot, null, 2)}\n`,
      ),
    ]);
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

    await move(join(staged, migration.id), join(directory, migration.id));
  } catch (error) {
    const failures: unknown[] = [error];

    for (const { source, destination } of moved.reverse()) {
      try {
        await rename(destination, source);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
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

    throw error;
  } finally {
    if (!preserveBackup) {
      await rm(temporary, { recursive: true, force: true });
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

    const plan = diffSchemas(emptySnapshot(), snapshot);
    const id = `000001_${name}`;
    const manifest: MigrationManifest = {
      version: 1,
      id,
      parent: null,
      before: snapshotHash(emptySnapshot()),
      after: snapshotHash(snapshot),
    };
    const up = formatMigrationSQL(plan.up);
    const down = formatMigrationSQL(plan.down);
    const squashed: GeneratedMigration = {
      id,
      manifest,
      snapshot,
      up,
      down,
      checksum: checksum(canonicalJSON({ manifest, up, down })),
    };
    await writeMigrationFiles(
      directory,
      squashed,
      [manifest],
      migrations.map((migration) => migration.id),
    );

    return squashed;
  });
};

/** SQL files are editable before application; applied checksums include both directions. */
export const generateMigration = async (
  options: GenerateMigrationOptions,
): Promise<GeneratedMigration | null> => {
  const directory = resolve(options.directory);
  const name = normalizeName(options.name);

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

    if (!options.empty && !plan.up.length && !plan.down.length) {
      return null;
    }

    const ordinal = Number(previous?.id.slice(0, 6) ?? 0) + 1;

    if (ordinal > 999999) {
      throw new Error("symmetria: migration sequence exhausted");
    }

    const id = `${String(ordinal).padStart(6, "0")}_${name}`;
    const manifest: MigrationManifest = {
      version: 1,
      id,
      parent: previous?.id ?? null,
      before: snapshotHash(before),
      after: snapshotHash(after),
    };
    const up = formatMigrationSQL(plan.up);
    const down = formatMigrationSQL(plan.down);
    const migration: GeneratedMigration = {
      id,
      manifest,
      snapshot: after,
      up,
      down,
      checksum: checksum(canonicalJSON({ manifest, up, down })),
    };
    await writeMigrationFiles(directory, migration, [
      ...migrations.map((entry) => entry.manifest),
      manifest,
    ]);

    return migration;
  });
};
