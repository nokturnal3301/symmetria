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
