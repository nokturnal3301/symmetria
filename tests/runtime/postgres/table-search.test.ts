import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  int,
  text,
  sql,
  type Predicate,
} from "../../../packages/runtime/src";
import {
  bm25,
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import { testDatabase } from "../../../packages/kit/src/testing";
import { hasExtension } from "../../support/extensions";

/**
 * Stands in for an embedding model: every topic has a direction, and a text
 * points towards the topics whose words it contains, in any language.
 */
const TOPICS = [
  ["garage", "гараж", "гаража", "keys", "ключи", "car", "машина", "автомобиль"],
  ["soup", "борщ", "борща", "recipe", "рецепт", "beet", "свёкла"],
  ["database", "postgres", "index", "vacuum"],
];
const direction = (value: string): number[] => {
  const words = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = TOPICS.map(
    (topic) => words.filter((word) => topic.includes(word)).length,
  );
  const length = Math.hypot(...vector);

  return length ? vector.map((component) => component / length) : [1, 1, 1];
};
const asked: { kind: string; count: number }[] = [];
const topics = embedder(
  3,
  async (texts, kind) => {
    asked.push({ kind, count: texts.length });

    return texts.map(direction);
  },
  { name: "topics" },
);

/** The hidden embedding is a column by name, though not part of the typed row. */
const unembedded = (chunk: object) =>
  (chunk as { about: { is: (value: null) => Predicate } }).about.is(null);

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
const withVector = await hasExtension(databaseUrl, "vector");
const withBm25 = withVector && (await hasExtension(databaseUrl, "pg_search"));

const model = (words: typeof fullText | typeof bm25) => {
  const notes = table({ id: int.auto, title: text, chunks: many.cascade });
  const chunks = table({
    id: int.auto,
    note: one(notes.chunks),
    owner: text,
    title: text,
    content: text,
  }).search((chunk) => ({
    about: {
      words: words({ A: chunk.title, B: chunk.content }),
      meaning: topics(chunk.title, chunk.content),
    },
  }));

  return schema({ notes, chunks });
};

const suite = (name: string, words: typeof fullText | typeof bm25) => () => {
  const searched = model(words);
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof searched>>>;
  let database: typeof isolated.database;

  // Both suites share the model; each counts from where it started.
  let started = 0;

  beforeAll(async () => {
    started = asked.length;
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: searched,
      prefix: `symmetria_search_${name}`,
      max: 2,
      searchPath: ["public", "paradedb"],
    });
    database = isolated.database;

    const note = await database.notes.insert({ title: "Home" }).returning("id");

    await database.chunks.insert([
      {
        noteId: note.id,
        owner: "ada",
        title: "Гараж",
        content: "Ключи от гаража лежат в синей коробке.",
      },
      {
        noteId: note.id,
        owner: "ada",
        title: "Обед",
        content: "Рецепт борща: свёкла и два часа времени.",
      },
      {
        noteId: note.id,
        owner: "ada",
        title: "Работа",
        content: "Postgres vacuum and index notes.",
      },
      {
        noteId: note.id,
        owner: "ada",
        title: "Стоянка",
        content: "Автомобиль стоит во дворе, машина заперта.",
      },
      {
        noteId: note.id,
        owner: "grace",
        title: "Гараж",
        content: "Ключи от гаража у соседа.",
      },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("rows are written with their embeddings, asked for once", async () => {
    expect(asked.slice(started, started + 1)).toEqual([
      { kind: "document", count: 5 },
    ]);
    expect(
      await database.chunks({ where: (chunk) => unembedded(chunk) }).count(),
    ).toBe(0);
    expect(Object.keys((await database.chunks({ limit: 1 }))[0]!)).toEqual([
      "id",
      "noteId",
      "owner",
      "title",
      "content",
    ]);
  });

  test("words and meaning are merged, best first, inside the filter", async () => {
    const rows = await database.chunks.search(
      (chunk) => ({ title: chunk.title, note: chunk.note.title }),
      { where: { owner: "ada" }, about: "Где ключи от гаража?", limit: 3 },
    );

    // The garage note matches both ways; the parking note only by meaning
    // (no word of the question is in it), and grace's note is filtered out.
    expect(rows.slice(0, 2)).toEqual([
      { title: "Гараж", note: "Home" },
      { title: "Стоянка", note: "Home" },
    ]);
    expect(rows.partial).toBeUndefined();
  });

  test("each way of searching also works by itself", async () => {
    const byWords = await database.chunks.search(
      (chunk) => ({ title: chunk.title }),
      {
        about: { text: "борща" },
        where: { owner: "ada" },
        candidates: 10,
        limit: 1,
      },
    );

    expect(byWords).toEqual([{ title: "Обед" }]);

    const byMeaning = await database.chunks.search(
      (chunk) => ({ title: chunk.title }),
      { about: direction("postgres"), where: { owner: "ada" }, limit: 1 },
    );

    expect(byMeaning).toEqual([{ title: "Работа" }]);
    expect(
      (await database.chunks.search({ about: "гаража", limit: 10 })).map(
        (row) => row.owner,
      ),
    ).toContain("grace");
  });

  test("an UPDATE of the text clears the embedding and reindex() restores it", async () => {
    const before = asked.length;
    const [soup] = await database.chunks({ where: { title: "Обед" } });

    await database.chunks
      .byId(soup!.id)
      .update({ content: "Ключи от машины в гараже." });
    expect(
      await database.chunks({ where: (chunk) => unembedded(chunk) }).count(),
    ).toBe(1);

    // Until it is embedded again the row is still found by its words.
    const found = await database.chunks.search((chunk) => ({ id: chunk.id }), {
      about: { text: "машины" },
      where: { owner: "ada" },
    });

    expect(found.map((row) => row.id)).toContain(soup!.id);
    expect(await database.chunks.search.reindex()).toBe(1);
    expect(await database.chunks.search.reindex()).toBe(0);
    expect(
      asked.slice(before).filter((entry) => entry.kind === "document"),
    ).toEqual([{ kind: "document", count: 1 }]);

    const nearest = await database.chunks.search(
      (chunk) => ({ id: chunk.id }),
      {
        about: direction("garage car"),
        where: { owner: "ada" },
        limit: 3,
      },
    );

    expect(nearest.map((row) => row.id)).toContain(soup!.id);
  });

  test("a scope and a transaction bound the search like any query", async () => {
    const scoped = database.$scope({
      chunks: (chunk) => chunk.owner.is("grace"),
    });

    expect(
      (await scoped.chunks.search({ about: "ключи гаража" })).map(
        (row) => row.owner,
      ),
    ).toEqual(["grace"]);

    await expect(
      database.$transaction(async (transaction) => {
        await transaction.chunks.delete({ where: { owner: "grace" } });

        const rows = await transaction.chunks.search({
          about: "ключи гаража",
          limit: 10,
        });

        expect(rows.map((row) => row.owner)).not.toContain("grace");

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await database.chunks({ where: { owner: "grace" } }).count()).toBe(
      1,
    );
  });

  test("children created by a nested insert are embedded too", async () => {
    const before = asked.length;

    await database.notes.insert({
      title: "Nested",
      chunks: {
        create: [
          { owner: "nested", title: "Суп", content: "Борщ и свёкла." },
          { owner: "nested", title: "База", content: "Postgres index." },
        ],
      },
    });
    expect(
      await database
        .chunks({
          where: (chunk) => [chunk.owner.is("nested"), unembedded(chunk)],
        })
        .count(),
    ).toBe(0);
    expect(asked.length).toBeGreaterThan(before);
  });
};

describe.skipIf(!withVector)(
  "search by full text and meaning on PostgreSQL",
  suite("fulltext", fullText),
);
describe.skipIf(!withBm25)(
  "search by BM25 and meaning on PostgreSQL with pg_search",
  suite("bm25", bm25),
);

/** A model that answers with the length of each text, and records what it was asked. */
const lengthsAsked: string[] = [];
const lengths = embedder(
  2,
  async (texts) => {
    lengthsAsked.push(...texts);

    return texts.map((value) => [value.length, 1]);
  },
  { name: "lengths" },
);
const written = schema({
  docs: table({
    id: int.auto,
    slug: text.unique,
    title: text,
    content: text.nullable,
  }).search((doc) => ({
    about: { meaning: lengths(doc.title, doc.content) },
  })),
});

describe.skipIf(!withVector)("embedded writes on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof written>>>;
  let database: typeof isolated.database;

  const stored = async (slug: string) =>
    (
      (await isolated.driver.execute({
        sql: "SELECT title, content, about::text AS about FROM docs WHERE slug = $1",
        parameters: [slug],
      })) as { rows: unknown[] }
    ).rows[0] as {
      title: string;
      content: string | null;
      about: string | null;
    };

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: written,
      prefix: "symmetria_search_writes",
      max: 2,
      searchPath: ["public"],
    });
    database = isolated.database;
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("an upsert stores the embedding of the text the row ends up with", async () => {
    await database.docs.insert([
      { slug: "a", title: "first", content: "keys" },
      { slug: "b", title: "first", content: null },
      { slug: "c", title: "first", content: null },
    ]);

    // An update list of the text columns, without the embedding.
    await database.docs.upsert(
      { slug: "b", title: "second text", content: null },
      { by: "slug", update: ["title", "content"] },
    );
    await database.docs
      .insert({ slug: "c", title: "second text", content: null })
      .onConflict("slug")
      .doUpdate("title", "content");
    expect(await stored("b")).toMatchObject({ about: "[11,1]" });
    expect(await stored("c")).toMatchObject({ about: "[11,1]" });

    // The update replaces the title and keeps content, which the model did
    // not see: the embedding is left for reindex() instead of guessed.
    await database.docs.upsert({ slug: "a", title: "soup" }, { by: "slug" });
    expect(await stored("a")).toEqual({
      title: "soup",
      content: "keys",
      about: null,
    });
    expect(await database.docs.search.missing()).toBe(1);

    // One row without text does not make the others look different.
    await database.docs.upsert(
      [
        { slug: "d", title: "has text", content: null },
        { slug: "e", title: "", content: null },
      ],
      { by: "slug" },
    );
    expect(await stored("d")).toMatchObject({ about: "[8,1]" });
    expect(await stored("e")).toMatchObject({ about: null });
  });

  test("a row with an SQL expression in its text is written without an embedding", async () => {
    lengthsAsked.length = 0;
    await database.docs.insert({
      slug: "s",
      title: "garage",
      content: sql<string>`'keys are in the ' || 'blue box'`,
    });

    expect(lengthsAsked).toEqual([]);
    expect(await stored("s")).toEqual({
      title: "garage",
      content: "keys are in the blue box",
      about: null,
    });
  });
});

const worded = schema({
  pages: table({ id: int.auto, body: text }).search((page) => ({
    find: { words: fullText(page.body) },
  })),
});

describe.skipIf(!databaseUrl)("search by words in any script", () => {
  test("words with combining marks, and e-mail addresses, are found", async () => {
    const isolated = await testDatabase({
      url: databaseUrl!,
      schema: worded,
      prefix: "symmetria_search_words",
      max: 1,
    });

    try {
      for (const [body, word] of [
        ["यह हिन्दी भाषा है", "हिन्दी"],
        ["กุญแจ รถ อยู่ ที่ไหน", "กุญแจ"],
        ["le café est fermé".normalize("NFD"), "café".normalize("NFD")],
        ["write to ada@example.com today", "ada@example.com"],
      ] as const) {
        const { id } = await isolated.database.pages
          .insert({ body })
          .returning("id");

        expect(
          await isolated.database.pages.search((page) => ({ id: page.id }), {
            find: word,
          }),
        ).toContainEqual({ id });
      }
    } finally {
      await isolated.close();
    }
  });
});
