import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  bigint,
  uuid,
  text,
  timestamptz,
  tsvector,
  bytea,
  bool,
  doublePrecision,
  real,
  jsonb,
  customType,
  createDatabase,
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

describe.skipIf(!withVector)("reindex() under legacy string settings", () => {
  test("spaces are the same with standard_conforming_strings off", async () => {
    const isolated = await testDatabase({
      url: databaseUrl!,
      schema: schema({
        items: table({ id: int.auto, body: text }).search((item) => ({
          about: { meaning: lengths(item.body) },
        })),
      }),
      prefix: "symmetria_reindex_legacy",
      max: 1,
      // A session that reads backslashes in plain string literals itself.
      driver: (options) => {
        const legacy = new URL(options.url!);

        // Added to the options that isolate the test's schema.
        legacy.searchParams.set(
          "options",
          `${legacy.searchParams.get("options") ?? ""} -c standard_conforming_strings=off`.trim(),
        );

        return postgres({ ...options, url: legacy.toString() });
      },
    });

    try {
      // Written without embeddings: "v" is a letter, a vertical tab and a
      // no-break space are spaces, as insert() counts them.
      await isolated.driver.execute({
        sql: "INSERT INTO items (body) VALUES ($1), ($2), ($3), ($4), ($5)",
        parameters: ["vvv", "v v", "\v\v", " ﻿", "hello"],
      });
      const [setting] = (
        (await isolated.driver.execute({
          sql: "SELECT current_setting('standard_conforming_strings') AS value",
          parameters: [],
        })) as unknown as { rows: { value: string }[] }
      ).rows;

      expect(setting!.value).toBe("off");
      expect(await isolated.database.items.search.missing()).toBe(3);
      expect(await isolated.database.items.search.reindex()).toBe(3);
      expect(await isolated.database.items.search.missing()).toBe(0);
    } finally {
      await isolated.close();
    }
  });
});

describe.skipIf(!withVector)(
  "missing() and reindex() find text as insert() does",
  () => {
    test("a column with a character that is not a space has text, wherever it starts", async () => {
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          items: table({
            id: int.auto,
            title: text.nullable,
            body: text.nullable,
          }).search((item) => ({
            about: { meaning: lengths(item.title, item.body) },
          })),
        }),
        prefix: "symmetria_reindex_spaces",
        max: 1,
      });
      // [title, body]: after spaces, in the second column, a zero-width space
      // and a next-line character (no spaces to JavaScript's \s), or nothing.
      const rows = [
        ["Title", "body"],
        [" 　", "\n\tx"],
        [null, "  y"],
        ["  ", "﻿      \v\f\r"],
        ["", ""],
        [null, null],
        ["​", null],
        ["\u0085", " "],
        [" ".repeat(5000), `${" ".repeat(5000)}z`],
        [" ".repeat(5000), "\t".repeat(5000)],
      ] as const;
      const hasText = (row: readonly (string | null)[]) =>
        row.some((value) => value !== null && value.trim() !== "");

      try {
        await isolated.driver.execute({
          sql: `INSERT INTO items (title, body) SELECT * FROM unnest($1::text[], $2::text[])`,
          parameters: [rows.map((row) => row[0]), rows.map((row) => row[1])],
        });

        const expected = rows.filter(hasText).length;

        expect(expected).toBe(6);
        expect(await isolated.database.items.search.missing()).toBe(expected);
        expect(await isolated.database.items.search.reindex()).toBe(expected);
        expect(await isolated.database.items.search.missing()).toBe(0);
      } finally {
        await isolated.close();
      }
    });
  },
);

