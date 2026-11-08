import { expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  tsvector,
  searchDocument,
  createIndexesSQL,
} from "../../../packages/runtime/src";

const posts = table({
  id: int.auto,
  title: text,
  body: text.nullable,
  document: tsvector.nullable,
}).indexes((posts) => ({
  search: index(
    searchDocument({ A: posts.title, B: posts.body }, { language: "english" }),
  ).using("gin"),
  titleOnly: index(searchDocument(posts.title)).using("gin"),
}));
const model = schema({ posts });

test("a stored tsvector is matched and ranked without to_tsvector()", () => {
  const query = model
    .posts((post) => ({ id: post.id, rank: post.document.searchRank("bun") }), {
      where: (post) => post.document.search("bun"),
    })
    .toSQL();

  expect(query.sql).toContain(
    `ts_rank("posts"."document", websearch_to_tsquery('simple', $1)) AS "rank"`,
  );
  expect(query.sql).toContain(
    `WHERE "posts"."document" @@ websearch_to_tsquery('simple', $2)`,
  );
});

test("query modes select the tsquery parser", () => {
  const sqlFor = (mode: "websearch" | "plain" | "phrase" | "raw") =>
    model
      .posts((post) => ({ id: post.id }), {
        where: (post) => post.title.search("x", { mode }),
      })
      .toSQL().sql;

  expect(sqlFor("websearch")).toContain("websearch_to_tsquery('simple', $1)");
  expect(sqlFor("plain")).toContain("plainto_tsquery('simple', $1)");
  expect(sqlFor("phrase")).toContain("phraseto_tsquery('simple', $1)");
  expect(sqlFor("raw")).toContain("to_tsquery('simple', $1)");
  expect(() =>
    model.posts((post) => ({ id: post.id }), {
      where: (post) => post.title.search("x", { mode: "fuzzy" as "raw" }),
    }),
  ).toThrow(/search mode/);
  expect(() =>
    model.posts((post) => ({ id: post.id }), {
      where: (post) => post.title.search("x", { language: "English" }),
    }),
  ).toThrow(/text search configuration/);
  expect(
    model
      .posts((post) => ({ id: post.id }), {
        where: (post) =>
          post.title.search("x", { language: "pg_catalog_simple2" }),
      })
      .toSQL().sql,
  ).toContain("'pg_catalog_simple2'");
});

test("searchRank() renders weights, normalization and cover density", () => {
  const query = model
    .posts((post) => ({
      rank: post.title.searchRank("bun", {
        language: "english",
        weights: [0.1, 0.2, 0.4, 1],
        normalization: 32,
        coverDensity: true,
      }),
    }))
    .toSQL();

  expect(query.sql).toContain(
    `ts_rank_cd('{0.1,0.2,0.4,1}'::real[], to_tsvector('english', "posts"."title"), websearch_to_tsquery('english', $1), 32) AS "rank"`,
  );
  expect(() =>
    model.posts((post) => ({
      rank: post.title.searchRank("bun", { weights: [1, 2, 3] as never }),
    })),
  ).toThrow(/four non-negative numbers/);
  expect(() =>
    model.posts((post) => ({
      rank: post.title.searchRank("bun", { weights: [1, 2, 3, -1] }),
    })),
  ).toThrow(/four non-negative numbers/);
  expect(() =>
    model.posts((post) => ({
      rank: post.title.searchRank("bun", { normalization: 64 }),
    })),
  ).toThrow(/between 0 and 63/);
});

