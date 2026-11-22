import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDatabase,
  schema,
  table,
  int,
  text,
} from "../../../packages/runtime/src";
import {
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import { halfvec } from "../../../packages/runtime/src/entries/vector";
import {
  detectDrift,
  generateMigration,
  migrator,
  pullSchema,
} from "../../../packages/kit/src";
import { postgres } from "../../support/postgres";
import { hasExtension } from "../../support/extensions";
import { migrationDirectory } from "../../support/directories";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
const available = await hasExtension(url, "vector");

/** The vector is the text's length and its word count, and a constant. */
const toy = (name: string) =>
  embedder(
    3,
    async (texts) =>
      texts.map((value) => [value.length, value.split(/\s+/).length, 1]),
    { name },
  );
const first = toy("first-model");
const second = toy("second-model");

type Version = {
  model?: typeof first;
  sources?: "text" | "reply and text";
  half?: boolean;
};

const messages = ({
  model = first,
  sources = "text",
  half = false,
}: Version = {}) =>
  schema({
    messages: table({
      id: int.auto,
      text: text,
      replyText: text.nullable,
      note: halfvec(3).nullable,
    }).search((message) => {
      const meaning =
        sources === "text"
          ? model(message.text)
          : model(message.replyText, message.text);

      return {
        about: {
          words: fullText(message.text),
          meaning: half ? meaning.half : meaning,
        },
      };
    }),
  });

const sandbox = async (
  callback: (context: {
    directory: string;
    rows: (sql: string) => Promise<Record<string, unknown>[]>;
    driver: ReturnType<typeof postgres>;
    runner: () => ReturnType<typeof migrator>;
  }) => Promise<void>,
) => {
  const namespace = `search_migrations_${randomUUID().replaceAll("-", "")}`;
  const directory = await migrationDirectory();
  const address = new URL(url!);

  address.searchParams.set("options", `-c search_path=${namespace},public`);

  const driver = postgres({ url: address.toString(), max: 2 });
  const rows = async (sql: string) => {
    const result = await driver.execute({ sql, parameters: [] });

    return (Array.isArray(result) ? result : result.rows) as Record<
      string,
      unknown
    >[];
  };

  try {
    await rows(`CREATE SCHEMA "${namespace}"`);
    await callback({
      directory,
      rows,
      driver,
      runner: () => migrator({ driver, directory, metadataSchema: namespace }),
    });
  } finally {
    await rows(`DROP SCHEMA "${namespace}" CASCADE`);
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
};

describe.skipIf(!available)("search declarations in migrations", () => {
  test("embeddings of other columns or another model are cleared, and reindex() computes them again", () =>
    sandbox(async ({ directory, rows, driver, runner }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: messages().$snapshot(),
      });
      await runner().migrate();

      const before = createDatabase({ schema: messages(), driver });

      await before.messages.insert([
        { text: "where are the keys", replyText: "in the garage" },
        { text: "soup recipe", replyText: null },
      ]);

      // The embedded columns change: the stored embeddings describe text alone.
      await expect(
        generateMigration({
          directory,
          name: "reply",
          snapshot: messages({ sources: "reply and text" }).$snapshot(),
        }),
      ).rejects.toThrow(
        'messages.about: The embeddings in "about" are cleared: it embeds reply_text, text instead of text',
      );

      const reply = (await generateMigration({
        directory,
        name: "reply",
        snapshot: messages({ sources: "reply and text" }).$snapshot(),
        allowDestructive: true,
      }))!;

      // The note tells lint of the saved file what generate knew.
      expect(reply.up).toBe(
        '-- symmetria: destructive: the embeddings in "about" are cleared: it embeds reply_text, text instead of text.\nUPDATE "messages" SET "about" = NULL WHERE "about" IS NOT NULL;\n',
      );
      await runner().migrate();

      const after = createDatabase({
        schema: messages({ sources: "reply and text" }),
        driver,
      });

      expect(await after.messages.search.missing()).toBe(2);
      expect(await after.messages.search.reindex()).toBe(2);
      expect(
        await rows("SELECT about::text AS about FROM messages ORDER BY id"),
      ).toEqual([
        {
          about: `[${"in the garage\n\nwhere are the keys".length},7,1]`,
        },
        { about: `[${"soup recipe".length},2,1]` },
      ]);
      expect(
        await detectDrift({
          execute: driver.execute,
          ignoreTables: ["_symmetria_migrations"],
          snapshot: messages({ sources: "reply and text" }).$snapshot(),
        }),
      ).toEqual([]);

      // Another model of the same size reads the same text differently.
      const model = (await generateMigration({
        directory,
        name: "model",
        snapshot: messages({
          sources: "reply and text",
          model: second,
        }).$snapshot(),
        allowDestructive: true,
      }))!;

      expect(model.up).toContain('UPDATE "messages" SET "about" = NULL');

      // Nothing changed, nothing to generate.
      expect(
        await generateMigration({
          directory,
          name: "same",
          snapshot: messages({
            sources: "reply and text",
            model: second,
          }).$snapshot(),
        }),
      ).toBeNull();
    }));

  test("half precision keeps the embeddings, halves the column and pull reads it back", () =>
    sandbox(async ({ directory, rows, driver, runner }) => {
      await generateMigration({
        directory,
        name: "initial",
        snapshot: messages().$snapshot(),
      });
      await runner().migrate();
      await createDatabase({ schema: messages(), driver }).messages.insert([
        { text: "garage keys", note: [0.5, 0.25, 0.125] },
        { text: "soup" },
      ]);

      const half = (await generateMigration({
        directory,
        name: "half",
        snapshot: messages({ half: true }).$snapshot(),
      }))!;

      expect(half.up).toContain(
        'ALTER TABLE "messages" ALTER COLUMN "about" TYPE halfvec(3) USING "about"::halfvec(3)',
      );
      await runner().migrate();
      expect(
        await rows(
          "SELECT pg_typeof(about)::text AS type, about::text AS about FROM messages ORDER BY id",
        ),
      ).toEqual([
        { type: "halfvec", about: "[11,2,1]" },
        { type: "halfvec", about: "[4,1,1]" },
      ]);
      expect(
        await rows(
          "SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_about_meaning_idx'",
        ),
      ).toEqual([
        {
          indexdef: expect.stringContaining("hnsw (about halfvec_cosine_ops)"),
        },
      ]);
      expect(
        await detectDrift({
          execute: driver.execute,
          ignoreTables: ["_symmetria_migrations"],
          snapshot: messages({ half: true }).$snapshot(),
        }),
      ).toEqual([]);

      const halved = createDatabase({
        schema: messages({ half: true }),
        driver,
      });

      expect(
        await halved.messages.search((message) => ({ text: message.text }), {
          about: [11, 2, 1],
          limit: 1,
        }),
      ).toEqual([{ text: "garage keys" }]);

      const pulled = await pullSchema({
        execute: driver.execute,
        module: resolve("packages/runtime/src/index.ts"),
        vectorModule: resolve("packages/runtime/src/entries/vector.ts"),
      });

      expect(pulled.source).toContain("about: halfvec(3).nullable,");
      expect(pulled.source).toContain("note: halfvec(3).nullable,");
      expect(pulled.source).toMatch(/import \{ halfvec \} from /);

      expect(await runner().rollback()).toEqual([half.id]);
      expect(
        await rows(
          "SELECT pg_typeof(about)::text AS type, about::text AS about FROM messages ORDER BY id",
        ),
      ).toEqual([
        { type: "vector", about: "[11,2,1]" },
        { type: "vector", about: "[4,1,1]" },
      ]);
    }));
});
