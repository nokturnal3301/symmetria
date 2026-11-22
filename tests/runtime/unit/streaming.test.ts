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
