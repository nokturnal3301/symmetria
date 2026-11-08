/**
 * Query profiler: records per-request query timings through AsyncLocalStorage and serves them over HTTP with a token.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { serveProfiler } from "./http";
import { cloneParameter } from "../query/codecs";
import { postgresRenderer } from "../query/compile/postgres/render";
import {
  normalizeResult,
  type CompiledQuery,
  type Driver,
  type QueryExecutor,
  type TransactionDriver,
} from "../query/plan/types";

export type ProfiledQuery = {
  id: number;
  sql: string;
  parameters: unknown[];
  kind: "select" | "insert" | "update" | "delete" | "raw";
  compileMs: number;
  databaseMs: number;
  decodeMs: number;
  rows: number;
  error?: string;
};

export type ProfiledRequest = {
  id: number;
  label: string;
  startedAt: string;
  durationMs: number;
  buildMs: number;
  queries: ProfiledQuery[];
  /** Oldest queries removed once the request exceeded the profiler's queryCapacity. */
  droppedQueries?: number;
  error?: string;
};

type QueryDetails = {
  kind: ProfiledQuery["kind"];
  compileMs: number;
  decodeMs: number;
};
type ExecutorProfiling = {
  trackBuilder: <Builder extends object>(builder: Builder) => Builder;
  annotate: (query: CompiledQuery, details: QueryDetails) => void;
};

const executorProfiles = new WeakMap<QueryExecutor, ExecutorProfiling>();

export const executorProfiling = (
  executor?: QueryExecutor,
): ExecutorProfiling | undefined =>
  executor ? executorProfiles.get(executor) : undefined;

