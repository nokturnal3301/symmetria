import { schema, int, text } from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;
const model = schema({
  plain: { primary: int.primaryKey.array, unique: text.unique.array },
  keyed: {
    key: int.array.primaryKey,
    unique: text.array.unique,
    nullable: int.array.nullable,
  },
});

// @ts-expect-error array() drops scalar primary-key constraints
model.plain.byId([1]);
// @ts-expect-error array() drops scalar uniqueness constraints
model.plain.by.unique(["value"]);
model.keyed.byId([1]);
model.keyed.by.unique(["value"]);
const lengths = model.keyed((keyed) => ({
  required: keyed.key.length(),
  nullable: keyed.nullable.length(),
}));
type Lengths = Assert<
  Equal<
    Awaited<ReturnType<typeof lengths.execute>>,
    { required: number; nullable: number | null }[]
  >
>;
