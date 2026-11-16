/**
 * `symmetria/voyage`: Voyage AI embedding models for `.search()`:
 * `meaning: voyage4(chunk.title, chunk.content)`. Requests go straight to
 * Voyage's HTTP API; the key is read from `VOYAGE_API_KEY` when the first
 * text is embedded, unless `voyage(model, { apiKey })` names one.
 */
import { apiKey, byIndex, inBatches, postJson } from "../embedders/http";
import { embedder } from "../schema/search";

/** Voyage accepts up to 1,000 texts per request; smaller batches keep requests under its token limit. */
const BATCH = 128;
/** The output size of the voyage-4 models unless another is asked for. */
const DEFAULT_SIZE = 1024;

export type VoyageOptions = {
  readonly apiKey?: string;
  /** Embedding length; sent to Voyage as `output_dimension` when given. */
  readonly size?: number;
  readonly baseUrl?: string;
};

export const voyage = (model: string, options: VoyageOptions = {}) =>
  embedder(
    options.size ?? DEFAULT_SIZE,
    (texts, kind) =>
      inBatches(texts, BATCH, async (input) =>
        byIndex(
          (
            await postJson<{ data: { embedding: number[]; index: number }[] }>(
              "Voyage",
              model,
              `${options.baseUrl ?? "https://api.voyageai.com/v1"}/embeddings`,
              {
                Authorization: `Bearer ${apiKey("Voyage", model, options.apiKey, "VOYAGE_API_KEY")}`,
              },
              {
                input,
                model,
                input_type: kind,
                ...(options.size !== undefined
                  ? { output_dimension: options.size }
                  : {}),
              },
            )
          ).data,
        ),
      ),
    { name: model },
  );

export const voyage4 = voyage("voyage-4");
export const voyage4Lite = voyage("voyage-4-lite");
export const voyage4Large = voyage("voyage-4-large");
