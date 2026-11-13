#!/usr/bin/env node
/**
 * `symmetria` command line. Parsing and flag rules live in ./options,
 * the shared environment in ./context and each command in ./commands.
 */
import { runCommand } from "./commands";
import { createContext, type Output } from "./context";
import { formatHelp } from "./ui/format";
import { help, parseCommandLine, resolveCommand } from "./options";
import { formatError, supportsColor } from "./ui/style";
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

const runMigrationCLI = async (
  argumentsList: string[],
  output: Output = (message) => console.log(message),
): Promise<void> => {
  const parsed = parseCommandLine(argumentsList);
  const context = createContext(parsed.values, output, runMigrationCLI);

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

    if (process.argv.includes("--json")) {
      // Machine-readable runs get JSON on failure too, on stdout like a result.
      console.log(JSON.stringify({ error: errorJSON(error, message) }));
    } else {
      console.error(
        formatError(
          message,
          supportsColor() &&
            !process.argv.includes("--no-color") &&
            !process.argv.includes("--sql"),
        ),
      );
    }

    // Ctrl-C and SIGTERM already chose 130 and 143.
    if (!process.exitCode) {
      process.exitCode = 1;
    }
  }
}
