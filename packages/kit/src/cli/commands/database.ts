/**
 * Database-backed CLI commands: verify, drift, repair, adopt, status, migrate and rollback.
 * Each one opens a connection through the shared context and prints or emits JSON.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  detectDrift,
  formatDriftFindings,
  loadMigrationState,
  migrator,
  parseMigrationSnapshot,
  snapshotHash,
  verifyMigrations,
} from "../../index";
import { boundaryDifferences } from "../../migrations/verify";
import { formatExecution, formatPlan, formatStatus } from "../ui/format";
import { terminalOutput } from "../ui/style";
import { ask } from "../ui/terminal";
import {
  confirmRollback,
  databaseName,
  rollbackSummary,
} from "../screens/rollback-prompt";
import {
  verificationUrl,
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
  const url = verificationUrl(project);

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

/**
 * `drift`: compare the live catalog with the latest snapshot or the declared
 * schema. A database that is some migrations behind the local chain, after a
 * rollback or before a deploy, is not compared with the latest snapshot: every
 * pending change would read as drift. There are no older snapshots, so its own
 * boundary is checked by replaying the chain on the verification server, when
 * one is configured.
 */
export const drift = async (
  context: CliContext,
  project: Project,
): Promise<void> =>
  withDatabase(project, async (driver, signal) => {
    const state = await loadMigrationState(project.directory);
    const { migrations, snapshot } = state;
    const expected =
      (migrations.length ? snapshot : undefined) ?? project.snapshot();

    if (!expected) {
      throw new Error(
        "symmetria: drift needs a migration chain or a schema in the config",
      );
    }

    const { metadataSchema, metadataTable } = project.config;
    const { ignoreTables } = project.runnerOptions;
    const verificationDatabaseUrl = verificationUrl(project);
    const history = migrations.length
      ? await migrator({ ...project.runnerOptions, driver, signal }).status()
      : [];
    // A migration that stopped part-way leaves the schema between two
    // boundaries, so neither describes it, and migrate refuses until repair
    // settles it.
    const incomplete = history.find((entry) => entry.status === "incomplete");

    if (incomplete) {
      const { id, direction, statement, running, error } = incomplete;

      context.emit({
        json: {
          findings: [],
          incomplete: {
            id,
            direction,
            statement,
            ...(running ? { running } : {}),
            ...(error ? { error } : {}),
          },
        },
        indent: 2,
        plain: () =>
          [
            `Migration ${id} is incomplete (${direction}, ${statement} confirmed statements): the schema is between two migrations, so drift does not compare it.`,
            ...(error
              ? [
                  `It stopped with: ${error.split("\n")[0]!.replace(/^symmetria: /, "")}`,
                ]
              : []),
            running
              ? "Another process holds the migration lock and is still running it; check drift again when it finishes."
              : `Inspect the database, then run \`symmetria repair ${id} --action retry\` after undoing what it did, or \`--action complete\` after finishing it by hand.`,
          ].join("\n"),
      });

      if (context.values.strict && !running) {
        process.exitCode = 1;
      }

      return;
    }

    const applied = history.findLastIndex(
      (entry) => entry.status === "applied",
    );

    // A database with no applied migration is compared with the latest
    // snapshot, as before `adopt`; so is one whose pending migrations leave
    // the schema as it is.
    if (
      applied >= 0 &&
      applied < migrations.length - 1 &&
      migrations[applied]!.manifest.after !== snapshotHash(snapshot)
    ) {
      const lastApplied = migrations[applied]!.id;
      const pending = migrations.slice(applied + 1).map(({ id }) => id);
      const differences = verificationDatabaseUrl
        ? await context.progress("Replaying the applied migrations", () =>
            boundaryDifferences({
              ...project.runnerOptions,
              execute: driver.execute,
              state,
              target: applied,
              url: verificationDatabaseUrl,
              signal,
            }),
          )
        : undefined;
      const summary = `The database is ${pending.length} ${pending.length === 1 ? "migration" : "migrations"} behind the local chain (last applied: ${lastApplied}); drift is checked against the latest snapshot only.`;

      context.emit({
        json: {
          findings: [],
          behind: {
            migrations: pending.length,
            lastApplied,
            pending,
            verified: differences ? differences.length === 0 : null,
            ...(differences?.length ? { differences } : {}),
          },
        },
        indent: 2,
        plain: () =>
          [
            summary,
            ...(differences === undefined
              ? [
                  `Run migrate, or verify the database against ${lastApplied} with --verify-url.`,
                ]
              : differences.length
                ? [
                    `Replaying the chain up to ${lastApplied} on the verification server gives a different schema:`,
                    ...differences.map((line) => `  ${line}`),
                  ]
                : [
                    `Replaying the chain up to ${lastApplied} on the verification server gives the same schema: no schema drift detected.`,
                  ]),
          ].join("\n"),
      });

      // Being behind is not drift; a boundary that does not match is.
      if (context.values.strict && differences?.length) {
        process.exitCode = 1;
      }

      return;
    }

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
    plain: () => formatPlan(steps),
  });
};

export const repair = (
  context: CliContext,
  project: Project,
  id: string,
): Promise<void> =>
  withRunner(project, async (runner) => {
    // Checked before the runner may need it to verify the boundary.
    verificationUrl(project);
    const action = context.values.action as "retry" | "complete";
    // The snapshot file of the boundary, such as meta/snapshot.json as it was
    // before the migration was generated; the runner checks its hash.
    const file = context.values.snapshot;
    const snapshot =
      file === undefined
        ? undefined
        : parseMigrationSnapshot(
            JSON.parse(await readFile(resolve(file), "utf8")),
          );
    await runner.repair({ id, action, ...(snapshot ? { snapshot } : {}) });
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

    // A migration another process is still running needs no repair yet.
    if (
      statuses.some((entry) => entry.status === "incomplete" && !entry.running)
    ) {
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
                  `${entry.status.padEnd(7)} ${entry.id}${entry.status === "incomplete" ? ` · ${entry.direction} · ${entry.statement} confirmed statements · ${entry.running ? "running in another process" : "repair required"}` : ""}`,
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

    const steps = values.steps === undefined ? 1 : Number(values.steps);
    let expected: string[] | undefined;

    // down.sql usually removes columns or tables, so it never runs unasked.
    if (
      !values.yes &&
      (await runner.status()).some((entry) => entry.status !== "pending")
    ) {
      if (!context.interactive) {
        throw new Error(
          "symmetria: rollback runs down.sql, which can remove data; review it with --plan and pass --yes to run it",
        );
      }

      const planned = await runner.plan({ steps, direction: "down" });

      // What was shown is what runs: another process may roll back in between.
      expected = [...new Set(planned.map((step) => step.id))];

      const confirmed = await confirmRollback(
        rollbackSummary(planned),
        databaseName(project.databaseUrl),
        {
          write: (text) => process.stdout.write(terminalOutput(text)),
          select: context.select,
          ask: (question) => ask(question, context.color),
        },
      );

      if (!confirmed) {
        context.emit({
          json: { reverted: [], cancelled: true },
          pretty: () =>
            `\n  ${context.style("○", "muted")} Rollback cancelled; nothing was changed.\n`,
          plain: () => "Rollback cancelled; nothing was changed.",
        });

        return;
      }
    }

    const started = performance.now();
    const reverted = await context.progress("Rolling back migrations", () =>
      runner.rollback({
        ...(values.steps === undefined ? {} : { steps }),
        ...(expected ? { expected } : {}),
      }),
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
