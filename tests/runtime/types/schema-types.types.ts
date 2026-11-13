// Compile-only API contracts: bun run test:types.
// Named enum types, collations, BY DEFAULT identities and boolean conditions.
import {
  schema,
  table,
  index,
  int,
  bigint,
  text,
  bool,
  oneOf,
  sql,
  timestamptz,
  type Infer,
  type InferInsert,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

{
  // typeName() keeps the label union and chains like any enum column.
  const role = oneOf("USER", "ADMIN").typeName("Role");
  const model = schema({
    users: table({
      id: int.auto.byDefault,
      role: role.default("USER"),
      previousRole: role.nullable,
      code: text.collate("C"),
      label: text.collate("C").nullable,
    }),
    events: table({ id: bigint.auto, label: text }),
  });

  type User = Infer<typeof model.users>;
  type _Role = Assert<Equal<User["role"], "USER" | "ADMIN">>;
  type _Previous = Assert<Equal<User["previousRole"], "USER" | "ADMIN" | null>>;
  type _Code = Assert<Equal<User["code"], string>>;
  type _Label = Assert<Equal<User["label"], string | null>>;

  // BY DEFAULT identities accept an explicit id; ALWAYS identities do not.
  type UserInsert = InferInsert<typeof model.users>;
  type _OptionalId = Assert<Equal<UserInsert["id"], number | undefined>>;
  const withId: UserInsert = { id: 7, code: "a" };
  const withoutId: UserInsert = { code: "b" };
  void [withId, withoutId];
  // @ts-expect-error GENERATED ALWAYS columns are not written
  const always: InferInsert<typeof model.events> = { id: 1n, label: "x" };
  void always;

  // @ts-expect-error typeName() is only for enum columns
  text.typeName("Role");
  // @ts-expect-error byDefault follows auto
  text.auto.byDefault;
}

{
  // Checks and partial indexes take predicates or boolean expressions.
  schema({
    products: table({
      id: int.auto,
      price: int,
      active: bool,
      deletedAt: timestamptz.nullable,
    })
      .checks((products) => ({
        positive: sql<boolean>`${products.price} > 0`,
        bounded: products.price.below(1000),
        flagged: products.active,
      }))
      .indexes((products) => ({
        live: index(products.price).where(
          sql<boolean>`${products.deletedAt} IS NULL`,
        ),
        enabled: index(products.price).where(products.active),
      })),
  });

  // In a check, an untyped template is read as a boolean expression.
  schema({
    products: table({ id: int.auto, price: int }).checks((products) => ({
      inferred: sql`${products.price} > 0`,
    })),
  });

  schema({
    products: table({ id: int.auto, price: int }).checks((products) => ({
      // @ts-expect-error a template typed as another value is not a condition
      priced: sql<number>`${products.price} + 1`,
    })),
  });

  schema({
    products: table({ id: int.auto, price: int }).indexes((products) => ({
      // @ts-expect-error a number column is not a condition
      priced: index(products.price).where(products.price),
    })),
  });
}
