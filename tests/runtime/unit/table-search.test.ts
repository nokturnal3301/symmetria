import { expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  int,
  text,
  uuid,
  date,
  timestamptz,
  numeric,
  inet,
  jsonb,
  oneOf,
  customType,
  type CompiledQuery,
  type InferInsert,
} from "../../../packages/runtime/src";
import {
  bm25,
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import { ollama } from "../../../packages/runtime/src/entries/ollama";
import { voyage, voyage4 } from "../../../packages/runtime/src/entries/voyage";

/** A model that answers with the length of each text, and records what it was asked. */
const counting = () => {
  const asked: { kind: string; texts: readonly string[] }[] = [];
  const model = embedder(
    2,
    async (texts, kind) => {
      asked.push({ kind, texts });

      return texts.map((text) => [text.length, 1]);
    },
    { name: "counting" },
  );

  return { model, asked };
};

const tables = (model = counting().model) => {
  const notes = table({ id: int.auto, title: text, chunks: many.cascade });
  const chunks = table({
    id: int.auto,
    note: one(notes.chunks),
    owner: text,
    title: text,
    content: text,
  }).search((chunk) => ({
    about: {
      words: fullText({ A: chunk.title, B: chunk.content }),
      meaning: model(chunk.title, chunk.content),
    },
  }));

  return { notes, chunks };
};

const recording = (
  definitions: ReturnType<typeof tables>,
  rows: Record<string, unknown>[] = [],
) => {
  const calls: CompiledQuery[] = [];
  const database = schema(definitions, {
    executor: async (query) => {
      calls.push(query);

      return { rows, affectedRows: rows.length };
    },
  });

  return { database, calls, last: () => calls.at(-1)! };
};

test("search() lowers to a hidden vector column, two indexes and the extension", () => {
  const snapshot = schema(tables()).$snapshot();
  const chunks = snapshot.tables.find((entry) => entry.name === "chunks")!;

  expect(snapshot.extensions).toEqual(["vector"]);
  expect(chunks.columns.slice(-2)).toEqual([
    {
      name: "about",
      sqlName: "about",
      sqlType: "vector(2)",
      notNull: false,
      unique: false,
      primaryKey: false,
      hidden: true,
      // What the embeddings describe: migrations clear them when it changes.
      embedding: { model: "counting", sources: ["title", "content"] },
    },
    // The document is stored, so ranking does not parse the text again.
    {
      name: "aboutWords",
      sqlName: "about_words",
      sqlType: "tsvector",
      notNull: false,
      unique: false,
      primaryKey: false,
      hidden: true,
      generated: `setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("content", '')), 'B')`,
    },
  ]);
  expect(
    chunks.indexes!.map(({ sqlName, method, keys }) => [sqlName, method, keys]),
  ).toEqual([
    ["chunks_note_id_idx", "btree", ['"note_id"']],
    ["chunks_about_meaning_idx", "hnsw", ['"about"']],
    ["chunks_about_words_idx", "gin", ['"about_words"']],
  ]);
  expect(() =>
    schema({
      notes: table({ id: int.auto, title: text, aboutWords: text }).search(
        (note) => ({ about: { words: fullText(note.title) } }),
      ),
    }),
  ).toThrow(
    'symmetria: search "about" keeps its document in a column named "aboutWords", which the table already has',
  );
});

test("bm25() indexes the key and the columns, and asks for pg_search", () => {
  const documents = table({ id: uuid.v4, title: text, body: text }).search(
    (document) => ({
      text: { words: bm25({ A: document.title, B: document.body }) },
    }),
  );
  const snapshot = schema({ documents }).$snapshot();

  expect(snapshot.extensions).toEqual(["pg_search"]);
  expect(snapshot.tables[0]!.columns.map((column) => column.name)).toEqual([
    "id",
    "title",
    "body",
  ]);
  expect(snapshot.tables[0]!.indexes).toEqual([
    expect.objectContaining({
      sqlName: "documents_text_words_idx",
      method: "bm25",
      keys: ['"id"', '"title"', '"body"'],
    }),
  ]);
  // Declared extensions are merged with the ones search needs.
  expect(
    schema({ documents }, { extensions: ["citext"] }).$snapshot().extensions,
  ).toEqual(["citext", "pg_search"]);
});

test("a schema without search() is unchanged", () => {
  const plain = table({ id: int.auto, title: text });
  const snapshot = schema({ plain }).$snapshot();

  expect(snapshot.extensions).toBeUndefined();
  expect(JSON.stringify(snapshot)).not.toContain("hidden");
});

test("declarations are checked where they are written", () => {
  const base = () => table({ id: int.auto, title: text, about: text });
  const { model } = counting();

  expect(() =>
    base().search((row) => ({ about: { meaning: model(row.title) } })),
  ).toThrow(
    'search "about" keeps its embedding in a column of that name, which the table already has',
  );
  expect(() => base().search(() => ({ found: {} }))).toThrow(
    'search "found" declares neither words nor meaning',
  );
  expect(() =>
    base().search((row) => ({ found: { words: row.title as never } })),
  ).toThrow('"found.words" is declared with bm25() or fullText()');
  expect(() =>
    base().search((row) => ({
      found: { meaning: fullText(row.title) as never },
    })),
  ).toThrow('"found.meaning" is declared with an embedding model');
  expect(() =>
    base().search((row) => ({
      found: { words: fullText({ Z: row.title } as never) },
    })),
  ).toThrow("fullText() weights are A, B, C and D");
  expect(() =>
    base()
      .search((row) => ({ found: { words: fullText(row.title) } }))
      .search((row) => ({ found: { words: fullText(row.about) } })),
  ).toThrow('duplicate search "found"');
  expect(() => embedder(0, async () => [])).toThrow(
    "an embedding has between 1 and 4000 dimensions",
  );
  // More than pgvector indexes in full precision: half precision takes it.
  const large = embedder(3072, async () => [], { name: "large" });

  expect(() =>
    schema({
      wide: base().search((row) => ({ found: { meaning: large(row.about) } })),
    }),
  ).toThrow(
    'search "found": pgvector indexes vectors of at most 2000 dimensions and large has 3072; keep it in half precision, large(...).half',
  );

  const halved = schema({
    wide: base().search((row) => ({
      found: { meaning: large(row.about).half },
    })),
  }).$snapshot().tables[0]!;

  expect(halved.columns.at(-1)).toMatchObject({
    name: "found",
    sqlType: "halfvec(3072)",
    hidden: true,
  });
  expect(halved.indexes!.at(-1)).toMatchObject({
    method: "hnsw",
    opclasses: ["halfvec_cosine_ops"],
  });
  expect(() => ollama("unknown-model")).toThrow(
    'the embedding length of "unknown-model" is not known',
  );
  expect(voyage4.model).toMatchObject({ name: "voyage-4", size: 1024 });
  expect(voyage("voyage-4-large", { size: 2000 }).model.size).toBe(2000);
  expect(ollama("bge-m3:latest").model).toMatchObject({ size: 1024 });
});

test("whole-row reads and writes leave the embedding out", async () => {
  const { database, last } = recording(tables(), [{ id: 1 }]);

  await database.chunks({ where: { owner: "u" } });
  expect(last().sql).not.toContain('"about"');
  await database.chunks.get(1);
  expect(last().sql).not.toContain('"about"');
  await database.chunks
    .insert({ noteId: 1, owner: "u", title: "t", content: "c", about: [1, 2] })
    .returning();
  expect(last().sql).toStartWith(
    'INSERT INTO "chunks" AS "chunks"\n("note_id", "owner", "title", "content", "about")',
  );
  expect(last().sql.split("RETURNING")[1]).not.toContain('"about"');
  // By name it is a column like any other.
  await database.chunks((chunk) => ({
    about: (chunk as unknown as { about: typeof chunk.title }).about,
  }));
  expect(last().sql).toContain('"chunks"."about" AS "about"');
});

test("insert and upsert ask the model once for the rows that need it", async () => {
  const { model, asked } = counting();
  const { database, calls } = recording(tables(model), [{ id: 1 }]);

  await database.chunks.insert([
    { noteId: 1, owner: "u", title: "One", content: "first" },
    { noteId: 1, owner: "u", title: "Two", content: "second", about: [9, 9] },
    { noteId: 1, owner: "u", title: "", content: "" },
  ]);
  expect(asked).toEqual([{ kind: "document", texts: ["One\n\nfirst"] }]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.parameters).toContain("[10,1]");
  expect(calls[0]!.parameters).toContain("[9,9]");

  // Chained calls reach the real builder once the embedding is there.
  const created = await database.chunks
    .insert({ noteId: 1, owner: "u", title: "Three", content: "third" })
    .returning("id");

  expect(created).toEqual({ id: 1 });
  expect(calls[1]!.sql).toEndWith('RETURNING "chunks"."id" AS "id"');

  const pages = table({ id: int.auto, slug: text.unique, body: text }).search(
    (page) => ({ about: { meaning: model(page.body) } }),
  );
  const upserts: CompiledQuery[] = [];
  const site = schema(
    { pages },
    {
      executor: async (query) => {
        upserts.push(query);

        return { rows: [], affectedRows: 1 };
      },
    },
  );

  await site.pages.upsert({ slug: "home", body: "welcome" }, { by: "slug" });
  expect(asked.at(-1)).toEqual({ kind: "document", texts: ["welcome"] });
  expect(upserts[0]!.sql).toContain('"about" = "excluded"."about"');
  expect(() =>
    database.chunks
      .insert({ noteId: 1, owner: "u", title: "t", content: "c" })
      .toSQL(),
  ).toThrow("toSQL() cannot wait for embeddings");
});

test("a model that fails rejects the insert before anything is sent", async () => {
  const failing = embedder(2, async () => {
    throw new Error("model is down");
  });
  const { database, calls } = recording(tables(failing));

  await expect(
    database.chunks
      .insert({ noteId: 1, owner: "u", title: "t", content: "c" })
      .execute(),
  ).rejects.toThrow("model is down");
  expect(calls).toHaveLength(0);

  const short = embedder(2, async (texts) => texts.map(() => [1]));

  await expect(
    recording(tables(short))
      .database.chunks.insert({
        noteId: 1,
        owner: "u",
        title: "t",
        content: "c",
      })
      .execute(),
  ).rejects.toThrow("custom returned 1 numbers for a text; 2 expected");
});

test("rows the write refuses never reach the model", async () => {
  const { model, asked } = counting();
  const { database, calls } = recording(tables(model), [{ id: 1 }]);
  const row = { noteId: 1, owner: "u", title: "One", content: "first" };

  // A required column is missing.
  await expect(
    database.chunks
      .insert({ noteId: 1, title: "One", content: "first" } as never)
      .execute(),
  ).rejects.toThrow("owner");
  // A value its column cannot hold.
  await expect(
    database.chunks.insert({ ...row, noteId: 1.5 }).execute(),
  ).rejects.toThrow();
  // A column the table does not have.
  await expect(
    database.chunks.insert({ ...row, missing: 1 } as never).execute(),
  ).rejects.toThrow("missing");
  // A chained call that cannot be made.
  await expect(
    (
      database.chunks.insert(row) as unknown as {
        returning: (name: string) => { execute: () => Promise<unknown> };
      }
    )
      .returning("missing")
      .execute(),
  ).rejects.toThrow("missing");
  expect(asked).toEqual([]);
  expect(calls).toHaveLength(0);

  await database.chunks.insert(row).returning("id");
  expect(asked).toHaveLength(1);
  expect(calls).toHaveLength(1);
});

test("an UPDATE of the text clears the embedding that described it", async () => {
  const { database, last } = recording(tables());

  await database.chunks.update({ content: "new" }, { where: { id: 1 } });
  expect(last().sql).toBe(
    'UPDATE "chunks" AS "chunks" SET "content" = $1, "about" = $2::text::vector\nWHERE "chunks"."id" = $3',
  );
  expect(last().parameters).toEqual(["new", null, 1]);
  await database.chunks.byId(1).update({ title: "T" });
  expect(last().sql).toContain('"about" = $2');
  // Other columns leave it alone, and so does an UPDATE that sets it.
  await database.chunks.update({ owner: "v" }, { where: { id: 1 } });
  expect(last().sql).not.toContain('"about"');
  await database.chunks.update(
    { content: "new", about: [1, 2] },
    { where: { id: 1 } },
  );
  expect(last().parameters).toEqual(["new", "[1,2]", 1]);
});

test("search() ranks by words and meaning in one statement", async () => {
  const { model, asked } = counting();
  const { database, calls } = recording(tables(model), [{ title: "found" }]);
  const run = database.chunks.search(
    (chunk) => ({ title: chunk.title, note: chunk.note.title }),
    { where: { owner: "u" }, about: "Where are the keys?", limit: 3 },
  );
  const { sql, parameters } = await run.toSQL();

  expect(sql).toBe(
    [
      'WITH "search_about_meaning_probe" AS (SELECT "chunks"."id" AS "id"',
      'FROM "chunks" AS "chunks"',
      'WHERE "chunks"."owner" = $1 AND "chunks"."about" IS NOT NULL',
      "LIMIT 10001),",
      '"search_about_meaning_exact" AS (SELECT "chunks"."id" AS "id", ROW_NUMBER() OVER (ORDER BY (("chunks"."about" <=> (SELECT $2::text::vector))) + 0 ASC, "chunks"."id" ASC) AS "position", (("chunks"."about" <=> (SELECT $2::text::vector))) + 0 AS "rank"',
      'FROM "chunks" AS "chunks"',
      'WHERE (SELECT COUNT(*) AS "matches"',
      'FROM "search_about_meaning_probe" AS "search_about_meaning_probe") <= $3 AND "chunks"."owner" = $4 AND "chunks"."about" IS NOT NULL',
      'ORDER BY (("chunks"."about" <=> (SELECT $2::text::vector))) + 0 ASC, "chunks"."id" ASC',
      "LIMIT 40),",
      '"search_about_meaning" AS (SELECT "chunks"."id" AS "id", ROW_NUMBER() OVER (ORDER BY ("chunks"."about" <=> (SELECT $5::text::vector)) ASC) AS "position", ("chunks"."about" <=> (SELECT $5::text::vector)) AS "rank"',
      'FROM "chunks" AS "chunks"',
      `WHERE (SELECT CASE WHEN current_setting('hnsw.iterative_scan', true) IS NULL THEN '' ELSE set_config('hnsw.iterative_scan', 'strict_order', true) END || CASE WHEN current_setting('hnsw.max_scan_tuples', true) IS NULL THEN '' ELSE set_config('hnsw.max_scan_tuples', '2147483647', true) END || CASE WHEN current_setting('hnsw.scan_mem_multiplier', true) IS NULL THEN '' ELSE set_config('hnsw.scan_mem_multiplier', '1000', true) END) IS NOT NULL AND (SELECT COUNT(*) AS "matches"`,
      'FROM "search_about_meaning_probe" AS "search_about_meaning_probe") > $6 AND "chunks"."owner" = $7 AND "chunks"."about" IS NOT NULL',
      'ORDER BY ("chunks"."about" <=> (SELECT $5::text::vector)) ASC',
      "LIMIT 40),",
      '"search_fused" AS (SELECT coalesce("search_about_meaning_exact"."id", "search_about_meaning"."id") AS "id", (coalesce(1.0 / (60 + "search_about_meaning_exact"."position"), 0)) + (coalesce(1.0 / (60 + "search_about_meaning"."position"), 0)) AS "score"',
      'FROM "search_about_meaning_exact" AS "search_about_meaning_exact"',
      'FULL JOIN "search_about_meaning" AS "search_about_meaning" ON ("search_about_meaning_exact"."id" = "search_about_meaning"."id")),',
      `"search_about_words" AS (SELECT "chunks"."id" AS "id", ROW_NUMBER() OVER (ORDER BY ts_rank("chunks"."about_words", (SELECT to_tsquery('simple', $8))) DESC, "chunks"."id" ASC) AS "position", ts_rank("chunks"."about_words", (SELECT to_tsquery('simple', $8))) AS "rank"`,
      'FROM "chunks" AS "chunks"',
      `WHERE "chunks"."owner" = $9 AND "chunks"."about_words" @@ to_tsquery('simple', $10)`,
      `ORDER BY ts_rank("chunks"."about_words", (SELECT to_tsquery('simple', $8))) DESC, "chunks"."id" ASC`,
      "LIMIT 40),",
      '"search_fused_2" AS (SELECT coalesce("search_fused"."id", "search_about_words"."id") AS "id", coalesce("search_fused"."score", 0) + (coalesce(1.0 / (60 + "search_about_words"."position"), 0)) AS "score"',
      'FROM "search_fused" AS "search_fused"',
      'FULL JOIN "search_about_words" AS "search_about_words" ON ("search_fused"."id" = "search_about_words"."id"))',
      'SELECT "chunks"."title" AS "title", "__symmetria_path_0"."title" AS "note"',
      'FROM "search_fused_2" AS "search_fused_2"',
      'INNER JOIN "chunks" AS "chunks" ON ("chunks"."id" = "search_fused_2"."id")',
      'INNER JOIN "notes" AS "__symmetria_path_0" ON "chunks"."note_id" = "__symmetria_path_0"."id"',
      'ORDER BY "search_fused_2"."score" DESC, "search_fused_2"."id" ASC',
      "LIMIT 3",
    ].join("\n"),
  );
  // Any of the question's words matches, each a quoted operand PostgreSQL's
  // parser reads as written (and lowercases), so punctuation cannot reach
  // the query syntax: the bare word as 3.5.0 sent it, then the word with what
  // surrounds it.
  expect(parameters).toEqual([
    "u",
    "[19,1]",
    10000,
    "u",
    "[19,1]",
    10000,
    "u",
    "' Where' | ' are' | ' the' | ' keys'",
    "u",
    "' Where' | ' are' | ' the' | ' keys'",
  ]);
  expect(await run).toEqual([{ title: "found" } as never]);
  // The question was embedded once, for toSQL() and the run together.
  expect(asked).toEqual([{ kind: "query", texts: ["Where are the keys?"] }]);
  expect(calls).toHaveLength(1);
});

test("one way of searching needs no fusion", async () => {
  const { model, asked } = counting();
  const { database } = recording(tables(model));
  const byVector = await database.chunks
    .search({ about: [1, 0], limit: 5, candidates: 5 })
    .toSQL();

  expect(asked).toEqual([]);
  expect(byVector.sql).not.toContain("search_fused");
  expect(byVector.sql).toContain(
    'ORDER BY "search_about_meaning"."position" ASC',
  );
  expect(byVector.sql).toContain("LIMIT 5)\n");
  // Whole rows, without the embedding.
  expect(byVector.sql).toContain(
    'SELECT "chunks"."id" AS "id", "chunks"."note_id" AS "noteId", "chunks"."owner" AS "owner", "chunks"."title" AS "title", "chunks"."content" AS "content"\n',
  );

  const both = await database.chunks
    .search({ about: { text: "keys", vector: [0, 1] } })
    .toSQL();

  expect(asked).toEqual([]);
  expect(both.sql).toContain("search_fused");
  expect(both.parameters[0]).toBe("[0,1]");
});

test("a filtered search by meaning ranks few rows exactly and many through the index", async () => {
  const { database } = recording(tables());
  const filtered = await database.chunks
    .search({ about: [1, 0], where: { owner: "u" }, limit: 5 })
    .toSQL();

  // The filters are counted once, up to the limit of an exact ranking.
  expect(filtered.sql).toContain(
    'WITH "search_about_meaning_probe" AS (SELECT "chunks"."id" AS "id"\nFROM "chunks" AS "chunks"\nWHERE "chunks"."owner" = $1 AND "chunks"."about" IS NOT NULL\nLIMIT 10001)',
  );
  // `+ 0` is an ordering the vector index cannot produce.
  expect(filtered.sql).toContain(
    'ORDER BY (("chunks"."about" <=> (SELECT $2::text::vector))) + 0 ASC, "chunks"."id" ASC',
  );
  expect(filtered.sql).toContain(
    'FROM "search_about_meaning_probe" AS "search_about_meaning_probe") <= $3 AND',
  );
  expect(filtered.sql).toContain(
    'FROM "search_about_meaning_probe" AS "search_about_meaning_probe") > $6 AND',
  );
  expect(filtered.parameters).toEqual([
    "u",
    "[1,0]",
    10000,
    "u",
    "[1,0]",
    10000,
    "u",
  ]);

  // A $scope() filter narrows the rows like a `where` does.
  const scoped = await database
    .$scope({ chunks: (chunk) => chunk.owner.is("u") })
    .chunks.search({ about: [1, 0] })
    .toSQL();

  expect(scoped.sql).toContain('"search_about_meaning_probe"');

  // Without a filter the index answers alone, with room for every candidate.
  const open = await database.chunks
    .search({ about: [1, 0], limit: 50 })
    .toSQL();

  expect(open.sql).not.toContain("probe");
  expect(open.sql).toContain(
    "set_config('hnsw.ef_search', greatest(current_setting('hnsw.ef_search')::integer, 200)::text, true)",
  );
});

test("an empty question and a vector of the wrong size never reach PostgreSQL", async () => {
  const { model, asked } = counting();
  const { database, calls } = recording(tables(model), [{ id: 1 }]);

  expect(await database.chunks.search({ about: "" })).toEqual([]);
  expect(await database.chunks.search({ about: "   " })).toEqual([]);
  expect(asked).toEqual([]);
  expect(calls).toHaveLength(0);
  await expect(
    database.chunks.search({ about: [1, 2, 3] }).execute(),
  ).rejects.toThrow(
    'symmetria: search "about" compares vectors of 2 numbers, received 3',
  );

  // PostgreSQL text cannot hold a zero byte; the words on both sides survive.
  const zero = await database.chunks
    .search({ about: { text: "data\0base", vector: [1, 0] } })
    .toSQL();

  expect(zero.parameters).toContain("' database'");
});

test("a model that fails at search time leaves the words, and says so", async () => {
  const failing = embedder(2, async () => {
    throw new Error("model is down");
  });
  const { database, last } = recording(tables(failing), [{ id: 1 }]);
  const rows = await database.chunks.search({ about: "keys" });

  expect(rows).toEqual([{ id: 1 } as never]);
  expect(rows.partial?.search).toBe("about");
  expect((rows.partial?.error as Error).message).toBe("model is down");
  expect(last().sql).not.toContain("search_about_meaning");

  // Without words to fall back on, the failure is the answer.
  const semantic = table({ id: int.auto, body: text }).search((row) => ({
    about: { meaning: failing(row.body) },
  }));
  const meaningOnly = schema({ semantic }, { executor: async () => [] });

  await expect(
    meaningOnly.semantic.search({ about: "keys" }).execute(),
  ).rejects.toThrow("model is down");
});

test("search() refuses what it cannot answer", async () => {
  const { database, calls } = recording(tables());

  expect(() => database.chunks.search({ nope: "x" } as never)).toThrow(
    '"chunks" has no search "nope"; it declares "about"',
  );
  expect(() => database.chunks.search({ limit: 3 })).toThrow(
    'search() needs what to search for, for example { about: "…" }',
  );
  expect(() => database.chunks.search({ about: "x", limit: 0 })).toThrow(
    "limit must be a positive integer",
  );
  expect(() =>
    database.chunks.search({ about: "x", limit: 10, candidates: 5 }),
  ).toThrow("candidates must be an integer of at least the limit");
  expect(() =>
    database.chunks.search({ about: { query: "x" } as never }),
  ).toThrow('search "about" takes text, vector or both, not "query"');
  expect("search" in database.notes).toBe(false);
  // A question without a single word and without a vector finds nothing, and sends nothing.
  const wordsOnly = table({ id: int.auto, body: text }).search((row) => ({
    text: { words: fullText(row.body) },
  }));
  const plain = schema({ wordsOnly }, { executor: async () => [{ id: 1 }] });

  expect(await plain.wordsOnly.search({ text: "?!" })).toEqual([]);
  expect(calls).toHaveLength(0);
});

/** The characters JavaScript's `\s` counts as spaces, as a regular expression in SQL. */
const NOT_SPACE = `E'[^\\\\t\\\\n\\\\v\\\\f\\\\r \\\\u00a0\\\\u1680\\\\u2000-\\\\u200a\\\\u2028\\\\u2029\\\\u202f\\\\u205f\\\\u3000\\\\ufeff]'`;
/**
 * reindex() and missing() leave out a row unless a source column has a
 * character that is not a space: a printable ASCII first character, another
 * first character that is no space, or one anywhere. Under the "C" collation,
 * and without ascii(), which raises beyond ASCII in EUC_JP.
 */
const hasTextSQL = (column: string) => {
  const text = `${column} COLLATE "C"`;

  return `(${text} <> '' AND (left(${text}, 1) BETWEEN '!' AND '~' OR left(${text}, 1) ~ ${NOT_SPACE} OR ${text} ~ ${NOT_SPACE}))`;
};

test("reindex() embeds the rows that have no embedding, a batch at a time", async () => {
  const { model, asked } = counting();
  const pages = [
    [
      { id: 1, title: "A", content: "one", __symmetria_key: "1" },
      { id: 2, title: "C", content: "", __symmetria_key: "2" },
    ],
    [{ id: 3, title: "B", content: "three", __symmetria_key: "3" }],
    [],
  ];
  const calls: CompiledQuery[] = [];
  const database = schema(tables(model), {
    executor: async (query) => {
      calls.push(query);

      return query.sql.startsWith("SELECT")
        ? pages.shift()!
        : { rows: [], affectedRows: query.parameters.length === 4 ? 2 : 1 };
    },
  });

  expect(await database.chunks.search.reindex({ batch: 2 })).toBe(3);
  expect(asked.map((entry) => entry.texts)).toEqual([
    ["A\n\none", "C"],
    ["B\n\nthree"],
  ]);

  const selects = calls.filter((call) => call.sql.startsWith("SELECT"));

  expect(selects).toHaveLength(3);
  // Rows without text (or only spaces, as JavaScript's \s counts them) are
  // left out by the query itself, so no call reads them again. Each column
  // is tested on its own, by its first character unless that is a space, so
  // that a long text is not converted for a regular expression.
  expect(selects[0]!.sql).toContain(
    `WHERE "chunks"."about" IS NULL AND ((${hasTextSQL('"chunks"."title"')} OR ${hasTextSQL('"chunks"."content"')})) = (TRUE)`,
  );
  // Pages continue after the last key.
  expect(selects[1]!.sql).toContain('AND "chunks"."id" > $1');
  expect(selects[1]!.parameters).toEqual([2]);

  // One UPDATE per batch, which keeps an embedding written meanwhile and
  // skips a row whose sources changed while the model was asked: they are
  // compared as stored, as PostgreSQL writes them out ('' for NULL).
  const updates = calls.filter((call) => call.sql.startsWith("UPDATE"));

  expect(updates).toHaveLength(2);
  expect(updates[0]!.sql).toBe(
    `UPDATE "chunks" AS "chunks" SET "about" = (($1::text::jsonb) ->> ("chunks"."id")::text)::vector(2)\nWHERE ("chunks"."id" IN ($2, $3) AND "chunks"."about" IS NULL AND (jsonb_build_array(concat("chunks"."title"), concat("chunks"."content")) = (($4::text::jsonb) -> ("chunks"."id")::text)) = (TRUE))`,
  );
  expect(updates[0]!.parameters).toEqual([
    JSON.stringify({ 1: "[6,1]", 2: "[1,1]" }),
    1,
    2,
    JSON.stringify({ 1: ["A", "one"], 2: ["C", ""] }),
  ]);
});

test("reindex() goes by descending key and missing() counts what is left", async () => {
  const calls: CompiledQuery[] = [];
  const database = schema(tables(), {
    executor: async (query) => {
      calls.push(query);

      return query.sql.includes("COUNT(*)") ? [{ count: 7 }] : [];
    },
  });

  expect(await database.chunks.search.reindex({ order: "desc" })).toBe(0);
  expect(calls[0]!.sql).toContain('ORDER BY "chunks"."id" DESC');
  expect(
    await database.chunks.search.missing({ where: { owner: "ada" } }),
  ).toBe(7);
  expect(calls[1]!.sql).toContain(
    `WHERE "chunks"."owner" = $1 AND "chunks"."about" IS NULL AND ((${hasTextSQL('"chunks"."title"')} OR`,
  );
  await expect(
    database.chunks.search.reindex({ order: "newest" as never }),
  ).rejects.toThrow('reindex() order is "asc" or "desc"');
});

test("a model that answers NaN fails like a model that is down", async () => {
  const broken = embedder(
    2,
    async (texts) => texts.map(() => [Number.NaN, 1]),
    {
      name: "broken",
    },
  );
  const { database, calls } = recording(tables(broken), [{ id: 1 }]);
  const rows = await database.chunks.search({ about: "keys" });

  // The search falls back to its words.
  expect(rows).toEqual([{ id: 1 } as never]);
  expect((rows.partial?.error as Error).message).toBe(
    "symmetria: broken returned a number that is not finite for a question",
  );
  calls.length = 0;
  await expect(
    database.chunks
      .insert({ noteId: 1, owner: "u", title: "t", content: "c" })
      .execute(),
  ).rejects.toThrow(
    "symmetria: broken returned a number that is not finite for a text",
  );
  expect(calls).toHaveLength(0);
});

test("an insert may leave an embedding undefined, under exactOptionalPropertyTypes", () => {
  const searched = schema(tables());
  type Insert = InferInsert<typeof searched.chunks>;
  const row: Insert = {
    noteId: 1,
    owner: "u",
    title: "t",
    content: "c",
    about: undefined,
  };

  expect(row.about).toBeUndefined();
});

test("a search runs each time it is awaited, and asks the model again only after a failure", async () => {
  let failures = 0;
  const asked: string[] = [];
  const flaky = embedder(
    2,
    async (texts) => {
      asked.push(...texts);

      if (failures > 0) {
        failures -= 1;
        throw new Error("429 Too Many Requests");
      }

      return texts.map((value) => [value.length, 1]);
    },
    { name: "flaky" },
  );
  const { database, calls } = recording(tables(flaky), [{ id: 1 }]);
  const search = database.chunks.search({ about: "keys" });

  // Rows written since, and the current $scope() tenant, are seen as by a
  // query; the question is embedded once.
  await search;
  await search.execute();
  await search.then((rows) => rows);
  expect(calls).toHaveLength(3);
  expect(asked).toEqual(["keys"]);

  // A failure is not kept: the next await asks the model again.
  const semantic = table({ id: int.auto, body: text }).search((row) => ({
    about: { meaning: flaky(row.body) },
  }));
  const meaningOnly = schema({ semantic }, { executor: async () => [] });
  const kept = meaningOnly.semantic.search({ about: "garage" });

  failures = 1;
  await expect(kept.execute()).rejects.toThrow("429 Too Many Requests");
  expect(await kept).toEqual([]);
  expect(asked).toEqual(["keys", "garage", "garage"]);
});

test("a write that waits for its embedding runs each time it is awaited", async () => {
  const { model, asked } = counting();
  const { database, calls } = recording(tables(model), [{ id: 1 }]);
  const write = database.chunks.insert({
    noteId: 1,
    owner: "u",
    title: "t",
    content: "c",
  });

  await write;
  await write.execute();
  expect(calls.filter((call) => call.sql.startsWith("INSERT"))).toHaveLength(2);
  expect(asked).toHaveLength(2);
});

test("a text of spaces only is not embedded, as a question of spaces finds nothing", async () => {
  const { model, asked } = counting();
  const { database, last } = recording(tables(model));

  // Spaces as JavaScript's \s counts them, no-break spaces and a byte order
  // mark included; missing() and reindex() count the same ones in SQL.
  await database.chunks.insert({
    noteId: 1,
    owner: "u",
    title: "  \u00a0",
    content: "\n\t\ufeff",
  });
  expect(asked).toEqual([]);
  expect(last().sql).not.toContain('"about"');
});

test("full-text questions keep what PostgreSQL's parser keeps, as quoted operands", async () => {
  const words = schema(
    {
      pages: table({ id: int.auto, body: text }).search((page) => ({
        find: { words: fullText(page.body) },
      })),
    },
    { executor: async () => [] },
  );
  const question = async (value: string) =>
    (await words.pages.search({ find: value }).toSQL()).parameters[0];

  // Cased as written (PostgreSQL lowercases it as it lowercased the
  // document). Every word bare, as 3.5.0 sent it, so nothing it found is
  // lost; then the first and last word of a piece with what surrounds them,
  // unless PostgreSQL's parser drops all of that (`keys?`): its lexemes are
  // sent already, and each operand more costs every row the search reads.
  expect(await question("İstanbul ΟΔΟΣ /etc/hosts -5 ./run.sh keys?")).toBe(
    "' İstanbul' | ' ΟΔΟΣ' | ' etc/hosts' | ' 5' | ' run.sh' | ' keys' | ' /etc/hosts' | ' -5' | ' ./run.sh'",
  );
  expect(
    await question(`"Where" (are) my keys?! What's that, memory: 3.14.`),
  ).toBe(
    "' Where' | ' are' | ' my' | ' keys' | ' What' | ' s' | ' that' | ' memory' | ' 3.14'",
  );
  expect(await question("...my keys... e-mail-- (e.g. the car's)")).toBe(
    "' my' | ' keys' | ' e-mail' | ' e.g' | ' the' | ' car' | ' s'",
  );
  // Two dots after a word are a file name to the parser, and a sign before
  // a number is part of it.
  expect(await question("keys.. +5")).toBe(
    "' keys' | ' 5' | ' keys..' | ' +5'",
  );
  // Characters beyond ASCII are letters to a database in the C locale.
  expect(await question("«keys»")).toBe("' keys' | ' «keys»'");
  // A short piece of several words is also asked as a whole (a URL with a
  // query), after the words; quotes and backslashes stay inside their operand.
  expect(await question("it's a\\b x.org/a?c='1' /a\\b")).toBe(
    "' it' | ' s' | ' a' | ' b' | ' x.org/a' | ' c' | ' 1' | ' x.org/a?c=''1''' | ' /a' | ' /a\\\\b'",
  );
  // However long and repetitive a question, it sends a bounded query: a long
  // piece is not sent whole, and a word of more than 16 runs of letters and
  // digits is sent as its first, which every row holding it also holds.
  expect(await question("foo,".repeat(20_000))).toBe("' foo'");
  expect(await question("a-b-".repeat(1000))).toBe("' a'");
  // Repeated words count once; the first 64 distinct words are asked.
  expect(await question("Keys keys KEYS")).toBe("' Keys'");

  const many = await question(
    Array.from({ length: 70 }, (_value, position) => `w${position}`).join(" "),
  );

  expect(String(many).split(" | ")).toHaveLength(64);
  expect(many).toContain("' w63'");
  expect(many).not.toContain("' w64'");
});

test("searches read columns that are not text through a cast, or refuse them", async () => {
  const typed = table({
    id: int.auto,
    body: text,
    ref: uuid,
    price: numeric(10, 2),
    kind: oneOf("note", "faq"),
    day: date,
    host: inet,
  });
  const snapshot = schema({
    docs: typed.search((doc) => ({
      about: { words: fullText([doc.body, doc.ref, doc.price, doc.host]) },
    })),
  }).$snapshot();

  // Text keeps the expression it always had; uuid and numeric are cast, and
  // an inet is written as its output writes it (`10.0.0.1`, not `/32`).
  expect(
    snapshot.tables[0]!.columns.find((column) => column.name === "aboutWords")!
      .generated,
  ).toBe(
    `setweight(to_tsvector('simple', coalesce("body", '')), 'A') || setweight(to_tsvector('simple', coalesce("ref"::text, '')), 'A') || setweight(to_tsvector('simple', coalesce("price"::text, '')), 'A') || setweight(to_tsvector('simple', coalesce(abbrev("host"), '')), 'A')`,
  );

  // A generated column cannot hold text that can change; pg_search matches
  // words only in text.
  expect(() =>
    schema({
      docs: typed.search((doc) => ({ about: { words: fullText(doc.kind) } })),
    }),
  ).toThrow(
    'symmetria: fullText() cannot read "kind", which is an enum: its values can be renamed',
  );
  expect(() =>
    schema({
      docs: typed.search((doc) => ({ about: { words: fullText(doc.day) } })),
    }),
  ).toThrow('fullText() cannot read "day", which is of type date');
  expect(() =>
    schema({
      docs: typed.search((doc) => ({ about: { words: bm25(doc.ref) } })),
    }),
  ).toThrow(
    'symmetria: bm25() matches words in text columns; "ref" is of type uuid, which pg_search cannot match words in',
  );

  // A meaning reads any of them; missing() and reindex() read them as text.
  const { model } = counting();
  const calls: CompiledQuery[] = [];
  const database = schema(
    {
      docs: typed.search((doc) => ({
        about: { meaning: model(doc.body, doc.kind, doc.day, doc.host) },
      })),
    },
    {
      executor: async (query) => {
        calls.push(query);

        return [{ count: 1 }];
      },
    },
  );

  expect(await database.docs.search.missing()).toBe(1);
  // An enum's label may be only spaces; a date's or an inet's text is never
  // empty, so it is enough that they are not NULL.
  expect(calls[0]!.sql).toContain(
    [
      hasTextSQL('"docs"."body"'),
      hasTextSQL('concat("docs"."kind")'),
      '("docs"."day" IS NOT NULL)',
      '("docs"."host" IS NOT NULL)',
    ].join(" OR "),
  );
});

test("bm25() refuses numbers, booleans and bytes; fullText() refuses unfixed text in any spelling, with its own message", () => {
  const custom = (sqlType: string, base?: string) =>
    customType<string>(sqlType, {
      encode: (value: string) => value,
      decode: (value: unknown) => String(value),
      ...(base ? { base } : {}),
    } as never);
  const declare = (
    words: typeof bm25 | typeof fullText,
    column: ReturnType<typeof custom>,
  ) =>
    schema({
      docs: table({ id: int.auto, title: text, c: column.nullable }).search(
        (doc) => ({ about: { words: words([doc.title, doc.c]) } }),
      ),
    });

  // pg_search cannot match words in them: every search failed.
  for (const type of [
    "integer",
    "int4",
    "bigint",
    "smallint",
    "boolean",
    "bool",
    "real",
    "double precision",
    "float8",
    "bytea",
  ]) {
    expect(() => declare(bm25, custom(type))).toThrow(
      `symmetria: bm25() matches words in text columns; "c" is of type ${type}, which pg_search cannot match words in`,
    );
  }

  expect(() => declare(bm25, custom("counter", "integer"))).toThrow(
    '"c" is of type counter (integer), which pg_search cannot match words in',
  );
  // A type not known (a domain over text, without a base) is still taken.
  expect(() => declare(bm25, custom("label"))).not.toThrow();
  // Text, varchar and citext, JSON, and arrays of text or varchar.
  for (const type of [
    "text[]",
    "_text",
    "text[][]",
    "varchar(9)[]",
    "character varying(10)[]",
    "_varchar",
    "citext",
    "jsonb",
  ]) {
    expect(() => declare(bm25, custom(type))).not.toThrow();
  }
  expect(() => declare(bm25, custom("citext", "text"))).not.toThrow();

  // pg_search takes no other type: arrays of others and ranges failed every
  // search, char(n), name, a tsvector or xml failed at migrate, and so did
  // a domain or an extension's type whatever its base.
  for (const type of [
    "integer[]",
    "uuid[]",
    "numeric[]",
    "date[]",
    "boolean[]",
    "timestamptz[]",
    "citext[]",
    "char(3)[]",
    "jsonb[]",
    "label[]",
    "int4range",
    "tstzrange",
    "int4multirange",
    "char(3)",
    "character(3)",
    "bpchar",
    "name",
    "tsvector",
    "xml",
  ]) {
    expect(() => declare(bm25, custom(type))).toThrow(
      `symmetria: bm25() matches words in text columns; "c" is of type ${type}, which pg_search cannot match words in`,
    );
  }

  for (const [type, base] of [
    ["label", "text"],
    ["ltree", "text"],
    ["tags", "text[]"],
    ["counts", "integer[]"],
    ["period", "tstzrange"],
  ] as const) {
    expect(() => declare(bm25, custom(type, base))).toThrow(
      `"c" is of type ${type} (${base}), which pg_search cannot match words in`,
    );
  }

  for (const [type, reason] of [
    ["timestamp(3) with time zone", "its text follows the session's settings"],
    ["interval day to second", "its text follows the session's settings"],
    ["int4range", "PostgreSQL does not count the text of a range or an array"],
    ["datemultirange", "PostgreSQL does not count the text of a range"],
    ["_text", "PostgreSQL does not count the text of a range or an array"],
    // A text type with a length, as an array.
    [
      "varchar(40)[]",
      "PostgreSQL does not count the text of a range or an array",
    ],
    [
      "character varying(10)[]",
      "PostgreSQL does not count the text of a range or an array",
    ],
    ["char(3)[]", "PostgreSQL does not count the text of a range or an array"],
  ] as const) {
    expect(() => declare(fullText, custom(type))).toThrow(
      `symmetria: fullText() cannot read "c", which is of type ${type}: ${reason}`,
    );
  }

  expect(() => declare(fullText, custom("int4"))).not.toThrow();
});

test("a meaning over a timestamp, a custom type or its own key reads each as an insert does", async () => {
  const path = customType<string>("ltree", {
    encode: (value: string) => value,
    decode: (value: unknown) => String(value),
  });
  const { model, asked } = counting();
  const calls: CompiledQuery[] = [];
  const pages: Record<string, unknown>[][] = [
    [
      {
        id: 7,
        title: "Intro",
        at: "2026-11-23 10:00:00+00",
        path: "docs.intro",
        __symmetria_key: "7",
        __symmetria_stored_1: "2026-11-23 10:00:00+00",
        __symmetria_stored_2: "docs.intro",
        __symmetria_stored_3: "7",
      },
    ],
    [],
  ];
  const database = schema(
    {
      pages: table({
        id: int.auto,
        title: text,
        at: timestamptz.nullable,
        path: path.nullable,
      }).search((page) => ({
        // A meaning's types take text columns; any column reads at run time.
        about: {
          meaning: model(
            page.title,
            page.at as never,
            page.path,
            page.id as never,
          ),
        },
      })),
    },
    {
      executor: async (query) => {
        calls.push(query);

        return query.sql.startsWith("SELECT")
          ? (pages.shift() ?? [])
          : { rows: [], affectedRows: 1 };
      },
    },
  );

  expect(await database.pages.search.reindex()).toBe(1);
  // A timestamp or a number is never empty text, so it is enough that it is
  // not NULL; no left(ltree), so a type not known is read as its text.
  expect(calls[0]!.sql).toContain(
    [
      hasTextSQL('"pages"."title"'),
      '("pages"."at" IS NOT NULL)',
      hasTextSQL('concat("pages"."path")'),
      '("pages"."id" IS NOT NULL)',
    ].join(" OR "),
  );
  // Each is read through its codec, as a query reads it, and as stored, to
  // see that it did not change while the model was asked.
  expect(calls[0]!.sql).toContain(
    `SELECT "pages"."id" AS "id", "pages"."title" AS "title", "pages"."at" AS "at", "pages"."path" AS "path", ("pages"."id")::text AS "__symmetria_key", concat("pages"."at") AS "__symmetria_stored_1", concat("pages"."path") AS "__symmetria_stored_2", concat("pages"."id") AS "__symmetria_stored_3"`,
  );
  // The model gets the text an insert of those values gets.
  expect(asked.map((entry) => entry.texts)).toEqual([
    ["Intro\n\n2026-11-23T10:00:00.000Z\n\ndocs.intro\n\n7"],
  ]);
  const update = calls.find((call) => call.sql.startsWith("UPDATE"))!;

  expect(update.sql).toContain(
    `"pages"."id" IN ($2) AND "pages"."about" IS NULL AND (jsonb_build_array(concat("pages"."title"), concat("pages"."at"), concat("pages"."path"), concat("pages"."id")) = (($3::text::jsonb) -> ("pages"."id")::text)) = (TRUE)`,
  );
  expect(update.parameters).toEqual([
    JSON.stringify({ 7: "[46,1]" }),
    7,
    JSON.stringify({
      7: ["Intro", "2026-11-23 10:00:00+00", "docs.intro", "7"],
    }),
  ]);
});

test("a stored document reads a jsonb column as JSON and keeps a custom type as it was", () => {
  const email = customType<string>("email", {
    encode: (value: string) => value,
    decode: (value: unknown) => String(value),
  });
  const snapshot = schema({
    docs: table({
      id: int.auto,
      meta: jsonb<string>().nullable,
      floor: int,
      mail: email,
    }).search((doc) => ({
      about: {
        words: fullText({
          A: doc.meta,
          B: doc.floor as never,
          C: doc.mail,
        }),
      },
    })),
  }).$snapshot();

  // A custom type (a domain over text) keeps the expression of the column
  // its documents were stored with; jsonb and integer were refused before.
  expect(
    snapshot.tables[0]!.columns.find((column) => column.name === "aboutWords")!
      .generated,
  ).toBe(
    `setweight(to_tsvector('simple', coalesce("meta", '{}')), 'A') || setweight(to_tsvector('simple', coalesce(("floor")::text, '')), 'B') || setweight(to_tsvector('simple', coalesce("mail", '')), 'C')`,
  );
});
