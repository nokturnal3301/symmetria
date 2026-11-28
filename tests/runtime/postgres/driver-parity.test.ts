import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  int,
  smallint,
  real,
  doublePrecision,
  date,
  text,
  timestamp,
  timestamptz,
  prepare,
  bigint,
  bytea,
  createDatabase,
  sql,
  QueryError,
} from "../../../packages/runtime/src";
import { bun, transactionPooling } from "../../support/postgres";
import { postgres as pg } from "../../../packages/runtime/src/entries/pg";
import { testDatabase } from "../../../packages/kit/src/testing";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;

const model = schema({
  samples: {
    id: int,
    count: int.nullable,
    small: smallint.nullable,
    single: real.nullable,
    double: doublePrecision.nullable,
    day: date.nullable,
    local: timestamp.nullable,
    zoned: timestamptz.nullable,
    numbers: int.array.nullable,
    singles: real.array.nullable,
    title: text.nullable,
  },
});

type Fixture = Awaited<ReturnType<typeof testDatabase<typeof model>>>;

/** Rows of a raw statement, as PostgreSQL's text output when the SQL casts to text. */
const select = async (
  { driver }: Fixture,
  sql: string,
  parameters: unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const result = await driver.execute({ sql, parameters });

  return Array.isArray(result) ? result : result.rows;
};

