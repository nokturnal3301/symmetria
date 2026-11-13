import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  index,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import type {
  Driver,
  TransactionDriver,
} from "../../../packages/runtime/src/entries/driver";
import { transactionOptionsSQL } from "../../../packages/runtime/src/driver/transactions";

test("transaction views route queries through the scoped driver and retain inferred results", async () => {
  const rootCalls: CompiledQuery[] = [];
  const scopedCalls: CompiledQuery[] = [];
  const nestedCalls: CompiledQuery[] = [];
  const nestedDriver: TransactionDriver = {
    execute: async (query) => {
      nestedCalls.push(query);

      return [{ name: "Nested" }];
    },
    transaction: async (callback) => callback(nestedDriver),
  };
  const scopedDriver: TransactionDriver = {
    execute: async (query) => {
      scopedCalls.push(query);

      return [{ name: "Scoped" }];
    },
    transaction: async (callback) => callback(nestedDriver),
  };
  const driver: Driver = {
    execute: async (query) => {
      rootCalls.push(query);

      return [];
    },
    transaction: async (callback) => callback(scopedDriver),
    close: async () => {},
  };
  const model = schema(
    { records: { id: int.auto, name: text } },
    { driver, indexes: ({ records }) => ({ byName: index(records.name) }) },
  );
  const result = await model.$transaction(async (transaction) => {
    const rows = await transaction
      .records((records) => ({ name: records.name }))
      .execute();
    const nested = await transaction.$transaction(async (savepoint) =>
      savepoint.records((records) => ({ name: records.name })).execute(),
    );
    await transaction.$createIndexes().execute();
    expect(transaction.$snapshot()).toEqual(model.$snapshot());
    // @ts-expect-error PostgreSQL disallows concurrent index creation in transactions
    expect(() => transaction.$createIndexes({ concurrently: true })).toThrow(
      /CONCURRENTLY/,
    );
    expect("$close" in transaction).toBe(false);

    return { rows, nested };
  });
  expect(result).toEqual({
    rows: [{ name: "Scoped" }],
    nested: [{ name: "Nested" }],
  });
  expect(rootCalls).toHaveLength(0);
  expect(scopedCalls).toHaveLength(2);
  expect(nestedCalls).toHaveLength(1);
  type Expect<Condition extends true> = Condition;
  type InferredResult = Expect<
    typeof result.rows extends { name: string }[] ? true : false
  >;
});

test("executor-only schemas cannot silently emulate transactions", async () => {
  const model = schema({ records: { id: int } }, { executor: async () => [] });
  await expect(model.$transaction(async () => 1)).rejects.toThrow(
    /does not support transactions/,
  );
});

test("transaction options are whitelisted and DEFERRABLE requires serializable read-only", () => {
  expect(
    transactionOptionsSQL({
      isolationLevel: "serializable",
      readOnly: true,
      deferrable: true,
    }),
  ).toBe("ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE");
  expect(transactionOptionsSQL()).toBe("");
  expect(() => transactionOptionsSQL({ deferrable: true })).toThrow(
    /SERIALIZABLE READ ONLY/,
  );
  expect(() =>
    // @ts-expect-error arbitrary SQL is not an isolation level
    transactionOptionsSQL({ isolationLevel: "read committed; COMMIT" }),
  ).toThrow(/isolation level/);
});

test("row locks use typed aliases, compose with pagination and preserve query branches", () => {
  const model = schema({ records: { id: int, name: text } });
  const base = model.records((records) => ({ id: records.id }), { limit: 2 });
  expect(
    base({ forUpdate: { of: ["records"], skipLocked: true } }).toSQL().sql,
  ).toEndWith('LIMIT 2\nFOR UPDATE OF "records" SKIP LOCKED');
  expect(base({ forShare: { noWait: true } }).toSQL().sql).toEndWith(
    "FOR SHARE NOWAIT",
  );
  expect(base.toSQL().sql).not.toContain("FOR UPDATE");
  expect(() => base({ forUpdate: { noWait: true, skipLocked: true } })).toThrow(
    /either/,
  );
  expect(() => base({ forUpdate: { of: ["missing"] } })).toThrow(
    /existing query aliases/,
  );
});

