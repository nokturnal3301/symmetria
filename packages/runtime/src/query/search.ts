/**
 * `table.search()`: one statement that ranks a table's rows by words, by
 * meaning, or by both. Each way of searching is a ranked list of primary
 * keys in a CTE; several lists are merged by reciprocal rank fusion, where a
 * row scores 1 / (60 + its place) in every list that has it.
 */
import { primaryKeyColumns, type TableSnapshot } from "../schema/assembly";
import {
  declaredSearches,
  wordsColumn,
  type wordsDocument,
  type EmbeddingModel,
  type Search,
  type SearchCallback,
} from "../schema/search";
import { rowNumber, sql } from "./expressions";
import { QUERY_TAG, WRITE_TAG, type Awaitable } from "./plan/types";
import { FULL_JOIN } from "./select/joins";
import { equalityPredicates, plainRecord } from "./select/shape";
import type { RuntimeScope } from "./select/types";

/** Reciprocal rank fusion's damping constant; 60 is the value from the original paper. */
const RRF_K = 60;
const DEFAULT_LIMIT = 10;
/** Each list contributes at least this many rows, and four times the limit beyond it. */
const MIN_CANDIDATES = 40;
/** BM25 boosts of the weights A to D: a title outweighs a body two to one. */
const BOOSTS = { A: 4, B: 2, C: 1, D: 0.5 } as const;

type Row = RuntimeScope[string];
type Tools = Record<string | symbol, unknown> & { sql: typeof sql };
type Callable = (...argumentsList: unknown[]) => Source;
type Source = Callable & {
  cte: (name: string) => Source;
  execute: () => Promise<Record<string, unknown>[]>;
  toSQL: () => { sql: string; parameters: unknown[] };
};

/** `sql` called with strings built at run time. */
const template = (strings: string[], ...values: unknown[]) =>
  sql(Object.assign([...strings], { raw: [...strings] }), ...values);

/**
 * A question as a full-text query that matches any of its words: `websearch`
 * would demand all of them, and a question shares few words with its answer.
 * A word keeps its combining marks (Hindi, Thai, Arabic vowels, decomposed
 * accents) and the `@ . - _ /` inside it, so an address or a host name stays
 * the one word PostgreSQL's parser makes of it. Nothing else survives, so the
 * raw query syntax cannot break.
 */
const anyWord = (text: string): string =>
  [
    ...new Set(
      text
        .toLowerCase()
        .match(/[\p{L}\p{N}\p{M}]+(?:[@._\-/][\p{L}\p{N}\p{M}]+)*/gu) ?? [],
    ),
  ]
    .slice(0, 64)
    .join(" | ");

/** What was asked of one declared search: words, an embedding, or both. */
type Input = { text?: string; vector?: readonly number[] };

const readInput = (name: string, value: unknown): Input => {
  if (typeof value === "string") {
    // PostgreSQL text cannot hold a zero byte.
    return { text: value.replaceAll("\0", "") };
  }

  if (Array.isArray(value)) {
    return { vector: value as number[] };
  }

  if (plainRecord(value)) {
    for (const key of Object.keys(value)) {
      if (key !== "text" && key !== "vector") {
        throw new Error(
          `symmetria: search "${name}" takes text, vector or both, not "${key}"`,
        );
      }
    }

    const { text, vector } = value;

    if (text !== undefined && typeof text !== "string") {
      throw new Error(`symmetria: search "${name}" text must be a string`);
    }

    if (vector !== undefined && !Array.isArray(vector)) {
      throw new Error(
        `symmetria: search "${name}" vector must be an array of numbers`,
      );
    }

    return {
      ...(text !== undefined ? { text: text.replaceAll("\0", "") } : {}),
      ...(vector !== undefined ? { vector: vector as number[] } : {}),
    };
  }

  throw new Error(
    `symmetria: search "${name}" takes a string, an embedding, or { text, vector }`,
  );
};

/** One ranked list: the extra filter that defines it and the order of its rows. */
type List = {
  readonly label: string;
  readonly filter: (row: Row) => unknown;
  readonly order: (row: Row) => unknown;
  /**
   * What `order` sorts by, when it carries the question. Selected next to the
   * position, it makes the list send the question once for both, and so read
   * as one expression to PostgreSQL, whichever plan it runs.
   */
  readonly rank?: (row: Row) => unknown;
  /** Rows of equal rank come in key order, so a search repeats its answer. */
  readonly ties?: boolean;
  /** Ranked by distance from a vector, through the column's HNSW index. */
  readonly vector?: boolean;
};

