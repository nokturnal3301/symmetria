/**
 * Dispatches a parsed command line to the command implementation in ./schema, ./database,
 * ./files, ./graph, ./init, ./pull or ./profile.
 */
import { loadProject, missingDirectoryNote, type CliContext } from "../context";
import type { Command } from "../options";
import { dashboard } from "../screens/dashboard";
import {
  adopt,
  drift,
  migrate,
  repair,
  rollback,
  status,
  verify,
} from "./database";
import { discard, recover, squash } from "./files";
import { graph } from "./graph";
import { init } from "./init";
import { profile } from "./profile";
import { pull } from "./pull";
import { diff, generate, inspect, lint } from "./schema";

/**
 * Commands that read the migration files. A migrations directory that does
 * not exist is refused for them when it is a wrong path (see
 * missingDirectoryNote). `generate` creates the directory, and `diff`,
 * `inspect` and `graph` describe the declared schema without it.
 */
const READS_MIGRATIONS: readonly Command[] = [
  "migrate",
  "status",
  "rollback",
  "adopt",
  "repair",
  "verify",
  "drift",
  "lint",
  "squash",
  "discard",
  "recover",
];

/**
 * Of those, the commands whose answer for an empty chain reads as success
 * ("Database is up to date.", "Verified 0 migrations"). In a project that has
 * no migrations directory yet they say that instead; `lint` and `drift` still
 * review the declared schema, and the others fail on their own.
 */
const REPORTS_NOTHING: readonly Command[] = [
  "migrate",
  "status",
  "rollback",
  "verify",
  "squash",
  "recover",
];

/** Runs one command; every command except `profile`, `init` and `pull` works on the loaded project. */
export const runCommand = async (
  command: Command,
  name: string | undefined,
  base: CliContext,
): Promise<void> => {
  switch (command) {
    case "profile":
      return profile(base);
    case "init":
      return init(base, name);
    case "pull":
      return pull(base, name);
    default:
  }

  const project = await loadProject(base);
  const note = READS_MIGRATIONS.includes(command)
    ? missingDirectoryNote(project, base.values)
    : undefined;
  // The command still runs, so a database that holds applied migrations of
  // another chain is reported as before; only its "nothing to do" changes.
  const context: CliContext =
    note && REPORTS_NOTHING.includes(command)
      ? {
          ...base,
          emit: ({ json, indent, replacer }) =>
            base.emit({
              json: {
                ...(json as Record<string, unknown>),
                missingDirectory: project.directory,
              },
              ...(indent === undefined ? {} : { indent }),
              ...(replacer ? { replacer } : {}),
              plain: () => note,
            }),
        }
      : base;

  switch (command) {
    case "recover":
      return recover(context, project);
    case "squash":
      return squash(context, project, name!);
    case "discard":
      return discard(context, project, name);
    case "dashboard":
      return dashboard(context, project);
    case "inspect":
      return inspect(context, project, name);
    case "graph":
      return graph(context, project, name);
    case "lint":
      return lint(context, project);
    case "diff":
      return diff(context, project);
    case "generate":
      return generate(context, project, name);
    case "verify":
      return verify(context, project);
    case "drift":
      return drift(context, project);
    case "repair":
      return repair(context, project, name!);
    case "adopt":
      return adopt(context, project);
    case "status":
      return status(context, project);
    case "migrate":
      return migrate(context, project);
    case "rollback":
      return rollback(context, project);
  }
};
