import { expect, test } from "bun:test";
import {
  schema,
  table,
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
  timestamp,
  timestamptz,
} from "../../../packages/runtime/src";
import { codecFor } from "../../../packages/runtime/src/query/codecs";
import { postgresArrayLiteral } from "../../../packages/runtime/src/query/compile/postgres/values";
import { createSchemaSQL, normalizeSqlType } from "../../../packages/kit/src";
import { expectDataError } from "../../support/data-errors";
import { quoteLiteral } from "../../../packages/kit/src/migrations/snapshot";

test("the builders declare their PostgreSQL types and modifiers", () => {
  expect(
    [smallint, real, doublePrecision, date, time, interval, bytea, inet].map(
      (column) => column.definition.sqlType,
    ),
  ).toEqual([
    "smallint",
    "real",
    "double precision",
    "date",
    "time",
    "interval",
    "bytea",
    "inet",
  ]);
  expect(smallint.auto.definition.default).toEqual({
    kind: "sql",
    sql: "identity",
  });
  expect(inet.array.definition.sqlType).toBe("inet[]");
  expect(bytea.nullable.definition.notNull).toBe(false);
});

test("codecs normalize driver, JSON and text forms", () => {
  const decode = (sqlType: string, value: unknown) =>
    codecFor(sqlType)!.decode(value);

  expect(decode("real", "NaN")).toBeNaN();
  expect(decode("double precision", "-Infinity")).toBe(-Infinity);
  expect(decode("smallint", 7)).toBe(7);
  expect(decode("smallint", "7")).toBe(7);
  // Bun parses dates as UTC midnight, node-postgres as local midnight; both read back as text.
  expect(decode("date", new Date("2024-01-31T00:00:00Z"))).toBe("2024-01-31");
  expect(decode("date", new Date(2024, 0, 31))).toBe("2024-01-31");
  expect(decode("date", "2024-01-31")).toBe("2024-01-31");
  expect(
    codecFor("date")!.encode(new Date("2024-01-31T00:00:00Z") as never),
  ).toBe("2024-01-31");
  expect(decode("interval", { toPostgres: () => "1 day 02:00:00" })).toBe(
    "1 day 02:00:00",
  );
  expect(decode("interval", "1 day")).toBe("1 day");
  expect(decode("bytea", "\\xdead")).toEqual(new Uint8Array([0xde, 0xad]));
  expect(decode("bytea", Buffer.from([1, 2]))).toEqual(new Uint8Array([1, 2]));
  expect(() => codecFor("bytea")!.encode("nope" as never)).toThrow(
    /accept Uint8Array/,
  );
  expect(codecFor("time")).toBeUndefined();
  expect(codecFor("inet")).toBeUndefined();
  expect(codecFor("bytea[]")!.decode(["\\x01"])).toEqual([new Uint8Array([1])]);
});

test("binary values render as hex in array literals and defaults", () => {
  expect(postgresArrayLiteral([new Uint8Array([0xde, 0xad]), null])).toBe(
    '{"\\\\xdead",NULL}',
  );
  expect(quoteLiteral(new Uint8Array([0, 255]))).toBe("'\\x00ff'::bytea");

  const files = table({
    id: int.auto,
    name: text,
    content: bytea.default(new Uint8Array([1, 2])),
    since: date.default("2024-01-01"),
    ttl: interval.default("1 day"),
    address: inet.nullable,
    ratio: real.default(0.5),
  });
  const ddl = createSchemaSQL(schema({ files }).$snapshot())
    .map((statement) =>
      typeof statement === "string"
        ? statement
        : (statement as { sql: string }).sql,
    )
    .join("\n");

  expect(ddl).toContain(`"content" bytea DEFAULT '\\x0102'::bytea NOT NULL`);
  expect(ddl).toContain(`"since" date DEFAULT E'2024-01-01' NOT NULL`);
  expect(ddl).toContain(`"ttl" interval DEFAULT E'1 day' NOT NULL`);
  expect(ddl).toContain(`"address" inet,`);
  expect(ddl).toContain(`"ratio" real DEFAULT 0.5 NOT NULL`);
});

