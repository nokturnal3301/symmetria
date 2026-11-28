/** Everything a command needs: terminal mode, output, the project configuration and a database driver. */
import { access, readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgres, type PostgresDriver } from "symmetria/driver";
import { sqlState, type SchemaSnapshot } from "symmetria";
import type { MigrationConfig } from "../migrations/config";
import type { MigratorOptions } from "../migrations/runner";
import { serverAddress } from "../migrations/verify";
import { interruptible, type Interruptible } from "./signals";
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
  /** The migrations directory does not exist (not yet, in a new project). */
  readonly directoryMissing: boolean;
  readonly databaseUrl: string | undefined;
  /** Where databaseUrl came from, for messages (never the value). */
  readonly databaseUrlSource?: string;
  /** How long a connection to the database may take to open; 0 sets no limit. */
  readonly connectTimeoutMs: number;
  /** Where runnerOptions.verificationDatabaseUrl came from, for messages. */
  readonly verificationUrlSource?: string;
  readonly runnerOptions: Omit<MigratorOptions, "driver" | "signal">;
  /** The declared schema as a snapshot, when the config has one. */
  readonly snapshot: () => SchemaSnapshot | undefined;
};

/** What a command needs to reach the database. */
export type DatabaseAccess = Pick<
  Project,
  "databaseUrl" | "databaseUrlSource" | "connectTimeoutMs"
>;

const TIMEOUT_FLAGS = [
  ["advisoryLockTimeoutMs", "advisory-lock-timeout"],
  ["lockTimeoutMs", "lock-timeout"],
  ["statementTimeoutMs", "statement-timeout"],
] as const;

/**
 * How long the CLI waits for the database to accept a connection, unless
 * --connect-timeout says otherwise. Without a limit a host that drops packets
 * holds a command for as long as the operating system keeps trying.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;

/**
 * A timeout flag's value: whole milliseconds in decimal digits. Number() would
 * also read "1e3", "0x10" and "" (as 0, which disables the timeout).
 */
const flagMilliseconds = (flag: string, given: string): number => {
  const value = /^\d+$/.test(given.trim()) ? Number(given) : Number.NaN;

  if (!Number.isSafeInteger(value) || value > 2147483647) {
    throw new Error(
      `symmetria: invalid --${flag} ${JSON.stringify(given)}: expected whole milliseconds from 0 to 2147483647`,
    );
  }

  return value;
};

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
 * Whether text is written as a PostgreSQL URL: the scheme and its two
 * slashes. `host:5432/db` and `user:password@host/db` are URLs to a parser
 * as well, with `host:` or `user:` for a scheme.
 */
const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

/** node-postgres's own form for a socket directory: `socket:/dir?db=name`. */
const SOCKET_URL = /^socket:\//i;

/**
 * A PostgreSQL URL checked when a driver is opened, not when the config
 * loads (commands without a database ignore it). node-postgres resolves any
 * text against `postgres://base`, so a typo would surface as a DNS error for
 * the host "base", and it ignores the scheme of an absolute URL: text with
 * the `postgres://` forgotten (`host:5432/app`, `user:password@host/app`)
 * would leave it without a host, and it would connect to localhost, the
 * wrong server. This check refuses both and what node-postgres cannot parse,
 * and accepts the forms it reads: a URL with the scheme `postgres://` or
 * `postgresql://`, also without a host (`postgres:///app?host=/var/run/…`,
 * `postgres://user:password@/app?host=/cloudsql/…`, which it parses with a
 * placeholder host as done here), and a socket directory
 * (`/var/run/postgresql`, `socket:/var/run/postgresql?db=app`). The message
 * names where the value came from, never the value (it can hold a password).
 */
export const checkedUrl = (url: string, source: string): string => {
  // A config can hold anything where the URL belongs.
  if (typeof url !== "string") {
    throw new Error(
      `symmetria: invalid database URL in ${source}: expected a string such as postgres://user:password@host:5432/database`,
    );
  }

  if (url.startsWith("/")) {
    return url;
  }

  // pg-connection-string encodes spaces and stray `%` before parsing.
  const text = /[ ]|%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(url)
    ? encodeURI(url).replace(/%25(\d\d)/g, "%$1")
    : url;
  const parsed =
    URL.parse(text) ?? URL.parse(text.replace("@/", "@___DUMMY___/"));

  if (!parsed || !(POSTGRES_URL.test(url) || SOCKET_URL.test(url))) {
    throw new Error(
      `symmetria: invalid database URL in ${source}: expected postgres://user:password@host:5432/database`,
    );
  }

  return url;
};