describe.skipIf(!url)(
  "values read and written alike by Bun.SQL and node-postgres",
  () => {
    const fixtures: [string, Fixture][] = [];

    beforeAll(async () => {
      for (const [name, driver] of [
        ["Bun.SQL", bun],
        ["node-postgres", pg],
      ] as const) {
        fixtures.push([
          name,
          await testDatabase({
            url: url!,
            schema: model,
            driver,
            max: 2,
            prefix: "symmetria_parity",
          }),
        ]);
      }
    });

    afterAll(async () => {
      await Promise.all(fixtures.map(([, fixture]) => fixture.close()));
    });

    /** Runs the scenario on both drivers and returns each result by driver name. */
    const both = async <Result>(
      scenario: (fixture: Fixture) => Promise<Result>,
    ): Promise<Record<string, Result>> => {
      const results: Record<string, Result> = {};

      for (const [name, fixture] of fixtures) {
        await fixture.driver.execute({
          sql: "TRUNCATE samples",
          parameters: [],
        });
        results[name] = await scenario(fixture);
      }

      return results;
    };

    test("integer[] and real[] read back from parameterized queries and RETURNING", async () => {
      const results = await both(async ({ database }) => ({
        returned: await database.samples
          .insert({ id: 1, numbers: [1, -2], singles: [0.1, 0.5] })
          .returning((sample) => ({
            numbers: sample.numbers,
            singles: sample.singles,
          })),
        filtered: await database.samples(
          (sample) => ({ numbers: sample.numbers, singles: sample.singles }),
          { where: (sample) => sample.id.atLeast(1) },
        ),
      }));

      for (const result of Object.values(results)) {
        expect(result).toEqual({
          returned: { numbers: [1, -2], singles: [0.1, 0.5] },
          filtered: [{ numbers: [1, -2], singles: [0.1, 0.5] }],
        });
      }
    });

    test("real reads as PostgreSQL prints it and both float types keep -0", async () => {
      const results = await both(async (fixture) => {
        const { database } = fixture;
        const returned = await database.samples
          .insert({ id: 1, single: 0.1, double: -0, singles: [-0, 1.1] })
          .returning((sample) => ({
            single: sample.single,
            double: sample.double,
            singles: sample.singles,
          }));
        const filtered = await database.samples(
          (sample) => ({ single: sample.single, double: sample.double }),
          { where: (sample) => sample.single.is(0.1) },
        );
        const stored = await select(
          fixture,
          "SELECT single::text AS single, double::text AS double, singles::text AS singles FROM samples",
        );

        return { returned, filtered, stored };
      });

      for (const { returned, filtered, stored } of Object.values(results)) {
        expect(returned).toEqual({
          single: 0.1,
          double: -0,
          singles: [-0, 1.1],
        });
        expect(Object.is(returned.double, -0)).toBe(true);
        expect(Object.is(returned.singles![0], -0)).toBe(true);
        expect(filtered).toEqual([{ single: 0.1, double: -0 }]);
        expect(stored).toEqual([
          { single: "0.1", double: "-0", singles: "{-0,1.1}" },
        ]);
      }
    });

    test("searchRank() reads the real value PostgreSQL prints on both drivers", async () => {
      const results = await both(async (fixture) => {
        const { database } = fixture;
        await database.samples.insert([
          { id: 1, title: "bun and postgres" },
          { id: 2, title: "postgres sql bun bun sql" },
        ]);
        const query = database.samples(
          (sample) => ({
            id: sample.id,
            rank: sample.title.searchRank("bun sql"),
          }),
          { orderBy: (sample) => sample.id.ascending },
        );
        const compiled = query.toSQL();
        const printed = await select(
          fixture,
          `SELECT "rank"::text AS "rank" FROM (${compiled.sql}) AS ranked ORDER BY "id"`,
          compiled.parameters,
        );

        return {
          ranks: (await query).map(({ rank }) => rank),
          printed: printed.map(({ rank }) => Number(rank)),
        };
      });

      for (const { ranks, printed } of Object.values(results)) {
        expect(ranks).toEqual(printed);
      }

      expect(results["Bun.SQL"]).toEqual(results["node-postgres"]!);
    });

    test("dates read in PostgreSQL's form, with and without parameters", async () => {
      const days = ["0999-05-05", "0044-03-15 BC", "infinity", "-infinity"];
      const results = await both(async ({ database }) => {
        await database.samples.insert(days.map((day, id) => ({ id, day })));
        const lookup = prepare({ from: int }, (parameters) =>
          database.samples((sample) => ({ day: sample.day }), {
            where: (sample) => sample.id.atLeast(parameters.from),
            orderBy: (sample) => sample.id.ascending,
          }),
        );

        return {
          plain: await database.samples((sample) => ({ day: sample.day }), {
            orderBy: (sample) => sample.id.ascending,
          }),
          parameterized: await lookup({ from: 0 }),
        };
      });

      for (const result of Object.values(results)) {
        expect(result.plain.map(({ day }) => day)).toEqual(days);
        expect(result.parameterized.map(({ day }) => day)).toEqual(days);
      }
    });

    test("BC and distant timestamps read back as the same Dates", async () => {
      const caesar = new Date("-000043-03-15T12:00:00.000Z");
      const future = new Date("+010000-01-01T00:00:00.000Z");
      const results = await both(async (fixture) => {
        const { database, driver } = fixture;
        await database.samples.insert([
          { id: 1, local: caesar, zoned: caesar },
          { id: 2, local: future, zoned: future },
        ]);
        const rows = await database.samples(
          (sample) => ({ local: sample.local, zoned: sample.zoned }),
          { orderBy: (sample) => sample.id.ascending },
        );
        const nested = await database.samples((sample) => ({
          payload: { local: sample.local, zoned: sample.zoned },
        }));
        const stored = await select(
          fixture,
          "SELECT local::text AS local FROM samples ORDER BY id",
        );
        await driver.execute({
          sql: "UPDATE samples SET local = 'infinity' WHERE id = 2",
          parameters: [],
        });
        const infinite = await database
          .samples((sample) => ({ local: sample.local }))
          .then(
            () => "read",
            (error: Error) => error.message,
          );

        return { rows, nested, stored, infinite };
      });

      for (const result of Object.values(results)) {
        expect(result.rows).toEqual([
          { local: caesar, zoned: caesar },
          { local: future, zoned: future },
        ]);
        expect(
          result.nested.sort(
            (left, right) =>
              left.payload.local!.getTime() - right.payload.local!.getTime(),
          ),
        ).toEqual(result.rows.map((payload) => ({ payload })));
        expect(result.stored).toEqual([
          { local: "0044-03-15 12:00:00 BC" },
          { local: "10000-01-01 00:00:00" },
        ]);
        expect(result.infinite).toMatch(/cannot represent timestamp value/);
      }
    });

    test("historic timestamptz instants survive a process time zone with second offsets", async () => {
      const instants = [
        // Kyiv's local mean time was UTC+2:02:04 until 1924, Monrovia's UTC-0:44:30 until 1972.
        "1920-06-01T12:00:00.000Z",
        "1971-06-01T12:00:00.000Z",
        "2026-06-01T12:00:00.000Z",
      ];
      const original = process.env.TZ;

      try {
        for (const zone of ["Europe/Kyiv", "Africa/Monrovia"]) {
          process.env.TZ = zone;
          const results = await both(async (fixture) => {
            const { database } = fixture;
            await database.samples.insert(
              instants.map((instant, id) => ({ id, zoned: new Date(instant) })),
            );
            const stored = await select(
              fixture,
              `SELECT to_char(zoned AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS zoned FROM samples ORDER BY id`,
            );
            const found = await Promise.all(
              instants.map((instant) =>
                database
                  .samples((sample) => ({ id: sample.id }), {
                    where: (sample) => sample.zoned.is(new Date(instant)),
                  })
                  .count(),
              ),
            );

            return { stored: stored.map((row) => row.zoned), found };
          });

          for (const result of Object.values(results)) {
            expect(result).toEqual({ stored: instants, found: [1, 1, 1] });
          }
        }
      } finally {
        if (original === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = original;
        }
      }
    });

    test("integer columns reject fractional and out-of-range numbers before either driver sends them", async () => {
      const results = await both(async ({ database }) => {
        // The queries build; running them rejects before anything is sent.
        const failure = (query: PromiseLike<unknown>) =>
          Promise.resolve(query).then(
            () => "accepted",
            (error: Error) => error.message,
          );

        await database.samples.insert({ id: 1, count: 7, small: 3 });

        return [
          await failure(
            database.samples((sample) => ({ id: sample.id }), {
              where: (sample) => sample.count.above(6.5),
            }),
          ),
          await failure(
            database.samples((sample) => ({ id: sample.id }), {
              where: (sample) => sample.count.is(2 ** 31),
            }),
          ),
          await failure(database.samples.insert({ id: 2, small: 70000 })),
          await database.samples((sample) => ({ id: sample.id }), {
            where: (sample) => sample.count.above(6),
          }),
        ];
      });

      expect(results["Bun.SQL"]).toEqual(results["node-postgres"]!);
      expect(results["Bun.SQL"]).toEqual([
        "symmetria: integer values are integers from -2147483648 to 2147483647, received 6.5",
        "symmetria: integer values are integers from -2147483648 to 2147483647, received 2147483648",
        "symmetria: smallint values are integers from -32768 to 32767, received 70000",
        [{ id: 1 }],
      ]);
    });

    test("NULL array elements written outside Symmetria and invalid Dates fail loudly", async () => {
      const results = await both(async ({ database, driver }) => {
        await driver.execute({
          sql: "INSERT INTO samples (id, numbers) VALUES (1, '{1,NULL,3}')",
          parameters: [],
        });

        return {
          read: await database
            .samples((sample) => ({ numbers: sample.numbers }))
            .then(
              () => "read",
              (error: Error) => error.message,
            ),
          invalid: await Promise.resolve()
            .then(() =>
              database.samples.insert({ id: 2, zoned: new Date("x") }),
            )
            .then(
              () => "written",
              (error: Error) => error.message,
            ),
        };
      });

      for (const result of Object.values(results)) {
        expect(result.read).toMatch(
          /integer\[\] value from the database contains a NULL element/,
        );
        expect(result.invalid).toMatch(
          /timestamptz values must be valid Dates/,
        );
      }
    });
  },
);

