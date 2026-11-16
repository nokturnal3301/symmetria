/**
 * `symmetria/ollama`: embedding models served by a local Ollama for
 * `.search()`: `meaning: ollama("bge-m3")(chunk.title, chunk.content)`.
 * Nothing leaves the machine and there is no key.
 */
import { postJson } from "../embedders/http";
import { embedder } from "../schema/search";

/** Embedding lengths of the models Ollama's library lists most often. */
const SIZES: Readonly<Record<string, number>> = {
  "bge-m3": 1024,
  "mxbai-embed-large": 1024,
  "nomic-embed-text": 768,
  "all-minilm": 384,
};

export type OllamaOptions = {
  /** Embedding length; required for a model this module does not know. */
  readonly size?: number;
  /** Where Ollama listens; `OLLAMA_HOST` or `http://localhost:11434` otherwise. */
  readonly baseUrl?: string;
};

export const ollama = (model: string, options: OllamaOptions = {}) => {
  const size = options.size ?? SIZES[model.split(":")[0]!];

  if (size === undefined) {
    throw new Error(
      `symmetria: the embedding length of "${model}" is not known; pass ollama("${model}", { size })`,
    );
  }

  return embedder(
    size,
    async (texts) => {
      const host =
        options.baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";

      return (
        await postJson<{ embeddings: number[][] }>(
          "Ollama",
          model,
          `${/^https?:\/\//.test(host) ? host : `http://${host}`}/api/embed`,
          {},
          { model, input: texts },
        )
      ).embeddings;
    },
    { name: model },
  );
};
