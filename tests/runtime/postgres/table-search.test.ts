import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  one,
  many,
  int,
  text,
  uuid,
  date,
  numeric,
  inet,
  jsonb,
  oneOf,
  sql,
  type Predicate,
} from "../../../packages/runtime/src";
import {
  bm25,
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import { voyage } from "../../../packages/runtime/src/entries/voyage";
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
  test("words with combining marks, e-mail addresses, paths and signs are found, cased as PostgreSQL cases them", async () => {
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
        // PostgreSQL lowercases the question as it lowercased the document.
        ["Flights to İstanbul", "İstanbul"],
        ["ΟΔΟΣ ΑΘΗΝΑΣ", "ΟΔΟΣ"],
        // The parser keeps a path's slash, a number's sign, a URL's query.
        ["Edit /etc/hosts and restart", "/etc/hosts"],
        ["set it to -5 degrees", "-5"],
        ["then run ./run.sh again", "./run.sh"],
        ["open https://x.org/a/b?c=1 now", "https://x.org/a/b?c=1"],
        // Every word is also asked bare, as 3.5.0 asked it: what that found
        // is still found.
        ["we talk about postgres here", "/postgres"],
        ["version v1.2 shipped", "v1.2-"],
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

      // Punctuation that PostgreSQL's parser drops asks for nothing more:
      // the same rows come, ranked the same.
      const found = (question: string) =>
        isolated.database.pages.search((page) => ({ id: page.id }), {
          find: question,
        });

      expect(await found(`"Edit" (the) /etc/hosts, to -5? v1.2!`)).toEqual(
        await found("Edit the /etc/hosts to -5 v1.2"),
      );
    } finally {
      await isolated.close();
    }
  });

  test("a jsonb and an integer column are stored as searchDocument() reads them", async () => {
    // Before, the generated column read them as coalesce(meta, ''), which
    // PostgreSQL refused: '' is no JSON and no integer.
    const isolated = await testDatabase({
      url: databaseUrl!,
      schema: schema({
        notes: table({
          id: int.auto,
          title: text,
          meta: jsonb<{ note: string }>().nullable,
          floor: int,
        }).search((note) => ({
          find: {
            words: fullText({
              A: note.title,
              B: [note.meta as never as typeof note.title, note.floor as never],
            }),
          },
        })),
      }),
      prefix: "symmetria_search_words_json",
      max: 1,
    });

    try {
      await isolated.database.notes.insert([
        { title: "first", meta: { note: "gamma ray" }, floor: 42 },
        { title: "second", meta: null, floor: 7 },
      ]);
      const found = (question: string) =>
        isolated.database.notes.search((note) => ({ id: note.id }), {
          find: question,
        });

      expect(await found("gamma")).toEqual([{ id: 1 }]);
      // A key of the document is no word.
      expect(await found("note")).toEqual([]);
      expect(await found("7")).toEqual([{ id: 2 }]);
    } finally {
      await isolated.close();
    }
  });
});

/** A model that takes a while, as any network model does. */
const slow = embedder(
  2,
  async (texts) => {
    await new Promise((resolve) => setTimeout(resolve, 20));

    return texts.map((value) => [value.length, 1]);
  },
  { name: "slow" },
);
// A service that accepts a request and never answers.
const silent = Bun.serve({
  port: 0,
  fetch: () => new Promise<Response>(() => {}),
});
const unanswered = voyage("voyage-4", {
  apiKey: "k",
  baseUrl: `http://127.0.0.1:${silent.port}/v1`,
  size: 2,
  timeoutMs: 100,
});
const ordered = schema({
  logs: table({ id: int.auto, body: text }),
  chunks: table({
    id: int.auto,
    tenant: text,
    body: text,
    kind: oneOf("note", "faq").nullable,
    ref: uuid.nullable,
    day: date.nullable,
    price: numeric(10, 2).nullable,
    host: inet.nullable,
  }).search((chunk) => ({
    about: {
      words: fullText([chunk.body, chunk.ref, chunk.price, chunk.host]),
      meaning: slow(
        chunk.body,
        chunk.kind,
        chunk.ref,
        chunk.day,
        chunk.price,
        chunk.host,
      ),
    },
  })),
  hung: table({ id: int.auto, body: text }).search((row) => ({
    about: { meaning: unanswered(row.body) },
  })),
});