describe.skipIf(!url)("named prepared statements on node-postgres", () => {
  test("a statement prepared before its column changed type is prepared again", async () => {
    const before = schema({ items: { id: int, n: int } });
    const fixture = await testDatabase({
      url: url!,
      schema: before,
      driver: (options) => pg({ ...options, prepare: true }),
      max: 2,
      prefix: "symmetria_prepared",
    });
    const read = (database: typeof fixture.database) =>
      database.items((item) => ({ n: item.n }), {
        where: (item) => item.id.is(1),
      });

    try {
      await fixture.database.items.insert([
        { id: 1, n: 1 },
        { id: 2, n: 2 },
      ]);
      // Both connections prepare the statement.
      await Promise.all(
        Array.from({ length: 6 }, () => read(fixture.database)),
      );
      await fixture.driver.execute({
        sql: "ALTER TABLE items ALTER COLUMN n TYPE bigint",
        parameters: [],
      });

      // PostgreSQL refuses the old plan ("cached plan must not change result
      // type"); outside a transaction the call runs again under a new name.
      const migrated = createDatabase({
        schema: schema({ items: { id: int, n: bigint } }),
        driver: fixture.driver,
      });

      for (let call = 0; call < 6; call += 1) {
        expect(await read(migrated as never)).toEqual([{ n: 1n }] as never);
      }
    } finally {
      await fixture.close();
    }
  });

  /** The pool, a transaction or a session: whatever runs a statement. */
  type Executor = {
    readonly execute: (query: {
      sql: string;
      parameters: unknown[];
    }) => Promise<
      Record<string, unknown>[] | { rows: Record<string, unknown>[] }
    >;
  };

  const rows = async (
    executor: Executor,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<Record<string, unknown>[]> => {
    const result = await executor.execute({ sql, parameters });

    return Array.isArray(result) ? result : result.rows;
  };

  /** A pool of `max` connections on a table whose column `n` changes its type. */
  const retyped = async (max: number) => {
    const fixture = await testDatabase({
      url: url!,
      schema: schema({ items: { id: int, n: int } }),
      driver: (options) => pg({ ...options, prepare: true }),
      max,
      prefix: "symmetria_prepared",
    });
    const read = (executor: Executor = fixture.driver) =>
      rows(executor, "SELECT n FROM items WHERE id = $1", [1]);

    await fixture.database.items.insert({ id: 1, n: 1 });

    return {
      ...fixture,
      read,
      /** Every connection prepares the statement, then the column changes. */
      retype: async (type: "bigint" | "integer") => {
        for (let round = 0; round < 3; round += 1) {
          await Promise.all(Array.from({ length: max * 2 }, () => read()));
        }

        await rows(
          fixture.driver,
          `ALTER TABLE items ALTER COLUMN n TYPE ${type}`,
        );
      },
    };
  };

  // Through a pooler in transaction mode a call has no connection of its own
  // to have prepared the statement on.
  test.skipIf(transactionPooling)(
    "calls in flight on every connection when a column changes its type all run again",
    async () => {
      for (const max of [1, 4]) {
        const fixture = await retyped(max);
        const calls = (count: number) =>
          Promise.all(Array.from({ length: count }, () => fixture.read()));

        try {
          for (const [type, n] of [
            ["bigint", 1n],
            ["integer", 1],
          ] as const) {
            await fixture.retype(type);

            // One call per connection, each with the old plan: PostgreSQL
            // refuses them all at once, and every one of them runs again.
            expect(await calls(max)).toEqual(
              Array.from({ length: max }, () => [{ n }]),
            );
            expect(await calls(max * 3)).toEqual(
              Array.from({ length: max * 3 }, () => [{ n }]),
            );
          }
        } finally {
          await fixture.close();
        }
      }
    },
  );

  test.skipIf(transactionPooling)(
    "after a type change a session statement outside a transaction runs again, and a transaction fails once",
    async () => {
      const fixture = await retyped(2);
      const { driver, read } = fixture;

      try {
        await fixture.retype("bigint");

        expect(
          await driver.session(async (session) => [
            await read(session),
            await read(session),
          ]),
        ).toEqual([[{ n: 1n }], [{ n: 1n }]]);

        // The error has aborted the transaction, so nothing can run again
        // inside it: it fails with PostgreSQL's error, and the next one
        // prepares the statement afresh.
        await fixture.retype("integer");

        const refused = await driver
          .transaction((tx) => read(tx))
          .catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(QueryError);
        expect(refused).toMatchObject({
          sqlState: "0A000",
          message: "cached plan must not change result type",
        });
        expect(await driver.transaction((tx) => read(tx))).toEqual([{ n: 1 }]);

        // The same inside a session: its transaction fails, the session goes on.
        await fixture.retype("bigint");

        expect(
          await driver.session(async (session) => [
            await session
              .transaction((tx) => read(tx))
              .catch((error: { sqlState?: unknown }) => error.sqlState),
            await read(session),
          ]),
        ).toEqual(["0A000", [{ n: 1n }]]);
      } finally {
        await fixture.close();
      }
    },
  );

  // Values node-postgres turns into text only while it binds a statement, and
  // the error it throws for each when it cannot.
  const refusal = new Error("this value has no text");
  const circular: Record<string, unknown> = {};

  circular.self = circular;

  const unbindable: [
    name: string,
    value: unknown,
    thrown: (error: unknown) => boolean,
  ][] = [
    [
      "an object that holds a BigInt",
      { owner: "ada", balance: 10n },
      (error) => error instanceof TypeError && /BigInt/.test(error.message),
    ],
    [
      "a circular object",
      circular,
      (error) =>
        error instanceof TypeError && /circular|cyclic/i.test(error.message),
    ],
    [
      "an object whose toJSON() throws",
      {
        toJSON: () => {
          throw refusal;
        },
      },
      (error) => error === refusal,
    ],
    [
      "an object whose toPostgres() throws",
      {
        toPostgres: () => {
          throw refusal;
        },
      },
      (error) => error === refusal,
    ],
  ];

  // Such a value fails its own statement and whatever transaction holds it,
  // with node-postgres's error, and nothing after it: unnamed statements
  // (`prepare: false`) always behaved so, named ones must too.
  for (const prepare of [true, false]) {
    test.skipIf(transactionPooling)(
      `a value node-postgres cannot turn into text fails only its own statement (prepare: ${prepare})`,
      async () => {
        const fixture = await testDatabase({
          url: url!,
          schema: schema({ logs: { id: int.auto, message: text } }),
          driver: (options) => pg({ ...options, prepare }),
          // One connection, so every later call uses the one that failed.
          max: 1,
          prefix: "symmetria_prepared",
        });
        const { driver } = fixture;
        const failure = (work: Promise<unknown>): Promise<unknown> =>
          work.then(
            () => undefined,
            (error: unknown) => error,
          );
        const logged = async (message: string) =>
          (
            await rows(driver, "SELECT id FROM logs WHERE message = $1", [
              message,
            ])
          ).length;
        let statements = 0;

        try {
          for (const [name, value, thrown] of unbindable) {
            // The failing run is the statement's first on the connection, or
            // comes after the connection has prepared it.
            for (const prepared of [false, true]) {
              for (const place of ["transaction", "savepoint", "session"]) {
                const mark = `${name}, ${prepared ? "prepared" : "new"}, ${place}`;
                const sql = `SELECT $1::jsonb ->> 'owner' AS owner, ${++statements} AS statement`;
                const owner = async (executor: Executor, document: unknown) =>
                  (await rows(executor, sql, [document]))[0]?.owner;
                const log = (executor: Executor) =>
                  rows(executor, "INSERT INTO logs (message) VALUES ($1)", [
                    mark,
                  ]);

                if (prepared) {
                  expect(await owner(driver, { owner: "ada" })).toBe("ada");
                }

                if (place === "transaction") {
                  const failed = await failure(
                    driver.transaction(async (tx) => {
                      await log(tx);
                      await owner(tx, value);
                    }),
                  );

                  expect([mark, thrown(failed)]).toEqual([mark, true]);
                  expect([mark, await logged(mark)]).toEqual([mark, 0]);
                } else if (place === "savepoint") {
                  // The transaction catches the failure of its savepoint and
                  // goes on with the same statement.
                  const [failed, after] = await driver.transaction(
                    async (tx) => {
                      await log(tx);

                      return [
                        await failure(
                          tx.transaction((savepoint) =>
                            owner(savepoint, value),
                          ),
                        ),
                        await owner(tx, { owner: "ada" }),
                      ];
                    },
                  );

                  expect([mark, thrown(failed), after]).toEqual([
                    mark,
                    true,
                    "ada",
                  ]);
                  expect([mark, await logged(mark)]).toEqual([mark, 1]);
                } else {
                  const [failed, after] = await driver.session(
                    async (session) => [
                      await failure(owner(session, value)),
                      await owner(session, { owner: "ada" }),
                    ],
                  );

                  expect([mark, thrown(failed), after]).toEqual([
                    mark,
                    true,
                    "ada",
                  ]);
                }

                // The pool's connection runs the same statement again.
                for (let call = 0; call < 3; call += 1) {
                  expect([mark, await owner(driver, { owner: "ada" })]).toEqual(
                    [mark, "ada"],
                  );
                }
              }
            }
          }
        } finally {
          await fixture.close();
        }
      },
    );
  }

  test.skipIf(transactionPooling)(
    "a document JSON cannot hold, interpolated in a transaction, fails before the statement is sent",
    async () => {
      const fixture = await testDatabase({
        url: url!,
        schema: schema({ logs: { id: int.auto, message: text } }),
        driver: (options) => pg({ ...options, prepare: true }),
        max: 1,
        prefix: "symmetria_prepared",
      });
      const owner = (database: typeof fixture.database, document: unknown) =>
        database.logs((log) => ({
          id: log.id,
          owner: sql<string>`${document}::jsonb ->> 'owner'`,
        }));
      const backend = async () =>
        (await rows(fixture.driver, "SELECT pg_backend_pid() AS pid"))[0]!.pid;

      try {
        await fixture.database.logs.insert({ message: "seed" });
        expect(await owner(fixture.database, { owner: "ada" })).toEqual([
          { id: 1, owner: "ada" },
        ]);

        const pid = await backend();
        // A row of a table with a bigint column is such a document.
        const failed = await fixture.database
          .$transaction(async (tx) => {
            await tx.logs.insert({ message: "rolled back" });
            await owner(tx as never, { owner: "ada", balance: 10n });
          })
          .catch((error: unknown) => error);

        expect(failed).toBeInstanceOf(TypeError);
        expect(
          await fixture.database.logs((log) => ({ message: log.message })),
        ).toEqual([{ message: "seed" }]);

        for (let call = 0; call < 3; call += 1) {
          expect(await owner(fixture.database, { owner: "ada" })).toEqual([
            { id: 1, owner: "ada" },
          ]);
        }

        // Nothing reached the connection, so the pool keeps it.
        expect(await backend()).toBe(pid);
      } finally {
        await fixture.close();
      }
    },
  );
});

// A pooler in transaction mode refuses start-up parameters it does not know.
describe.skipIf(!url || transactionPooling)(
  "bytea on Bun.SQL where the server prints it in the escape form",
  () => {
    test("the connection option reads it, and without it the error names the option", async () => {
      const files = schema({ files: { id: int.auto, body: bytea } });
      const escaped = (
        address: string,
        connection?: Record<string, string>,
      ) => {
        const styled = new URL(address);

        styled.searchParams.set(
          "options",
          `${styled.searchParams.get("options") ?? ""} -c bytea_output=escape`.trim(),
        );

        return bun({
          url: styled.toString(),
          max: 1,
          ...(connection ? { connection } : {}),
        });
      };
      const fixture = await testDatabase({
        url: url!,
        schema: files,
        prefix: "symmetria_bytea_escape",
        max: 1,
        driver: ({ url: address }) => escaped(address, { bytea_output: "hex" }),
      });
      const plain = escaped(
        `${url!}${url!.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${fixture.namespace}`)}`,
      );

      try {
        const body = Uint8Array.from([0, 1, 92, 39, 255]);

        await fixture.database.files.insert({ body });
        expect(
          await fixture.database.files((file) => ({ body: file.body })),
        ).toEqual([{ body }]);

        const database = createDatabase({ schema: files, driver: plain });

        const refused = await Promise.resolve(
          database.files((file) => ({ body: file.body })),
        ).catch((error: unknown) => error);

        expect(String((refused as Error).message)).toContain(
          'connection: { bytea_output: "hex" }',
        );
        // Bun's own error, with its code, as before the advice was added.
        expect((refused as { code?: unknown }).code).toBe(
          "ERR_POSTGRES_UNSUPPORTED_BYTEA_FORMAT",
        );
        // Inside nested JSON the value is PostgreSQL's text, read either way;
        // the connection still works.
        expect(
          await database.files((file) => ({ nested: { body: file.body } })),
        ).toEqual([{ nested: { body } }]);
      } finally {
        await plain.close();
        await fixture.close();
      }
    });
  },
);