/**
 * Up to this many rows that pass the filters are ranked by comparing every
 * one of them; beyond it the vector index answers.
 */
const EXACT_ROWS = 10_000;

/** Rows found without one of the searches asked for, and why. */
export type PartialSearch = {
  readonly search: string;
  readonly error: unknown;
};

export type SearchRun = Awaitable<Record<string, unknown>[]> & {
  readonly execute: () => Promise<Record<string, unknown>[]>;
  readonly toSQL: () => Promise<{ sql: string; parameters: unknown[] }>;
};

export const createSearch = (
  queryTable: object,
  table: TableSnapshot,
  callbacks: readonly SearchCallback[],
  /** The searches read once against the table's own columns: names and models. */
  declared: readonly Search[],
  /** Whether a $scope() filter narrows every read of the table. */
  scoped: boolean,
) => {
  const source = queryTable as Source;
  const keys = primaryKeyColumns(table);
  const searchOf = (row: Row, name: string): Search =>
    declaredSearches(callbacks, row).find((search) => search.name === name)!;

  return (first?: unknown, second?: unknown): SearchRun => {
    const shape = typeof first === "function" ? (first as Callable) : undefined;
    const options = shape ? (second ?? {}) : (first ?? {});

    if (!plainRecord(options)) {
      throw new Error("symmetria: search() options must be an object");
    }

    if (keys.length !== 1) {
      throw new Error(
        `symmetria: search() needs a single-column primary key on "${table.name}"`,
      );
    }

    const key = keys[0]!.name;
    const { where, limit = DEFAULT_LIMIT, candidates, ...asked } = options;

    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    ) {
      throw new Error("symmetria: search() limit must be a positive integer");
    }

    const inputs = Object.entries(asked).flatMap(([name, value]) => {
      const search = declared.find((entry) => entry.name === name);

      if (!search) {
        throw new Error(
          `symmetria: "${table.name}" has no search "${name}"; it declares ${declared.map((entry) => `"${entry.name}"`).join(", ") || "none"}`,
        );
      }

      return value === undefined
        ? []
        : [{ search, input: readInput(name, value) }];
    });

    if (!inputs.length) {
      throw new Error(
        `symmetria: search() needs what to search for, for example { ${declared[0]?.name ?? "about"}: "…" }`,
      );
    }

    const size =
      candidates === undefined
        ? Math.max(MIN_CANDIDATES, limit * 4)
        : (candidates as number);

    if (!Number.isSafeInteger(size) || size < limit) {
      throw new Error(
        "symmetria: search() candidates must be an integer of at least the limit",
      );
    }

    const filtered = (row: Row, tools: unknown): unknown[] => {
      const value =
        typeof where === "function"
          ? (where as (row: Row, tools: unknown) => unknown)(row, tools)
          : where;
      const resolved = plainRecord(value)
        ? equalityPredicates(row, value)
        : value;

      return resolved === undefined
        ? []
        : Array.isArray(resolved)
          ? resolved
          : [resolved];
    };

    /** The lists of this search; embeddings a model must compute come first. */
    type Ranked = { lists: List[]; partial?: PartialSearch };
    let ranking: Promise<Ranked> | undefined;
    // An embedding is asked for once, whether the search runs or only prints its SQL.
    const lists = (): Promise<Ranked> => (ranking ??= rank());
    const rank = async (): Promise<Ranked> => {
      const result: List[] = [];
      let partial: PartialSearch | undefined;

      for (const { search, input } of inputs) {
        const { name } = search;

        // An empty question finds nothing, whichever way it is searched.
        if (!input.vector && !input.text?.trim()) {
          continue;
        }
        const words =
          search.words && input.text !== undefined ? input.text : undefined;
        let vector = search.meaning ? input.vector : undefined;

        if (search.meaning && !vector && input.text !== undefined) {
          try {
            vector = await embedQuery(search.meaning.model, input.text);
          } catch (error) {
            // Words still answer; without them there is nothing to fall back on.
            if (words === undefined) {
              throw error;
            }

            partial ??= { search: name, error };
          }
        }

        if (input.vector && !search.meaning) {
          throw new Error(
            `symmetria: search "${name}" declares no meaning to compare a vector with`,
          );
        }

        if (vector && vector.length !== search.meaning!.model.size) {
          throw new Error(
            `symmetria: search "${name}" compares vectors of ${search.meaning!.model.size} numbers, received ${vector.length}`,
          );
        }

        if (words === undefined && !vector) {
          throw new Error(
            `symmetria: search "${name}" matches ${search.words ? "words" : "meaning"}; give it ${search.words ? "text" : "text or a vector"}`,
          );
        }

        if (vector) {
          const embedding = vector;
          const distance = (row: Row) =>
            (
              row[name] as unknown as {
                cosineDistance: (value: readonly number[]) => {
                  ascending: unknown;
                };
              }
            ).cosineDistance(embedding);

          result.push({
            label: `${name}_meaning`,
            filter: (row) =>
              (
                row[name] as unknown as { isNot: (value: null) => unknown }
              ).isNot(null),
            order: (row) => distance(row).ascending,
            rank: distance,
            vector: true,
          });
        }

        if (words !== undefined) {
          const kind = search.words!.kind;

          if (kind === "fullText") {
            const query = anyWord(words);
            const { language } = search.words!;
            // The document as its generated column stores it.
            const stored = (row: Row) =>
              row[wordsColumn(name)] as unknown as ReturnType<
                typeof wordsDocument
              >;
            const document = (row: Row) => ({
              search: (text: string, options: { mode: "raw" }) =>
                stored(row).search(text, { ...options, language }),
              searchRank: (text: string, options: { mode: "raw" }) =>
                stored(row).searchRank(text, { ...options, language }),
            });

            if (query) {
              result.push({
                label: `${name}_words`,
                filter: (row) => document(row).search(query, { mode: "raw" }),
                order: (row) =>
                  document(row).searchRank(query, { mode: "raw" }).descending,
                rank: (row) => document(row).searchRank(query, { mode: "raw" }),
                ties: true,
              });
            }
          } else if (words.trim()) {
            result.push({
              label: `${name}_words`,
              filter: (row) => {
                const { parts } = searchOf(row, name).words!;
                const strings = ["("];
                const values: unknown[] = [];

                parts.forEach((part, position) => {
                  values.push(part.column, words);
                  strings.push(
                    " ||| ",
                    `::pdb.boost(${BOOSTS[part.weight]})${position < parts.length - 1 ? " OR " : ")"}`,
                  );
                });

                // A boolean expression becomes a condition by comparing it
                // with TRUE, which PostgreSQL folds away while planning.
                return (
                  template(strings, ...values) as unknown as {
                    is: (value: unknown) => unknown;
                  }
                ).is(template(["TRUE"]));
              },
              order: (row) =>
                (
                  template(["pdb.score(", ")"], row[key]) as unknown as {
                    descending: unknown;
                  }
                ).descending,
            });
          }
        }
      }

      return { lists: result, ...(partial ? { partial } : {}) };
    };

    const build = (ranked: List[]): Source | undefined => {
      if (!ranked.length) {
        return undefined;
      }

      const order = (list: List, row: Row): unknown[] => [
        list.order(row),
        ...(list.ties
          ? [(row[key] as unknown as { ascending: unknown }).ascending]
          : []),
      ];
      // A condition on no row at all: PostgreSQL checks it before it scans.
      type Gated = List & { readonly gate?: (tools: Tools) => unknown[] };
      const narrowed = where !== undefined || scoped;
      const gated = ranked.flatMap((list): Gated[] => {
        if (!list.vector) {
          return [list];
        }

        if (!narrowed) {
          return [list];
        }

        // The index finds a query's neighbours and only then meets the
        // filters, so the fewer rows they keep, the further it has to look.
        // Few enough rows are faster, and exactly, ranked one by one; the
        // list that does not apply is skipped without reading the table.
        const probe = source((row: Row) => ({ id: row[key] }), {
          where: (row: Row, tools: unknown) => [
            ...filtered(row, tools),
            list.filter(row),
          ],
          limit: EXACT_ROWS + 1,
        }).cte(`search_${list.label}_probe`);
        const matches = (tools: Tools) =>
          (
            probe((_row: Row) => ({
              matches: (tools.count as () => unknown)(),
            })) as unknown as {
              scalar: () => {
                atMost: (value: number) => unknown;
                above: (value: number) => unknown;
              };
            }
          ).scalar();
        // `+ 0` keeps the index out of it: an ordering it cannot produce.
        const exact = (row: Row) =>
          template(["(", ") + 0"], list.rank!(row)) as unknown as {
            ascending: unknown;
          };

        return [
          {
            ...list,
            label: `${list.label}_exact`,
            order: (row) => exact(row).ascending,
            rank: exact,
            ties: true,
            gate: (tools) => [matches(tools).atMost(EXACT_ROWS)],
          },
          {
            ...list,
            gate: (tools) => [matches(tools).above(EXACT_ROWS)],
          },
        ];
      });
      const tables = gated.map((list) =>
        source(
          (row: Row) => ({
            id: row[key],
            position: rowNumber().over({ orderBy: order(list, row) as never }),
            ...(list.rank ? { rank: list.rank(row) } : {}),
          }),
          {
            where: (row: Row, tools: unknown) => [
              ...(list.gate?.(tools as Tools) ?? []),
              ...filtered(row, tools),
              list.filter(row),
            ],
            orderBy: (row: Row) => order(list, row),
            limit: size,
          },
        ).cte(`search_${list.label}`),
      );
      const reciprocal = (position: unknown) =>
        template([`coalesce(1.0 / (${RRF_K} + `, "), 0)"], position);
      // Each step joins one more list; a row missing from a side scores 0 there.
      const fused = tables.slice(1).reduce(
        (merged, next, step) =>
          merged((left: Row, tools: Tools) => {
            const right = (tools[FULL_JOIN] as Callable)(next, (row: Row) =>
              (left.id as unknown as { is: (value: unknown) => unknown }).is(
                row.id,
              ),
            ) as unknown as Row;

            return {
              id: tools.sql`coalesce(${left.id}, ${right.id})`,
              score:
                step === 0
                  ? tools.sql`${reciprocal(left.position)} + ${reciprocal(right.position)}`
                  : tools.sql`coalesce(${left.score}, 0) + ${reciprocal(right.position)}`,
            };
          }).cte(`search_fused${step ? `_${step + 1}` : ""}`),
        tables[0]!,
      );
      const single = tables.length === 1;

      return fused(
        (found: Row, tools: Tools) => {
          const row = (tools.innerJoin as Callable)(source, (joined: Row) =>
            (joined[key] as unknown as { is: (value: unknown) => unknown }).is(
              found.id,
            ),
          ) as unknown as Row;

          return shape ? shape(row, tools) : { ...row };
        },
        {
          orderBy: (found: Row) =>
            single
              ? [
                  (found.position as unknown as { ascending: unknown })
                    .ascending,
                ]
              : [
                  (found.score as unknown as { descending: unknown })
                    .descending,
                  (found.id as unknown as { ascending: unknown }).ascending,
                ],
          limit,
        },
      );
    };

    const execute = async () => {
      const { lists: ranked, partial } = await lists();
      const rows = (await build(ranked)?.execute()) ?? [];

      // Said on the result rather than thrown: the rows are still an answer.
      return partial
        ? Object.defineProperty(rows, "partial", { value: partial })
        : rows;
    };
    let running: Promise<Record<string, unknown>[]> | undefined;
    const run = () => (running ??= execute());

    return {
      execute: run,
      toSQL: async () => {
        const query = build((await lists()).lists);

        if (!query) {
          throw new Error("symmetria: this search has no words to look for");
        }

        return query.toSQL();
      },
      [Symbol.toStringTag]: QUERY_TAG,
      then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
      catch: (onRejected) => run().catch(onRejected),
      finally: (onFinally) => run().finally(onFinally),
    };
  };
};

