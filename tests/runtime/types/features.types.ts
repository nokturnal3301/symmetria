// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  int,
  text,
  bool,
  bigint,
  jsonb,
  tsvector,
  searchDocument,
  sql,
  index,
  operatorClass,
  numeric,
  varchar,
  when,
  type TsVector,
  type Vector,
  type Infer,
  type InferInsert,
  type InferShape,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const settings = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) =>
      typeof value === "object" && value !== null
        ? { value: value as { theme: string; tags: string[] } }
        : { issues: [{ message: "object expected" }] },
  },
};
const model = schema({
  users: { id: int.auto, name: text, active: bool, settings: jsonb(settings) },
  posts: ({ users }) => ({
    id: int.auto,
    title: text,
    author: users,
    tags: text.array,
    scores: bigint.array.nullable,
  }),
});

{
  type Settings = Expect<
    AreEqual<
      typeof model.users.$row.settings,
      { theme: string; tags: string[] }
    >
  >;
  const scoped = model.$scope({ users: (users) => users.active.is(true) });
  type Same = Expect<AreEqual<typeof scoped, typeof model>>;
  scoped.$scope({ posts: (posts) => posts.title.is("x") });
  // @ts-expect-error unknown tables are rejected
  model.$scope({ comments: (comments) => comments.id.is(1) });
  // @ts-expect-error scope callbacks only see the table's own columns
  model.$scope({ users: (users) => users.missing.is(1) });
  model.posts.delete().where((posts) => posts.author.name.is("Ada"));
  model.users
    .update({ active: false })
    .where((users) => users.posts.some((posts) => posts.title.is("x")));
  // @ts-expect-error unknown relations stay rejected in mutation predicates
  model.posts.delete().where((posts) => posts.nothing.id.is(1));
  await model.$transaction(async (transaction) => {
    const inner = transaction.$scope({
      users: (users) => users.active.is(true),
    });
    type Transactional = Expect<AreEqual<typeof inner, typeof transaction>>;
    await inner.users((users) => ({ id: users.id }));
  });

  for await (const page of model
    .users(
      (users) => ({
        id: users.id,
        name: users.name,
      }),
      { orderBy: (users) => users.id.ascending },
    )
    .pages({ size: 10 })) {
    type Items = Expect<
      AreEqual<typeof page.items, { id: number; name: string }[]>
    >;
  }
}

{
  type Tags = Expect<AreEqual<typeof model.posts.$row.tags, string[]>>;
  type Scores = Expect<
    AreEqual<typeof model.posts.$row.scores, bigint[] | null>
  >;
  model.posts({ where: (posts) => posts.tags.has("x") });
  model.posts({ where: (posts) => posts.scores.has(5n) });
  model.posts({ where: (posts) => posts.tags.contains(["x"]) });
  model.posts({ where: (posts) => posts.tags.overlaps(["x"]) });
  model.posts((posts) => ({ count: posts.tags.length().as("count") }));
  model.posts({
    where: (posts) => posts.title.search("bun", { language: "english" }),
  });
  model.posts((posts) => ({
    id: posts.id,
    searchRank: posts.title.searchRank("bun"),
  }));
  // @ts-expect-error array elements keep their type
  model.posts({ where: (posts) => posts.tags.has(1) });
  // @ts-expect-error has() exists on array columns only
  model.posts({ where: (posts) => posts.title.has("x") });
  // @ts-expect-error search() exists on text columns only
  model.posts({ where: (posts) => posts.id.search("x") });
  // @ts-expect-error inserts require arrays for array columns
  model.posts.insert({ title: "t", authorId: 1, tags: "x" });
}

{
  const documents = schema({
    docs: table({
      id: int.auto,
      title: text,
      body: text.nullable,
      document: tsvector.nullable,
    }),
  });
  type Document = Expect<
    AreEqual<typeof documents.docs.$row.document, TsVector | null>
  >;
  documents.docs({ where: (docs) => docs.document.search("x") });
  documents.docs({
    where: (docs) => docs.title.search("x", { mode: "phrase" }),
    orderBy: (docs) =>
      docs.document.searchRank("x", {
        weights: [0.1, 0.2, 0.4, 1],
        coverDensity: true,
      }).descending,
  });
  const highlighted = documents.docs((docs) => ({
    snippet: docs.title.searchHeadline("x", {
      startSel: "<b>",
      stopSel: "</b>",
    }),
    optional: docs.body.searchHeadline("x"),
  }));
  type Snippet = Expect<
    AreEqual<Awaited<typeof highlighted>[number]["snippet"], string>
  >;
  type OptionalSnippet = Expect<
    AreEqual<Awaited<typeof highlighted>[number]["optional"], string | null>
  >;
  documents.docs({
    where: (docs) =>
      searchDocument(
        { A: docs.title, B: [docs.body] },
        { language: "english" },
      ).search("x"),
    orderBy: (docs) => searchDocument(docs.title).searchRank("x").descending,
  });
  documents.docs.insert({
    title: "t",
    document: sql.of(tsvector)`to_tsvector('english', ${"t"})`,
  });
  // @ts-expect-error headlines highlight text, not a stored tsvector
  documents.docs((docs) => ({ snippet: docs.document.searchHeadline("x") }));
  // @ts-expect-error headlines exist on text columns only
  documents.docs((docs) => ({ snippet: docs.id.searchHeadline("x") }));
  documents.docs({
    where: (docs) =>
      searchDocument({
        // @ts-expect-error weights are A, B, C or D
        E: docs.title,
      }).search("x"),
  });
  // @ts-expect-error a plain string is not a tsvector; build it with sql.of(tsvector)
  documents.docs.insert({ title: "t", document: "t" });
}