const serialize = (value: unknown) =>
  JSON.stringify(value, (_name, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );

const constantTimeEqual = (
  candidate: string | null,
  expected: string,
): boolean => {
  if (candidate === null) {
    return false;
  }

  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
};

/** Opt-in profiling; async contexts isolate simultaneous named traces and HTTP requests. */
export const createProfiler = (
  options: {
    /** Completed requests retained for the endpoint and snapshot() (default 200). */
    capacity?: number;
    /** Queries retained per request; older ones are dropped and counted (default 1000). */
    queryCapacity?: number;
  } = {},
) => {
  const capacity = options.capacity ?? 200;
  const queryCapacity = options.queryCapacity ?? 1000;

  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("symmetria: profiler capacity must be a positive integer");
  }

  if (!Number.isSafeInteger(queryCapacity) || queryCapacity < 1) {
    throw new Error(
      "symmetria: profiler queryCapacity must be a positive integer",
    );
  }

  const context = new AsyncLocalStorage<ProfiledRequest>();
  const requests: ProfiledRequest[] = [];
  const queryRecords = new WeakMap<CompiledQuery, ProfiledQuery>();
  const queryExecutors = new Map<
    number,
    {
      query: CompiledQuery;
      executor: QueryExecutor;
      record: ProfiledQuery;
    }
  >();
  const wrappedBuilders = new WeakSet<object>();
  const excluded = new Set([
    "execute",
    "then",
    "toSQL",
    "one",
    "maybeOne",
    "first",
    "page",
    "pages",
    "stream",
    "inspect",
    "$transaction",
    "$close",
    "$snapshot",
  ]);
  let nextRequestId = 1;
  let nextQueryId = 1;
  let building = 0;

  const remember = (request: ProfiledRequest) => {
    requests.push(request);

    while (requests.length > capacity) {
      const removed = requests.shift()!;

      for (const query of removed.queries) {
        queryExecutors.delete(query.id);
      }
    }
  };

  const trace = async <Result>(
    label: string,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> => {
    const request: ProfiledRequest = {
      id: nextRequestId++,
      label,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      buildMs: 0,
      queries: [],
    };

    const started = performance.now();

    try {
      return await context.run(request, operation);
    } catch (error) {
      request.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      request.durationMs = performance.now() - started;
      remember(request);
    }
  };

  const trackBuilder = <Builder extends object>(builder: Builder): Builder => {
    if (wrappedBuilders.has(builder)) {
      return builder;
    }

    const methods = new Map<PropertyKey, unknown>();

    const measure = (operation: () => unknown): unknown => {
      const request = context.getStore();
      const outermost = building++ === 0;
      const started = request && outermost ? performance.now() : 0;

      try {
        return operation();
      } finally {
        building--;

        if (request && outermost) {
          request.buildMs += performance.now() - started;
        }
      }
    };

    const proxy = new Proxy(
      typeof builder === "function"
        ? (..._argumentsList: unknown[]) => undefined
        : {},
      {
        apply: (_target, receiver, argumentsList) =>
          measure(() =>
            Reflect.apply(
              builder as (...argumentsList: unknown[]) => unknown,
              receiver,
              argumentsList,
            ),
          ),
        get: (_target, key) => {
          const value = Reflect.get(builder, key);

          if (
            typeof value !== "function" ||
            typeof key !== "string" ||
            excluded.has(key)
          ) {
            if (key === "by" && value && typeof value === "object") {
              if (!methods.has(key)) {
                methods.set(key, trackBuilder(value));
              }

              return methods.get(key);
            }

            return value;
          }

          if (!methods.has(key)) {
            methods.set(key, (...argumentsList: unknown[]) => {
              return measure(() =>
                Reflect.apply(value, builder, argumentsList),
              );
            });
          }

          return methods.get(key);
        },
        has: (_target, key) => key in builder,
        getPrototypeOf: () => Object.getPrototypeOf(builder) as object | null,
        ownKeys: () => Reflect.ownKeys(builder),
        getOwnPropertyDescriptor: (_target, key) => {
          const descriptor = Object.getOwnPropertyDescriptor(builder, key);

          return descriptor ? { ...descriptor, configurable: true } : undefined;
        },
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
      },
    ) as Builder;
    wrappedBuilders.add(proxy);

    return proxy;
  };

  const wrapExecutor = (
    executor: QueryExecutor,
    explainExecutor = executor,
  ): QueryExecutor => {
    const execute: QueryExecutor = async (query) => {
      const request = context.getStore();

      if (!request) {
        return trace("background query", () => execute(query));
      }

      const started = performance.now();
      const record: ProfiledQuery = {
        id: nextQueryId++,
        sql: query.sql,
        parameters: [],
        kind: "raw",
        compileMs: 0,
        databaseMs: 0,
        decodeMs: 0,
        rows: 0,
      };

      try {
        const result = await executor(query);
        record.rows = normalizeResult(result).affectedRows;

        return result;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        record.databaseMs = performance.now() - started;
        record.parameters = query.parameters.map(cloneParameter);
        request.queries.push(record);
        queryRecords.set(query, record);
        queryExecutors.set(record.id, {
          query: { sql: query.sql, parameters: record.parameters },
          executor: explainExecutor,
          record,
        });

        // A runaway loop must not retain unbounded SQL and parameters.
        while (request.queries.length > queryCapacity) {
          const dropped = request.queries.shift()!;
          queryExecutors.delete(dropped.id);
          request.droppedQueries = (request.droppedQueries ?? 0) + 1;
        }
      }
    };

    executorProfiles.set(execute, {
      trackBuilder,
      annotate: (query, details) => {
        const record = queryRecords.get(query);

        if (record) {
          Object.assign(record, details);
        }
      },
    });

    return execute;
  };

  const transactionDriver = (
    driver: TransactionDriver,
    explainExecutor: QueryExecutor,
  ): TransactionDriver =>
    Object.freeze({
      execute: wrapExecutor(driver.execute, explainExecutor),
      transaction: (callback) =>
        driver.transaction((nested) =>
          callback(transactionDriver(nested, explainExecutor)),
        ),
    });

  const wrapDriver = (driver: Driver): Driver =>
    Object.freeze({
      execute: wrapExecutor(driver.execute, driver.execute),
      close: driver.close,
      ...(driver.session ? { session: driver.session } : {}),
      ...(driver.transaction
        ? {
            transaction: <Result>(
              callback: (driver: TransactionDriver) => Promise<Result>,
              settings?: import("../query/plan/types").TransactionOptions,
            ) =>
              driver.transaction!(
                (scoped) => callback(transactionDriver(scoped, driver.execute)),
                settings,
              ),
          }
        : {}),
    });

  const snapshot = (): ProfiledRequest[] => structuredClone(requests);

  const explain = async (identifier: number, analyze = false) => {
    const entry = queryExecutors.get(identifier);

    if (!entry || entry.record.kind !== "select") {
      throw new Error("symmetria: EXPLAIN requires a retained SELECT query");
    }

    const statement = postgresRenderer.explain(entry.query.sql, analyze);
    const result = normalizeResult(
      await entry.executor({
        sql: statement.sql,
        parameters: entry.query.parameters.map(cloneParameter),
      }),
    );

    return statement.plan(result.rows);
  };

  const fetchHandler =
    (handler: (request: Request) => Response | Promise<Response>) =>
    (request: Request) =>
      trace(`${request.method} ${new URL(request.url).pathname}`, () =>
        handler(request),
      );

  const serve = async (
    settings: {
      port?: number;
      hostname?: "127.0.0.1" | "::1";
      /**
       * Shared secret every request must send as `X-Symmetria-Token`.
       * Defaults to SYMMETRIA_PROFILE_TOKEN, else a random value returned
       * from serve(); `symmetria profile` reads the same variable.
       */
      token?: string;
    } = {},
  ) => {
    const hostname = settings.hostname ?? "127.0.0.1";

    if (hostname !== "127.0.0.1" && hostname !== "::1") {
      throw new Error(
        "symmetria: profiler HTTP server requires a loopback address",
      );
    }

    const token =
      settings.token ?? process.env.SYMMETRIA_PROFILE_TOKEN ?? randomUUID();

    if (
      typeof token !== "string" ||
      token.length < 16 ||
      !/^[\x21-\x7e]+$/.test(token)
    ) {
      throw new Error(
        "symmetria: profiler token must be at least 16 printable ASCII characters",
      );
    }

    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };

    const server = await serveProfiler({
      hostname,
      port: settings.port ?? 7331,
      fetch: async (request, server) => {
        const url = new URL(request.url);
        const names = [hostname === "::1" ? "[::1]" : hostname, "localhost"];
        const hosts = names.flatMap((name) =>
          server.port === 80
            ? [name, `${name}:80`]
            : [`${name}:${server.port}`],
        );
        const origin = request.headers.get("origin");
        const site = request.headers.get("sec-fetch-site");

        if (
          url.protocol !== "http:" ||
          !hosts.includes(url.host) ||
          !hosts.includes(request.headers.get("host")?.toLowerCase() ?? "") ||
          (origin !== null && origin !== url.origin) ||
          (site !== null && site !== "same-origin" && site !== "none") ||
          // Captured SQL and parameters are as sensitive as EXPLAIN ANALYZE,
          // which re-executes the statement: every route needs the token.
          !constantTimeEqual(request.headers.get("x-symmetria-token"), token)
        ) {
          return Response.json(
            { error: "Forbidden" },
            { status: 403, headers },
          );
        }

        if (request.method === "GET" && url.pathname === "/requests") {
          return new Response(serialize(snapshot()), { headers });
        }

        if (request.method === "POST" && url.pathname === "/explain") {
          try {
            const result = await explain(
              Number(url.searchParams.get("id")),
              url.searchParams.get("analyze") === "true",
            );

            return new Response(serialize(result), {
              headers,
            });
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : String(error) },
              { status: 400, headers },
            );
          }
        }

        return Response.json({ error: "Not found" }, { status: 404, headers });
      },
    });

    return Object.freeze({ ...server, token });
  };

  return Object.freeze({
    trace,
    fetch: fetchHandler,
    driver: wrapDriver,
    snapshot,
    explain,
    serve,
  });
};

export type QueryProfiler = ReturnType<typeof createProfiler>;
