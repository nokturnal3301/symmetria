/**
 * One path for Ctrl-C and SIGTERM in the CLI. Running database work is
 * cancelled first and given a few seconds to stop and roll back, so the
 * statement and its locks end with the process; open prompts close as
 * cancelled. When nothing is left to cancel, or the time is up, or a second
 * signal arrives, the terminal is restored and the process exits with 130
 * (Ctrl-C) or 143 (SIGTERM).
 */

/** How long cancelled database work gets to stop before the CLI exits anyway. */
const CANCEL_GRACE_MS = 5000;

type Code = 130 | 143;

export type Interruptible = {
  /** Stops the work; the code that started it unwinds and reports. */
  readonly cancel?: (reason: Error) => void;
  /** Puts the terminal back when the process exits before the work unwinds. */
  readonly restore?: () => void;
  /**
   * Ends the message "exited before …" when the process exits before the
   * cancelled work ends: what had not happened yet, and what that leaves
   * behind.
   */
  readonly unfinished?: () => string;
};

const entries: Interruptible[] = [];
let received: Code | undefined;

const reasonFor = (code: Code): Error =>
  new Error(code === 130 ? "symmetria: interrupted" : "symmetria: terminated");

/**
 * Restores the terminal (innermost first) and leaves at once. Cancelled work
 * that has not ended says what it leaves behind: on stdout as the JSON error
 * with --json, on stderr otherwise.
 */
const exitNow = (code: Code): never => {
  const unfinished = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.cancel
          ? [entry.unfinished?.() ?? "the cancelled work ended"]
          : [],
      ),
    ),
  ];

  for (const entry of entries.toReversed()) {
    try {
      entry.restore?.();
    } catch {
      // the next restore still runs
    }
  }

  if (unfinished.length) {
    const message = `${reasonFor(code).message}: exited before ${unfinished.join("; ")}`;

    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ error: { message } })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
  }

  process.exit(code);
};

const receive = (code: Code): void => {
  if (received !== undefined) {
    exitNow(code);
  }

  received = code;
  process.exitCode = code;
  const cancellable = entries.filter((entry) => entry.cancel);

  if (!cancellable.length) {
    exitNow(code);
  }

  const reason = reasonFor(code);

  for (const entry of cancellable) {
    entry.cancel!(reason);
  }

  // Unreferenced: a run that unwinds in time exits on its own.
  setTimeout(() => exitNow(code), CANCEL_GRACE_MS).unref();
};

const onInterrupt = () => receive(130);
const onTerminate = () => receive(143);

/**
 * Registers work or a screen for the signal path while it runs; the returned
 * function unregisters it. Work registered after a signal is cancelled at once.
 */
export const interruptible = (entry: Interruptible): (() => void) => {
  if (!entries.length) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }

  entries.push(entry);

  // After the caller has its unregister function in hand.
  if (received !== undefined && entry.cancel) {
    const reason = reasonFor(received);
    queueMicrotask(() => entry.cancel!(reason));
  }

  return () => {
    const position = entries.indexOf(entry);

    if (position >= 0) {
      entries.splice(position, 1);
    }

    if (!entries.length) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  };
};

/** Ctrl-C typed at a prompt in raw mode: the same path as a SIGINT. */
export const interrupt = (): void => receive(130);

/** 130 or 143 once Ctrl-C or SIGTERM has interrupted this run. */
export const interruption = (): Code | undefined => received;
