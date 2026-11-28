/**
 * Interactive dashboard: header with chain, connectivity and schema state, plus a menu for generate,
 * migrate, inspect, status and rollback.
 */
import { relative } from "node:path";
import { diffSchemas, loadMigrationState, migrator } from "../../index";
import { formatDashboard } from "../ui/format";
import { inspectSchema } from "./schema-browser";
import { interruption } from "../signals";
import { formatError } from "../ui/style";
import { choose, view, withScreen } from "../ui/terminal";
import {
  databaseDriver,
  displayedUrl,
  missingDirectoryNote,
  type CliContext,
  type Project,
} from "../context";

const ACTIONS = [
  [
    "View schema changes",
    "diff",
    "Compare your schema with the latest local snapshot.",
  ],
  [
    "Generate migration",
    "generate",
    "Turn schema changes into a versioned SQL migration.",
  ],
  ["Apply migrations", "migrate", "Run pending migrations against PostgreSQL."],
  [
    "Inspect schema",
    "inspect",
    "Explore tables, columns, relationships and constraints.",
  ],
  [
    "Migration history",
    "status",
    "See applied and pending migrations at a glance.",
  ],
  [
    "Rollback latest migration",
    "rollback",
    "Execute down.sql for the latest applied migration.",
  ],
  ["Exit", "", "Back to your terminal."],
] as const;

const clear = () => process.stdout.write("\u001b[H\u001b[2J");

/** What the dashboard header shows: local chain, database connectivity and schema changes. */
const overview = async (context: CliContext, project: Project) => {
  const { migrations, snapshot: before } = await loadMigrationState(
    project.directory,
  );
  const snapshot = project.snapshot();
  // What `status` says of a migrations directory that is not there: a wrong
  // path, which it refuses, or a project before its first `generate`. The
  // header says the same instead of counting an empty chain as up to date.
  let missing: string | undefined;

  try {
    missing = missingDirectoryNote(project, context.values);
  } catch (error) {
    missing = (error instanceof Error ? error.message : String(error))
      .replace(/^symmetria: /, "")
      .replace(/^./, (first) => first.toUpperCase());
  }

  const summary = {
    migrations: `${migrations.length} local · database not configured`,
    address: "Offline · set DATABASE_URL to connect",
    connection: "offline" as "connected" | "offline" | "unavailable",
    pending: 0,
    applied: 0,
  };

  if (project.databaseUrl) {
    // A socket directory is no URL; a bad URL is reported below, and never
    // shown: text that is not one can hold a password anywhere.
    const url = displayedUrl(project.databaseUrl);
    summary.address = url
      ? `PostgreSQL · ${url.hostname}:${url.port || "5432"}${url.pathname}`
      : "PostgreSQL";
    let driver: ReturnType<typeof databaseDriver> | undefined;

    try {
      const opened = databaseDriver(project);
      driver = opened;
      const statuses = await context.progress("Checking PostgreSQL", () =>
        migrator({ driver: opened, ...project.runnerOptions }).status(),
      );
      summary.applied = statuses.filter(
        (entry) => entry.status === "applied",
      ).length;
      summary.pending = statuses.filter(
        (entry) => entry.status === "pending",
      ).length;
      summary.connection = "connected";
      summary.migrations = `${summary.applied} applied · ${summary.pending} pending`;
      const incomplete = statuses.length - summary.applied - summary.pending;

      if (incomplete) {
        summary.migrations += ` · ${incomplete} incomplete (${statuses.some((entry) => entry.running) ? "running in another process" : "repair required"})`;
      }
    } catch (error) {
      summary.connection = "unavailable";
      summary.migrations = `Unavailable: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      await driver?.close();
    }
  }

  return {
    ...summary,
    ...(missing ? { missing } : {}),
    snapshot,
    local: migrations.length,
    changes: snapshot
      ? diffSchemas(before, snapshot).up.filter(
          (statement) => !statement.startsWith("--"),
        ).length
      : undefined,
    config: project.present
      ? relative(process.cwd(), project.configPath) || project.configPath
      : "No config · symmetria init to get started",
  };
};

/** `dashboard` (the bare `symmetria` command): a menu that runs the other commands in place. */
export const dashboard = async (
  context: CliContext,
  project: Project,
): Promise<void> => {
  const { values, color } = context;

  if (!context.interactive) {
    throw new Error("symmetria: dashboard requires an interactive terminal");
  }

  const forwarded = [
    ...(values.config ? ["--config", values.config] : []),
    ...(values.dir ? ["--dir", values.dir] : []),
    ...(values["database-url"]
      ? ["--database-url", values["database-url"]]
      : []),
    ...(values["no-color"] ? ["--no-color"] : []),
    ...(values["no-animation"] ? ["--no-animation"] : []),
  ];

  return withScreen(async () => {
    while (true) {
      const state = await overview(context, project);
      const selected = await choose(
        "Choose an action",
        ACTIONS.map(([label]) => label),
        {
          color,
          animation: !values["no-animation"],
          header: (frame) => formatDashboard(state, color, frame),
          descriptions: ACTIONS.map(([, , description]) => description),
        },
      );
      const action = selected === undefined ? "" : ACTIONS[selected]![1];

      if (!action) {
        return;
      }

      clear();

      if (action === "inspect" && state.snapshot) {
        try {
          await inspectSchema(state.snapshot, { color });
        } catch (error) {
          await view(
            "inspect",
            formatError(
              error instanceof Error ? error.message : String(error),
              color,
            ),
            color,
          );
        }

        clear();
        continue;
      }

      const messages: string[] = [];
      // An action's exit code (status with an incomplete migration, say)
      // belongs to its view, not to the dashboard's exit.
      const exitCode = process.exitCode;

      try {
        await context.rerun([action, ...forwarded], (message) => {
          messages.push(message);
        });
      } catch (error) {
        // Ctrl-C or SIGTERM during the action ends the dashboard: the error
        // is reported, after the screen is restored, with 130 or 143.
        if (interruption()) {
          throw error;
        }

        messages.push(
          formatError(
            error instanceof Error ? error.message : String(error),
            color,
          ),
        );
      }

      if (interruption()) {
        return;
      }

      // Bun ignores `process.exitCode = undefined`; 0 resets it on both.
      process.exitCode = exitCode ?? 0;
      await view(action, messages.join("\n"), color);
      clear();
    }
  });
};
