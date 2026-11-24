import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import type {
  Driver,
  TransactionDriver,
} from "../../../packages/runtime/src/entries/driver";
import {
  createPostgresDriver,
  type PostgresConnection,
} from "../../../packages/runtime/src/driver/pool";

/** A driver whose transactions hand out a recording executor; FETCH answers come from `batches`. */
const streamingDriver = (batches: Record<string, unknown>[][]) => {
  const statements: CompiledQuery[] = [];
  const events: string[] = [];
  let fetches = 0;
  const connection: TransactionDriver = {
    execute: async (query) => {
      statements.push(query);

      if (query.sql.startsWith("FETCH")) {
        return batches[fetches++] ?? [];
      }

      if (query.sql.startsWith("FETCH-FAIL")) {
        throw new Error("boom");
      }

      return [];
    },
    transaction: async (callback) => callback(connection),
  };
  const driver: Driver = {
    execute: async (query) => {
      statements.push(query);

      return [];
    },
    close: async () => {},
    transaction: async (callback) => {
      events.push("begin");

      try {
        const result = await callback(connection);
        events.push("commit");

        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };

  return { driver, statements, events };
};

test("stream() declares a cursor, fetches in batches and closes it inside one transaction", async () => {
  const { driver, statements, events } = streamingDriver([
    [
      { id: 1, name: "Ada", views: "10" },
      { id: 2, name: "Linus", views: "20" },
    ],
    [{ id: 3, name: "Grace", views: "30" }],
  ]);
  const database = schema(
    { users: { id: int, name: text, views: bigint } },
    { driver },
  );
  const rows: unknown[] = [];

  for await (const row of database
    .users((user) => ({ id: user.id, name: user.name, views: user.views }))
    .stream({ size: 2 })) {
    rows.push(row);
  }

  expect(rows).toEqual([
    { id: 1, name: "Ada", views: 10n },
    { id: 2, name: "Linus", views: 20n },
    { id: 3, name: "Grace", views: 30n },
  ]);
  expect(statements.map((statement) => statement.sql.split(" ")[0])).toEqual([
    "SET",
    "DECLARE",
    "FETCH",
    "FETCH",
    "CLOSE",
  ]);
  // Planned to be read to the end, like the plain query.
  expect(statements[0]!.sql).toBe("SET LOCAL cursor_tuple_fraction = 1");
  expect(statements[1]!.sql).toMatch(
    /^DECLARE "__symmetria_stream_\d+" NO SCROLL CURSOR FOR SELECT "users"\."id" AS "id"/,
  );
  expect(statements[2]!.sql).toMatch(
    /^FETCH FORWARD 2 FROM "__symmetria_stream_\d+"$/,
  );
  expect(events).toEqual(["begin", "commit"]);
});

test("breaking out of a stream closes the cursor and ends the transaction", async () => {
  const { driver, statements, events } = streamingDriver([
    [{ id: 1, name: "Ada", views: "1" }],
    [{ id: 2, name: "Linus", views: "2" }],
  ]);
  const database = schema(
    { users: { id: int, name: text, views: bigint } },
    { driver },
  );

  for await (const row of database
    .users((user) => ({ id: user.id }))
    .stream({ size: 1 })) {
    expect(row.id).toBe(1);
    break;
  }

  expect(statements.map((statement) => statement.sql.split(" ")[0])).toEqual([
    "SET",
    "DECLARE",
    "FETCH",
    "CLOSE",
  ]);
  expect(events).toEqual(["begin", "commit"]);
});

test("a failing fetch rejects the iteration and rolls the transaction back", async () => {
  const { driver, events } = streamingDriver([]);
  const failing: Driver = {
    ...driver,
    transaction: async (callback) => {
      events.push("begin");

      try {
        return await callback({
          execute: async (query) => {
            if (query.sql.startsWith("FETCH")) {
              throw new Error("boom");
            }

            return [];
          },
          transaction: async () => {
            throw new Error("unused");
          },
        });
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };
  const database = schema({ users: { id: int } }, { driver: failing });

  await expect(async () => {
    for await (const _row of database
      .users((user) => ({ id: user.id }))
      .stream()) {
      // unreachable
    }
  }).toThrow("boom");
  expect(events).toEqual(["begin", "rollback"]);
});

test("stream() validates its size and needs a transactional driver", () => {
  const database = schema({ users: { id: int } }, { executor: async () => [] });

  expect(() => database.users((user) => ({ id: user.id })).stream()).toThrow(
    /requires a driver with transaction support/,
  );
  expect(() =>
    database.users((user) => ({ id: user.id })).stream({ size: 0 }),
  ).toThrow(/positive integer/);
});

for (const phase of ["close", "commit"] as const) {
  for (const early of [false, true]) {
    test(`stream() propagates ${phase} failure on ${early ? "early exit" : "completion"}`, async () => {
      const failure = new Error(`${phase} failed`);
      const events: string[] = [];
      const connection: TransactionDriver = {
        execute: async ({ sql }) => {
          if (sql.startsWith("CLOSE") && phase === "close") {
            throw failure;
          }

          return sql.startsWith("FETCH") ? [{ id: 1 }] : [];
        },
        transaction: async (callback) => callback(connection),
      };
      const driver: Driver = {
        execute: connection.execute,
        close: async () => {},
        transaction: async (callback) => {
          try {
            const result = await callback(connection);
            events.push("commit");

            if (phase === "commit") {
              throw failure;
            }

            return result;
          } catch (error) {
            events.push("rollback");
            throw error;
          }
        },
      };
      const db = schema({ users: { id: int } }, { driver });
      const consume = async () => {
        for await (const _row of db.users(({ id }) => ({ id })).stream()) {
          if (early) {
            break;
          }
        }
      };

      await expect(consume()).rejects.toBe(failure);
      expect(events.at(-1)).toBe("rollback");
    });
  }
}

test("stream() preserves a fetch failure when rollback also fails", async () => {
  const failure = new Error("fetch failed");
  const connection: TransactionDriver = {
    execute: async ({ sql }) => {
      if (sql.startsWith("FETCH")) {
        throw failure;
      }

      return [];
    },
    transaction: async (callback) => callback(connection),
  };
  const driver: Driver = {
    execute: connection.execute,
    close: async () => {},
    transaction: async (callback) => {
      try {
        return await callback(connection);
      } catch {
        throw new Error("rollback failed");
      }
    },
  };
  const db = schema({ users: { id: int } }, { driver });

  await expect(async () => {
    for await (const _row of db.users(({ id }) => ({ id })).stream()) {
      // The FETCH never returns a row.
    }
  }).toThrow(failure);
});

test("stream() propagates connection acquisition failure", async () => {
  const failure = new Error("pool unavailable");
  const db = schema(
    { users: { id: int } },
    {
      driver: {
        execute: async () => [],
        close: async () => {},
        transaction: async () => {
          throw failure;
        },
      },
    },
  );

  await expect(async () => {
    for await (const _row of db.users(({ id }) => ({ id })).stream()) {
      // No connection was acquired.
    }
  }).toThrow(failure);
});

/** A pool of `max` connections whose FETCH answers come from `batches`; every statement is logged. */
const pooledStreams = (max: number, batches: Record<string, unknown>[][]) => {
  const log: string[] = [];
  let fetches = 0;
  const connection = (): PostgresConnection => ({
    execute: async (query) => {
      log.push(query.sql);

      return {
        rows: query.sql.startsWith("FETCH") ? (batches[fetches++] ?? []) : [],
        affectedRows: 0,
      };
    },
    release: () => {},
    discard: async () => {},
  });
  const driver = createPostgresDriver({
    execute: (query) => connection().execute(query),
    connect: async () => connection(),
    cancel: async () => {},
    close: async () => {},
    max,
  });

  return { driver, log };
};

test("a query inside a stream loop that holds the only connection is refused at once", async () => {
  const { driver } = pooledStreams(1, [[{ id: 1 }]]);
  const database = schema({ items: { id: int } }, { driver });
  const query = { sql: "SELECT 1", parameters: [] };

  for await (const item of database
    .items((items) => ({ id: items.id }))
    .stream({ size: 1 })) {
    expect(item).toEqual({ id: 1 });
    // It would wait for the connection the loop itself holds.
    await expect(driver.execute(query)).rejects.toThrow(
      "symmetria: this query asks the pool for a connection from inside a stream() loop that holds the only one, and would wait forever; run it after the loop or raise max",
    );
  }

  expect(await driver.execute(query)).toEqual({ rows: [], affectedRows: 0 });
});

test("an iterator dropped halfway gives its connection back once it is collected", async () => {
  const { driver, log } = pooledStreams(1, [[{ id: 1 }], [{ id: 2 }]]);
  const database = schema({ items: { id: int } }, { driver });
  const readOne = async () => {
    const iterator = database
      .items((items) => ({ id: items.id }))
      .stream({ size: 1 })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ id: 1 });
  };

  await readOne();

  for (
    let attempt = 0;
    attempt < 40 && !log.includes("ROLLBACK");
    attempt += 1
  ) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // Its cursor was still open, so the transaction rolls back.
  expect(log.at(-1)).toBe("ROLLBACK");
});

test("a row that fails to decode inside $transaction closes its cursor, so the transaction can go on", async () => {
  const { driver, log } = pooledStreams(2, [[{ views: "not a number" }]]);
  const database = schema({ posts: { id: int, views: bigint } }, { driver });

  expect(
    await database.$transaction(async (tx) => {
      await expect(
        (async () => {
          for await (const _ of tx
            .posts((posts) => ({ views: posts.views }))
            .stream({ size: 1 })) {
            // never reached
          }
        })(),
      ).rejects.toThrow();

      return "committed";
    }),
  ).toBe("committed");
  expect(log.some((sql) => sql.startsWith("CLOSE"))).toBe(true);
  expect(log.at(-1)).toBe("COMMIT");
});

/**
 * A pool that opens at most `max` connections, so a request waits for a free
 * one; each cursor reads `rows` rows `{ id }`, each FETCH taking `fetchMs`.
 * Every statement is logged.
 */
const limitedPool = (max: number, rows: number, fetchMs = 0) => {
  const log: string[] = [];
  const waiting: (() => void)[] = [];
  let free = max;
  const acquire = async () => {
    if (free > 0) {
      free -= 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };
  const giveBack = () => {
    const next = waiting.shift();

    if (next) {
      next();
    } else {
      free += 1;
    }
  };
  const connect = async (): Promise<PostgresConnection> => {
    await acquire();
    let released = false;
    let fetched = 0;
    const release = () => {
      if (!released) {
        released = true;
        giveBack();
      }
    };

    return {
      execute: async (query) => {
        log.push(query.sql);
        const fetch = /^FETCH FORWARD (\d+)/.exec(query.sql);

        if (!fetch) {
          return { rows: [], affectedRows: 0 };
        }

        if (fetchMs) {
          await new Promise((resolve) => setTimeout(resolve, fetchMs));
        }

        const batch = Array.from(
          { length: Math.max(0, Math.min(Number(fetch[1]), rows - fetched)) },
          (_, index) => ({ id: fetched + index + 1 }),
        );
        fetched += batch.length;

        return { rows: batch, affectedRows: 0 };
      },
      release,
      discard: async () => release(),
    };
  };
  const driver = createPostgresDriver({
    execute: async (query) => {
      const connection = await connect();

      try {
        return await connection.execute(query);
      } finally {
        connection.release();
      }
    },
    connect,
    cancel: async () => {},
    close: async () => {},
    max,
  });

  return { driver, log };
};

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const plain = { sql: "SELECT 1", parameters: [] };

test("a stream loop in an async helper counts its connection as held by its body, not by the helper's caller", async () => {
  const { driver } = limitedPool(1, 4);
  const database = schema({ items: { id: int } }, { driver });
  const read: number[] = [];
  const exportAll = async () => {
    for await (const item of database
      .items((items) => ({ id: items.id }))
      .stream({ size: 2 })) {
      read.push(item.id);

      // The body would wait for the connection its own loop holds.
      if (item.id === 1) {
        await expect(driver.execute(plain)).rejects.toThrow(
          "from inside a stream() loop that holds the only one",
        );
      }

      await sleep(2);
    }
  };
  const job = exportAll();

  // The caller is in no loop: its query waits its turn.
  expect(await driver.execute(plain)).toEqual({ rows: [], affectedRows: 0 });
  expect(read).toEqual([1, 2, 3, 4]);
  await job;
});

test("an iterator dropped halfway gives its connection back once a query has waited idleTimeoutMs for it", async () => {
  const { driver, log } = limitedPool(1, 4);
  const database = schema({ items: { id: int } }, { driver });
  // Read in a helper, as code that drops an iterator does.
  const readOne = async () => {
    const iterator = database
      .items((items) => ({ id: items.id }))
      .stream({ size: 2, idleTimeoutMs: 40 })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ id: 1 });

    return iterator;
  };
  const iterator = await readOne();
  const started = performance.now();

  expect(await driver.execute(plain)).toEqual({ rows: [], affectedRows: 0 });
  expect(performance.now() - started).toBeGreaterThanOrEqual(35);
  // The stream's transaction ended before the query ran.
  expect(log.slice(-3).map((sql) => sql.split(" ")[0])).toEqual([
    "CLOSE",
    "COMMIT",
    "SELECT",
  ]);
  await expect(iterator.next()).rejects.toThrow(
    "symmetria: this stream was ended because its reader asked for no row for 40 ms while other queries waited for a connection",
  );
});

test("a stream whose reader pauses keeps its connection while no query waits", async () => {
  const { driver, log } = limitedPool(2, 3);
  const database = schema({ items: { id: int } }, { driver });
  const read: number[] = [];

  for await (const item of database
    .items((items) => ({ id: items.id }))
    .stream({ size: 1, idleTimeoutMs: 10 })) {
    read.push(item.id);
    await sleep(60);
  }

  expect(read).toEqual([1, 2, 3]);
  expect(log.at(-1)).toBe("COMMIT");
});

test("stream() validates idleTimeoutMs", () => {
  const { driver } = limitedPool(1, 0);
  const database = schema({ items: { id: int } }, { driver });
  const items = database.items((items) => ({ id: items.id }));

  for (const idleTimeoutMs of [0, -1, Number.NaN, "5" as never]) {
    expect(() => items.stream({ idleTimeoutMs })).toThrow(
      "symmetria: stream idleTimeoutMs must be a positive number of milliseconds",
    );
  }

  expect(() =>
    items.stream({ idleTimeoutMs: Number.POSITIVE_INFINITY }),
  ).not.toThrow();
});

test("driver.close() ends a stream paused between rows instead of waiting for its loop", async () => {
  const { driver, log } = limitedPool(1, 4);
  const database = schema({ items: { id: int } }, { driver });
  const gate = Promise.withResolvers<void>();
  const read: number[] = [];
  const loop = (async () => {
    for await (const item of database
      .items((items) => ({ id: items.id }))
      .stream({ size: 1 })) {
      read.push(item.id);
      await gate.promise;
    }
  })();

  while (!read.length) {
    await sleep(1);
  }

  expect(
    await Promise.race([
      driver.close().then(() => "closed"),
      sleep(1000).then(() => "waiting"),
    ]),
  ).toBe("closed");
  expect(log.slice(-2).map((sql) => sql.split(" ")[0])).toEqual([
    "CLOSE",
    "COMMIT",
  ]);
  gate.resolve();
  await expect(loop).rejects.toThrow(
    "symmetria: the database was closed while this stream was open",
  );
  expect(read).toEqual([1]);
});

test("$close() refuses work started after the call, a stream too", async () => {
  const { driver } = limitedPool(2, 4);
  const database = schema({ items: { id: int } }, { driver });
  const closing = database.$close();

  await expect(database.items.count()).rejects.toThrow(
    "symmetria: driver is closed",
  );
  await expect(
    (async () => {
      for await (const _ of database
        .items((items) => ({ id: items.id }))
        .stream()) {
        // never reached
      }
    })(),
  ).rejects.toThrow("symmetria: driver is closed");
  await closing;
});

test("a caller's query waits for a helper's stream whose fetches take longer than a second", async () => {
  const { driver } = limitedPool(1, 2, 1200);
  const database = schema({ items: { id: int } }, { driver });
  const exportAll = async () => {
    let read = 0;

    for await (const _ of database
      .items((items) => ({ id: items.id }))
      .stream({ size: 2 })) {
      read += 1;
    }

    return read;
  };
  const job = exportAll();

  // The stream holds the connection; the loop's body is instant, and each of
  // its two fetches takes 1.2 s.
  await sleep(50);
  const started = performance.now();

  expect(await driver.execute(plain)).toEqual({ rows: [], affectedRows: 0 });
  expect(performance.now() - started).toBeGreaterThanOrEqual(2200);
  expect(await job).toBe(2);
});

test("a query of code that reads a stream elsewhere than in its own loop is refused once the stream has not been read for a second", async () => {
  const { driver } = limitedPool(1, 4);
  const database = schema({ items: { id: int } }, { driver });
  const query = () => database.items((items) => ({ id: items.id }));
  const refusal =
    "symmetria: this query asks the pool for a connection from inside a stream() loop that holds the only one, and would wait forever";

  // Read through ReadableStream.from(): the rows are read inside it.
  const from = (
    ReadableStream as unknown as {
      from: <Row>(rows: AsyncIterable<Row>) => ReadableStream<Row>;
    }
  ).from;
  const reader = from(query().stream({ size: 2 })).getReader();
  expect((await reader.read()).value).toEqual({ id: 1 });
  let started = performance.now();
  await expect(driver.execute(plain)).rejects.toThrow(refusal);
  expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  await reader.cancel();

  // By hand, with the row read after the query.
  const iterator = query()
    .stream({ size: 2 })
    [Symbol.asyncIterator]() as AsyncGenerator<{ id: number }>;
  const first = await iterator.next();
  started = performance.now();
  await expect(driver.execute(plain)).rejects.toThrow(refusal);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(first.value).toEqual({ id: 1 });
  await iterator.return(undefined);

  // Nothing holds the connection any more.
  expect(await driver.execute(plain)).toEqual({ rows: [], affectedRows: 0 });
});

test("a stream's iterator is an async generator: await using closes it", async () => {
  const { driver, log } = limitedPool(1, 4);
  const database = schema({ items: { id: int } }, { driver });
  const query = database.items((items) => ({ id: items.id }));
  // Typed as an AsyncIterable; the iterator is an async generator.
  const iterator = query.stream()[Symbol.asyncIterator]() as AsyncGenerator<{
    id: number;
  }>;

  expect(Object.prototype.toString.call(iterator)).toBe(
    "[object AsyncGenerator]",
  );
  expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
  await iterator.return(undefined);

  {
    await using rows = query
      .stream({ size: 1 })
      [Symbol.asyncIterator]() as AsyncGenerator<{ id: number }>;
    expect((await rows.next()).value).toEqual({ id: 1 });
  }

  expect(log.slice(-2).map((sql) => sql.split(" ")[0])).toEqual([
    "CLOSE",
    "COMMIT",
  ]);
});