/** A model's answer as a vector it can store: its length, finite numbers only. */
const modelVector = (
  model: EmbeddingModel,
  vector: readonly number[] | undefined,
  what: string,
): readonly number[] => {
  if (!vector || vector.length !== model.size) {
    throw new Error(
      `symmetria: ${model.name} returned ${vector ? `${vector.length} numbers` : "nothing"} for ${what}; ${model.size} expected`,
    );
  }

  // pgvector stores no NaN or infinity; a model that answers one failed.
  if (!vector.every(Number.isFinite)) {
    throw new Error(
      `symmetria: ${model.name} returned a number that is not finite for ${what}`,
    );
  }

  return vector;
};

const embedQuery = async (
  model: EmbeddingModel,
  text: string,
): Promise<readonly number[]> => {
  const [vector] = await model.embed([text], "query");

  return modelVector(model, vector, "a question");
};

/** The text a model embeds for a row: its source columns, one per paragraph. */
export const documentText = (
  sources: readonly string[],
  row: Record<string, unknown>,
): string =>
  sources
    .map((name) => row[name])
    .filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    .join("\n\n");

/** The searches of a table that keep an embedding, with the columns it is made from. */
type Embedded = {
  readonly column: string;
  readonly model: EmbeddingModel;
  readonly sources: readonly string[];
  /**
   * Source columns whose value a row that leaves them out does not tell:
   * PostgreSQL fills in their default.
   */
  readonly defaults?: ReadonlySet<string>;
};

