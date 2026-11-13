# Symmetria

A type-safe, SQL-first PostgreSQL query builder for Node.js and Bun. The result
you describe in TypeScript becomes exactly one SQL statement, however deep the
nesting, typed to the field and as fast as hand-written SQL. Declare the schema
once; it drives queries, migrations, drift detection and `pull` for existing
databases.

**Node.js 24.11+ or Bun 1.4.4+ · ESM · MIT**

[Core concepts](https://github.com/nokturnal3301/symmetria/blob/main/docs/guide.md)
explains shapes, relationships, nullability and bigint step by step.

```ts
const authors = await db.users(
  ({ name, posts }) => ({
    name,
    posts: posts(
      ({ title, views }) => ({
        title,
        views,
      }),
      {
        orderBy: ({ id }) => id.descending,
        limit: 3,
      },
    ),
  }),
  { orderBy: ({ id }) => id.ascending, limit: 20 },
);
// { name: string; posts: { title: string; views: bigint }[] }[]
```

One SQL statement, three latest posts per author, exact types throughout.

## Install

```sh
bun add symmetria
bun add -d symmetria-kit
```

For Node.js: `npm install symmetria pg` and `npm install -D symmetria-kit`.
Import `postgres` from `symmetria/pg`; use `symmetria/bun` for Bun's native
pool.

The runtime provides schemas, queries, drivers and opt-in profiling.
[`symmetria-kit`](https://www.npmjs.com/package/symmetria-kit) provides
migrations, the `symmetria` command and interactive inspection. Use matching
package versions.

## Define a schema

```ts
// schema.ts
import {
  schema,
  table,
  int,
  text,
  bigint,
  oneOf,
  timestamptz,
} from "symmetria";

const users = table({
  id: int.auto,
  name: text,
  email: text.unique,
});

const posts = table({
  id: int.auto,
  title: text,
  author: users.index,
  views: bigint.default(0n),
  state: oneOf("draft", "published").default("draft"),
  createdAt: timestamptz.now,
});

export const appSchema = schema({ users, posts });
```

Each table can live in its own module. `author: users.index` declares a foreign
key, its index and the `posts.author` / `users.posts` relationships. Columns are
non-null by default. Property names map from camelCase to snake_case.
`users.by("email")` references a unique column instead of the primary key and
`users.column("created_by")` keeps a legacy column name. Tables that relate
through plain columns declare the join predicate instead:
`table({...}).relations((post, { to }) => ({ author: to(users).one((user) => post.authorName.is(user.name)) }))`
adds a relation without a foreign key. `numeric` and `varchar` work bare or with
arguments; schema mistakes name the table and column and explain the fix.

## Create the tables

```ts
// symmetria.config.ts
import { defineMigrationConfig } from "symmetria-kit";
import { appSchema } from "./schema.ts";

export default defineMigrationConfig({
  schema: appSchema,
  directory: "./migrations",
  databaseUrl: process.env.DATABASE_URL,
});
```

Set `DATABASE_URL` to a PostgreSQL connection URL, then generate and review the
migration before applying it:

```sh
bunx --package symmetria-kit symmetria generate initial
bunx --package symmetria-kit symmetria migrate
```

## Write and query

```ts
// main.ts — bun main.ts
import { createDatabase } from "symmetria";
import { postgres } from "symmetria/bun";
import { appSchema } from "./schema.ts";

const database = createDatabase({
  schema: appSchema,
  driver: postgres({ url: process.env.DATABASE_URL! }),
});

try {
  await database.users
    .insert({ name: "Ada", email: "ada@example.com" })
    .onConflict("email")
    .doNothing();

  const author = await database.users.by.email("ada@example.com").one();
  await database.posts.insert({ title: "Typed SQL", authorId: author.id });

  const authors = await database.users(({ name, posts }) => ({
    name,
    posts: posts(({ title, views }) => ({ title, views }), {
      orderBy: ({ id }) => id.descending,
      limit: 3,
    }),
  }));
  // { name: string; posts: { title: string; views: bigint }[] }[]

  console.log(authors);
} finally {
  await database.$close();
}
```

Nested collections load in one statement, with limits applied per parent. Empty
collections are `[]`; optional to-one selections are `null`. `await query` and
`.execute()` both execute; `.toSQL()` only compiles SQL and bound parameters.
Relation paths such as `posts.author.name` add the required JOINs.

## JOINs and composition

Tables, relations, aliases and CTEs share one callable SELECT API. The
projection selects fields; a separate options object accepts `where`, `orderBy`,
`groupBy`, `having`, `limit`, `offset`, `distinct`, `forUpdate` and `forShare`.
Each option can be a value or a synchronous callback receiving the same typed
source and SQL tools.

```ts
const feed = database.posts(
  ({ title, authorId }, { join }) => ({ title, author: join(authorId).name }),
  { orderBy: ({ id }) => id.descending },
);
const page = feed({ limit: 10 });
```

`join`, `innerJoin` and `leftJoin` infer the target and ON condition from a
relation or FK column. Smart `join` uses INNER for required forward references
and LEFT for optional/reverse relations. Repeated sources and self-JOINs receive
automatic aliases. Explicit sources use an ON callback; `crossJoin` creates a
Cartesian product. Options-only calls preserve the previous selection; branches
are immutable.

Smart JOINs also use LEFT for junction relations and propagate optional
ancestry. `crossJoin` can infer its target from an FK or relation, without an ON
condition. Explicit aliases must be unique within the query. Filters, ordering
and grouping append; new selected fields replace the projection and new
LIMIT/OFFSET replace previous counts. Fixed counts are validated integer
literals; explicit prepared count parameters remain bound placeholders.

## Reusable projections and aggregates

Reusable projections bind to each source occurrence, including aliases and
relations:

```ts
const userCard = database.users.shape((user) => ({ name: user.name }));
const feed = database.posts((post) => ({
  title: post.title,
  author: post.author(userCard),
}));
```

`.shape()` stores a synchronous callback and evaluates it on each application. A
projection belongs to its defining table, contains at least one selected field
and has no `$...` controls. Apply options at use sites, for example
`database.users(userCard, { limit: 20 })`. It can be defined on an offline
schema and used on its connected or transaction-bound tables. To-one selections
are typed as an object or `null`.

Relations offer `count`, `exists`, `sum`, `average`, `minimum` and `maximum`:

```ts
const totals = database.users(({ name, posts }) => ({
  name,
  totalViews: posts.sum.views,
  latestPost: posts.maximum.createdAt,
  recentViews: posts({
    where: ({ state }) => state.is.published,
    orderBy: ({ id }) => id.descending,
    limit: 3,
  }).sum.views,
  weightedViews: posts.sum((post) => post.views.multiply(2n)),
}));
```

Plain columns aggregate through properties (`posts.sum.views`); expressions use
the callback form. Filters and pagination select input rows before aggregation.
`sum` / `average` return decimal strings or `null`; `minimum` / `maximum`
preserve the column's value type and codec, plus `null`, and order JSON values
as jsonb does (numbers numerically), booleans, `uuid` and `bytea` too. Empty or
all-NULL value inputs produce `null`; `count()` returns `0` and `exists()`
returns `false` for empty inputs.

## Enum mappings

```ts
const labels = database.posts((post) => ({
  title: post.title,
  status: post.state.match({ draft: "Draft", published: "Published" }),
  visibleViews: post.state.match({ draft: 0n, published: post.views }),
}));
```

`.match()` emits SQL CASE with exactly one branch per enum member. Branches
accept scalar literals or compatible SQL expressions. Nullable inputs produce
`null`; bigint, Date and expression codecs survive nested results, aliases and
CTEs.

## Write callbacks

```ts
const updated = await database.posts
  .byId(42)
  .update((post) => ({ views: post.views.plus(1n) }))
  .returning((post) => ({ id: post.id, views: post.views }));

const userCard = database.users.shape(({ id, name }) => ({ id, name }));
await database.users.by
  .email("ada@example.com")
  .update({ name: "Ada Lovelace" })
  .returning(userCard);

await database.users
  .insert({ name: "Ada Lovelace", email: "ada@example.com" })
  .onConflict("email")
  .doUpdate((user, excluded) => ({ email: user.email, name: excluded.name }));

await database.posts.update({ state: "draft" }).all(); // whole table, spelled out
```

`byId()` and `.by.<key>()` lookups update and delete directly, in one statement.
`returning()` accepts a callback or a row-local reusable projection of the same
table. UPDATE, WHERE and RETURNING callbacks receive the row directly, including
nested-insert RETURNING. Upserts receive the existing row first and the proposed
`excluded` row second. `.doUpdate("name")` copies a field from `excluded`. An
UPDATE or DELETE without `where()` is refused unless `.all()` confirms it.

## Capabilities

- Shape-first projections, explicit or FK-inferred JOINs, `some`/`none`/`every`.
- CRUD, bulk writes, upserts, unique-key lookups with direct writes, reusable
  RETURNING projections and atomic nested inserts.
- CTEs, recursive CTEs, window functions, aggregates and subqueries.
- Callable prepared queries with `one` / `maybeOne` / `first` / `count` /
  `exists` / `inspect`, keyset pagination in both directions and `pages()` async
  iteration; `count()` and `exists()` on any table or filtered source.
- Transactions, nested savepoints, isolation options and row locks.
- `Transaction<typeof database>` for schema-specific transaction helpers.
- `$scope()` filters for reads, updates and deletes, including related tables,
  and checks every row a scoped insert, upsert or update writes, like row-level
  security's `WITH CHECK` (`SYMMETRIA_OUT_OF_SCOPE`); reused and prepared
  queries bind the current tenant at every execution.
- Bigint, decimal-string, Date and custom codecs, including nested JSON results;
  `smallint`, `real`, `doublePrecision`, `date`, `time`, `interval`, `bytea` and
  `inet` as first-class builders.
- Conditional upserts: `doUpdate(values, { where: (current, incoming) => … })`.
- Any SQL names: `casing: "preserve"` for camelCase databases such as Prisma's,
  `.named()` on tables and columns, `.onUpdate.cascade` foreign keys and
  `timestamp(3)` columns read as UTC dates; enum types named and shared with
  `oneOf(...).typeName("Role")`, collations with `text.collate("C")`,
  `int.auto.byDefault` identities that also accept explicit ids, and derived
  names over 63 bytes shortened with a hash.
- Exact arithmetic typed as PostgreSQL computes it: `quantity.multiply(price)`
  and `quantity.divide(2)` are `Decimal` (division never truncates),
  `quantity.quotient(2)` is integer division, `real` columns stay floats.
- `databaseError(error)` describes unique, foreign-key, not-null and check
  violations and lost connections the same way on both drivers; `one()` errors
  carry a code. Invalid values (out-of-range numbers, invalid `jsonb(schema)`
  input, `null` for NOT NULL columns) reject the query's promise when it runs;
  mistakes in the query's shape throw where it is built.
- Arrays, full-text search with stored `tsvector` columns, weighted documents,
  ranking and headlines, pgvector embeddings with distance operators and HNSW
  indexes (`symmetria/vector`), typed JSON paths and Standard Schema JSON
  validation.
- Computed fields, branded IDs, indexes, primary keys and CHECK constraints.
- Condition relations (`.relations()`) that join by a predicate without a
  foreign key, in both directions, invisible to migrations.
- `stream()` server-side cursors, `$transaction` retries after serialization
  failures and deadlocks, `Infer` / `InferInsert` / `InferUpdate` / `InferShape`
  type aliases, predicate lists that skip `undefined`, `null` and `false`, and
  "did you mean" hints for unknown columns and relations.

`count()` and ranking functions return `number`; PostgreSQL `bigint` columns
decode to `bigint`, and `numeric()` values retain decimal precision as strings.
Single-object `insert().returning()` returns one row; bulk inserts return
arrays.

## Inspect and profile

```ts
await query.inspect(); // Requires symmetria-kit for the terminal UI.

const report = await query.inspect({ interactive: false });
console.log(report.sql, report.parameters); // Works with the runtime alone.
```

The interactive inspector offers SQL, Parameters, Results and Explain tabs.
`createProfiler()` adds opt-in request traces with build, compile, database and
decode timings. Pass it to `postgres({ url, profiler })`, wrap requests with
`profiler.fetch(handler)` and expose the local endpoint with
`await profiler.serve()`. Every request to it carries a token; set
`SYMMETRIA_PROFILE_TOKEN` for the application and the CLI, then open
`bunx --package symmetria-kit symmetria profile`.

## Drivers

Official drivers ship with `symmetria` and are maintained and released together:

```ts
import { createDatabase } from "symmetria";
import { postgres } from "symmetria/pg";

const database = createDatabase({
  schema: appSchema,
  driver: postgres({ url: process.env.DATABASE_URL!, max: 10 }),
});
```

`symmetria/driver` re-exports `symmetria/pg`. Install `pg` when using either
(Symmetria declares the pool options itself, so `@types/pg` is not needed);
`symmetria/bun` needs no external database driver. Each accepts a URL or its
underlying pool options plus `url` and `profiler`.

Both adapters return `{ rows, affectedRows }`, read values the same way,
preserve bigint/numeric precision, support nested transactions and pinned
sessions, and drain accepted operations on close. Operations on a transaction or
session run one at a time in call order. Session settings belong to a
connection: use `driver.session()` for multi-statement workflows; its connection
is closed afterwards, so its settings, locks and temporary tables never reach
other queries. For isolated PostgreSQL test schemas, use `testDatabase()` from
`symmetria-kit/testing`, optionally passing a `driver` factory.

Behind a transaction-mode pooler such as PgBouncer, queries, transactions,
streams and prepared queries work on both adapters; pass `prepare: false` to
`symmetria/bun` unless the pooler tracks named statements (PgBouncer 1.21+ with
`max_prepared_statements`), and set `search_path` on the role rather than in the
URL. `driver.session()` cannot pin a server connection there. See
[transaction pooling](https://github.com/nokturnal3301/symmetria/blob/main/docs/reference.md#transaction-pooling-pgbouncer).

## License

[MIT](https://opensource.org/license/mit).