test("type normalization treats time precision and aliases alike", () => {
  expect(normalizeSqlType("time")).toBe("time without time zone");
  expect(normalizeSqlType("time(3)")).toBe("time without time zone(3)");
  expect(normalizeSqlType("time(3) without time zone")).toBe(
    "time without time zone(3)",
  );
  expect(normalizeSqlType("timetz")).toBe("time with time zone");
  expect(normalizeSqlType("timestamp(3) with time zone")).toBe(
    "timestamp with time zone(3)",
  );
  expect(normalizeSqlType("double precision")).toBe("double precision");
  expect(normalizeSqlType("float8[]")).toBe("double precision[]");
});

test("timestamp builders take a precision and read zone-less values as UTC", () => {
  expect(timestamp.definition.sqlType).toBe("timestamp");
  expect(timestamp(3).definition.sqlType).toBe("timestamp(3)");
  expect(timestamptz(6).now.definition).toMatchObject({
    sqlType: "timestamptz(6)",
    default: { kind: "sql", sql: "now()" },
  });
  expect(() => timestamp(7)).toThrow(/between 0 and 6/);

  const codec = codecFor("timestamp(3)")!;
  const instant = new Date("2024-01-31T12:00:00.123Z");

  // Text from node-postgres, JSON from nested results, and a Bun Date all agree.
  expect(codec.decode("2024-01-31 12:00:00.123")).toEqual(instant);
  expect(codec.decode("2024-01-31T12:00:00.123")).toEqual(instant);
  expect(codec.decode(instant)).toBe(instant);
  expect(codec.encode(instant as never)).toBe("2024-01-31T12:00:00.123Z");
  expect(() => codec.decode("infinity")).toThrow(/cannot represent/);
  // node-postgres would print a Date in local time with a whole-minute offset.
  expect(codecFor("timestamptz(3)")!.encode(instant as never)).toBe(
    "2024-01-31T12:00:00.123Z",
  );
  expect(normalizeSqlType("timestamp(3)")).toBe(
    normalizeSqlType("timestamp(3) without time zone"),
  );
});

test("timestamps reject invalid Dates and keep BC years, large years and offsets with seconds", () => {
  const local = codecFor("timestamp")!;
  const zoned = codecFor("timestamptz")!;
  const caesar = new Date("-000043-03-15T12:00:00.000Z");
  const future = new Date("+010000-01-01T00:00:00.000Z");

  for (const codec of [local, zoned]) {
    expect(() => codec.encode(new Date("not a date") as never)).toThrow(
      /must be valid Dates/,
    );
    expect(codec.encode(caesar as never)).toBe("0044-03-15T12:00:00.000Z BC");
    expect(codec.encode(future as never)).toBe("10000-01-01T00:00:00.000Z");
  }

  // PostgreSQL's text (node-postgres) and JSON forms of the same instants.
  expect(local.decode("0044-03-15 12:00:00 BC")).toEqual(caesar);
  expect(local.decode("0044-03-15T12:00:00 BC")).toEqual(caesar);
  expect(local.decode("0001-01-01 00:00:00 BC")).toEqual(
    new Date("0000-01-01T00:00:00.000Z"),
  );
  expect(local.decode("10000-01-01T00:00:00")).toEqual(future);
  expect(local.decode("2024-01-31 12:00:00.123456")).toEqual(
    new Date("2024-01-31T12:00:00.123Z"),
  );
  expect(zoned.decode("0044-03-15T12:00:00+00:00 BC")).toEqual(caesar);
  // Kyiv's local mean time before 1924 was 2:02:04 ahead of UTC.
  expect(zoned.decode("1920-06-01 14:02:04+02:02:04")).toEqual(
    new Date("1920-06-01T12:00:00.000Z"),
  );
  expect(zoned.decode("1971-06-01T11:15:30-00:44:30")).toEqual(
    new Date("1971-06-01T12:00:00.000Z"),
  );
  expect(zoned.decode("2024-01-31 12:00:00.5+05:30")).toEqual(
    new Date("2024-01-31T06:30:00.500Z"),
  );
});

test("dates print PostgreSQL's forms for every driver value", () => {
  const codec = codecFor("date")!;

  // Bun reads dates as UTC midnight Dates and infinity as ±Infinity.
  expect(codec.decode(new Date("0999-05-05T00:00:00.000Z"))).toBe("0999-05-05");
  expect(codec.decode(new Date("-000043-03-15T00:00:00.000Z"))).toBe(
    "0044-03-15 BC",
  );
  expect(codec.decode(new Date("0000-12-31T00:00:00.000Z"))).toBe(
    "0001-12-31 BC",
  );
  expect(codec.decode(Infinity)).toBe("infinity");
  expect(codec.decode(-Infinity)).toBe("-infinity");
  expect(codec.decode("0044-03-15 BC")).toBe("0044-03-15 BC");
  expect(codec.encode(new Date("-000043-03-15T00:00:00.000Z") as never)).toBe(
    "0044-03-15 BC",
  );
});

