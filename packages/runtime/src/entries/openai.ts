/**
 * `symmetria/openai`: OpenAI embedding models for `.search()`:
 * `meaning: textEmbedding3Small(chunk.title, chunk.content)`. The key is read
 * from `OPENAI_API_KEY` unless given. `baseUrl` points the same requests at
 * any server that speaks OpenAI's embeddings API (LM Studio, vLLM, a gateway).
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

const BATCH = 128;
/**
 * Both text-embedding-3 models are asked for 1,536 numbers: the large one's
 * own 3,072 are more than pgvector indexes (2,000).
 */
const DEFAULT_SIZE = 1536;

export type OpenAIOptions = RequestOptions & {
  readonly apiKey?: string;
  /** Embedding length; sent as `dimensions`, which text-embedding-3 models accept. */
  readonly size?: number;
  readonly baseUrl?: string;
};

export const openai = (model: string, options: OpenAIOptions = {}) => {
  const size = options.size ?? DEFAULT_SIZE;
  // Older and third-party models have one length and refuse the parameter.
  const sized = options.size !== undefined || /^text-embedding-3/.test(model);

  const request = requestOptions(model, options);

  return embedder(
    size,
    (texts) =>
      inBatches(texts, BATCH, async (input) =>
        byIndex(
          (
            await postJson<{ data: { embedding: number[]; index: number }[] }>(
              "OpenAI",
              model,
              `${options.baseUrl ?? "https://api.openai.com/v1"}/embeddings`,
              {
                Authorization: `Bearer ${apiKey("OpenAI", model, options.apiKey, "OPENAI_API_KEY")}`,
              },
              {
                input,
                model,
                encoding_format: "float",
                ...(sized ? { dimensions: size } : {}),
              },
              request,
            )
          ).data,
        ),
      ),
    { name: model },
  );
};

export const textEmbedding3Small = openai("text-embedding-3-small");
export const textEmbedding3Large = openai("text-embedding-3-large");
