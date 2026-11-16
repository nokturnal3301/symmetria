import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  varchar,
} from "../../../packages/runtime/src";
import {
  bm25,
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import {
  createSchemaSQL,
  diffSchemas,
  lintMigration,
} from "../../../packages/kit/src";

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
    `ALTER TABLE "documents" ADD COLUMN "about_words" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("body", '')), 'A')) STORED`,
    'CREATE INDEX "documents_about_meaning_idx" ON "documents" USING hnsw ("about" vector_cosine_ops)',
    'CREATE INDEX "documents_about_words_idx" ON "documents" USING gin ("about_words")',
  ]);
  expect(added.down).toContain('ALTER TABLE "documents" DROP COLUMN "about"');
  expect(added.down).toContain(
    'ALTER TABLE "documents" DROP COLUMN "about_words"',
  );
  // The stored document is computed for every row, and holds nothing of its own.
  expect(
    lintMigration(added).map(
      (finding) => `${finding.level}: ${finding.column}`,
    ),
  ).toContain("caution: about_words");
  expect(
    lintMigration(diffSchemas(after, before)).filter(
      (finding) => finding.column === "about_words",
    ),
  ).toEqual([]);

  // A source column that changes its type takes the document with it:
  // PostgreSQL refuses to retype a column a generated column is computed from.
  const wider = schema({
    documents: table({ id: int.auto, body: varchar(200) }).search(
      (document) => ({ about: { words: fullText(document.body) } }),
    ),
  }).$snapshot();
  const narrower = schema({
    documents: table({ id: int.auto, body: varchar(100) }).search(
      (document) => ({ about: { words: fullText(document.body) } }),
    ),
  }).$snapshot();

  expect(diffSchemas(narrower, wider).up).toEqual([
    'DROP INDEX "documents_about_words_idx"',
    'ALTER TABLE "documents" DROP COLUMN "about_words"',
    'ALTER TABLE "documents" ALTER COLUMN "body" TYPE varchar(200)',
    `ALTER TABLE "documents" ADD COLUMN "about_words" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("body", '')), 'A')) STORED`,
    'CREATE INDEX "documents_about_words_idx" ON "documents" USING gin ("about_words")',
  ]);
  // A renamed source column leaves it alone: PostgreSQL follows the rename.
  const renamed = schema({
    documents: table({ id: int.auto, text: varchar(100) }).search(
      (document) => ({ about: { words: fullText(document.text) } }),
    ),
  }).$snapshot();

  expect(
    diffSchemas(narrower, renamed, {
      renames: { columns: { documents: { body: "text" } } },
    }).up,
  ).toEqual(['ALTER TABLE "documents" RENAME COLUMN "body" TO "text"']);
  // The same declaration again is no change.
  expect(diffSchemas(after, after).up).toEqual([]);
});
