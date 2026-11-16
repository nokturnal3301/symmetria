import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  many,
  index,
  int,
  text,
  numeric,
  customType,
  operatorClass,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";
import { embedder } from "../../../packages/runtime/src/entries/search";
import { testDatabase } from "../../support/postgres";
import { hasExtension } from "../../support/extensions";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

const moment = customType<Date>("timestamptz", {
  encode: (value) => value,
  decode: (value) => new Date(value as string | Date),
});
const tags = table({ id: int.auto, label: text.unique, books: many });
const books = table({ id: int.auto, title: text, tags: many(tags.books) });
const amounts = table({ id: int.auto, amount: numeric });
const moments = table({ id: int.auto, at: moment });
const model = schema({ tags, books, amounts, moments });

describe.skipIf(!databaseUrl)("fixes of the 2.4.0 bug hunt", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_hunt",
      max: 4,
    });
    database = isolated.database;
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("connectOrCreate of the same rows in opposite orders does not deadlock", async () => {
    await database.tags.insert([{ label: "bun" }, { label: "postgres" }]);

    const results = await Promise.allSettled(
      Array.from({ length: 48 }, (_, position) =>
        database.books.insert({
          title: `book ${position}`,
          tags: {
            connectOrCreate:
              position % 2
                ? [{ label: "bun" }, { label: "postgres" }]
                : [{ label: "postgres" }, { label: "bun" }],
          },
        }),
      ),
    );

    expect(
      results.flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      ),
    ).toEqual([]);
    expect(await database.tags((tag) => ({ id: tag.id })).count()).toBe(2);
    expect(await database.books((book) => ({ id: book.id })).count()).toBe(48);

    // A row that is not there yet is still created, once.
    await Promise.all(
      Array.from({ length: 8 }, (_, position) =>
        database.books.insert({
          title: `late ${position}`,
          tags: { connectOrCreate: [{ label: "new" }] },
        }),
      ),
    );
    expect(await database.tags((tag) => ({ id: tag.id })).count()).toBe(3);
  });

  test("a JavaScript number in a numeric column keeps every digit", async () => {
    const few = [{ amount: (0.1 + 0.2) as never }];
    const many_ = Array.from({ length: 120 }, () => ({
      amount: (0.1 + 0.2) as never,
    }));

    await database.amounts.insert(few);
    await database.amounts.insert(many_);

    const stored = await database.amounts((row) => ({ amount: row.amount }), {
      distinct: true,
    });

    expect(stored).toEqual([{ amount: "0.30000000000000004" }]);
  });

  test("a Date outside years 1 to 9999 is written the same in both insert forms", async () => {
    const caesar = new Date(Date.UTC(2000, 2, 15, 1, 2, 3));
    caesar.setUTCFullYear(-43);
    const far = new Date(Date.UTC(12000, 0, 1));

    await database.moments.insert([{ at: caesar }, { at: far }]);
    await database.moments.insert(
      Array.from({ length: 120 }, (_, position) => ({
        at: position % 2 ? caesar : far,
      })),
    );

    const stored = await database.moments((row) => ({ at: row.at }), {
      distinct: true,
      orderBy: (row) => row.at.asc,
    });

    expect(stored.map((row) => row.at.getTime())).toEqual([
      caesar.getTime(),
      far.getTime(),
    ]);
  });

  test("$close() ends open streams instead of waiting for their loops", async () => {
    const open = async () => {
      const fresh = await testDatabase({
        url: databaseUrl!,
        schema: model,
        prefix: "symmetria_hunt_stream",
        max: 2,
      });

      await fresh.database.amounts.insert(
        Array.from({ length: 20 }, (_, position) => ({
          amount: String(position),
        })),
      );

      return fresh;
    };
    const rows = (database: typeof isolated.database) =>
      database.amounts((row) => ({ id: row.id })).stream({ size: 3 });

    // A loop that closes the database and stops: the usual way out.
    const first = await open();
    let read = 0;

    for await (const _row of rows(first.database)) {
      read += 1;

      if (read === 4) {
        await first.database.$close();
        break;
      }
    }

    expect(read).toBe(4);
    await first.close();

    // A loop that reads on is told why it cannot.
    const second = await open();
    const reading = (async () => {
      for await (const _row of rows(second.database)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await second.database.$close();
    await expect(reading).rejects.toThrow(
      "symmetria: the database was closed while this stream was open",
    );
    await second.close();
  });

  test("$close() inside its own transaction fails instead of waiting forever", async () => {
    await expect(
      database.$transaction(async () => {
        await isolated.database.$close();
      }),
    ).rejects.toThrow(
      "symmetria: $close() was called inside a $transaction() of the same database; close it after the transaction ends",
    );
    // The database is still open.
    expect(await database.tags((tag) => ({ id: tag.id })).count()).toBe(3);
  });
});

const size = 8;
const unit = (seed: number): number[] => {
  const values = Array.from({ length: size }, (_, position) =>
    Math.sin(seed * (position + 1) * 12.9898),
  );
  const length = Math.hypot(...values);

  return values.map((value) => value / length);
};
const fixed = embedder(size, async (texts) => texts.map(() => unit(1)), {
  name: "fixed",
});
const items = table({
  id: int.auto,
  kind: text,
  body: text,
  position: vector(size),
})
  .indexes((item) => ({
    position: index(operatorClass(item.position, "vector_l2_ops")).using(
      "hnsw",
    ),
  }))
  .search((item) => ({ about: { meaning: fixed(item.body) } }));
const vectors = schema({ items }, { extensions: ["vector"] });
const available = await hasExtension(databaseUrl, "vector");

describe.skipIf(!available)("nearest rows through an HNSW index", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof vectors>>>;
  let database: typeof isolated.database;
  const question = unit(7);
  // One row in fifty is "rare", and never among the nearest of the question.
  const rare = 60;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: vectors,
      prefix: "symmetria_hunt_vector",
      max: 2,
      searchPath: ["public"],
    });
    database = isolated.database;
    await database.items.insert(
      Array.from({ length: 3000 }, (_, position) => {
        const point = unit(position + 100);

        return {
          kind: position % 50 === 0 ? "rare" : "common",
          body: `item ${position}`,
          position: point,
          about: point,
        };
      }),
    );
    await isolated.driver.execute({ sql: "ANALYZE", parameters: [] });
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("a filter and a long LIMIT get every row they ask for", async () => {
    const filtered = await database.items((item) => ({ id: item.id }), {
      where: { kind: "rare" },
      orderBy: (item) => item.position.l2Distance(question).asc,
      limit: 25,
    });

    expect(filtered).toHaveLength(25);

    const long = await database.items((item) => ({ id: item.id }), {
      orderBy: (item) => item.position.l2Distance(question).asc,
      limit: 300,
    });

    expect(long).toHaveLength(300);
  });

  test("a stream reads the rows an await reads", async () => {
    const query = database.items((item) => ({ id: item.id }), {
      where: { kind: "rare" },
      orderBy: (item) => item.position.l2Distance(question).asc,
    });
    const streamed: number[] = [];

    for await (const row of query.stream({ size: 20 })) {
      streamed.push(row.id);
    }

    expect(streamed).toEqual((await query).map((row) => row.id));
    expect(streamed).toHaveLength(rare);
  });

  test("pages by distance cover every row once", async () => {
    const query = database.items((item) => ({ id: item.id }), {
      where: { kind: "rare" },
      orderBy: (item) => [item.position.l2Distance(question).asc, item.id.asc],
    });
    const paged: number[] = [];
    let after: Parameters<typeof query.page>[0]["after"] = null;

    for (;;) {
      const page = await query.page({ size: 7, after });

      paged.push(...page.items.map((row) => row.id));

      if (!page.nextCursor) {
        break;
      }

      after = page.nextCursor;
    }

    expect(paged).toEqual((await query).map((row) => row.id));
  });

  test("a filtered search by meaning finds the rows of the filter", async () => {
    const found = await database.items.search((item) => ({ kind: item.kind }), {
      about: question,
      where: { kind: "rare" },
      limit: 10,
    });

    expect(found).toEqual(Array.from({ length: 10 }, () => ({ kind: "rare" })));

    const scoped = await database
      .$scope({ items: (item) => item.kind.is("rare") })
      .items.search((item) => ({ kind: item.kind }), {
        about: question,
        limit: 10,
      });

    expect(scoped).toHaveLength(10);
    expect(
      await database.items.search((item) => ({ id: item.id }), {
        about: question,
        limit: 80,
      }),
    ).toHaveLength(80);
  });
});
