/**
 * Searches a table declares with `.search()`: by words (PostgreSQL full text,
 * or BM25 through the `pg_search` extension), by meaning (an embedding kept
 * in a hidden vector column), or by both at once. A declaration lowers to an
 * ordinary column and ordinary indexes, so migrations see nothing new.
 */
import type { TableBinding } from "../query/plan/types";
import {
  COLUMN_EXPRESSION,
  readColumn,
  searchDocument,
  type SelectedColumn,
} from "../query/expressions";
import { createScope } from "../query/select/scope";
import type { RuntimeScope } from "../query/select/types";
import { hiddenColumn, tsvector } from "./column";
import { vector } from "../entries/vector";
import {
  index,
  operatorClass,
  storedIndex,
  type IndexDefinition,
} from "./indexes";
import {
  searchLowering,
  type TableIndexCallback,
  type TableState,
} from "./table";

const WORDS = Symbol("symmetria.search.words");
const MEANING = Symbol("symmetria.search.meaning");

type Text = SelectedColumn<string | null>;
type Weight = "A" | "B" | "C" | "D";

/** The columns a search reads, heaviest first: a column, several, or a weight map. */
export type SearchParts =
  | Text
  | readonly Text[]
  | Readonly<Partial<Record<Weight, Text | readonly Text[]>>>;

/** How a search matches words: declared with `bm25()` or `fullText()`. */
export interface WordsSearch {
  readonly [WORDS]: {
    readonly kind: "bm25" | "fullText";
    readonly parts: readonly {
      readonly column: Text;
      readonly weight: Weight;
    }[];
    readonly language: string;
  };
}

/** Turns texts into embeddings; `kind` tells documents from the questions asked about them. */
export type EmbeddingModel = {
  readonly name: string;
  readonly size: number;
  readonly embed: (
    texts: readonly string[],
    kind: "document" | "query",
  ) => Promise<readonly (readonly number[])[]>;
};

/** How a search matches meaning: the model and the columns whose text it embeds. */
export interface MeaningSearch {
  readonly [MEANING]: {
    readonly model: EmbeddingModel;
    readonly sources: readonly Text[];
  };
}

/** One named search of a table: `about: { words: bm25(...), meaning: voyage4(...) }`. */
export type SearchDeclaration = {
  readonly words?: WordsSearch;
  readonly meaning?: MeaningSearch;
};

export type SearchCallback = (
  columns: RuntimeScope[string],
) => Record<string, SearchDeclaration>;

const WEIGHTS: readonly Weight[] = ["A", "B", "C", "D"];

const isText = (value: unknown): value is Text =>
  Boolean(value) &&
  (typeof value === "object" || typeof value === "function") &&
  COLUMN_EXPRESSION in (value as object);

const weighted = (
  name: string,
  parts: SearchParts,
): WordsSearch[typeof WORDS]["parts"] => {
  const entries: [Weight, unknown][] = isText(parts)
    ? [["A", parts]]
    : Array.isArray(parts)
      ? parts.map((part) => ["A", part])
      : WEIGHTS.flatMap((weight): [Weight, unknown][] => {
          const part = (parts as Record<string, unknown>)[weight];

          return part === undefined
            ? []
            : (Array.isArray(part) ? part : [part]).map((column) => [
                weight,
                column,
              ]);
        });

  if (
    !isText(parts) &&
    !Array.isArray(parts) &&
    Object.keys(parts as object).some((key) => !WEIGHTS.includes(key as Weight))
  ) {
    throw new Error(`symmetria: ${name}() weights are A, B, C and D`);
  }

  if (!entries.length) {
    throw new Error(`symmetria: ${name}() requires at least one column`);
  }

  return Object.freeze(
    entries.map(([weight, column]) => {
      if (!isText(column) || readColumn(column).node.kind !== "column") {
        throw new Error(
          `symmetria: ${name}() takes the table's own text columns`,
        );
      }

      return Object.freeze({ column, weight });
    }),
  );
};

/**
 * Words ranked with BM25, which weighs rare words more than common ones. It
 * needs the `pg_search` extension (ParadeDB); migrations create it.
 */
export const bm25 = (parts: SearchParts): WordsSearch =>
  Object.freeze({
    [WORDS]: Object.freeze({
      kind: "bm25" as const,
      parts: weighted("bm25", parts),
      language: "simple",
    }),
  });

