import { afterEach, expect, test } from "bun:test";
import { cohere, embedV4 } from "../../../packages/runtime/src/entries/cohere";
import { geminiEmbedding } from "../../../packages/runtime/src/entries/google";
import { jinaV3 } from "../../../packages/runtime/src/entries/jina";
import { mistralEmbed } from "../../../packages/runtime/src/entries/mistral";
import { ollama } from "../../../packages/runtime/src/entries/ollama";
import {
  openai,
  textEmbedding3Large,
} from "../../../packages/runtime/src/entries/openai";
import { voyage, voyage4 } from "../../../packages/runtime/src/entries/voyage";

const realFetch = globalThis.fetch;
const KEYS = [
  "VOYAGE_API_KEY",
  "OPENAI_API_KEY",
  "COHERE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "JINA_API_KEY",
  "OLLAMA_HOST",
];
const saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));

afterEach(() => {
  globalThis.fetch = realFetch;

  for (const name of KEYS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

type Sent = { url: string; headers: Record<string, string>; body: any };

/** Answers every request with `reply(body)` and records what was sent. */
const service = (reply: (body: any) => unknown, status = 200) => {
  const sent: Sent[] = [];

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);

    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body,
    });

    return new Response(JSON.stringify(reply(body)), { status });
  }) as never;

  return sent;
};
/** An OpenAI-shaped answer, deliberately out of order. */
const openaiShaped = (body: { input: string[] }) => ({
  data: body.input
    .map((text, index) => ({ index, embedding: [text.length] }))
    .reverse(),
});

test("Voyage: documents and questions are told apart, answers keep their order", async () => {
  process.env.VOYAGE_API_KEY = "voyage-key";

  const sent = service(openaiShaped);

  expect(await voyage4.model.embed(["a", "bbb"], "document")).toEqual([
    [1],
    [3],
  ]);
  expect(sent[0]).toEqual({
    url: "https://api.voyageai.com/v1/embeddings",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer voyage-key",
    },
    body: { input: ["a", "bbb"], model: "voyage-4", input_type: "document" },
  });
  await voyage("voyage-4-large", { size: 2000, apiKey: "own" }).model.embed(
    ["q"],
    "query",
  );
  expect(sent[1]!.headers.Authorization).toBe("Bearer own");
  expect(sent[1]!.body).toEqual({
    input: ["q"],
    model: "voyage-4-large",
    input_type: "query",
    output_dimension: 2000,
  });
});

test("large inputs are sent in batches", async () => {
  process.env.VOYAGE_API_KEY = "voyage-key";

  const sent = service(openaiShaped);
  const texts = Array.from({ length: 300 }, (_, position) =>
    "x".repeat(position % 7),
  );
  const embeddings = await voyage4.model.embed(texts, "document");

  expect(sent.map((request) => request.body.input.length)).toEqual([
    128, 128, 44,
  ]);
  expect(embeddings.map(([length]) => length)).toEqual(
    texts.map((text) => text.length),
  );
});

test("OpenAI: text-embedding-3 models are asked for a length pgvector can index", async () => {
  process.env.OPENAI_API_KEY = "openai-key";

  const sent = service(openaiShaped);

  expect(textEmbedding3Large.model.size).toBe(1536);
  await textEmbedding3Large.model.embed(["a"], "query");
  expect(sent[0]).toEqual({
    url: "https://api.openai.com/v1/embeddings",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer openai-key",
    },
    body: {
      input: ["a"],
      model: "text-embedding-3-large",
      encoding_format: "float",
      dimensions: 1536,
    },
  });
  // Another server speaking the same API, and a model with one length.
  await openai("nomic-embed-text", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "local",
  }).model.embed(["a"], "document");
  expect(sent[1]!.url).toBe("http://localhost:1234/v1/embeddings");
  expect(sent[1]!.body).toEqual({
    input: ["a"],
    model: "nomic-embed-text",
    encoding_format: "float",
  });
});

