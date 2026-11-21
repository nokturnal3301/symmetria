import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  bigint,
  uuid,
  text,
} from "../../../packages/runtime/src";
import { embedder } from "../../../packages/runtime/src/entries/search";
import { testDatabase } from "../../../packages/kit/src/testing";
import type { PostgresDriver } from "../../../packages/runtime/src/entries/pg";
import { postgres } from "../../support/postgres";
import { hasExtension } from "../../support/extensions";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
const withVector = await hasExtension(databaseUrl, "vector");

/** A stand-in model: the vector is the text's length and its word count. */
const embedded: string[][] = [];
let during: ((texts: readonly string[]) => Promise<void>) | undefined;
const lengths = embedder(
  2,
  async (texts) => {
    embedded.push([...texts]);
    await during?.(texts);

    return texts.map((value) => [value.length, value.split(/\s+/).length]);
  },
  { name: "lengths" },
);

const messages = table({
  id: int.auto,
  owner: text,
  title: text.nullable,
  body: text.nullable,
}).search((message) => ({
  about: { meaning: lengths(message.title, message.body) },
}));
const notes = table({ id: uuid.v4, body: text }).search((note) => ({
  about: { meaning: lengths(note.body) },
}));
const events = table({ id: bigint.auto, body: text }).search((event) => ({
  about: { meaning: lengths(event.body) },
}));
const model = schema({ messages, notes, events });

describe.skipIf(!withVector)("reindex() and missing() on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;
  const statements: string[] = [];

  /** Embeddings as PostgreSQL holds them, by key. */
  const stored = async (name: string) =>
    Object.fromEntries(
      (
        (await isolated.driver.execute({
          sql: `SELECT id::text AS id, about::text AS about FROM "${name}" ORDER BY id`,
          parameters: [],
        })) as unknown as { rows: { id: string; about: string | null }[] }
      ).rows.map((row) => [row.id, row.about]),
    );

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_reindex",
      max: 4,
      // Every statement the database receives outside a transaction.
      driver: (options) => {
        const inner = postgres(options) as PostgresDriver;

        return {
          ...inner,
          execute: (query) => {
            statements.push(query.sql);

            return inner.execute(query);
          },
        } as PostgresDriver;
      },
    });
    database = isolated.database;

    // Written with their own (wrong) vectors, so nothing is embedded yet; then
    // the vectors are cleared, as rows from before the search was declared.
    await database.messages.insert(
      Array.from({ length: 7 }, (_, index) => ({
        owner: index < 5 ? "ada" : "grace",
        title: index === 3 ? null : `Title ${index}`,
        body: index === 3 ? "" : `body number ${index}`,
        about: [0, 0],
      })),
    );
    await database.messages.insert([
      { owner: "ada", title: "", body: null, about: [0, 0] },
      { owner: "ada", title: null, body: null, about: [0, 0] },
    ]);
    await isolated.driver.execute({
      sql: "UPDATE messages SET about = NULL",
      parameters: [],
    });
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("rows without text are never read; one UPDATE per batch", async () => {
    // Rows 4, 8 and 9 have no text: nothing to embed, so nothing to count.
    expect(await database.messages.search.missing()).toBe(6);
    expect(
      await database.messages.search.missing({ where: { owner: "grace" } }),
    ).toBe(2);

    statements.length = 0;
    embedded.length = 0;
    expect(await database.messages.search.reindex({ batch: 4 })).toBe(6);
    expect(embedded.map((texts) => texts.length)).toEqual([4, 2]);
    expect(statements.filter((sql) => sql.startsWith("UPDATE"))).toHaveLength(
      2,
    );
    // Two pages and the empty one that ends the walk.
    expect(statements.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(
      3,
    );

    const vectors = await stored("messages");

    expect(vectors["1"]).toBe(`[${"Title 0\n\nbody number 0".length},5]`);
    expect(vectors["4"]).toBeNull();
    expect(vectors["8"]).toBeNull();
    expect(vectors["9"]).toBeNull();

    // A second call reads one empty page and asks the model nothing.
    statements.length = 0;
    embedded.length = 0;
    expect(await database.messages.search.reindex()).toBe(0);
    expect(await database.messages.search.missing()).toBe(0);
    expect(embedded).toEqual([]);
    expect(statements.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(
      2,
    );
  });

  test("order: desc starts from the highest key", async () => {
    await isolated.driver.execute({
      sql: "UPDATE messages SET about = NULL WHERE id IN (1, 2, 6)",
      parameters: [],
    });
    embedded.length = 0;
    expect(
      await database.messages.search.reindex({ order: "desc", batch: 2 }),
    ).toBe(3);
    expect(embedded).toEqual([
      ["Title 5\n\nbody number 5", "Title 1\n\nbody number 1"],
      ["Title 0\n\nbody number 0"],
    ]);
  });

  test("a row whose text changes while the model answers keeps no stale embedding", async () => {
    await isolated.driver.execute({
      sql: "UPDATE messages SET about = NULL WHERE id IN (1, 2)",
      parameters: [],
    });
    // While the model is asked: row 1 is edited (its embedding stays NULL,
    // the text is new), and row 2 gets an embedding from another writer.
    during = async () => {
      during = undefined;
      await database.messages.byId(1).update({ body: "edited meanwhile" });
      await isolated.driver.execute({
        sql: "UPDATE messages SET about = '[99,99]' WHERE id = 2",
        parameters: [],
      });
    };

    expect(await database.messages.search.reindex()).toBe(0);

    let vectors = await stored("messages");

    expect(vectors["1"]).toBeNull();
    expect(vectors["2"]).toBe("[99,99]");

    // The next call embeds the text the row has now.
    expect(await database.messages.search.reindex()).toBe(1);
    vectors = await stored("messages");
    expect(vectors["1"]).toBe(`[${"Title 0\n\nedited meanwhile".length},4]`);
  });

  test("uuid and bigint keys, and a scope that bounds the work", async () => {
    await database.notes.insert([
      { body: "first note", about: [0, 0] },
      { body: "second longer note", about: [0, 0] },
    ]);
    await database.events.insert([
      { body: "an event", about: [0, 0] },
      { body: "another event here", about: [0, 0] },
    ]);
    await isolated.driver.execute({
      sql: "UPDATE notes SET about = NULL; UPDATE events SET about = NULL",
      parameters: [],
    });

    expect(await database.notes.search.reindex()).toBe(2);
    expect(Object.values(await stored("notes")).sort()).toEqual(
      ["[10,2]", "[18,3]"].sort(),
    );
    expect(await database.events.search.reindex({ order: "desc" })).toBe(2);
    expect(await stored("events")).toEqual({ "1": "[8,2]", "2": "[18,3]" });

    await isolated.driver.execute({
      sql: "UPDATE messages SET about = NULL",
      parameters: [],
    });

    const grace = database.$scope({
      messages: (message) => message.owner.is("grace"),
    });

    expect(await grace.messages.search.missing()).toBe(2);
    expect(await grace.messages.search.reindex()).toBe(2);
    expect(await database.messages.search.missing()).toBe(4);
  });
});
