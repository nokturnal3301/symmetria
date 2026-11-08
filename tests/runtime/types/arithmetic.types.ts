// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  prepare,
  int,
  bigint,
  numeric,
  real,
  text,
  timestamp,
  type Decimal,
  type Infer,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

const lines = table({
  id: int.auto,
  quantity: int,
  price: numeric(10, 2),
  discount: numeric.nullable,
  weight: real,
  views: bigint,
  title: text,
  shippedAt: timestamp(3).nullable,
});
const model = schema({ lines });

{
  const query = model.lines((line) => ({
    total: line.quantity.multiply(line.price),
    reversed: line.price.multiply(line.quantity),
    withTax: line.price.multiply("1.2"),
    discounted: line.price.minus(line.discount),
    half: line.quantity.divide(2),
    ratio: line.weight.multiply(2),
    bump: line.views.plus(1),
    mixed: line.quantity.plus(10n),
  }));
  type Row = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>[number],
      {
        total: Decimal;
        reversed: Decimal;
        withTax: Decimal;
        discounted: Decimal | null;
        half: number;
        ratio: number;
        bump: bigint;
        mixed: bigint;
      }
    >
  >;
  // @ts-expect-error arithmetic needs a numeric column
  model.lines((line) => ({ x: line.title.plus(1) }));
  // @ts-expect-error pattern matching needs a text column
  model.lines((line) => ({ x: line.quantity.like("1%") }));
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
    price: fromForm,
    weight: 1,
    views: 1n,
    title: "x",
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
  const minimum = 0 as number;
  model.lines((line) => ({ id: line.id }), {
    where: (line) => [
      search && line.title.ilike(`%${search}%`),
      minimum && line.quantity.atLeast(minimum),
    ],
  });
}
