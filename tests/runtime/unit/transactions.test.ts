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
} from "../../../packages/runtime/src/driver";
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
  const base = model.records((records) => ({ id: records.id, $limit: 2 }));
  expect(
    base((records) => ({
      $forUpdate: { of: ["records"], skipLocked: true },
    })).toSQL().sql,
  ).toEndWith('LIMIT 2\nFOR UPDATE OF "records" SKIP LOCKED');
  expect(
    base((records) => ({ $forShare: { noWait: true } })).toSQL().sql,
  ).toEndWith("FOR SHARE NOWAIT");
  expect(base.toSQL().sql).not.toContain("FOR UPDATE");
  expect(() =>
    base((records) => ({ $forUpdate: { noWait: true, skipLocked: true } })),
  ).toThrow(/either/);
  expect(() =>
    base((records) => ({ $forUpdate: { of: ["missing"] } })),
  ).toThrow(/existing query aliases/);
});
