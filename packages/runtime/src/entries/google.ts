/**
 * `symmetria/google`: Google Gemini embedding models for `.search()`:
 * `meaning: geminiEmbedding(chunk.title, chunk.content)`. The key is read
 * from `GEMINI_API_KEY` or `GOOGLE_API_KEY` unless given.
 */
import {
  apiKey,
  inBatches,
  postJson,
  requestOptions,
  type RequestOptions,
} from "../embedders/http";
import { embedder } from "../schema/search";

/** `batchEmbedContents` takes at most 100 texts. */
const BATCH = 100;
/**
 * gemini-embedding-001 has 3,072 numbers of its own, more than pgvector
 * indexes (2,000); it is asked for 1,536, a length it is trained to shorten to.
 */
const DEFAULT_SIZE = 1536;

export type GoogleOptions = RequestOptions & {
  readonly apiKey?: string;
  /** Embedding length; sent as `outputDimensionality`. */
  readonly size?: number;
  readonly baseUrl?: string;
};

export const google = (model: string, options: GoogleOptions = {}) => {
  const size = options.size ?? DEFAULT_SIZE;
  const request = requestOptions(model, options);

  return embedder(
    size,
    (texts, kind) =>
      inBatches(texts, BATCH, async (batch) =>
        (
          await postJson<{ embeddings: { values: number[] }[] }>(
            "Google",
            model,
            `${options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"}/models/${model}:batchEmbedContents`,
            {
              "x-goog-api-key": apiKey(
                "Google",
                model,
                options.apiKey,
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
              ),
            },
            {
              requests: batch.map((text) => ({
                model: `models/${model}`,
                content: { parts: [{ text }] },
                taskType:
                  kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
                outputDimensionality: size,
              })),
            },
            request,
          )
        ).embeddings.map((embedding) => embedding.values),
      ),
    { name: model },
  );
};

export const geminiEmbedding = google("gemini-embedding-001");
