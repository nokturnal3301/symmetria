import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { schema, table, int, text } from "../../../packages/runtime/src";
import {
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import { testDatabase } from "../../../packages/kit/src/testing";
import { postgres } from "../../support/postgres";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
const admin = databaseUrl ? postgres({ url: databaseUrl, max: 1 }) : undefined;
const rows = (result: unknown) =>
  (Array.isArray(result)
    ? result
    : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
const available =
  admin &&
  rows(
    await admin.execute({
      sql: "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'",
      parameters: [],
    }),
  ).length > 0;

// A database of its own, so the extension is surely missing before the test.
const name = `symmetria_ext_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let url: string;

beforeAll(async () => {
  if (!available) {
    return;
  }

  await admin!.execute({ sql: `CREATE DATABASE "${name}"`, parameters: [] });
  const target = new URL(databaseUrl!);

  target.pathname = `/${name}`;
  url = target.toString();
});

afterAll(async () => {
  if (available) {
    await admin!.execute({
      sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      parameters: [],
    });
  }

  await admin?.close();
});

const lengths = embedder(2, async (texts) =>
  texts.map((value) => [value.length, 1]),
);
const notes = table({ id: int.auto, body: text }).search((note) => ({
  about: { words: fullText(note.body), meaning: lengths(note.body) },
}));
const model = schema({ notes });

test.skipIf(!available)(
  "testDatabase() installs the extensions a schema needs and finds their types",
  async () => {
    // No CREATE EXTENSION beforehand and no searchPath option.
    for (let round = 0; round < 2; round += 1) {
      const isolated = await testDatabase({
        url,
        schema: model,
        prefix: "symmetria_ext",
      });

      try {
        await isolated.database.notes.insert([
          { body: "garage keys" },
          { body: "soup" },
        ]);
        expect(
          await isolated.database.notes.search(
            (note) => ({ body: note.body }),
            { about: "garage", limit: 1 },
          ),
        ).toEqual([{ body: "garage keys" }]);
      } finally {
        await isolated.close();
      }
    }

    // The extension stays in the database's default schema, shared by later tests.
    const probe = postgres({ url, max: 1 });

    try {
      expect(
        rows(
          await probe.execute({
            sql: "SELECT extnamespace::regnamespace::text AS home FROM pg_extension WHERE extname = 'vector'",
            parameters: [],
          }),
        ),
      ).toEqual([{ home: "public" }]);
    } finally {
      await probe.close();
    }
  },
);

test.skipIf(!databaseUrl)(
  "testDatabase refuses bad options before it creates anything, and cleans up after any later failure",
  async () => {
    const prefix = `symmetria_leak_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const opened: { closed: boolean }[] = [];
    // Every pool testDatabase opens, and whether it was closed.
    const driver = (options: { url: string; max: number }) => {
      const pool = postgres(options);
      const entry = { closed: false };

      opened.push(entry);

      return {
        ...pool,
        close: async () => {
          entry.closed = true;
          await pool.close();
        },
      };
    };
    const leftovers = async () =>
      rows(
        await admin!.execute({
          sql: "SELECT nspname FROM pg_namespace WHERE nspname LIKE $1",
          parameters: [`${prefix}%`],
        }),
      );

    await expect(
      testDatabase({
        url: databaseUrl!,
        schema: schema({ t: table({ id: int.auto }) }),
        prefix,
        searchPath: ["Public"],
        driver,
      }),
    ).rejects.toThrow("search_path entries must be identifiers");
    expect(opened).toEqual([]);

    // A statement that fails after the schema exists drops it and closes both pools.
    await expect(
      testDatabase({
        url: databaseUrl!,
        schema: schema({ t: table({ id: int.auto }) }),
        prefix,
        searchPath: ["missing_schema_for_types"],
        driver: (options) => {
          const pool = driver(options);

          return opened.length === 2
            ? {
                ...pool,
                execute: async () => {
                  throw new Error("refused by the test");
                },
              }
            : pool;
        },
      }),
    ).rejects.toThrow("refused by the test");
    expect(opened).toEqual([{ closed: true }, { closed: true }]);
    expect(await leftovers()).toEqual([]);
  },
);
