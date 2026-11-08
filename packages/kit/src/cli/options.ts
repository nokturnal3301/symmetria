/** Command-line surface: help text, flag parsing and the rules that tie flags to commands. */
import { parseArgs } from "node:util";

export const help = `symmetria <command>

  init [directory]     Create modular tables, connection and migration config
  pull [file]          Write a schema module for an existing database (default: schema.ts)
  diff                 Compare schema code with the latest migration snapshot
  lint                 Review saved up.sql files and ungenerated schema changes
  inspect [table]      Inspect tables, columns, relations, indexes and checks
  graph [file]         Print or write a Mermaid entity-relationship diagram
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
  --profile-token <t>   Profiler token (default: SYMMETRIA_PROFILE_TOKEN)
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
  --force              Overwrite the file written by pull or graph
  --compact            graph: entities and relations without column lists
  --sql                Print executable SQL for diff
  --json               Machine-readable output
  --relations          Show the relation graph with inspect
  --no-color           Disable terminal colors
  --no-animation       Disable logo and loading animations
  --no-interactive     Disable dashboard, schema browser and rename questions
  --help               Show this help
`;

const COMMANDS = [
  "generate",
  "migrate",
  "status",
  "rollback",
  "init",
  "pull",
  "graph",
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
] as const;
export type Command = (typeof COMMANDS)[number];

export const parseCommandLine = (argumentsList: string[]) =>
  parseArgs({
    args: argumentsList,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      dir: { type: "string" },
      "database-url": { type: "string" },
      "profile-url": { type: "string" },
      "profile-token": { type: "string" },
      diff: { type: "string" },
      strict: { type: "boolean" },
      force: { type: "boolean" },
      compact: { type: "boolean" },
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

type CommandLine = ReturnType<typeof parseCommandLine>;
export type CliValues = CommandLine["values"];

/** Commands that take a second positional argument (a name or an ID). */
const NAMED: readonly Command[] = [
  "generate",
  "inspect",
  "init",
  "pull",
  "graph",
  "squash",
  "repair",
];

/** Flags that belong to specific commands, with the exact refusal wording. */
const SCOPED_FLAGS: readonly {
  readonly flags: readonly (keyof CliValues)[];
  readonly commands: readonly Command[];
  readonly message: string;
}[] = [
  {
    flags: ["allow-destructive", "transaction", "online"],
    commands: ["generate"],
    message:
      "symmetria: --allow-destructive, --transaction and --online are generate options",
  },
  {
    flags: ["pending"],
    commands: ["lint"],
    message: "symmetria: --pending is a lint option",
  },
  {
    flags: ["plan"],
    commands: ["migrate", "rollback"],
    message: "symmetria: --plan is a migrate/rollback option",
  },
  {
    flags: ["action"],
    commands: ["repair"],
    message: "symmetria: --action is a repair option",
  },
  {
    flags: ["strict"],
    commands: ["lint", "drift"],
    message: "symmetria: --strict is a lint/drift option",
  },
  {
    flags: ["diff"],
    commands: ["generate", "diff", "lint"],
    message:
      "symmetria: --diff is for generate/diff/lint; --empty is for generate",
  },
  {
    flags: ["empty"],
    commands: ["generate"],
    message:
      "symmetria: --diff is for generate/diff/lint; --empty is for generate",
  },
  {
    flags: ["sql"],
    commands: ["diff"],
    message: "symmetria: --sql is a diff option",
  },
  {
    flags: ["relations"],
    commands: ["inspect"],
    message: "symmetria: --relations is an inspect option",
  },
  {
    flags: ["to"],
    commands: ["migrate", "adopt"],
    message: "symmetria: --to is a migrate/adopt option",
  },
  {
    flags: ["steps"],
    commands: ["rollback"],
    message: "symmetria: --steps is a rollback option",
  },
  {
    flags: ["force"],
    commands: ["pull", "graph"],
    message: "symmetria: --force is a pull/graph option",
  },
  {
    flags: ["compact"],
    commands: ["graph"],
    message: "symmetria: --compact is a graph option",
  },
];

/** Resolves the command and its name, then rejects flags and arguments that do not fit it. */
export const resolveCommand = (
  { values, positionals }: CommandLine,
  interactive: boolean,
): { command: Command; name: string | undefined } => {
  const command = (positionals[0] ?? "dashboard") as Command;
  const name = positionals[1];

  if (!COMMANDS.includes(command)) {
    throw new Error(`symmetria: unknown command "${command}"`);
  }

  if (positionals.length > (NAMED.includes(command) ? 2 : 1)) {
    throw new Error("symmetria: unexpected positional arguments");
  }

  if (command === "generate" && !name && !interactive) {
    throw new Error("symmetria: generate requires a migration name");
  }

  if (command === "squash" && !name) {
    throw new Error("symmetria: squash requires a migration name");
  }

  for (const rule of SCOPED_FLAGS) {
    if (
      !rule.commands.includes(command) &&
      rule.flags.some((flag) => values[flag])
    ) {
      throw new Error(rule.message);
    }
  }

  if (
    values.transaction &&
    !["batch", "each", "none"].includes(values.transaction)
  ) {
    throw new Error("symmetria: --transaction must be batch, each, or none");
  }

  if (
    command === "repair" &&
    (!name || !["retry", "complete"].includes(values.action ?? ""))
  ) {
    throw new Error(
      "symmetria: repair requires an ID and --action retry|complete",
    );
  }

  if (values.sql && values.json) {
    throw new Error("symmetria: choose either --sql or --json");
  }

  return { command, name };
};
