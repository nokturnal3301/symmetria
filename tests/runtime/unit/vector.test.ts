import { expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  prepare,
  operatorClass,
  createIndexesSQL,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";
import { migrationSnapshot } from "../../../packages/kit/src";

const documents = table({
  id: int.auto,
  content: text,
  embedding: vector(3),
  optional: vector().nullable,
}).indexes((documents) => ({
  embedding: index(operatorClass(documents.embedding, "vector_cosine_ops"))
    .using("hnsw")
    .with({ m: 16, ef_construction: 64 }),
  content: index(
    operatorClass(documents.content.descending, "text_pattern_ops"),
  ),
}));
const model = schema({ documents }, { extensions: ["vector"] });

test("distance operators compile with a cast vector parameter and no array methods", () => {
  const query = model
    .documents(
      (doc) => ({
        id: doc.id,
        l2: doc.embedding.l2Distance([0.1, 0.2, 0.3]),
        cosine: doc.embedding.cosineDistance([0.1, 0.2, 0.3]),
        inner: doc.embedding.innerProduct([0.1, 0.2, 0.3]),
        l1: doc.embedding.l1Distance([0.1, 0.2, 0.3]),
        between: doc.embedding.l2Distance(doc.optional),
      }),
      {
        where: (doc) =>
          doc.embedding.cosineDistance([0.1, 0.2, 0.3]).below(0.5),
        orderBy: (doc) =>
          doc.embedding.cosineDistance([0.1, 0.2, 0.3]).ascending,
        limit: 5,
      },
    )
    .toSQL();

  expect(query.sql).toContain(
    `("documents"."embedding" <-> $1::text::vector) AS "l2"`,
  );
  expect(query.sql).toContain(
    `("documents"."embedding" <=> $2::text::vector) AS "cosine"`,
  );
  expect(query.sql).toContain(
    `("documents"."embedding" <#> $3::text::vector) AS "inner"`,
  );
  expect(query.sql).toContain(
    `("documents"."embedding" <+> $4::text::vector) AS "l1"`,
  );
  expect(query.sql).toContain(
    `("documents"."embedding" <-> "documents"."optional") AS "between"`,
  );
  expect(query.sql).toContain(
    `WHERE ("documents"."embedding" <=> $5::text::vector) < $6`,
  );
  expect(query.sql).toContain(
    `ORDER BY ("documents"."embedding" <=> $7::text::vector) ASC`,
  );
  expect(query.parameters[0]).toBe("[0.1,0.2,0.3]");
  expect(query.parameters[5]).toBe(0.5);
});

test("prepared vector parameters and writes encode embeddings as pgvector text", () => {
  const nearest = prepare({ query: vector(3), size: int }, (parameters) =>
    model.documents((doc) => ({ id: doc.id }), {
      orderBy: (doc) => doc.embedding.l2Distance(parameters.query).ascending,
      limit: parameters.size,
    }),
  );
  const compiled = nearest.toSQL({ query: [1, 2, 3], size: 2 });

  expect(compiled.sql).toContain(
    `ORDER BY ("documents"."embedding" <-> $1::text::vector) ASC`,
  );
  expect(compiled.parameters).toEqual(["[1,2,3]", 2]);

  const insert = model.documents
    .insert({ content: "hello", embedding: [1, 2, 3] })
    .toSQL();
  expect(insert.parameters).toEqual(["hello", "[1,2,3]"]);
  expect(() =>
    model.documents
      .insert({ content: "bad", embedding: [1, Number.NaN, 3] })
      .toSQL(),
  ).toThrow(/finite numbers/);
});

test("vector indexes render operator classes, access methods and storage options", () => {
  expect(createIndexesSQL(model.$snapshot()).map((entry) => entry.sql)).toEqual(
    [
      `CREATE INDEX "documents_embedding_idx" ON "documents" USING hnsw ("embedding" vector_cosine_ops) WITH (ef_construction = 64, m = 16)`,
      `CREATE INDEX "documents_content_idx" ON "documents" USING btree ("content" text_pattern_ops DESC)`,
    ],
  );
  const snapshot = migrationSnapshot(model.$snapshot());
  const embedding = snapshot.tables[0]!.indexes.find(
    (entry) => entry.sqlName === "documents_embedding_idx",
  )!;

  expect(embedding.opclasses).toEqual(["vector_cosine_ops"]);
  expect(embedding.with).toEqual({ ef_construction: 64, m: 16 });
  expect(embedding.keys).toEqual(['"embedding"']);
  expect(snapshot.extensions).toEqual(["vector"]);
  expect(
    snapshot.tables[0]!.indexes.find(
      (entry) => entry.sqlName === "documents_content_idx",
    )!.with,
  ).toBeUndefined();
  expect(snapshot.tables[0]!.columns.map((column) => column.sqlType)).toEqual([
    "integer",
    "text",
    "vector(3)",
    "vector",
  ]);
});

test("invalid vector declarations are rejected early", () => {
  expect(() => vector(0)).toThrow(/between 1 and 16000/);
  expect(() => vector(1.5)).toThrow(/between 1 and 16000/);
  expect(() => vector(3).array).toThrow(/cannot be arrays/);
  expect(() => operatorClass(documents.id as never, "bad class")).toThrow(
    /invalid operator class/,
  );
  expect(() =>
    schema({
      rows: table({ id: int, a: vector(3), b: vector(3) }).indexes((rows) => ({
        both: index(rows.a, rows.b).using("hnsw"),
      })),
    }),
  ).toThrow(/hnsw indexes require one key/);
  expect(() =>
    schema({
      rows: table({ id: int, a: vector(3), b: text }).indexes((rows) => ({
        included: index(rows.a).using("hnsw").include(rows.b),
      })),
    }),
  ).toThrow(/does not support INCLUDE/);
  expect(() =>
    schema({
      rows: table({ id: int, a: vector(3) }).indexes((rows) => ({
        ordered: index(rows.a.descending).using("hnsw"),
      })),
    }),
  ).toThrow(/ordered index keys require btree/);
  expect(() =>
    schema({
      rows: table({ id: int, a: vector(3) }).indexes((rows) => ({
        storage: index(rows.a).using("hnsw").with({ "m;drop": 1 }),
      })),
    }),
  ).toThrow(/invalid index storage option/);
  expect(() =>
    schema({
      rows: table({ id: int, a: vector(3) }).indexes((rows) => ({
        storage: index(rows.a).using("hnsw").with({}),
      })),
    }),
  ).toThrow(/at least one storage option/);
  expect(() =>
    schema({ rows: { id: int } }, { extensions: ["Vector"] }),
  ).toThrow(/lowercase identifiers/);
  expect(() =>
    model.documents((doc) => ({
      bad: (doc.content as unknown as typeof doc.embedding).l2Distance([1]),
    })),
  ).toThrow(/require a vector column/);
});
