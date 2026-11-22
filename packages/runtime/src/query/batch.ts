/**
 * `$batch()`: several reads sent as one statement. Each read becomes a JSON
 * subquery of a single SELECT, the way a nested query in a projection is
 * rendered, so the batch costs one round trip on any driver, sees one
 * snapshot of the data and works inside a transaction.
 */
import { jsonRowCodec } from "./codecs/json";
import { compilePlan, executePlan } from "./compile";
import { batchCollectors } from "./plan/batching";
import { freeze } from "./plan/freeze";
import { queryOccurrence, rebindPlan } from "./plan/occurrence";
import type {
  CommonTableExpression,
  ExecutionResult,
  QueryExecutor,
  SelectPlan,
  TableBinding,
} from "./plan/types";
import { initialPlan } from "./select/scope";
import { deferredRead } from "./select/terminal";

/** The batch statement selects from nothing; its plan still names a root. */
const BATCH_ROOT: TableBinding = freeze({
  table: freeze({
    name: "__symmetria_batch",
    sqlName: "__symmetria_batch",
    junction: false,
    columns: [],
    relations: [],
  }),
  alias: "__symmetria_batch",
  codecs: freeze({}),
});

type Pending = {
  readonly plan: SelectPlan;
  readonly resolve: (result: ExecutionResult) => void;
  readonly reject: (error: unknown) => void;
};

const batchPlan = (pending: readonly Pending[]): SelectPlan =>
  freeze({
    ...initialPlan(BATCH_ROOT),
    rootless: true as const,
    selection: freeze(
      pending.map(({ plan }, position) => {
        // Two reads of one table are two occurrences of it in the statement.
        const query = queryOccurrence(plan);

        return freeze({
          outputName: `q${position}`,
          node: freeze({ kind: "jsonRows" as const, query, many: true }),
          codec: jsonRowCodec(query.selection, true),
        });
      }),
    ),
  });

/** What a write, a row lock, a stream or a transaction started on a batch's handle fails with. */
export const readsOnly = (): Error =>
  new Error(
    "symmetria: $batch() sends reads as one statement; a write, a row lock, a stream or a transaction cannot be part of it, run it outside the batch",
  );

/** PostgreSQL allows 1,664 fields in a SELECT and 65,535 bound values in a statement. */
const MAX_READS = 1000;
const MAX_PARAMETERS = 65535;

const rejectAll = (reads: readonly Pending[], error: unknown): void => {
  for (const read of reads) {
    read.reject(error);
  }
};

/**
 * The CTEs a plan defines, by identity, also those inside other CTEs, and
 * every name of a table, alias or CTE it uses.
 */
const commonTablesOf = (
  plan: SelectPlan,
  found = new Map<object, CommonTableExpression>(),
  names = new Set<string>(),
): Map<object, CommonTableExpression> => {
  rebindPlan(plan, (binding) => {
    const definition = binding.cte;

    names.add(binding.alias);
    names.add(binding.cteReference?.name ?? binding.table.sqlName);

    if (definition && !found.has(definition.identity)) {
      found.set(definition.identity, definition);
      commonTablesOf(definition.query, found, names);

      if (definition.recursive) {
        commonTablesOf(definition.recursive, found, names);
      }
    }

    return undefined;
  });

  return found;
};

/**
 * A value as text that tells apart every value a statement can bind: NaN,
 * the infinities and -0, bigint, dates, bytes, undefined and null, and the
 * shape of arrays and objects. Undefined for anything else, which makes two
 * CTEs count as different, the safe side.
 */
