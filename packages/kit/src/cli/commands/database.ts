/**
 * Database-backed CLI commands: verify, drift, repair, adopt, status, migrate and rollback.
 * Each one opens a connection through the shared context and prints or emits JSON.
 */
import {
  detectDrift,
  formatDriftFindings,
  loadMigrationState,
  migrator,
  verifyMigrations,
} from "../../index";
import { formatExecution, formatStatus } from "../ui/format";
import {
  withCancellation,
  withDatabase,
  type CliContext,
  type Project,
} from "../context";

/** `verify`: replay the chain in disposable databases on the verification server. */
export const verify = async (
  context: CliContext,
  project: Project,
): Promise<void> => {
  const url = project.runnerOptions.verificationDatabaseUrl;

  if (!url) {
    throw new Error(
      "symmetria: verify requires --verify-url or verificationDatabaseUrl: an administrative PostgreSQL URL with CREATEDB permission, separate from the application database",
    );
  }

  const result = await withCancellation((signal) =>
    verifyMigrations({
      ...project.runnerOptions,
      ...project.config.verify,
      url,
      signal,
    }),
  );
  context.emit({
    json: result,
    plain: () =>
      `Verified ${result.migrations.length} migrations: installation, upgrade, rollback and reapplication.`,
  });
};

/** `drift`: compare the live catalog with the latest snapshot or the declared schema. */
export const drift = async (
  context: CliContext,
  project: Project,
): Promise<void> =>
  withDatabase(project, async (driver) => {
    const { migrations, snapshot } = await loadMigrationState(
      project.directory,
    );
    const expected =
      (migrations.length ? snapshot : undefined) ?? project.snapshot();

    if (!expected) {
      throw new Error(
        "symmetria: drift needs a migration chain or a schema in the config",
      );
    }

    const { metadataSchema, metadataTable } = project.config;
    const { ignoreTables } = project.runnerOptions;
    const findings = await context.progress("Inspecting the database", () =>
      detectDrift({
        execute: driver.execute,
        snapshot: expected,
        ...(metadataSchema ? { metadataSchema } : {}),
        ...(metadataTable ? { metadataTable } : {}),
        ...(ignoreTables ? { ignoreTables } : {}),
      }),
    );
    context.emit({
      json: { findings },
      indent: 2,
      plain: () => formatDriftFindings(findings),
    });

    if (context.values.strict && findings.length) {
      process.exitCode = 1;
    }
  });

type Runner = ReturnType<typeof migrator>;

/** `migrate`, `rollback`, `status`, `adopt` and `repair` share one migrator bound to the database. */
const withRunner = (
  project: Project,
  operation: (runner: Runner) => Promise<void>,
): Promise<void> =>
  withDatabase(project, (driver, signal) =>
    operation(migrator({ ...project.runnerOptions, driver, signal })),
  );

const plan = async (
  context: CliContext,
  runner: Runner,
  direction: "up" | "down",
): Promise<void> => {
  const { values } = context;
  const steps = await runner.plan({
    ...(values.to ? { to: values.to } : {}),
    ...(values.steps ? { steps: Number(values.steps) } : {}),
    direction,
  });
  context.emit({
    json: { steps },
    indent: 2,
    plain: () =>
      steps
        .map(
          (step) =>
            `-- group ${step.group}: ${step.transaction} · ${step.id}\n${step.statements.map((sql) => `${sql};`).join("\n\n")}`,
        )
        .join("\n\n"),
  });
};

export const repair = (
  context: CliContext,
  project: Project,
  id: string,
): Promise<void> =>
  withRunner(project, async (runner) => {
    const action = context.values.action as "retry" | "complete";
    await runner.repair({ id, action });
    context.emit({
      json: { repaired: id, action },
      plain: () => `Repaired ${id}: ${action}`,
    });
  });

export const adopt = (context: CliContext, project: Project): Promise<void> =>
  withRunner(project, async (runner) => {
    const { values } = context;
    const adopted = await context.progress("Recording the local chain", () =>
      runner.adopt(values.to ? { to: values.to } : {}),
    );
    context.emit({
      json: { adopted },
      plain: () =>
        adopted.length
          ? adopted.map((id) => `Adopted ${id}`).join("\n")
          : "Nothing to adopt.",
    });
  });

export const status = (context: CliContext, project: Project): Promise<void> =>
  withRunner(project, async (runner) => {
    const statuses = await context.progress("Reading migration history", () =>
      runner.status(),
    );

    if (statuses.some((entry) => entry.status === "incomplete")) {
      process.exitCode = 1;
    }

    context.emit({
      json: { migrations: statuses },
      pretty: () => formatStatus(statuses, context.color),
      plain: () =>
        statuses.length
          ? statuses
              .map(
                (entry) =>
                  `${entry.status.padEnd(7)} ${entry.id}${entry.status === "incomplete" ? ` · ${entry.direction} · ${entry.statement} confirmed statements · repair required` : ""}`,
              )
              .join("\n")
          : "No migrations.",
    });
  });

export const migrate = (context: CliContext, project: Project): Promise<void> =>
  withRunner(project, async (runner) => {
    const { values } = context;

    if (values.plan) {
      return plan(context, runner, "up");
    }

    const started = performance.now();
    const applied = await context.progress("Applying migrations", () =>
      runner.migrate(values.to ? { to: values.to } : {}),
    );
    const durationMs = Math.round(performance.now() - started);
    // `--to` an applied migration does nothing; say where the database stands.
    const current =
      !applied.length && values.to
        ? (await runner.status())
            .filter((entry) => entry.status === "applied")
            .at(-1)?.id
        : undefined;
    const idle =
      current === undefined
        ? "Database is up to date."
        : current === values.to
          ? `Database is already at ${values.to}.`
          : `${values.to} is already applied; the database is further along, at ${current}. Use rollback to go back.`;
    context.emit({
      json: { applied, durationMs },
      pretty: () =>
        current === undefined
          ? formatExecution(applied, "Applied", durationMs, context.color)
          : `\n  ${context.style("✓", "success")} ${idle}\n`,
      plain: () =>
        applied.length ? applied.map((id) => `Applied ${id}`).join("\n") : idle,
    });
  });

export const rollback = (
  context: CliContext,
  project: Project,
): Promise<void> =>
  withRunner(project, async (runner) => {
    const { values } = context;

    if (values.plan) {
      return plan(context, runner, "down");
    }

    const started = performance.now();
    const reverted = await context.progress("Rolling back migrations", () =>
      runner.rollback(
        values.steps === undefined ? {} : { steps: Number(values.steps) },
      ),
    );
    const durationMs = Math.round(performance.now() - started);
    context.emit({
      json: { reverted, durationMs },
      pretty: () =>
        formatExecution(reverted, "Reverted", durationMs, context.color),
      plain: () =>
        reverted.length
          ? reverted.map((id) => `Reverted ${id}`).join("\n")
          : "No applied migrations.",
    });
  });
