import { recoverMigrationFiles, squashMigrations } from "../../index";
import type { CliContext, Project } from "../context";

/** `recover`: finish or roll back a publication left behind by a crashed generator. */
export const recover = async (
  context: CliContext,
  project: Project,
): Promise<void> => {
  await recoverMigrationFiles(project.directory);
  context.emit({
    json: { recovered: true },
    plain: () => "Migration files recovered.",
  });
};

/** `squash <name>`: replace the local chain with one baseline migration. */
export const squash = async (
  context: CliContext,
  project: Project,
  name: string,
): Promise<void> => {
  const squashed = await context.progress("Squashing migrations", () =>
    squashMigrations({ directory: project.directory, name }),
  );
  context.emit({
    json: squashed ? { id: squashed.id } : { id: null },
    plain: () =>
      squashed
        ? `Squashed into ${squashed.id}. Run "symmetria adopt" on databases that applied the old chain.`
        : "Nothing to squash.",
  });
};
