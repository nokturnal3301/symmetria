/**
 * `table.search()`: one statement that ranks a table's rows by words, by
 * meaning, or by both. Each way of searching is a ranked list of primary
 * keys in a CTE; several lists are merged by reciprocal rank fusion, where a
 * row scores 1 / (60 + its place) in every list that has it.
 */
import { primaryKeyColumns, type TableSnapshot } from "../schema/assembly";
import {
  declaredSearches,
  meaningSource,
  wordsColumn,
  type wordsDocument,
  type EmbeddingModel,
  type MeaningSource,
  type Search,
  type SearchCallback,
} from "../schema/search";
import { shortestReal, type RuntimeCodec } from "./codecs";
import { canonicalType } from "./codecs/type-names";
import { COLUMN_EXPRESSION, rowNumber, sql } from "./expressions";
import {
  DEFAULT_VALUE,
  QUERY_TAG,
  WRITE_TAG,
  type Awaitable,
} from "./plan/types";
import { FULL_JOIN } from "./select/joins";
import { equalityPredicates, plainRecord } from "./select/shape";
import type { RuntimeScope } from "./select/types";
import { exactTextParts } from "./write/nested-input";

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
 * What counts as a space, the same in JavaScript and in PostgreSQL's regular
 * expressions (JavaScript's `\s`, as `trim()` removes it): a text made only of
 * these, no-break spaces and byte order marks included, has nothing to search
 * for or to embed.
 */
const SPACES =
  "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const NOT_SPACE = new RegExp(`[^${SPACES}]`, "u");

/** Whether a text holds anything but spaces. */
const hasText = (value: string | undefined): value is string =>
  value !== undefined && NOT_SPACE.test(value);

/**
 * A word of a question: letters, digits and combining marks (Hindi, Thai,
 * Arabic vowels, decomposed accents), with the `@ . - _ /` inside it, so an
 * address or a host name stays the one word PostgreSQL's parser makes of it.
 */
const WORD = /[\p{L}\p{N}\p{M}]+(?:[@._\-/][\p{L}\p{N}\p{M}]+)*/gu;
/** A run of letters, digits and marks: PostgreSQL's parser makes at most one word of it. */
const PART = /[\p{L}\p{N}\p{M}]+/gu;
/** A question is searched by its first this many distinct words. */
const QUESTION_WORDS = 64;
/**
 * How much more than its words a question may send, so that none makes
 * PostgreSQL build more than about two thousand query nodes: each word at
 * most 16 runs of letters and digits; other spellings and pieces within 128
 * operands and 256 runs in all, 16 runs and 200 characters each; a piece
 * between spaces is sent whole only with at most 8 words.
 */
const QUESTION_OPERANDS = 128;
const QUESTION_PARTS = 256;
const OPERAND_PARTS = 16;
const OPERAND_LENGTH = 200;
const PIECE_WORDS = 8;
/** PostgreSQL keeps no longer word in a document, so a question needs none. */
const LONGEST_WORD = 2047;

/** Text as a quoted operand of the raw query syntax, where it is only ever words. */
const quotedOperand = (text: string): string =>
  `' ${text.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

const partsOf = (text: string): number => text.match(PART)?.length ?? 0;

/** ASCII characters PostgreSQL's parser drops next to a word and between words, outside a URL. */
const DROPPED = "!\"#$%&'()*,;<=>?@[\\\\\\]^`{|}";
const ONLY_DROPPED = new RegExp(`^[${DROPPED}]*$`);
/** Before the first word, also `. : _` and a sign that no digit follows. */
const DROPPED_BEFORE = new RegExp(`^[${DROPPED}.:_+-]*$`);
/**
 * After the last word, also `. : _ + - ~`, but no two of `. _ ~` together,
 * which make a file name (`..`), except an ellipsis (`...`).
 */
const DROPPED_AFTER = new RegExp(`^[${DROPPED}.:_+~-]*$`);
const FILE_NAME = /[._~]{2}/;

/**
 * Whether a spelling makes no lexeme that its words alone do not, which are
 * sent already: PostgreSQL's parser drops what it adds to them (`keys?`,
 * `(account,`, `What's`, `memory:`, `e-mail--`, `...end`). Otherwise it may
 * join a word into another lexeme: a sign before a number (`-5`, `+5`), a
 * path (`/etc/hosts`, `~/x`, `..`, `v1.2-`, `U.S_`), a port, nearly any
 * character in a URL's path or query (after `x.org/`), and a character
 * beyond ASCII, which a database in the C locale reads as a letter. Checked
 * against PostgreSQL 16 and 18 for every run of up to four such characters
 * before and after each kind of word.
 */
const addsNothing = (written: string): boolean => {
  const found = [...written.matchAll(WORD)];
  const first = found[0];
  const last = found.at(-1);

  if (!first || !last || found.some((match) => match[0].includes("/"))) {
    return false;
  }

  const before = written.slice(0, first.index);
  const after = written.slice(last.index + last[0].length);

  return (
    found.every(
      (match, position) =>
        position === 0 ||
        ONLY_DROPPED.test(
          written.slice(
            found[position - 1]!.index + found[position - 1]![0].length,
            match.index,
          ),
        ),
    ) &&
    DROPPED_BEFORE.test(before) &&
    !(/^\p{N}/u.test(first[0]) && /[+-]$/.test(before)) &&
    DROPPED_AFTER.test(after) &&
    !FILE_NAME.test(after.replace(/\.{3,}/g, "!")) &&
    !(last[0].includes(".") && /^[-_]/.test(after))
  );
};

/**
 * A word as sent alone: as written, or its first run of letters and digits
 * when it has more than 16, which every document holding the word also
 * holds; nothing for a word longer than PostgreSQL keeps.
 */
const bareWord = (word: string): string | undefined => {
  const sent = partsOf(word) > OPERAND_PARTS ? word.match(PART)![0] : word;

  return sent.length > LONGEST_WORD ? undefined : sent;
};

/**
 * A question as a full-text query that matches any of its words: `websearch`
 * would demand all of them, and a question shares few words with its answer.
 * Each operand is quoted, and PostgreSQL turns it into lexemes with the
 * document's own parser and dictionaries, lowercasing it as it lowercased the
 * document (`İstanbul`, `ΟΔΟΣ`). Every word is sent bare, so a question finds
 * every row that one of its words finds by itself. The first and last word of a
 * piece between spaces are also sent with what surrounds them, read after a
 * space as in the middle of a document (`/etc/hosts`, `-5`, `./run.sh`), and a
 * short piece of several words whole (the address and query of a URL), within
 * the bounds above. A word made of several lexemes (`e-mail`) matches them as
 * a phrase. The first 64 distinct words count.
 */
const anyWord = (text: string): string => {
  const words = new Map<string, string>();
  const spellings: string[] = [];
  const spell = (written: string): void => {
    if (
      written.length <= OPERAND_LENGTH &&
      partsOf(written) <= OPERAND_PARTS &&
      !addsNothing(written)
    ) {
      spellings.push(written);
    }
  };

  pieces: for (const piece of text.split(/\s+/u)) {
    const found = [...piece.matchAll(WORD)];

    for (const [position, match] of found.entries()) {
      const word = match[0].toLowerCase();

      if (!words.has(word)) {
        if (words.size === QUESTION_WORDS) {
          break pieces;
        }

        words.set(word, match[0]);
      }

      const written = piece.slice(
        position === 0 ? 0 : match.index,
        position === found.length - 1
          ? piece.length
          : match.index + match[0].length,
      );

      if (written !== match[0]) {
        spell(written);
      }
    }

    if (
      found.length > 1 &&
      found.length <= PIECE_WORDS &&
      piece.length <= OPERAND_LENGTH
    ) {
      spell(piece);
    }
  }

  const sent = new Set<string>();
  const operands: string[] = [];
  let parts = 0;
  const send = (written: string): void => {
    const key = written.toLowerCase();

    if (!sent.has(key)) {
      sent.add(key);
      parts += partsOf(written);
      operands.push(quotedOperand(written));
    }
  };

  for (const word of words.values()) {
    const bare = bareWord(word);

    if (bare !== undefined) {
      send(bare);
    }
  }

  for (const written of spellings) {
    if (operands.length >= QUESTION_OPERANDS) {
      break;
    }

    if (parts + partsOf(written) <= QUESTION_PARTS) {
      send(written);
    }
  }

  return operands.join(" | ");
};

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
  /**
   * In a transaction: runs a search that waits for a model in the place it
   * took in the transaction's order when it started, against the table as
   * that place sees it.
   */
  ordered?: InOrder,
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

    /** What one input asks for: words, a vector given, or a text a model embeds. */
    type Step = {
      readonly search: Search;
      readonly words?: string;
      readonly vector?: readonly number[];
      readonly embed?: string;
    };

    /** The steps of this search, checked before any model is asked. */
    const plan = (): Step[] =>
      inputs.flatMap(({ search, input }): Step[] => {
        const { name } = search;

        // An empty question finds nothing, whichever way it is searched.
        if (!input.vector && !hasText(input.text)) {
          return [];
        }

        const words =
          search.words && input.text !== undefined ? input.text : undefined;
        const vector = search.meaning ? input.vector : undefined;

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

        const embed =
          search.meaning && !vector && input.text !== undefined
            ? input.text
            : undefined;

        if (words === undefined && !vector && embed === undefined) {
          throw new Error(
            `symmetria: search "${name}" matches ${search.words ? "words" : "meaning"}; give it ${search.words ? "text" : "text or a vector"}`,
          );
        }

        return [
          {
            search,
            ...(words !== undefined ? { words } : {}),
            ...(vector ? { vector } : {}),
            ...(embed !== undefined ? { embed } : {}),
          },
        ];
      });

    // The question's embeddings a model answered. The search runs again on
    // every await, and asks a model again only where it failed.
    const embedded = new Map<string, readonly number[]>();
    const asking = new Map<string, Promise<readonly number[]>>();
    const ask = ({ search, embed }: Step): Promise<readonly number[]> => {
      const { name } = search;
      let answer = asking.get(name);

      if (!answer) {
        answer = embedQuery(search.meaning!.model, embed!).then(
          (vector) => {
            embedded.set(name, vector);

            return vector;
          },
          (error: unknown) => {
            asking.delete(name);

            throw error;
          },
        );
        asking.set(name, answer);
      }

      return answer;
    };
    /** Asks the models the steps still need, all at once; the failures, by search. */
    const embedAll = async (
      steps: readonly Step[],
    ): Promise<ReadonlyMap<string, unknown>> => {
      const waiting = steps.filter(
        (step) => step.embed !== undefined && !embedded.has(step.search.name),
      );
      const settled = await Promise.allSettled(waiting.map(ask));

      return new Map(
        settled.flatMap((result, position) =>
          result.status === "rejected"
            ? [[waiting[position]!.search.name, result.reason] as const]
            : [],
        ),
      );
    };

    /** The lists of this search once its embeddings are known. */
    type Ranked = { lists: List[]; partial?: PartialSearch };
    const ranked = (
      steps: readonly Step[],
      failures: ReadonlyMap<string, unknown> = new Map(),
    ): Ranked => {
      const result: List[] = [];
      let partial: PartialSearch | undefined;

      for (const step of steps) {
        const { search } = step;
        const { name } = search;
        const { words } = step;
        const vector = step.vector ?? embedded.get(name);

        if (step.embed !== undefined && !vector) {
          const error = failures.get(name);

          // Words still answer; without them there is nothing to fall back on.
          if (words === undefined) {
            throw error;
          }

          partial ??= { search: name, error };
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
          } else if (hasText(words)) {
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

    const build = (ranked: List[], from: Source): Source | undefined => {
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
        const probe = from((row: Row) => ({ id: row[key] }), {
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
        from(
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
          const row = (tools.innerJoin as Callable)(from, (joined: Row) =>
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

    const rows = async (
      { lists, partial }: Ranked,
      from: Source,
    ): Promise<Record<string, unknown>[]> => {
      const found = (await build(lists, from)?.execute()) ?? [];

      // Said on the result rather than thrown: the rows are still an answer.
      return partial
        ? Object.defineProperty(found, "partial", { value: partial })
        : found;
    };
    /**
     * Runs the search, every time it is awaited, as a query does. A question
     * whose embedding is known is sent at once. One a model must embed first
     * keeps the place it took when it started in a transaction's order: the
     * model is asked now, and the statement goes out once it answers, before
     * anything started after it.
     */
    const run = (): Promise<Record<string, unknown>[]> => {
      try {
        const steps = plan();

        if (
          steps.every(
            (step) =>
              step.embed === undefined || embedded.has(step.search.name),
          )
        ) {
          return rows(ranked(steps), source);
        }

        const failures = embedAll(steps);
        const answer = async (from: Source) =>
          rows(ranked(steps, await failures), from);

        return ordered
          ? ordered((from) => answer(from as Source))
          : answer(source);
      } catch (error) {
        return Promise.reject(error);
      }
    };

    return {
      execute: run,
      toSQL: async () => {
        const steps = plan();
        const query = build(ranked(steps, await embedAll(steps)).lists, source);

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

/**
 * Runs `run` in the place an operation takes in a transaction's order when
 * it starts, with the table as that place sees it (`from`).
 */
export type InOrder = <Value>(
  run: (from: object) => Promise<Value>,
) => Promise<Value>;

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

/** A JSON value's keys in one order, as the value is written and as it is read back. */
const sortedKeys = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    return String(value);
  }

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return value;
  }

  const record = value as Record<string, unknown>;

  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((name) => [name, record[name]]),
  );
};

/** Bytes as PostgreSQL writes them: `\x0102`. */
const bytesText = (value: Uint8Array): string =>
  `\\x${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`;

/** A number as a `real` column stores and reads it: 1/3 is 0.33333334. */
const realNumber = (value: number): number => shortestReal(Math.fround(value));

/**
 * A value as JSON text, its object keys sorted: jsonb stores keys in an
 * order of its own. The elements of an array that is not JSON (`bytea[]`,
 * `real[]`) are written as a lone value of their type is: bytes as
 * `\x0102`, a real as stored.
 */
const jsonDocument = (
  value: unknown,
  elements?: { readonly real: boolean },
): string | undefined => {
  try {
    return JSON.stringify(
      value,
      elements
        ? function (this: Record<string, unknown>, key, item) {
            // A Buffer's toJSON() ran first: its bytes are the original.
            const original = this[key];

            return original instanceof Uint8Array
              ? bytesText(original)
              : elements.real && typeof item === "number"
                ? realNumber(item)
                : sortedKeys(key, item);
          }
        : sortedKeys,
    );
  } catch {
    // A value no JSON column holds, which its write refuses.
    return undefined;
  }
};

/**
 * The text a model reads for a source value, as the application writes it
 * and as a read returns it: a string as it is (uuid, numeric, a date, an
 * enum's label…), a number, a bigint or a boolean as JavaScript writes it,
 * a Date as its ISO 8601 text, bytes as PostgreSQL writes them (`\x0102`),
 * and an array or an object as JSON. A JSON column's value is read as it is
 * stored, as JSON: a JSON string is the string itself, anything else its
 * JSON text with object keys sorted, and JSON null no text.
 */
const valueText = (
  value: unknown,
  { json, real }: { readonly json: boolean; readonly real: boolean },
): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (json) {
    // A Date, or another value whose JSON is a string, is stored as that string.
    const text = jsonDocument(value);

    return text === undefined || text === "null"
      ? undefined
      : text.startsWith('"')
        ? (JSON.parse(text) as string)
        : text;
  }

  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return String(real ? realNumber(value) : value);
    case "bigint":
    case "boolean":
      return String(value);
    case "object":
      break;
    default:
      return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return bytesText(value);
  }

  // An object of the application's own (a Decimal) as its text, when it has one.
  return !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null &&
    (value as object).toString !== Object.prototype.toString
    ? String(value)
    : jsonDocument(value, { real });
};

/**
 * The text a model embeds for a row: its source columns, one per paragraph,
 * each as `valueText` writes it. An insert computes it from the values as
 * written, `reindex()` from the values as read.
 */
export const documentText = (
  search: Pick<Embedded, "sources" | "reads">,
  row: Record<string, unknown>,
): string =>
  search.sources
    .map((name) =>
      valueText(row[name], {
        json: !!search.reads?.get(name)?.json,
        real: !!search.reads?.get(name)?.real,
      }),
    )
    .filter((text): text is string => text !== undefined && text !== "")
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
  /** How each source column is read, by its type: see `MeaningSource`. */
  readonly reads?: ReadonlyMap<string, MeaningSource>;
  /** How `reindex()` reads the table's primary key: see `KeyRead`. */
  readonly key?: KeyRead;
};

/**
 * A single-column primary key as `reindex()` addresses rows by it. `exact`:
 * a read returns it as stored (an integer, text, uuid without a codec), so
 * the value read finds the row. Any other key (a timestamptz with
 * microseconds a Date has not, numeric or an interval read in another form,
 * a customType that decodes) is found by its stored value, read as text
 * that casts back to it (`exactTextParts()` of `type`) as `sqlType`.
 */
type KeyRead = {
  readonly exact: boolean;
  readonly type: string;
  readonly sqlType: string;
};

/** Key types a read returns exactly as stored, without a codec. */
const EXACT_KEY =
  /^(?:integer|smallint|bigint|text|uuid|boolean|varchar(?:\(\d+\))?)$/;

const keyRead = (
  table: TableSnapshot | undefined,
  codecs: Readonly<Record<string, RuntimeCodec>> | undefined,
): KeyRead | undefined => {
  const keys = table ? primaryKeyColumns(table) : [];

  if (keys.length !== 1) {
    return undefined;
  }

  const column = keys[0]!;
  const codec = codecs?.[column.name];
  const type = canonicalType(column.sqlType);

  return {
    exact:
      codec === undefined &&
      (!!column.enumerationValues || EXACT_KEY.test(type)),
    type:
      codec?.base ??
      (codec?.element?.base === undefined ? type : `${codec.element.base}[]`),
    sqlType: column.sqlType,
  };
};

/**
 * A row's primary key as text that casts back to its stored value, as
 * template strings around copies of the key: `(key)::text` for a key read
 * exactly, as PostgreSQL prints it.
 */
const keyTextStrings = (key: KeyRead | undefined): string[] =>
  key && !key.exact
    ? exactTextParts(key.type, "\u0000").join("").split("\u0000")
    : ["(", ")::text"];

/** `keyTextStrings()` between two pieces of SQL, after `values`, as a template. */
const withKeyText = (
  key: KeyRead | undefined,
  value: unknown,
  strings: readonly string[],
  values: readonly unknown[],
  after: string,
) => {
  const text = keyTextStrings(key);

  return template(
    [
      ...strings.slice(0, -1),
      `${strings.at(-1)}${text[0]}`,
      ...text.slice(1, -1),
      `${text.at(-1)}${after}`,
    ],
    ...values,
    ...text.slice(1).map(() => value),
  );
};

export const embeddedSearches = (
  declared: readonly Search[],
  sourceNames: (search: NonNullable<Search["meaning"]>) => readonly string[],
  table?: TableSnapshot,
  /** The table's column codecs: a customType's `base` tells its type. */
  codecs?: Readonly<Record<string, RuntimeCodec>>,
): readonly Embedded[] =>
  declared.flatMap((search) => {
    if (!search.meaning) {
      return [];
    }

    const sources = sourceNames(search.meaning);
    const key = keyRead(table, codecs);

    return [
      {
        column: search.name,
        model: search.meaning.model,
        sources,
        ...(key ? { key } : {}),
        defaults: new Set(
          sources.filter(
            (name) =>
              table?.columns.find((column) => column.name === name)?.default !==
              undefined,
          ),
        ),
        reads: new Map(
          sources.flatMap((name) => {
            const column = table?.columns.find(
              (candidate) => candidate.name === name,
            );

            return column
              ? [[name, meaningSource(column, codecs?.[name])] as const]
              : [];
          }),
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

/** A value PostgreSQL computes when it writes the row: an SQL expression, or DEFAULT. */
const computedValue = (value: unknown): boolean =>
  value === DEFAULT_VALUE ||
  (!!value &&
    (typeof value === "object" || typeof value === "function") &&
    COLUMN_EXPRESSION in value);

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
    } else if (computedValue(value)) {
      return undefined;
    }
  }

  return documentText(search, row);
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

      // Only spaces mean nothing, as in a question.
      if (!hasText(text)) {
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
          row[search.column] === undefined &&
          hasText(knownText(search, row, false)),
      ),
  );

const TERMINALS = new Set(["then", "catch", "finally", "execute"]);

/**
 * A write that has to wait for its embeddings: the calls chained onto it
 * (`returning()`, `onConflict()`…) are remembered and made on the real
 * builder once it exists. Like any write it runs each time it is awaited
 * (or `execute()` is called): `start` receives the chained calls, writes,
 * and resolves with what the write returns.
 */
export const deferredWrite = (
  start: (
    /** The chained calls, such as `onConflict("slug")`, with their arguments. */
    calls: readonly (readonly [string, readonly unknown[]])[],
  ) => Promise<unknown>,
  chain: readonly (readonly [string, readonly unknown[]])[] = [],
): object => {
  const run = (): Promise<unknown> => {
    try {
      return start(chain);
    } catch (error) {
      return Promise.reject(error);
    }
  };

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
    // A row with no text (or only spaces) has nothing to embed; it is left
    // out in SQL, so it is not read again on every call.
    hasTextSQL(search, row),
  ];
};

/**
 * Whether a row has text to embed, in SQL, as `documentText` finds it in
 * JavaScript: a source column whose value has text (see `MeaningSource`).
 *
 * A text column (and the text PostgreSQL writes out for a value whose text
 * may be empty: an enum's label, a tsvector, a type not known) holds a
 * character that is not a space. A text that starts with another character
 * is known by it without reading the rest of the text or the next columns:
 * a printable ASCII character by comparing bytes, any other by the regular
 * expression on that one character; only one that starts with a space is
 * matched as a whole, which converts the whole text first. Every comparison
 * and match is under the "C" collation: a regular expression refuses a
 * nondeterministic collation, and an ignorable character is no empty text.
 * No `ascii()`, which raises for a character beyond ASCII in a multibyte
 * encoding other than UTF8 (EUC_JP).
 *
 * A JSON value has text unless it is JSON null or a JSON string without
 * text, which is checked as a text column is; that reads each document for
 * its type. Any other value has text unless it is NULL.
 */
const hasTextSQL = ({ sources, reads }: Embedded, row: Row) => {
  const pattern = `E'[^${SPACES.replaceAll("\\", "\\\\")}]'`;
  const strings = ["("];
  const values: unknown[] = [];

  sources.forEach((name, position) => {
    const check = reads?.get(name)?.check ?? "text";
    const [open, close] =
      check === "output"
        ? ["concat(", ') COLLATE "C"']
        : check === "text" || check === "value"
          ? ["", ' COLLATE "C"']
          : ["(", ` #>> '{}') COLLATE "C"`];
    const spaces = [
      `${close} <> '' AND (left(${open}`,
      `${close}, 1) BETWEEN '!' AND '~' OR left(${open}`,
      `${close}, 1) ~ ${pattern} OR ${open}`,
      `${close} ~ ${pattern})`,
    ];
    // The SQL around each place the column goes.
    const [first, ...rest] =
      check === "value"
        ? ["", " IS NOT NULL"]
        : check === "json" || check === "jsonb"
          ? [
              "",
              ` IS NOT NULL AND CASE ${check}_typeof(`,
              `) WHEN 'string' THEN ${open}`,
              ...spaces.slice(0, -1),
              `${spaces.at(-1)} WHEN 'null' THEN FALSE ELSE TRUE END`,
            ]
          : [open, ...spaces];

    strings[strings.length - 1] += `${position ? " OR " : ""}(${first}`;
    strings.push(...rest.slice(0, -1), `${rest.at(-1)})`);
    rest.forEach(() => values.push(row[name]));
  });
  strings[strings.length - 1] += ")";

  return template(strings, ...values);
};

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
      // A source whose value as read is not its stored text (a type that is
      // not text, a codec that decrypts) is also read as stored.
      const stored = search.sources.map(
        (name) => !search.reads?.get(name)?.plain,
      );
      // A key read in another form than stored is addressed by its stored
      // value, from the text read: a Date without the key's microseconds
      // would find no row to write and page back to the same row for ever.
      const exact = !search.key || search.key.exact;
      const storedKey = (text: unknown) =>
        template(["(", `)::${search.key!.sqlType}`], text);

      // By key, so a row that was not written (its text changed meanwhile)
      // is passed once, not met forever.
      for (;;) {
        const rows = await source(
          (row: Row) => ({
            // Read through their codecs, as a query reads them: the model
            // gets the text an insert of these values gets.
            ...Object.fromEntries(
              [key, ...search.sources].map((name) => [name, row[name]]),
            ),
            // The key as text that casts back to it, to address the row in
            // JSON and to page on.
            [KEY_TEXT]: withKeyText(search.key, row[key], [""], [], ""),
            ...Object.fromEntries(
              search.sources.flatMap((name, position) =>
                stored[position]
                  ? [
                      [
                        `${STORED_TEXT}${position}`,
                        template(["concat(", ")"], row[name]),
                      ],
                    ]
                  : [],
              ),
            ),
          }),
          {
            where: (row: Row, tools: unknown) => [
              ...unembedded(search, where, row, tools),
              ...(last === undefined
                ? []
                : [
                    exact
                      ? (
                          row[key] as unknown as Record<
                            "above" | "below",
                            (value: unknown) => unknown
                          >
                        )[order === "asc" ? "above" : "below"](last)
                      : template(
                          ["(", `) ${order === "asc" ? ">" : "<"} `, ""],
                          row[key],
                          storedKey(last),
                        ),
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

        last = rows.at(-1)![exact ? key : KEY_TEXT];

        const filled = await embedRows([search], rows);
        const written = filled.filter((row) =>
          Array.isArray(row[search.column]),
        );

        if (!written.length) {
          continue;
        }

        // One statement for the batch. A row keeps what it has when its
        // embedding was written meanwhile, or a source changed while the
        // model was asked: what it says now is embedded on a later call.
        // The sources are compared as stored, as PostgreSQL writes them out
        // (`concat()`, '' for NULL): the text the model got may differ.
        const vectors = JSON.stringify(
          Object.fromEntries(
            written.map((row) => [
              row[KEY_TEXT],
              `[${(row[search.column] as number[]).join(",")}]`,
            ]),
          ),
        );
        const unchanged = JSON.stringify(
          Object.fromEntries(
            written.map((row) => [
              row[KEY_TEXT],
              search.sources.map((name, position) =>
                stored[position]
                  ? row[`${STORED_TEXT}${position}`]
                  : (row[name] ?? ""),
              ),
            ]),
          ),
        );
        const ids = written.map((row) => row[exact ? key : KEY_TEXT]);
        const { affectedRows } = await source.update(
          (row) => ({
            [search.column]: withKeyText(
              search.key,
              row[key],
              ["((", "::text::jsonb) ->> "],
              [vectors],
              `)::${columnType}`,
            ),
          }),
          {
            where: (row) => [
              exact
                ? (
                    row[key] as unknown as {
                      in: (values: unknown[]) => unknown;
                    }
                  ).in(ids)
                : template(
                    [
                      "(",
                      ") IN (SELECT (jsonb_array_elements_text(",
                      `::text::jsonb))::${search.key!.sqlType})`,
                    ],
                    row[key],
                    JSON.stringify(ids),
                  ),
              (
                row[search.column] as unknown as {
                  is: (value: null) => unknown;
                }
              ).is(null),
              withKeyText(
                search.key,
                row[key],
                [
                  "jsonb_build_array(concat(",
                  ...search.sources.slice(1).map(() => "), concat("),
                  ")) = ((",
                  "::text::jsonb) -> ",
                ],
                [...search.sources.map((name) => row[name]), unchanged],
                ")",
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
/** The fields that carry a source's stored text through `reindex()`, by its place. */
const STORED_TEXT = "__symmetria_stored_";