{
  const vectors = schema(
    {
      docs: table({
        id: int.auto,
        content: text,
        embedding: vector(3),
        optional: vector().nullable,
      }).indexes((docs) => ({
        embedding: index(operatorClass(docs.embedding, "vector_cosine_ops"))
          .using("hnsw")
          .with({ m: 16 }),
        content: index(operatorClass(docs.content, "text_pattern_ops")).unique,
      })),
    },
    { extensions: ["vector"] },
  );
  type Embedding = Expect<AreEqual<typeof vectors.docs.$row.embedding, Vector>>;
  type Optional = Expect<
    AreEqual<typeof vectors.docs.$row.optional, Vector | null>
  >;
  vectors.docs.insert({ content: "x", embedding: [1, 2, 3] });
  vectors.docs.insert({ content: "x", embedding: [1, 2, 3], optional: null });
  const nearest = vectors.docs(
    (docs) => ({
      id: docs.id,
      distance: docs.embedding.cosineDistance([1, 2, 3]),
      other: docs.embedding.l2Distance(docs.optional),
    }),
    {
      where: (docs) => docs.embedding.innerProduct([1, 2, 3]).below(-0.5),
      orderBy: (docs) => docs.embedding.l1Distance([1, 2, 3]).ascending,
      limit: 5,
    },
  );
  type Distance = Expect<
    AreEqual<Awaited<typeof nearest>[number]["distance"], number>
  >;
  // The unique index on a classed key still registers the unique lookup.
  vectors.docs.by.content("x");
  // @ts-expect-error vectors are not arrays: no element membership
  vectors.docs({ where: (docs) => docs.embedding.has(1) });
  // @ts-expect-error vectors are not arrays: no cardinality
  vectors.docs((docs) => ({ n: docs.embedding.length() }));
  // @ts-expect-error vectors are not JSON: no containment
  vectors.docs({ where: (docs) => docs.embedding.contains([1]) });
  // @ts-expect-error vectors are not JSON: no paths
  vectors.docs((docs) => ({ first: docs.embedding.path(0) }));
  // @ts-expect-error distances exist on vector columns only
  vectors.docs((docs) => ({ bad: docs.content.l2Distance([1, 2, 3]) }));
  // @ts-expect-error a string is not an embedding
  vectors.docs.insert({ content: "x", embedding: "[1,2,3]" });
}

{
  const accounts = table({
    id: int.auto,
    owner: text,
    balance: bigint.default(0n),
    note: text.nullable,
    price: numeric,
    code: varchar,
  });
  const ledger = schema({ accounts });
  type Row = Expect<
    AreEqual<
      Infer<typeof ledger.accounts>,
      {
        id: number;
        owner: string;
        balance: bigint;
        note: string | null;
        price: string;
        code: string;
      }
    >
  >;
  type StandaloneRow = Expect<
    AreEqual<Infer<typeof accounts>, Infer<typeof ledger.accounts>>
  >;
  type InsertInput = InferInsert<typeof ledger.accounts>;
  const insertable: InsertInput = { owner: "ada", price: "1", code: "a" };
  const standalone: InferInsert<typeof accounts> = {
    owner: "ada",
    price: "1",
    code: "a",
    balance: 5,
    note: undefined,
  };
  void insertable;
  void standalone;
  const card = ledger.accounts.shape((account) => ({
    owner: account.owner,
    balance: account.balance,
  }));
  type Card = Expect<
    AreEqual<InferShape<typeof card>, { owner: string; balance: bigint }>
  >;
  const listed = ledger.accounts((account) => ({ id: account.id }), {
    where: (account) => [
      when(undefined as string | undefined, (owner) => account.owner.is(owner)),
      false,
      null,
      account.id.above(0),
    ],
  });
  type Listed = Expect<AreEqual<InferShape<typeof listed>, { id: number }>>;
  const streamed = listed.stream({ size: 10 });
  type Streamed = Expect<
    AreEqual<typeof streamed, AsyncIterable<{ id: number }>>
  >;
  ledger.$transaction(
    async (tx) => {
      // @ts-expect-error savepoints cannot change transaction options
      await tx.$transaction(async () => undefined, { retries: 1 });
    },
    { retries: 2, retryDelayMs: 5, isolationLevel: "serializable" },
  );
  // @ts-expect-error the insert type omits generated identities
  const generated: InsertInput = { id: 1, owner: "ada", price: "1", code: "a" };
  void generated;
}
