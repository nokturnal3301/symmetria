// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  prepare,
  int,
  smallint,
  bigint,
  numeric,
  real,
  doublePrecision,
  text,
  jsonb,
  oneOf,
  timestamp,
  sql,
  sum,
  average,
  minimum,
  maximum,
  coalesce,
  count,
  over,
  lag,
  rowNumber,
  type Decimal,
  type Infer,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends <
    Value,
  >() => Value extends Expected ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type RowOf<Query extends { execute: () => Promise<unknown> }> =
  Awaited<ReturnType<Query["execute"]>> extends readonly (infer Row)[]
    ? Row
    : never;

const lines = table({
  id: int.auto,
  quantity: int,
  small: smallint,
  price: numeric(10, 2),
  discount: numeric.nullable,
  weight: real,
  ratio: doublePrecision,
  maybeQuantity: int.nullable,
  maybeWeight: real.nullable,
  views: bigint,
  title: text,
  state: oneOf("open", "closed"),
  // Enum labels that look numeric are still text.
  code: oneOf("1", "2").default("1"),
  // A branded decimal is still a decimal.
  money: numeric(10, 2).brand("Money").nullable,
  meta: jsonb<{ size: number; price: Decimal; tags: string[] }>(),
  history: jsonb<{ price: Decimal }>().array,
  readings: real.array,
  shippedAt: timestamp(3).nullable,
}).computed((line) => ({
  // A computed expression keeps its SQL type: this one is a float.
  load: line.weight.multiply(line.quantity),
  units: sql.of(int)`${line.quantity} * 2`,
}));
const orders = table({ id: int.auto, line: lines, total: real, note: text });
const model = schema({ lines, orders });

