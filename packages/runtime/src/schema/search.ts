/**
 * Searches a table declares with `.search()`: by words (PostgreSQL full text,
 * or BM25 through the `pg_search` extension), by meaning (an embedding kept
 * in a hidden vector column), or by both at once. A declaration lowers to an
 * ordinary column and ordinary indexes, so migrations see nothing new.
 */
import type { TableBinding } from "../query/plan/types";
import type { ColumnSnapshot } from "./assembly";
import {
  COLUMN_EXPRESSION,
  readColumn,
  searchDocument,
  sql,
  type SelectedColumn,
} from "../query/expressions";
import { canonicalType, isBuiltInType } from "../query/codecs/type-names";
import {
  unfixedSearchText,
  unindexableSearchText,
} from "../query/compile/postgres/search";
import { createScope } from "../query/select/scope";
import type { RuntimeScope } from "../query/select/types";
import { hiddenColumn, tsvector } from "./column";
import { halfvec, vector } from "../entries/vector";
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
    /** `"half"`: kept as `halfvec`, in half the space; `"full"` (`vector`) unless `.half` says so. */
    readonly precision: "full" | "half";
  };
  /**
   * The embedding in half precision (`halfvec`, pgvector 0.7+): the column and
   * its index take about half the space, models of up to 4,000 dimensions can
   * be indexed, and the ranking hardly changes.
   */
  readonly half: MeaningSearch;
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

/** Types PostgreSQL reads as text as they are, in the runtime's spelling. */
const TEXT_TYPE =
  /^(?:text|citext|name|bpchar|varchar|char|character)(?:\(\d+\))?$/;
/** Types whose text is always the same, so a stored document can hold it through a cast. */
const FIXED_TEXT_TYPE =
  /^(?:uuid|inet|cidr|macaddr8?|time|timetz|numeric)(?:\([\d,]+\))?$/;
/**
 * The spellings a stored document reads as `column::text` (an inet as
 * `abbrev(column)`). Another spelling of those types (`dec(4,1)`,
 * `pg_catalog.uuid`) is left to `searchDocument()`, which reads it as
 * `(column)::text`.
 */
const STORED_CAST_TYPE =
  /^(?:uuid|inet|cidr|macaddr8?|(?:time|timetz|time with(?:out)? time zone)(?:\s*\(\s*\d\s*\))?|(?:numeric|decimal)(?:\s*\([\d\s,]+\))?)$/i;
/** Numbers, booleans and bytes: text, but no words pg_search can match. */
const VALUE_TYPE =
  /^(?:integer|bigint|smallint|real|double precision|boolean|bytea)$/;

/**
 * How a search reads a column's values as text, by the type in any spelling
 * PostgreSQL accepts (`timestamp(3) with time zone`, `int4`, `_text`):
 * `"text"` as they are (text, varchar, char, citext), `"cast"` through
 * `::text` (uuid, numeric, inet, time), `"value"` a number, a boolean or
 * bytes, `"changing"` for text that is not always the same (an enum, whose
 * values can be renamed, a date, an interval, money or a timestamp, which
 * follow the session's settings), `"unfixed"` for a range or an array, whose
 * text PostgreSQL does not count as fixed either, `"unknown"` for any other
 * type (JSON, a tsvector, bits, a custom type), which a search reads as
 * `searchDocument()` does.
 */
export const columnText = (column: {
  readonly sqlType: string;
  readonly enumerationValues?: readonly string[];
}): "text" | "cast" | "value" | "changing" | "unfixed" | "unknown" => {
  if (column.enumerationValues) {
    return "changing";
  }

  const type = canonicalType(column.sqlType);

  return TEXT_TYPE.test(type)
    ? "text"
    : FIXED_TEXT_TYPE.test(type)
      ? "cast"
      : VALUE_TYPE.test(type)
        ? "value"
        : (unfixedSearchText(type) ?? "unknown");
};

