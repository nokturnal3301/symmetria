import { expect, expectTypeOf, test } from "bun:test";
import {
  junction,
  schema,
  table,
  int,
  text,
  bigint,
  timestamptz,
  index,
  sql,
  prepare,
  customType,
  numeric,
  jsonb,
  type CompiledQuery,
  tsvector,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";

const users = table({
  id: int.auto,
  email: text.unique,
  name: text,
  visits: bigint.default(9007199254740993n),
  createdAt: timestamptz.now,
});
const posts = table({
  id: int.auto,
  author: users,
  slug: text.unique,
  title: text,
});
const tags = table({ id: int.auto, label: text.unique }).checks((tags) => ({
  valid: tags.label.isNot("rejected"),
}));
const postTags = junction({ post: posts, tag: tags });
const handles = table({
  id: int.auto,
  tenant: text,
  handle: text,
  active: int,
}).indexes((handles) => ({
  identity: index(handles.tenant, handles.handle).unique,
  partial: index(handles.handle).unique.where(handles.active.is(1)),
  expression: index(sql<string>`lower(${handles.handle})`).unique,
}));
const amount = customType<{ cents: () => bigint }>("numeric(30, 0)", {
  encode: (value) => value.cents().toString(),
  decode: (value) => ({ cents: () => BigInt(String(value)) }),
});
const wallets = table({ id: int.auto, owner: users, amount: amount.unique });
const model = schema({ users, posts, tags, postTags, handles, wallets });

test("unique lookups infer plain and composite keys and preserve prepared parameters", () => {
  const lookup = model.users.by.email("ada")((users) => ({
    id: users.id,
    name: users.name,
  }));
  expect(lookup.toSQL().parameters).toEqual(["ada"]);
  expectTypeOf<Awaited<ReturnType<typeof lookup.execute>>>().toEqualTypeOf<
    { id: number; name: string }[]
  >();
  expect(
    model.handles.by.identity({ tenant: "one", handle: "ada" }).toSQL()
      .parameters,
  ).toEqual(["one", "ada"]);
  expect(Object.keys(model.handles.by)).toEqual(["identity"]);
  expect(
    prepare({ email: text }, (parameters) =>
      model.users.by.email(parameters.email),
    ).toSQL({ email: "ada" }).parameters,
  ).toEqual(["ada"]);
});

test("a key whose value is an array is looked up; a list given for a scalar key is refused", async () => {
  const calls: CompiledQuery[] = [];
  // A range as [from, to], a decimal as [units, scale]: the codec says what one value is.
  const span = customType<[number, number]>("int4range", {
    encode: ([from, to]) => `[${from},${to})`,
    decode: (value) =>
      String(value).slice(1, -1).split(",").map(Number) as [number, number],
  });
  const scaled = customType<[bigint, number]>("numeric", {
    encode: ([units, scale]) => `${units}e-${scale}`,
    decode: (value) => [BigInt(String(value)), 0],
  });
  const database = schema(
    {
      points: table({ at: vector(3).primaryKey, label: text }),
      bookings: table({
        id: int.auto,
        tenant: int,
        period: span.unique,
        price: scaled.unique,
        tags: text.array.unique,
        doc: jsonb<number[]>().unique,
        // Domains: over an array and over jsonb an array is one value, over
        // numeric, bigint or text it is not.
        pair: customType<number[]>("pair", { base: "integer[]" }).unique,
        list: customType<number[]>("list", { base: "jsonb" }).unique,
        amount: customType<string>("amount", { base: "numeric(30,10)" }).unique,
        serial: customType<bigint>("serial_no", { base: "bigint" }).unique,
        label: customType<string>("label", { base: "text" }).unique,
        words: tsvector.unique,
        code: text.unique,
        rate: numeric(10, 2).unique,
        visits: bigint.unique,
        seen: timestamptz.unique,
      }).indexes((booking) => ({
        slot: index(booking.tenant, booking.period).unique,
      })),
    },
    {
      executor: async (query) => {
        calls.push(query);

        return [];
      },
    },
  );
  const { points } = database;
  const bookings = database.bookings as unknown as {
    find: (key: unknown) => Promise<unknown>;
    get: (key: unknown) => Promise<unknown>;
    byId: (key: unknown) => { maybeOne: () => Promise<unknown> };
    by: Record<string, (key: unknown) => { maybeOne: () => Promise<unknown> }>;
  };
  const bound = async (read: () => Promise<unknown>) => {
    calls.length = 0;
    await read();

    return calls[0]!.parameters;
  };

  expect(await bound(() => points.find([1, 2, 3] as never))).toEqual([
    "[1,2,3]",
  ]);
  expect(await bound(() => points.byId([1, 2, 3] as never).maybeOne())).toEqual(
    ["[1,2,3]"],
  );

  for (const [key, value, parameter] of [
    ["period", [1, 5], "[1,5)"],
    ["price", [1250n, 2], "1250e-2"],
    ["tags", ["a", "b"], ["a", "b"]],
    ["doc", [1, 2], "[1,2]"],
    ["pair", [1, 2], [1, 2]],
    ["list", [1, 2], "[1,2]"],
  ] as const) {
    expect(await bound(() => bookings.find({ [key]: value }))).toEqual([
      parameter,
    ]);
    expect(await bound(() => bookings.by[key]!(value).maybeOne())).toEqual([
      parameter,
    ]);
  }

  expect(
    await bound(() =>
      bookings.by.slot!({ tenant: 2, period: [5, 9] }).maybeOne(),
    ),
  ).toEqual([2, "[5,9)"]);

  // A scalar key takes one value, as before.
  for (const [key, list] of [
    ["code", ["a", "b"]],
    ["rate", ["1.50"]],
    ["visits", [1n]],
    ["seen", [new Date(0)]],
    ["amount", ["1.5"]],
    ["serial", [1n]],
    ["label", ["a"]],
    // A builder the library itself makes with customType().
    ["words", ["'a'", "'b'"]],
  ] as const) {
    const refusal = `symmetria: unique key "${key}" takes one value, received an array`;

    await expect(bookings.find({ [key]: list })).rejects.toThrow(refusal);
    await expect(bookings.by[key]!(list).maybeOne()).rejects.toThrow(refusal);
  }

  await expect(bookings.get([1])).rejects.toThrow(
    'symmetria: primary key "id" takes one value, received an array',
  );
  await expect(bookings.byId([1, 2]).maybeOne()).rejects.toThrow(
    'symmetria: primary key "id" takes one value, received an array',
  );
  await expect(
    bookings.by.slot!({ tenant: [1, 2], period: [5, 9] }).maybeOne(),
  ).rejects.toThrow(
    'symmetria: unique key "tenant" takes one value, received an array',
  );
});
