/** Everything a command needs: terminal mode, output, the project configuration and a database driver. */
import { access } from "node:fs/promises";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgres, type PostgresDriver } from "symmetria/driver";
import { sqlState, type SchemaSnapshot } from "symmetria";
import type { MigrationConfig } from "../migrations/config";
import type { MigratorOptions } from "../migrations/runner";
import { interruptible } from "./signals";
import { supportsColor, terminalText, theme } from "./ui/style";
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
            : pretty
              ? // Plain text has no colours of the CLI: on a terminal every
                // escape sequence in it came with a name from the database.
                terminalText(rendering.plain())
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
  /** Where databaseUrl came from, for messages (never the value). */
  readonly databaseUrlSource?: string;
  /** Where runnerOptions.verificationDatabaseUrl came from, for messages. */
  readonly verificationUrlSource?: string;
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

/**
 * A PostgreSQL URL checked when a driver is opened, not when the config
 * loads (commands without a database ignore it). node-postgres resolves any
 * text against `postgres://base`, so a typo would surface as a DNS error for
 * the host "base". This check refuses text that is not an absolute URL and
 * what node-postgres cannot parse, and accepts all else it reads: a socket
 * directory (`/var/run/postgresql`), and credentials without a host
 * (`postgres://user:password@/app?host=/cloudsql/…`), which it parses with a
 * placeholder host as done here. The message names where the
 * value came from, never the value (it can hold a password).
 */
export const checkedUrl = (url: string, source: string): string => {
  if (url.startsWith("/")) {
    return url;
  }

  // pg-connection-string encodes spaces and stray `%` before parsing.
  const text = /[ ]|%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(url)
    ? encodeURI(url).replace(/%25(\d\d)/g, "%$1")
    : url;
  const parsed =
    URL.parse(text) ?? URL.parse(text.replace("@/", "@___DUMMY___/"));

  // Relative text has no scheme: node-postgres would read it against
  // postgres://base. It ignores the scheme of an absolute URL.
  if (!parsed) {
    throw new Error(
      `symmetria: invalid database URL in ${source}: expected postgres://user:password@host:5432/database`,
    );
  }

  return url;
};

/** The database URL and its source: --database-url, then the config, then DATABASE_URL. */
export const databaseUrlOf = (
  values: CliValues,
  config: MigrationConfig,
): Pick<Project, "databaseUrl" | "databaseUrlSource"> =>
  values["database-url"] !== undefined
    ? {
        databaseUrl: values["database-url"],
        databaseUrlSource: "--database-url",
      }
    : config.databaseUrl !== undefined && config.databaseUrl !== null
      ? {
          databaseUrl: config.databaseUrl,
          databaseUrlSource: "databaseUrl in the config",
        }
      : {
          databaseUrl: process.env.DATABASE_URL,
          databaseUrlSource: "DATABASE_URL",
        };

/** The verification server's URL, checked like the database URL; undefined when none is set. */
export const verificationUrl = (
  project: Pick<Project, "runnerOptions" | "verificationUrlSource">,
): string | undefined => {
  const url = project.runnerOptions.verificationDatabaseUrl;

  return url
    ? checkedUrl(url, project.verificationUrlSource ?? "the verification URL")
    : undefined;
};