/**
 * The parts of a database URL for display, or undefined for a socket
 * directory and for text that is no PostgreSQL URL: a parser would read
 * `user:password@host/app` as a path and show the password with it.
 */
export const displayedUrl = (url: unknown): URL | undefined =>
  typeof url === "string" && POSTGRES_URL.test(url)
    ? (URL.parse(url) ?? undefined)
    : undefined;

/**
 * The database URL and its source (--database-url, then the config, then
 * DATABASE_URL), and how long a connection to it may take to open.
 */
export const databaseUrlOf = (
  values: CliValues,
  config: MigrationConfig,
): DatabaseAccess => ({
  ...(values["database-url"] !== undefined
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
        }),
  connectTimeoutMs:
    values["connect-timeout"] === undefined
      ? DEFAULT_CONNECT_TIMEOUT_MS
      : flagMilliseconds("connect-timeout", values["connect-timeout"]),
});

/** The verification server's URL, checked like the database URL; undefined when none is set. */
export const verificationUrl = (
  project: Pick<Project, "runnerOptions" | "verificationUrlSource">,
): string | undefined => {
  const url = project.runnerOptions.verificationDatabaseUrl;

  return url
    ? checkedUrl(url, project.verificationUrlSource ?? "the verification URL")
    : undefined;
};

/** What node-postgres reports when a new connection did not open within `connectionTimeoutMillis`. */
const CONNECT_TIMEOUT = "Connection terminated due to connection timeout";

/**
 * A driver for the project's database (its URL is set), after the URL check.
 * Every connection it opens, also the ones a migration opens to cancel a
 * statement or to record a failure, must be accepted within the connection
 * timeout; an open connection is not limited, so a slow statement on a
 * server that answers is never cut short. `onConnect` hears of each
 * connection that opens.
 */