/**
 * Words matched with PostgreSQL's own full-text search, which every server
 * has. `language` is a text search configuration; the default, "simple",
 * does no stemming and so works for any language.
 */
export const fullText = (
  parts: SearchParts,
  options: { readonly language?: string } = {},
): WordsSearch =>
  Object.freeze({
    [WORDS]: Object.freeze({
      kind: "fullText" as const,
      parts: weighted("fullText", parts),
      language: options.language ?? "simple",
    }),
  });

/** pgvector indexes `vector` columns of at most 2,000 dimensions. */
const MAX_INDEXED_SIZE = 2000;

/**
 * A model for searching by meaning: `embedder(1024, (texts, kind) => …)`.
 * The result is called with the columns whose text describes a row,
 * `meaning: model(chunk.title, chunk.content)`.
 */
export const embedder = (
  size: number,
  embed: EmbeddingModel["embed"],
  options: { readonly name?: string } = {},
): ((...sources: Text[]) => MeaningSearch) & {
  readonly model: EmbeddingModel;
} => {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_INDEXED_SIZE) {
    throw new Error(
      `symmetria: an embedding has between 1 and ${MAX_INDEXED_SIZE} dimensions`,
    );
  }

  if (typeof embed !== "function") {
    throw new Error("symmetria: embedder() requires a function");
  }

  const model: EmbeddingModel = Object.freeze({
    name: options.name ?? "custom",
    size,
    embed,
  });

  return Object.assign(
    (...sources: Text[]): MeaningSearch => {
      if (!sources.length) {
        throw new Error(
          `symmetria: ${model.name} needs the columns whose text it reads`,
        );
      }

      for (const source of sources) {
        if (!isText(source) || readColumn(source).node.kind !== "column") {
          throw new Error(
            `symmetria: ${model.name} reads the table's own text columns`,
          );
        }
      }

      return Object.freeze({
        [MEANING]: Object.freeze({ model, sources: Object.freeze(sources) }),
      });
    },
    { model },
  );
};

/** A declared search, read: its name and what each half is made of. */
export type Search = {
  readonly name: string;
  readonly words?: WordsSearch[typeof WORDS];
  readonly meaning?: MeaningSearch[typeof MEANING];
};

const columnName = (column: Text): string => {
  const { node } = readColumn(column);

  if (node.kind !== "column") {
    throw new Error("symmetria: a search reads plain columns");
  }

  return node.description.column.name;
};

/** Names of the columns a half of a search reads. */
export const searchColumns = (
  half:
    | { readonly parts: readonly { readonly column: Text }[] }
    | {
        readonly sources: readonly Text[];
      },
): readonly string[] =>
  "parts" in half
    ? half.parts.map((part) => columnName(part.column))
    : half.sources.map(columnName);

/** Runs a table's `.search()` callbacks against a row and checks what they return. */
export const declaredSearches = (
  callbacks: readonly SearchCallback[],
  columns: RuntimeScope[string],
): readonly Search[] => {
  const searches: Search[] = [];

  for (const callback of callbacks) {
    const declared = callback(columns);

    if (!declared || typeof declared !== "object") {
      throw new Error("symmetria: search() expects an object of searches");
    }

    for (const [name, entry] of Object.entries(declared)) {
      if (searches.some((search) => search.name === name)) {
        throw new Error(`symmetria: duplicate search "${name}"`);
      }

      if (!entry || typeof entry !== "object") {
        throw new Error(
          `symmetria: search "${name}" is an object with words, meaning or both`,
        );
      }

      for (const key of Object.keys(entry)) {
        if (key !== "words" && key !== "meaning") {
          throw new Error(
            `symmetria: search "${name}" has words and meaning, not "${key}"`,
          );
        }
      }

      const words = entry.words?.[WORDS];
      const meaning = entry.meaning?.[MEANING];

      if (entry.words !== undefined && !words) {
        throw new Error(
          `symmetria: "${name}.words" is declared with bm25() or fullText()`,
        );
      }

      if (entry.meaning !== undefined && !meaning) {
        throw new Error(
          `symmetria: "${name}.meaning" is declared with an embedding model, such as voyage4(…)`,
        );
      }

      if (!words && !meaning) {
        throw new Error(
          `symmetria: search "${name}" declares neither words nor meaning`,
        );
      }

      searches.push(
        Object.freeze({
          name,
          ...(words ? { words } : {}),
          ...(meaning ? { meaning } : {}),
        }),
      );
    }
  }

  return Object.freeze(searches);
};