{
  // Every combination, as PostgreSQL computes it (see arithmetic in the reference).
  const query = model.lines((line) => ({
    // int × int: integers, except division, which is exact.
    intPlus: line.quantity.plus(line.quantity),
    intMinus: line.quantity.minus(1),
    intTimes: line.quantity.multiply(2),
    intDivide: line.quantity.divide(2),
    intDivideColumn: line.quantity.divide(line.small),
    intQuotient: line.quantity.quotient(2),
    smallPlus: line.small.plus(1),
    smallDivide: line.small.divide(line.small),
    // int × bigint
    intPlusBigint: line.quantity.plus(line.views),
    intPlusBigintLiteral: line.quantity.plus(10n),
    intDivideBigint: line.quantity.divide(line.views),
    intQuotientBigint: line.quantity.quotient(10n),
    // int × numeric and decimal text
    intTimesNumeric: line.quantity.multiply(line.price),
    intTimesText: line.quantity.multiply("1.5"),
    intDivideNumeric: line.quantity.divide(line.price),
    intQuotientText: line.quantity.quotient("2"),
    // bigint × anything
    bigintPlus: line.views.plus(1),
    bigintTimesBigint: line.views.multiply(line.views),
    bigintDivide: line.views.divide(2),
    bigintQuotient: line.views.quotient(2),
    bigintTimesNumeric: line.views.multiply(line.price),
    // numeric × numeric
    numericPlus: line.price.plus(line.price),
    numericDivide: line.price.divide(3),
    numericQuotient: line.price.quotient(line.price),
    // floats keep float semantics, except next to a decimal
    floatPlus: line.weight.plus(1.5),
    floatTimesInt: line.weight.multiply(line.quantity),
    intTimesFloat: line.quantity.multiply(line.weight),
    floatTimesBigint: line.weight.multiply(10n),
    bigintTimesFloat: line.views.multiply(line.ratio),
    floatDivide: line.weight.divide(2),
    intDivideFloat: line.quantity.divide(line.ratio),
    floatQuotient: line.ratio.quotient(2),
    floatTimesNumeric: line.weight.multiply(line.price),
    floatTimesText: line.ratio.multiply("2"),
    // nullable operands give nullable results
    nullableNumeric: line.discount.plus(1),
    nullableOperand: line.quantity.plus(line.maybeQuantity),
    nullableDivide: line.maybeQuantity.divide(2),
    nullableFloat: line.maybeWeight.divide(line.quantity),
    // results keep computing as their type
    chainedDecimal: line.quantity.divide(2).plus(1),
    chainedFloat: line.weight.multiply(2).divide(2),
    chainedInteger: line.quantity.plus(1).divide(2),
    computedFloat: line.load.divide(2),
    computedInteger: line.units.divide(2),
  }));
  type Row = Assert<
    Equal<
      RowOf<typeof query>,
      {
        intPlus: number;
        intMinus: number;
        intTimes: number;
        intDivide: Decimal;
        intDivideColumn: Decimal;
        intQuotient: number;
        smallPlus: number;
        smallDivide: Decimal;
        intPlusBigint: bigint;
        intPlusBigintLiteral: bigint;
        intDivideBigint: Decimal;
        intQuotientBigint: bigint;
        intTimesNumeric: Decimal;
        intTimesText: Decimal;
        intDivideNumeric: Decimal;
        intQuotientText: Decimal;
        bigintPlus: bigint;
        bigintTimesBigint: bigint;
        bigintDivide: Decimal;
        bigintQuotient: bigint;
        bigintTimesNumeric: Decimal;
        numericPlus: Decimal;
        numericDivide: Decimal;
        numericQuotient: Decimal;
        floatPlus: number;
        floatTimesInt: number;
        intTimesFloat: number;
        floatTimesBigint: number;
        bigintTimesFloat: number;
        floatDivide: number;
        intDivideFloat: number;
        floatQuotient: number;
        floatTimesNumeric: Decimal;
        floatTimesText: Decimal;
        nullableNumeric: Decimal | null;
        nullableOperand: number | null;
        nullableDivide: Decimal | null;
        nullableFloat: number | null;
        chainedDecimal: Decimal;
        chainedFloat: number;
        chainedInteger: Decimal;
        computedFloat: number;
        computedInteger: Decimal;
      }
    >
  >;
  // @ts-expect-error arithmetic needs a numeric column
  model.lines((line) => ({ x: line.title.plus(1) }));
  // @ts-expect-error quotient() as well
  model.lines((line) => ({ x: line.shippedAt.quotient(1) }));
  // @ts-expect-error pattern matching needs a text column
  model.lines((line) => ({ x: line.quantity.like("1%") }));
  // @ts-expect-error a raw template has no SQL type to compute with
  model.lines(() => ({ x: sql<number>`1`.plus(1) }));
  // @ts-expect-error nor as an operand
  model.lines((line) => ({ x: line.quantity.plus(sql<number>`1`) }));
  model.lines(() => ({ x: sql.of(real)`1`.plus(1) }));
}
{
  // Text that looks numeric is not a decimal: enum labels and match() literals.
  // @ts-expect-error an enum has no arithmetic, even labelled "1"
  model.lines((line) => ({ x: line.code.plus(1) }));
  // @ts-expect-error nor as an operand
  model.lines((line) => ({ x: line.quantity.plus(line.code) }));
  // @ts-expect-error nor quotient()
  model.lines((line) => ({ x: line.code.quotient(1) }));
  model.lines((line) => ({ id: line.id }), {
    // @ts-expect-error filters take the labels, not any string
    where: (line) => line.code.is("3"),
  });
  // @ts-expect-error writes too
  model.lines.update({ code: "3" }).all();
  // @ts-expect-error sum() and average() add numbers
  model.lines((line) => ({ x: sum(line.code) }));
  // @ts-expect-error relation aggregates as well
  model.orders((order) => ({ x: order.line.orders.sum((o) => o.line.code) }));
  const labels = model.lines((line) => ({
    label: line.state.match({ open: "1", closed: "2" }),
  }));
  type Labels = Assert<Equal<RowOf<typeof labels>, { label: "1" | "2" }>>;
  model.lines((line) => ({
    // @ts-expect-error a match() of numeric-looking labels is text
    x: line.state.match({ open: "1", closed: "2" }).plus(1),
  }));
  model.lines((line) => ({ id: line.id }), {
    // @ts-expect-error and compares as its labels
    where: (line) => line.state.match({ open: "1", closed: "2" }).is("3"),
  });
  const byCode = prepare({ code: oneOf("1", "2") }, (values) =>
    model.lines((line) => ({ id: line.id }), {
      where: (line) => line.code.is(values.code),
    }),
  );
  // @ts-expect-error prepared enum values are labels
  byCode.execute({ code: "3" });
  // Real decimals keep accepting any string, branded or not.
  const exact = model.lines((line) => ({
    total: line.money.multiply(line.quantity),
    half: line.money.divide(2),
  }));
  type Exact = Assert<
    Equal<RowOf<typeof exact>, { total: Decimal | null; half: Decimal | null }>
  >;
  const fromForm = "1.5" as string;
  model.lines((line) => ({ id: line.id }), {
    where: (line) => [line.money.atLeast(fromForm), line.price.is(fromForm)],
  });
  model.lines.update({ money: fromForm }).all();
}
{
  // Aggregates, windows, JSON, derived tables and parameters keep the SQL type.
  const query = model.lines(
    (line, { innerJoin }) => {
      const order = innerJoin(model.orders, (order) =>
        order.lineId.is(line.id),
      );

      return {
        countPlus: count().plus(1),
        countDivide: count().divide(2),
        countPlusBigint: count().plus(1n),
        sumOfProducts: sum(line.quantity.multiply(line.price)),
        averageOfQuotients: average(line.weight.divide(2)),
        sumOfJson: sum(line.meta.path("size")),
        largestWeight: maximum(line.weight).divide(2),
        largestQuantity: maximum(line.quantity).divide(2),
        smallestFloor: minimum(line.quantity).quotient(2),
        fallback: coalesce(line.maybeWeight, 0).divide(2),
        fallbackInteger: coalesce(line.maybeQuantity, 0).divide(2),
        joinedFloat: order.total.divide(2),
        jsonPlus: line.meta.path("size").plus(1),
        jsonDivide: line.meta.path("size").divide(2),
        jsonQuotient: line.meta.path("size").quotient(2),
        jsonDecimal: line.meta.path("size").plus("0.5"),
        // A decimal-typed JSON value is JSON text, computed as a double.
        jsonText: line.meta.path("price").plus(1),
        jsonLength: line.meta.path("tags").length().divide(2),
        // Elements of a jsonb array are JSON too; of a real array, floats.
        arrayJson: line.history.path(0, "price").plus(1),
        arrayFloat: line.readings.path(0).divide(2),
        labelled: line.state.match({ open: 1, closed: 0 }).divide(2),
        labelledColumn: line.state
          .match({ open: line.quantity, closed: 0 })
          .divide(2),
      };
    },
    { groupBy: (line) => [line.id] },
  );
  type Row = Assert<
    Equal<
      RowOf<typeof query>,
      {
        countPlus: number;
        countDivide: Decimal;
        countPlusBigint: bigint;
        sumOfProducts: Decimal | null;
        averageOfQuotients: Decimal | null;
        sumOfJson: Decimal | null;
        largestWeight: number | null;
        largestQuantity: Decimal | null;
        smallestFloor: number | null;
        fallback: number;
        fallbackInteger: Decimal;
        joinedFloat: number;
        jsonPlus: number | null;
        jsonDivide: number | null;
        jsonQuotient: number | null;
        jsonDecimal: Decimal | null;
        jsonText: number | null;
        jsonLength: Decimal | null;
        arrayJson: number | null;
        arrayFloat: number | null;
        labelled: number;
        labelledColumn: Decimal;
      }
    >
  >;
  const windows = model.lines((line) => ({
    position: rowNumber().over().quotient(2),
    previous: lag(line.weight).over().divide(2),
    running: over(sum(line.views), { orderBy: line.id.ascending }).divide(2),
  }));
  type Windows = Assert<
    Equal<
      RowOf<typeof windows>,
      { position: number; previous: number | null; running: Decimal | null }
    >
  >;
  // Nested results keep each field's SQL type; numbers compute as doubles.
  const totals = model
    .lines((line) => ({
      id: line.id,
      weight: line.weight,
      quantity: line.quantity,
      payload: { views: line.views, quantity: line.quantity },
    }))
    .cte("totals");
  const derived = totals((row) => ({
    weight: row.weight.divide(2),
    quantity: row.quantity.divide(2),
    views: row.payload.path("views").plus(1n),
    nested: row.payload.path("quantity").divide(2),
  }));
  type Derived = Assert<
    Equal<
      RowOf<typeof derived>,
      {
        weight: number;
        quantity: Decimal;
        views: bigint | null;
        nested: number | null;
      }
    >
  >;
  const parameters = prepare({ factor: real, count: int }, (values) =>
    model.lines((line) => ({
      float: line.quantity.multiply(values.factor),
      exact: line.quantity.divide(values.count),
    })),
  );
  type Parameters = Assert<
    Equal<
      Awaited<ReturnType<typeof parameters.execute>>[number],
      { float: number; exact: Decimal }
    >
  >;
  const related = model.lines((line) => ({
    heaviest: line.orders.maximum.total.divide(2),
    largest: line.orders.maximum((order) => order.id).divide(2),
  }));
  type Related = Assert<
    Equal<
      RowOf<typeof related>,
      { heaviest: number | null; largest: Decimal | null }
    >
  >;
  const narrowed = model.lines((line, { whereNotNull }) => ({
    weight: whereNotNull(line.maybeWeight).divide(2),
  }));
  type Narrowed = Assert<Equal<RowOf<typeof narrowed>, { weight: number }>>;
  // sum() and average() take numbers, not text.
  // @ts-expect-error a text column does not sum
  model.lines((line) => ({ x: sum(line.title) }));
  // @ts-expect-error nor in a relation aggregate
  model.lines((line) => ({ x: line.orders.average.note }));
  model.lines((line) => ({ x: line.orders.sum.total }));
}
{
  // Decimal columns read exact text and accept plain strings on write and in filters.
  type Price = Assert<Equal<Infer<typeof model.lines>["price"], Decimal>>;
  type Shipped = Assert<
    Equal<Infer<typeof model.lines>["shippedAt"], Date | null>
  >;
  const fromForm = "19.99" as string;
  model.lines.insert({
    quantity: 1,
    small: 1,
    price: fromForm,
    weight: 1,
    ratio: 1,
    views: 1n,
    title: "x",
    state: "open",
    meta: { size: 1, price: "1", tags: [] },
    history: [],
    readings: [],
  });
  model.lines((line) => ({ id: line.id }), {
    where: (line) => line.price.atLeast(fromForm),
  });
  const byPrice = prepare({ price: numeric }, (parameters) =>
    model.lines((line) => ({ id: line.id }), {
      where: (line) => line.price.is(parameters.price),
    }),
  );
  byPrice.execute({ price: fromForm });
  const decimal: string = null as unknown as Decimal;
  void decimal;
}
{
  // `cond && predicate` lists compile for optional strings and numbers.
  const search = undefined as string | undefined;
  const least = 0 as number;
  model.lines((line) => ({ id: line.id }), {
    where: (line) => [
      search && line.title.ilike(`%${search}%`),
      least && line.quantity.atLeast(least),
    ],
  });
}
