# Core concepts

[← Symmetria](../README.md) · [API reference](reference.md) ·
[Advanced recipes](advanced.md) · [Runnable examples](../examples/README.md)

Start here after [getting started](../README.md#get-started). This guide
explains the everyday choices: defining data, connecting, choosing a result
shape and following relationships. Apply your migrations before running
database-backed examples.

## 1. Describe data once, connect where needed

A schema describes tables and relationships. It can generate SQL without opening
a connection, so migrations can import it independently of your application.

```ts
// schema.ts
import { schema, table, int, text, bigint } from "symmetria";

const users = table({
  id: int.auto,
  name: text,
});

const posts = table({
  id: int.auto,
  title: text,
  author: users,
  editor: users.nullable.inverse("edited"),
  views: bigint.default(0n),
});

export const model = schema({ users, posts });
```

`author: users` declares a required foreign key. It gives a post an `authorId`
column and an `author` relationship. `editor` is optional, so `editorId` can be
`null`. The inverse name distinguishes a user's edited posts from authored
posts. Existing databases rarely follow one convention: `users.by("email")`
references a unique column instead of the primary key,
`users.column("created_by")` keeps a legacy column name, `.named("User")` sets
any table or column name, and `schema(…, { casing: "preserve" })` keeps
camelCase keys as SQL names, as databases created by Prisma use them.

```ts
// database.ts
import { createDatabase } from "symmetria";
import { postgres } from "symmetria/pg";
import { model } from "./schema.ts";

export const db = createDatabase({
  schema: model,
  driver: postgres({ url: process.env.DATABASE_URL!, max: 10 }),
});
```

Official drivers ship in the same package. `symmetria/driver` and `symmetria/pg`
use node-postgres (install `pg`); `symmetria/bun` uses Bun's native SQL pool.
`createDatabase` preserves the schema's types and scopes and reuses its
metadata. `await db.$close()` closes the supplied driver; database handles using
the same driver share its lifetime.

## 2. A shape describes the result

The projection selects result fields. A separate options object controls which
rows SQL returns and their order. Both callbacks receive the same typed source,
so you can filter or sort by fields without selecting them.

```ts
const query = db.posts(
  ({ title, views }) => ({
    title,
    views,
  }),
  {
    where: ({ views }) => views.above(10),
    orderBy: ({ id }) => id.descending,
    limit: 20,
  },
);

console.log(query.toSQL()); // SQL and bound parameters; no execution
const rows = await query; // { title: string; views: bigint }[]
```

Options accept values or synchronous callbacks. Each callback also receives SQL
tools as its second argument, for example `where: ({ views }, { and }) => ...`.
The projection only selects fields; everything that picks or orders rows lives
in the options object.

Queries are immutable. Building a query or calling `toSQL()` does not execute
it. `await query` and `query.execute()` both run it. Choose a terminal method to
express cardinality:

| Method             | Result                | What it checks                |
| ------------------ | --------------------- | ----------------------------- |
| `await query`      | Array, possibly empty | No cardinality restriction    |
| `query.first()`    | First row or `null`   | Requests at most one row      |
| `query.maybeOne()` | One row or `null`     | Rejects multiple rows         |
| `query.one()`      | One row               | Rejects zero or multiple rows |

Use an ordering when "first" must be predictable. For a primary-key lookup,
`await db.posts.byId(1).one()` selects the table's row and checks that it
exists.

## 3. Choose a flat field or a nested result

Most relationship queries start with one of these two forms.

### A related field in the current row

```ts
const cards = await db.posts(({ title, author, editor }) => ({
  title,
  authorName: author.name,
  editorName: editor.name,
}));
// { title: string; authorName: string; editorName: string | null }[]
```

The paths add SQL JOINs. The required author uses INNER JOIN; the optional
editor uses LEFT JOIN. A post without an editor remains in the result with
`editorName: null`.

INNER JOIN only returns matching rows. If a scope or PostgreSQL row-level
security hides the author, that post is omitted by the author JOIN. This is how
the returned `authorName` can remain a non-null `string`.

### An object or collection inside the current row

```ts
const articles = await db.posts(({ title, author }) => ({
  title,
  author: author(({ name }) => ({ name })),
}));
// { title: string; author: { name: string } | null }[]

const authors = await db.users(({ name, posts }) => ({
  name,
  posts: posts(({ title }) => ({ title }), {
    orderBy: ({ id }) => id.descending,
    limit: 3,
  }),
}));
// { name: string; posts: { title: string }[] }[]
```

Each query executes one SQL statement. The nested limit is **three posts per
user**. Users without posts get `[]`, and nested collections do not multiply the
outer rows. Each nested callback has its own filters, ordering and limit.

### Why a required author still has a nullable object

A required foreign key guarantees that a referenced row exists. A nested query
can still filter it out:

```ts
const filtered = await db.posts(({ title, author }) => ({
  title,
  author: author(({ name }) => ({ name }), {
    where: ({ name }) => name.is("Ada"),
  }),
}));
```

A post written by Grace remains in `filtered`, with `author: null`. Scopes and
row-level security can also hide related rows. Nested to-one types therefore
conservatively include `null`, even for required foreign keys.

| Shape                                            | Missing related result             | Effect on parent rows                |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------ |
| `post.author.name`                               | Required INNER JOIN finds no match | Parent is omitted                    |
| `post.editor.name`                               | `null`                             | LEFT JOIN retains the parent         |
| `post.author(author => ({ name: author.name }))` | `null`                             | Nested projection retains the parent |
| `user.posts(post => ({ title: post.title }))`    | `[]`                               | Nested projection retains the parent |

## 4. Use an explicit JOIN when its behavior matters

For example, to return only posts with a visible editor:

```ts
const edited = await db.posts((post, { innerJoin }) => {
  const editor = innerJoin(post.editorId);

  return { title: post.title, editorName: editor.name };
});
// { title: string; editorName: string }[]
```

`innerJoin` requires a match; `leftJoin` retains unmatched parents and makes
joined fields nullable. Both infer the target and ON condition from the foreign
key. The shorthand `join` chooses a kind from the relationship:

| Source for `join(...)`                        | Automatic choice |
| --------------------------------------------- | ---------------- |
| Required forward foreign key                  | INNER            |
| Optional forward foreign key                  | LEFT             |
| Reverse or many-to-many relationship          | LEFT             |
| A source reached through an optional ancestor | LEFT propagates  |

An INNER JOIN preserves each column's own nullability; a nullable column stays
nullable. Joining a collection can produce several rows per parent. Choose a
nested callback when you want an array instead. See
[JOIN details](reference.md#local-joins) for aliases, repeated sources and
custom ON conditions.

## 5. Write rows and group work in a transaction

Writes use scalar columns such as `authorId`. Shape callbacks select returned
fields:

```ts
await db.$transaction(async (transaction) => {
  const author = await transaction.users
    .insert({ name: "Ada" })
    .returning((user) => ({ id: user.id }));

  await transaction.posts.insert({
    title: "A first post",
    authorId: author.id,
    editorId: null,
    views: 0,
  });
});
```

A single-row insert with `returning` returns an object; a bulk insert returns an
array. Await every operation inside a transaction and use the supplied
transaction handle. Throwing rolls back the work. See
[writes](reference.md#insert-update-delete) and
[transactions](reference.md#transactions) for updates, conflicts and savepoints.

A mistake in the query itself, such as an unknown column, throws where the query
is built. A problem with the values, such as `null` for a required column or
`1.5` for an `int`, rejects the promise when the write runs, before anything is
sent, so `.catch()` and `try { await … }` handle request data in one place (see
[when errors surface](reference.md#when-errors-surface)).

## 6. Keep large values exact at the JSON boundary

Bigint writes and comparisons accept safe JavaScript integers: `views.above(10)`
and `{ views: 42 }` work. Schema defaults use bigint literals, such as
`bigint.default(0n)`. Use bigint literals for larger inputs too, such as
`9007199254740993n`. An unsafe integer `number` input rejects the query when it
runs.

Results remain JavaScript `bigint`; decimal `numeric()` values are strings. For
PostgreSQL integer-range values, `int` gives ordinary `number` results. Choose
the storage type for the domain rather than converting large results to `number`
and losing precision.

Arithmetic stays exact the same way, and its result type is what PostgreSQL
returns. `quantity.multiply(price)` and `quantity.divide(2)` are decimal strings
(division never drops the fraction); `quantity.quotient(2)` is the whole-number
part, a `number`. A fraction next to an integer column is written as text,
`quantity.multiply("1.5")`; `quantity.multiply(1.5)` rejects the query like
`1.5` written to an `int`. `real` and `doublePrecision` columns stay floats (see
[arithmetic](reference.md#arithmetic)).

JSON has no bigint type. A response can encode these values as decimal strings:

```ts
const body = JSON.stringify(rows, (_key, value) =>
  typeof value === "bigint" ? value.toString() : value,
);
const response = new Response(body, {
  headers: { "content-type": "application/json" },
});
```

Document those response fields as strings. Clients can opt into `BigInt(value)`
when they need exact arithmetic.

## 7. Search, vectors and relations without keys

The same shapes cover PostgreSQL features that usually need hand-written SQL.
`searchDocument()` builds a weighted full-text document from several columns;
`.search()`, `.searchRank()` and `.searchHeadline()` filter, order and
highlight. Declaring the same document with `index(...).using("gin")` makes the
index usable by the query. `vector(n)` from `symmetria/vector` stores pgvector
embeddings written as plain number arrays, with `cosineDistance()`,
`l2Distance()`, `innerProduct()` and `l1Distance()` for ordering and HNSW or
IVFFlat indexes.

Tables that relate through plain columns, without a foreign key, declare the
join predicate once:

```ts
const posts = table({ id: int.auto, title: text, authorName: text }).relations(
  (post, { to }) => ({
    author: to(users).one((user) => post.authorName.is(user.name)),
  }),
);
```

`post.author.name`, nested `post.author(...)` and `innerJoin(post.author)` then
work like any other relation; the to-one side is always optional because no key
guarantees a match. When several users share the name, `one()` takes the first
match by the target's primary key, so a post never appears twice. Nothing is
added to the database or to migrations.

Large results do not have to fit in memory:
`for await (const row of query.stream({ size: 1000 }))` reads through a
server-side cursor inside one transaction. `$transaction(fn, { retries: 3 })`
repeats the callback after serialization failures and deadlocks.
`Infer<typeof db.users>`, `InferInsert<typeof db.users>` and
`InferUpdate<typeof db.users>` name the row, insert and update types when a
function signature needs them.

## Where to go next

- [Runnable examples](../examples/README.md) for complete programs.
- [Reusable shapes](reference.md#reusable-projections) for shared projections.
- [Scopes](reference.md#scoped-databases) for tenant and visibility filters that
  also check every row a scoped write leaves behind.
- [Full-text search](reference.md#full-text-search),
  [vectors](reference.md#vectors-pgvector) and
  [relations without a foreign key](reference.md#relations-without-a-foreign-key).
- [Streaming rows](reference.md#streaming-rows) and
  [transactions](reference.md#transactions) with retries.
- [API reference](reference.md) for precise rules and advanced SQL.
- [Kit](../packages/kit/README.md) for migrations and interactive tools.

Application imports come from `symmetria`, `symmetria/bun` or `symmetria/pg`,
and `symmetria-kit`. `symmetria/driver` aliases the `pg` adapter;
`symmetria/internal` is the private integration bridge used by the matching Kit
release.
