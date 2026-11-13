/**
 * Ordering on a reserved connection, shared by sessions and transactions: one
 * operation at a time in call order, and the async context that tells whether
 * a call comes from inside a nested callback that holds the connection.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type SerialQueue = {
  readonly run: <Value>(operation: () => Promise<Value>) => Promise<Value>;
};

const ignore = () => {};

/**
 * Runs each operation after the previous one settled. node-postgres
 * deprecates overlapping `client.query()` calls; Bun.SQL would pipeline them.
 */
export const createSerialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run: (operation) => {
      const result = tail.then(operation);
      tail = result.then(ignore, ignore);

      return result;
    },
  };
};

/** A nested callback (savepoint or session transaction) that holds its parent's connection. */
export type NestedFrame = { readonly parent: NestedFrame | undefined };

const frames = new AsyncLocalStorage<NestedFrame>();

/** A frame for a nested callback started from the current context. */
export const nestedFrame = (): NestedFrame => ({ parent: frames.getStore() });

/** Runs the nested operation so that calls made from its callbacks are recognised. */
export const runInFrame = <Value>(
  frame: NestedFrame,
  operation: () => Promise<Value>,
): Promise<Value> => frames.run(frame, operation);

/**
 * Whether the caller runs inside the frame. A parent operation queued behind
 * its nested callback while that callback waits for it would never run.
 */
export const callerInside = (frame: NestedFrame): boolean => {
  for (let current = frames.getStore(); current; current = current.parent) {
    if (current === frame) {
      return true;
    }
  }

  return false;
};
