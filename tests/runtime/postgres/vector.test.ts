import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  prepare,
  operatorClass,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";
import { testDatabase } from "../../support/postgres";
import { hasExtension } from "../../support/extensions";

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

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

describe.skipIf(!available)("pgvector on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_vector",
      max: 1,
      searchPath: ["public"],
    });
    database = isolated.database;
    await database.documents.insert([
      { content: "east", embedding: [1, 0, 0] },
      { content: "north", embedding: [0, 1, 0] },
      { content: "north-east", embedding: [0.7, 0.7, 0] },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("embeddings round-trip as number arrays", async () => {
    const rows = await database.documents(
      (doc) => ({ content: doc.content, embedding: doc.embedding }),
      { orderBy: (doc) => doc.id.ascending },
    );

    expect(rows.map((row) => row.content)).toEqual([
      "east",
      "north",
      "north-east",
    ]);
    expect(Array.isArray(rows[0]!.embedding)).toBe(true);
    expect([...rows[0]!.embedding]).toEqual([1, 0, 0]);
    expect(typeof rows[2]!.embedding[0]).toBe("number");
    expect(rows[2]!.embedding[0]).toBeCloseTo(0.7, 5);
  });

  test("nearest neighbours order by distance with plausible values", async () => {
    const nearest = await database.documents(
      (doc) => ({
        content: doc.content,
        cosine: doc.embedding.cosineDistance([1, 0.1, 0]),
        l2: doc.embedding.l2Distance([1, 0.1, 0]),
        inner: doc.embedding.innerProduct([1, 0.1, 0]),
        l1: doc.embedding.l1Distance([1, 0.1, 0]),
      }),
      {
        orderBy: (doc) => doc.embedding.cosineDistance([1, 0.1, 0]).ascending,
        limit: 2,
      },
    );

    expect(nearest.map((row) => row.content)).toEqual(["east", "north-east"]);
    expect(nearest[0]!.cosine).toBeGreaterThanOrEqual(0);
    expect(nearest[0]!.cosine).toBeLessThan(nearest[1]!.cosine);
    expect(nearest[0]!.l2).toBeGreaterThanOrEqual(0);
    expect(nearest[0]!.inner).toBeLessThan(0);
    expect(nearest[0]!.l1).toBeCloseTo(0.1, 5);
    expect(typeof nearest[0]!.cosine).toBe("number");

    const filtered = await database.documents((doc) => ({ id: doc.id }), {
      where: (doc) => doc.embedding.l2Distance([0, 1, 0]).below(0.01),
    });
    expect(filtered).toEqual([{ id: 2 }]);
  });

  test("prepared queries bind vector parameters", async () => {
    const nearest = prepare({ query: vector(3), size: int }, (parameters) =>
      database.documents((doc) => ({ content: doc.content }), {
        orderBy: (doc) => doc.embedding.l2Distance(parameters.query).ascending,
        limit: parameters.size,
      }),
    );

    expect(await nearest.execute({ query: [0, 1, 0], size: 1 })).toEqual([
      { content: "north" },
    ]);
    expect(await nearest.execute({ query: [1, 0, 0], size: 1 })).toEqual([
      { content: "east" },
    ]);
  });

  test("the HNSW index exists and serves nearest-neighbour queries", async () => {
    const indexes = rowsOf(
      await isolated.driver.execute({
        sql: "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'documents'",
        parameters: [],
      }),
    ).map((row) => String(row.indexdef));

    expect(
      indexes.some(
        (definition) =>
          definition.includes("USING hnsw") &&
          definition.includes("vector_cosine_ops") &&
          definition.includes("m='16'"),
      ),
    ).toBe(true);

    const compiled = database
      .documents((doc) => ({ id: doc.id }), {
        orderBy: (doc) => doc.embedding.cosineDistance([1, 0, 0]).ascending,
        limit: 2,
      })
      .toSQL();

    await isolated.driver.execute({
      sql: "SET enable_seqscan = off",
      parameters: [],
    });

    try {
      const plan = rowsOf(
        await isolated.driver.execute({
          sql: `EXPLAIN ${compiled.sql}`,
          parameters: [...compiled.parameters],
        }),
      )
        .map((row) => String(row["QUERY PLAN"]))
        .join("\n");

      expect(plan).toContain("documents_embedding_idx");
    } finally {
      await isolated.driver.execute({
        sql: "RESET enable_seqscan",
        parameters: [],
      });
    }
  });
});
