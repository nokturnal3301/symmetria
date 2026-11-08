// pgvector embeddings: a vector(3) column, an HNSW index with its operator
// class, and nearest-neighbour ordering by cosine distance. Creates its own
// isolated schema and skips cleanly when the server has no pgvector.
import assert from "node:assert/strict";
import { index, int, operatorClass, schema, table, text } from "symmetria";
import { postgres } from "symmetria/bun";
import { vector } from "symmetria/vector";
import { testDatabase } from "symmetria-kit/testing";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("Set DATABASE_URL to a PostgreSQL database for the demo.");
}

// The extension is installed once into public; the demo schema puts public on its search_path.
const admin = postgres({ url, max: 1 });
const available = await admin
  .execute({
    sql: "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'",
    parameters: [],
  })
  .then((result) => ("rows" in result ? result.rows : result).length > 0);

if (available) {
  await admin.execute({
    sql: 'CREATE EXTENSION IF NOT EXISTS "vector" SCHEMA public',
    parameters: [],
  });
}

await admin.close();

if (!available) {
  console.log("vectors skipped: pgvector is not installed on this server");
  process.exit(0);
}

const documents = table({
  id: int.auto,
  content: text,
  embedding: vector(3),
}).indexes((document) => ({
  nearest: index(operatorClass(document.embedding, "vector_cosine_ops"))
    .using("hnsw")
    .with({ m: 16, ef_construction: 64 }),
}));

const { database, close } = await testDatabase({
  url,
  schema: schema({ documents }, { extensions: ["vector"] }),
  prefix: "symmetria_vectors",
  searchPath: ["public"],
});

try {
  // Embeddings are plain number arrays on both sides.
  await database.documents.insert([
    { content: "east", embedding: [1, 0, 0] },
    { content: "north", embedding: [0, 1, 0] },
    { content: "north-east", embedding: [0.7, 0.7, 0] },
  ]);

  const query = [1, 0.1, 0];
  const nearest = database.documents(
    (document) => ({
      content: document.content,
      distance: document.embedding.cosineDistance(query),
    }),
    {
      orderBy: (document) => document.embedding.cosineDistance(query).ascending,
      limit: 2,
    },
  );

  console.log(nearest.toSQL().sql);
  const rows = await nearest;
  console.log(rows);
  assert.deepEqual(
    rows.map((row) => row.content),
    ["east", "north-east"],
  );
  assert.ok(rows[0]!.distance < rows[1]!.distance);

  console.log("vectors verified");
} finally {
  await close();
}
