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
} from "../../../packages/runtime/src";
import { bun } from "../../support/postgres";
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
