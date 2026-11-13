/**
 * Errors about data values surface when a query runs: building it succeeds,
 * `toSQL()` throws, and executing it, awaiting it or calling `then()` rejects,
 * so `.catch()` handlers see the error instead of an exception escaping.
 */
import { expect } from "bun:test";

type Runnable = PromiseLike<unknown> & {
  readonly execute: () => Promise<unknown>;
  readonly toSQL?: () => unknown;
};

export const expectDataError = async (
  build: () => Runnable,
  message: RegExp,
  code?: string,
): Promise<void> => {
  const matches = (error: unknown) => {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);

    if (code) {
      expect((error as { code?: unknown }).code).toBe(code);
    }
  };
  const query = build();

  if (query.toSQL) {
    let thrown: unknown;

    try {
      query.toSQL();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    matches(thrown);
  }

  matches(await query.execute().catch((error: unknown) => error));
  matches(await Promise.resolve(query).catch((error: unknown) => error));

  let rejected: unknown;
  await query.then(undefined, (error: unknown) => {
    rejected = error;
  });
  matches(rejected);
};
