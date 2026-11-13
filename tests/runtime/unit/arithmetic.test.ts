import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  bigint,
  numeric,
  real,
  smallint,
  text,
  oneOf,
  sum,
  sql,
  databaseError,
} from "../../../packages/runtime/src";
import { expectDataError } from "../../support/data-errors";

const lines = table({
  id: int.auto,
  quantity: int,
  small: smallint,
  price: numeric(10, 2),
  weight: real,
  views: bigint,
  title: text,
});
const rows: Record<string, unknown>[] = [];
const model = schema({ lines }, { executor: async () => rows });
type Line = Parameters<Parameters<typeof model.lines>[0]>[0];
const sqlOf = (
  build: (
    line: Parameters<Parameters<typeof model.lines>[0]>[0],
  ) => Record<string, unknown>,
) =>
  (
    model.lines(build as never) as unknown as {
      toSQL: () => { sql: string; parameters: unknown[] };
    }
  ).toSQL();

test("a decimal operand turns the other side into numeric", () => {
  expect(
    sqlOf((line) => ({ total: line.quantity.multiply(line.price) })).sql,
  ).toContain('((("lines"."quantity")::numeric) * "lines"."price") AS "total"');
  expect(sqlOf((line) => ({ total: line.price.multiply("1.2") }))).toEqual({
    sql: 'SELECT ("lines"."price" * $1::text::numeric) AS "total"\nFROM "lines" AS "lines"',
    parameters: ["1.2"],
  });
  // A decimal column divided by a float column stays exact.
  expect(
    sqlOf((line) => ({ x: line.price.divide(line.weight) })).sql,
  ).toContain('("lines"."price" / (("lines"."weight")::numeric))');
});

test("divide() never truncates; quotient() divides toward zero in the integer type", () => {
  expect(sqlOf((line) => ({ x: line.quantity.divide(2) })).sql).toContain(
    '((("lines"."quantity")::numeric) / $1::text::numeric)',
  );
  expect(
    sqlOf((line) => ({ x: line.views.divide(line.quantity) })).sql,
  ).toContain(
    '((("lines"."views")::numeric) / (("lines"."quantity")::numeric))',
  );
  expect(sqlOf((line) => ({ x: line.quantity.quotient(2) })).sql).toContain(
    '("lines"."quantity" / $1)',
  );
  expect(sqlOf((line) => ({ x: line.price.quotient(2) })).sql).toContain(
    'div("lines"."price", $1::text::numeric)',
  );
  expect(sqlOf((line) => ({ x: line.weight.quotient(2) })).sql).toContain(
    'trunc((("lines"."weight")::double precision) / $1::text::double precision)',
  );
  // Floats compute in double precision, whatever the other side.
  expect(sqlOf((line) => ({ x: line.weight.divide(2) })).sql).toContain(
    '((("lines"."weight")::double precision) / $1::text::double precision)',
  );
  expect(sqlOf((line) => ({ x: line.weight.multiply(10n) })).sql).toContain(
    '((("lines"."weight")::double precision) * $1::text::double precision)',
  );
  expect(sqlOf((line) => ({ x: line.quantity.plus(10n) })).sql).toContain(
    '("lines"."quantity" + $1::text::bigint)',
  );
  expect(sqlOf((line) => ({ x: line.views.plus(1) }))).toMatchObject({
    parameters: ["1"],
  });
  // A number next to a smallint is an integer, like a SQL literal.
  expect(sqlOf((line) => ({ x: line.small.plus(1) })).sql).toContain(
    '("lines"."small" + $1::text::integer)',
  );
});

test("numbers next to integer columns are integers in range; fractions are decimal text", async () => {
  expect(sqlOf((line) => ({ x: line.quantity.multiply("1.5") })).sql).toContain(
    '((("lines"."quantity")::numeric) * $1::text::numeric)',
  );

  for (const [build, message] of [
    [
      (line: Line) => line.quantity.multiply(1.5),
      /integer values are integers from -2147483648 to 2147483647, received 1.5/,
    ],
    [(line: Line) => line.quantity.plus(2 ** 31), /received 2147483648/],
    [(line: Line) => line.small.minus(Number.NaN), /received NaN/],
    [
      (line: Line) => line.views.multiply(0.5),
      /bigint values or safe integers/,
    ],
  ] as const) {
    await expectDataError(
      () => model.lines((line) => ({ x: build(line) })),
      message,
    );
  }

  // Next to a count(), which is bigint in SQL, any safe integer fits.
  expect(
    model.lines((_line, { count }) => ({ x: count().plus(2 ** 40) })).toSQL(),
  ).toMatchObject({ parameters: [String(2 ** 40)] });
});

