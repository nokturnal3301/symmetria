/**
 * Filesystem CLI commands: recover a crashed generation, squash the chain and
 * discard the latest migration.
 */
import { postgres } from "symmetria/driver";
import {
  discardMigration,
  loadMigrationState,
  migrator,
  recoverMigrationFiles,
  squashMigrations,
} from "../../index";
import type { CliContext, Project } from "../context";

/** `recover`: finish or roll back a publication left behind by a crashed generator. */
export const recover = async (
  context: CliContext,
  project: Project,
): Promise<void> => {
  const recovered = await recoverMigrationFiles(project.directory);
  context.emit({
    json: { recovered },
    plain: () =>
      recovered
        ? "Migration files recovered."
        : "Nothing to recover: no generation lock was left behind.",
  });
};

/** `squash <name>`: replace the local chain with one baseline migration. */
export const squash = async (
  context: CliContext,
  project: Project,
  name: string,
): Promise<void> => {
  const squashed = await context.progress("Squashing migrations", () =>
    squashMigrations({
      directory: project.directory,
      name,
      ...(context.values["allow-custom-sql"] ? { allowCustomSQL: true } : {}),
    }),
  );
  context.emit({
    json: squashed ? { id: squashed.id } : { id: null },
    plain: () =>
      squashed
        ? `Squashed into ${squashed.id}. Run "symmetria adopt" on databases that applied the old chain.`
        : "Nothing to squash.",
  });
};

/**
 * `discard [id]`: take back the latest migration while no database has
 * applied it. The configured database is asked first; without one, `--force`
 * says that none has.
 */
export const discard = async (
  context: CliContext,
  project: Project,
  id: string | undefined,
): Promise<void> => {
  const { values } = context;
  const { migrations } = await loadMigrationState(project.directory).catch(
    () => ({ migrations: [] }),
  );
  const latest = migrations.at(-1)?.id;

  if (latest !== undefined) {
    if (project.databaseUrl) {
      const driver = postgres(project.databaseUrl);

      try {
        const entry = (
          await migrator({ driver, ...project.runnerOptions }).status()
        ).find((status) => status.id === latest);

        if (entry && entry.status !== "pending") {
          throw new Error(
            `symmetria: "${latest}" is ${entry.status} in the configured database; roll it back first (symmetria rollback), then discard it`,
          );
        }
      } finally {
        await driver.close();
      }
    } else if (!values.force) {
      throw new Error(
        `symmetria: discard asks the database whether "${latest}" was applied; set databaseUrl in the config, DATABASE_URL or --database-url, or pass --force when no database has applied it`,
      );
    }
  }

  const discarded = await discardMigration({
    directory: project.directory,
    ...(id ? { id } : {}),
    ...(values.force ? { allowEdited: true } : {}),
  });
  const from =
    discarded.source === "git" ? " (the earlier snapshot came from Git)" : "";
  context.emit({
    json: discarded,
    plain: () =>
      discarded.id
        ? `Discarded ${discarded.id}; the snapshot is the schema before it${from}.`
        : `The snapshot matches the journal again${from}.`,
  });
};
