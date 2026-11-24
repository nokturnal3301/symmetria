/**
 * OpenTelemetry spans for a driver: one client span per statement and one
 * around every transaction and savepoint. The tracer is passed in, so the
 * package does not depend on `@opentelemetry/api`; the types below are the
 * part of its `Tracer` and `Span` this file calls.
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

// The kinds of token the scanner below reads.
const END = 0;
/** A keyword or a bare identifier. */
const WORD = 1;
/** A "quoted identifier". */
const QUOTED = 2;
const OPEN = 3;
const CLOSE = 4;
const DOT = 5;
const COMMA = 6;
const SEMICOLON = 7;
/** A string, number, parameter or operator. */
const OTHER = 8;

/** The token the scanner read last, from `start` to `end`. */
type Cursor = { start: number; end: number };

const isLetter = (code: number): boolean =>
  (code >= 97 && code <= 122) ||
  (code >= 65 && code <= 90) ||
  code === 95 ||
  code >= 128;

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/** Where a string or quoted identifier opened at `at` ends; -1 when it does not. */
const quoted = (sql: string, at: number, quote: string): number => {
  let index = at + 1;

  for (;;) {
    const close = sql.indexOf(quote, index);

    if (close < 0) {
      return -1;
    }

    // A doubled quote is one quote inside.
    if (sql[close + 1] !== quote) {
      return close + 1;
    }

    index = close + 2;
  }
};

/** Where an escape string `E'…'` ends: a backslash escapes the next character. */
const escaped = (sql: string, at: number): number => {
  for (let index = at + 1; index < sql.length; index += 1) {
    const code = sql.charCodeAt(index);

    if (code === 92) {
      index += 1;
    } else if (code === 39) {
      if (sql.charCodeAt(index + 1) !== 39) {
        return index + 1;
      }

      index += 1;
    }
  }

  return sql.length;
};

