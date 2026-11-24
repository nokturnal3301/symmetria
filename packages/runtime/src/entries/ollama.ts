/**
 * `symmetria/ollama`: embedding models served by a local Ollama for
 * `.search()`: `meaning: ollama("bge-m3")(chunk.title, chunk.content)`.
 * Nothing leaves the machine and there is no key.
 */
import {
  postJson,
  requestOptions,
  type RequestOptions,
} from "../embedders/http";
import { embedder } from "../schema/search";

/** Embedding lengths of the models Ollama's library lists most often. */
const SIZES: Readonly<Record<string, number>> = {
  "bge-m3": 1024,
  "mxbai-embed-large": 1024,
  "nomic-embed-text": 768,
  "all-minilm": 384,
};

/** Where Ollama listens unless it is told otherwise. */
const DEFAULT_PORT = "11434";

export type OllamaOptions = RequestOptions & {
  /** Embedding length; required for a model this module does not know. */
  readonly size?: number;
  /** Where Ollama listens; `OLLAMA_HOST` or `http://localhost:11434` otherwise. */
  readonly baseUrl?: string;
};

/** The address a server listens on for every interface, reached on this machine. */
const reached = (host: string): string =>
  host === "" || host === "0.0.0.0"
    ? "127.0.0.1"
    : host === "::" || host === "[::]"
      ? host.startsWith("[")
        ? "[::1]"
        : "::1"
      : host;

/**
 * Ollama's address. A URL (`http://user:secret@host:8080/ollama`) keeps its
 * scheme, credentials, port and path. An address without a scheme is read as
 * the `ollama` command reads `OLLAMA_HOST`: `http`, and port 11434 unless it
 * names one (`127.0.0.1`, `localhost:11434`, `[::1]`). In both, a host that a
 * server listens on for every interface (`0.0.0.0`, `::`) is reached on this
 * machine (`127.0.0.1`, `::1`).
 */
const ollamaUrl = (value: string | undefined): string => {
  const given = value?.trim() ?? "";

  if (!given) {
    return `http://localhost:${DEFAULT_PORT}`;
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(given)) {
    let url: URL;

    try {
      url = new URL(given);
    } catch {
      throw new Error(`symmetria: Ollama's address "${given}" is not a URL`);
    }

    url.hostname = reached(url.hostname);

    return url.href.replace(/\/+$/, "");
  }

  const slash = given.indexOf("/");
  const address = slash < 0 ? given : given.slice(0, slash);
  const path = slash < 0 ? "" : given.slice(slash).replace(/\/+$/, "");
  const bracketed = /^\[([^\]]*)\](?::(\d*))?$/.exec(address);
  const [host, port] = bracketed
    ? [bracketed[1]!, bracketed[2]]
    : address.split(":").length === 2
      ? (address.split(":") as [string, string])
      : [address, undefined];
  const name = reached(host);

  return `http://${name.includes(":") ? `[${name}]` : name}:${port || DEFAULT_PORT}${path}`;
};

export const ollama = (model: string, options: OllamaOptions = {}) => {
  const size = options.size ?? SIZES[model.split(":")[0]!];

  if (size === undefined) {
    throw new Error(
      `symmetria: the embedding length of "${model}" is not known; pass ollama("${model}", { size })`,
    );
  }

  const request = requestOptions(model, options);

  return embedder(
    size,
    async (texts) =>
      (
        await postJson<{ embeddings: number[][] }>(
          "Ollama",
          model,
          `${ollamaUrl(options.baseUrl ?? process.env.OLLAMA_HOST)}/api/embed`,
          {},
          { model, input: texts },
          request,
        )
      ).embeddings,
    { name: model },
  );
};