export const embeddedSearches = (
  declared: readonly Search[],
  sourceNames: (search: NonNullable<Search["meaning"]>) => readonly string[],
  table?: TableSnapshot,
): readonly Embedded[] =>
  declared.flatMap((search) => {
    if (!search.meaning) {
      return [];
    }

    const sources = sourceNames(search.meaning);

    return [
      {
        column: search.name,
        model: search.meaning.model,
        sources,
        defaults: new Set(
          sources.filter(
            (name) =>
              table?.columns.find((column) => column.name === name)?.default !==
              undefined,
          ),
        ),
      },
    ];
  });

/** A row as a write takes it, also one built without a prototype (nested inserts). */
const writtenRow = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * The text a row's embedding is made of, or undefined when the row does not
 * tell it: a source column holds an SQL expression, or is left out where
 * PostgreSQL decides its value (a default, or the existing row of an upsert).
 */
const knownText = (
  search: Embedded,
  row: Record<string, unknown>,
  conflict: boolean,
): string | undefined => {
  for (const name of search.sources) {
    const value = row[name];

    if (value === undefined) {
      if (conflict || search.defaults?.has(name)) {
        return undefined;
      }
    } else if (value !== null && typeof value !== "string") {
      return undefined;
    }
  }

  return documentText(search.sources, row);
};