/** Built-in types whose text can be empty: a model may find nothing in it. */
const MAYBE_EMPTY_TYPE = /^(?:tsvector|tsquery|xml|bit|varbit)(?:\(|$)/;

/**
 * How a meaning reads a source column, and how SQL finds, as `documentText`
 * does in JavaScript, that a value has text to embed:
 * - `"text"`: a text column (text, varchar, char, citext) holds a character
 *   that is not a space;
 * - `"output"`: the text PostgreSQL writes out has one, for a value whose text
 *   can be empty or only spaces: an enum's label, a tsvector, xml, bits, a
 *   type not known (a custom type without `base`, which may be a domain
 *   over text), and a custom type read as text whose own type is not a
 *   text type (ltree, hstore, an enum type, a domain), which takes no
 *   collation;
 * - `"json"` / `"jsonb"`: a JSON value is not JSON null, and a JSON string
 *   holds a character that is not a space; any other JSON value's text (its
 *   JSON) is never empty;
 * - `"value"`: the value is not NULL. Every other type's text is never empty:
 *   a number, a boolean, uuid, a date, a timestamp, bytes, an array.
 *
 * `json` marks a source read as JSON. `plain` marks a text column
 * without a codec, whose value as read is its stored text. `real` marks a
 * `real` column or array, whose numbers are embedded as stored.
 */
export type MeaningSource = {
  readonly check: "text" | "output" | "json" | "jsonb" | "value";
  readonly json: boolean;
  readonly plain: boolean;
  readonly real: boolean;
};

/** How a meaning reads a column of a type (a customType's `base`, else its SQL type). */
export const meaningSource = (
  column: {
    readonly sqlType: string;
    readonly enumerationValues?: readonly string[];
  },
  codec?: { readonly base?: string },
): MeaningSource => {
  const type = canonicalType(codec?.base ?? column.sqlType);
  const check: MeaningSource["check"] = column.enumerationValues
    ? "output"
    : type.endsWith("[]")
      ? "value"
      : TEXT_TYPE.test(type)
        ? // A collation applies to a text column itself; a customType read
          // as text (ltree, hstore, an enum type, a domain) through its output.
          TEXT_TYPE.test(canonicalType(column.sqlType))
          ? "text"
          : "output"
        : type === "json" || type === "jsonb"
          ? type
          : isBuiltInType(type) && !MAYBE_EMPTY_TYPE.test(type)
            ? "value"
            : "output";

  return Object.freeze({
    check,
    json: check === "json" || check === "jsonb",
    plain: check === "text" && !codec,
    real: /^real(?:\[\])*$/.test(type),
  });
};

/**
 * A column a words search reads, with the type it is read as: a customType's
 * `base`, else its SQL type. `declared` names it in messages.
 */
const sourceColumn = (column: Text) => {
  const { node, codec } = readColumn(column);
  const snapshot = (node as { description: { column: ColumnSnapshot } })
    .description.column;

  return codec?.base === undefined
    ? { ...snapshot, declared: snapshot.sqlType, own: snapshot.sqlType }
    : {
        ...snapshot,
        sqlType: codec.base,
        declared: `${snapshot.sqlType} (${codec.base})`,
        own: snapshot.sqlType,
      };
};

/**
 * The types pg_search matches words in, by a column's own type: text,
 * varchar, citext, JSON, and arrays of text or varchar. Another type fails
 * when the index is created (char(n), name, a tsvector, xml, an array of
 * char, name or JSON, a multirange) or in every search ("not compatible
 * with the `|||` operator": an array of numbers or citext, a range, a
 * domain or an extension's type such as ltree, whatever its `base`).
 */
const BM25_TYPE =
  /^(?:(?:text|varchar(?:\(\d+\))?)(?:\[\])*|citext|json|jsonb)$/;

/**
 * A words search reads text: `bm25()` columns pg_search matches words in,
 * `fullText()` columns whose text a generated column can store.
 */
const checkWordsColumn = (name: string, column: Text): void => {
  const snapshot = sourceColumn(column);
  const kind = columnText(snapshot);
  // While a table is declared, an enum's type is "enum", its values not yet known.
  const enumeration =
    !!snapshot.enumerationValues || canonicalType(snapshot.sqlType) === "enum";
  const what = enumeration ? "an enum" : `of type ${snapshot.declared}`;

  const own = canonicalType(snapshot.own);

  if (
    name === "bm25" &&
    (kind === "cast" ||
      kind === "value" ||
      kind === "changing" ||
      // A type not known (a customType without `base`) may be one it
      // takes; an array of one is not.
      (!BM25_TYPE.test(own) &&
        (isBuiltInType(own) ||
          own.endsWith("[]") ||
          snapshot.own !== snapshot.sqlType)))
  ) {
    throw new Error(
      `symmetria: bm25() matches words in text columns; "${snapshot.name}" is ${what}, which pg_search cannot match words in`,
    );
  }

  if (name === "fullText" && (kind === "changing" || kind === "unfixed")) {
    throw new Error(
      `symmetria: fullText() cannot read "${snapshot.name}", which is ${what}: ${unindexableSearchText(enumeration ? "enum" : canonicalType(snapshot.sqlType))}, so the generated column that stores the document cannot hold it; keep that text in a text column, or filter by it with where`,
    );
  }
};

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

      checkWordsColumn(name, column);

      return Object.freeze({ column, weight });
    }),
  );
};

