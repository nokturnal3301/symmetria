/**
 * What the ready-made embedding models share: a JSON POST with a timeout and
 * an abort signal, batches and the key.
 */

/** How long a request to a model may take, answer included, unless `timeoutMs` says otherwise. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** The longest wait a timer can count (about 24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** What every ready-made model takes besides its own options. */
export type RequestOptions = {
  /**
   * Milliseconds each request may take, answer included, before it fails
   * with an error naming the service: 60,000 unless given. A service that
   * accepts a request and never answers would otherwise hold the write, and
   * the transaction it runs in, forever.
   */
  readonly timeoutMs?: number;
  /** Aborting it fails the requests under way, such as when the application shuts down. */
  readonly signal?: AbortSignal;
};

/** The request options of a model, checked where it is declared. */
export const requestOptions = (
  model: string,
  options: RequestOptions,
): Required<Pick<RequestOptions, "timeoutMs">> &
  Pick<RequestOptions, "signal"> => {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `symmetria: ${model} timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`,
    );
  }

  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error(`symmetria: ${model} signal must be an AbortSignal`);
  }

  return { timeoutMs, ...(signal ? { signal } : {}) };
};

const seconds = (milliseconds: number): string =>
  milliseconds % 1000 ? `${milliseconds} ms` : `${milliseconds / 1000} s`;

/**
 * POSTs JSON and reads JSON; a refusal names the service, the model and what
 * it answered. A request that takes longer than `timeoutMs`, or whose
 * `signal` is aborted, fails instead of waiting.
 */
export const postJson = async <Result>(
  service: string,
  model: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: ReturnType<typeof requestOptions> = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
): Promise<Result> => {
  const { timeoutMs, signal } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const aborted = () => controller.abort(signal!.reason);

  if (signal?.aborted) {
    aborted();
  } else {
    signal?.addEventListener("abort", aborted, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `symmetria: ${service} refused to embed with ${model} (${response.status}): ${await response.text()}`,
      );
    }

    return (await response.json()) as Result;
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `symmetria: ${service} did not answer within ${seconds(timeoutMs)} when asked to embed with ${model} (timeoutMs sets how long to wait)`,
        { cause: error },
      );
    }

    if (signal?.aborted) {
      throw new Error(
        `symmetria: the request to ${service} to embed with ${model} was aborted`,
        { cause: signal.reason },
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
  }
};

/** Embeds texts a batch at a time, keeping their order. */
export const inBatches = async (
  texts: readonly string[],
  size: number,
  embed: (batch: readonly string[]) => Promise<readonly number[][]>,
): Promise<number[][]> => {
  const embeddings: number[][] = [];

  for (let start = 0; start < texts.length; start += size) {
    embeddings.push(...(await embed(texts.slice(start, start + size))));
  }

  return embeddings;
};

/** The key given, or the first of the environment variables that is set. */
export const apiKey = (
  service: string,
  model: string,
  given: string | undefined,
  ...variables: string[]
): string => {
  const key = given ?? variables.map((name) => process.env[name]).find(Boolean);

  if (!key) {
    throw new Error(
      `symmetria: ${model} needs a ${service} API key: set ${variables.join(" or ")}, or pass { apiKey }`,
    );
  }

  return key;
};

/** Rows of an OpenAI-shaped answer, which may arrive out of order. */
export const byIndex = (
  data: readonly { embedding: number[]; index: number }[],
): number[][] =>
  [...data]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