describe.skipIf(!withVector)(
  "missing() and reindex() over sources that are not plain text",
  () => {
    test("a nondeterministic collation, a timestamp, a tsvector and bytea", async () => {
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          items: table({
            id: int.auto,
            title: text,
            at: timestamptz.nullable,
            words: tsvector.nullable,
            raw: bytea.nullable,
          }).search((item) => ({
            // A meaning's types take text columns; any column reads.
            about: {
              meaning: lengths(
                item.title,
                item.at as never,
                item.words as never,
                item.raw as never,
              ),
            },
          })),
        }),
        prefix: "symmetria_reindex_types",
        max: 1,
      });
      const run = (statement: string) =>
        isolated.driver.execute({ sql: statement, parameters: [] });

      try {
        // A regular expression refuses a nondeterministic collation; no
        // timestamp is '' and there is no left() of a tsvector or bytea.
        await run(
          `CREATE COLLATION "${isolated.namespace}".case_blind (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
        );
        await run(
          `ALTER TABLE items ALTER COLUMN title TYPE text COLLATE "${isolated.namespace}".case_blind`,
        );
        await run("SET TIME ZONE 'UTC'");
        await run(
          `INSERT INTO items (title, at, words, raw) VALUES (' indented', NULL, NULL, NULL), ('', '2026-11-23 10:00:00+00', NULL, NULL), ('', NULL, 'keys:1', NULL), ('', NULL, NULL, '\\x01'), ('  ', NULL, NULL, NULL)`,
        );
        embedded.length = 0;

        expect(await isolated.database.items.search.missing()).toBe(4);
        expect(await isolated.database.items.search.reindex()).toBe(4);
        expect(await isolated.database.items.search.missing()).toBe(0);
        // Each as an insert of the value read gets it: a Date as its ISO
        // text, bytes as PostgreSQL writes them.
        expect(embedded.flat()).toEqual([
          " indented",
          "2026-11-23T10:00:00.000Z",
          "'keys':1",
          "\\x01",
        ]);
      } finally {
        await isolated.close();
      }
    });

    test("a codec that changes the stored text: embedded once, from the text it decodes", async () => {
      const encoded = customType<string>("text", {
        encode: (value) => Buffer.from(value).toString("base64"),
        decode: (value) => Buffer.from(String(value), "base64").toString(),
      });
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          items: table({ id: int.auto, body: encoded }).search((item) => ({
            about: { meaning: lengths(item.body) },
          })),
        }),
        prefix: "symmetria_reindex_codec",
        max: 1,
      });

      try {
        await isolated.database.items.insert({ body: "garage keys" });
        await isolated.driver.execute({
          sql: "UPDATE items SET about = NULL",
          parameters: [],
        });
        embedded.length = 0;

        expect(await isolated.database.items.search.missing()).toBe(1);
        expect(await isolated.database.items.search.reindex()).toBe(1);
        expect(await isolated.database.items.search.missing()).toBe(0);
        expect(await isolated.database.items.search.reindex()).toBe(0);
        expect(embedded).toEqual([["garage keys"]]);
      } finally {
        await isolated.close();
      }
    });

    test("an insert and reindex() give a row the same text: JSON, a Date, a number, a boolean", async () => {
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          items: table({
            id: int.auto,
            meta: jsonb<unknown>().nullable,
            at: timestamptz.nullable,
            size: doublePrecision.nullable,
            done: bool.nullable,
          }).search((item) => ({
            // A meaning's types take text columns; any column reads.
            about: {
              meaning: lengths(
                item.meta as never,
                item.at as never,
                item.size as never,
                item.done as never,
              ),
            },
          })),
        }),
        prefix: "symmetria_reindex_values",
        max: 1,
      });
      const rows = [
        { meta: { title: "Keys", at: [1, "x"] } },
        { meta: "hello" },
        { meta: "  " },
        { at: new Date("2026-11-23T10:00:00Z"), size: 1.5, done: false },
      ];

      try {
        embedded.length = 0;
        await isolated.database.items.insert(rows);

        const inserted = embedded.flat();

        // JSON as JSON text, keys sorted (jsonb keeps its own order), a
        // JSON string as the string, which has no text when it is only
        // spaces; a Date as its ISO text.
        expect(inserted).toEqual([
          '{"at":[1,"x"],"title":"Keys"}',
          "hello",
          "2026-11-23T10:00:00.000Z\n\n1.5\n\nfalse",
        ]);
        expect(await isolated.database.items.search.missing()).toBe(0);

        await isolated.driver.execute({
          sql: `UPDATE items SET about = NULL`,
          parameters: [],
        });
        // JSON null and strings of spaces, written by SQL, have no text, as
        // NULL has none.
        await isolated.driver.execute({
          sql: `INSERT INTO items (meta) VALUES ('null'), (NULL), ('""'), ('"\\u00a0\\t"')`,
          parameters: [],
        });
        embedded.length = 0;

        expect(await isolated.database.items.search.missing()).toBe(3);
        expect(await isolated.database.items.search.reindex()).toBe(3);
        expect(embedded.flat()).toEqual(inserted);
        expect(await isolated.database.items.search.missing()).toBe(0);
      } finally {
        await isolated.close();
      }
    });

    test("an insert and reindex() give a row the same text: a real, bytes in an array", async () => {
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          items: table({
            id: int.auto,
            ratio: real.nullable,
            ratios: real.array.nullable,
            blobs: bytea.array.nullable,
          }).search((item) => ({
            about: {
              meaning: lengths(
                item.ratio as never,
                item.ratios as never,
                item.blobs as never,
              ),
            },
          })),
        }),
        prefix: "symmetria_reindex_reals",
        max: 1,
      });

      try {
        embedded.length = 0;
        await isolated.database.items.insert({
          ratio: 1 / 3,
          ratios: [0.1, 1 / 3],
          blobs: [new Uint8Array([1, 2]), Buffer.from([255])],
        });

        const inserted = embedded.flat();

        // A real as the column keeps it, bytes as `\x…` in the array's JSON.
        expect(inserted).toEqual([
          '0.33333334\n\n[0.1,0.33333334]\n\n["\\\\x0102","\\\\xff"]',
        ]);

        await isolated.driver.execute({
          sql: "UPDATE items SET about = NULL",
          parameters: [],
        });
        embedded.length = 0;

        expect(await isolated.database.items.search.reindex()).toBe(1);
        expect(embedded.flat()).toEqual(inserted);
      } finally {
        await isolated.close();
      }
    });

    test("a customType read as text whose own type takes no collation: an enum type", async () => {
      const mood = customType<string>("reindex_mood", {
        base: "text",
        encode: (value) => value,
        decode: (value) => String(value),
      });
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({ placeholder: table({ id: int.auto }) }),
        prefix: "symmetria_reindex_enum_type",
        searchPath: ["public"],
        max: 1,
      });

      try {
        for (const statement of [
          "CREATE TYPE reindex_mood AS ENUM ('calm', ' ')",
          "CREATE TABLE moods (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, mood reindex_mood, about vector(2))",
          "INSERT INTO moods (mood) VALUES ('calm'), (' '), (NULL)",
        ]) {
          await isolated.driver.execute({ sql: statement, parameters: [] });
        }

        const database = createDatabase({
          schema: schema({
            moods: table({ id: int.auto, mood: mood.nullable }).search(
              (row) => ({ about: { meaning: lengths(row.mood) } }),
            ),
          }),
          driver: isolated.driver,
        });

        embedded.length = 0;

        // A label of only spaces has no text.
        expect(await database.moods.search.missing()).toBe(1);
        expect(await database.moods.search.reindex()).toBe(1);
        expect(await database.moods.search.missing()).toBe(0);
        expect(embedded).toEqual([["calm"]]);
      } finally {
        await isolated.close();
      }
    });

    test("a key read in another form than stored: each row embedded once, page by page", async () => {
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          stamped: table({ at: timestamptz.primaryKey, body: text }).search(
            (row) => ({ about: { meaning: lengths(row.body) } }),
          ),
        }),
        prefix: "symmetria_reindex_stamp_keys",
        max: 1,
      });

      try {
        // Microseconds a Date has not: the key read finds no row, and the
        // page after it starts at the same row.
        await isolated.driver.execute({
          sql: "INSERT INTO stamped (at, body) VALUES ('2026-11-23T10:00:00.123456Z', 'one'), ('2026-11-23T10:00:00.123457Z', 'two words'), ('2026-11-23T10:00:00.1234Z', 'three')",
          parameters: [],
        });

        for (const order of ["asc", "desc"] as const) {
          await isolated.driver.execute({
            sql: "UPDATE stamped SET about = NULL",
            parameters: [],
          });
          embedded.length = 0;

          expect(
            await isolated.database.stamped.search.reindex({ batch: 1, order }),
          ).toBe(3);
          expect(embedded.flat().sort()).toEqual(["one", "three", "two words"]);
          expect(await isolated.database.stamped.search.missing()).toBe(0);
        }
      } finally {
        await isolated.close();
      }
    });

    // Creates its own database, as no schema can change the encoding.
    test("an EUC_JP database, where ascii() raises for a character beyond ASCII", async () => {
      const name = `symmetria_reindex_euc_${process.pid}_${Date.now()}`;
      const admin = postgres({ url: databaseUrl!, max: 1 });
      const address = new URL(databaseUrl!);
      address.pathname = `/${name}`;

      await admin.execute({
        sql: `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'EUC_JP' LOCALE 'C'`,
        parameters: [],
      });

      try {
        const isolated = await testDatabase({
          url: address.toString(),
          schema: schema({
            items: table({
              id: int.auto,
              title: text,
              body: text.nullable,
            }).search((item) => ({
              about: { meaning: lengths(item.title, item.body) },
            })),
          }),
          prefix: "symmetria_reindex_euc",
          max: 1,
        });

        try {
          await isolated.driver.execute({
            sql: "INSERT INTO items (title, body) VALUES ('日本語の文書', NULL), ('', '東京'), ('', NULL)",
            parameters: [],
          });

          expect(await isolated.database.items.search.missing()).toBe(2);
          expect(await isolated.database.items.search.reindex()).toBe(2);
          expect(await isolated.database.items.search.missing()).toBe(0);
        } finally {
          await isolated.close();
        }
      } finally {
        await admin.execute({
          sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
          parameters: [],
        });
        await admin.close();
      }
    });
  },
);
