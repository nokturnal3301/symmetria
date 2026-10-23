import {
  open,
  readFile,
  rename,
  rm,
  mkdir,
  writeFile,
  stat,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

export const generationLockName = ".symmetria-generate.lock";
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

/** Recover a process crash without discarding a live writer or guessing at incomplete metadata. */
export const recoverMigrationFiles = async (
  directory: string,
): Promise<void> => {
  directory = resolve(directory);
  const lock = join(directory, generationLockName);
  const owner = JSON.parse(
    await readFile(join(lock, "owner.json"), "utf8"),
  ) as { pid: number; host: string };

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
        !publication.temporary.startsWith(join(directory, ".symmetria-")) ||
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
    }

    await rm(lock, { recursive: true, force: true });
    await syncPath(directory);
  } catch (error) {
    await rm(recovery, { recursive: true, force: true });
    throw error;
  }
};
