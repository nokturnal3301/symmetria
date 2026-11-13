/**
 * Errors about data values found while a query is built — a value a codec
 * rejects, a null for a NOT NULL column, duplicate upsert keys — fail the
 * query when it runs instead of escaping from the builder call: the build
 * records the first one, keeps going with SQL NULL in its place so errors about
 * the query's structure still throw there, and its plan carries the error to
 * compilation. `toSQL()` and `prepare()` therefore throw it, and executing the
 * query rejects with it.
 */

/** The first data error of a build, kept on its plan. */
export type DeferredError = { readonly error: unknown };

type Frame = { failure?: DeferredError };

let current: Frame | undefined;

/**
 * Runs a synchronous build and returns its result with the first data error it
 * recorded. A nested build's error also fails the build around it, unless
 * `propagate` is false: `$scope()` callbacks run again, with current values,
 * at every execution, so a failure while building says nothing about it.
 */
export const collectDataErrors = <Result>(
  build: () => Result,
  propagate = true,
): [Result, DeferredError | undefined] => {
  const outer = current;
  const frame: Frame = {};
  current = frame;

  try {
    const result = build();

    if (propagate && outer && frame.failure) {
      outer.failure ??= frame.failure;
    }

    return [result, frame.failure];
  } finally {
    current = outer;
  }
};

/** Records a data error for the build in progress, or throws it outside one. */
export const dataError = (error: unknown): void => {
  if (!current) {
    throw error;
  }

  current.failure ??= { error };
};

/** Runs code that must throw data errors itself, such as binding values at execution. */
export const throwDataErrors = <Result>(run: () => Result): Result => {
  if (!current) {
    return run();
  }

  const outer = current;
  current = undefined;

  try {
    return run();
  } finally {
    current = outer;
  }
};
