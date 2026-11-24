import { expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  tsvector,
  jsonb,
  uuid,
  date,
  timestamptz,
  interval,
  oneOf,
  sql,
  customType,
  searchDocument,
  createIndexesSQL,
  type SelectedColumn,
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

  // A rank parses its question once per statement; a match keeps the call,
  // which a custom plan reads as a constant.
  expect(query.sql).toContain(
    `ts_rank("posts"."document", (SELECT websearch_to_tsquery('simple', $1))) AS "rank"`,
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
    `ts_rank_cd('{0.1,0.2,0.4,1}'::real[], to_tsvector('english', "posts"."title"), (SELECT websearch_to_tsquery('english', $1)), 32) AS "rank"`,
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

test("searchHeadline() renders ts_headline() with validated options as a parameter", () => {
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
    `ts_headline('simple', "posts"."title", (SELECT websearch_to_tsquery('simple', $1))) AS "snippet"`,
  );
  // The options are a parameter: their values stay out of the SQL text.
  expect(styled.sql).toContain(
    `ts_headline('english', "posts"."body", (SELECT plainto_tsquery('english', $1)), $2::text) AS "snippet"`,
  );
  expect(styled.parameters).toEqual([
    "bun",
    'StartSel="<b class=""hit"">", StopSel="</b>", MaxWords=10, HighlightAll=true',
  ]);
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
    `ts_rank((${document}), (SELECT websearch_to_tsquery('english', $1))) AS "rank"`,
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

test("a jsonb value is searched as PostgreSQL reads JSON, its question parsed once per row-wise call", () => {
  const notes = schema({
    notes: table({
      id: int.auto,
      meta: jsonb<string>().nullable,
      doc: jsonb<Record<string, unknown>>().nullable,
    }),
  });
  const query = notes
    .notes(
      (note) => ({
        rank: note.meta.searchRank("keys"),
        snippet: note.meta.searchHeadline("keys"),
      }),
      {
        where: (note) => [
          note.meta.search("keys"),
          searchDocument({
            A: note.meta,
            B: note.doc.path("title") as never,
          }).search("keys"),
        ],
      },
    )
    .toSQL();

  // The jsonb itself, as 3.5.0 sent it: its string values are words, not
  // its keys, numbers or booleans, and an index on to_tsvector(cfg, meta)
  // serves the match. A missing value in a document reads as an empty object.
  expect(query.sql).toContain(
    `ts_rank(to_tsvector('simple', "notes"."meta"), (SELECT websearch_to_tsquery('simple', $1))) AS "rank"`,
  );
  expect(query.sql).toContain(
    `ts_headline('simple', "notes"."meta", (SELECT websearch_to_tsquery('simple', $2))) AS "snippet"`,
  );
  expect(query.sql).toContain(
    `to_tsvector('simple', "notes"."meta") @@ websearch_to_tsquery('simple', $3)`,
  );
  expect(query.sql).toContain(
    `(setweight(to_tsvector('simple', coalesce("notes"."meta", '{}')), 'A') || setweight(to_tsvector('simple', coalesce(("notes"."doc" #> ARRAY[$4::text]), '{}')), 'B')) @@`,
  );
});

test("page cursors 3.5.0 issued for a rank, a headline and a jsonb search stay valid", async () => {
  const rows = [
    { id: 1, __symmetria_cursor_0: "0.5" },
    { id: 2, __symmetria_cursor_0: "0.4" },
    { id: 3, __symmetria_cursor_0: "0.3" },
  ];
  const database = schema(
    { posts: table({ id: int.auto, title: text, meta: jsonb() }) },
    { executor: async () => rows },
  );
  const query = database.posts(
    (post) => ({ id: post.id, snippet: post.title.searchHeadline("bun") }),
    {
      where: (post) => [
        post.title.searchRank("bun", { mode: "plain" }).above(0.1),
        (post.meta as never as typeof post.title).search("bun"),
      ],
      orderBy: (post) => post.id.asc,
    },
  );

  expect(query.toSQL().sql).toContain(
    `ts_rank(to_tsvector('simple', "posts"."title"), (SELECT plainto_tsquery('simple', $2))) > $3`,
  );
  // The cursor 3.5.0 issued: its fingerprint is the SQL of the query's shape,
  // which keeps the question as 3.5.0 parsed it, and the jsonb as it was.
  expect(String((await query.page({ size: 2 })).nextCursor)).toBe(
    "eyJ2ZXJzaW9uIjoxLCJxdWVyeSI6Ijg3NzVjNjczODdlODZmNDViZGMzMzVmZWRkNzlkZDFkMDU1YjViZWJhZDVkODJjZWZlMTYwOWVjN2UzMjFhMzUiLCJ2YWx1ZXMiOlsiMC40Il19",
  );
});

test("an index on searchDocument() reads each part as the query does: a jsonb part as JSON, another type as its text", () => {
  // A custom type without a base may be text or JSON (a domain): it is read
  // as it is, as 3.5.0 read it; one with a base is read as its base.
  const email = customType<string>("email", {
    encode: (value: string) => value,
    decode: (value: unknown) => String(value),
  });
  const ref = customType("ref", { base: "uuid" });
  type SearchPart = SelectedColumn<string | null>;
  type Note = {
    title: SearchPart;
    meta: SearchPart & { path: (key: string) => SearchPart };
    code: SearchPart;
    mail: SearchPart;
    link: SearchPart;
  };
  const document = (note: Note) =>
    searchDocument({
      A: [note.title, note.meta],
      B: [note.meta.path("title"), note.code],
      C: note.mail,
      D: note.link,
    });
  const model = schema({
    notes: table({
      id: int.auto,
      title: text,
      meta: jsonb<string>().nullable,
      code: uuid.nullable,
      mail: email.nullable,
      link: ref.nullable,
    }).indexes((note) => ({
      words: index(document(note as never)).using("gin"),
    })),
  });
  const [created] = createIndexesSQL(model.$snapshot());
  const { sql } = model
    .notes((note) => ({ id: note.id }), {
      where: (note) => document(note as never).search("keys"),
    })
    .toSQL();
  const parts = [
    `setweight(to_tsvector('simple', coalesce("title", '')), 'A')`,
    `setweight(to_tsvector('simple', coalesce("meta", '{}')), 'A')`,
    `setweight(to_tsvector('simple', coalesce(("meta" #> ARRAY[E'title'::text]), '{}')), 'B')`,
    `setweight(to_tsvector('simple', coalesce(("code")::text, '')), 'B')`,
    `setweight(to_tsvector('simple', coalesce("mail", '')), 'C')`,
    `setweight(to_tsvector('simple', coalesce(("link")::text, '')), 'D')`,
  ].join(" || ");

  expect(created!.sql).toBe(
    `CREATE INDEX "notes_words_idx" ON "notes" USING gin ((${parts}))`,
  );
  // The query's document is the same expression, its path key a parameter.
  expect(sql).toContain(
    `WHERE (${parts.replaceAll('("', '("notes"."').replace("E'title'::text", "$1::text")}) @@`,
  );
});

test("an index on searchDocument() refuses a part whose text PostgreSQL cannot index; queries and checks read it", () => {
  const day = customType("day", { base: "date" });
  const domain = customType<string>("label", {
    encode: (value: string) => value,
    decode: (value: unknown) => String(value),
  });
  const columns = {
    id: int.auto,
    title: text,
    state: oneOf("draft", "live"),
    born: date,
    at: timestamptz(3),
    span: interval,
    tags: text.array,
    due: day,
    label: domain,
    slots: customType<string>("int4multirange", {
      encode: (value: string) => value,
      decode: (value: unknown) => String(value),
    }),
  };
  type Part = Exclude<keyof typeof columns, "id" | "title">;
  const indexed = (part: Part) =>
    schema({
      notes: table(columns).indexes((note) => ({
        words: index(
          searchDocument({ A: note.title, B: note[part] as never }),
        ).using("gin"),
      })),
    });

  // `(part)::text` of these calls an output function that is not
  // immutable: the migration would fail to build the index.
  expect(() => indexed("state")).toThrow(
    'symmetria: an index on searchDocument() cannot read "state", which is an enum: its values can be renamed, so PostgreSQL refuses its text in an index',
  );
  expect(() => indexed("born")).toThrow(
    'cannot read "born", which is of type date: its text follows the session\'s settings',
  );
  expect(() => indexed("at")).toThrow(
    'cannot read "at", which is of type timestamptz(3)',
  );
  expect(() => indexed("span")).toThrow('"span", which is of type interval');
  expect(() => indexed("tags")).toThrow(
    '"tags", which is of type text[]: PostgreSQL does not count the text of a range or an array as fixed',
  );
  expect(() => indexed("slots")).toThrow(
    '"slots", which is of type int4multirange: PostgreSQL does not count the text of a range or an array as fixed',
  );
  // A custom type is judged by its base; without one it is read as it is.
  expect(() => indexed("due")).toThrow('"due", which is of type day (date)');
  expect(createIndexesSQL(indexed("label").$snapshot())[0]!.sql).toContain(
    `setweight(to_tsvector('simple', coalesce("label", '')), 'B')`,
  );

  // A query reads each as its text, and so does a check, which PostgreSQL
  // does not require to be immutable.
  const model = schema({
    notes: table(columns).checks((note) => ({
      words: sql<boolean>`${searchDocument(note.born)} @@ 'x'::tsquery`,
    })),
  });
  const { sql: query } = model
    .notes((note) => ({ id: note.id }), {
      where: (note) =>
        searchDocument({
          A: note.state as never,
          B: [note.born, note.at, note.span, note.tags, note.due] as never,
        }).search("x"),
    })
    .toSQL();

  for (const name of ["state", "born", "at", "span", "tags", "due"]) {
    expect(query).toContain(`coalesce(("notes"."${name}")::text, '')`);
  }

  expect(model.$snapshot().tables[0]!.checks![0]!.expression).toBe(
    `to_tsvector('simple', coalesce(("born")::text, '')) @@ 'x'::tsquery`,
  );
});