/**
 * Words ranked with BM25, which weighs rare words more than common ones. It
 * needs the `pg_search` extension (ParadeDB); migrations create it. It reads
 * text, varchar, citext and JSON columns, arrays of text or varchar, and a
 * `customType()` of an extension's type or a domain declared without `base`;
 * other types are refused, since pg_search cannot match words in them.
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
 * does no stemming and so works for any language. Text columns are read as
 * they are, uuid, numeric, inet and time columns as their text. An enum, a
 * date, an interval, money, a timestamp, a range or an array is refused:
 * its text can change, or PostgreSQL does not count it as fixed, so the
 * generated column that stores the document cannot keep it.
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

/** pgvector indexes `vector` columns of at most 2,000 dimensions, `halfvec` of 4,000. */
const MAX_INDEXED_SIZE = 2000;
const MAX_INDEXED_HALF_SIZE = 4000;

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
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_INDEXED_HALF_SIZE) {
    throw new Error(
      `symmetria: an embedding has between 1 and ${MAX_INDEXED_HALF_SIZE} dimensions (more than ${MAX_INDEXED_SIZE} only in half precision, model(...).half)`,
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

      const meaning = (precision: "full" | "half"): MeaningSearch =>
        Object.freeze({
          [MEANING]: Object.freeze({
            model,
            sources: Object.freeze(sources),
            precision,
          }),
          get half() {
            return meaning("half");
          },
        });

      return meaning("full");
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

/**
 * The document a full-text search matches; a generated column stores it. A
 * column of a type that is not text (uuid, numeric, inet, time) is read as
 * its text. Text columns are read as they are, the expression earlier
 * versions stored, so their documents need no migration. A type this module
 * does not know (a custom type without `base`, which may be a domain over
 * text) is read as it is, as raw SQL.
 */
export const wordsDocument = (words: NonNullable<Search["words"]>) =>
  searchDocument(
    Object.fromEntries(
      WEIGHTS.flatMap((weight) => {
        const columns = words.parts
          .filter((part) => part.weight === weight)
          .map((part) => {
            const column = sourceColumn(part.column);
            const kind = columnText(column);

            // `abbrev()` writes an inet as its output does (`10.0.0.1`, no
            // `/32`); a generated column cannot call the output function.
            return kind === "unknown" &&
              !isBuiltInType(canonicalType(column.sqlType))
              ? (sql`${part.column}` as unknown as Text)
              : kind !== "cast" || !STORED_CAST_TYPE.test(column.sqlType)
                ? part.column
                : /^inet$/i.test(column.sqlType)
                  ? (sql`abbrev(${part.column})` as unknown as Text)
                  : (sql`${part.column}::text` as unknown as Text);
          });

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

      const { model, precision } = search.meaning;

      if (precision === "full" && model.size > MAX_INDEXED_SIZE) {
        throw new Error(
          `symmetria: search "${search.name}": pgvector indexes vectors of at most ${MAX_INDEXED_SIZE} dimensions and ${model.name} has ${model.size}; keep it in half precision, ${model.name}(...).half, or ask the model for fewer`,
        );
      }

      extensions.add("vector");
      // Nullable: a table that already has rows can gain a search, and a row
      // whose embedding is not there yet is still found by its words.
      columns[search.name] = hiddenColumn(
        (precision === "half" ? halfvec : vector)(model.size).nullable,
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
            search.meaning.precision === "half"
              ? "halfvec_cosine_ops"
              : "vector_cosine_ops",
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
