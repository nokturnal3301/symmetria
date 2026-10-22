import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const migrationDirectory = async (): Promise<string> => {
  const base = process.env.SYMMETRIA_TEST_TMPDIR ?? join(tmpdir(), "symmetria");
  await mkdir(base, { recursive: true });

  return mkdtemp(join(base, "symmetria-migrations-"));
};

export const withMigrationDirectory = async (
  callback: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await migrationDirectory();

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
