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
import { queryOccurrence } from "./plan/occurrence";
import type {
  ExecutionResult,
  QueryExecutor,
  SelectPlan,
  TableBinding,
} from "./plan/types";
import { initialPlan } from "./select/scope";

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
 * One statement for these reads, or several when they exceed what a statement
 * holds. The statement is compiled once; only when that fails is each read
 * compiled by itself, so a read that cannot run (a data error, no selected
 * fields) fails alone and the others still share a statement.
 */
const send = async (
  reads: readonly Pending[],
  executor: QueryExecutor | undefined,
): Promise<void> => {
  if (!reads.length) {
    return;
  }

  if (reads.length > MAX_READS) {
    await send(reads.slice(0, MAX_READS), executor);

    return send(reads.slice(MAX_READS), executor);
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

    // Every read compiles alone, so the failure belongs to all of them.
    if (sound.length === reads.length) {
      return rejectAll(reads, error);
    }

    return send(sound, executor);
  }

  if (parameters > MAX_PARAMETERS && reads.length > 1) {
    const half = Math.ceil(reads.length / 2);

    await send(reads.slice(0, half), executor);

    return send(reads.slice(half), executor);
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
 */
export const runBatch = async (
  executor: QueryExecutor | undefined,
  build: (collecting: QueryExecutor) => unknown,
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

  await send(pending, executor);

  const settled = await whole;

  return keyed
    ? Object.fromEntries(
        entries.map(([key], position) => [key, settled[position]]),
      )
    : settled;
};