/**
 * Rows about to be written, with the embeddings their searches keep. A row
 * that brings its own embedding keeps it; every model is asked once for all
 * the rows that need it. A row whose text is empty, or not known before
 * PostgreSQL writes it (an SQL expression, a left-out column with a default,
 * a left-out column an upsert keeps), gets no embedding (`null`), which
 * `reindex()` computes later; so every row carries the column, as a bulk
 * write requires. `conflict`: the write may update an existing row.
 */
export const embedRows = async (
  embedded: readonly Embedded[],
  rows: readonly Record<string, unknown>[],
  conflict = false,
): Promise<Record<string, unknown>[]> => {
  const result = rows.map((row) => ({ ...row }));

  for (const search of embedded) {
    const { column, model } = search;
    const missing = result.flatMap((row, position) => {
      if (row[column] !== undefined) {
        return [];
      }

      const text = knownText(search, row, conflict);

      if (!text) {
        row[column] = null;

        return [];
      }

      return [{ position, text }];
    });

    if (!missing.length) {
      continue;
    }

    const vectors = await model.embed(
      missing.map((entry) => entry.text),
      "document",
    );

    if (vectors.length !== missing.length) {
      throw new Error(
        `symmetria: ${model.name} returned ${vectors.length} embeddings for ${missing.length} texts`,
      );
    }

    missing.forEach(({ position }, at) => {
      result[position]![column] = modelVector(model, vectors[at], "a text");
    });
  }

  return result;
};

/** Whether any row needs an embedding computed before it is written. */
export const needsEmbedding = (
  embedded: readonly Embedded[],
  rows: readonly unknown[],
): boolean =>
  rows.some(
    (row) =>
      writtenRow(row) &&
      embedded.some(
        (search) =>
          row[search.column] === undefined && !!knownText(search, row, false),
      ),
  );

const TERMINALS = new Set(["then", "catch", "finally", "execute"]);