/** A driver for the project's database (its URL is set), after the URL check. */
export const databaseDriver = (
  project: Pick<Project, "databaseUrl" | "databaseUrlSource">,
): PostgresDriver =>
  postgres(
    checkedUrl(
      project.databaseUrl!,
      project.databaseUrlSource ?? "the database URL",
    ),
  );

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
  const { databaseUrl, databaseUrlSource } = databaseUrlOf(values, config);
  const timeouts = Object.fromEntries(
    TIMEOUT_FLAGS.flatMap(([key, flag]) => {
      const given = values[flag];
      // Number("") is 0, which would silently disable the timeout.
      const value =
        given === undefined
          ? config[key]
          : given.trim()
            ? Number(given)
            : Number.NaN;

      if (value === undefined) {
        return [];
      }

      if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
        throw new Error(
          `symmetria: invalid ${given === undefined ? `${key} in the config` : `--${flag} ${JSON.stringify(given)}`}: expected whole milliseconds from 0 to 2147483647`,
        );
      }

      return [[key, value]];
    }),
  );
  const verificationDatabaseUrl =
    values["verify-url"] ?? config.verificationDatabaseUrl;

  if (
    config.ignoreTables !== undefined &&
    (!Array.isArray(config.ignoreTables) ||
      config.ignoreTables.some((name) => typeof name !== "string"))
  ) {
    throw new Error(
      "symmetria: invalid ignoreTables in the config: expected an array of table names",
    );
  }

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
    ...(databaseUrlSource ? { databaseUrlSource } : {}),
    verificationUrlSource:
      values["verify-url"] === undefined
        ? "verificationDatabaseUrl in the config"
        : "--verify-url",
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
 * Opens a driver for the configured database (after the URL check), turns
 * Ctrl-C and SIGTERM into a cancellation signal (see withCancellation), and
 * closes the driver. After a failure it waits at most CLOSE_GRACE_MS for the
 * close, so the error is reported at once (see leftClosing).
 */
export const withDatabase = async <Result>(
  project: Pick<Project, "databaseUrl" | "databaseUrlSource">,
  operation: (driver: PostgresDriver, signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
  if (!project.databaseUrl) {
    throw new Error(
      "symmetria: no database: set databaseUrl in the config, DATABASE_URL or --database-url",
    );
  }

  const driver = databaseDriver(project);
  // Whether a connection was made: until then a cancellation leaves no
  // statement behind on the server.
  let connected = false;

  const reached = <Result>(work: Promise<Result>): Promise<Result> => {
    work.then(
      () => {
        connected = true;
      },
      (error: unknown) => {
        connected ||= sqlState(error) !== undefined;
      },
    );

    return work;
  };

  const tracked: PostgresDriver = {
    ...driver,
    execute: ((query) =>
      reached(driver.execute(query))) as PostgresDriver["execute"],
    transaction: (callback, options) =>
      driver.transaction((inside) => {
        connected = true;

        return callback(inside);
      }, options),
    session: (callback) =>
      driver.session((inside) => {
        connected = true;

        return callback(inside);
      }),
  };

  let failed = false;

  try {
    return await withCancellation(
      (signal) => operation(tracked, signal),
      () =>
        connected
          ? "the database confirmed the cancellation; the statement can run until PostgreSQL notices the closed connection"
          : "a connection to the database was made; nothing was sent",
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const closing = driver.close();

    if (!failed) {
      await closing;
    } else {
      // A failed or interrupted command reports at once. Work it gave up
      // on, such as a journal write whose new connection a server that
      // does not answer keeps waiting (with node-postgres for good), would
      // hold the close: the process leaves without it once it has reported.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        closing.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
        }),
      ]).finally(() => clearTimeout(timer));

      if (!closed) {
        closingLeft = true;
        closing.catch(() => {});
      }
    }
  }
};

/** How long a failed command waits for its driver to close before it reports. */
const CLOSE_GRACE_MS = 500;
let closingLeft = false;

/**
 * Whether a failed command left its driver closing: the process then exits
 * once its output is written, instead of waiting for the work that holds it.
 */
export const leftClosing = (): boolean => closingLeft;

/**
 * Runs database work that Ctrl-C and SIGTERM cancel: the signal aborts it, the
 * runner cancels the running statement and rolls back, and the process exits
 * with 130 or 143 once this returns (or after a few seconds; see ./signals).
 */
export const withCancellation = async <Result>(
  operation: (signal: AbortSignal) => Promise<Result>,
  unfinished?: () => string,
): Promise<Result> => {
  const cancellation = new AbortController();
  const unregister = interruptible({
    cancel: (reason) => cancellation.abort(reason),
    ...(unfinished ? { unfinished } : {}),
  });

  try {
    return await operation(cancellation.signal);
  } finally {
    unregister();
  }
};
