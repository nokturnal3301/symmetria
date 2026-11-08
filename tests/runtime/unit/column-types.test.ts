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
  expect(codecFor("bytea[]")!.decode(["\\x01", null])).toEqual([
    new Uint8Array([1]),
    null,
  ]);
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
  expect(codecFor("timestamptz(3)")!.encode(instant as never)).toBe(instant);
  expect(normalizeSqlType("timestamp(3)")).toBe(
    normalizeSqlType("timestamp(3) without time zone"),
  );
});
