/**
 * `table.search()`: one statement that ranks a table's rows by words, by
 * meaning, or by both. Each way of searching is a ranked list of primary
 * keys in a CTE; several lists are merged by reciprocal rank fusion, where a
 * row scores 1 / (60 + its place) in every list that has it.
 */
import { primaryKeyColumns, type TableSnapshot } from "../schema/assembly";
import {
  declaredSearches,
  wordsDocument,
  type EmbeddingModel,
  type Search,
  type SearchCallback,
} from "../schema/search";
import { rowNumber, sql } from "./expressions";
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
 * Only letters and digits survive, so the raw query syntax cannot break.
 */
const anyWord = (text: string): string =>
  [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .slice(0, 64)
    .join(" | ");

/** What was asked of one declared search: words, an embedding, or both. */
type Input = { text?: string; vector?: readonly number[] };

const readInput = (name: string, value: unknown): Input => {
  if (typeof value === "string") {
    return { text: value };
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
      ...(text !== undefined ? { text } : {}),
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
};

/** Rows found without one of the searches asked for, and why. */
export type PartialSearch = {
  readonly search: string;
  readonly error: unknown;
};

export type SearchRun = PromiseLike<Record<string, unknown>[]> & {
  readonly execute: () => Promise<Record<string, unknown>[]>;
  readonly toSQL: () => Promise<{ sql: string; parameters: unknown[] }>;
  readonly catch: Promise<Record<string, unknown>[]>["catch"];
  readonly finally: Promise<Record<string, unknown>[]>["finally"];
};

export const createSearch = (
  queryTable: object,
  table: TableSnapshot,
  callbacks: readonly SearchCallback[],
  /** The searches read once against the table's own columns: names and models. */
  declared: readonly Search[],
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
            ).cosineDistance(embedding).ascending;

          result.push({
            label: `${name}_meaning`,
            filter: (row) =>
              (
                row[name] as unknown as { isNot: (value: null) => unknown }
              ).isNot(null),
            order: distance,
          });
        }

        if (words !== undefined) {
          const kind = search.words!.kind;

          if (kind === "fullText") {
            const query = anyWord(words);
            const document = (row: Row) =>
              wordsDocument(searchOf(row, name).words!);

            if (query) {
              result.push({
                label: `${name}_words`,
                filter: (row) => document(row).search(query, { mode: "raw" }),
                order: (row) =>
                  document(row).searchRank(query, { mode: "raw" }).descending,
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

      const tables = ranked.map((list) =>
        source(
          (row: Row) => ({
            id: row[key],
            position: rowNumber().over({ orderBy: [list.order(row) as never] }),
          }),
          {
            where: (row: Row, tools: unknown) => [
              ...filtered(row, tools),
              list.filter(row),
            ],
            orderBy: (row: Row) => list.order(row),
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
      then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
      catch: (onRejected) => run().catch(onRejected),
      finally: (onFinally) => run().finally(onFinally),
    };
  };
};

const embedQuery = async (
  model: EmbeddingModel,
  text: string,
): Promise<readonly number[]> => {
  const [vector] = await model.embed([text], "query");

  if (!vector || vector.length !== model.size) {
    throw new Error(
      `symmetria: ${model.name} returned ${vector ? `${vector.length} numbers` : "nothing"} for a question; ${model.size} expected`,
    );
  }

  return vector;
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
};

export const embeddedSearches = (
  declared: readonly Search[],
  sourceNames: (search: NonNullable<Search["meaning"]>) => readonly string[],
): readonly Embedded[] =>
  declared.flatMap((search) =>
    search.meaning
      ? [
          {
            column: search.name,
            model: search.meaning.model,
            sources: sourceNames(search.meaning),
          },
        ]
      : [],
  );

/**
 * Rows about to be written, with the embeddings their searches keep. A row
 * that brings its own embedding, or whose text is not plain strings, is left
 * as it is; every model is asked once for all the rows that need it.
 */
export const embedRows = async (
  embedded: readonly Embedded[],
  rows: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> => {
  const result = rows.map((row) => ({ ...row }));

  for (const { column, model, sources } of embedded) {
    const missing = result.flatMap((row, position) => {
      const text = row[column] === undefined ? documentText(sources, row) : "";

      return text ? [{ position, text }] : [];
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
      const vector = vectors[at]!;

      if (vector.length !== model.size) {
        throw new Error(
          `symmetria: ${model.name} returned ${vector.length} numbers; ${model.size} expected`,
        );
      }

      result[position]![column] = vector;
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
      plainRecord(row) &&
      embedded.some(
        ({ column, sources }) =>
          row[column] === undefined && documentText(sources, row) !== "",
      ),
  );

const TERMINALS = new Set(["then", "catch", "finally", "execute"]);

/**
 * A write that has to wait for its embeddings: the calls chained onto it
 * (`returning()`, `onConflict()`…) are remembered and made on the real
 * builder once it exists.
 */
export const deferredWrite = (
  start: () => Promise<{ readonly builder: object }>,
  chain: readonly (readonly [string, readonly unknown[]])[] = [],
): object => {
  let running: Promise<unknown> | undefined;
  const run = () =>
    (running ??= start().then(({ builder }) => {
      const built = chain.reduce(
        (current, [method, argumentsList]) =>
          (
            current as Record<string, (...values: readonly unknown[]) => object>
          )[method]!(...argumentsList),
        builder,
      );

      return (built as { execute: () => Promise<unknown> }).execute();
    }));

  return new Proxy(Object.create(null) as object, {
    get: (_target, key) => {
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

type Lookup = (key: unknown) => {
  update: (values: Record<string, unknown>) => PromiseLike<unknown>;
};

/**
 * `table.search.reindex()`: computes the embeddings that are missing, such as
 * those of rows written before the search was declared or cleared by an
 * UPDATE of their text. Returns how many rows it embedded.
 */
export const createReindex =
  (queryTable: object, table: TableSnapshot, embedded: readonly Embedded[]) =>
  async (
    options: { readonly where?: unknown; readonly batch?: number } = {},
  ): Promise<number> => {
    const source = queryTable as Source & { byId: Lookup };
    const keys = primaryKeyColumns(table);
    const batch = options.batch ?? 100;

    if (keys.length !== 1) {
      throw new Error(
        `symmetria: reindex() needs a single-column primary key on "${table.name}"`,
      );
    }

    if (!Number.isSafeInteger(batch) || batch < 1) {
      throw new Error("symmetria: reindex() batch must be a positive integer");
    }

    const key = keys[0]!.name;
    const { where } = options;
    let embeddedRows = 0;

    for (const search of embedded) {
      let last: unknown;

      // By key, so a row whose text is empty is passed once, not met forever.
      for (;;) {
        const rows = await source(
          (row: Row) =>
            Object.fromEntries(
              [key, ...search.sources].map((name) => [name, row[name]]),
            ),
          {
            where: (row: Row, tools: unknown) => {
              const value =
                typeof where === "function"
                  ? (where as (row: Row, tools: unknown) => unknown)(row, tools)
                  : where;
              const filter = plainRecord(value)
                ? equalityPredicates(row, value)
                : value;
              const column = row[search.column] as unknown as {
                is: (value: null) => unknown;
              };
              const id = row[key] as unknown as {
                above: (value: unknown) => unknown;
              };

              return [
                ...(filter === undefined
                  ? []
                  : Array.isArray(filter)
                    ? filter
                    : [filter]),
                column.is(null),
                ...(last === undefined ? [] : [id.above(last)]),
              ];
            },
            orderBy: (row: Row) =>
              (row[key] as unknown as { ascending: unknown }).ascending,
            limit: batch,
          },
        ).execute();

        if (!rows.length) {
          break;
        }

        last = rows.at(-1)![key];

        const filled = await embedRows([search], rows);

        for (const row of filled) {
          if (row[search.column] !== undefined) {
            await source
              .byId(row[key])
              .update({ [search.column]: row[search.column] });
            embeddedRows += 1;
          }
        }
      }
    }

    return embeddedRows;
  };