describe.skipIf(!withVector)("models in transactions on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof ordered>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: ordered,
      prefix: "symmetria_search_ordered",
      max: 2,
      searchPath: ["public"],
    });
    database = isolated.database;
  });

  afterAll(async () => {
    await isolated?.close();
    silent.stop(true);
  });

  test("a write or a search that waits for a model keeps its place in the transaction's order", async () => {
    const [counted, seen, found] = await database.$transaction(async (tx) => {
      const [, count] = await Promise.all([
        tx.chunks.insert({ tenant: "a", body: "first" }),
        tx.chunks.count(),
      ]);
      const [, rows] = await Promise.all([
        tx.chunks.insert({ tenant: "a", body: "second" }),
        tx.chunks((chunk) => ({ body: chunk.body }), {
          orderBy: (chunk) => chunk.id.ascending,
        }),
      ]);
      // Started first, the search does not see the row written after it.
      const [results] = await Promise.all([
        tx.chunks.search((chunk) => ({ body: chunk.body }), {
          about: "third",
          limit: 10,
        }),
        tx.chunks.insert({ tenant: "a", body: "third" }),
      ]);

      return [count, rows.map((row) => row.body), results.length];
    });

    expect(counted).toBe(1);
    expect(seen).toEqual(["first", "second"]);
    expect(found).toBe(2);
  });

  test("a search kept and awaited again sees new rows and the current tenant", async () => {
    let tenant = "x";
    const scoped = database.$scope({
      chunks: (chunk) => chunk.tenant.is(tenant),
    });
    const kept = scoped.chunks.search((chunk) => ({ tenant: chunk.tenant }), {
      about: "kept",
      limit: 10,
    });

    expect(await kept).toEqual([]);
    await database.chunks.insert([
      { tenant: "x", body: "kept x" },
      { tenant: "y", body: "kept y" },
    ]);
    expect(await kept).toEqual([{ tenant: "x" }]);
    tenant = "y";
    expect(await kept).toEqual([{ tenant: "y" }]);
  });

  test("a model that does not answer fails the write after its timeout and leaves the transaction usable", async () => {
    const started = Date.now();
    const outcome = await database.$transaction(async (tx) => {
      const write = await tx.hung.insert({ body: "never embedded" }).then(
        () => "written",
        (error: Error) => error.message,
      );

      await tx.logs.insert({ body: "after the timeout" });

      return write;
    });

    expect(outcome).toBe(
      "symmetria: Voyage did not answer within 100 ms when asked to embed with voyage-4 (timeoutMs sets how long to wait)",
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await database.hung.count()).toBe(0);
    expect(await database.logs.count()).toBe(1);
  });

  test("sources that are not text are read as their text by words, missing() and reindex()", async () => {
    const ref = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const { id } = await database.chunks
      .insert({
        tenant: "t",
        body: "Opening hours",
        kind: "faq",
        ref,
        day: "2024-01-31",
        price: "12.50",
        host: "10.0.0.1",
      })
      .returning("id");
    // Only spaces, as JavaScript's \s counts them: nothing to embed, and
    // nothing missing() counts.
    await database.chunks.insert({ tenant: "t", body: "\u00a0\ufeff " });

    for (const word of [ref, "12.50", "10.0.0.1"]) {
      expect(
        await database.chunks.search((chunk) => ({ id: chunk.id }), {
          about: { text: word, vector: [1, 1] },
          limit: 50,
        }),
      ).toContainEqual({ id });
    }

    await database.chunks.update(
      { body: "Opening hours on Sunday" },
      { where: (chunk) => chunk.id.is(id) },
    );
    expect(await database.chunks.search.missing()).toBe(1);
    expect(await database.chunks.search.reindex()).toBe(1);
    expect(await database.chunks.search.missing()).toBe(0);

    const [stored] = (
      (await isolated.driver.execute({
        sql: "SELECT about::text AS about FROM chunks WHERE id = $1",
        parameters: [id],
      })) as unknown as { rows: { about: string }[] }
    ).rows;

    expect(stored!.about).toBe(
      `[${["Opening hours on Sunday", "faq", ref, "2024-01-31", "12.50", "10.0.0.1"].join("\n\n").length},1]`,
    );
  });
});