/**
 * A write that has to wait for its embeddings: the calls chained onto it
 * (`returning()`, `onConflict()`…) are remembered and made on the real
 * builder once it exists. `start` receives them as a function, so it can
 * try the whole write on the rows as given before it asks a model.
 */
export const deferredWrite = (
  start: (
    chained: (builder: object) => object,
    /** The chained calls, such as `onConflict("slug")`, with their arguments. */
    calls: readonly (readonly [string, readonly unknown[]])[],
  ) => Promise<{
    readonly builder: object;
    /** The chained calls were already made on `builder`. */
    readonly chained?: true;
  }>,
  chain: readonly (readonly [string, readonly unknown[]])[] = [],
): object => {
  let running: Promise<unknown> | undefined;
  const chained = (builder: object) =>
    chain.reduce(
      (current, [method, argumentsList]) =>
        (current as Record<string, (...values: readonly unknown[]) => object>)[
          method
        ]!(...argumentsList),
      builder,
    );
  const run = () =>
    (running ??= start(chained, chain).then((started) =>
      (
        (started.chained ? started.builder : chained(started.builder)) as {
          execute: () => Promise<unknown>;
        }
      ).execute(),
    ));

  return new Proxy(Object.create(null) as object, {
    get: (_target, key) => {
      if (key === Symbol.toStringTag) {
        return WRITE_TAG;
      }

      if (typeof key !== "string") {
        return undefined;
      }

      if (key === "execute") {
        return run;
      }

      if (TERMINALS.has(key)) {
        return (...handlers: unknown[]) =>
          (
            run() as unknown as Record<
              string,
              (...values: unknown[]) => unknown
            >
          )[key]!(...handlers);
      }

      if (key === "toSQL" || key === "prepare") {
        return () => {
          throw new Error(
            `symmetria: ${key}() cannot wait for embeddings; pass them with the rows, or await the write`,
          );
        };
      }

      return (...argumentsList: unknown[]) =>
        deferredWrite(start, [...chain, [key, argumentsList]]);
    },
  });
};

type Writable = Source & {
  update: (
    values: (row: Row) => Record<string, unknown>,
    options: { where: (row: Row) => unknown[] },
  ) => PromiseLike<{ affectedRows: number }>;
  count: () => Promise<number>;
};

type ReindexOptions = {
  readonly where?: unknown;
  readonly batch?: number;
  readonly order?: "asc" | "desc";
};

/** Separates the source columns of a document, as `documentText` joins them. */
const PARAGRAPH = "\n\n";

/** The filter of `reindex()` and `missing()`: rows of a search that still need an embedding. */
const unembedded = (
  search: Embedded,
  where: unknown,
  row: Row,
  tools: unknown,
): unknown[] => {
  const value =
    typeof where === "function"
      ? (where as (row: Row, tools: unknown) => unknown)(row, tools)
      : where;
  const filter = plainRecord(value) ? equalityPredicates(row, value) : value;

  return [
    ...(filter === undefined ? [] : Array.isArray(filter) ? filter : [filter]),
    (row[search.column] as unknown as { is: (value: null) => unknown }).is(
      null,
    ),
    // A row with no text has nothing to embed; it is left out in SQL, so it
    // is not read again on every call.
    template(["", " <> ''"], documentSQL(search.sources, row)),
  ];
};

/**
 * The text a row's embedding is made from, computed by PostgreSQL the way
 * `documentText` computes it: the non-empty source columns, one per
 * paragraph (`concat_ws(sep, NULLIF(a, ''), NULLIF(b, ''))`).
 */
const documentSQL = (sources: readonly string[], row: Row) =>
  template(
    [
      "concat_ws(",
      ...sources.map((_name, position) =>
        position === 0 ? ", NULLIF(" : ", ''), NULLIF(",
      ),
      ", ''))",
    ],
    PARAGRAPH,
    ...sources.map((name) => row[name]),
  );

const readOptions = (table: TableSnapshot, options: ReindexOptions) => {
  const keys = primaryKeyColumns(table);

  if (keys.length !== 1) {
    throw new Error(
      `symmetria: reindex() needs a single-column primary key on "${table.name}"`,
    );
  }

  const batch = options.batch ?? 100;

  if (!Number.isSafeInteger(batch) || batch < 1) {
    throw new Error("symmetria: reindex() batch must be a positive integer");
  }

  const order = options.order ?? "asc";

  if (order !== "asc" && order !== "desc") {
    throw new Error('symmetria: reindex() order is "asc" or "desc"');
  }

  return { key: keys[0]!.name, batch, order };
};

