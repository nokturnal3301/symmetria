// Compile-only API contracts: bun run test:types.
import { expectTypeOf } from "bun:test";
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
{
  // @ts-expect-error a nonunique field is not a lookup
  model.users.by.name("Ada");
  // @ts-expect-error partial indexes cannot identify arbitrary rows
  model.handles.by.partial("ada");
  // @ts-expect-error expression indexes are not plain unique keys
  model.handles.by.expression("ada");
  // @ts-expect-error composite keys require every field
  model.handles.by.identity({ tenant: "one" });
  // @ts-expect-error relation and scalar FK are mutually exclusive
  model.posts.insert({
    authorId: 1,
    author: { connect: 1 },
    slug: "one",
    title: "One",
  });
  // @ts-expect-error a required relation cannot be omitted
  model.posts.insert({
    slug: "one",
    title: "One",
    tags: { create: [{ label: "bun" }] },
  });
  model.posts.insert({
    // @ts-expect-error connect must use the referenced PK type or a unique selector
    author: { connect: "wrong" },
    slug: "one",
    title: "One",
  });
  model.posts.insert({
    // @ts-expect-error name is not a unique selector
    author: { connect: { name: "Ada" } },
    slug: "one",
    title: "One",
  });
}

{
  const input = {
    authorId: 1,
    slug: "one",
    title: "One",
    tags: { create: [{ label: "bun" }] },
  };
  const query = model.posts.insert(input);
  expectTypeOf(query).not.toHaveProperty("toSQL");
}
