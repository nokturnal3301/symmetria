// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  junction,
  int,
  bigint,
  text,
  oneOf,
  count,
} from "../../../packages/runtime/src";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const users = table({ id: int.auto, name: text });
const teams = table({ id: int.auto, title: text });
const memberships = junction({ user: users, team: teams });
const model = schema({
  users,
  teams,
  memberships,
  records: { id: int.auto, state: oneOf("draft", "published") },
  counters: { id: int.auto, total: bigint },
});

{
  const rows = await model.users((users) => ({
    id: users.id,
    name: users.name,
  }));
  type Rows = Expect<AreEqual<typeof rows, { id: number; name: string }[]>>;
  const projected = await model.users((users) => ({
    label: users.name,
    $limit: 1,
  }));
  type Projected = Expect<AreEqual<typeof projected, { label: string }[]>>;
  const first = await model.users((users) => ({ id: users.id })).first();
  type First = Expect<AreEqual<typeof first, { id: number } | null>>;
  const maybe = await model.users
    .byId(1)((users) => ({ name: users.name }))
    .maybeOne();
  type Maybe = Expect<AreEqual<typeof maybe, { name: string } | null>>;
  const one = await model.users
    .byId(1)((users) => ({ name: users.name }))
    .one();
  type One = Expect<AreEqual<typeof one, { name: string }>>;
  const inserted = await model.users.insert({ name: "Ada" });
  type Inserted = Expect<AreEqual<typeof inserted, { affectedRows: number }>>;
  const returned = await model.users
    .insert({ name: "Ada" })
    .returning((users) => [users.id]);
  type Returned = Expect<AreEqual<typeof returned, { id: number }>>;
  const skipped = await model.users
    .insert({ name: "Ada" })
    .onConflict("id")
    .doNothing()
    .returning((users) => [users.id]);
  type Skipped = Expect<AreEqual<typeof skipped, { id: number } | null>>;
  const many = await model.users
    .insert([{ name: "Ada" }])
    .returning((users) => [users.id]);
  type Many = Expect<AreEqual<typeof many, { id: number }[]>>;
  const counted = await model.users((users) => ({ count: count() }));
  type Counted = Expect<AreEqual<typeof counted, { count: number }[]>>;
  model.counters((counters) => ({ $where: counters.total.above(10) }));
  model.counters((counters) => ({ $where: counters.total.atMost(10n) }));
  model.counters.insert({ total: 5 });
  model.counters.insert({ total: 5n });
  model.counters.update({ total: 5 });
  // @ts-expect-error strings are not bigint values
  model.counters.insert({ total: "5" });
  // @ts-expect-error integer columns do not accept bigint
  model.users((users) => ({ $where: users.id.above(1n) }));
  const deleted = await model.users.delete().where((users) => users.id.is(1));
  type Deleted = Expect<AreEqual<typeof deleted, { affectedRows: number }>>;
  const linked = await model.memberships.insert({ userId: 1, teamId: 2 });
  type Linked = Expect<AreEqual<typeof linked, { affectedRows: number }>>;
}

{
  model.records((records) => ({ $where: records.state.is("published") }));
  model.records((records) => ({ $where: records.state.isNot("draft") }));
  model.records((records) => ({ $where: records.state.is(null) }));
  model.records((records) => ({ $where: records.state.is.published }));
  // @ts-expect-error enum calls accept declared labels only
  model.records((records) => ({ $where: records.state.is("archived") }));
  // @ts-expect-error equality keeps the column value type
  model.users((users) => ({ $where: users.name.isNot(42) }));
  // @ts-expect-error legacy comparison names were removed
  model.users((users) => ({ $where: users.name.equals("Ada") }));
  // @ts-expect-error NULL checks are spelled is(null)
  model.users((users) => ({ $where: users.name.isNull() }));
}

{
  model.memberships.byId({ userId: 1, teamId: 2 });
  // @ts-expect-error a junction key needs both foreign keys
  model.memberships.byId(1);
  type MembershipRow = Expect<
    AreEqual<typeof model.memberships.$row, { userId: number; teamId: number }>
  >;
  model.users((users) => ({
    teams: users.teams((teams) => ({ title: teams.title })),
  }));
  // @ts-expect-error a junction's primary key is fixed to its foreign keys
  junction({ user: users, team: teams }).primaryKey((columns) => [
    columns.userId,
  ]);
  const plain = schema({
    users: { id: int.auto },
    teams: { id: int.auto },
    links: ({ users, teams }) => ({ user: users, team: teams }),
  });
  // @ts-expect-error without junction() there is no M:N relation
  plain.users((users) => ({ value: users.teams.count() }));
}