/**
 * `table.search.reindex()`: computes the embeddings that are missing, such as
 * those of rows written before the search was declared or cleared by an
 * UPDATE of their text. Returns how many rows it embedded.
 */
export const createReindex =
  (queryTable: object, table: TableSnapshot, embedded: readonly Embedded[]) =>
  async (options: ReindexOptions = {}): Promise<number> => {
    const source = queryTable as Writable;
    const { key, batch, order } = readOptions(table, options);
    const { where } = options;
    let embeddedRows = 0;

    for (const search of embedded) {
      const columnType = table.columns.find(
        (column) => column.name === search.column,
      )!.sqlType;
      let last: unknown;

      // By key, so a row that was not written (its text changed meanwhile)
      // is passed once, not met forever.
      for (;;) {
        const rows = await source(
          (row: Row) => ({
            ...Object.fromEntries(
              [key, ...search.sources].map((name) => [name, row[name]]),
            ),
            // The key as PostgreSQL prints it, to address the row in JSON.
            [KEY_TEXT]: template(["(", ")::text"], row[key]),
          }),
          {
            where: (row: Row, tools: unknown) => [
              ...unembedded(search, where, row, tools),
              ...(last === undefined
                ? []
                : [
                    (
                      row[key] as unknown as Record<
                        "above" | "below",
                        (value: unknown) => unknown
                      >
                    )[order === "asc" ? "above" : "below"](last),
                  ]),
            ],
            orderBy: (row: Row) =>
              (
                row[key] as unknown as Record<
                  "ascending" | "descending",
                  unknown
                >
              )[order === "asc" ? "ascending" : "descending"],
            limit: batch,
          },
        ).execute();

        if (!rows.length) {
          break;
        }

        last = rows.at(-1)![key];

        const filled = await embedRows([search], rows);
        const written = filled.filter((row) =>
          Array.isArray(row[search.column]),
        );

        if (!written.length) {
          continue;
        }

        // One statement for the batch. A row keeps what it has when its
        // embedding was written meanwhile, or its text changed while the
        // model was asked: that text is embedded on a later call.
        const vectors = JSON.stringify(
          Object.fromEntries(
            written.map((row) => [
              row[KEY_TEXT],
              `[${(row[search.column] as number[]).join(",")}]`,
            ]),
          ),
        );
        const texts = JSON.stringify(
          Object.fromEntries(
            written.map((row) => [
              row[KEY_TEXT],
              documentText(search.sources, row),
            ]),
          ),
        );
        const ids = written.map((row) => row[key]);
        const { affectedRows } = await source.update(
          (row) => ({
            [search.column]: template(
              ["((", "::text::jsonb) ->> (", `)::text)::${columnType}`],
              vectors,
              row[key],
            ),
          }),
          {
            where: (row) => [
              (
                row[key] as unknown as { in: (values: unknown[]) => unknown }
              ).in(ids),
              (
                row[search.column] as unknown as {
                  is: (value: null) => unknown;
                }
              ).is(null),
              template(
                ["", " = ((", "::text::jsonb) ->> (", ")::text)"],
                documentSQL(search.sources, row),
                texts,
                row[key],
              ),
            ],
          },
        );

        embeddedRows += affectedRows;
      }
    }

    return embeddedRows;
  };

/** `table.search.missing()`: how many embeddings `reindex()` would compute now. */
export const createMissing =
  (queryTable: object, table: TableSnapshot, embedded: readonly Embedded[]) =>
  async (options: Pick<ReindexOptions, "where"> = {}): Promise<number> => {
    const source = queryTable as Writable;

    readOptions(table, options);

    let total = 0;

    for (const search of embedded) {
      total += await (
        source({
          where: (row: Row, tools: unknown) =>
            unembedded(search, options.where, row, tools),
        }) as unknown as Writable
      ).count();
    }

    return total;
  };

/** The field that carries a row's key as text through `reindex()`. */
const KEY_TEXT = "__symmetria_key";
