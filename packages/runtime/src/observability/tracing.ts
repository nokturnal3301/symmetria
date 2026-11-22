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
  recordException(
    exception: { name: string; message: string; code?: string } | string,
  ): unknown;
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

const SUMMARIES = 1000;
const CACHED_TEXT = 2000;
const CURSOR =
  /^\s*(DECLARE|FETCH|MOVE|CLOSE)\b(?:\s+\w+)*?\s+("(?:[^"]|"")+"|[A-Za-z_]\w*)\s*(?:NO\s+SCROLL|SCROLL|BINARY|INSENSITIVE|ASENSITIVE|CURSOR|$)/i;

type Summary = { readonly operation: string; readonly table?: string };

const IDENTIFIER =
  /^(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*))?/;

/** `"audit"."events"` is the table audit.events. */
const tableName = (text: string): string =>
  text
    .split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) =>
      part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part,
    )
    .join(".");

/**
 * The words of a statement outside parentheses, quotes and strings, with
 * their positions: nested reads, subqueries and `extract(year from at)` sit
 * in parentheses, so the first top-level FROM is the statement's own.
 */
const topLevelWords = function* (
  sql: string,
): Generator<{ word: string; end: number }> {
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;

    if (char === "'" || char === '"') {
      const close = sql.indexOf(char, index + 1);

      index = close < 0 ? sql.length : close + 1;
    } else if (char === "$") {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(index))?.[0];
      const close = tag ? sql.indexOf(tag, index + tag.length) : -1;

      index = tag ? (close < 0 ? sql.length : close + tag.length) : index + 1;
    } else if (char === "(") {
      depth += 1;
      index += 1;
    } else if (char === ")") {
      depth -= 1;
      index += 1;
    } else if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_]\w*/.exec(sql.slice(index))![0];

      index += word.length;

      if (depth === 0) {
        yield { word: word.toUpperCase(), end: index };
      }
    } else {
      index += 1;
    }
  }
};

/** The table a statement reads or writes, looking into a derived table. */
const statementTable = (sql: string): string | undefined => {
  for (const { word, end } of topLevelWords(sql)) {
    if (word !== "FROM" && word !== "INTO" && word !== "UPDATE") {
      continue;
    }

    const rest = sql.slice(end).trimStart();

    if (rest.startsWith("(")) {
      let depth = 0;
      let close = 0;

      for (; close < rest.length; close += 1) {
        depth += rest[close] === "(" ? 1 : rest[close] === ")" ? -1 : 0;

        if (depth === 0) {
          break;
        }
      }

      return statementTable(rest.slice(1, close));
    }

    const name = IDENTIFIER.exec(rest)?.[0];

    // UPDATE as a word inside a statement (FOR UPDATE, DO UPDATE) names none.
    if (name && !/^(?:SET|OF|NOWAIT|SKIP)$/i.test(name)) {
      return tableName(name);
    }
  }

  return undefined;
};

/**
 * `SELECT … FROM "users" AS …` is the operation SELECT on the table users. A
 * cursor's FETCH and CLOSE name no table: its name is new for every stream.
 */
const summarize = (sql: string): Summary => {
  const operation = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? "QUERY";

  if (operation === "FETCH" || operation === "CLOSE" || operation === "MOVE") {
    return { operation };
  }

  const table = statementTable(sql);

  return table === undefined ? { operation } : { operation, table };
};

const failed = (span: TracingSpan, error: unknown): void => {
  const state = sqlState(error);
  const name = error instanceof Error ? error.name : "Error";
  const { code, constraint } = (error ?? {}) as {
    code?: unknown;
    constraint?: unknown;
  };
  const known = state ?? (typeof code === "string" ? code : undefined);
  const message = [
    name,
    known === undefined ? undefined : `(${known})`,
    typeof constraint === "string"
      ? `on constraint "${constraint}"`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

  if (state) {
    span.setAttribute("db.response.status_code", state);
  }

  span.setAttribute("error.type", state ?? name);
  span.recordException(
    known === undefined ? { name, message } : { name, message, code: known },
  );
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

  // Statements with inlined lists or many rows are unbounded; the cache
  // keeps short texts only, and at most SUMMARIES of them.
  const summary = (sql: string): Summary => {
    if (sql.length > CACHED_TEXT) {
      return summarize(sql);
    }

    let known = summaries.get(sql);

    if (!known) {
      known = summarize(sql);

      if (summaries.size >= SUMMARIES) {
        summaries.clear();
      }

      summaries.set(sql, known);
    }

    return known;
  };
  // The table each open cursor reads, from its DECLARE, for its FETCH and
  // CLOSE; a stream's cursor is closed when it ends.
  const cursors = new Map<string, string>();
  const statement = (sql: string): Summary => {
    const cursor = CURSOR.exec(sql);

    if (!cursor) {
      return summary(sql);
    }

    const [, operation, name] = cursor as unknown as [string, string, string];

    if (operation.toUpperCase() === "DECLARE") {
      const declared = summary(sql);

      if (declared.table !== undefined) {
        if (cursors.size >= SUMMARIES) {
          cursors.clear();
        }

        cursors.set(name, declared.table);
      }

      return declared;
    }

    const table = cursors.get(name);

    if (operation.toUpperCase() === "CLOSE") {
      cursors.delete(name);
    }

    return {
      operation: operation.toUpperCase(),
      ...(table === undefined ? {} : { table }),
    };
  };
  // Errors a statement's span has recorded. A transaction rejects the
  // statements queued behind a failed one with its error, unsent.
  const recorded = new WeakSet<object>();

  const executor = (execute: QueryExecutor): QueryExecutor => {
    const wrapper: QueryExecutor = async (query) => {
      const { operation, table } = statement(query.sql);
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
        if (typeof error === "object" && error !== null) {
          if (recorded.has(error)) {
            span.setAttribute("error.type", "not_sent");
            span.setStatus({
              code: ERROR,
              message:
                "not sent: an earlier statement of the transaction failed",
            });
            throw error;
          }

          recorded.add(error);
        }

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
