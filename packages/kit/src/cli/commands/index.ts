/**
 * Dispatches a parsed command line to the command implementation in ./schema, ./database,
 * ./files, ./graph, ./init, ./pull or ./profile.
 */
import { loadProject, type CliContext } from "../context";
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
import { recover, squash } from "./files";
import { graph } from "./graph";
import { init } from "./init";
import { profile } from "./profile";
import { pull } from "./pull";
import { diff, generate, inspect, lint } from "./schema";

/** Runs one command; every command except `profile`, `init` and `pull` works on the loaded project. */
export const runCommand = async (
  command: Command,
  name: string | undefined,
  context: CliContext,
): Promise<void> => {
  switch (command) {
    case "profile":
      return profile(context);
    case "init":
      return init(context, name);
    case "pull":
      return pull(context, name);
    default:
  }

  const project = await loadProject(context);

  switch (command) {
    case "recover":
      return recover(context, project);
    case "squash":
      return squash(context, project, name!);
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
