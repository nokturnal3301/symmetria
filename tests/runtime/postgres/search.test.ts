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
  and,
  varchar,
  oneOf,
  uuid,
  date,
  numeric,
  inet,
  jsonb,
  customType,
  createDatabase,
  type SelectedColumn,
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

describe.skipIf(!databaseUrl)(
  "full-text search over columns that are not text",
  () => {
    const items = table({
      id: int.auto,
      title: text,
      code: varchar(20),
      kind: oneOf("alpha", "beta"),
      uid: uuid,
      day: date,
      price: numeric(10, 2),
      host: inet,
      meta: jsonb<{ note: string }>(),
    });
    const itemsModel = schema({ items });
    let isolated: Awaited<ReturnType<typeof testDatabase<typeof itemsModel>>>;

    beforeAll(async () => {
      isolated = await testDatabase({
        url: databaseUrl ?? "postgres://localhost/postgres",
        schema: itemsModel,
        prefix: "symmetria_search_types",
        max: 1,
      });
      await isolated.database.items.insert({
        title: "hello world",
        code: "abc",
        kind: "alpha",
        uid: "11111111-1111-4111-8111-111111111111",
        day: "2026-01-02",
        price: "12.50",
        host: "10.0.0.1",
        meta: { note: "gamma ray" },
      });
    });

    afterAll(async () => {
      await isolated?.close();
    });

    test("searchDocument(), search(), searchRank() and searchHeadline() read them as text", async () => {
      const { items: found } = isolated.database;
      const sources = [
        ["kind", "alpha"],
        ["uid", "11111111-1111-4111-8111-111111111111"],
        ["day", "2026-01-02"],
        ["price", "12.50"],
        ["host", "10.0.0.1"],
      ] as const;

      for (const [key, word] of sources) {
        expect(
          await found((item) => ({ id: item.id }), {
            where: (item) =>
              and(
                searchDocument({ A: item.title, B: item[key] }).search(word),
                item[key].search(word),
              ),
          }),
        ).toEqual([{ id: 1 }]);
        const [ranked] = await found((item) => ({
          rank: searchDocument(item[key]).searchRank(word),
          headline: item[key].searchHeadline(word),
        }));
        expect(ranked!.rank).toBeGreaterThan(0);
        expect(ranked!.headline).toContain("<b>");
      }

      expect(
        await found((item) => ({ id: item.id }), {
          where: (item) =>
            searchDocument(item.meta.path("note")).search("gamma"),
        }),
      ).toEqual([{ id: 1 }]);

      // Text columns render as before, without a cast.
      const { sql: text } = found((item) => ({ id: item.id }), {
        where: (item) =>
          searchDocument({ A: item.title, B: item.code }).search("hello"),
      }).toSQL();
      expect(text).toContain(
        `to_tsvector('simple', coalesce("items"."title", '')), 'A') || setweight(to_tsvector('simple', coalesce("items"."code", '')), 'B')`,
      );
    });

    test("a jsonb column is searched by its string values, as an index on to_tsvector(cfg, value) reads it", async () => {
      const { items: found } = isolated.database;
      // The types offer search on string values; this column holds an object.
      const meta = <Row extends { meta: unknown; title: unknown }>(item: Row) =>
        item.meta as unknown as Row["title"];

      // Its keys are no words: "note" is a key, "gamma" a value.
      for (const [word, expected] of [
        ["note", []],
        ["gamma", [{ id: 1 }]],
      ] as const) {
        expect(
          await found((item) => ({ id: item.id }), {
            where: (item) => meta(item).search(word),
          }),
        ).toEqual([...expected]);
        expect(
          await found((item) => ({ id: item.id }), {
            where: (item) =>
              searchDocument({ A: item.title, B: meta(item) }).search(word),
          }),
        ).toEqual([...expected]);
      }

      // The headline highlights within the JSON values, as ts_headline() of
      // a jsonb does.
      expect(
        await found((item) => ({
          headline: meta(item).searchHeadline("gamma"),
          rank: meta(item).searchRank("note"),
        })),
      ).toEqual([{ headline: { note: "<b>gamma</b> ray" } as never, rank: 0 }]);

      await isolated.driver.execute({
        sql: `CREATE INDEX items_meta_words ON items USING gin (to_tsvector('simple', meta))`,
        parameters: [],
      });
      const compiled = found((item) => ({ id: item.id }), {
        where: (item) => meta(item).search("gamma"),
      }).toSQL();
      const plan = await isolated.driver.transaction(async (transaction) => {
        await transaction.execute({
          sql: "SET LOCAL enable_seqscan = off",
          parameters: [],
        });
        const result = await transaction.execute({
          sql: `EXPLAIN ${compiled.sql}`,
          parameters: [...compiled.parameters],
        });

        return (
          Array.isArray(result)
            ? result
            : (result as { rows: Record<string, unknown>[] }).rows
        )
          .map((row) => String(row["QUERY PLAN"]))
          .join("\n");
      });

      expect(plan).toContain("items_meta_words");
    });
  },
);

