import { expect, test } from "bun:test";
import {
  databaseError,
  type CompiledQuery,
} from "../../../packages/runtime/src";
import {
  createPostgresDriver,
  type PostgresConnection,
} from "../../../packages/runtime/src/driver/pool";
import { postgresParameters } from "../../../packages/runtime/src/driver/parameters";
import { scopeViolation } from "../../../packages/runtime/src/driver/errors";

const statement = (sql: string): CompiledQuery => ({ sql, parameters: [] });

/** A pool whose connections log statements and record how many overlap. */
const recordingPool = () => {
  const log: string[] = [];
  const connections = { released: 0, discarded: 0 };
  let running = 0;
  let overlap = 0;

  const connection = (): PostgresConnection => ({
    execute: async (query) => {
      running += 1;
      overlap = Math.max(overlap, running);
      log.push(query.sql);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;

      if (query.sql === "FAIL") {
        throw Object.assign(new Error("division by zero"), { code: "22012" });
      }

      // A failed $scope() write check, as Bun.SQL reports it.
      if (query.sql === "OUT OF SCOPE") {
        throw Object.assign(
          new Error(
            'invalid input syntax for type boolean: "SYMMETRIA_OUT_OF_SCOPE:update:team%3Anotes:16384"',
          ),
          { code: "ERR_POSTGRES_SERVER_ERROR", errno: "22P02" },
        );
      }

      return {
        rows: [{ pid: 7, sql: query.sql }],
        affectedRows: 1,
      };
    },
    release: () => {
      connections.released += 1;
    },
    discard: async () => {
      connections.discarded += 1;
    },
  });

  const driver = createPostgresDriver({
    execute: (query) => connection().execute(query),
    connect: async () => connection(),
    cancel: async () => {},
    close: async () => {},
  });

  return { driver, log, connections, overlap: () => overlap };
};

test("a transaction runs concurrent statements one at a time in call order", async () => {
  const { driver, log, overlap } = recordingPool();

  await driver.transaction(async (tx) => {
    await Promise.all(
      ["a", "b", "c", "d"].map((sql) => tx.execute(statement(sql))),
    );
  });

  expect(overlap()).toBe(1);
  expect(log).toEqual(["BEGIN", "a", "b", "c", "d", "COMMIT"]);
});

test("concurrent savepoints and parent statements queue behind each other", async () => {
  const { driver, log, overlap } = recordingPool();

  await driver.transaction(async (tx) => {
    await Promise.all([
      tx.transaction(async (nested) => {
        await nested.execute(statement("first 1"));
        await nested.execute(statement("first 2"));
      }),
      tx.transaction(async (nested) => {
        await nested.execute(statement("second"));
      }),
      tx.execute(statement("parent")),
    ]);
  });

  expect(overlap()).toBe(1);
  expect(log).toEqual([
    "BEGIN",
    "SAVEPOINT symmetria_savepoint_1",
    "first 1",
    "first 2",
    "RELEASE SAVEPOINT symmetria_savepoint_1",
    "SAVEPOINT symmetria_savepoint_2",
    "second",
    "RELEASE SAVEPOINT symmetria_savepoint_2",
    "parent",
    "COMMIT",
  ]);
});

test("using the parent context inside a nested callback fails instead of waiting for itself", async () => {
  const { driver, log } = recordingPool();

  await driver.transaction(async (tx) => {
    await expect(
      tx.transaction(async () => {
        await tx.execute(statement("parent inside"));
      }),
    ).rejects.toThrow(/await the nested transaction/);
    await expect(
      tx.transaction(async (nested) => {
        await nested.transaction(async () => {
          await tx.transaction(async () => {});
        });
      }),
    ).rejects.toThrow(/await the nested transaction/);
    await tx.execute(statement("after"));
  });

  expect(log).not.toContain("parent inside");
  expect(log.slice(-2)).toEqual(["after", "COMMIT"]);
});

test("operations still pending when the callback returns reject, because the transaction rolls back", async () => {
  const { driver, log } = recordingPool();
  let running: Promise<unknown> | undefined;
  let queued: Promise<unknown> | undefined;

  await expect(
    driver.transaction(async (tx) => {
      await tx.execute(statement("awaited"));
      running = tx.execute(statement("running"));
      queued = tx.execute(statement("queued"));
    }),
  ).rejects.toThrow(/await all transaction operations/);

  for (const operation of [running, queued]) {
    await expect(operation).rejects.toThrow(
      "symmetria: the transaction ended before this operation was awaited; it was rolled back",
    );
  }

  // The queued statement never starts.
  expect(log).toEqual(["BEGIN", "awaited", "running", "ROLLBACK"]);
});

test("a failed statement fails the statements queued behind it without running them", async () => {
  const { driver, log } = recordingPool();
  const failures: unknown[] = [];

  await expect(
    driver.transaction(async (tx) => {
      failures.push(
        ...(await Promise.allSettled([
          tx.execute(statement("FAIL")),
          tx.execute(statement("next")),
        ])),
      );
    }),
  ).rejects.toThrow("division by zero");

  expect(failures).toMatchObject([
    { status: "rejected", reason: { code: "22012" } },
    { status: "rejected", reason: { code: "22012" } },
  ]);
  expect(log).toEqual(["BEGIN", "FAIL", "ROLLBACK"]);
});

