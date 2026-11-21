import { expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  int,
  text,
  uuid,
  type CompiledQuery,
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

      return rows;
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

        return [];
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
  ).rejects.toThrow("custom returned 1 numbers; 2 expected");
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
      '"search_about_meaning_exact" AS (SELECT "chunks"."id" AS "id", ROW_NUMBER() OVER (ORDER BY (("chunks"."about" <=> $2::text::vector)) + 0 ASC, "chunks"."id" ASC) AS "position", (("chunks"."about" <=> $2::text::vector)) + 0 AS "rank"',
      'FROM "chunks" AS "chunks"',
      'WHERE (SELECT COUNT(*) AS "matches"',
      'FROM "search_about_meaning_probe" AS "search_about_meaning_probe") <= $3 AND "chunks"."owner" = $4 AND "chunks"."about" IS NOT NULL',
      'ORDER BY (("chunks"."about" <=> $2::text::vector)) + 0 ASC, "chunks"."id" ASC',
      "LIMIT 40),",
      '"search_about_meaning" AS (SELECT "chunks"."id" AS "id", ROW_NUMBER() OVER (ORDER BY ("chunks"."about" <=> $5::text::vector) ASC) AS "position", ("chunks"."about" <=> $5::text::vector) AS "rank"',
      'FROM "chunks" AS "chunks"',
      `WHERE (SELECT CASE WHEN current_setting('hnsw.iterative_scan', true) IS NULL THEN '' ELSE set_config('hnsw.iterative_scan', 'strict_order', true) END || CASE WHEN current_setting('hnsw.max_scan_tuples', true) IS NULL THEN '' ELSE set_config('hnsw.max_scan_tuples', '2147483647', true) END) IS NOT NULL AND (SELECT COUNT(*) AS "matches"`,
      'FROM "search_about_meaning_probe" AS "search_about_meaning_probe") > $6 AND "chunks"."owner" = $7 AND "chunks"."about" IS NOT NULL',
      'ORDER BY ("chunks"."about" <=> $5::text::vector) ASC',
      "LIMIT 40),",
      '"search_fused" AS (SELECT coalesce("search_about_meaning_exact"."id", "search_about_meaning"."id") AS "id", (coalesce(1.0 / (60 + "search_about_meaning_exact"."position"), 0)) + (coalesce(1.0 / (60 + "search_about_meaning"."position"), 0)) AS "score"',
      'FROM "search_about_meaning_exact" AS "search_about_meaning_exact"',
      'FULL JOIN "search_about_meaning" AS "search_about_meaning" ON ("search_about_meaning_exact"."id" = "search_about_meaning"."id")),',
      `"search_about_words" AS (SELECT "chunks"."id" AS "id", ROW_NUMBER() OVER (ORDER BY ts_rank("chunks"."about_words", to_tsquery('simple', $8)) DESC, "chunks"."id" ASC) AS "position", ts_rank("chunks"."about_words", to_tsquery('simple', $8)) AS "rank"`,
      'FROM "chunks" AS "chunks"',
      `WHERE "chunks"."owner" = $9 AND "chunks"."about_words" @@ to_tsquery('simple', $10)`,
      `ORDER BY ts_rank("chunks"."about_words", to_tsquery('simple', $8)) DESC, "chunks"."id" ASC`,
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
  // Any of the question's words matches; punctuation cannot reach the query syntax.
  expect(parameters).toEqual([
    "u",
    "[19,1]",
    10000,
    "u",
    "[19,1]",
    10000,
    "u",
    "where | are | the | keys",
    "u",
    "where | are | the | keys",
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
    'ORDER BY (("chunks"."about" <=> $2::text::vector)) + 0 ASC, "chunks"."id" ASC',
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

  expect(zero.parameters).toContain("database");
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
        : { rows: [], affectedRows: query.parameters.length === 5 ? 2 : 1 };
    },
  });

  expect(await database.chunks.search.reindex({ batch: 2 })).toBe(3);
  expect(asked.map((entry) => entry.texts)).toEqual([
    ["A\n\none", "C"],
    ["B\n\nthree"],
  ]);

  const selects = calls.filter((call) => call.sql.startsWith("SELECT"));

  expect(selects).toHaveLength(3);
  // Rows without text are left out by the query itself, so no call reads them again.
  expect(selects[0]!.sql).toContain(
    `WHERE "chunks"."about" IS NULL AND ((concat_ws($1, NULLIF("chunks"."title", ''), NULLIF("chunks"."content", ''))) <> '') = (TRUE)`,
  );
  // Pages continue after the last key.
  expect(selects[1]!.sql).toContain('AND "chunks"."id" > $2');
  expect(selects[1]!.parameters).toEqual(["\n\n", 2]);

  // One UPDATE per batch, which keeps an embedding written meanwhile and
  // skips a row whose text changed while the model was asked.
  const updates = calls.filter((call) => call.sql.startsWith("UPDATE"));

  expect(updates).toHaveLength(2);
  expect(updates[0]!.sql).toBe(
    `UPDATE "chunks" AS "chunks" SET "about" = (($1::text::jsonb) ->> ("chunks"."id")::text)::vector(2)\nWHERE ("chunks"."id" IN ($2, $3) AND "chunks"."about" IS NULL AND ((concat_ws($4, NULLIF("chunks"."title", ''), NULLIF("chunks"."content", ''))) = (($5::text::jsonb) ->> ("chunks"."id")::text)) = (TRUE))`,
  );
  expect(updates[0]!.parameters).toEqual([
    JSON.stringify({ 1: "[6,1]", 2: "[1,1]" }),
    1,
    2,
    "\n\n",
    JSON.stringify({ 1: "A\n\none", 2: "C" }),
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
    `WHERE "chunks"."owner" = $1 AND "chunks"."about" IS NULL AND ((concat_ws(`,
  );
  await expect(
    database.chunks.search.reindex({ order: "newest" as never }),
  ).rejects.toThrow('reindex() order is "asc" or "desc"');
});
