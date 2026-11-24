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
  coalesce,
  lag,
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
    `("documents"."embedding" <-> (SELECT $1::text::vector)) AS "l2"`,
  );
  // One vector, read once wherever it is compared: one parameter.
  expect(query.sql).toContain(
    `("documents"."embedding" <=> (SELECT $1::text::vector)) AS "cosine"`,
  );
  expect(query.sql).toContain(
    `("documents"."embedding" <#> (SELECT $1::text::vector)) AS "inner"`,
  );
  expect(query.sql).toContain(
    `("documents"."embedding" <+> (SELECT $1::text::vector)) AS "l1"`,
  );
  expect(query.sql).toContain(
    `("documents"."embedding" <-> "documents"."optional") AS "between"`,
  );
  expect(query.sql).toContain(
    `IS NOT NULL AND ("documents"."embedding" <=> (SELECT $1::text::vector)) < $2`,
  );
  expect(query.sql).toContain(
    `ORDER BY ("documents"."embedding" <=> (SELECT $1::text::vector)) ASC`,
  );
  expect(query.parameters[0]).toBe("[0.1,0.2,0.3]");
  // The filter and the ordering reuse the selected distance: one vector is sent.
  expect(query.parameters).toHaveLength(2);
  expect(query.parameters[1]).toBe(0.5);
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
    `ORDER BY ("documents"."embedding" <-> (SELECT $1::text::vector)) ASC`,
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

test("a distance in a check or an index predicate renders its vector bare, as before 3.4.1", () => {
  // PostgreSQL refuses `(SELECT …)` in a CHECK or an index predicate.
  const places = table({ id: int.auto, at: vector(3) })
    .checks((place) => ({ near: place.at.l2Distance([1, 0, 0]).below(10) }))
    .indexes((place) => ({
      close: index(place.id).where(
        place.at.cosineDistance([1, 0, -1.5]).below(0.5),
      ),
    }));
  const snapshot = migrationSnapshot(
    schema({ places }, { extensions: ["vector"] }).$snapshot(),
  );

  expect(snapshot.tables[0]!.checks![0]!.expression).toBe(
    `("at" <-> E'[1,0,0]'::text::vector) < 10`,
  );
  expect(snapshot.tables[0]!.indexes[0]!.where).toBe(
    `("at" <=> E'[1,0,-1.5]'::text::vector) < 0.5`,
  );
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

test("a distance reads as a number inside JSON, and a plain array is a vector fallback", async () => {
  const database = schema(
    { documents },
    {
      executor: async () => [
        // A nested result: PostgreSQL writes a NaN distance as the text "NaN".
        { id: 1, nested: [{ distance: "NaN" }], filled: "[0,0,0]" },
      ],
    },
  );
  const [row] = await database.documents((document) => ({
    id: document.id,
    nested: database.documents((inner) => ({
      distance: inner.embedding.cosineDistance([1, 0, 0]),
    })),
    // A number[] fallback type-checks, as it encodes.
    filled: coalesce(document.optional, [0, 0, 0]),
  }));

  expect(Number.isNaN(row!.nested[0]!.distance)).toBe(true);
  expect(typeof row!.nested[0]!.distance).toBe("number");
  expect(
    database
      .documents((document) => ({
        previous: lag(document.embedding, 1, [9, 9, 9]).over({
          orderBy: document.id.asc,
        }),
      }))
      .toSQL().parameters,
  ).toContain("[9,9,9]");
});

test("page cursors issued before 3.4.1 for a distance stay valid", async () => {
  const rows = [
    { id: 1, __symmetria_cursor_0: "0.5", __symmetria_cursor_1: "1" },
    { id: 2, __symmetria_cursor_0: "0.6", __symmetria_cursor_1: "2" },
    { id: 3, __symmetria_cursor_0: "0.7", __symmetria_cursor_1: "3" },
  ];
  const database = schema(
    {
      documents: table({ id: int.auto, content: text, embedding: vector(3) }),
    },
    { extensions: ["vector"], executor: async () => rows },
  );
  const ordered = await database
    .documents((document) => ({ id: document.id }), {
      orderBy: (document) => [
        document.embedding.cosineDistance([1, 0, 0]).asc,
        document.id.asc,
      ],
    })
    .page({ size: 2 });
  const filtered = await database
    .documents((document) => ({ id: document.id }), {
      where: (document) => document.embedding.l2Distance([1, 0, 0]).below(0.5),
      orderBy: (document) => document.id.asc,
    })
    .page({ size: 2 });

  // The cursors 3.4.0 issued, before a bound vector was read once per
  // statement as `(SELECT $1::text::vector)`.
  expect(String(ordered.nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6IjRkMGFiMzNiOWRjNWU1MjAxN2RiN2U0MGZjNzdiNDI4ZDg4MzE2MWE4YTQwM2IxNTdhN2QwNDQzZGIzMmVkZDAiLCJ2YWx1ZXMiOlsiMC42IiwiMiJdfQ",
  );
  expect(String(filtered.nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6ImM1NmFjNzJmZWM0ZjBjMzE5MzkxYzY5MGRkYzhlYTE3Mjc2MzgzNzc1OGMyMDNmYzYxMzdjMjdkMTIxY2IwNmEiLCJ2YWx1ZXMiOlsiMC42Il19",
  );
});

test("the order columns of an IVFFlat scan are named like no selected field", () => {
  const places = table({ id: int.auto, at: vector(3) }).indexes((place) => ({
    at: index(operatorClass(place.at, "vector_l2_ops")).using("ivfflat"),
  }));
  const { sql } = schema({ places })
    .places((place) => ({ __symmetria_order_0: place.id }), {
      orderBy: (place) => place.at.l2Distance([1, 0, 0]).asc,
      limit: 5,
    })
    .toSQL();

  expect(sql).toContain(
    '"places"."id" AS "__symmetria_order_0", ("places"."at" <-> (SELECT $2::text::vector)) AS "__symmetria_order_0_"',
  );
  expect(sql).toStartWith('SELECT "__symmetria_order_0"\n');
  expect(sql).toEndWith('ORDER BY "__symmetria_order_0_" + 0 ASC');
});