export const databaseDriver = (
  project: DatabaseAccess,
  onConnect?: () => void,
): PostgresDriver => {
  const url = checkedUrl(
    project.databaseUrl!,
    project.databaseUrlSource ?? "the database URL",
  );
  const limit = project.connectTimeoutMs;
  const driver = postgres({
    url,
    ...(limit ? { connectionTimeoutMillis: limit } : {}),
    ...(onConnect ? { onConnect } : {}),
  });

  if (!limit) {
    return driver;
  }

  // The driver's own error names neither the server nor the limit. The
  // replacement stays a connection failure for code that tells those from
  // statement errors (ETIMEDOUT is what the operating system reports when
  // its own, longer limit ends the attempt).
  const unanswered = (error: unknown): never => {
    throw error instanceof Error && error.message === CONNECT_TIMEOUT
      ? Object.assign(
          new Error(
            `symmetria: no connection to the database: ${serverAddress(url) ?? "the database server"} did not answer within ${limit}ms (--connect-timeout <ms> sets the limit; 0 waits as long as the operating system does)`,
          ),
          { code: "ETIMEDOUT" },
        )
      : error;
  };

  return {
    ...driver,
    execute: ((query) =>
      driver.execute(query).catch(unanswered)) as PostgresDriver["execute"],
    transaction: (callback, options) =>
      driver.transaction(callback, options).catch(unanswered),
    session: (callback) => driver.session(callback).catch(unanswered),
  };
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

    const exported: unknown = module.default;
    // A Promise or an array is an object too, and would read as a config
    // without a single setting.
    const found =
      exported === undefined
        ? "has no default export"
        : exported === null || typeof exported !== "object"
          ? `exports ${exported === null ? "null" : `a ${typeof exported}`}`
          : Array.isArray(exported)
            ? "exports an array"
            : typeof (exported as { then?: unknown }).then === "function"
              ? "exports a Promise, which is not awaited"
              : undefined;

    if (found) {
      throw new Error(
        `symmetria: ${configPath} must default-export a migration configuration object, as in "export default defineMigrationConfig({ schema, directory })"; it ${found}`,
      );
    }

    config = exported as MigrationConfig;
  }

  // null and undefined both leave the default in place.
  if (
    config.directory !== undefined &&
    config.directory !== null &&
    typeof config.directory !== "string"
  ) {
    throw new Error(
      'symmetria: invalid directory in the config: expected a path such as "./migrations"',
    );
  }

  const directory = values.dir
    ? resolve(values.dir)
    : resolve(
        present ? dirname(configPath) : process.cwd(),
        config.directory ?? "migrations",
      );
  const directoryMissing = await access(directory).then(
    () => false,
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
  const { databaseUrl, databaseUrlSource, connectTimeoutMs } = databaseUrlOf(
    values,
    config,
  );
  const timeouts = Object.fromEntries(
    TIMEOUT_FLAGS.flatMap(([key, flag]) => {
      const given = values[flag];
      const value =
        given === undefined ? config[key] : flagMilliseconds(flag, given);

      if (value === undefined) {
        return [];
      }

      if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
        throw new Error(
          `symmetria: invalid ${key} in the config: expected whole milliseconds from 0 to 2147483647`,
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
    directoryMissing,
    databaseUrl,
    ...(databaseUrlSource ? { databaseUrlSource } : {}),
    connectTimeoutMs,
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
      ...(connectTimeoutMs ? { connectionTimeoutMs: connectTimeoutMs } : {}),
      ignoreTables,
      ...timeouts,
      ...(config.onEvent ? { onEvent: config.onEvent } : {}),
    },
    snapshot: () => {
      const source: unknown = config.schema;

      if (source === undefined || source === null) {
        return undefined;
      }

      const declared = source as {
        $snapshot?: unknown;
        tables?: unknown;
      };

      if (
        typeof source === "object" &&
        typeof declared.$snapshot === "function"
      ) {
        return (source as { $snapshot: () => SchemaSnapshot }).$snapshot();
      }

      // Anything else must be the snapshot itself.
      if (typeof source !== "object" || !Array.isArray(declared.tables)) {
        throw new Error(
          "symmetria: invalid schema in the config: expected a schema() value, or the snapshot its $snapshot() returns",
        );
      }

      return source as SchemaSnapshot;
    },
  };
};

/**
 * What a command that reads the migration files says about a directory that
 * does not exist. A directory named with --dir, or the default one when no
 * config file was found either, is a wrong path: the command fails instead of
 * reporting an empty chain as success. Under a config file it is a project
 * before its first `generate`, and the returned note says so.
 */
export const missingDirectoryNote = (
  project: Project,
  values: CliValues,
): string | undefined => {
  if (!project.directoryMissing) {
    return undefined;
  }

  if (values.dir) {
    throw new Error(
      `symmetria: the migrations directory ${project.directory} (--dir) does not exist`,
    );
  }

  if (!project.present) {
    throw new Error(
      `symmetria: no config file was found in the current directory (looked for ${project.configPath}), and there is no migrations directory at ${project.directory} either; run the command in the project's directory, or pass --config <file> or --dir <directory>`,
    );
  }

  return `No migrations yet: the migrations directory ${project.directory} does not exist. "symmetria generate <name>" creates the first migration.`;
};

/**
 * The JSON in a file named by a flag. A file that cannot be read or parsed is
 * reported with the flag and the path, which JSON.parse's own message lacks.
 */
export const readJSONFile = async (
  flag: string,
  file: string,
): Promise<unknown> => {
  const path = resolve(file);
  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `symmetria: cannot read the --${flag} file ${path} (${reason(error)})`,
      { cause: error },
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `symmetria: the --${flag} file ${path} is not valid JSON (${reason(error)})`,
      { cause: error },
    );
  }
};

/**
 * Opens a driver for the configured database (after the URL check), turns
 * Ctrl-C and SIGTERM into a cancellation signal (see withCancellation), and
 * closes the driver. After a failure it waits at most CLOSE_GRACE_MS for the
 * close, so the error is reported at once (see leftClosing).
 */
export const withDatabase = async <Result>(
  project: DatabaseAccess,
  operation: (driver: PostgresDriver, signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
  if (!project.databaseUrl) {
    throw new Error(
      "symmetria: no database: set databaseUrl in the config, DATABASE_URL or --database-url",
    );
  }

  // Whether a connection was made: until then a cancellation leaves no
  // statement behind on the server.
  let connected = false;
  const driver = databaseDriver(project, () => {
    connected = true;
  });

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
    return await withCancellation((signal) => operation(tracked, signal), {
      unfinished: () =>
        connected
          ? "the database confirmed the cancellation; the statement can run until PostgreSQL notices the closed connection"
          : "a connection to the database was made; nothing was sent",
      // Nothing reached the server yet: no statement or lock to wait for.
      waits: () => connected,
    });
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
      // does not answer keeps waiting (until the connection timeout, or
      // for good without one), would hold the close: the process leaves
      // without it once it has reported.
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
  state: Pick<Interruptible, "unfinished" | "waits"> = {},
): Promise<Result> => {
  const cancellation = new AbortController();
  const unregister = interruptible({
    cancel: (reason) => cancellation.abort(reason),
    ...state,
  });

  try {
    return await operation(cancellation.signal);
  } finally {
    unregister();
  }
};
