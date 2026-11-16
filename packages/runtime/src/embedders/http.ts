/** What the ready-made embedding models share: a JSON POST, batches and the key. */

/** POSTs JSON and reads JSON; a refusal names the service, the model and what it answered. */
export const postJson = async <Result>(
  service: string,
  model: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Result> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `symmetria: ${service} refused to embed with ${model} (${response.status}): ${await response.text()}`,
    );
  }

  return (await response.json()) as Result;
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