test("transactions retry serialization failures and deadlocks, nothing else", async () => {
  const attempts: unknown[] = [];
  const make = (failures: unknown[]) => {
    let calls = 0;
    const driver: Driver = {
      execute: async () => [],
      close: async () => {},
      transaction: async (callback, options) => {
        attempts.push(options);
        const failure = failures[calls++];

        if (failure) {
          throw failure;
        }

        return callback({
          execute: async () => [{ ok: true }],
          transaction: async (nested) =>
            nested({
              execute: async () => [],
              transaction: async () => {
                throw new Error("unused");
              },
            }),
        });
      },
    };

    return { driver, calls: () => calls };
  };
  const serialization = Object.assign(new Error("conflict"), { code: "40001" });
  const deadlock = Object.assign(new Error("deadlock"), { errno: "40P01" });
  const unique = Object.assign(new Error("duplicate"), { code: "23505" });

  const retried = make([serialization, deadlock]);
  const database = schema({ users: { id: int } }, { driver: retried.driver });
  const originalRandom = Math.random;
  Math.random = () => 1;
  const started = performance.now();

  try {
    expect(
      await database.$transaction(async () => "done", {
        retries: 3,
        retryDelayMs: 5,
        isolationLevel: "serializable",
      }),
    ).toBe("done");
  } finally {
    Math.random = originalRandom;
  }

  expect(retried.calls()).toBe(3);
  // Retry settings never reach the driver; the transaction options do.
  expect(attempts[0]).toEqual({ isolationLevel: "serializable" });
  expect(performance.now() - started).toBeGreaterThanOrEqual(5 + 10 - 2);

  const exhausted = make([serialization, serialization]);
  await expect(
    schema({ users: { id: int } }, { driver: exhausted.driver }).$transaction(
      async () => "never",
      { retries: 1, retryDelayMs: 0 },
    ),
  ).rejects.toBe(serialization);
  expect(exhausted.calls()).toBe(2);

  const other = make([unique]);
  await expect(
    schema({ users: { id: int } }, { driver: other.driver }).$transaction(
      async () => "never",
      { retries: 5, retryDelayMs: 0 },
    ),
  ).rejects.toBe(unique);
  expect(other.calls()).toBe(1);

  const plain = make([serialization]);
  await expect(
    schema({ users: { id: int } }, { driver: plain.driver }).$transaction(
      async () => "never",
    ),
  ).rejects.toBe(serialization);
  expect(plain.calls()).toBe(1);

  await expect(
    schema({ users: { id: int } }, { driver: plain.driver }).$transaction(
      async () => "never",
      { retries: 25 },
    ),
  ).rejects.toThrow(/between 0 and 20/);
  await expect(
    schema({ users: { id: int } }, { driver: plain.driver }).$transaction(
      async () => "never",
      { retryDelayMs: -1 },
    ),
  ).rejects.toThrow(/non-negative/);
});

test("retry waits double up to a second, or retryDelayMs when it is longer", async () => {
  const serialization = Object.assign(new Error("conflict"), { code: "40001" });
  const conflicting = (failures: number): Driver => {
    let calls = 0;

    return {
      execute: async () => [],
      close: async () => {},
      transaction: async (callback) => {
        if (calls++ < failures) {
          throw serialization;
        }

        return callback({
          execute: async () => [],
          transaction: async () => {
            throw new Error("unused");
          },
        });
      },
    };
  };
  const waits: number[] = [];
  const originalRandom = Math.random;
  const originalTimeout = globalThis.setTimeout;
  Math.random = () => 1;
  // Record each wait and continue at once.
  globalThis.setTimeout = ((resolve: () => void, delay: number) => {
    waits.push(delay);

    return originalTimeout(resolve, 0);
  }) as typeof setTimeout;

  try {
    for (const retryDelayMs of [10, 3000]) {
      await schema(
        { users: { id: int } },
        { driver: conflicting(20) },
      ).$transaction(async () => "done", { retries: 20, retryDelayMs });
    }
  } finally {
    Math.random = originalRandom;
    globalThis.setTimeout = originalTimeout;
  }

  expect(waits.slice(0, 20)).toEqual([
    10,
    20,
    40,
    80,
    160,
    320,
    640,
    ...Array(13).fill(1000),
  ]);
  expect(waits.slice(20)).toEqual(Array(20).fill(3000));
});
