import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  sql,
  smallint,
  real,
  doublePrecision,
  date,
  time,
  interval,
  bytea,
  inet,
  int,
  text,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const owners = table({ id: int.auto, name: text });
const samples = table({
  id: smallint.auto,
  owner: owners,
  weight: real,
  ratio: doublePrecision.nullable,
  born: date,
  dates: date.array,
  at: time,
  ttl: interval,
  payload: bytea,
  chunks: bytea.array.nullable,
  address: inet.nullable,
  hosts: inet.array.default([]),
  ranks: smallint.array,
});
const model = schema({ owners, samples });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("first-class column types on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_types",
      max: 1,
    });
    database = isolated.database;
    await database.owners.insert({ name: "Ada" });
  });

  afterAll(async () => {
    await isolated?.close();
  });

  const row = {
    ownerId: 1,
    weight: 1.5,
    ratio: null,
    born: "2024-01-31",
    dates: ["2024-01-01", "2024-12-31"],
    at: "12:30:00",
    ttl: "1 day 02:00:00",
    payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    chunks: [new Uint8Array([1]), new Uint8Array([2, 3])],
    address: "10.0.0.1",
    hosts: ["::1", "192.168.0.0/24"],
    ranks: [1, 2, 3],
  };

  test("values round-trip through writes, reads, RETURNING and nested JSON", async () => {
    const inserted = await database.samples
      .insert(row)
      .returning((sample) => ({ ...sample }));

    expect(inserted).toEqual({ id: 1, ...row });
    expect(typeof inserted.id).toBe("number");

    const read = await database.samples
      .byId(1)((sample) => ({
        born: sample.born,
        at: sample.at,
        ttl: sample.ttl,
        payload: sample.payload,
        weight: sample.weight,
        dates: sample.dates,
        chunks: sample.chunks,
        hosts: sample.hosts,
        ranks: sample.ranks,
      }))
      .one();
    expect(read).toEqual({
      born: row.born,
      at: row.at,
      ttl: row.ttl,
      payload: row.payload,
      weight: row.weight,
      dates: row.dates,
      chunks: row.chunks,
      hosts: row.hosts,
      ranks: row.ranks,
    });

    // Nested JSON delivers PostgreSQL's text forms; the codecs decode them too.
    const nested = await database.owners((owner) => ({
      samples: owner.samples((sample) => ({
        born: sample.born,
        ttl: sample.ttl,
        payload: sample.payload,
        weight: sample.weight,
        ranks: sample.ranks,
      })),
    }));
    expect(nested).toEqual([
      {
        samples: [
          {
            born: row.born,
            ttl: row.ttl,
            payload: row.payload,
            weight: row.weight,
            ranks: row.ranks,
          },
        ],
      },
    ]);
  });

  test("floats keep NaN and infinities, filters bind native values", async () => {
    await database.samples.insert({
      ...row,
      weight: Number.NaN,
      ratio: Number.POSITIVE_INFINITY,
      born: "2023-06-15",
      payload: new Uint8Array([0x00]),
      address: "::1",
      chunks: null,
    });
    const floats = await database.samples(
      (sample) => ({ weight: sample.weight, ratio: sample.ratio }),
      {
        where: (sample) => sample.id.is(2),
      },
    );
    expect(floats[0]!.weight).toBeNaN();
    expect(floats[0]!.ratio).toBe(Number.POSITIVE_INFINITY);

    expect(
      await database.samples((sample) => ({ id: sample.id }), {
        where: (sample) => sample.payload.is(new Uint8Array([0x00])),
      }),
    ).toEqual([{ id: 2 }]);
    expect(
      await database.samples((sample) => ({ id: sample.id }), {
        where: (sample) => sample.address.is("::1"),
      }),
    ).toEqual([{ id: 2 }]);
    expect(
      await database.samples((sample) => ({ id: sample.id }), {
        where: (sample) => sample.born.below("2024-01-01"),
      }),
    ).toEqual([{ id: 2 }]);
    expect(
      await database.samples(
        (sample) => ({
          year: sql<number>`extract(year from ${sample.born})::int`,
        }),
        {
          where: (sample) => sample.id.is(1),
        },
      ),
    ).toEqual([{ year: 2024 }]);
  });

  test("keyset pages order by date columns in both directions", async () => {
    const feed = database.samples(
      (sample) => ({ id: sample.id, born: sample.born }),
      {
        orderBy: (sample) => [sample.born.descending, sample.id.ascending],
      },
    );
    const first = await feed.page({ size: 1 });
    const second = await feed.page({ size: 1, after: first.nextCursor });
    const back = await feed.page({ size: 1, before: second.previousCursor });

    expect(first.items).toEqual([{ id: 1, born: "2024-01-31" }]);
    expect(second.items).toEqual([{ id: 2, born: "2023-06-15" }]);
    expect(back.items).toEqual(first.items);
  });
});
