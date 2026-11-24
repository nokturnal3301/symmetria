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
  one,
  many,
  customType,
  createDatabase,
  type Decimal,
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

describe.skipIf(!databaseUrl)("customType() spellings and base types", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase>>;
  const execute = (sqlText: string) =>
    isolated.driver.execute({ sql: sqlText, parameters: [] });

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: schema({ placeholder: table({ id: int.auto }) }),
      prefix: "symmetria_custom",
      max: 1,
    });

    for (const statement of [
      "CREATE DOMAIN amount AS numeric(30,10)",
      "CREATE DOMAIN big_id AS bigint",
      "CREATE DOMAIN moment AS timestamptz",
      "CREATE DOMAIN day AS date",
      "CREATE DOMAIN flag AS boolean",
      "CREATE DOMAIN doc AS jsonb",
      "CREATE TABLE owners (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL)",
      `CREATE TABLE entries (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id integer NOT NULL REFERENCES owners,
        int8 int8 NOT NULL, upper_bigint BIGINT NOT NULL, decimal decimal(30,10) NOT NULL,
        int8s int8[] NOT NULL, bool bool NOT NULL, upper_uuid UUID NOT NULL,
        amount amount NOT NULL, big big_id NOT NULL, at moment NOT NULL, day day NOT NULL,
        flag flag NOT NULL, amounts amount[] NOT NULL, flags flag[] NOT NULL,
        docs doc[] NOT NULL, dec_value dec(30,10) NOT NULL,
        int8_array _int8 NOT NULL)`,
    ]) {
      await execute(statement);
    }
  });

  afterAll(async () => {
    await isolated?.close();
  });

  const asBigint = (sqlType: string) =>
    customType<bigint>(sqlType, {
      encode: (value) => value.toString(),
      decode: (value) => BigInt(String(value)),
    });
  const asText = (sqlType: string) =>
    customType<string>(sqlType, {
      encode: (value) => value,
      decode: (value) => String(value),
    });
  const same = <Value>(sqlType: string) =>
    customType<Value>(sqlType, {
      encode: (value) => value,
      decode: (value) => value as Value,
    });

  const owners = table({ id: int.auto, name: text, entries: many });
  const entries = table({
    id: int.auto,
    owner: one(owners.entries),
    int8: asBigint("int8"),
    upperBigint: asBigint("BIGINT"),
    decimal: asText("decimal(30,10)"),
    int8s: customType<bigint[]>("int8[]", {
      encode: (value) => value.map(String),
      decode: (value) =>
        (value as unknown[]).map((item) => BigInt(String(item))),
    }),
    bool: same<boolean>("bool"),
    upperUuid: same<string>("UUID"),
    amount: customType<Decimal>("amount", { base: "numeric(30,10)" }),
    big: customType<bigint>("big_id", { base: "bigint" }),
    at: customType<Date>("moment", { base: "timestamptz" }),
    day: customType<string>("day", { base: "date" }),
    flag: customType<boolean>("flag", { base: "boolean" }),
    amounts: customType<Decimal>("amount", { base: "numeric(30,10)" }).array,
    // A domain's array has a type of its own, which both drivers read as text.
    flags: customType<boolean>("flag", { base: "boolean" }).array,
    docs: customType<unknown>("doc", { base: "jsonb" }).array,
    // SQL's DEC, and int8[] by the name of its array type.
    decValue: asText("dec(30,10)"),
    int8Array: customType<bigint[]>("_int8", {
      encode: (value) => value.map(String),
      decode: (value) =>
        (value as unknown[]).map((item) => BigInt(String(item))),
    }),
  });
  const values = {
    int8: 9007199254740993n,
    upperBigint: 9007199254740993n,
    decimal: "1234567890.0123456789",
    int8s: [9007199254740993n],
    bool: true,
    upperUuid: "11111111-1111-4111-8111-111111111111",
    amount: "1234567890.0123456789" as Decimal,
    big: 9007199254740993n,
    at: new Date("2026-01-02T03:04:05.678Z"),
    day: "2026-01-02",
    flag: true,
    amounts: ["9007199254740993.0000000001" as Decimal],
    flags: [true, false],
    docs: [{ k: [1, true] }, "text", null] as unknown[],
    decValue: "12345678901234567890.1234567891",
    int8Array: [9007199254740993n],
  };

  test("values keep their precision and type at the top level, nested, in $batch, DISTINCT and RETURNING", async () => {
    const database = createDatabase({
      schema: schema({ owners, entries }),
      driver: isolated.driver,
    });
    await database.owners.insert({ name: "Ada" });
    const {
      id: _id,
      ownerId: _owner,
      ...returned
    } = await database.entries.insert({ ownerId: 1, ...values }).returning();
    const shape = database.entries.shape((entry) => ({
      int8: entry.int8,
      upperBigint: entry.upperBigint,
      decimal: entry.decimal,
      int8s: entry.int8s,
      bool: entry.bool,
      upperUuid: entry.upperUuid,
      amount: entry.amount,
      big: entry.big,
      at: entry.at,
      day: entry.day,
      flag: entry.flag,
      amounts: entry.amounts,
      flags: entry.flags,
      docs: entry.docs,
      decValue: entry.decValue,
      int8Array: entry.int8Array,
    }));
    const top = (await database.entries(shape))[0]!;
    const nested = (
      await database.owners((owner) => ({ entries: owner.entries(shape) }))
    )[0]!.entries[0]!;
    const [batched] = await database.$batch((db) => [
      db.entries(shape).first(),
    ]);
    const distinct = (
      await database.entries(
        (entry) => ({
          row: {
            int8: entry.int8,
            decimal: entry.decimal,
            amount: entry.amount,
            at: entry.at,
            decValue: entry.decValue,
            int8Array: entry.int8Array,
          },
        }),
        { distinct: true },
      )
    )[0]!.row;

    expect(top).toEqual(values);
    expect(returned).toEqual(values);
    expect(nested).toEqual(values);
    expect(batched).toEqual(values);
    // What a read returns writes back unchanged.
    await database.entries
      .byId(1)
      .update({ amounts: top.amounts, flags: top.flags, docs: top.docs });
    expect((await database.entries(shape))[0]).toEqual(values);
    expect(distinct).toEqual({
      int8: values.int8,
      decimal: values.decimal,
      amount: values.amount,
      at: values.at,
      decValue: values.decValue,
      int8Array: values.int8Array,
    });
  });

  test("aggregates, arithmetic and filters follow the type, not its spelling", async () => {
    const database = createDatabase({
      schema: schema({ owners, entries }),
      driver: isolated.driver,
    });
    const extremes = await database.entries.aggregate(
      (entry, { minimum, maximum }) => ({
        bool: maximum(entry.bool),
        uuid: minimum(entry.upperUuid),
        flag: minimum(entry.flag),
        amount: maximum(entry.amount),
        at: maximum(entry.at),
      }),
    );

    expect(extremes).toEqual({
      bool: true,
      uuid: values.upperUuid,
      flag: true,
      amount: values.amount,
      at: values.at,
    });
    expect(
      await database.entries((entry) => ({ next: entry.big.plus(1n) }), {
        where: (entry) => entry.big.is(9007199254740993n),
      }),
    ).toEqual([{ next: 9007199254740994n }]);
    expect(
      await database.owners((owner) => ({
        entries: owner.entries((entry) => ({ id: entry.id }), {
          where: (entry) => entry.amount.above("1234567890.0123456788"),
        }),
      })),
    ).toEqual([{ entries: [{ id: 1 }] }]);
  });
});