test("real values read as PostgreSQL prints them, the shortest decimal of the float", () => {
  const codec = codecFor("real")!;

  // Bun's binary protocol hands over the exact float; node-postgres its text.
  expect(codec.decode(Math.fround(0.1))).toBe(0.1);
  expect(codec.decode(0.1)).toBe(0.1);
  expect(codec.decode(Math.fround(16777217))).toBe(16777216);
  expect(codec.decode(Math.fround(3.4028234663852886e38))).toBe(3.4028235e38);
  expect(codec.decode(Math.fround(1e-45))).toBe(1e-45);
  // Ties go to the even digit, as in PostgreSQL's float output.
  expect(codec.decode(1367415.25)).toBe(1367415.2);
  expect(codec.decode(329221.125)).toBe(329221.12);
  expect(codec.decode(0.5)).toBe(0.5);
  expect(Object.is(codec.decode(-0), -0)).toBe(true);
  expect(codec.decode("NaN")).toBeNaN();
  expect(codec.decode(-Infinity)).toBe(-Infinity);
  expect(codecFor("real[]")!.decode(Float32Array.of(0.1, 2.5))).toEqual([
    0.1, 2.5,
  ]);
  expect(codecFor("double precision")!.decode(Math.fround(0.1))).toBe(
    Math.fround(0.1),
  );
});

test("integer columns reject fractional and out-of-range numbers on every driver", async () => {
  const integer = codecFor("integer")!;
  const small = codecFor("smallint")!;

  expect(integer.encode(-2147483648 as never)).toBe(-2147483648);
  expect(integer.encode(2147483647 as never)).toBe(2147483647);
  expect(small.encode(-32768 as never)).toBe(-32768);

  for (const value of [6.5, 2 ** 31, -(2 ** 31) - 1, Number.NaN, Infinity]) {
    expect(() => integer.encode(value as never)).toThrow(
      /integer values are integers from -2147483648 to 2147483647/,
    );
  }

  expect(() => small.encode(70000 as never)).toThrow(
    /smallint values are integers from -32768 to 32767, received 70000/,
  );
  expect(() => integer.encode((2n ** 31n) as never)).toThrow(/integer values/);

  // Out-of-range values fail the query when it runs, reads and writes alike.
  const model = schema({ rows: { id: int.auto, n: int, s: smallint } });
  await expectDataError(
    () =>
      model.rows((rows) => ({ id: rows.id }), {
        where: (rows) => rows.n.above(6.5),
      }),
    /integer values/,
  );
  await expectDataError(
    () => model.rows.insert({ n: 1, s: 70000 }),
    /smallint values/,
  );
  await expectDataError(
    () =>
      model.rows((rows) => ({ id: rows.id }), {
        where: (rows) => rows.n.in([1, 2 ** 31]),
      }),
    /integer values/,
  );
  expect(() =>
    model.rows((rows) => ({ id: rows.id }), {
      where: (rows) => rows.n.above(6),
    }),
  ).not.toThrow();
});

test("arrays accept Bun's typed arrays and reject NULL elements their type cannot hold", () => {
  expect(codecFor("integer[]")!.decode(Int32Array.of(1, -2))).toEqual([1, -2]);
  expect(codecFor("smallint[]")!.decode(Int16Array.of(3))).toEqual([3]);
  expect(codecFor("bigint[]")!.decode(BigInt64Array.of(5n))).toEqual([5n]);
  expect(() =>
    codecFor("integer[]")!.decode(new DataView(new ArrayBuffer(4))),
  ).toThrow(/expected an array value/);

  for (const sqlType of ["integer[]", "text[]", "bytea[]", "bigint[]"]) {
    expect(() => codecFor(sqlType)!.decode([null])).toThrow(
      /contains a NULL element/,
    );
    expect(() => codecFor(sqlType)!.encode([null] as never)).toThrow(
      /cannot store NULL elements/,
    );
  }

  // JSON null is a value of a jsonb element.
  expect(codecFor("jsonb[]")!.decode([null, { a: 1 }])).toEqual([
    null,
    { a: 1 },
  ]);
  expect(int.array.nullable.definition.sqlType).toBe("integer[]");
});
