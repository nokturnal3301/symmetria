import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  tsvector,
  searchDocument,
  sql,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const posts = table({
  id: int.auto,
  title: text,
  body: text.nullable,
  document: tsvector.nullable,
}).indexes((posts) => ({
  search: index(
    searchDocument({ A: posts.title, B: posts.body }, { language: "english" }),
  ).using("gin"),
}));
const model = schema({ posts });

const english = { language: "english" } as const;
const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("full-text search on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl ?? "postgres://localhost/postgres",
      schema: model,
      prefix: "symmetria_search",
      max: 1,
    });
    database = isolated.database;
    await database.posts.insert(
      [
        {
          title: "PostgreSQL full text search",
          body: "Ranking functions and headlines",
        },
        {
          title: "Bun runtime",
          body: "Fast JavaScript with PostgreSQL drivers",
        },
        { title: "Cooking", body: null },
      ].map((post) => ({
        ...post,
        document: sql.of(tsvector)`to_tsvector('english', ${post.title})`,
      })),
    );
  });

  afterAll(async () => {
    await isolated?.close();
  });

  const ids = (rows: readonly { id: number }[]) => rows.map((row) => row.id);

  test("a stored tsvector column is searched directly", async () => {
    expect(
      ids(
        await database.posts((post) => ({ id: post.id }), {
          where: (post) => post.document.search("postgresql", english),
          orderBy: (post) => post.id.ascending,
        }),
      ),
    ).toEqual([1]);
    expect(
      ids(
        await database.posts((post) => ({ id: post.id }), {
          where: (post) =>
            searchDocument({ A: post.title, B: post.body }, english).search(
              "postgresql",
            ),
          orderBy: (post) => post.id.ascending,
        }),
      ),
    ).toEqual([1, 2]);
  });

  test("weighted documents rank title matches above body matches", async () => {
    const ranked = await database.posts(
      (post) => ({
        id: post.id,
        rank: searchDocument(
          { A: post.title, B: post.body },
          english,
        ).searchRank("postgresql"),
        dense: searchDocument(
          { A: post.title, B: post.body },
          english,
        ).searchRank("postgresql", {
          coverDensity: true,
          normalization: 1,
        }),
      }),
      {
        where: (post) =>
          searchDocument({ A: post.title, B: post.body }, english).search(
            "postgresql",
          ),
        orderBy: (post) =>
          searchDocument({ A: post.title, B: post.body }, english).searchRank(
            "postgresql",
          ).descending,
      },
    );

    expect(ids(ranked)).toEqual([1, 2]);
    expect(ranked[0]!.rank).toBeGreaterThan(ranked[1]!.rank);
    expect(ranked[0]!.dense).toBeGreaterThan(0);
    const inverted = await database.posts((post) => ({ id: post.id }), {
      where: (post) =>
        searchDocument({ A: post.title, B: post.body }, english).search(
          "postgresql",
        ),
      orderBy: (post) =>
        searchDocument({ A: post.title, B: post.body }, english).searchRank(
          "postgresql",
          { weights: [0, 0, 1, 0.1] },
        ).descending,
    });
    expect(ids(inverted)).toEqual([2, 1]);
  });

  test("plain, phrase and raw modes parse the query differently", async () => {
    const matches = (query: string, mode: "plain" | "phrase" | "raw") =>
      database
        .posts((post) => ({ id: post.id }), {
          where: (post) => post.title.search(query, { ...english, mode }),
          orderBy: (post) => post.id.ascending,
        })
        .then(ids);

    expect(await matches("bun runtime", "plain")).toEqual([2]);
    expect(await matches("full text", "phrase")).toEqual([1]);
    expect(await matches("text full", "phrase")).toEqual([]);
    expect(await matches("post:*", "raw")).toEqual([1]);
    expect(await matches("cook:* | bun", "raw")).toEqual([2, 3]);
  });

  test("searchHeadline() highlights the matched words", async () => {
    const [row] = await database.posts(
      (post) => ({
        snippet: post.title.searchHeadline("postgresql", {
          ...english,
          startSel: "<b>",
          stopSel: "</b>",
        }),
        body: post.body.searchHeadline("ranking", english),
      }),
      { where: (post) => post.id.is(1) },
    );

    expect(row?.snippet).toBe("<b>PostgreSQL</b> full text search");
    expect(row?.body).toBe("<b>Ranking</b> functions and headlines");
  });

  test("the GIN index on the document expression exists and serves the query", async () => {
    const indexes = await isolated.driver.execute({
      sql: "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'posts'",
      parameters: [],
    });
    const rows = (result: unknown) =>
      (Array.isArray(result)
        ? result
        : (result as { rows: Record<string, unknown>[] }).rows) as Record<
        string,
        unknown
      >[];

    expect(rows(indexes).map((row) => row.indexname)).toContain(
      "posts_search_idx",
    );

    const compiled = database
      .posts((post) => ({ id: post.id }), {
        where: (post) =>
          searchDocument({ A: post.title, B: post.body }, english).search(
            "postgresql",
          ),
      })
      .toSQL();

    // SET LOCAL keeps the planner setting on this transaction's connection.
    const plan = await isolated.driver.transaction(async (transaction) => {
      await transaction.execute({
        sql: "SET LOCAL enable_seqscan = off",
        parameters: [],
      });

      return rows(
        await transaction.execute({
          sql: `EXPLAIN ${compiled.sql}`,
          parameters: [...compiled.parameters],
        }),
      )
        .map((row) => String(row["QUERY PLAN"]))
        .join("\n");
    });

    expect(plan).toContain("posts_search_idx");
  });
});
