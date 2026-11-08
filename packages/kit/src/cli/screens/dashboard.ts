/**
 * Interactive dashboard: header with chain, connectivity and schema state, plus a menu for generate,
 * migrate, inspect, status and rollback.
 */
import { relative } from "node:path";
import { postgres } from "symmetria/driver";
import { diffSchemas, loadMigrationState, migrator } from "../../index";
import { formatDashboard } from "../ui/format";
import { inspectSchema } from "./schema-browser";
import { formatError } from "../ui/style";
import { choose, view, withScreen } from "../ui/terminal";
import type { CliContext, Project } from "../context";

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
  const summary = {
    migrations: `${migrations.length} local · database not configured`,
    address: "Offline · set DATABASE_URL to connect",
    connection: "offline" as "connected" | "offline" | "unavailable",
    pending: 0,
    applied: 0,
  };

  if (project.databaseUrl) {
    const url = new URL(project.databaseUrl);
    summary.address = `PostgreSQL · ${url.hostname}:${url.port || "5432"}${url.pathname}`;
    const driver = postgres(project.databaseUrl);

    try {
      const statuses = await context.progress("Checking PostgreSQL", () =>
        migrator({ driver, ...project.runnerOptions }).status(),
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
        summary.migrations += ` · ${incomplete} incomplete (repair required)`;
      }
    } catch (error) {
      summary.connection = "unavailable";
      summary.migrations = `Unavailable: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      await driver.close();
    }
  }

  return {
    ...summary,
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

      try {
        await context.rerun([action, ...forwarded], (message) => {
          messages.push(message);
        });
      } catch (error) {
        messages.push(
          formatError(
            error instanceof Error ? error.message : String(error),
            color,
          ),
        );
      }

      await view(action, messages.join("\n"), color);
      clear();
    }
  });
};