test("searchHeadline() renders ts_headline() with a validated options literal", () => {
  const plain = model
    .posts((post) => ({ snippet: post.title.searchHeadline("bun") }))
    .toSQL();
  const styled = model
    .posts((post) => ({
      snippet: post.body.searchHeadline("bun", {
        language: "english",
        mode: "plain",
        startSel: '<b class="hit">',
        stopSel: "</b>",
        maxWords: 10,
        highlightAll: true,
      }),
    }))
    .toSQL();

  expect(plain.sql).toContain(
    `ts_headline('simple', "posts"."title", websearch_to_tsquery('simple', $1)) AS "snippet"`,
  );
  expect(styled.sql).toContain(
    `ts_headline('english', "posts"."body", plainto_tsquery('english', $1), 'StartSel="<b class=""hit"">", StopSel="</b>", MaxWords=10, HighlightAll=true') AS "snippet"`,
  );
  expect(() =>
    model.posts((post) => ({
      snippet: post.title.searchHeadline("bun", { maxWords: -1 }),
    })),
  ).toThrow(/non-negative integer/);
  expect(() =>
    model.posts((post) => ({
      snippet: post.title.searchHeadline("bun", {
        startSel: "<b>'); DROP TABLE posts; --",
      }),
    })),
  ).not.toThrow();
  expect(() =>
    model.posts((post) => ({
      snippet: (post.document as unknown as typeof post.title).searchHeadline(
        "bun",
      ),
    })),
  ).toThrow(/text column, not on a tsvector/);
});

test("searchDocument() builds weighted documents for matching, ranking and indexes", () => {
  const query = model
    .posts(
      (post) => ({
        id: post.id,
        rank: searchDocument(
          { A: post.title, B: [post.body] },
          { language: "english" },
        ).searchRank("bun"),
      }),
      {
        where: (post) =>
          searchDocument(
            { A: post.title, B: [post.body] },
            { language: "english" },
          ).search("bun"),
      },
    )
    .toSQL();
  const document = `setweight(to_tsvector('english', coalesce("posts"."title", '')), 'A') || setweight(to_tsvector('english', coalesce("posts"."body", '')), 'B')`;

  expect(query.sql).toContain(
    `ts_rank((${document}), websearch_to_tsquery('english', $1)) AS "rank"`,
  );
  expect(query.sql).toContain(
    `WHERE (${document}) @@ websearch_to_tsquery('english', $2)`,
  );
  expect(
    model
      .posts((post) => ({ id: post.id }), {
        where: (post) => searchDocument([post.title, post.body]).search("bun"),
      })
      .toSQL().sql,
  ).toContain(
    `WHERE (to_tsvector('simple', coalesce("posts"."title", '')) || to_tsvector('simple', coalesce("posts"."body", ''))) @@`,
  );
  expect(
    model
      .posts((post) => ({ id: post.id }), {
        where: (post) => searchDocument(post.title).search("bun"),
      })
      .toSQL().sql,
  ).toContain(
    `WHERE to_tsvector('simple', coalesce("posts"."title", '')) @@ websearch_to_tsquery('simple', $1)`,
  );
  expect(
    model
      .posts((post) => ({ id: post.id }), {
        where: (post) =>
          searchDocument({ A: post.title, D: post.document }).search("bun"),
      })
      .toSQL().sql,
  ).toContain(
    `(setweight(to_tsvector('simple', coalesce("posts"."title", '')), 'A') || setweight("posts"."document", 'D')) @@`,
  );
  expect(() =>
    model.posts((post) => ({ id: post.id }), {
      where: (post) => searchDocument([]).search("bun"),
    }),
  ).toThrow(/at least one text expression/);
  expect(() =>
    model.posts((post) => ({ id: post.id }), {
      where: (post) => searchDocument({ E: post.title } as never).search("bun"),
    }),
  ).toThrow(/A, B, C or D/);
  expect(createIndexesSQL(model.$snapshot()).map((entry) => entry.sql)).toEqual(
    [
      `CREATE INDEX "posts_search_idx" ON "posts" USING gin ((setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("body", '')), 'B')))`,
      `CREATE INDEX "posts_title_only_idx" ON "posts" USING gin ((to_tsvector('simple', coalesce("title", ''))))`,
    ],
  );
  expect(() =>
    schema({
      notes: table({ id: int, title: text }).indexes((notes) => ({
        bad: index(notes.title).where(notes.title.search("x")),
      })),
    }),
  ).toThrow(/full-text predicates are not supported in schema expressions/);
});
