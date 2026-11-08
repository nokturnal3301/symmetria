// Full-text search over a weighted document, ranked and highlighted, plus
// count()/exists() on a filtered source. Creates its own isolated schema.
import assert from "node:assert/strict";
import { index, int, schema, searchDocument, table, text } from "symmetria";
import { testDatabase } from "symmetria-kit/testing";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("Set DATABASE_URL to a PostgreSQL database for the demo.");
}

// The index expression is the query expression, so the GIN index serves the search.
const articles = table({
  id: int.auto,
  title: text,
  body: text.nullable,
}).indexes((article) => ({
  search: index(
    searchDocument(
      { A: article.title, B: article.body },
      { language: "english" },
    ),
  ).using("gin"),
}));

const { database, close } = await testDatabase({
  url,
  schema: schema({ articles }),
  prefix: "symmetria_search",
});

try {
  await database.articles.insert([
    {
      title: "Typed SQL for Bun",
      body: "Symmetria compiles shapes into one SQL statement for Bun.",
    },
    {
      title: "Shipping a PostgreSQL schema",
      body: "Migrations, drift and pull keep SQL schemas honest for Bun and Node.",
    },
    { title: "Weekend notes", body: null },
  ]);

  // One weighted document per use: titles count more than bodies.
  const results = database.articles(
    (article) => ({
      title: article.title,
      relevance: searchDocument(
        { A: article.title, B: article.body },
        { language: "english" },
      ).searchRank("bun sql", { normalization: 32 }),
      snippet: article.body.searchHeadline("bun sql", {
        language: "english",
        startSel: "[",
        stopSel: "]",
      }),
    }),
    {
      where: (article) =>
        searchDocument(
          { A: article.title, B: article.body },
          { language: "english" },
        ).search("bun sql"),
      orderBy: (article) =>
        searchDocument(
          { A: article.title, B: article.body },
          { language: "english" },
        ).searchRank("bun sql").descending,
    },
  );

  console.log(results.toSQL().sql);
  const rows = await results;
  console.log(rows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.title, "Typed SQL for Bun");
  assert.match(rows[0]?.snippet ?? "", /\[SQL\]|\[Bun\]/);

  // A filtered source answers how many and whether, without a projection.
  const matching = database.articles({
    where: (article) =>
      searchDocument(
        { A: article.title, B: article.body },
        { language: "english" },
      ).search("postgresql"),
  });
  console.log({
    count: await matching.count(),
    exists: await matching.exists(),
  });
  assert.equal(await matching.count(), 1);
  assert.equal(
    await database
      .articles({ where: (a) => a.title.ilike("%kotlin%") })
      .exists(),
    false,
  );

  console.log("search verified");
} finally {
  await close();
}