test("a failed scope check fails the transaction and the statements behind it as SYMMETRIA_OUT_OF_SCOPE", async () => {
  const { driver, log } = recordingPool();
  const failures: PromiseSettledResult<unknown>[] = [];
  const violation = {
    code: "SYMMETRIA_OUT_OF_SCOPE",
    table: "team:notes",
    message:
      'symmetria: update on "team:notes" would write a row outside the database scope',
  };

  await expect(
    driver.transaction(async (tx) => {
      failures.push(
        ...(await Promise.allSettled([
          tx.execute(statement("OUT OF SCOPE")),
          tx.execute(statement("next")),
        ])),
      );
    }),
  ).rejects.toMatchObject(violation);

  expect(failures.map((failure) => failure.status)).toEqual([
    "rejected",
    "rejected",
  ]);

  for (const failure of failures) {
    const { reason } = failure as PromiseRejectedResult;
    expect(reason).toMatchObject(violation);
    // The driver error stays available as the cause.
    expect((reason as Error).cause).toMatchObject({ errno: "22P02" });
  }

  expect(log).toEqual(["BEGIN", "OUT OF SCOPE", "ROLLBACK"]);
  // A server with translated messages quotes the text differently.
  expect(
    scopeViolation(
      Object.assign(
        new Error(
          "ungültige Eingabesyntax für Typ boolean: »SYMMETRIA_OUT_OF_SCOPE:conflict:posts:16384«",
        ),
        { code: "22P02" },
      ),
    ),
  ).toMatchObject({
    code: "SYMMETRIA_OUT_OF_SCOPE",
    table: "posts",
    message:
      'symmetria: upsert on "posts" conflicted with a row outside the database scope',
  });
  // Other errors pass through unchanged.
  const other = Object.assign(new Error("invalid input syntax"), {
    code: "22P02",
  });
  expect(scopeViolation(other)).toBe(other);
});

test("a stream cursor still open when the callback returns is unfinished work", async () => {
  const { driver, log } = recordingPool();
  const declare = statement(
    'DECLARE "__symmetria_stream_1" NO SCROLL CURSOR FOR SELECT 1',
  );

  await expect(
    driver.transaction(async (tx) => {
      await tx.execute(declare);
    }),
  ).rejects.toThrow(/finish or break out of every stream\(\)/);
  expect(log.at(-1)).toBe("ROLLBACK");

  await driver.transaction(async (tx) => {
    await tx.execute(declare);
    await tx.execute(statement('CLOSE "__symmetria_stream_1"'));
  });
  expect(log.at(-1)).toBe("COMMIT");
});

test("sessions queue their statements and close the connection afterwards", async () => {
  const { driver, log, connections, overlap } = recordingPool();

  await driver.session(async (session) => {
    await Promise.all([
      session.execute(statement("one")),
      session.transaction(async (tx) => {
        await tx.execute(statement("inside"));
        expect(() => session.execute(statement("session inside"))).toThrow(
          /await the session transaction/,
        );
      }),
      session.execute(statement("two")),
    ]);
  });

  expect(overlap()).toBe(1);
  expect(log).toEqual([
    "SELECT pg_backend_pid() AS pid",
    "one",
    "BEGIN",
    "inside",
    "COMMIT",
    "two",
  ]);
  expect(connections).toEqual({ released: 0, discarded: 1 });

  await expect(
    driver.session(async () => {
      throw new Error("failed session");
    }),
  ).rejects.toThrow("failed session");
  expect(connections).toEqual({ released: 0, discarded: 2 });
});

test("node-postgres parameters keep -0 and send Dates as UTC text", () => {
  const instant = new Date("1920-06-01T12:00:00.000Z");
  const parameters = [-0, 0, [-0, 1.5], instant, "text"];

  expect(postgresParameters(parameters, true)).toEqual([
    "-0",
    0,
    '{"-0","1.5"}',
    "1920-06-01T12:00:00.000Z",
    "text",
  ]);
  // Bun.SQL binds numbers and Dates exactly; only arrays become literals.
  expect(postgresParameters(parameters)).toEqual([
    -0,
    0,
    '{"-0","1.5"}',
    instant,
    "text",
  ]);
  expect(postgresParameters([1, "a"], true)).toEqual([1, "a"]);
  expect(() => postgresParameters([new Date("never")], true)).toThrow(
    /valid Dates/,
  );
});

test("databaseError() describes lost and refused connections on both drivers", () => {
  const lost = [
    new Error("Connection terminated unexpectedly"),
    Object.assign(new Error("Connection closed"), {
      code: "ERR_POSTGRES_CONNECTION_CLOSED",
    }),
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  ];

  for (const error of lost) {
    expect(databaseError(error)).toEqual({
      kind: "connection",
      sqlState: "08006",
      message: error.message,
    });
  }

  for (const error of [
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
    }),
    Object.assign(new Error("Failed to connect"), {
      code: "ERR_POSTGRES_CONNECTION_REFUSED",
    }),
  ]) {
    expect(databaseError(error)).toMatchObject({
      kind: "connection",
      sqlState: "08001",
    });
  }

  // The server ends the session: pg reports `code`, Bun `errno`.
  expect(
    databaseError(
      Object.assign(
        new Error("terminating connection due to administrator command"),
        { code: "57P01" },
      ),
    ),
  ).toMatchObject({ kind: "connection", sqlState: "57P01" });
  expect(
    databaseError({ code: "ERR_POSTGRES_SERVER_ERROR", errno: "08P01" }),
  ).toMatchObject({ kind: "connection" });
  // A cancelled statement leaves the connection usable.
  expect(databaseError({ code: "57014" })).toMatchObject({ kind: "other" });
  expect(databaseError(new Error("symmetria: invalid"))).toBeUndefined();
});
