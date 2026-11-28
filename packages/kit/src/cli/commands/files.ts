/**
 * Filesystem CLI commands: recover a crashed generation, squash the chain and
 * discard the latest migration.
 */
import { sqlState } from "symmetria";
import {
  discardMigration,
  recoverMigrationFiles,
  squashMigrations,
} from "../../index";
import { executeSQL, migrationLockHolder } from "../../migrations/execution";
import { discardTarget } from "../../migrations/files";
import { migrationJournal } from "../../migrations/runner";
import {
  databaseDriver,
  withCancellation,
  type CliContext,
  type Project,
} from "../context";

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
  // Squashing takes the generation lock, which would create the directory
  // of a project that has no migrations yet.
  const squashed = project.directoryMissing
    ? null
    : await context.progress("Squashing migrations", () =>
        // Ctrl-C and SIGTERM stop it before anything is published; the lock
        // and the staged files do not outlive the command.
        withCancellation((signal) =>
          squashMigrations({
            directory: project.directory,
            name,
            ...(context.values["allow-custom-sql"]
              ? { allowCustomSQL: true }
              : {}),
            signal,
          }),
        ),
      );
  context.emit({
    json: squashed ? { id: squashed.id } : { id: null },
    plain: () =>
      squashed
        ? `Squashed into ${squashed.id}. Run "symmetria adopt" on databases that applied the old chain.`
        : "Nothing to squash.",
  });
};

/** How long discard waits for a lock on the database's journal, as status does. */
const JOURNAL_LOCK_TIMEOUT_MS = 2000;

/**
 * What the configured database knows of a migration: how its journal lists
 * it (applied, incomplete, or not at all), and the session that holds the
 * migration lock, if another one does. A running `migrate` writes the journal
 * row of a transactional migration inside its open transaction, where no
 * other session sees it, so the lock is the only sign that the migration is
 * being applied right now. The journal table is read itself, not through
 * `status`, which first loads the local chain: discard is the repair for a
 * chain that does not load.
 */
const askDatabase = async (
  project: Project,
  id: string,
): Promise<{
  readonly state?: "applied" | "incomplete";
  readonly running?: { readonly pid: number | undefined };
}> => {
  const { qualifiedName: journal, lockName } = migrationJournal(
    project.runnerOptions,
  );
  const driver = databaseDriver(project);

  try {
    return await driver.transaction(
      async (tx) => {
        const holder = () => migrationLockHolder(tx.execute, lockName);
        // Asked before the journal is read and again after it: a run that
        // starts or ends in between is seen by one of the two. The first
        // answer also spares the wait for a journal the run has locked.
        const before = await holder();

        if (before) {
          return { running: before };
        }

        // A migration that creates or upgrades the journal locks it until
        // it commits: fail with a message instead of waiting behind it.
        await executeSQL(
          tx.execute,
          "SELECT set_config('lock_timeout', $1, true)",
          [`${JOURNAL_LOCK_TIMEOUT_MS}ms`],
        );

        const table = await executeSQL(
          tx.execute,
          "SELECT to_regclass($1)::text AS name",
          [journal],
        );
        // Journals of the first release have no state column: all applied.
        const rows = table.rows[0]?.name
          ? (
              await executeSQL(
                tx.execute,
                `SELECT to_jsonb(history)->>'state' AS state FROM ${journal} history WHERE id = $1`,
                [id],
              )
            ).rows
          : [];

        if (rows.length) {
          return {
            state: rows[0]!.state === "incomplete" ? "incomplete" : "applied",
          };
        }

        const after = await holder();

        return after ? { running: after } : {};
      },
      { isolationLevel: "read committed", readOnly: true },
    );
  } catch (error) {
    if (sqlState(error) === "55P03") {
      throw new Error(
        `symmetria: the migration journal ${journal} is locked by another session, so discard cannot ask whether "${id}" was applied; a migration creating or upgrading the journal holds the lock until it commits. Try again when it finishes`,
        { cause: error },
      );
    }

    throw error;
  } finally {
    await driver.close();
  }
};

/**
 * `discard [id]`: take back the latest migration while no database has
 * applied it. The configured database is asked first, also whether another
 * process is applying migrations there right now, which `--force` does not
 * override; without a database, `--force` says that none has applied it.
 * Putting back a snapshot that does not match the journal takes no migration
 * out of it, so there is nothing to ask.
 */
export const discard = async (
  context: CliContext,
  project: Project,
  id: string | undefined,
): Promise<void> => {
  const { values } = context;

  // Discarding takes the generation lock, which would create the directory.
  if (project.directoryMissing) {
    throw new Error(
      `symmetria: there is no migration to discard: the migrations directory ${project.directory} does not exist`,
    );
  }

  // Also the latest migration whose directory was deleted by hand, which is
  // why every other command refuses the chain.
  const target = await discardTarget(project.directory);

  if (target) {
    if (project.databaseUrl) {
      const { state, running } = await askDatabase(project, target.id);

      if (state) {
        throw new Error(
          target.removed
            ? `symmetria: "${target.id}" is ${state} in the configured database, and its directory is gone: restore the directory (from version control), roll the migration back (symmetria rollback), then discard it`
            : `symmetria: "${target.id}" is ${state} in the configured database; roll it back first (symmetria rollback), then discard it`,
        );
      }

      if (running) {
        throw new Error(
          `symmetria: another process holds the migration lock of the configured database${running.pid === undefined ? "" : ` (PostgreSQL process ${running.pid})`}: a migrate, rollback, adopt or repair is running there and may be applying "${target.id}" right now. Run discard again when it has finished and status shows the migration as pending`,
        );
      }
    } else if (!values.force) {
      throw new Error(
        `symmetria: discard asks the database whether "${target.id}" was applied; set databaseUrl in the config, DATABASE_URL or --database-url, or pass --force when no database has applied it`,
      );
    }
  }

  // Ctrl-C and SIGTERM stop it before anything is published, lock included.
  const discarded = await withCancellation((signal) =>
    discardMigration({
      directory: project.directory,
      ...(id ? { id } : {}),
      ...(values.force ? { allowEdited: true } : {}),
      signal,
    }),
  );
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
