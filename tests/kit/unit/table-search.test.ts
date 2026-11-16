import { expect, test } from "bun:test";
import { schema, table, int, text } from "../../../packages/runtime/src";
import {
  bm25,
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import { createSchemaSQL, diffSchemas } from "../../../packages/kit/src";

const model = embedder(4, async (texts) => texts.map(() => [0, 0, 0, 1]), {
  name: "four",
});
const plain = () => table({ id: int.auto, title: text, body: text });

test("a searched table migrates as a vector column, its indexes and the extensions", () => {
  const documents = plain().search((document) => ({
    about: {
      words: bm25({ A: document.title, B: document.body }),
      meaning: model(document.title, document.body),
    },
  }));

  expect(
    createSchemaSQL(schema({ documents }).$snapshot()).map(({ sql }) => sql),
  ).toEqual([
    'CREATE EXTENSION IF NOT EXISTS "pg_search"',
    'CREATE EXTENSION IF NOT EXISTS "vector"',
    [
      'CREATE TABLE "documents" (',
      '  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,',
      '  "title" text NOT NULL,',
      '  "body" text NOT NULL,',
      '  "about" vector(4),',
      '  CONSTRAINT "documents_pkey" PRIMARY KEY ("id")',
      ")",
    ].join("\n"),
    'CREATE INDEX "documents_about_meaning_idx" ON "documents" USING hnsw ("about" vector_cosine_ops)',
    'CREATE INDEX "documents_about_words_idx" ON "documents" USING bm25 ("id", "title", "body")',
  ]);
});

test("adding a search to an existing table adds the column and indexes, and removing it drops them", () => {
  const before = schema({ documents: plain() }).$snapshot();
  const after = schema({
    documents: plain().search((document) => ({
      about: {
        words: fullText(document.body),
        meaning: model(document.body),
      },
    })),
  }).$snapshot();
  const added = diffSchemas(before, after);

  expect(added.up).toEqual([
    'CREATE EXTENSION IF NOT EXISTS "vector"',
    'ALTER TABLE "documents" ADD COLUMN "about" vector(4)',
    'CREATE INDEX "documents_about_meaning_idx" ON "documents" USING hnsw ("about" vector_cosine_ops)',
    `CREATE INDEX "documents_about_words_idx" ON "documents" USING gin ((setweight(to_tsvector('simple', coalesce("body", '')), 'A')))`,
  ]);
  expect(added.down).toContain('ALTER TABLE "documents" DROP COLUMN "about"');
  // The same declaration again is no change.
  expect(diffSchemas(after, after).up).toEqual([]);
});
