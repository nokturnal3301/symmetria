#!/usr/bin/env bun
import { access, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { postgres } from "symmetria/driver";
import {
  formatCreated,
  formatDashboard,
  formatDiff,
  formatExecution,
  formatHelp,
  formatSchema,
  formatStatus,
} from "./cli/format";
import { choose, ask, view, withScreen, withSpinner } from "./cli/terminal";
import { formatError, supportsColor, theme } from "./cli/style";
import { resolveRenames } from "./cli/renames";
import { initializeProject } from "./cli/init";
import { inspectSchema } from "./cli/inspect";
import { profileScreen } from "./cli/profile";
import {
  generateMigration,
  squashMigrations,
  lintMigration,
  lintMigrationSQL,
  verifyMigrations,
  recoverMigrationFiles,
  formatLintFindings,
  detectDrift,
  formatDriftFindings,
  migrator,
  loadMigrationState,
  migrationSnapshot,
  diffSchemas,
  type MigrationConfig,
  type MigrationDiffOptions,
} from "./index";

const help = `symmetria <command>

  init [directory]     Create modular tables, connection and migration config
  diff                 Compare schema code with the latest migration snapshot
  lint                 Review saved up.sql files and ungenerated schema changes
  inspect [table]      Inspect tables, columns, relations, indexes and checks
  profile              Observe live application requests and SQL timings
  generate <name>       Generate up.sql, down.sql and a versioned snapshot
  migrate              Apply pending migrations atomically
  status               Show applied and pending migrations
  rollback             Revert the latest migration
  squash <name>        Replace the migration chain with one baseline migration
  adopt                Record the local chain as applied after a squash or baseline
  drift                Compare the live database with the latest migration snapshot
  verify               Exercise installation, upgrade and rollback in disposable databases
  repair <id>          Resolve an incomplete migration after verifying its schema
  recover              Recover files left by a crashed generation process
  (no command)         Open the interactive dashboard in a terminal

  --config <file>       Config module (default: symmetria.config.ts)
  --dir <directory>     Override the migrations directory
  --database-url <url>  Override config/database environment URL
  --profile-url <url>   Profiler endpoint (default: http://127.0.0.1:7331)
  --diff <file.json>    Explicit rename hints and USING conversions for generate
  --empty              Generate an empty, editable SQL migration
  --allow-destructive  Explicitly permit destructive generation
  --transaction <mode> batch (default), each, or none
  --pending            Lint only migrations pending in the configured database
  --online             Generate concurrent indexes and phased validation (transaction none)
  --plan               Show SQL and transaction groups without executing migrations
  --action <action>    repair: retry or complete, after manual data reconciliation
  --verify-url <url>   Administrative PostgreSQL URL for disposable verification databases
  --advisory-lock-timeout <ms>  Migration lock wait (default: 10000)
  --lock-timeout <ms>   DDL lock wait (default: 5000; 0 disables)
  --statement-timeout <ms>  Statement duration (default: 600000; 0 disables)
  --to <migration-id>   Apply up to a migration
  --steps <number>      Number of migrations to rollback (default: 1)
  --strict             Exit with code 1 when lint or drift report findings
  --sql                Print executable SQL for diff
  --json               Machine-readable output
  --relations          Show the relation graph with inspect
  --no-color           Disable terminal colors
  --no-animation       Disable logo and loading animations
  --no-interactive     Disable dashboard, schema browser and rename questions
  --help               Show this help
`;

export const runMigrationCLI = async (
  argumentsList: string[],
  output: (message: string) => void = (message) => console.log(message),
): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: argumentsList,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      dir: { type: "string" },
      "database-url": { type: "string" },
      "profile-url": { type: "string" },
      diff: { type: "string" },
      strict: { type: "boolean" },
      empty: { type: "boolean" },
      "allow-destructive": { type: "boolean" },
      transaction: { type: "string" },
      pending: { type: "boolean" },
      online: { type: "boolean" },
      plan: { type: "boolean" },
      action: { type: "string" },
      "verify-url": { type: "string" },
      "advisory-lock-timeout": { type: "string" },
      "lock-timeout": { type: "string" },
      "statement-timeout": { type: "string" },
      to: { type: "string" },
      steps: { type: "string" },
      help: { type: "boolean", short: "h" },
      sql: { type: "boolean" },
      json: { type: "boolean" },
      relations: { type: "boolean" },
      "no-color": { type: "boolean" },
      "no-animation": { type: "boolean" },
      "no-interactive": { type: "boolean" },
    },
  });
  const pretty = !!process.stdout.isTTY && process.env.TERM !== "dumb";
  const interactive =
    !!process.stdin.isTTY &&
    pretty &&
    !values["no-interactive"] &&
    !values.json &&
    !values.sql;
  const color =
    supportsColor() && !values["no-color"] && !values.json && !values.sql;
  const { style } = theme(color);

  const progress = <Result>(label: string, operation: () => Promise<Result>) =>
    withSpinner(label, operation, {
      enabled: pretty && !values.json && !values.sql,
      color,
      animation: !values["no-animation"],
    });

  const select = (question: string, choices: readonly string[]) =>
    choose(question, choices, { color });

  if (values.help || (!positionals.length && !interactive)) {
    output(
      pretty && !values.json && !values.sql ? formatHelp(help, color) : help,
    );

    return;
  }

  const command = positionals[0] ?? "dashboard";
  let name = positionals[1];

  if (
    ![
      "generate",
      "migrate",
      "status",
      "rollback",
      "init",
      "diff",
      "lint",
      "squash",
      "adopt",
      "drift",
      "inspect",
      "dashboard",
      "profile",
      "verify",
      "repair",
      "recover",
    ].includes(command)
  ) {
    throw new Error(`symmetria: unknown command "${command}"`);
  }

  if (
    positionals.length >
    (["generate", "inspect", "init", "squash", "repair"].includes(command)
      ? 2
      : 1)
  ) {
    throw new Error("symmetria: unexpected positional arguments");
  }

  if (command === "generate" && !name && !interactive) {
    throw new Error("symmetria: generate requires a migration name");
  }

  if (command === "squash" && !name) {
    throw new Error("symmetria: squash requires a migration name");
  }

  if (
    (values["allow-destructive"] || values.transaction || values.online) &&
    command !== "generate"
  ) {
    throw new Error(
      "symmetria: --allow-destructive and --transaction are generate options",
    );
  }

  if (
    values.transaction &&
    !["batch", "each", "none"].includes(values.transaction)
  ) {
    throw new Error("symmetria: --transaction must be batch, each, or none");
  }

  if (values.pending && command !== "lint") {
    throw new Error("symmetria: --pending is a lint option");
  }

  if (values.plan && !["migrate", "rollback"].includes(command)) {
    throw new Error("symmetria: --plan is a migrate/rollback option");
  }

  if (values.action && command !== "repair") {
    throw new Error("symmetria: --action is a repair option");
  }

  if (
    command === "repair" &&
    (!name || !["retry", "complete"].includes(values.action ?? ""))
  ) {
    throw new Error(
      "symmetria: repair requires an ID and --action retry|complete",
    );
  }

  if (values.strict && !["lint", "drift"].includes(command)) {
    throw new Error("symmetria: --strict is a lint/drift option");
  }

  if (
    (!["generate", "diff", "lint"].includes(command) && values.diff) ||
    (command !== "generate" && values.empty)
  ) {
    throw new Error(
      "symmetria: --diff is for generate/diff/lint; --empty is for generate",
    );
  }

  if (values.sql && command !== "diff") {
    throw new Error("symmetria: --sql is a diff option");
  }

  if (values.sql && values.json) {
    throw new Error("symmetria: choose either --sql or --json");
  }

  if (values.relations && command !== "inspect") {
    throw new Error("symmetria: --relations is an inspect option");
  }

  if (!["migrate", "adopt"].includes(command) && values.to) {
    throw new Error("symmetria: --to is a migrate/adopt option");
  }

  if (command !== "rollback" && values.steps) {
    throw new Error("symmetria: --steps is a rollback option");
  }

  if (command === "profile") {
    const address = values["profile-url"] ?? "http://127.0.0.1:7331";

    if (interactive) {
      return profileScreen(address, color);
    }

    const response = await fetch(new URL("/requests", address));

    if (!response.ok) {
      throw new Error(`symmetria: profiler returned HTTP ${response.status}`);
    }

    output(JSON.stringify(await response.json(), null, 2));

    return;
  }

  if (command === "init") {
    const directory = resolve(name ?? ".");
    const files = await progress("Creating your project", () =>
      initializeProject(directory),
    );

    if (!files.length) {
      output(
        values.json
          ? JSON.stringify({ directory, files })
          : "Existing project files preserved; nothing to create.",
      );

      return;
    }

    const quoteArgument = (value: string) =>
      /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

    const invocation = "bunx --package symmetria-kit symmetria";
    const changeDirectory =
      directory === process.cwd()
        ? ""
        : `  cd ${quoteArgument(relative(process.cwd(), directory))}\n`;
    output(
      values.json
        ? JSON.stringify({ directory, files })
        : `${pretty ? formatCreated(directory, files, color) : `Created\n${files.map((file) => `  ${file}`).join("\n")}\n`}\n${style("Next", "violet")}\n${changeDirectory}  Set DATABASE_URL (see .env.example)\n  ${style(`${invocation} generate initial`, "accent")}\n  ${style(`${invocation} migrate`, "accent")}`,
    );

    return;
  }

  const configPath = resolve(values.config ?? "symmetria.config.ts");
  const present = await access(configPath).then(
    () => true,
    (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT" &&
        !values.config
      ) {
        return false;
      }

      throw error;
    },
  );
  let config: MigrationConfig = {};

  if (present) {
    const module = await progress(
      "Loading schema",
      () => import(pathToFileURL(configPath).href),
    );

    if (!module.default || typeof module.default !== "object") {
      throw new Error(
        "symmetria: config must default-export a migration configuration",
      );
    }

    config = module.default;
  }

  const directory = values.dir
    ? resolve(values.dir)
    : resolve(
        present ? dirname(configPath) : process.cwd(),
        config.directory ?? "migrations",
      );
  const databaseUrl =
    values["database-url"] ?? config.databaseUrl ?? process.env.DATABASE_URL;
  const runnerOptions = {
    directory,
    ...(config.metadataSchema ? { metadataSchema: config.metadataSchema } : {}),
    ...(config.metadataTable ? { metadataTable: config.metadataTable } : {}),
    ...(config.verificationDatabaseUrl || values["verify-url"]
      ? {
          verificationDatabaseUrl:
            values["verify-url"] ?? config.verificationDatabaseUrl!,
        }
      : {}),
    ...Object.fromEntries(
      (
        [
          ["advisoryLockTimeoutMs", "advisory-lock-timeout"],
          ["lockTimeoutMs", "lock-timeout"],
          ["statementTimeoutMs", "statement-timeout"],
        ] as const
      ).flatMap(([key, flag]) => {
        const value =
          values[flag] === undefined ? config[key] : Number(values[flag]);

        if (value === undefined) {
          return [];
        }

        if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
          throw new Error(`symmetria: invalid --${flag}`);
        }

        return [[key, value]];
      }),
    ),
    ...(config.onEvent ? { onEvent: config.onEvent } : {}),
  };

  if (command === "recover") {
    await recoverMigrationFiles(directory);
    output(
      values.json
        ? JSON.stringify({ recovered: true })
        : "Migration files recovered.",
    );

    return;
  }

  if (command === "dashboard") {
    if (!interactive) {
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
        const { migrations, snapshot: before } =
          await loadMigrationState(directory);
        const source = config.schema;
        const snapshot = source
          ? "$snapshot" in source
            ? source.$snapshot()
            : source
          : undefined;
        const changes = snapshot
          ? diffSchemas(before, snapshot).up.length
          : undefined;
        let migrationSummary = `${migrations.length} local · database not configured`;
        let address = "Offline · set DATABASE_URL to connect";
        let connection: "connected" | "offline" | "unavailable" = "offline";
        let pending = 0;
        let applied = 0;

        if (databaseUrl) {
          const url = new URL(databaseUrl);
          address = `PostgreSQL · ${url.hostname}:${url.port || "5432"}${url.pathname}`;
          const driver = postgres(databaseUrl);

          try {
            const statuses = await progress("Checking PostgreSQL", () =>
              migrator({ driver, ...runnerOptions }).status(),
            );
            applied = statuses.filter(
              (entry) => entry.status === "applied",
            ).length;
            pending = statuses.filter(
              (entry) => entry.status === "pending",
            ).length;
            connection = "connected";
            migrationSummary = `${applied} applied · ${pending} pending`;
            const incomplete = statuses.length - applied - pending;

            if (incomplete) {
              migrationSummary += ` · ${incomplete} incomplete (repair required)`;
            }
          } catch (error) {
            connection = "unavailable";
            migrationSummary = `Unavailable: ${error instanceof Error ? error.message : String(error)}`;
          } finally {
            await driver.close();
          }
        }

        const selected = await choose(
          "Choose an action",
          [
            "View schema changes",
            "Generate migration",
            "Apply migrations",
            "Inspect schema",
            "Migration history",
            "Rollback latest migration",
            "Exit",
          ],
          {
            color,
            animation: !values["no-animation"],
            header: (frame) =>
              formatDashboard(
                {
                  address,
                  connection,
                  snapshot,
                  migrations: migrationSummary,
                  applied,
                  local: migrations.length,
                  pending,
                  changes,
                  config: present
                    ? relative(process.cwd(), configPath) || configPath
                    : "No config · symmetria init to get started",
                },
                color,
                frame,
              ),
            descriptions: [
              "Compare your schema with the latest local snapshot.",
              "Turn schema changes into a versioned SQL migration.",
              "Run pending migrations against PostgreSQL.",
              "Explore tables, columns, relationships and constraints.",
              "See applied and pending migrations at a glance.",
              "Execute down.sql for the latest applied migration.",
              "Back to your terminal.",
            ],
          },
        );

        if (selected === undefined || selected === 6) {
          return;
        }

        const action = [
          "diff",
          "generate",
          "migrate",
          "inspect",
          "status",
          "rollback",
        ][selected]!;
        process.stdout.write("\u001b[H\u001b[2J");

        if (action === "inspect" && snapshot) {
          try {
            await inspectSchema(snapshot, { color });
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

          process.stdout.write("\u001b[H\u001b[2J");
          continue;
        }

        const messages: string[] = [];

        try {
          await runMigrationCLI([action, ...forwarded], (message) => {
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
        process.stdout.write("\u001b[H\u001b[2J");
      }
    });
  }

  if (command === "squash") {
    const squashed = await progress("Squashing migrations", () =>
      squashMigrations({ directory, name: name! }),
    );
    output(
      values.json
        ? JSON.stringify(squashed ? { id: squashed.id } : { id: null })
        : squashed
          ? `Squashed into ${squashed.id}. Run "symmetria adopt" on databases that applied the old chain.`
          : "Nothing to squash.",
    );

    return;
  }

  if (["generate", "diff", "inspect", "lint"].includes(command)) {
    const source = config.schema;

    if (command !== "lint" && !values.empty && !source) {
      throw new Error(
        "symmetria: configure schema in symmetria.config.ts before inspecting or generating a migration",
      );
    }

    const snapshot = source
      ? "$snapshot" in source
        ? source.$snapshot()
        : source
      : undefined;

    if (command === "inspect") {
      const tables = name
        ? snapshot!.tables.filter(
            (table) => table.name === name || table.sqlName === name,
          )
        : snapshot!.tables;

      if (name && !tables.length) {
        throw new Error(`symmetria: unknown table "${name}"`);
      }

      if (interactive) {
        return withScreen(() =>
          inspectSchema(snapshot!, {
            color,
            ...(name ? { table: name } : {}),
            tab: values.relations ? "Relations" : "Columns",
          }),
        );
      }

      output(
        values.json
          ? JSON.stringify(
              values.relations
                ? tables.map((table) => ({
                    name: table.name,
                    relations: table.relations,
                  }))
                : { tables },
              (_name, value) =>
                typeof value === "bigint" ? value.toString() : value,
              2,
            )
          : formatSchema(snapshot!, name, values.relations, color),
      );

      return;
    }

    let diffOptions: MigrationDiffOptions = values.diff
      ? JSON.parse(await readFile(resolve(values.diff), "utf8"))
      : {};

    if (values.online) {
      diffOptions = { ...diffOptions, online: true };
    }

    const { snapshot: before, migrations } =
      await loadMigrationState(directory);
    const after =
      snapshot && !values.empty ? migrationSnapshot(snapshot) : before;

    if (command === "generate" && interactive && !values.empty) {
      diffOptions = await resolveRenames(before, after, select, diffOptions);
    }

    const plan = diffSchemas(before, after, diffOptions);

    if (command === "lint") {
      let selected = migrations;

      if (values.pending) {
        if (!databaseUrl) {
          throw new Error("symmetria: --pending requires databaseUrl");
        }

        const driver = postgres(databaseUrl);

        try {
          const statuses = await migrator({
            driver,
            ...runnerOptions,
          }).status();

          if (statuses.some((entry) => entry.status === "incomplete")) {
            throw new Error(
              "symmetria: repair incomplete migrations before linting the pending chain",
            );
          }

          selected = migrations.filter((migration) =>
            statuses.some(
              (status) =>
                status.id === migration.id && status.status === "pending",
            ),
          );
        } finally {
          await driver.close();
        }
      }

      const findings = [
        ...selected.flatMap((migration) =>
          lintMigrationSQL(migration.up, migration.id),
        ),
        ...lintMigration(plan, diffOptions.renames),
      ];
      output(
        values.json
          ? JSON.stringify(findings, null, 2)
          : formatLintFindings(findings),
      );

      if (
        findings.some((finding) => values.strict || finding.level !== "caution")
      ) {
        process.exitCode = 1;
      }

      return;
    }

    if (command === "diff") {
      output(
        values.json
          ? JSON.stringify(plan, null, 2)
          : values.sql
            ? plan.up.map((statement) => `${statement};`).join("\n\n")
            : formatDiff(plan, color, diffOptions.renames),
      );

      return;
    }

    if (!name) {
      name = await ask("Migration name:", color);
    }

    if (!name) {
      throw new Error("symmetria: generate requires a migration name");
    }

    if (pretty && !values.json && !values.empty) {
      output(formatDiff(plan, color, diffOptions.renames));
    }

    const migration = await progress("Writing migration", () =>
      generateMigration({
        ...diffOptions,
        directory,
        name: name!,
        ...(snapshot ? { snapshot } : {}),
        ...(values.empty ? { empty: true } : {}),
        ...(values["allow-destructive"] ? { allowDestructive: true } : {}),
        ...(values.transaction
          ? { transaction: values.transaction as "batch" | "each" | "none" }
          : {}),
        ...(values.online ? { online: true } : {}),
      }),
    );
    output(
      values.json
        ? JSON.stringify(
            migration
              ? {
                  id: migration.id,
                  directory: resolve(directory, migration.id),
                  metadataDirectory: resolve(directory, "meta"),
                  up: migration.up,
                  down: migration.down,
                }
              : { id: null, changed: false },
          )
        : migration
          ? pretty
            ? formatCreated(
                directory,
                [
                  `${migration.id}/up.sql`,
                  `${migration.id}/down.sql`,
                  "meta/snapshot.json",
                  "meta/migration.json",
                ],
                color,
              )
            : `Generated ${migration.id}`
          : "No schema changes.",
    );

    return;
  }

  if (!databaseUrl && command !== "verify") {
    throw new Error("symmetria: configure databaseUrl or DATABASE_URL");
  }

  const cancellation = new AbortController();

  const interrupt = () => {
    process.exitCode = 130;
    cancellation.abort(new Error("symmetria: interrupted"));
  };

  const terminate = () => {
    process.exitCode = 143;
    cancellation.abort(new Error("symmetria: terminated"));
  };

  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const driver = command === "verify" ? undefined : postgres(databaseUrl!);

  try {
    if (command === "verify") {
      const url =
        values["verify-url"] ?? config.verificationDatabaseUrl ?? databaseUrl;

      if (!url) {
        throw new Error(
          "symmetria: verify requires --verify-url or a configured database URL with CREATEDB permission",
        );
      }

      const result = await verifyMigrations({
        ...runnerOptions,
        ...config.verify,
        url,
        signal: cancellation.signal,
      });
      output(
        values.json
          ? JSON.stringify(result)
          : `Verified ${result.migrations.length} migrations: installation, upgrade, rollback and reapplication.`,
      );

      return;
    }

    const runner = migrator({
      ...runnerOptions,
      driver: driver!,
      signal: cancellation.signal,
    });

    if (values.plan) {
      const plan = await runner.plan({
        ...(values.to ? { to: values.to } : {}),
        ...(values.steps ? { steps: Number(values.steps) } : {}),
        direction: command === "rollback" ? "down" : "up",
      });
      output(
        values.json
          ? JSON.stringify(plan, null, 2)
          : plan
              .map(
                (step) =>
                  `-- group ${step.group}: ${step.transaction} · ${step.id}\n${step.statements.map((sql) => `${sql};`).join("\n\n")}`,
              )
              .join("\n\n"),
      );

      return;
    }

    if (command === "repair") {
      await runner.repair({
        id: name!,
        action: values.action as "retry" | "complete",
      });
      output(
        values.json
          ? JSON.stringify({ repaired: name, action: values.action })
          : `Repaired ${name}: ${values.action}`,
      );

      return;
    }

    if (command === "drift") {
      const { migrations, snapshot } = await loadMigrationState(directory);
      const source = config.schema;
      const expected =
        (migrations.length ? snapshot : undefined) ??
        (source
          ? "$snapshot" in source
            ? source.$snapshot()
            : source
          : undefined);

      if (!expected) {
        throw new Error(
          "symmetria: drift needs a migration chain or a schema in the config",
        );
      }

      const findings = await progress("Inspecting the database", () =>
        detectDrift({
          execute: driver!.execute,
          snapshot: expected,
          ...(config.metadataSchema
            ? { metadataSchema: config.metadataSchema }
            : {}),
          ...(config.metadataTable
            ? { metadataTable: config.metadataTable }
            : {}),
        }),
      );
      output(
        values.json
          ? JSON.stringify(findings, null, 2)
          : formatDriftFindings(findings),
      );

      if (values.strict && findings.length) {
        process.exitCode = 1;
      }
    } else if (command === "adopt") {
      const adopted = await progress("Recording the local chain", () =>
        runner.adopt(values.to ? { to: values.to } : {}),
      );
      output(
        values.json
          ? JSON.stringify({ adopted })
          : adopted.length
            ? adopted.map((id) => `Adopted ${id}`).join("\n")
            : "Nothing to adopt.",
      );
    } else if (command === "status") {
      const statuses = await progress("Reading migration history", () =>
        runner.status(),
      );

      if (statuses.some((entry) => entry.status === "incomplete")) {
        process.exitCode = 1;
      }

      output(
        values.json
          ? JSON.stringify(statuses)
          : pretty
            ? formatStatus(statuses, color)
            : statuses.length
              ? statuses
                  .map(
                    (entry) =>
                      `${entry.status.padEnd(7)} ${entry.id}${entry.status === "incomplete" ? ` · ${entry.direction} · ${entry.statement} confirmed statements · repair required` : ""}`,
                  )
                  .join("\n")
              : "No migrations.",
      );
    } else if (command === "migrate") {
      const started = performance.now();
      const applied = await progress("Applying migrations", () =>
        runner.migrate(values.to ? { to: values.to } : {}),
      );
      const durationMs = Math.round(performance.now() - started);
      output(
        values.json
          ? JSON.stringify({ applied, durationMs })
          : pretty
            ? formatExecution(applied, "Applied", durationMs, color)
            : applied.length
              ? applied.map((id) => `Applied ${id}`).join("\n")
              : "Database is up to date.",
      );
    } else {
      const started = performance.now();
      const reverted = await progress("Rolling back migrations", () =>
        runner.rollback(
          values.steps === undefined ? {} : { steps: Number(values.steps) },
        ),
      );
      output(
        values.json
          ? JSON.stringify({
              reverted,
              durationMs: Math.round(performance.now() - started),
            })
          : pretty
            ? formatExecution(
                reverted,
                "Reverted",
                Math.round(performance.now() - started),
                color,
              )
            : reverted.length
              ? reverted.map((id) => `Reverted ${id}`).join("\n")
              : "No applied migrations.",
      );
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await driver?.close();
  }
};

if (import.meta.main) {
  try {
    await runMigrationCLI(process.argv.slice(2));
  } catch (error) {
    let cause: unknown = error;
    const messages: string[] = [];

    while (cause instanceof Error) {
      messages.push(cause.message);
      cause = cause.cause;
    }

    console.error(
      formatError(
        messages.length ? messages.join("\n") : String(error),
        supportsColor() &&
          !process.argv.includes("--no-color") &&
          !process.argv.includes("--json") &&
          !process.argv.includes("--sql"),
      ),
    );
    process.exitCode = 1;
  }
}
