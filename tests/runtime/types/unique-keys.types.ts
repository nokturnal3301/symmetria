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
  one,
  many,
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

// A bigint key takes a safe integer, as writes and filters do.
{
  const events = table({
    id: bigint.auto,
    ref: bigint.unique.nullable,
    body: text,
    replies: many,
  });
  const replies = table({
    id: int.auto,
    event: one(events.replies),
    body: text,
  });
  const store = schema({ events, replies });

  expectTypeOf(await store.events.find(1)).toEqualTypeOf<{
    id: bigint;
    ref: bigint | null;
    body: string;
  } | null>();
  await store.events.get(1n);
  await store.events.byId(1).one();
  await store.events.by.ref(10).maybeOne();
  await store.events.find({ ref: 10 });
  await store.events.byId(1).update({ body: "edited" });
  await store.replies.insert({ body: "hi", event: { connect: 1 } });
  await store.replies.insert({ body: "hi", event: { connect: { id: 1 } } });
  // @ts-expect-error a bigint key is not text
  await store.events.find("1");
}

// onConflict() and upsert() take a unique index by the name by.<name> uses.
{
  model.handles
    .insert({ tenant: "team", handle: "ada", active: 1 })
    .onConflict("identity")
    .doUpdate("active");
  model.handles
    .insert({ tenant: "team", handle: "ada", active: 1 })
    .onConflict("tenant", "handle")
    .doNothing();
  model.handles
    .insert({ tenant: "team", handle: "ada", active: 1 })
    .returning("id")
    .onConflict("identity")
    .doNothing();
  model.handles.upsert(
    { tenant: "team", handle: "ada", active: 1 },
    { by: "identity" },
  );
  model.handles
    .insert({ tenant: "team", handle: "ada", active: 1 })
    // @ts-expect-error a partial index is not a key
    .onConflict("partial");
  model.handles
    .insert({ tenant: "team", handle: "ada", active: 1 })
    // @ts-expect-error an index name is the whole target, not one of its columns
    .onConflict("identity", "tenant");
  model.handles.upsert(
    { tenant: "team", handle: "ada", active: 1 },
    // @ts-expect-error not a key of the table
    { by: "nope" },
  );
  model.handles.upsert(
    { tenant: "team", handle: "ada", active: 1 },
    { by: ["tenant", "handle"] },
  );
  model.handles.upsert(
    { tenant: "team", handle: "ada", active: 1 },
    // @ts-expect-error a column that is part of no key
    { by: "active" },
  );
  model.handles
    .insert({ tenant: "team", handle: "ada", active: 1 })
    // @ts-expect-error a column that is part of no key
    .onConflict("active");
  model.users.upsert({ email: "a@b.c", name: "Ada" }, { by: "email" });
  model.users
    .insert({ email: "a@b.c", name: "Ada" })
    .onConflict("id")
    .doNothing();
  // @ts-expect-error name is not unique
  model.users.upsert({ email: "a@b.c", name: "Ada" }, { by: "name" });
}
