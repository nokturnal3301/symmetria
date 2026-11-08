/**
 * In-flight promise tracking shared by the pool, sessions and transactions:
 * a scope settles everything it started before it closes or releases its
 * connection, and rejections are observed so they never surface as unhandled.
 */
type PendingTasks = {
  readonly track: <Value>(task: Promise<Value>) => Promise<Value>;
  readonly size: () => number;
  /** Resolves once every tracked task has settled; never rejects. */
  readonly settle: () => Promise<void>;
};

export const createPendingTasks = (): PendingTasks => {
  const pending = new Set<Promise<unknown>>();

  return {
    track: (task) => {
      pending.add(task);

      const done = () => {
        pending.delete(task);
      };

      void task.then(done, done);

      return task;
    },
    size: () => pending.size,
    settle: async () => {
      await Promise.allSettled([...pending]);
    },
  };
};
