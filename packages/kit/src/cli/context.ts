/** Everything a command needs: terminal mode, output, the project configuration and a database driver. */
import { access } from "node:fs/promises";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgres, type PostgresDriver } from "symmetria/driver";
import type { SchemaSnapshot } from "symmetria";
import type { MigrationConfig } from "../migrations/config";
import type { MigratorOptions } from "../migrations/runner";
import { supportsColor, theme } from "./ui/style";
import { choose, withSpinner } from "./ui/terminal";
import type { CliValues } from "./options";

export type Output = (message: string) => void;

export type CliContext = {
  readonly values: CliValues;
  readonly output: Output;
  /** A terminal that can show formatted output and animations. */
  readonly pretty: boolean;
  /** A terminal that can also ask questions and open screens. */
  readonly interactive: boolean;
  readonly color: boolean;
  readonly style: ReturnType<typeof theme>["style"];
  readonly progress: <Result>(
    label: string,
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  readonly select: (
    question: string,
    choices: readonly string[],
  ) => Promise<number | undefined>;
  /** Prints one of three renderings: JSON when --json, the pretty form on a terminal, else plain text. */
  readonly emit: (rendering: Rendering) => void;
  /** Runs another command in this process, collecting its output (used by the dashboard). */
  readonly rerun: (argumentsList: string[], output: Output) => Promise<void>;
};

type Rendering = {
  readonly json: unknown;
  readonly indent?: number;
  readonly replacer?: (name: string, value: unknown) => unknown;
  readonly pretty?: () => string;
  readonly plain: () => string;
};

export const createContext = (
  values: CliValues,
  output: Output,
  rerun: CliContext["rerun"],
): CliContext => {
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

  return {
    values,
    output,
    pretty,
    interactive,
    color,
    style,
    progress: (label, operation) =>
      withSpinner(label, operation, {
        enabled: pretty && !values.json && !values.sql,
        color,
        animation: !values["no-animation"],
      }),
    select: (question, choices) => choose(question, choices, { color }),
    emit: (rendering) => {
      output(
        values.json
          ? JSON.stringify(rendering.json, rendering.replacer, rendering.indent)
          : pretty && rendering.pretty
            ? rendering.pretty()
            : rendering.plain(),
      );
    },
    rerun,
  };
};

/** The migration project a command works on: config module, directories and connection settings. */
export type Project = {
  readonly configPath: string;
  readonly present: boolean;
  readonly config: MigrationConfig;
  readonly directory: string;
  readonly databaseUrl: string | undefined;
  readonly runnerOptions: Omit<MigratorOptions, "driver" | "signal">;
  /** The declared schema as a snapshot, when the config has one. */
  readonly snapshot: () => SchemaSnapshot | undefined;
};

const TIMEOUT_FLAGS = [
  ["advisoryLockTimeoutMs", "advisory-lock-timeout"],
  ["lockTimeoutMs", "lock-timeout"],
  ["statementTimeoutMs", "statement-timeout"],
] as const;

const RESOLVE_EXTENSIONS = [
  ".ts",
  ".mts",
  ".js",
  ".mjs",
  "/index.ts",
  "/index.js",
];
const RELATIVE_SPECIFIER = /^(\.\.?\/|\/|file:)/;
const KNOWN_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/;
let hooksRegistered = false;

/**
 * Node resolves `./src/schema` only with an extension, so the config and the
 * modules it imports get extension fallbacks. Bun resolves them natively and
 * has no registerHooks.
 */
const registerExtensionHooks = (): void => {
  // Bun has no registerHooks and resolves extensionless specifiers itself.
  const registerHooks = (
    nodeModule as { registerHooks?: typeof nodeModule.registerHooks }
  ).registerHooks;

  if (hooksRegistered || typeof registerHooks !== "function") {
    return;
  }

  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;

        if (
          (code !== "ERR_MODULE_NOT_FOUND" &&
            code !== "ERR_UNSUPPORTED_DIR_IMPORT") ||
          !RELATIVE_SPECIFIER.test(specifier) ||
          KNOWN_EXTENSION.test(specifier)
        ) {
          throw error;
        }

        for (const extension of RESOLVE_EXTENSIONS) {
          try {
            return nextResolve(`${specifier}${extension}`, context);
          } catch {
            // try the next candidate
          }
        }

        throw error;
      }
    },
  });
};

export const loadProject = async (context: CliContext): Promise<Project> => {
  const { values } = context;
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
    registerExtensionHooks();
    const module = await context.progress(
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
  const timeouts = Object.fromEntries(
    TIMEOUT_FLAGS.flatMap(([key, flag]) => {
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
  );
  const verificationDatabaseUrl =
    values["verify-url"] ?? config.verificationDatabaseUrl;
  // Prisma's history table is never part of an application schema, and adopt
  // must work while it still exists; declared tables are compared regardless.
  const ignoreTables = [
    ...new Set([
      "_prisma_migrations",
      ...(config.ignoreTables ?? []),
      ...(values["ignore-table"] ?? []),
    ]),
  ];

  return {
    configPath,
    present,
    config,
    directory,
    databaseUrl,
    runnerOptions: {
      directory,
      ...(config.metadataSchema
        ? { metadataSchema: config.metadataSchema }
        : {}),
      ...(config.metadataTable ? { metadataTable: config.metadataTable } : {}),
      ...(verificationDatabaseUrl ? { verificationDatabaseUrl } : {}),
      ignoreTables,
      ...timeouts,
      ...(config.onEvent ? { onEvent: config.onEvent } : {}),
    },
    snapshot: () => {
      const source = config.schema;

      return source
        ? "$snapshot" in source
          ? source.$snapshot()
          : source
        : undefined;
    },
  };
};

/**
 * Opens a driver for the configured database, turns SIGINT/SIGTERM into a
 * cancellation signal with the conventional exit codes, and always closes it.
 */
export const withDatabase = async <Result>(
  project: Pick<Project, "databaseUrl">,
  operation: (driver: PostgresDriver, signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
  if (!project.databaseUrl) {
    throw new Error(
      "symmetria: no database: set databaseUrl in the config, DATABASE_URL or --database-url",
    );
  }

  const driver = postgres(project.databaseUrl);

  try {
    return await withCancellation((signal) => operation(driver, signal));
  } finally {
    await driver.close();
  }
};

export const withCancellation = async <Result>(
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
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

  try {
    return await operation(cancellation.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
};