const exactly = (value: unknown): string | undefined => {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : `n${value}`;
    case "bigint":
      return `b${value}`;
    case "boolean":
      return `${value}`;
    case "undefined":
      return "u";
    case "object": {
      if (value === null) {
        return "null";
      }

      if (value instanceof Date) {
        return `d${value.getTime()}`;
      }

      if (ArrayBuffer.isView(value)) {
        return `x${value.constructor.name}(${new Uint8Array(value.buffer, value.byteOffset, value.byteLength).join(",")})`;
      }

      const prototype = Object.getPrototypeOf(value);
      const entries = Array.isArray(value)
        ? value.map((item) => exactly(item))
        : prototype === Object.prototype || prototype === null
          ? Object.entries(value).map(([key, item]) => {
              const text = exactly(item);

              return text === undefined
                ? undefined
                : `${JSON.stringify(key)}:${text}`;
            })
          : [undefined];

      return entries.includes(undefined)
        ? undefined
        : Array.isArray(value)
          ? `[${entries.join(",")}]`
          : `{${entries.join(",")}}`;
    }
    default:
      return undefined;
  }
};

/** What two CTEs of one name must share to be one: their SQL and its values. */
const definitionKey = (
  definition: CommonTableExpression,
): string | undefined => {
  try {
    const query = compilePlan(definition.query);
    const recursive = definition.recursive
      ? compilePlan(definition.recursive)
      : undefined;
    const values = exactly([
      query.parameters,
      recursive?.parameters ?? null,
      definition.materialized ?? null,
      definition.unionAll ?? null,
    ]);

    return values === undefined
      ? undefined
      : `${query.sql}\0${recursive?.sql ?? ""}\0${values}`;
  } catch {
    // A recursive term does not compile by itself; such a CTE is renamed.
    return undefined;
  }
};

/** The schema's tables, whose names a renamed CTE must not take. */
type Tables = readonly { readonly sqlName: string }[];

/** PostgreSQL cuts longer identifiers, and Symmetria refuses them. */
const MAX_IDENTIFIER_BYTES = 63;
const utf8 = new TextEncoder();

/** `name_2`: the name with a number, shortened to stay a valid identifier. */
const numberedName = (name: string, ordinal: number): string => {
  const suffix = `_${ordinal}`;
  const characters = [...name];

  while (
    characters.length &&
    utf8.encode(characters.join("")).length + suffix.length >
      MAX_IDENTIFIER_BYTES
  ) {
    characters.pop();
  }

  return `${characters.join("")}${suffix}`;
};

/**
 * The reads with the CTEs they define under one name made one statement's
 * worth, as a helper called once per read defines them: an identical CTE is
 * shared, a different one gets its own name in the statement (the alias the
 * read sees stays). Undefined when no names collide.
 */
