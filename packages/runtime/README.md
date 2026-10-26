# Symmetria

A type-safe, SQL-first PostgreSQL query builder for Bun, with an embedded SQLite
driver. Declare schemas in TypeScript, compose immutable queries and infer the
exact result shape, including relationships and nullable joins.

**Bun 1.4.4+ · ESM · MIT**

[Core concepts](https://github.com/nokturnal3301/symmetria/blob/main/docs/guide.md)
explains shapes, relationships, nullability and bigint step by step.

## Install

```sh
bun add symmetria
bun add -d symmetria-kit
```

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

const users = table({ id: int.auto, name: text, email: text.unique });
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

## Create the tables

```ts
// symmetria.config.ts
import { defineMigrationConfig } from "symmetria-kit";
import { appSchema } from "./schema";

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
import { postgres } from "symmetria/driver";
import { appSchema } from "./schema";

const database = createDatabase({
  schema: appSchema,
  driver: postgres(process.env.DATABASE_URL!),
});

try {
  await database.users
    .insert({ name: "Ada", email: "ada@example.com" })
    .onConflict("email")
    .doNothing();

  const author = await database.users.by.email("ada@example.com").one();
  await database.posts.insert({ title: "Typed SQL", authorId: author.id });

  const authors = await database.users((user) => ({
    name: user.name,
    posts: user.posts((post) => ({
      title: post.title,
      views: post.views,
      $orderBy: post.createdAt.descending,
      $limit: 3,
    })),
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

Tables, relations, aliases and CTEs share one callable SELECT API. Ordinary keys
select fields; `$where`, `$orderBy`, `$groupBy`, `$having`, `$limit`, `$offset`,
`$distinct`, `$forUpdate` and `$forShare` control the query.

```ts
const feed = database.posts((post, { join }) => {
  const author = join(post.authorId);

  return {
    title: post.title,
    author: author.name,
    $orderBy: post.id.descending,
  };
});
const page = feed(() => ({ $limit: 10 }));
```

`join`, `innerJoin` and `leftJoin` infer the target and ON condition from a
relation or FK column. Smart `join` uses INNER for required forward references
and LEFT for optional/reverse relations. Repeated sources and self-JOINs receive
automatic aliases. Explicit sources use an ON callback; `crossJoin` creates a
Cartesian product. Controls-only calls preserve the previous selection; branches
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
and has no `$...` controls. Apply controls through the surrounding query or a
preceding relation call. It can be defined on an offline schema and used on its
connected or transaction-bound tables. To-one selections are typed as an object
or `null`.

Relations offer `count`, `exists`, `sum`, `average`, `minimum` and `maximum`:

```ts
const totals = database.users((user) => ({
  name: user.name,
  totalViews: user.posts.sum((post) => post.views),
  latestPost: user.posts.maximum((post) => post.createdAt),
  recentViews: user
    .posts((post) => ({
      $where: post.state.is.published,
      $orderBy: post.id.descending,
      $limit: 3,
    }))
    .sum((post) => post.views),
}));
```

Filters and pagination select input rows before aggregation. `sum` / `average`
return decimal strings or `null`; `minimum` / `maximum` preserve the
expression's value type and codec, plus `null`. Empty or all-NULL value inputs
produce `null`; `count()` returns `0` and `exists()` returns `false` for empty
inputs.

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
  .update((post) => ({ views: post.views.plus(1n) }))
  .where((post) => post.id.is(42))
  .returning((post) => ({ id: post.id, views: post.views }));

await database.users
  .insert({ name: "Ada Lovelace", email: "ada@example.com" })
  .onConflict("email")
  .doUpdate((user, excluded) => ({ email: user.email, name: excluded.name }));
```

UPDATE, WHERE and RETURNING callbacks receive the row directly, including
nested-insert RETURNING. Upserts receive the existing row first and the proposed
`excluded` row second. `.doUpdate("name")` copies a field from `excluded`.

## Capabilities

- Shape-first projections, explicit or FK-inferred JOINs, `some`/`none`/`every`.
- CRUD, bulk writes, upserts, unique-key lookups and atomic nested inserts.
- CTEs, recursive CTEs, window functions, aggregates and subqueries.
- Prepared queries, keyset pagination and `pages()` async iteration.
- Transactions, nested savepoints, isolation options and row locks.
- `Transaction<typeof database>` for schema-specific transaction helpers.
- `$scope()` filters for reads, updates and deletes, including related tables.
- Bigint, decimal-string, Date and custom codecs, including nested JSON results.
- Arrays, full-text search, typed JSON paths and Standard Schema JSON
  validation.
- Computed fields, branded IDs, indexes, primary keys and CHECK constraints.

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
`profiler.fetch(handler)` and expose the local endpoint with `profiler.serve()`.
Open it with `bunx --package symmetria-kit symmetria profile`.

## Drivers

Official drivers ship with `symmetria` and are maintained and released together:

```ts
import { createDatabase } from "symmetria";
import { postgres, sqlite } from "symmetria/driver";

const database = createDatabase({
  schema: appSchema,
  driver: postgres({ url: process.env.DATABASE_URL!, max: 10 }),
});
```

`symmetria` contains schemas and query APIs; `symmetria/driver` contains
connections and driver types. SQL dialect strategies live in
`symmetria/dialect`.

### SQLite

```ts
import { createDatabase } from "symmetria";
import { sqlite } from "symmetria/driver";
import { appSchema } from "./schema";

const driver = sqlite(":memory:");
driver.createTables(appSchema);
const database = createDatabase({ schema: appSchema, driver });

try {
  await database.users.insert({ name: "Ada", email: "ada@example.com" });
  console.log(
    await database.users((user) => ({ id: user.id, name: user.name })),
  );
} finally {
  await database.$close();
}
```

The SQLite driver uses `bun:sqlite` and supports common query operations,
relations, upserts, savepoints and cursor pages. PostgreSQL-specific features
have dialect limits: row locks are rejected; array contains/overlaps,
`searchRank()`, partial indexes, CHECK callbacks and Kit migrations are
unavailable. Bigint storage uses SQLite safe integers. `createTables` is an
explicit setup helper for SQLite, not a PostgreSQL migration operation.

## License

[MIT](https://opensource.org/license/mit).
