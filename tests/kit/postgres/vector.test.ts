import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  schema,
  table,
  index,
  int,
  text,
  operatorClass,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";
import {
  detectDrift,
  migrationSnapshot,
  pullSchema,
  type MigrationSnapshot,
} from "../../../packages/kit/src";
import { testDatabase } from "../../support/postgres";
import { hasExtension } from "../../support/extensions";
import { migrationDirectory } from "../../support/directories";

const documents = table({
  id: int.auto,
  content: text,
  embedding: vector(3),
}).indexes((documents) => ({
  embedding: index(operatorClass(documents.embedding, "vector_cosine_ops"))
    .using("hnsw")
    .with({ m: 16, ef_construction: 64 }),
}));
const model = schema({ documents }, { extensions: ["vector"] });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
const available = await hasExtension(databaseUrl, "vector");

describe.skipIf(!available)("pgvector in migrations, drift and pull", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_vector_kit",
      max: 1,
      searchPath: ["public"],
    });
  });

  afterAll(async () => {
    await isolated?.close();
  });

  const withIndex = (
    change: (
      index: MigrationSnapshot["tables"][number]["indexes"][number],
    ) => MigrationSnapshot["tables"][number]["indexes"][number],
  ): MigrationSnapshot => {
    const snapshot = migrationSnapshot(model.$snapshot());

    return {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({
        ...table,
        indexes: table.indexes.map(change),
      })),
    };
  };

  test("the declared vector schema matches the live database", async () => {
    expect(
      await detectDrift({
        execute: isolated.driver.execute,
        snapshot: model.$snapshot(),
      }),
    ).toEqual([]);
  });

  test("operator class, storage parameters and extensions are compared", async () => {
    const differentClass = await detectDrift({
      execute: isolated.driver.execute,
      snapshot: withIndex((index) => ({
        ...index,
        opclasses: ["vector_l2_ops"],
      })),
    });
    expect(differentClass.map((finding) => finding.kind)).toEqual([
      "index-mismatch",
    ]);

    const differentStorage = await detectDrift({
      execute: isolated.driver.execute,
      snapshot: withIndex((index) => ({
        ...index,
        with: { ef_construction: 64, m: 32 },
      })),
    });
    expect(differentStorage.map((finding) => finding.kind)).toEqual([
      "index-mismatch",
    ]);

    const snapshot = migrationSnapshot(model.$snapshot());
    const missing = await detectDrift({
      execute: isolated.driver.execute,
      snapshot: {
        ...snapshot,
        extensions: ["symmetria_missing_ext", "vector"],
      },
    });
    expect(missing).toEqual([
      { kind: "missing-extension", table: "symmetria_missing_ext" },
    ]);
  });

  test("pull declares vector columns, HNSW indexes and the extension", async () => {
    const directory = await migrationDirectory();

    try {
      const result = await pullSchema({
        execute: isolated.driver.execute,
        module: resolve("packages/runtime/src/index.ts"),
        vectorModule: resolve("packages/runtime/src/entries/vector.ts"),
      });

      expect(result.extensions).toEqual(["vector"]);
      expect(result.source).toContain("embedding: vector(3),");
      expect(result.source).toContain(
        'embedding: index(operatorClass(documents.embedding, "vector_cosine_ops")).using("hnsw").with({ ef_construction: 64, m: 16 }),',
      );
      expect(result.source).toContain('extensions: ["vector"],');
      expect(result.source).toContain("import { vector } from ");

      const path = join(directory, "schema.ts");
      await writeFile(path, result.source);
      const loaded = await import(pathToFileURL(path).href);

      expect(
        await detectDrift({
          execute: isolated.driver.execute,
          snapshot: loaded.appSchema.$snapshot(),
        }),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