const mergedCommonTables = (
  reads: readonly Pending[],
  tables: Tables,
): Pending[] | undefined => {
  const byName = new Map<string, CommonTableExpression[]>();
  // A new name must not be one the statement uses already, nor a table's.
  const used = new Set<string>(tables.map((table) => table.sqlName));

  for (const read of reads) {
    for (const definition of commonTablesOf(
      read.plan,
      undefined,
      used,
    ).values()) {
      const named = byName.get(definition.name) ?? [];

      if (!named.some((other) => other.identity === definition.identity)) {
        named.push(definition);
      }

      byName.set(definition.name, named);
    }
  }

  // Compared without case, as raw SQL that names a table unquoted is read.
  const taken = new Set([...used].map((name) => name.toLowerCase()));
  // The reads' own SQL, raw fragments included: a table named only there
  // must not be hidden by a CTE either.
  const texts = reads.map((read) => {
    try {
      return compilePlan(read.plan).sql.toLowerCase();
    } catch {
      return "";
    }
  });
  const freeName = (name: string, from: number): string | undefined => {
    for (let ordinal = from; ordinal < from + 1000; ordinal += 1) {
      const candidate = numberedName(name, ordinal);
      const lower = candidate.toLowerCase();

      if (!taken.has(lower) && !texts.some((text) => text.includes(lower))) {
        return candidate;
      }
    }

    return undefined;
  };

  // Each CTE's group leader: the first of its name with the same definition.
  const leaders = new Map<object, CommonTableExpression>();
  // What a leader is called in the statement: its own name, or a new one.
  const names = new Map<object, { name: string; identity: object }>();

  for (const [name, named] of byName) {
    const kept: {
      key: string | undefined;
      definition: CommonTableExpression;
    }[] = [];

    for (const definition of named) {
      const key = named.length > 1 ? definitionKey(definition) : undefined;
      const same =
        key === undefined ? undefined : kept.find((entry) => entry.key === key);

      if (same) {
        leaders.set(definition.identity, same.definition);
        continue;
      }

      leaders.set(definition.identity, definition);

      if (kept.length) {
        const next = freeName(name, kept.length + 1);

        // No name to give it: the statement stays as it was.
        if (next === undefined) {
          return undefined;
        }

        taken.add(next.toLowerCase());
        names.set(definition.identity, { name: next, identity: freeze({}) });
      }

      kept.push({ key, definition });
    }
  }

  if (
    ![...leaders].some(
      ([identity, leader]) =>
        leader.identity !== identity || names.has(identity),
    )
  ) {
    return undefined;
  }

  const target = (identity: object) => {
    const leader = leaders.get(identity);

    return leader
      ? (names.get(leader.identity) ?? {
          name: leader.name,
          identity: leader.identity,
        })
      : undefined;
  };
  // One replacement per binding and per CTE, so every reference to a source
  // stays the same object, as the compiler expects. Every CTE body is
  // rewritten too, since it may read a CTE that was renamed or shared.
  const bindings = new Map<TableBinding, TableBinding>();
  const definitions = new Map<object, CommonTableExpression>();
  const definitionOf = (identity: object): CommonTableExpression => {
    const leader = leaders.get(identity)!;
    const { name, identity: key } = target(identity)!;
    let definition = definitions.get(key);

    if (!definition) {
      definition = freeze({
        ...leader,
        name,
        identity: key,
        query: rewrite(leader.query),
        ...(leader.recursive ? { recursive: rewrite(leader.recursive) } : {}),
      });
      definitions.set(key, definition);
    }

    return definition;
  };
  const replace = (binding: TableBinding): TableBinding | undefined => {
    const reference = binding.cteReference;
    const renamed = reference && target(reference.identity);

    if (
      !reference ||
      !renamed ||
      (!binding.cte && renamed.identity === reference.identity)
    ) {
      return undefined;
    }

    let replaced = bindings.get(binding);

    if (!replaced) {
      replaced = freeze({
        ...binding,
        // A recursive term names its own CTE before that CTE is rebuilt.
        cteReference: freeze({
          name: renamed.name,
          identity: renamed.identity,
        }),
        ...(binding.cte ? { cte: definitionOf(reference.identity) } : {}),
      });
      bindings.set(binding, replaced);
    }

    return replaced;
  };
  const rewrite = (plan: SelectPlan): SelectPlan => rebindPlan(plan, replace);

  return reads.map((read) => ({ ...read, plan: rewrite(read.plan) }));
};

/**
 * One statement for these reads, or several when they exceed what a statement
 * holds. The statement is compiled once; only when that fails is each read
 * compiled by itself, so a read that cannot run (a data error, no selected
 * fields) fails alone and the others still share a statement.
 */
