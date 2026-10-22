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
} from "../../../packages/runtime/src";

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
