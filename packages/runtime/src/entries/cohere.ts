/**
 * `symmetria/cohere`: Cohere embedding models for `.search()`:
 * `meaning: embedV4(chunk.title, chunk.content)`. The key is read from
 * `COHERE_API_KEY` unless given.
 */
import {
  apiKey,
  inBatches,
  postJson,
  requestOptions,
  type RequestOptions,
} from "../embedders/http";
import { embedder } from "../schema/search";

/** Cohere embeds at most 96 texts per request. */
const BATCH = 96;
/** Lengths of the models that have one; embed-v4.0 is asked for its length. */
const SIZES: Readonly<Record<string, number>> = {
  "embed-v4.0": 1536,
  "embed-multilingual-v3.0": 1024,
  "embed-english-v3.0": 1024,
  "embed-multilingual-light-v3.0": 384,
  "embed-english-light-v3.0": 384,
};

export type CohereOptions = RequestOptions & {
  readonly apiKey?: string;
  /** Embedding length; sent as `output_dimension`, which embed-v4.0 accepts. */
  readonly size?: number;
  readonly baseUrl?: string;
};

export const cohere = (model: string, options: CohereOptions = {}) => {
  const size = options.size ?? SIZES[model];

  if (size === undefined) {
    throw new Error(
      `symmetria: the embedding length of "${model}" is not known; pass cohere("${model}", { size })`,
    );
  }

  const request = requestOptions(model, options);

  return embedder(
    size,
    (texts, kind) =>
      inBatches(
        texts,
        BATCH,
        async (batch) =>
          (
            await postJson<{ embeddings: { float: number[][] } }>(
              "Cohere",
              model,
              `${options.baseUrl ?? "https://api.cohere.com/v2"}/embed`,
              {
                Authorization: `Bearer ${apiKey("Cohere", model, options.apiKey, "COHERE_API_KEY")}`,
              },
              {
                model,
                texts: batch,
                input_type:
                  kind === "query" ? "search_query" : "search_document",
                embedding_types: ["float"],
                ...(options.size !== undefined || model === "embed-v4.0"
                  ? { output_dimension: size }
                  : {}),
              },
              request,
            )
          ).embeddings.float,
      ),
    { name: model },
  );
};

export const embedV4 = cohere("embed-v4.0");
export const embedMultilingualV3 = cohere("embed-multilingual-v3.0");