const send = async (
  reads: readonly Pending[],
  executor: QueryExecutor | undefined,
  tables: Tables,
): Promise<void> => {
  if (!reads.length) {
    return;
  }

  if (reads.length > MAX_READS) {
    await send(reads.slice(0, MAX_READS), executor, tables);

    return send(reads.slice(MAX_READS), executor, tables);
  }

  const plan = batchPlan(reads);
  let parameters: number;

  try {
    parameters = compilePlan(plan).parameters.length;
  } catch (error) {
    const sound = reads.filter((read) => {
      try {
        compilePlan(read.plan);

        return true;
      } catch (own) {
        read.reject(own);

        return false;
      }
    });

    // Every read compiles alone, so they only fail together, as two reads
    // that each define a CTE of one name do: the names are made one
    // statement's worth, so the batch still reads one snapshot.
    if (sound.length === reads.length) {
      if (reads.length === 1) {
        return rejectAll(reads, error);
      }

      const merged = mergedCommonTables(reads, tables);

      if (merged) {
        return send(merged, executor, tables);
      }

      // Nothing known to merge: as a last resort, separate statements.
      const half = Math.ceil(reads.length / 2);

      await send(reads.slice(0, half), executor, tables);

      return send(reads.slice(half), executor, tables);
    }

    return send(sound, executor, tables);
  }

  if (parameters > MAX_PARAMETERS && reads.length > 1) {
    const half = Math.ceil(reads.length / 2);

    await send(reads.slice(0, half), executor, tables);

    return send(reads.slice(half), executor, tables);
  }

  try {
    // The plan is compiled already; this call reuses it.
    const { rows } = await executePlan(plan, executor);

    reads.forEach((read, position) => {
      const result = rows[0]![`q${position}`] as Record<string, unknown>[];

      read.resolve({ rows: result, affectedRows: result.length });
    });
  } catch (error) {
    rejectAll(reads, error);
  }
};

/**
 * Runs `build` with an executor that collects the reads started while it
 * runs, sends them as one statement and settles each read with its own rows.
 * Like the reads in it, the batch starts when it is awaited, so a batch in
 * `Promise.all([write, batch])` inside a transaction sees the write.
 */
export const runBatch = (
  executor: QueryExecutor | undefined,
  build: (collecting: QueryExecutor) => unknown,
  tables: Tables = [],
): Promise<unknown> =>
  deferredRead(() => collectBatch(executor, build, tables), executor);

const collectBatch = async (
  executor: QueryExecutor | undefined,
  build: (collecting: QueryExecutor) => unknown,
  tables: Tables,
): Promise<unknown> => {
  const pending: Pending[] = [];
  let open = true;

  const collecting: QueryExecutor = (query) => {
    if (open) {
      return Promise.reject(readsOnly());
    }

    // After the batch has run, its database handle works like the original.
    return executor
      ? executor(query)
      : Promise.reject(
          new Error(
            "symmetria: configure a query executor or driver before calling execute()",
          ),
        );
  };

  batchCollectors.set(collecting, {
    add: (plan) => {
      if (!open || plan.locking) {
        return undefined;
      }

      return new Promise<ExecutionResult>((resolve, reject) => {
        pending.push({ plan, resolve, reject });
      });
    },
  });

  let built: unknown;

  try {
    built = build(collecting);
  } catch (error) {
    open = false;

    for (const read of pending) {
      read.reject(error);
    }

    throw error;
  }

  const keyed =
    !!built &&
    typeof built === "object" &&
    !Array.isArray(built) &&
    Object.getPrototypeOf(built) === Object.prototype;

  if (!Array.isArray(built) && !keyed) {
    open = false;

    // An async callback: its own promise fails with the reads it awaited.
    if (typeof (built as PromiseLike<unknown> | null)?.then === "function") {
      (built as PromiseLike<unknown>).then(undefined, () => {});
    }

    const error = new Error(
      "symmetria: a $batch() callback returns its reads at once, as an array or an object: db.$batch((db) => [db.users.get(1), db.posts.count()])",
    );

    for (const read of pending) {
      read.reject(error);
    }

    throw error;
  }

  const entries = Object.entries(built as Record<string, unknown>);
  // A query that was not awaited starts here, while the batch is still open.
  const results = entries.map(([, value]) =>
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
      ? new Promise((resolve, reject) => {
          (value as PromiseLike<unknown>).then(resolve, reject);
        })
      : value,
  );

  open = false;

  // Awaited from the start: a read may fail before its statement is sent.
  const whole = Promise.all(results);

  whole.catch(() => {});

  await send(pending, executor, tables);

  const settled = await whole;

  return keyed
    ? Object.fromEntries(
        entries.map(([key], position) => [key, settled[position]]),
      )
    : settled;
};
