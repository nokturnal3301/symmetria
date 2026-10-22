import { describe, expect, test } from "bun:test";
import { sqlite } from "../../../packages/runtime/src/driver";
import { queryEdgeCaseTests } from "../../support/query-edge-cases";

describe("SQLite query edge cases", () => queryEdgeCaseTests("sqlite"));

test("SQLite close drains accepted queries and transactions and rejects new work", async () => {
  const driver = sqlite();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const transaction = driver.transaction!(async (scoped) => {
    started.resolve();
    await resume.promise;

    return scoped.execute({ sql: "SELECT 1 AS value", parameters: [] });
  });
  await started.promise;
  const pending = driver.execute({ sql: "SELECT 2 AS value", parameters: [] });
  const closing = driver.close();
  await expect(
    driver.execute({ sql: "SELECT 3", parameters: [] }),
  ).rejects.toThrow(/closed/);
  await expect(driver.transaction!(async () => undefined)).rejects.toThrow(
    /closed/,
  );
  resume.resolve();
  const [transactionResult, pendingResult] = await Promise.all([
    transaction,
    pending,
    closing,
  ]);
  expect(transactionResult).toEqual({ rows: [{ value: 1n }], affectedRows: 1 });
  expect(pendingResult).toEqual({ rows: [{ value: 2n }], affectedRows: 1 });
  await expect(
    driver.execute({ sql: "SELECT 3", parameters: [] }),
  ).rejects.toThrow(/closed/);
  await driver.close();
});