/** Where the spaces and comments from `at` end. Block comments nest. */
const spaced = (sql: string, at: number): number => {
  const length = sql.length;
  let index = at;

  while (index < length) {
    const code = sql.charCodeAt(index);

    if (code === 32 || (code >= 9 && code <= 13)) {
      index += 1;
    } else if (code === 45 && sql.charCodeAt(index + 1) === 45) {
      const line = sql.indexOf("\n", index + 2);

      index = line < 0 ? length : line + 1;
    } else if (code === 47 && sql.charCodeAt(index + 1) === 42) {
      let depth = 1;

      index += 2;

      while (depth > 0 && index < length) {
        const next = sql.charCodeAt(index);

        if (next === 47 && sql.charCodeAt(index + 1) === 42) {
          depth += 1;
          index += 2;
        } else if (next === 42 && sql.charCodeAt(index + 1) === 47) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
    } else {
      break;
    }
  }

  return index;
};

/**
 * Reads the token after `cursor.end` the way PostgreSQL's scanner does:
 * comments are space, so they are never read as SQL; a string, a
 * dollar-quoted string, a number or a parameter is one token, and `x$y` is
 * one identifier.
 */
const scan = (sql: string, cursor: Cursor): number => {
  const length = sql.length;
  const at = spaced(sql, cursor.end);

  cursor.start = at;

  if (at >= length) {
    cursor.end = length;

    return END;
  }

  const code = sql.charCodeAt(at);
  let end = at + 1;
  let kind = OTHER;

  if (isLetter(code)) {
    for (
      let next = sql.charCodeAt(end);
      end < length && (isLetter(next) || isDigit(next) || next === 36);
      next = sql.charCodeAt(end)
    ) {
      end += 1;
    }

    if (end === at + 1 && (code === 69 || code === 101) && sql[end] === "'") {
      end = escaped(sql, end);
    } else {
      kind = WORD;
    }
  } else if (code === 39 || code === 34) {
    const close = quoted(sql, at, sql[at]!);

    end = close < 0 ? length : close;
    // An unterminated or empty quoted name names nothing.
    kind = code === 34 && close > at + 2 ? QUOTED : OTHER;
  } else if (code === 36) {
    // $1 is a parameter; $$…$$ and $tag$…$tag$ are strings.
    let tag = end;

    while (
      tag < length &&
      (isLetter(sql.charCodeAt(tag)) || isDigit(sql.charCodeAt(tag)))
    ) {
      tag += 1;
    }

    if (isDigit(sql.charCodeAt(end))) {
      end = tag;
    } else if (sql.charCodeAt(tag) === 36) {
      const delimiter = sql.slice(at, tag + 1);
      const close = sql.indexOf(delimiter, tag + 1);

      end = close < 0 ? length : close + delimiter.length;
    }
  } else if (isDigit(code)) {
    while (
      end < length &&
      (isLetter(sql.charCodeAt(end)) || isDigit(sql.charCodeAt(end)))
    ) {
      end += 1;
    }
  } else {
    kind =
      code === 40
        ? OPEN
        : code === 41
          ? CLOSE
          : code === 46
            ? DOT
            : code === 44
              ? COMMA
              : code === 59
                ? SEMICOLON
                : OTHER;
  }

  cursor.end = end;

  return kind;
};

/** Whether the text from `start` to `end` is `word` in any case. */
const spells = (
  sql: string,
  start: number,
  end: number,
  word: string,
): boolean => {
  if (end - start !== word.length) {
    return false;
  }

  // `word` is in capitals; clearing bit 32 turns a small ASCII letter into
  // its capital and leaves every other character outside A-Z.
  for (let index = 0; index < word.length; index += 1) {
    if ((sql.charCodeAt(start + index) & ~32) !== word.charCodeAt(index)) {
      return false;
    }
  }

  return true;
};

/** The name an identifier token gives: `"we""ird"` is we"ird. */
const nameOf = (sql: string, start: number, end: number, kind: number) =>
  kind === QUOTED
    ? sql.slice(start + 1, end - 1).replaceAll('""', '"')
    : sql.slice(start, end);

/** A name as PostgreSQL compares it: unquoted, it is in lower case. */
const keyOf = (sql: string, start: number, end: number, kind: number) =>
  kind === QUOTED
    ? nameOf(sql, start, end, kind)
    : sql.slice(start, end).replace(/[A-Z]+/g, (upper) => upper.toLowerCase());

/** Words after FROM, INTO or UPDATE that name no table (FOR UPDATE OF, DO UPDATE SET). */
const NOT_TABLES = new Set(["SET", "OF", "NOWAIT", "SKIP"]);

const isOwnKeyword = (sql: string, start: number, end: number) =>
  spells(sql, start, end, "FROM") ||
  spells(sql, start, end, "INTO") ||
  spells(sql, start, end, "UPDATE");

/**
 * The summary of a statement whose own table comes before any WITH in it,
 * read no further than that table, so that most statements (an INSERT of
 * many rows among them) cost a few tokens. A statement's own table is the
 * first name after FROM, INTO or UPDATE outside parentheses: nested reads,
 * subqueries and `extract(year from at)` sit in parentheses. Undefined when
 * the rest of the statement decides the name.
 */
const leading = (sql: string): Summary | undefined => {
  const cursor = { start: 0, end: 0 };

  if (scan(sql, cursor) !== WORD) {
    return undefined;
  }

  const operation = sql.slice(cursor.start, cursor.end).toUpperCase();

  // A cursor's name is new for every stream, so FETCH and CLOSE name no table.
  if (operation === "FETCH" || operation === "CLOSE" || operation === "MOVE") {
    return { operation };
  }

  if (operation === "WITH") {
    return undefined;
  }

  let depth = 0;

  for (let kind = scan(sql, cursor); kind !== END; kind = scan(sql, cursor)) {
    if (kind === OPEN) {
      depth += 1;
    } else if (kind === CLOSE) {
      depth = Math.max(depth - 1, 0);
    } else if (kind === WORD && depth === 0) {
      const { start, end } = cursor;

      if (spells(sql, start, end, "WITH")) {
        return undefined;
      }

      if (isOwnKeyword(sql, start, end)) {
        const next = scan(sql, cursor);

        // A derived table: its own table is the statement's.
        if (next === OPEN) {
          return undefined;
        }

        if (next === WORD || next === QUOTED) {
          const name = nameOf(sql, cursor.start, cursor.end, next);
          const after = cursor.end;

          if (scan(sql, cursor) === DOT) {
            const part = scan(sql, cursor);

            if (part === WORD || part === QUOTED) {
              return {
                operation,
                table: `${name}.${nameOf(sql, cursor.start, cursor.end, part)}`,
              };
            }
          }

          if (next === QUOTED || !NOT_TABLES.has(name.toUpperCase())) {
            return { operation, table: name };
          }

          cursor.end = after;
        } else {
          // Read the token again: it may open or close a parenthesis.
          cursor.end = end;
        }
      }
    }
  }

  return undefined;
};

/** A common table of a WITH list: its name, its body and the table it reads. */
type Common = {
  readonly key: string;
  readonly body: number;
  readonly recursive: boolean;
  state: "new" | "naming" | "named";
  table: string | null;
};

/** What a statement or subquery names first after FROM, INTO or UPDATE. */
type Own =
  | { readonly table: string }
  | { readonly common: Common }
  | { readonly derived: number };

/**
 * Subqueries nested deeper than this name no table. PostgreSQL refuses
 * statements nested a few thousand deep; the limit keeps naming off the end
 * of the call stack.
 */
const NESTING = 1000;

/**
 * The summary of any statement. Its tokens are read into lists; one pass from
 * left to right then finds each WITH list and the own table of the statement
 * and of every parenthesis, resolving a name against the common tables in
 * scope there as PostgreSQL does: a common table is seen by the statement
 * after its list and by the bodies after its own, or by every body of a
 * WITH RECURSIVE list, and an inner list hides an outer name. Each
 * parenthesis and common table is looked at once, so naming takes time in
 * proportion to the statement's length.
 */
const analyze = (sql: string): Summary => {
  const kinds: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const cursor = { start: 0, end: 0 };

  for (let kind = scan(sql, cursor); kind !== END; kind = scan(sql, cursor)) {
    kinds.push(kind);
    starts.push(cursor.start);
    ends.push(cursor.end);
  }

  const count = kinds.length;
  // Where each parenthesis closes, by the token that opens it; an unclosed
  // one closes at the end. A ) without its ( is ignored.
  const closes = new Int32Array(count);
  const opened: number[] = [];

  for (let index = 0; index < count; index += 1) {
    if (kinds[index] === OPEN) {
      opened.push(index);
    } else if (kinds[index] === CLOSE && opened.length) {
      closes[opened.pop()!] = index;
    }
  }

  for (const index of opened) {
    closes[index] = count;
  }

  const is = (index: number, word: string) =>
    kinds[index] === WORD && spells(sql, starts[index]!, ends[index]!, word);
  const isName = (index: number) =>
    kinds[index] === WORD || kinds[index] === QUOTED;
  const closed = (index: number) =>
    kinds[index] === OPEN && closes[index]! < count;
  const name = (index: number) =>
    nameOf(sql, starts[index]!, ends[index]!, kinds[index]!);

  /** Skips `a, b, c` from `index`; -1 unless it is a list of names. */
  const names = (index: number): number => {
    let next = index;

    while (isName(next)) {
      if (kinds[next + 1] !== COMMA) {
        return next + 1;
      }

      next += 2;
    }

    return -1;
  };

  /** Skips a few tokens to `word` (`TO true DEFAULT false USING`); -1 without it. */
  const toWord = (index: number, word: string): number => {
    for (let next = index; next < index + 4; next += 1) {
      if (is(next, word)) {
        return next;
      }
    }

    return -1;
  };

  /**
   * The WITH list starting at `at`: `WITH [RECURSIVE] a [(x, y)] AS
   * [[NOT] MATERIALIZED] (…) [SEARCH …] [CYCLE …], b AS (…)`, and the token
   * after it. Undefined for any other WITH (WITH HOLD, WITH TIME ZONE).
   */
  const list = (
    at: number,
  ): { recursive: boolean; commons: Common[]; end: number } | undefined => {
    let index = at + 1;
    const recursive = is(index, "RECURSIVE");
    const commons: Common[] = [];

    if (recursive) {
      index += 1;
    }

    for (;;) {
      if (!isName(index)) {
        return undefined;
      }

      const key = keyOf(sql, starts[index]!, ends[index]!, kinds[index]!);

      index += 1;

      if (kinds[index] === OPEN) {
        if (!closed(index)) {
          return undefined;
        }

        index = closes[index]! + 1;
      }

      if (!is(index, "AS")) {
        return undefined;
      }

      index += is(index + 1, "NOT") ? 2 : 1;

      if (is(index, "MATERIALIZED")) {
        index += 1;
      }

      if (!closed(index)) {
        return undefined;
      }

      commons.push({ key, body: index, recursive, state: "new", table: null });
      index = closes[index]! + 1;

      // SEARCH DEPTH FIRST BY a, b SET ordinal
      if (is(index, "SEARCH")) {
        index =
          is(index + 2, "FIRST") && is(index + 3, "BY") ? names(index + 4) : -1;

        if (!is(index, "SET") || !isName(index + 1)) {
          return undefined;
        }

        index += 2;
      }

      // CYCLE a, b SET looped [TO true DEFAULT false] USING path
      if (is(index, "CYCLE")) {
        index = names(index + 1);

        if (!is(index, "SET") || !isName(index + 1)) {
          return undefined;
        }

        index += 2;

        if (is(index, "TO")) {
          index = toWord(index + 1, "DEFAULT");
          index = index < 0 ? -1 : toWord(index + 1, "USING");
        }

        if (!is(index, "USING") || !isName(index + 1)) {
          return undefined;
        }

        index += 2;
      }

      if (kinds[index] !== COMMA) {
        return { recursive, commons, end: index };
      }

      index += 1;
    }
  };

  // The statement itself is the frame `count`; a parenthesis is the frame of
  // its opening token.
  const top = count;
  const owns = new Map<number, Own>();
  const listEnds = new Map<number, number>();
  const listed = new Map<number, number>();
  const visible = new Map<string, Common[]>();
  const defined = new Map<number, string[]>();
  const bodies = new Map<number, Common>();
  // Common tables in the order their bodies close: inner ones and those a
  // body can read come first.
  const closing: Common[] = [];
  const define = (frame: number, common: Common) => {
    const scope = visible.get(common.key) ?? [];
    const keys = defined.get(frame) ?? [];

    scope.push(common);
    keys.push(common.key);
    visible.set(common.key, scope);
    defined.set(frame, keys);
  };
  const frames: number[] = [];
  let frame = top;

  for (let index = 0; index < count; index += 1) {
    const kind = kinds[index];

    if (kind === OPEN) {
      frames.push(frame);
      frame = index;
    } else if (kind === CLOSE && frame !== top) {
      for (const key of defined.get(frame) ?? []) {
        visible.get(key)!.pop();
      }

      const common = bodies.get(frame);

      frame = frames.pop()!;

      if (common) {
        closing.push(common);

        // A common table of a plain WITH list is seen after its body.
        if (!common.recursive) {
          define(frame, common);
        }
      }
    } else if (kind === WORD && index >= (listed.get(frame) ?? 0)) {
      if (is(index, "WITH")) {
        const found = list(index);

        if (found) {
          listEnds.set(index, found.end);
          listed.set(frame, found.end);

          for (const common of found.commons) {
            bodies.set(common.body, common);

            if (common.recursive) {
              define(frame, common);
            }
          }
        }
      } else if (
        !owns.has(frame) &&
        isOwnKeyword(sql, starts[index]!, ends[index]!)
      ) {
        const next = index + 1;

        if (kinds[next] === OPEN) {
          owns.set(frame, { derived: next });
        } else if (isName(next)) {
          const qualified = kinds[next + 1] === DOT && isName(next + 2);

          if (
            qualified ||
            kinds[next] === QUOTED ||
            !NOT_TABLES.has(name(next).toUpperCase())
          ) {
            const common = qualified
              ? undefined
              : visible
                  .get(keyOf(sql, starts[next]!, ends[next]!, kinds[next]!))
                  ?.at(-1);

            owns.set(
              frame,
              common
                ? { common }
                : {
                    table: qualified
                      ? `${name(next)}.${name(next + 2)}`
                      : name(next),
                  },
            );
          }
        }
      }
    }
  }

  const resolved = new Map<number, string | null>();
  const reads = new Map<number, string | null>();
  const firsts = new Map<number, string | null>();
  let depth = 0;

  /** The table a frame names itself, through derived tables and common tables. */
  const ownTable = (frame: number): string | null => {
    const known = resolved.get(frame);

    if (known !== undefined) {
      return known;
    }

    const chain = [frame];
    let own = owns.get(frame);

    while (own && "derived" in own) {
      chain.push(own.derived);
      own = owns.get(own.derived);
    }

    const table = !own
      ? null
      : "table" in own
        ? own.table
        : commonTable(own.common);

    for (const link of chain) {
      resolved.set(link, table);
    }

    return table;
  };

  /** The table a common table reads; none for a recursive one's own name. */
  const commonTable = (common: Common): string | null => {
    if (common.state === "new") {
      common.state = "naming";
      common.table = read(common.body);
      common.state = "named";
    }

    return common.state === "named" ? common.table : null;
  };

  const subquery = (open: number) =>
    is(open + 1, "SELECT") || is(open + 1, "WITH");

  /** A subquery's own table, or else the first a subquery of it reads. */
  const read = (open: number): string | null => {
    const known = reads.get(open);

    if (known !== undefined) {
      return known;
    }

    if (depth >= NESTING) {
      return null;
    }

    depth += 1;

    const table =
      ownTable(open) ?? first(open, listEnds.get(open + 1) ?? open + 1);

    depth -= 1;
    reads.set(open, table);

    return table;
  };

  /** The first table a subquery from `from` to the frame's end reads. */
  const first = (frame: number, from: number): string | null => {
    const known = firsts.get(frame);

    if (known !== undefined) {
      return known;
    }

    if (depth >= NESTING) {
      return null;
    }

    depth += 1;

    const end = frame === top ? count : closes[frame]!;
    let table: string | null = null;

    for (let index = from; index < end && table === null; index += 1) {
      if (kinds[index] === OPEN) {
        table = subquery(index) ? read(index) : first(index, index + 1);
        index = closes[index]!;
      }
    }

    depth -= 1;
    firsts.set(frame, table);

    return table;
  };

  /**
   * `SELECT (…) AS "q0", (…) q1`: a statement made only of subqueries, as a
   * `$batch()` statement is, named after its first subquery. Other statements
   * without a table of their own (`SELECT 1 WHERE EXISTS (…)`,
   * `(SELECT …) UNION (SELECT …)`) name none, as earlier versions did.
   */
  const onlySubqueries = (at: number): boolean => {
    if (!is(at, "SELECT")) {
      return false;
    }

    for (let index = at + 1; ; index += 1) {
      if (!closed(index)) {
        return false;
      }

      index = closes[index]! + 1;

      if (is(index, "AS")) {
        index += 1;

        if (!isName(index)) {
          return false;
        }
      }

      if (isName(index)) {
        index += 1;
      }

      if (index >= count || kinds[index] === SEMICOLON) {
        return true;
      }

      if (kinds[index] !== COMMA) {
        return false;
      }
    }
  };

  let operation = kinds[0] === WORD ? name(0).toUpperCase() : "QUERY";

  if (operation === "FETCH" || operation === "CLOSE" || operation === "MOVE") {
    return { operation };
  }

  // Where the query starts: after DECLARE … FOR, after EXPLAIN's options,
  // and past its WITH list.
  let query = 0;

  if (operation === "DECLARE") {
    query = count;

    for (let index = 0; index < count; index += 1) {
      if (kinds[index] === OPEN) {
        index = closes[index]!;
      } else if (is(index, "FOR")) {
        query = index + 1;
        break;
      }
    }
  } else if (operation === "EXPLAIN") {
    query = 1;

    if (kinds[1] === OPEN) {
      query = closes[1]! + 1;
    }

    while (
      is(query, "ANALYZE") ||
      is(query, "ANALYSE") ||
      is(query, "VERBOSE")
    ) {
      query += 1;
    }
  }

  const statement = listEnds.get(query) ?? query;

  // After a WITH list, the operation is the statement's own: SELECT for
  // `WITH … (SELECT …) UNION (SELECT …)`, WITH when nothing follows.
  if (operation === "WITH" && listEnds.has(0)) {
    let index = statement;

    while (kinds[index] === OPEN) {
      index += 1;
    }

    operation = kinds[index] === WORD ? name(index).toUpperCase() : "WITH";
  }

  // Named in the order their bodies close, a chain of common tables that
  // each read the one before is followed one link at a time.
  for (const common of closing) {
    commonTable(common);
  }

  const table = owns.has(top)
    ? ownTable(top)
    : onlySubqueries(statement)
      ? first(top, statement)
      : null;

  return table === null ? { operation } : { operation, table };
};

/**
 * `SELECT … FROM "users" AS …` is the operation SELECT on the table users,
 * and so is a read of a common table over users (`WITH ranked AS (SELECT …
 * FROM "users") SELECT … FROM "ranked"`). A cursor's FETCH and CLOSE name no
 * table: its name is new for every stream.
 */
const summarize = (sql: string): Summary => leading(sql) ?? analyze(sql);

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
 * A statement's span is a child of whatever span is active when it runs;
 * statements inside `$transaction` are children of its `transaction` span,
 * and those of a nested `$transaction` of its `savepoint` span.
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