/** The hidden column that stores a full-text search's document. */
export const wordsColumn = (search: string): string => `${search}Words`;

/** The document a full-text search matches; a generated column stores it. */
export const wordsDocument = (words: NonNullable<Search["words"]>) =>
  searchDocument(
    Object.fromEntries(
      WEIGHTS.flatMap((weight) => {
        const columns = words.parts
          .filter((part) => part.weight === weight)
          .map((part) => part.column);

        return columns.length ? [[weight, columns]] : [];
      }),
    ),
    { language: words.language },
  );

/** What `.search()` adds to a table: hidden vector columns, indexes and extensions. */
export const lowerSearch = (
  callback: SearchCallback,
  draft: TableBinding,
  state: TableState,
): Pick<
  TableState,
  "columns" | "indexCallbacks" | "searchCallbacks" | "extensions"
> => {
  const row = createScope({ [draft.alias]: draft })[draft.alias]!;
  const taken = new Set(
    declaredSearches(state.searchCallbacks, row).map((search) => search.name),
  );
  const searches = declaredSearches([callback], row);
  const columns: Record<string, unknown> = Object.create(null);
  const extensions = new Set(state.extensions);
  const names = new Set(draft.table.columns.map((column) => column.name));

  for (const search of searches) {
    if (taken.has(search.name)) {
      throw new Error(`symmetria: duplicate search "${search.name}"`);
    }

    if (search.words?.kind === "bm25") {
      extensions.add("pg_search");
    }

    if (search.meaning) {
      if (
        names.has(search.name) ||
        Object.hasOwn(state.slots, search.name) ||
        Object.hasOwn(state.throughs, search.name)
      ) {
        throw new Error(
          `symmetria: search "${search.name}" keeps its embedding in a column of that name, which the table already has`,
        );
      }

      extensions.add("vector");
      // Nullable: a table that already has rows can gain a search, and a row
      // whose embedding is not there yet is still found by its words.
      columns[search.name] = hiddenColumn(
        vector(search.meaning.model.size).nullable,
      );
    }

    if (search.words?.kind === "fullText") {
      const stored = wordsColumn(search.name);

      if (
        names.has(stored) ||
        Object.hasOwn(columns, stored) ||
        Object.hasOwn(state.slots, stored) ||
        Object.hasOwn(state.throughs, stored)
      ) {
        throw new Error(
          `symmetria: search "${search.name}" keeps its document in a column named "${stored}", which the table already has`,
        );
      }

      // PostgreSQL computes it from the text columns on every write.
      columns[stored] = hiddenColumn(tsvector.nullable);
    }
  }

  const indexes: TableIndexCallback = (table) => {
    const definitions: Record<string, IndexDefinition> = {};

    for (const search of declaredSearches([callback], table)) {
      if (search.meaning) {
        definitions[`${search.name}Meaning`] = index(
          operatorClass(
            table[search.name] as SelectedColumn,
            "vector_cosine_ops",
          ),
        ).using("hnsw");
      }

      if (search.words?.kind === "fullText") {
        // Ranking reads the stored document; parsing the text of every
        // matching row again is what made a common word slow.
        definitions[`${search.name}Words`] = storedIndex(
          index(wordsDocument(search.words)).using("gin"),
          wordsColumn(search.name),
        );
      }

      if (search.words?.kind === "bm25") {
        const key = Object.values(table).find((column) => {
          const { node } = readColumn(column as SelectedColumn);

          return node.kind === "column" && node.description.column.primaryKey;
        });

        if (!key) {
          throw new Error(
            `symmetria: bm25() needs a primary key on the table of search "${search.name}"`,
          );
        }

        definitions[`${search.name}Words`] = index(
          key as SelectedColumn,
          ...search.words.parts.map((part) => part.column),
        ).using("bm25");
      }
    }

    return definitions;
  };

  return {
    columns: Object.freeze({ ...state.columns, ...columns }),
    indexCallbacks: Object.freeze([...state.indexCallbacks, indexes]),
    searchCallbacks: Object.freeze([...state.searchCallbacks, callback]),
    extensions: Object.freeze([...extensions].sort()),
  };
};

searchLowering.lower = lowerSearch;

/** The `.search()` callbacks of each assembled table, for the query side. */
export const tableSearches = new WeakMap<object, readonly SearchCallback[]>();
