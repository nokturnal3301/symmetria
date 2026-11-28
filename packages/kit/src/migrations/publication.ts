/**
 * Atomic publication of generated migration files: lock file, fsync, ownership record, rollback and crash recovery.
 */
import {
  open,
  readFile,
  readdir,
  rename,
  rm,
  mkdir,
  writeFile,
  stat,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

export const generationLockName = ".symmetria-generate.lock";
/** A generator stages its files in a directory with this prefix and a random suffix. */
export const stagingPrefix = ".symmetria-";
export type Publication = {
  temporary: string;
  hadMetadata: boolean;
  moves: { source: string; destination: string; identity: string }[];
  committed: boolean;
};

export const fileIdentity = async (
  path: string,
): Promise<string | undefined> => {
  try {
    const value = await stat(path, { bigint: true });

    return `${value.dev}:${value.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

export const syncPath = async (path: string) => {
  const file = await open(path, "r");

  try {
    await file.sync();
  } finally {
    await file.close();
  }
};

export const savePublication = async (
  directory: string,
  publication: Publication,
) => {
  const path = join(directory, generationLockName, "publication.json");
  await writeFile(`${path}.next`, JSON.stringify(publication));
  await syncPath(`${path}.next`);
  await rename(`${path}.next`, path);
  await syncPath(dirname(path));
};

export const recordGenerationOwner = async (directory: string) => {
  const path = join(directory, generationLockName, "owner.json");
  await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname() }));
  await syncPath(path);
  await syncPath(dirname(path));
  await syncPath(directory);
};

const present = async (path: string) => {
  try {
    const file = await open(path);
    await file.close();

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

export const rollbackPublication = async (publication: Publication) => {
  for (const { source, destination, identity } of [
    ...publication.moves,
  ].reverse()) {
    const sourceIdentity = await fileIdentity(source);

    if (sourceIdentity === identity) {
      continue;
    }

    if (
      (await fileIdentity(destination)) === identity &&
      sourceIdentity === undefined
    ) {
      await rename(destination, source);
      await syncPath(dirname(source));
      await syncPath(dirname(destination));
    } else {
      throw new Error(
        `symmetria: conflicting publication recovery files: ${source} and ${destination}`,
      );
    }
  }
};

/** Whether anything but directories lies below `path`. */
const holdsFiles = async (path: string): Promise<boolean> => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || (await holdsFiles(join(path, entry.name)))) {
      return true;
    }
  }

  return false;
};

/**
 * Removes the staging directories of a generator that stopped before its
 * first publication record. Only one generator works in a directory at a time,
 * and each keeps the lock for as long as its staging directory exists: with
 * the lock in the hands of a dead process, no live generator owns one. A
 * directory counts as staging by its name (the prefix and the six characters
 * mkdtemp adds) and its content (`staged/` and `backup/` at most), so nothing
 * else named alike is touched. Without a record no file has moved, so
 * `backup/` holds none; one that does is kept, since it may be the only copy
 * of the files it holds.
 */
const removeUnpublishedStaging = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(stagingPrefix) ||
      !/^[A-Za-z0-9]{6}$/.test(entry.name.slice(stagingPrefix.length))
    ) {
      continue;
    }

    const content = await readdir(path, { withFileTypes: true });

    if (
      content.some(
        (item) =>
          !item.isDirectory() || !["staged", "backup"].includes(item.name),
      )
    ) {
      continue;
    }

    if (
      content.some((item) => item.name === "backup") &&
      (await holdsFiles(join(path, "backup")))
    ) {
      throw new Error(
        `symmetria: ${path} holds files that an earlier interrupted generation moved out of the migrations directory (in backup/), and no record says where they belong; move them back or remove the directory by hand, then run recover again`,
      );
    }

    await rm(path, { recursive: true, force: true });
  }
};

/**
 * Recover a process crash without discarding a live writer or guessing at
 * incomplete metadata. Resolves false when no generation lock is left behind.
 */
export const recoverMigrationFiles = async (
  directory: string,
): Promise<boolean> => {
  directory = resolve(directory);
  const lock = join(directory, generationLockName);

  if ((await fileIdentity(lock)) === undefined) {
    return false;
  }

  let owner: { pid: number; host: string };

  try {
    owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `symmetria: generation lock ${lock} has no readable owner.json (the generator stopped before recording it); make sure no generate or squash is running, then inspect and remove the lock manually`,
      { cause: error },
    );
  }

  if (
    owner.host !== hostname() ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1
  ) {
    throw new Error(
      "symmetria: generation lock belongs to another host or has invalid ownership; inspect it manually",
    );
  }

  try {
    process.kill(owner.pid, 0);
    throw new Error("symmetria: migration generation owner is still running");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }

  const recovery = join(lock, "recovering");
  await mkdir(recovery);

  try {
    const path = join(lock, "publication.json");

    if (await present(path)) {
      const publication = JSON.parse(
        await readFile(path, "utf8"),
      ) as Publication;

      // Recovery journals may only move files within this migration directory.
      const inside = (path: string) =>
        resolve(path).startsWith(`${directory}/`);

      if (
        !inside(publication.temporary) ||
        !publication.temporary.startsWith(join(directory, stagingPrefix)) ||
        typeof publication.hadMetadata !== "boolean" ||
        typeof publication.committed !== "boolean" ||
        !Array.isArray(publication.moves) ||
        publication.moves.some(
          (move) =>
            !inside(move.source) ||
            !inside(move.destination) ||
            typeof move.identity !== "string",
        )
      ) {
        throw new Error("symmetria: invalid publication recovery journal");
      }

      if (!publication.committed) {
        await rollbackPublication(publication);

        if (!publication.hadMetadata) {
          await rm(join(directory, "meta"), { recursive: true, force: true });
        }

        publication.moves = [];
        await savePublication(directory, publication);
      }

      await rm(publication.temporary, { recursive: true, force: true });
    } else {
      await removeUnpublishedStaging(directory);
    }

    await rm(lock, { recursive: true, force: true });
    await syncPath(directory);
  } catch (error) {
    await rm(recovery, { recursive: true, force: true });
    throw error;
  }

  return true;
};
