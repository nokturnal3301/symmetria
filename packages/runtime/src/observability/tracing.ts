/**
 * OpenTelemetry spans for a driver: one client span per statement and one
 * around every transaction. The tracer is passed in, so the package does not
 * depend on `@opentelemetry/api`; the types below are the part of its `Tracer`
 * and `Span` this file calls.
 */
import {
  normalizeResult,
  type Driver,
  type QueryExecutor,
  type SessionDriver,
  type TransactionDriver,
} from "../query/plan/types";
import { sqlState } from "../driver/errors";
import { inheritProfiling } from "./profiling";

type AttributeValue = string | number | boolean;

export type TracingSpan = {
  setAttribute(name: string, value: AttributeValue): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(error: Error | string): unknown;
  end(): void;
};

type SpanOptions = {
  kind?: number;
  attributes?: Record<string, AttributeValue>;
};

export type TracingTracer = {
  startSpan(name: string, options?: SpanOptions): TracingSpan;
  startActiveSpan<Result>(
    name: string,
    options: SpanOptions,
    run: (span: TracingSpan) => Result,
  ): Result;
};

export type TracingOptions = {
  /** `trace.getTracer("my-service")` from `@opentelemetry/api`. */
  readonly tracer: TracingTracer;
  /**
   * Whether spans carry the SQL text (`db.query.text`). The text has
   * placeholders in place of values, which are never recorded. Default true.
   */
  readonly text?: boolean;
  /** Added to every span, such as `server.address` or `db.namespace`. */
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
};

// SpanKind.CLIENT and SpanStatusCode.ERROR of @opentelemetry/api.
const CLIENT = 2;
const ERROR = 2;

const NAME = String.raw`(?:"(?:[^"]|"")+"|\w+)`;
const TARGET = new RegExp(
  String.raw`\b(?:FROM|INTO|UPDATE)\s+(${NAME}(?:\.${NAME})?)`,
  "i",
);
const SUMMARIES = 1000;

type Summary = { readonly operation: string; readonly table?: string };

/** `SELECT … FROM "users" AS …` is the operation SELECT on the table users. */
const summarize = (sql: string): Summary => {
  const operation = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? "QUERY";
  const target = TARGET.exec(sql)?.[1];

  return target === undefined
    ? { operation }
    : {
        operation,
        table: target
          .split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/)
          .map((part) =>
            part.startsWith('"')
              ? part.slice(1, -1).replaceAll('""', '"')
              : part,
          )
          .join("."),
      };
};

const failed = (span: TracingSpan, error: unknown): void => {
  const state = sqlState(error);
  const message = error instanceof Error ? error.message : String(error);

  if (state) {
    span.setAttribute("db.response.status_code", state);
  }

  span.setAttribute(
    "error.type",
    state ?? (error instanceof Error ? error.name : "Error"),
  );
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: ERROR, message });
};

/**
 * The driver with tracing:
 * `createDatabase({ schema, driver: traced(postgres({ url }), { tracer }) })`.
 * A statement's span is a child of whatever span is active when it runs, and
 * statements inside `$transaction` are children of the transaction's span.
 */
export const traced = <Wrapped extends Driver>(
  driver: Wrapped,
  options: TracingOptions,
): Wrapped => {
  const { tracer, text = true } = options;
  const shared = { "db.system.name": "postgresql", ...options.attributes };
  const summaries = new Map<string, Summary>();

  const summary = (sql: string): Summary => {
    let known = summaries.get(sql);

    if (!known) {
      known = summarize(sql);

      // Statements with inlined lists are unbounded; the cache is not.
      if (summaries.size >= SUMMARIES) {
        summaries.clear();
      }

      summaries.set(sql, known);
    }

    return known;
  };

  const executor = (execute: QueryExecutor): QueryExecutor => {
    const wrapper: QueryExecutor = async (query) => {
      const { operation, table } = summary(query.sql);
      const name = table === undefined ? operation : `${operation} ${table}`;
      const span = tracer.startSpan(name, {
        kind: CLIENT,
        attributes: {
          ...shared,
          "db.operation.name": operation,
          "db.query.summary": name,
          ...(table === undefined ? {} : { "db.collection.name": table }),
          ...(text ? { "db.query.text": query.sql } : {}),
        },
      });

      try {
        const result = await execute(query);

        span.setAttribute(
          "db.response.returned_rows",
          normalizeResult(result).rows.length,
        );

        return result;
      } catch (error) {
        failed(span, error);
        throw error;
      } finally {
        span.end();
      }
    };

    inheritProfiling(wrapper, execute);

    return wrapper;
  };

  const within = <Result>(
    name: string,
    run: () => Promise<Result>,
  ): Promise<Result> =>
    tracer.startActiveSpan(
      name,
      { kind: CLIENT, attributes: shared },
      async (span) => {
        try {
          return await run();
        } catch (error) {
          failed(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    );

  const inTransaction = (scoped: TransactionDriver): TransactionDriver =>
    Object.freeze({
      execute: executor(scoped.execute),
      transaction: (callback) =>
        within("savepoint", () =>
          scoped.transaction((nested) => callback(inTransaction(nested))),
        ),
    });

  const inSession = (session: SessionDriver): SessionDriver =>
    Object.freeze({
      ...session,
      execute: executor(session.execute),
      transaction: (callback, settings) =>
        within("transaction", () =>
          session.transaction(
            (scoped) => callback(inTransaction(scoped)),
            settings,
          ),
        ),
    });

  const { transaction, session } = driver;

  return Object.freeze({
    ...driver,
    execute: executor(driver.execute),
    ...(transaction
      ? {
          transaction: ((callback, settings) =>
            within("transaction", () =>
              transaction(
                (scoped) => callback(inTransaction(scoped)),
                settings,
              ),
            )) as NonNullable<Driver["transaction"]>,
        }
      : {}),
    ...(session
      ? {
          session: ((callback) =>
            session((pinned) => callback(inSession(pinned)))) as NonNullable<
            Driver["session"]
          >,
        }
      : {}),
  });
};
