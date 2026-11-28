#!/usr/bin/env node
/**
 * `symmetria` command line. Parsing and flag rules live in ./options,
 * the shared environment in ./context and each command in ./commands.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./commands";
import { createContext, leftClosing, type Output } from "./context";
import { formatHelp } from "./ui/format";
import { help, parseCommandLine, resolveCommand } from "./options";
import { flagGiven } from "./signals";
import { formatError, supportsColor, terminalOutput } from "./ui/style";
import { sqlState } from "symmetria";
import { MigrationExecutionError } from "../migrations/execution";

/** A failure as JSON: the message, plus the failing statement for migration errors. */
const errorJSON = (error: unknown, message: string) => {
  if (error instanceof MigrationExecutionError) {
    return {
      message,
      migration: error.migration,
      direction: error.direction,
      statement: error.statement,
      sql: error.sql,
      ...(error.sqlState ? { sqlState: error.sqlState } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }

  const state = sqlState(error);

  return state ? { message, sqlState: state } : { message };
};

/**
 * The version of the symmetria-kit this file belongs to, from the nearest
 * package.json above it: one level up from the built `dist/`, two from
 * `src/cli/` in the repository.
 */
const packageVersion = (): string => {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };

      if (
        manifest.name === "symmetria-kit" &&
        typeof manifest.version === "string"
      ) {
        return manifest.version;
      }
    } catch {
      // No package.json here, or another package's: look further up.
    }

    const parent = dirname(directory);

    if (parent === directory) {
      throw new Error(
        "symmetria: cannot read the version: no package.json of symmetria-kit was found above the command's own files",
      );
    }

    directory = parent;
  }
};

/**
 * Results on stdout. A terminal gets them without escape sequences other than
 * the CLI's colours: names and messages can come from the database. Piped
 * output (files, other programs) keeps every byte.
 */
const print: Output = (message) =>
  console.log(process.stdout.isTTY ? terminalOutput(message) : message);

const runMigrationCLI = async (
  argumentsList: string[],
  output: Output = print,
): Promise<void> => {
  const parsed = parseCommandLine(argumentsList);
  const context = createContext(parsed.values, output, runMigrationCLI);

  if (parsed.values.version && !parsed.values.help) {
    const version = packageVersion();

    output(parsed.values.json ? JSON.stringify({ version }) : version);

    return;
  }

  if (
    parsed.values.help ||
    (!parsed.positionals.length && !context.interactive)
  ) {
    output(
      context.pretty && !parsed.values.json && !parsed.values.sql
        ? formatHelp(help, context.color)
        : help,
    );

    return;
  }

  const { command, name } = resolveCommand(parsed, context.interactive);
  await runCommand(command, name, context);
};

if (import.meta.main) {
  try {
    try {
      // Bun loads .env on its own; releases before 1.4 lack process.loadEnvFile.
      process.loadEnvFile?.();
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    await runMigrationCLI(process.argv.slice(2));
  } catch (error) {
    let cause: unknown = error;
    const messages: string[] = [];

    while (cause instanceof Error) {
      const { message } = cause;

      // Wrappers such as MigrationExecutionError already quote their cause.
      if (!messages.some((previous) => previous.includes(message))) {
        messages.push(message);
      }

      cause = cause.cause;
    }

    const message = messages.length ? messages.join("\n") : String(error);

    const given = process.argv.slice(2);

    if (flagGiven(given, "--json")) {
      // Machine-readable runs get JSON on failure too, on stdout like a result.
      console.log(JSON.stringify({ error: errorJSON(error, message) }));
    } else {
      console.error(
        formatError(
          message,
          supportsColor() &&
            !flagGiven(given, "--no-color") &&
            !flagGiven(given, "--sql"),
        ),
      );
    }

    // Ctrl-C and SIGTERM already chose 130 and 143.
    if (!process.exitCode) {
      process.exitCode = 1;
    }
  }

  // A driver left closing by a failed command (see withDatabase) keeps the
  // process alive for as long as its connection attempt waits: leave once
  // the output is written.
  if (leftClosing()) {
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.write("", () => resolve());
          }),
      ),
    );
    process.exit();
  }
}