describe.skipIf(!databaseUrl)(
  "an index on searchDocument() over parts that are not text",
  () => {
    type SearchPart = SelectedColumn<string | null>;
    type Note = {
      title: SearchPart;
      meta: SearchPart & { path: (key: string) => SearchPart };
      code: SearchPart;
    };
    const document = (note: Note) =>
      searchDocument(
        { A: [note.title, note.meta], B: [note.meta.path("a"), note.code] },
        english,
      );
    const notes = table({
      id: int.auto,
      title: text,
      meta: jsonb<{ a: string }>().nullable,
      code: uuid.nullable,
    }).indexes((note) => ({
      words: index(document(note as never)).using("gin"),
    }));
    const notesModel = schema({ notes });

    test("migrates and serves the query", async () => {
      // Before, the index read a jsonb part as coalesce(meta, ''), which
      // PostgreSQL refused: '' is no JSON.
      const isolated = await testDatabase({
        url: databaseUrl ?? "postgres://localhost/postgres",
        schema: notesModel,
        prefix: "symmetria_search_index_types",
        max: 1,
      });

      try {
        await isolated.database.notes.insert([
          {
            title: "first",
            meta: { a: "apple pie" },
            code: "11111111-1111-4111-8111-111111111111",
          },
          { title: "second", meta: null, code: null },
        ]);
        const query = isolated.database.notes((note) => ({ id: note.id }), {
          where: (note) => document(note as never).search("apples"),
        });

        expect(await query).toEqual([{ id: 1 }]);

        const compiled = query.toSQL();
        const plan = await isolated.driver.transaction(async (transaction) => {
          await transaction.execute({
            sql: "SET LOCAL enable_seqscan = off",
            parameters: [],
          });
          const result = await transaction.execute({
            sql: `EXPLAIN ${compiled.sql}`,
            parameters: [...compiled.parameters],
          });

          return (
            Array.isArray(result)
              ? result
              : (result as { rows: Record<string, unknown>[] }).rows
          )
            .map((row) => String(row["QUERY PLAN"]))
            .join("\n");
        });

        expect(plan).toContain("notes_words_idx");
      } finally {
        await isolated.close();
      }
    });
  },
);

describe.skipIf(!databaseUrl)(
  "full-text search over a customType() without a base",
  () => {
    test("a domain over jsonb is searched by its string values, and an index on to_tsvector(cfg, column) serves it", async () => {
      const isolated = await testDatabase({
        url: databaseUrl ?? "postgres://localhost/postgres",
        schema: schema({ posts: table({ id: int.auto, title: text }) }),
        prefix: "symmetria_search_domain",
        max: 1,
      });
      const run = (statement: string) =>
        isolated.driver.execute({ sql: statement, parameters: [] });

      try {
        await run(
          `CREATE DOMAIN "${isolated.namespace}".meta_doc AS jsonb CHECK (jsonb_typeof(VALUE) = 'object')`,
        );
        await run(`ALTER TABLE posts ADD COLUMN meta meta_doc`);
        await run(
          `CREATE INDEX posts_meta_words ON posts USING gin (to_tsvector('simple', meta))`,
        );
        // Declared without a base, as every 3.5.0 schema is: the type may be
        // text or JSON, so it is read as it is, and PostgreSQL reads a domain
        // over jsonb as JSON.
        type Meta = { title: string; draft: boolean };
        const meta = customType("meta_doc", {
          encode: (value: Meta) => JSON.stringify(value),
          decode: (value: unknown) =>
            (typeof value === "string" ? JSON.parse(value) : value) as Meta,
        });
        const database = createDatabase({
          schema: schema({
            posts: table({ id: int.auto, title: text, meta: meta.nullable }),
          }),
          driver: isolated.driver,
        });
        await database.posts.insert([
          { title: "one", meta: { title: "gamma ray", draft: true } },
          { title: "two", meta: null },
        ]);
        // The types offer search on string values; this column holds an object.
        const words = <Row extends { meta: unknown; title: unknown }>(
          post: Row,
        ) => post.meta as unknown as Row["title"];
        const found = (word: string) =>
          database.posts((post) => ({ id: post.id }), {
            where: (post) => words(post).search(word),
          });

        // "title" is a key and "true" a boolean: no words of the JSON.
        expect(await found("gamma")).toEqual([{ id: 1 }]);
        expect(await found("title")).toEqual([]);
        expect(await found("true")).toEqual([]);
        expect(
          await database.posts(
            (post) => ({ headline: words(post).searchHeadline("title") }),
            { where: (post) => post.id.is(1) },
          ),
        ).toEqual([{ headline: { title: "gamma ray", draft: true } as never }]);

        const compiled = found("gamma").toSQL();

        expect(compiled.sql).toContain(
          `to_tsvector('simple', "posts"."meta") @@`,
        );
        const plan = await isolated.driver.transaction(async (transaction) => {
          await transaction.execute({
            sql: "SET LOCAL enable_seqscan = off",
            parameters: [],
          });
          const result = await transaction.execute({
            sql: `EXPLAIN ${compiled.sql}`,
            parameters: [...compiled.parameters],
          });

          return (
            Array.isArray(result)
              ? result
              : (result as { rows: Record<string, unknown>[] }).rows
          )
            .map((row) => String(row["QUERY PLAN"]))
            .join("\n");
        });

        expect(plan).toContain("posts_meta_words");
      } finally {
        await isolated.close();
      }
    });
  },
);