test("text that looks numeric has no arithmetic: enums and match() labels", () => {
  const coded = schema(
    {
      codes: table({
        id: int.auto,
        code: oneOf("1", "2"),
        state: oneOf("a", "b"),
      }),
    },
    { executor: async () => [] },
  );

  expect(() =>
    coded.codes((row) => ({
      x: (row.code as never as Line["quantity"]).plus(1),
    })),
  ).toThrow(/arithmetic needs a number, bigint or numeric value, not enum/);
  expect(() =>
    coded.codes((row) => ({
      x: (
        row.state.match({ a: "1", b: "2" }) as never as Line["quantity"]
      ).multiply(2),
    })),
  ).toThrow(/not text/);
});

test("arithmetic on raw SQL needs a SQL type", () => {
  expect(() =>
    sqlOf(() => ({ x: sql<number>`1`.plus(1 as never) as never })),
  ).toThrow(/known SQL type; write raw SQL as sql.of\(column\)/);
  expect(() =>
    sqlOf((line) => ({ x: line.quantity.plus(sql<number>`1` as never) })),
  ).toThrow(/known SQL type/);
  expect(sqlOf(() => ({ x: sql.of(int)`7`.divide(2) })).sql).toContain(
    "(((7))::numeric) / $1::text::numeric)",
  );
});

test("results decode with the promoted type, including sums of products", async () => {
  rows.splice(0, rows.length, {
    total: "606.30",
    views: "9007199254740994",
    ratio: 4.5,
    half: "1.5000000000000000",
    whole: 1,
    sum: "607.00",
  });
  const [row] = await model.lines((line) => ({
    total: line.quantity.multiply(line.price),
    views: line.views.plus(1),
    ratio: line.weight.multiply(1.5),
    half: line.quantity.divide(2),
    whole: line.quantity.quotient(2),
    sum: sum(line.quantity.multiply(line.price)),
  }));

  expect(row).toEqual({
    total: "606.30",
    views: 9007199254740994n,
    ratio: 4.5,
    half: "1.5000000000000000",
    whole: 1,
    sum: "607.00",
  });
});

test("arithmetic rejects missing and non-numeric operands", () => {
  expect(() =>
    sqlOf((line) => ({ x: line.quantity.plus(undefined as never) })),
  ).toThrow(/arithmetic needs a value; use coalesce\(\)/);
  expect(() =>
    sqlOf((line) => ({ x: line.quantity.plus({} as never) })),
  ).toThrow(/numbers, bigints, decimal strings or numeric columns/);
});

test("predicate lists skip every falsy entry, as `cond && predicate` produces", () => {
  const search = "" as string | undefined;
  const minimum = 0 as number;
  const { sql } = model
    .lines((line) => ({ id: line.id }), {
      where: (line) => [
        search && line.title.ilike(`%${search}%`),
        minimum && line.quantity.atLeast(minimum),
        0n,
        line.id.above(0),
      ],
    })
    .toSQL();

  expect(sql).toEndWith('WHERE "lines"."id" > $1');
  expect(() =>
    model.lines((line) => ({ id: line.id }), {
      where: () => ["oops" as never],
    }),
  ).toThrow(/expected a SQL predicate/);
});

test("one() and maybeOne() name the source and carry a code", async () => {
  rows.splice(0, rows.length);
  const missing = await model.lines
    .byId(7)
    .one()
    .catch((error: unknown) => error);

  expect(missing).toMatchObject({
    message: 'symmetria: expected exactly one row from "lines", received 0',
    code: "SYMMETRIA_RECORD_NOT_FOUND",
    table: "lines",
  });
  rows.splice(0, rows.length, { id: 1 }, { id: 2 });
  expect(
    await model
      .lines((line) => ({ id: line.id }))
      .maybeOne()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "SYMMETRIA_TOO_MANY_ROWS" });
});

test("databaseError() reads node-postgres and Bun.SQL errors alike", () => {
  const pg = Object.assign(
    new Error('duplicate key value violates unique constraint "u_email_key"'),
    {
      code: "23505",
      table: "u",
      constraint: "u_email_key",
      detail: "Key (email)=(a) already exists.",
    },
  );
  const bun = Object.assign(
    new Error(
      'null value in column "email" of relation "u" violates not-null constraint',
    ),
    { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23502", table: "u" },
  );

  expect(databaseError(pg)).toEqual({
    kind: "unique",
    sqlState: "23505",
    message: pg.message,
    table: "u",
    constraint: "u_email_key",
    detail: "Key (email)=(a) already exists.",
  });
  expect(databaseError(bun)).toMatchObject({
    kind: "not-null",
    sqlState: "23502",
    table: "u",
    column: "email",
  });
  expect(databaseError({ code: "22012" })).toMatchObject({ kind: "other" });
  expect(databaseError(new Error("socket closed"))).toBeUndefined();
  expect(databaseError(undefined)).toBeUndefined();
});
