/**
 * `symmetria/jina`: Jina AI embedding models for `.search()`:
 * `meaning: jinaV3(chunk.title, chunk.content)`. The key is read from
 * `JINA_API_KEY` unless given.
 */
import { apiKey, byIndex, inBatches, postJson } from "../embedders/http";
import { embedder } from "../schema/search";

const BATCH = 128;

export type JinaOptions = {
  readonly apiKey?: string;
  /** Embedding length; sent as `dimensions` when given. */
  readonly size?: number;
  readonly baseUrl?: string;
};

export const jina = (model: string, options: JinaOptions = {}) =>
  embedder(
    options.size ?? 1024,
    (texts, kind) =>
      inBatches(texts, BATCH, async (input) =>
        byIndex(
          (
            await postJson<{ data: { embedding: number[]; index: number }[] }>(
              "Jina",
              model,
              `${options.baseUrl ?? "https://api.jina.ai/v1"}/embeddings`,
              {
                Authorization: `Bearer ${apiKey("Jina", model, options.apiKey, "JINA_API_KEY")}`,
              },
              {
                input,
                model,
                task:
                  kind === "query" ? "retrieval.query" : "retrieval.passage",
                ...(options.size !== undefined
                  ? { dimensions: options.size }
                  : {}),
              },
            )
          ).data,
        ),
      ),
    { name: model },
  );

export const jinaV3 = jina("jina-embeddings-v3");
