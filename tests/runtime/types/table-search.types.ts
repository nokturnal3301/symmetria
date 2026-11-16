// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  one,
  many,
  int,
  text,
} from "../../../packages/runtime/src";
import {
  bm25,
  embedder,
  fullText,
  type PartialSearch,
} from "../../../packages/runtime/src/entries/search";
import { voyage4 } from "../../../packages/runtime/src/entries/voyage";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const own = embedder(8, async (texts) => texts.map(() => [0]));
const notes = table({ id: int.auto, title: text, chunks: many.cascade });
const chunks = table({
  id: int.auto,
  note: one(notes.chunks),
  owner: text,
  title: text,
  content: text,
})
  .search((chunk) => ({
    about: {
      words: bm25({ A: chunk.title, B: chunk.content }),
      meaning: voyage4(chunk.title, chunk.content),
    },
  }))
  .search((chunk) => ({
    titled: { words: fullText(chunk.title, { language: "english" }) },
    similar: { meaning: own(chunk.content) },
  }));
const database = schema({ notes, chunks }, { executor: async () => [] });

// Whole rows leave the embedding out; `partial` reports a search that was skipped.
const rows = await database.chunks.search({
  where: { owner: "ada" },
  about: "question",
  limit: 3,
});

type Row = (typeof rows)[number];
type _Row = Expect<
  Equal<
    Row,
    {
      id: number;
      noteId: number;
      owner: string;
      title: string;
      content: string;
    }
  >
>;
type _Partial = Expect<Equal<typeof rows.partial, PartialSearch | undefined>>;

// A shape is typed like any query's, relation paths included.
const shaped = await database.chunks.search(
  (chunk) => ({ title: chunk.title, note: chunk.note.title }),
  {
    where: (chunk) => chunk.owner.is("ada"),
    about: { text: "question", vector: [1, 2] },
    titled: "title",
    similar: [1, 2],
    candidates: 50,
  },
);

type _Shaped = Expect<
  Equal<(typeof shaped)[number], { title: string; note: string }>
>;

const card = database.chunks.shape((chunk) => ({ title: chunk.title }));
const reused = await database.chunks.search(card, { titled: "x" });

type _Reused = Expect<Equal<(typeof reused)[number], { title: string }>>;

const compiled = await database.chunks.search({ about: "x" }).toSQL();

type _Compiled = Expect<
  Equal<typeof compiled, { sql: string; parameters: unknown[] }>
>;

const embedded: number = await database.chunks.search.reindex({
  where: { owner: "ada" },
  batch: 50,
});

// An embedding may be written with the row; a search by words keeps none.
await database.chunks.insert({
  noteId: 1,
  owner: "ada",
  title: "t",
  content: "c",
  about: [1, 2],
  similar: null,
});
await database.chunks.insert({
  noteId: 1,
  owner: "ada",
  title: "t",
  content: "c",
  // @ts-expect-error a search by words has no embedding to write
  titled: [1, 2],
});

// @ts-expect-error the table declares no such search
database.chunks.search({ nope: "x" });
// @ts-expect-error a search by words takes text, not an embedding
database.chunks.search({ titled: [1, 2] });
// @ts-expect-error a table without search() has no search
database.notes.search;
// @ts-expect-error the embedding is not a field of the row
rows[0]?.about;
table({ id: int.auto, body: text }).search((row) => ({
  // @ts-expect-error search() declares words with bm25() or fullText()
  x: { words: row.body },
}));

void embedded;