test("Cohere, Google, Mistral, Jina and Ollama each get their own request", async () => {
  process.env.COHERE_API_KEY = "cohere-key";
  process.env.GOOGLE_API_KEY = "google-key";
  process.env.MISTRAL_API_KEY = "mistral-key";
  process.env.JINA_API_KEY = "jina-key";

  const cohereSent = service((body) => ({
    embeddings: { float: body.texts.map((text: string) => [text.length]) },
  }));

  expect(await embedV4.model.embed(["ab"], "query")).toEqual([[2]]);
  expect(cohereSent[0]).toMatchObject({
    url: "https://api.cohere.com/v2/embed",
    headers: { Authorization: "Bearer cohere-key" },
    body: {
      model: "embed-v4.0",
      texts: ["ab"],
      input_type: "search_query",
      embedding_types: ["float"],
      output_dimension: 1536,
    },
  });
  await cohere("embed-multilingual-v3.0").model.embed(["ab"], "document");
  expect(cohereSent[1]!.body).toEqual({
    model: "embed-multilingual-v3.0",
    texts: ["ab"],
    input_type: "search_document",
    embedding_types: ["float"],
  });

  const googleSent = service((body) => ({
    embeddings: body.requests.map((request: any) => ({
      values: [request.content.parts[0].text.length],
    })),
  }));

  expect(await geminiEmbedding.model.embed(["abc", "d"], "document")).toEqual([
    [3],
    [1],
  ]);
  expect(googleSent[0]).toMatchObject({
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    headers: { "x-goog-api-key": "google-key" },
  });
  expect(googleSent[0]!.body.requests[0]).toEqual({
    model: "models/gemini-embedding-001",
    content: { parts: [{ text: "abc" }] },
    taskType: "RETRIEVAL_DOCUMENT",
    outputDimensionality: 1536,
  });

  const mistralSent = service(openaiShaped);

  await mistralEmbed.model.embed(["a"], "document");
  expect(mistralSent[0]).toMatchObject({
    url: "https://api.mistral.ai/v1/embeddings",
    headers: { Authorization: "Bearer mistral-key" },
    body: { input: ["a"], model: "mistral-embed" },
  });

  const jinaSent = service(openaiShaped);

  await jinaV3.model.embed(["a"], "query");
  expect(jinaSent[0]).toMatchObject({
    url: "https://api.jina.ai/v1/embeddings",
    headers: { Authorization: "Bearer jina-key" },
    body: {
      input: ["a"],
      model: "jina-embeddings-v3",
      task: "retrieval.query",
    },
  });

  process.env.OLLAMA_HOST = "127.0.0.1:9999";

  const ollamaSent = service((body) => ({
    embeddings: body.input.map((text: string) => [text.length]),
  }));

  expect(await ollama("bge-m3").model.embed(["abcd"], "document")).toEqual([
    [4],
  ]);
  expect(ollamaSent[0]).toMatchObject({
    url: "http://127.0.0.1:9999/api/embed",
    body: { model: "bge-m3", input: ["abcd"] },
  });
});

test("a missing key and a refusal say what to do", async () => {
  for (const name of KEYS) {
    delete process.env[name];
  }

  const sent = service(() => ({}));

  await expect(voyage4.model.embed(["a"], "query")).rejects.toThrow(
    "voyage-4 needs a Voyage API key: set VOYAGE_API_KEY, or pass { apiKey }",
  );
  await expect(geminiEmbedding.model.embed(["a"], "query")).rejects.toThrow(
    "set GEMINI_API_KEY or GOOGLE_API_KEY, or pass { apiKey }",
  );
  expect(sent).toHaveLength(0);
  expect(() => cohere("some-new-model")).toThrow(
    'the embedding length of "some-new-model" is not known',
  );

  process.env.OPENAI_API_KEY = "openai-key";
  service(() => ({ error: "quota" }), 429);
  await expect(
    openai("text-embedding-3-small").model.embed(["a"], "query"),
  ).rejects.toThrow(
    'OpenAI refused to embed with text-embedding-3-small (429): {"error":"quota"}',
  );
});
