/**
 * `symmetria/mistral`: Mistral's embedding model for `.search()`:
 * `meaning: mistralEmbed(chunk.title, chunk.content)`. The key is read from
 * `MISTRAL_API_KEY` unless given.
 */
import {
  apiKey,
  byIndex,
  inBatches,
  postJson,
  requestOptions,
  type RequestOptions,
} from "../embedders/http";
import { embedder } from "../schema/search";

const BATCH = 64;

export type MistralOptions = RequestOptions & {
  readonly apiKey?: string;
  /** Embedding length of the model; `mistral-embed` has 1,024. */
  readonly size?: number;
  readonly baseUrl?: string;
};

export const mistral = (model: string, options: MistralOptions = {}) => {
  const request = requestOptions(model, options);

  return embedder(
    options.size ?? 1024,
    (texts) =>
      inBatches(texts, BATCH, async (input) =>
        byIndex(
          (
            await postJson<{ data: { embedding: number[]; index: number }[] }>(
              "Mistral",
              model,
              `${options.baseUrl ?? "https://api.mistral.ai/v1"}/embeddings`,
              {
                Authorization: `Bearer ${apiKey("Mistral", model, options.apiKey, "MISTRAL_API_KEY")}`,
              },
              { input, model },
              request,
            )
          ).data,
        ),
      ),
    { name: model },
  );
};

export const mistralEmbed = mistral("mistral-embed");
