import { AsyncLocalStorage } from "node:async_hooks";
import { cloneParameter } from "../query/codecs";
import { dialectName, resolveDialect } from "../query/dialects/registry";
import {
  normalizeResult,
  type CompiledQuery,
  type Dialect,
  type Driver,
  type QueryExecutor,
  type TransactionDriver,
} from "../query/state";

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

/** Opt-in profiling; async contexts isolate simultaneous named traces and HTTP requests. */
export const createProfiler = (options: { capacity?: number } = {}) => {
  const capacity = options.capacity ?? 200;

  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("symmetria: profiler capacity must be a positive integer");
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
      dialect: Dialect | undefined;
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
    dialect?: Dialect,
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
          dialect,
        });
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
    dialect: Dialect | undefined,
  ): TransactionDriver =>
    Object.freeze({
      execute: wrapExecutor(driver.execute, explainExecutor, dialect),
      transaction: (callback) =>
        driver.transaction((nested) =>
          callback(transactionDriver(nested, explainExecutor, dialect)),
        ),
    });

  const wrapDriver = (driver: Driver): Driver => {
    const dialect = dialectName(driver.dialect);

    return Object.freeze({
      execute: wrapExecutor(driver.execute, driver.execute, dialect),
      close: driver.close,
      ...(dialect ? { dialect } : {}),
      ...(driver.transaction
        ? {
            transaction: <Result>(
              callback: (driver: TransactionDriver) => Promise<Result>,
              settings?: import("../query/state").TransactionOptions,
            ) =>
              driver.transaction!(
                (scoped) =>
                  callback(transactionDriver(scoped, driver.execute, dialect)),
                settings,
              ),
          }
        : {}),
    });
  };

  const snapshot = (): ProfiledRequest[] => structuredClone(requests);

  const explain = async (identifier: number, analyze = false) => {
    const entry = queryExecutors.get(identifier);

    if (!entry || entry.record.kind !== "select") {
      throw new Error("symmetria: EXPLAIN requires a retained SELECT query");
    }

    const statement = resolveDialect(entry.dialect).explain(
      entry.query.sql,
      analyze,
    );
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

  const serve = (
    settings: { port?: number; hostname?: "127.0.0.1" | "::1" } = {},
  ) =>
    Bun.serve({
      hostname: settings.hostname ?? "127.0.0.1",
      port: settings.port ?? 7331,
      fetch: async (request) => {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/requests") {
          return new Response(serialize(snapshot()), {
            headers: { "content-type": "application/json" },
          });
        }

        if (request.method === "POST" && url.pathname === "/explain") {
          try {
            const result = await explain(
              Number(url.searchParams.get("id")),
              url.searchParams.get("analyze") === "true",
            );

            return new Response(serialize(result), {
              headers: { "content-type": "application/json" },
            });
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : String(error) },
              { status: 400 },
            );
          }
        }

        return new Response("Not found", { status: 404 });
      },
    });

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
