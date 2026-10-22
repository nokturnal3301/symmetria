# API reference

[← Symmetria](../README.md) · [Core concepts](guide.md) ·
[Advanced recipes](advanced.md) · [Runnable examples](../examples/README.md)

Query syntax, type guarantees, supported databases and execution behavior. For
installation and a first query, start with the
[quick start](../README.md#quick-start). For result shapes, relationships,
nullability and bigint, read [Core concepts](guide.md).

- [Schema and connection](#schema-and-connection)
- [SELECT, JOINs and relations](#select)
- [Shape-first queries](#shape-first-queries)
- [Reusable projections](#reusable-projections) and
  [enum mappings](#enum-mappings)
- [Query inspector](#query-inspector) and
  [live profiler](#live-request-profiler)
- [Prepared queries](#prepared-queries)
- [Writes](#insert-update-delete), [unique lookups](#unique-key-lookups) and
  [nested inserts](#atomic-nested-inserts)
- [CTEs and windows](#ctes-and-window-functions),
  [aggregates and subqueries](#aggregates-and-subqueries)
- [Nested relations](#nested-relations) and [value codecs](#values-and-drivers)
- [Relation aggregates](#relation-aggregates) and [cursor pages](#cursor-pages)
- [Arrays and full-text search](#arrays-and-full-text-search)
- [Scoped databases](#scoped-databases) and [SQLite](#sqlite-driver)
- [Computed fields, enums and JSON](#computed-fields-enums-and-json)
- [Indexes](#indexes),
  [primary keys and checks](#primary-keys-and-check-constraints)
- [Transactions](#transactions) and [migrations](#migrations)

## Schema and connection

```ts
import {
  schema,
  table,
  junction,
  createDatabase,
  int,
  text,
  bigint,
  bool,
  oneOf,
  timestamptz,
} from "symmetria";
import { postgres } from "symmetria/driver";

// Each declaration can live in its own module.
const users = table({
  id: int.auto,
  name: text.unique,
  active: bool.default(true),
});

const posts = table({
  id: int.auto,
  title: text,
  author: users.index,
  editor: users.nullable.inverse("edited"),
  views: bigint.default(0n),
  state: oneOf("draft", "published").default("draft"),
  createdAt: timestamptz.now,
});
const tags = table({ id: int.auto, label: text.unique });
const postTags = junction({ post: posts, tag: tags });

export const appSchema = schema({ users, posts, tags, postTags });
export const database = createDatabase({
  schema: appSchema,
  driver: postgres(process.env.DATABASE_URL!),
});
```

Names come from object keys; camelCase maps to snake_case. Columns are non-null
by default. `author: users` creates `authorId` and the `author` relationship;
`users.unique` represents 1:1. `junction({ post: posts, tag: tags })` declares a
many-to-many link table: both foreign keys form its primary key and each side
gains an M:N relation. `.inverse("edited")` resolves ambiguous reverse names.

`appSchema` is an offline, reusable registry.
`createDatabase({ schema, driver })` binds it to a connection, reusing its
resolved metadata, codecs and scopes without rerunning declaration callbacks.
Pass pool options to `postgres({ url, max: 10 })`. Each returned database
retains its own executor and transaction contexts. Closing it closes that
driver's pool; handles sharing a driver also share its lifetime.

Official drivers are maintained and versioned with the `symmetria` package:
`postgres` and `sqlite` are imported from `symmetria/driver`. Schemas and query
APIs, including `createDatabase`, come from `symmetria`. The `symmetria/dialect`
entry exposes low-level SQL strategies.

Keyed callbacks also work:
`posts: ({ users }) => table({ author: users, ... })`. Use them for cycles or to
distinguish reference targets with identical structural types. Branded PKs also
distinguish otherwise identical table declarations. An imported table must be
included in the final registry; one declaration reused under several keys needs
a keyed reference to identify the intended target.

Schema declaration creates metadata and query builders. Apply
[migrations](#migrations) to create the database tables;
[`examples`](../examples/README.md) generates its migrations into
`.symmetria-examples/` and includes an idempotent seed. `int.auto` is
`GENERATED ALWAYS AS IDENTITY`; generated identities are omitted from writes.
`uuid.v4` works on PostgreSQL 14; `uuid.v7` needs PostgreSQL 18+.

## SELECT

Callable tables autocomplete columns and infer the exact result:

```ts
await database.users((user) => ({ id: user.id, name: user.name }));
await database.users.byId(42).one();
await database.users
  .byId(42)((user) => ({ name: user.name }))
  .maybeOne();
```

`byId()` starts a query on a table's primary key and selects all its columns,
including computed fields. It accepts the key's value type, including branded
values and prepared parameters. A key named `code` works the same way as `id`;
composite keys take an object with all key fields, for example
`memberships.byId({ tenantId: 1, userId: 42 })`. Keyless tables have no typed
`byId()`. It composes with shape callbacks and terminal query methods.

Every SELECT uses a shape callback. Local JOINs return typed source handles:

```ts
const query = database.posts((post, { join }) => {
  const author = join(post.authorId);
  const editor = join(post.editorId);

  return {
    title: post.title,
    authorName: author.name,
    editorName: editor.name,
    $where: post.views.above(10n),
    $orderBy: post.createdAt.descending,
    $limit: 20,
  };
});

query.toSQL(); // { sql, parameters }; filters use $1, $2, …; fixed LIMIT is literal
const rows = await query.execute();
// { title: string; authorName: string; editorName: string | null }[]
```

JOIN returns a handle for use in the current callback. LEFT JOIN makes joined
fields nullable; INNER JOIN preserves each column's declared nullability.
Queries are immutable and thenable: `await query` runs it, as does `.execute()`.
`first()` returns one row or `null`.

`join(reference)` chooses INNER for required forward FKs, and LEFT for nullable
FKs, reverse relations and junction relations. LEFT propagates through optional
ancestors. `innerJoin(reference)` and `leftJoin(reference)` set the kind
explicitly. Relations and direct FK columns infer the target and ON condition.
Repeated sources receive automatic aliases; `.as("reviewer")` assigns an
explicit name. Ordinary JOINs retain SQL row multiplication.

`one()` requires exactly one result; `maybeOne()` allows zero or one and
resolves to `null` when nothing matches. Both reject multiple results, fetching
at most two rows while respecting an existing LIMIT.

Explicit and multi-hop JOINs use the same handles:

```ts
database.posts((post, { innerJoin, join }) => {
  const reviewer = innerJoin(database.users.as("reviewer"), (user) =>
    post.editorId.is(user.id),
  );
  const writer = join(post.author);
  const otherPost = join(writer.posts);

  return {
    title: post.title,
    reviewer: reviewer.name,
    otherTitle: otherPost.title,
  };
});
```

Also supported: `crossJoin`, `$distinct`, `$groupBy`, `$having`, `$offset`,
`ascending.nullsLast`, `is` / `isNot` (equality; `is(null)` compiles to
`IS NULL`), ordering comparisons, `in` / `notIn`, `between`, `like` / `ilike`,
`isDistinctFrom`, and `and` / `or` / `not`.

### Shape-first queries

Tables, aliases, relations, derived tables and CTEs are callable. The first
callback argument is the source's columns; ordinary object keys describe the
result, and `$` keys control the query:

```ts
const feed = database.users((user) => {
  const published = user.posts((post) => ({ $where: post.state.is.published }));

  return {
    name: user.name,
    publications: published.count(),
    posts: published((post) => ({
      title: post.title,
      editor: post.editor(({ name }) => ({ name })),
      tags: post.tags(({ label }) => ({ label })),

      $orderBy: [post.createdAt.descending, post.id.descending],
      $limit: 3,
    })),

    $where: published.some(),
    $orderBy: user.id.ascending,
    $limit: 20,
  };
});

await feed;
```

Each nested limit applies per parent. To-many relations produce arrays
(including `[]`); to-one selections produce an object or `null`, with
conservatively nullable types even for required relations. Automatic paths such
as `post.editor.name` retain their existing JOIN behavior and scalar
nullability.

| Control                   | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `$where`, `$having`       | Predicate or array of predicates combined with `AND`; use `or(...)` for alternatives |
| `$orderBy`                | One ordering expression or a nonempty array                                          |
| `$groupBy`                | Nonempty array of SQL expressions                                                    |
| `$limit`, `$offset`       | Nonnegative safe integer or prepared number parameter                                |
| `$distinct`               | Boolean; replaces the DISTINCT flag when supplied                                    |
| `$forUpdate`, `$forShare` | `true` or `{ of?, noWait?, skipLocked? }`; `false`/`undefined` omit the request      |

Controls with `undefined` values are ignored. Empty predicate arrays add no
restriction. Unknown `$` keys are errors, and controls never become result
fields. A controls-only shape preserves any previous projection. An unselected
query cannot execute until fields are selected. An empty shape is rejected
unless its callback added JOINs. Nested ordinary objects only change the result
structure; they do not imply SQL grouping.

Fixed numeric LIMIT/OFFSET counts compile as validated integer literals.
Explicit prepared count parameters remain placeholders and are validated when
bound. This lets PostgreSQL cost fixed pagination with the actual counts,
including generic plans.

For row-lock controls, PostgreSQL emits the requested lock; SQLite rejects them
at compilation. Choose one lock mode and one of `noWait` / `skipLocked`. `of`
names must identify sources in the query, including aliases introduced by local
JOINs.

#### Local JOINs

The second argument supplies `join`, `innerJoin`, `leftJoin` and `crossJoin`.
**`join(reference)` is the smart JOIN**: INNER for required forward foreign
keys, LEFT for optional/reverse/junction relations, propagating LEFT through
optional ancestors. Both SQL and handle types reflect that choice.

A relation or direct FK column supplies its ON condition from the schema.
Explicit `innerJoin` and `leftJoin` also accept a table, alias or CTE with an ON
callback receiving the joined source's columns. `crossJoin(source)` also accepts
a relationship or FK column to infer the target, but always produces a Cartesian
product without ON:

```ts
database.posts((post, { join, leftJoin }) => {
  const author = join(post.authorId);
  const editor = leftJoin(database.users.as("reviewer"), (user) => [
    user.id.is(post.editorId),
    user.active.is(true),
  ]);

  return {
    title: post.title,
    author: author.name,
    editor: editor.name,

    $where: post.state.is.published,
  };
});
```

Here `active` stays in `ON`, so a post without an active editor remains in the
result with `editor: null`. LEFT JOIN handles make every joined column nullable;
INNER JOIN preserves column nullability. Handles can be captured by later JOIN
callbacks. Repeated sources and self-JOINs get deterministic automatic aliases:

```ts
database.users((user, { join }) => {
  const manager = join(user.managerId);
  const director = join(manager.managerId);

  return { name: user.name, manager: manager.name, director: director.name };
});
```

Here the schema declares a `manager` self-reference. A nullable manager makes
both joined names nullable. Explicit `.as(...)` names must be unique within a
query. Ordinary scalar columns, arithmetic expressions and projected CTE fields
do not carry FK provenance and cannot infer a JOIN target.

`innerJoin(user.posts)` multiplies rows as an ordinary SQL JOIN;
`posts: user.posts(...)` builds a nested array. Filtered relation builders
remain callable for nested results; JOIN helpers accept unfiltered references.
Local helpers are valid only during their own synchronous shape callback. Their
handles belong to that query; duplicate explicit aliases and foreign bindings
are rejected.

#### Reusable projections

```ts
const userCard = database.users.shape((user) => ({
  name: user.name,
  posts: user.posts.count(),
}));

database.posts((post) => ({
  title: post.title,
  author: post.author(userCard),
  editor: post.editor(userCard),
}));
database.users.as("member")(userCard);
```

Definition stores the callback without evaluating it. Each use evaluates against
the current row and its local JOIN tools, preserving nested relations, codecs
and nullable to-one results. A projection belongs to its defining table and
contains one or more ordinary fields; apply `$...` controls in the surrounding
query or a preceding controls-only relation call. Projections do not capture a
connection.

For example, define a projection on the offline registry, then use it on a
connected database, an alias or the corresponding relation:

```ts
const postCard = appSchema.posts.shape((post) => ({
  title: post.title,
  status: post.state.match({ draft: "Draft", published: "Published" }),
}));

database.users((user) => ({
  name: user.name,
  recent: user.posts((post) => ({
    $where: post.state.is.published,
    $orderBy: [post.createdAt.descending, post.id.descending],
    $limit: 3,
  }))(postCard),
}));
database.posts(postCard)((post) => ({ $where: post.views.above(0n) }));
```

Keep reusable callbacks synchronous and derive expressions from their row and
local tools. The application supplies the current executor, transaction and
scopes.

#### Enum mappings

For a column declared with `oneOf("draft", "published")`:

```ts
database.posts((post) => ({
  status: post.state.match({ draft: "Draft", published: "Published" }),
  visibleViews: post.state.match({ draft: 0n, published: post.views }),
}));
```

`match` emits SQL CASE. Every enum member is required and extra keys are
rejected. Branches accept scalar literals or compatible SQL expressions;
expression branches must share a SQL storage type. Bigint, Date and expression
codecs survive aliases, CTEs and nested JSON. NULL inputs produce NULL; nullable
branch values also remain nullable. Literal values remain bound parameters. Only
finite enum columns expose `.match()`; ordinary `text` columns do not.

#### SQL expression helpers

All public SQL expression helpers are available in the second argument, with
their original types. They also remain available as named imports:

| Category                | Helpers                                                     |
| ----------------------- | ----------------------------------------------------------- |
| Predicates              | `and`, `or`, `not`, `when`, `exists`, `notExists`           |
| Aggregates and fallback | `count`, `sum`, `average`, `minimum`, `maximum`, `coalesce` |
| Windows                 | `rowNumber`, `rank`, `denseRank`, `lag`, `lead`, `over`     |
| SQL template            | `sql`                                                       |
| Local narrowing         | `whereNotNull`                                              |

```ts
database.posts((post, { join, count, sum }) => {
  const author = join(post.author);
  const publications = count();

  return {
    author: author.name,
    publications,
    views: sum(post.views),

    $where: post.state.is.published,
    $groupBy: [author.name],
    $having: publications.above(2),
    $orderBy: publications.descending,
  };
});
```

`whereNotNull(column)` adds `IS NOT NULL` to the current query and returns a
non-null typed expression. Select or reuse that returned expression:

```ts
database.posts((post, { whereNotNull }) => ({
  editorId: whereNotNull(post.editorId), // number, not number | null
}));
```

This narrows the returned expression; existing handles retain their types. Like
the JOIN helpers, `whereNotNull` is construction-local. Pure expression helpers
can be reused in ordinary functions and nested callbacks.

#### Nested SELECTs and CTEs

An arbitrary selected query in a result field also produces an array, in the
same SQL statement. JavaScript closures express correlation:

```ts
const ranked = database
  .posts((post, { rowNumber }) => ({
    authorId: post.authorId,
    title: post.title,
    position: rowNumber().over({
      partitionBy: [post.authorId],
      orderBy: [post.views.descending, post.id.ascending],
    }),
  }))
  .cte("ranked_posts");

database.users((user) => ({
  name: user.name,
  best: ranked((post) => ({
    title: post.title,
    position: post.position,

    $where: [post.authorId.is(user.id), post.position.atMost(3)],
    $orderBy: post.position.ascending,
  })),
}));
```

`rowNumber()` returns `number`. Bigints, timestamps and JSON values retain their
codecs through nested results and CTEs. Nested sources can reuse an outer
source's name: separate identities and automatic SQL aliases preserve
correlation.

Callbacks build the query immediately and must return synchronously. Execution
is deferred until `await`, `.execute()` or a terminal operation such as
`.one()`. `.toSQL()` only compiles. Shapes use the existing compiler, prepared
parameters, transactions, `$scope()` predicates and profiler, without a build
plugin.

Compose queries by calling them again. Controls-only calls preserve the selected
fields; supplying ordinary fields replaces the projection. Filters, ordering and
grouping append, while LIMIT/OFFSET replace their previous values when supplied:

```ts
const published = database.posts((post) => ({
  $where: post.state.is.published,
}));
const titles = published((post) => ({ title: post.title }));
const recent = titles((post) => ({ $orderBy: post.id.descending, $limit: 10 }));
```

Each branch is immutable. Callbacks receive the root source directly (`post`);
local JOINs are accessed through their handles inside the callback.

The selected query retains `.as()`, `.cte()`, `.recursive()`, `.prepare()`,
`.inspect()`, `.first()`, `.one()`, `.maybeOne()`, `.page()` and `.pages()`. An
object selection containing exactly one scalar expression supports `.scalar()`
and column `.in(query)` / `.notIn(query)`. For example,
`database.posts(post => ({ id: post.id, $limit: 1 })).scalar()` is a typed
nullable scalar subquery. Pagination and recursive CTEs keep their existing SQL
restrictions. Write/transaction APIs remain methods on the callable table and
database; SELECT controls describe the read plan.

See [`examples/shapes.ts`](../examples/shapes.ts) for reusable projections, enum
mappings, relation aggregates, explicit JOINs and multi-CTE analytics.

Read callbacks receive the root row first and SQL/JOIN tools second. Write
callbacks receive the row directly; upserts receive `(row, excluded)`. Schema
declaration callbacks such as `posts: ({ users }) => ...` receive table
references rather than query rows.

### Shape the result directly

```ts
database.posts((post, { join }) => {
  const author = join(post.authorId);

  return {
    title: post.title,
    author: { id: author.id, name: author.name },
  };
});
// { title: string; author: { id: number; name: string } }[]
```

Object keys replace `.as(...)`; nested objects compile to PostgreSQL JSON
builders with codec-aware decoding, including lossless bigint. Terminal
projections can use JSON; intermediate expressions and
equality/grouping-sensitive queries retain JSONB. LEFT-joined objects retain
their shape with nullable fields. Object projections also work in RETURNING,
prepared queries and derived tables.

### Follow relations directly

```ts
database.posts((posts) => ({
  title: posts.title,
  author: posts.author.name,
  editor: posts.editor.name, // string | null
}));

// With users.country declared, paths can continue through multiple tables:
database.posts((posts) => ({
  country: posts.author.country.name,
}));
```

Accessing a to-one relation field adds a JOIN automatically. Required forward
FKs use INNER; nullable FKs and reverse one-to-one relations use LEFT, including
optional ancestors. The same path is reused across SELECT, WHERE, ORDER BY,
GROUP BY and HAVING, and can reuse an existing explicit relation JOIN. Each
query branch remains immutable. `.toSQL()` exposes every generated JOIN.
Explicit JOIN `ON` callbacks reference columns of their declared table aliases.

To-many relations expose collection operations instead of scalar fields:

```ts
database.users((user) => ({
  name: user.name,
  posts: user.posts((post) => ({
    title: post.title,
    editor: post.editor((editor) => ({ name: editor.name })),
    $where: post.views.above(0n),
    $orderBy: post.createdAt.descending,
    $limit: 3,
  })),
}));
// { name: string; posts: { title: string; editor: { name: string } | null }[] }[]
```

Collections compile to correlated JSON aggregation in **one statement**, with
LIMIT/OFFSET applied per parent. They can contain further relation collections,
including many-to-many and self relations. Empty collections are `[]`; a to-one
shape returns an object or `null`. Use `$orderBy` for deterministic array
ordering. Bigint, numeric, dates and custom codecs decode recursively.
Parameters in filters and LIMIT/OFFSET work with `prepare()`.

Method names (`count`, `exists`, `as`, etc.) belong to the relation API. If a
related table has a column with such a name, access it inside its shape
callback, where row fields retain their normal names.

### Filter related rows

```ts
database.users((user) => ({
  name: user.name,
  $where: user.posts.some((post) => post.views.above(0n)),
}));

database.users((user) => ({
  name: user.name,
  $where: user.posts.none((post) => post.title.is("Untitled")),
}));

database.users((user) => ({
  name: user.name,
  $where: user.posts.every((post) => post.editorId.isNot(null)),
}));
```

`some` uses EXISTS; `none` and `every` use NOT EXISTS. `some()` / `none()` also
accept no predicate. For an empty relation, `some` is false and `none` / `every`
are true. `every` treats SQL NULL as a failed predicate (`IS NOT TRUE`). Filters
can nest and follow to-one paths. Quantifiers apply before LIMIT/OFFSET;
paginated collections still support shape callbacks, aggregates and `.exists()`,
with pagination included in their result.

### Conditional filters and narrowing

```ts
query((posts) => ({
  $where: and(
    when(search, (search) => posts.title.ilike(`%${search}%`)),
    when(authorId, (authorId) => posts.authorId.is(authorId)),
  ),
}));

database.posts((post, { whereNotNull }) => ({
  editorId: whereNotNull(post.editorId), // number, not number | null
}));
```

Import `and` and `when` from `symmetria`. `when` skips only null/undefined;
zero, false and empty strings are values. Empty AND is TRUE; empty OR is FALSE.
`whereNotNull()` adds a predicate and returns a narrowed expression.

### Cursor pages

```ts
const pageQuery = database.posts((post) => ({
  title: post.title,
  $orderBy: [post.createdAt.descending, post.id.descending],
}));

const firstPage = await pageQuery.page({ size: 20 });
const nextPage = await pageQuery.page({
  size: 20,
  after: firstPage.nextCursor,
});
// { items: { title: string }[]; nextCursor: PageCursor<...> | null }
```

`pages()` iterates until the cursor runs out:

```ts
for await (const page of pageQuery.pages({ size: 500 })) {
  await archive(page.items);
}
```

Pages use keyset comparisons and fetch one extra row. ORDER BY must use root
columns and include a full PK or a non-null unique column. Both directions and
NULLS FIRST/LAST work; ordering keys can be omitted from the projection. Cursor
values preserve PostgreSQL timestamp microseconds and storage precision. Cursors
are checked against the query, its parameters and ordering. The initial API
covers root-table queries without joins, grouping, DISTINCT, LIMIT or OFFSET.
Pass a non-null next cursor to continue; null marks the last page.

## Query inspector

```ts
await query.inspect();
```

In a terminal this opens a stationary **SQL / Parameters / Results / Explain**
browser in the blue–purple–pink theme. It starts on SQL; Results executes the
query on first visit, and Explain requests an estimated PostgreSQL plan. Results
and plans are cached while browsing.

- `←` / `→`, Tab or `1`–`4`: switch tabs.
- `↑` / `↓`, Page Up/Down, Home/End: navigate.
- Results: `h` / `l` scroll columns; Enter expands the selected row, including
  nested collections, bigint and dates. `r` executes the query again.
- Explain: Enter toggles the plan tree / JSON; `a` runs `EXPLAIN ANALYZE` with
  buffers and actual timings; `r` refreshes the estimated plan.
- Esc, `q` or Ctrl+C closes the browser and restores the terminal. An already
  running request finishes before `inspect()` resolves, preserving transaction
  scope.

The SQL and Parameters tabs work offline. Execution uses the query's original
parameters, LIMIT/OFFSET, codecs and transaction. The inspector loads lazily
when called. `NO_COLOR` disables colors; narrow terminals and resizing are
supported.

Without a terminal, `inspect()` returns a structured report. The same report can
be requested explicitly for scripts:

```ts
const report = await query.inspect({
  interactive: false,
  execute: true,
  explain: true, // use "analyze" for actual execution statistics
});
report.sql;
report.parameters;
report.compileMs;
report.results?.rows; // same exact row type as query.execute()
report.results?.durationMs; // execution + decoding
report.explanation?.plan; // PostgreSQL JSON plan
```

Omitting `execute` and `explain` performs no database calls. To try the browser
with the existing blog example:

```sh
DATABASE_URL=postgres://user:password@localhost/symmetria_examples bun examples/inspect.ts
# Or omit DATABASE_URL to browse SQL and parameters offline.
```

## Live request profiler

```ts
import { createDatabase, createProfiler } from "symmetria";
import { postgres } from "symmetria/driver";
import { appSchema } from "./schema";

const profiler = createProfiler({ capacity: 200 });
const database = createDatabase({
  schema: appSchema,
  driver: postgres({ url: process.env.DATABASE_URL!, profiler }),
});
const profilingServer = profiler.serve(); // 127.0.0.1:7331

Bun.serve({
  fetch: profiler.fetch(async (request) => {
    const users = await database
      .users((user) => ({ id: user.id, name: user.name }))
      .execute();
    return Response.json(users);
  }),
});
```

Open `bunx --package symmetria-kit symmetria profile`. Select a request, then a
SQL statement with Enter. `e` requests an estimated plan; `a` explicitly runs
`EXPLAIN ANALYZE`. Escape goes back; `q` exits. Repeated SQL shapes are marked
`↻`. `--profile-url` selects another endpoint; `--json` returns the retained
requests.

`profiler.trace("job name", async () => ...)` groups background work. The fetch
wrapper labels requests with HTTP method and pathname; concurrent requests have
independent contexts. This tracing context does not change transaction handling.
`snapshot()` returns a copy of the most recent completed requests.

Timings have distinct meanings:

| Metric   | Includes                                                       |
| -------- | -------------------------------------------------------------- |
| Build    | Synchronous query construction made inside a trace             |
| Compile  | SQL generation at execution time; zero for precompiled queries |
| Database | Driver round trip, pool waiting and result transfer            |
| Decode   | Symmetria result/codec mapping                                 |
| Total    | Entire traced callback, including non-database work            |

Instrumentation is opt-in and adds overhead. Build is request-level; compile,
database and decode are per statement. `one()`/pagination execution helpers are
outside the build timer. Parallel query durations need not add up to total.
EXPLAIN runs on the pool's connection context, so a saved transactional query's
plan may reflect different data or session settings. Only retained SELECTs can
be explained. Parameters remain visible in the local development endpoint. Stop
the endpoint with `await profilingServer.stop()` during shutdown.

## Prepared queries

```ts
import { prepare, int, text } from "symmetria";

const searchPosts = prepare(
  { authorId: int, title: text, size: int },
  (parameters) =>
    database.posts((post) => ({
      id: post.id,
      title: post.title,
      $where: [
        post.authorId.is(parameters.authorId),
        post.title.ilike(parameters.title),
      ],
      $limit: parameters.size,
    })),
);

searchPosts.toSQL({ authorId: 1, title: "%SQL%", size: 20 });
const posts = await searchPosts.execute({
  authorId: 1,
  title: "%SQL%",
  size: 20,
});
// { id: number; title: string }[]
```

The factory runs once and SQL is compiled once. Each execution binds a fresh set
of typed values through the column codecs. SELECT, INSERT, UPDATE, DELETE,
RETURNING, subqueries, and parameterized LIMIT/OFFSET share this mechanism.
Parameter names and values are required; use `.nullable` to accept `null`. Query
structure, selected fields and the number of IN-list elements stay fixed.
Placeholders belong to their factory and cannot escape into another query.
Prepared LIMIT/OFFSET parameters accept nonnegative safe integers, including
zero. Fixed counts still compile as literals, even inside a prepared query.

A query with fixed values can use `query.prepare()` and then `.execute()`
without arguments. Prepared queries retain the original executor and transaction
lifetime. Every query object also compiles its SQL once: repeated `.execute()`,
`await`, `one()`, `first()` and `toSQL()` calls on the same object reuse the
compiled text and only rebuild the parameters array. Server-side statement
caching is managed by the configured driver; a parameterized LIMIT/OFFSET keeps
one SQL text across page values, while literal counts produce one text per
value.

## INSERT, UPDATE, DELETE

```ts
const author = await database.users
  .insert({ name: "Ada" })
  .returning((users) => [users.id, users.name]);
// { id: number; name: string }

await database.posts.insert({ title: "SQL first", authorId: author.id });

await database.posts
  .update((posts) => ({ views: posts.views.plus(1) }))
  .where((posts) => posts.title.is("SQL first"));

await database.users
  .insert({ name: "Ada" })
  .onConflict("name")
  .doUpdate("name");

await database.posts.delete().where((posts) => posts.views.is(0));

// Relation paths and quantifiers work in UPDATE/DELETE predicates.
await database.posts.delete().where((posts) => posts.author.name.is("Ada"));
await database.users
  .update({ active: false })
  .where((users) => users.posts.none());
```

Bulk INSERT accepts arrays, including rows with different omitted defaults.
`defaultValue` explicitly emits SQL `DEFAULT`. Mutations resolve to
`{ affectedRows }` without `returning()`. With `returning()`, `insert(object)`
resolves to one row (`null` when `onConflict().doNothing()` skipped it) and
`insert(array)`, UPDATE and DELETE resolve to arrays. `bigint` columns accept
safe integers on write and in comparisons. Relation paths in `where()` compile
to a primary-key subquery (`WHERE "posts"."id" IN (SELECT ... JOIN ...)`), so
they need a primary key. UPDATE/DELETE without WHERE operate on all rows,
following SQL semantics. `onConflict().doNothing()` handles conflicts.
`doUpdate("name", "active")` assigns those fields from `excluded`; object and
callback forms support custom assignments. Generated and computed fields cannot
be written through the shorthand.

UPDATE assignments, WHERE and RETURNING callbacks receive the row directly,
including nested-insert RETURNING. The upsert callback receives the current row
first and the proposed `excluded` row second:

```ts
await database.users
  .insert({ name: "Ada", active: true })
  .onConflict("name")
  .doUpdate((user, excluded) => ({ name: user.name, active: excluded.active }))
  .returning((user) => ({ id: user.id, active: user.active }));
```

## Unique-key lookups

```ts
const users = table({ id: int.auto, email: text.unique, name: text });
const handles = table({ id: int.auto, tenant: text, handle: text }).indexes(
  (handles) => ({ identity: index(handles.tenant, handles.handle).unique }),
);
const database = createDatabase({
  schema: schema({ users, handles }),
  driver: postgres(process.env.DATABASE_URL!),
});

await database.users.by.email("ada@example.com").one();
await database.handles.by
  .identity({ tenant: "team", handle: "ada" })
  .maybeOne();
```

`.by` is inferred from `.unique` columns and table-local named, unconditional
unique indexes over plain columns. Composite keys require all fields. Lookups
select all root columns, including computed fields, and compose with ordinary
query methods and prepared parameters. Null/undefined keys are rejected. Partial
and expression indexes are excluded; use explicit predicates for them.
Primary-key lookup remains `.byId(...)`, including non-`id` and composite keys.

## Atomic nested inserts

```ts
await database.posts
  .insert({
    title: "Relations in SQL",
    author: { connect: 1 },
    tags: { connectOrCreate: [{ label: "bun" }, { label: "postgres" }] },
  })
  .returning((posts) => ({ id: posts.id, title: posts.title }))
  .execute();
```

- To-one relations accept exactly one of `connect`, `create`, `connectOrCreate`.
- Collections accept arrays under those keys; operations can be combined.
- `connect` accepts a primary-key value or a complete unique-key object. A
  missing row throws with code `SYMMETRIA_RECORD_NOT_FOUND`.
- `create` recursively inserts the target. Reverse child inserts infer the
  parent's foreign key; junction relations insert both target and linking rows.
- `connectOrCreate` takes a **flat insert payload**, including every required
  target field. It chooses the first populated unique key (PK, unique columns,
  then indexes) and uses `ON CONFLICT DO UPDATE` on those key fields. Existing
  non-key fields are preserved; database UPDATE triggers can run. Supply only
  the intended identifying key when several alternatives exist.

Reverse `connect` reparents the existing child; junction `connect` adds a link.
Supply a forward relation or its scalar FK, never both. Relation targets require
a single-column PK; `byId` and ordinary writes still support composite keys.
Junction writes require its normal inferred two-FK unique key and no additional
required payload. Self-relations need explicitly named inverses.

The whole insert, including an array of root inputs, executes in one
transaction. A nested insert inside `$transaction` uses a savepoint and inherits
its isolation. `returning` projects the inserted root; it does not load the
newly created graph. A single input resolves to one row, an array to an array;
without `returning` the result is `{ affectedRows }` counting root rows. Nested
inserts are multi-statement operations with `.returning()`/`.execute()`; they do
not expose `.toSQL()`, `.prepare()` or root `.onConflict()`. Ordinary flat
inserts keep the full SQL builder.

## CTEs and window functions

```ts
import { rowNumber, over, sum } from "symmetria";

const ranked = database
  .posts((post) => ({
    id: post.id,
    position: rowNumber().over({
      partitionBy: [post.authorId],
      orderBy: [post.createdAt.descending, post.id.descending],
    }),
    runningViews: over(sum(post.views), {
      partitionBy: [post.authorId],
      orderBy: post.id.ascending,
      rows: ["unbounded preceding", "current row"],
    }),
  }))
  .cte("ranked", { materialized: false });

await ranked((post) => ({
  id: post.id,
  position: post.position,
  runningViews: post.runningViews,
  $where: post.position.atMost(3),
})).execute();
```

Call `.cte(name)` after selecting fields. The result is a typed table source:
select from it, join it, or alias it. Dependencies are emitted once in a single
`WITH` statement; conflicting names throw. `materialized: true | false` emits
the PostgreSQL hint; omission uses the database default. CTEs support SELECT
bodies.

`rowNumber()`, `rank()` and `denseRank()` return number after `.over(...)`.
`lag(column, offset?, fallback?)` and `lead(...)` retain the column codec and a
nullable result. `over(aggregate, options)` supports aggregate windows; sums and
averages retain numeric precision. `partitionBy` takes columns, `orderBy` takes
one or multiple orderings. `rows: [start, end]` accepts `"unbounded preceding"`,
`"current row"`, `"unbounded following"`, `{ preceding: number }` and
`{ following: number }`. Offsets must be nonnegative safe integers. PostgreSQL
validates expression legality and frame ordering. Use a CTE to filter a window
result because windows cannot appear directly in WHERE.

Recursive example for a table with `id`, nullable `parentId`, and `name`:

```ts
const tree = database
  .nodes((node) => ({
    id: node.id,
    name: node.name,
    $where: node.id.is(rootId),
  }))
  .recursive("tree", (tree) =>
    database.nodes((node, { innerJoin }) => {
      innerJoin(tree, (parent) => node.parentId.is(parent.id));

      return { id: node.id, name: node.name };
    }),
  );

await tree((node) => ({ id: node.id, name: node.name })).execute();
```

The recursive term must return the anchor's fields in the same order and with
compatible types. `UNION ALL` is the default; `{ unionAll: false }` deduplicates
whole rows using `UNION`. Bound the traversal when the data can contain cycles.
The callback's self-reference is scoped to that CTE. Prepared anchors, nullable
columns and codecs are preserved through the resulting table source.

## Aggregates and subqueries

```ts
import { count, sum, exists } from "symmetria";

const totals = database.posts((post, { innerJoin }) => {
  const author = innerJoin(post.authorId);

  return {
    name: author.name,
    total: count(),
    views: sum(post.views),
    $groupBy: [author.name],
    $having: count().above(1),
  };
});

const activeAuthors = database.users((user) => ({
  name: user.name,
  $where: exists(
    database.posts((post) => ({
      id: post.id,
      $where: post.authorId.is(user.id),
    })),
  ),
}));
```

`count()` returns `number`. `sum()` and `average()` return lossless decimal
strings or `null`; `minimum()` and `maximum()` retain the value type and add
`null`. `coalesce()` supplies a non-null fallback. A selected query's
`.as("recent")` creates a typed derived table; single-column queries support
`in()` and `.scalar()`. Automatic aliases distinguish repeated sources when
correlating a table with itself.

### Relation aggregates

Relationships expose correlated aggregates directly. These scalar subqueries
support forward, reverse, self and junction relations without multiplying root
rows:

```ts
database.users((users) => ({
  name: users.name,
  posts: users.posts.count(),
  viewed: users.posts((posts) => ({ $where: posts.views.above(0n) })).count(),
  hasPosts: users.posts.exists(),
  totalViews: users.posts.sum((post) => post.views),
  averageViews: users.posts.average((post) => post.views),
  latestPost: users.posts.maximum((post) => post.createdAt),
}));
```

| Method                                                     | Result                                         | Empty input |
| ---------------------------------------------------------- | ---------------------------------------------- | ----------- |
| `count()`                                                  | `number`                                       | `0`         |
| `exists()`                                                 | `boolean`                                      | `false`     |
| `sum(row => expression)`, `average(row => expression)`     | Decimal `string \| null`                       | `null`      |
| `minimum(row => expression)`, `maximum(row => expression)` | Expression's value type and codec, plus `null` | `null`      |

Value aggregates ignore SQL NULL; an all-NULL input also produces `null`.
Filtering applies before aggregation. LIMIT/OFFSET select the input rows per
parent:

```ts
database.users((user) => {
  const recent = user.posts((post) => ({
    $where: post.state.is.published,
    $orderBy: [post.createdAt.descending, post.id.descending],
    $limit: 3,
  }));

  return {
    name: user.name,
    recentCount: recent.count(),
    recentViews: recent.sum((post) => post.views),
  };
});
```

This sums at most three published posts per user. Grouping, HAVING and DISTINCT
run in the inner query before the outer aggregate. With grouping, `count()`
counts groups and a value selector must be valid for the grouped query. For
value aggregates, DISTINCT applies to the selected aggregate input expression.

### Raw SQL expressions

`sql<Value>` is a typed template escape hatch: interpolated values become
parameters and column expressions remain identifiers. The caller supplies the
result type and any PostgreSQL casts needed by raw SQL, for example:
``sql<string>`concat(${"Hello "}::text, ${users.name})`.as("greeting")``.

## Nested relations

```ts
const authors = await database.users((user) => ({
  name: user.name,
  posts: user.posts((post) => ({
    title: post.title,
    editor: post.editor((editor) => ({ name: editor.name })),
    $orderBy: post.id.ascending,
  })),
  $where: user.name.ilike("A%"),
  $orderBy: user.name.ascending,
  $limit: 20,
}));
```

Nested 1:1, 1:M and M:N loads use one statement with correlated subqueries and
JSON aggregation. Missing collections are `[]`; missing optional single
relations are `null`. Root pagination applies to parents. Ordinary JOINs retain
SQL row multiplication. Specify `$orderBy` for deterministic nested collection
order.

When a paginated query projects nested collections, relation aggregates or
`exists()`, Symmetria restricts the root rows first in a derived table that
keeps the root alias, and evaluates the subqueries only for the resulting page;
the outer `ORDER BY` is repeated. The rewrite applies at every nesting level and
is skipped for `$distinct`, `$groupBy`, `$having`, row locks, local JOINs,
window functions, bare aggregates, raw SQL in projections or orderings,
orderings by a correlated subquery, shared aggregates and the SQLite driver. Raw
SQL is opaque: it may hide a window, aggregate or volatile expression, so it
keeps its original evaluation scope. Raw expressions inside a nested query block
only that query's rewrite.

## Values and drivers

- `bigint` → JavaScript `bigint`, `numeric(precision, scale)` → decimal
  `string`. Writes and comparisons also accept safe integers for `bigint`
  columns.
- `jsonb<Value>()` → `Value`, `timestamptz` → `Date`.
- `jsonb(schema)` takes any [Standard Schema](https://standardschema.dev) object
  (Zod, Valibot, ArkType, …), infers the value type from it and validates every
  written and read value synchronously; invalid data throws with the issue
  paths.
- `text.array`, `int.array`, `uuid.array`, `timestamptz.array`, … → `string[]`,
  `number[]`, … stored as PostgreSQL arrays. See
  [Arrays and full-text search](#arrays-and-full-text-search).
- `customType<Value>(sqlType, { encode, decode })` defines application codecs.
- `uuid.v4.brand("UserId")` adds a TypeScript brand inherited by FK fields. Use
  `Branded<string, "UserId">` to name the value type; SQL remains ordinary UUID.
- `schema(definitions, { executor })` accepts a custom execution function
  returning `{ rows, affectedRows }` (or an array of rows). JSON parameters use
  serialized text with explicit SQL casts. Selected aliases identify result
  keys.
- `await database.$close()` closes the configured driver's pool.

### Custom dialects

The `DialectStrategy` API exposes the differences used by the built-in
PostgreSQL and SQLite drivers: placeholders, casts, JSON functions, search,
defaults, EXPLAIN, result conversion and a `capabilities` record that switches
optimizations such as LATERAL sharing and root pagination, and gates supported
features. `postgresDialect` and `sqliteDialect` are exported from
`symmetria/dialect`, and a driver supplies its strategy through `dialect`:

```ts
import type { Driver } from "symmetria/driver";
import { postgresDialect, type DialectStrategy } from "symmetria/dialect";

const unlocked: DialectStrategy = {
  ...postgresDialect,
  name: "postgres-without-locks",
  capabilities: { ...postgresDialect.capabilities, rowLocks: false },
};

const driver: Driver = { execute, close, dialect: unlocked };
```

A strategy registers an immutable snapshot of its methods, `capabilities` and
`textCast` the first time a schema binds to the driver.
`registerDialect(strategy)` does the same explicitly. Re-registering the same
object is a no-op, even after the original object is edited; another strategy
under a taken name is rejected. Keep the registered object across hot reloads or
use a new name for a new strategy. Bindings carry the registered name, so
prepared queries, caches and codecs use the same snapshot. Built-ins are frozen
and use no `this`, making spread copies safe. Custom methods must be
deterministic and independent of mutable external state.

`rowLocks: false` rejects `$forUpdate` / `$forShare`, including on SQLite;
`containmentOperators: false` rejects `contains()` / `overlaps()` comparison
operators, while `has()` uses its own implementation. `fullTextSearch: false`
rejects `search()` and `searchRank()`. SQLite enables `search()` through its
documented LIKE emulation; ranking additionally requires a `searchRank` method.
Unsupported features fail during compilation, before execution.

Strategies customize PostgreSQL- and SQLite-compatible SQL. Identifier quoting,
identifier length limits, `ON CONFLICT`, `RETURNING`, explicit null ordering and
CTE materialization use those databases' syntax. MySQL is not supported.

## Arrays and full-text search

```ts
const posts = table({
  id: int.auto,
  title: text,
  tags: text.array,
  scores: bigint.array.nullable,
});
const database = createDatabase({
  schema: schema({ posts }),
  driver: postgres(process.env.DATABASE_URL!),
});

database.posts((post) => ({
  id: post.id,
  tagCount: post.tags.length(),
  $where: post.tags.has("sql"), // $1 = ANY("tags")
}));
database.posts((post) => ({
  id: post.id,
  $where: post.tags.contains(["bun", "sql"]),
})); // @>
database.posts((post) => ({
  id: post.id,
  $where: post.tags.overlaps(["bun", "deno"]),
})); // &&

database.posts((post) => {
  const relevance = post.title.searchRank("bun sql", { language: "english" });

  return {
    title: post.title,
    relevance,
    $where: post.title.search("bun sql", { language: "english" }),
    $orderBy: relevance.descending,
  };
});
```

Array parameters are sent as PostgreSQL array literals with an explicit cast;
elements use the column's codec, so `bigint[]` and `timestamptz[]` round-trip
exactly. `search()` compiles to
`to_tsvector(language, column) @@ websearch_to_tsquery(language, query)` with
the `"simple"` configuration by default; `websearch_to_tsquery` understands
quoted phrases and `-excluded` words. Add a GIN index with
`index(sql\`to_tsvector('english', ${posts.title})\`).using("gin")`.

## Scoped databases

For a schema whose `posts` and `comments` tables each declare `tenantId`:

```ts
const tenant = database.$scope({
  posts: (posts) => posts.tenantId.is(tenantId),
  comments: (comments) => comments.tenantId.is(tenantId),
});

await tenant.posts((post) => ({ id: post.id })); // WHERE "posts"."tenant_id" = $1
await tenant.users((user) => ({ posts: user.posts.count() }));
await tenant.posts.delete().where((posts) => posts.id.is(7));
```

`$scope()` returns a database with the same type whose reads, updates and
deletes of the scoped tables carry the predicate: root queries, `byId()`, unique
lookups, shape projections, relation paths, explicit joins (in `ON`), nested
collections and quantifiers. Inserts are not filtered. Scopes compose: a scoped
database can be scoped again and the predicates are ANDed. Transactions inherit
the scope, and `transaction.$scope()` narrows it further inside the callback.
Scope callbacks see the table's own columns.

## SQLite driver

```ts
import { createDatabase } from "symmetria";
import { sqlite } from "symmetria/driver";

const driver = sqlite(":memory:");
driver.createTables(appSchema);
const database = createDatabase({ schema: appSchema, driver });
```

`sqlite()` runs the same schema and queries on `bun:sqlite`, with no dependency,
through the exported `sqliteDialect` strategy: placeholders, JSON collections,
relation paths, upserts, `RETURNING`, savepoints, cursor pages and `inspect()`
(`EXPLAIN QUERY PLAN`) all work. Types map to INTEGER/REAL/TEXT storage: `bool`
↔ 0/1, `jsonb`, arrays and `timestamptz` ↔ ISO text, `bigint` stays exact
through safe integers. `driver.createTables(appSchema)` executes SQLite DDL;
`sqliteSchemaSQL(snapshot)` from `symmetria/driver` returns it with rowid
identities, enum CHECKs, foreign keys and plain indexes. Not available in
SQLite: `contains`/`overlaps`, `searchRank()`, row locks (rejected),
`EXPLAIN ANALYZE`, CHECK callbacks, partial indexes and Kit migrations; the
driver documents its supported query features through `sqliteDialect`. One
connection serves all queries; statements wait for an open transaction to
commit.

## Computed fields, enums and JSON

```ts
const users = table({ id: int.auto, firstName: text, lastName: text }).computed(
  (users) => ({
    fullName: sql<string>`concat_ws(' ', ${users.firstName}, ${users.lastName})`,
  }),
);
```

Computed fields are named SQL expressions. They are available to SELECT, WHERE,
JOIN aliases, RETURNING and nested loading, and are excluded from INSERT/UPDATE
and physical table DDL. Chained callbacks can refer to previously computed
fields. Use pure callbacks: expressions are built for the current SQL
alias/scope.

For `state: oneOf("draft", "published")`, `posts.state.is("published")`
autocompletes the labels; `posts.state.is.published` and
`posts.state.isNot.draft` are the same predicates as properties. Use
[`.match()`](#enum-mappings) for an exhaustive SQL CASE projection; it preserves
branch codecs and nullable inputs.

```ts
// metadata: jsonb<{ settings?: { theme: string }; tags: string[] }>()
posts.metadata.path("settings", "theme").is("dark");
posts.metadata.path("tags").contains(["sql"]);
posts.metadata.path("tags", 0).as("firstTag");
```

JSON paths check keys and numeric array positions, compile to `#>` with bound
path components, and retain JSON value types. Missing paths and JSON null decode
to null. `is(null)` tests SQL NULL (including a missing path); a present JSON
null is a JSON value. `contains()` uses `@>` and accepts partial
objects/subarrays.

## Indexes

Use `.index` for a single-column B-tree index, including foreign keys:

```ts
schema({
  users: { id: int.auto, name: text.index },
  posts: ({ users }) => ({ id: int.auto, author: users.index, title: text }),
});
// users_name_idx, posts_author_id_idx
```

Modifiers are immutable and compose with `.nullable`, `.default(...)` and
reference actions. A single-column PK or `.unique` already has an index, so
`.index` does not create a redundant one.

Declare indexes next to their table with `table(columns).indexes(callback)`. The
callback receives that table's columns, including generated FK columns.

```ts
import {
  schema,
  table,
  index,
  sql,
  int,
  text,
  bigint,
  timestamptz,
} from "symmetria";

import { postgres } from "symmetria/driver";

const database = schema(
  {
    users: table({ id: int.auto, name: text }).indexes((users) => ({
      lowerName: index(sql<string>`lower(${users.name})`).unique,
    })),
    posts: ({ users }) =>
      table({
        id: int.auto,
        title: text,
        author: users,
        views: bigint.default(0n),
        createdAt: timestamptz.now,
      }).indexes((posts) => ({
        byAuthorDate: index(posts.authorId, posts.createdAt.descending).include(
          posts.title,
        ),
        viewed: index(posts.views).where(posts.views.above(0n)),
      })),
  },
  { driver: postgres(process.env.DATABASE_URL!) },
);

database.$createIndexes().toSQL(); // CREATE INDEX statements
await database.$createIndexes({ ifNotExists: true }).execute();
```

Supported: compound, unique, partial, expression and covering indexes; `btree`
(default), `hash`, `gin`, `gist`, `spgist`, `brin` via `.using(method)`. Ordered
keys support `.ascending`/`.descending` and `.nullsFirst`/`.nullsLast`.
Method-specific combinations are validated during schema assembly. PostgreSQL
checks operator support and expression immutability.

Local names become `<table>_<key>_idx` in snake_case: `byAuthorDate` above
produces `posts_by_author_date_idx`. Keys may repeat across tables; SQL-name
collisions are rejected. `.indexes()` returns a new table declaration and
repeated calls append definitions. Callbacks run during schema assembly, after
all foreign keys and codecs are resolved. Declarations can be reused across
schemas and mixed with plain column objects.

Scalar and FK types are inferred inside local callbacks when the target key is
available from a non-callback declaration. For keys declared inside other schema
callbacks, including cycles, anchor their types before defining the tables:

```ts
schema.keys({ users: int, teams: int })({
  users: ({ teams }) =>
    table({ id: int.auto, team: teams.nullable.inverse("members") }).indexes(
      (users) => ({ byTeam: index(users.teamId) }),
    ), // number | null
  teams: ({ users }) => ({ id: int.auto, owner: users.inverse("ownedTeams") }),
});
```

Anchors must match the actual scalar PK's SQL type, enum values and custom
codec. Without anchors, callback-dependent FK values can remain `unknown`
locally; query, row and insert types are still fully resolved.

Schema-level `schema(definitions, { indexes: ({ posts }) => ({ ... }) })` is
also supported, with fully resolved FK value types. Its keys are schema-wide SQL
names (snake_case, without the table prefix or `_idx` suffix).

Index metadata lives in `$snapshot().tables[].indexes`.
`createIndexesSQL(snapshot, options)` also compiles it independently. DDL
literals are escaped directly because PostgreSQL index definitions cannot bind
parameters. Schema declaration records indexes; generated migrations or
`$createIndexes().execute()` apply them. `concurrently: true` is supported
outside transactions. `ifNotExists` skips an existing name; it does not compare
or replace its definition.

## Primary keys and CHECK constraints

```ts
import { schema, table, text, int, numeric } from "symmetria";

const inventory = schema({
  tenants: table({ code: text, name: text }).primaryKey((tenants) => [
    tenants.code,
  ]),
  products: ({ tenants }) =>
    table({
      tenant: tenants.index,
      sku: text,
      price: numeric(12, 2),
      stock: int.default(0),
    })
      .primaryKey((products) => [products.tenantId, products.sku])
      .checks((products) => ({
        positivePrice: products.price.above("0"),
        availableStock: products.stock.atLeast(0),
      })),
});
```

`.primaryKey(callback)` preserves the selected column order, including generated
FK columns. Keys require non-null plain columns. A single column can also use
`code: text.primaryKey`; otherwise a scalar `id` is the conventional PK.
Shorthand references accept one scalar PK with any name: `tenantId` above is a
string referencing `tenants.code`. Composite foreign-key targets are not
supported.

`.checks(callback)` receives typed columns and returns named predicates. Calls
append immutably; names become `<table>_<key>_check` in snake_case. CHECK
expressions use the same codecs and literal escaping as indexes. Aggregates,
subqueries and foreign callback scopes are rejected. PostgreSQL CHECK semantics
apply: both TRUE and NULL pass; use non-null columns to reject NULL values.

Keys and checks appear in snapshots, generated DDL and reversible migration
diffs. Checks are rebuilt around affected column renames and type changes.

## Transactions

```ts
import { IsolationLevel } from "symmetria";

const article = await database.$transaction(
  async (transaction) => {
    const author = await transaction.users
      .insert({ name: "Grace" })
      .returning((users) => [users.id])
      .execute();

    return transaction.posts
      .insert({ title: "Atomic writes", authorId: author.id })
      .returning((posts) => [posts.id, posts.title])
      .execute();
  },
  { isolationLevel: IsolationLevel.Serializable },
);
```

The callback receives the same typed tables bound to one reserved connection.
Its result is returned after COMMIT; a thrown error rolls back and is rethrown.
Use this callback context for every operation in the transaction.

Use `Transaction<typeof database>` for services that receive a transaction:

```ts
import type { Transaction } from "symmetria";

type AppTransaction = Transaction<typeof database>;

const findAuthor = (transaction: AppTransaction, authorId: number) =>
  transaction.users.byId(authorId).one();

await database.$transaction((transaction) => findAuthor(transaction, 1));
```

It infers the exact tables and relations from either the connected database or
`typeof appSchema`. Nested savepoints have the same type. Pool shutdown and
transaction-incompatible index options remain unavailable on this context. The
type distinguishes a transaction from the pool-bound database, so passing
`database` to a transaction-only helper is a compile-time error.

- Isolation: `IsolationLevel.ReadCommitted`, `IsolationLevel.RepeatableRead`,
  `IsolationLevel.Serializable`. The corresponding strings (`"read committed"`,
  `"repeatable read"`, `"serializable"`) are also accepted. `IsolationLevel` is
  a frozen constant object and an exported union type.
- `readOnly: true`; `deferrable: true` with serializable read-only transactions.
- `transaction.$transaction(async (savepoint) => …)` creates a nested savepoint.
  Catch its failure in the outer callback to recover and continue; successful
  nested writes still roll back if the outer transaction fails.
- `$forUpdate` / `$forShare` acquire row locks. Options: `of: [alias]`,
  `noWait: true`, or `skipLocked: true`. Locks last until the transaction ends.
- Await all operations. An unfinished operation at callback exit causes
  rollback; query handles from a finished transaction/savepoint reject
  execution. Await an active savepoint before using its parent or starting a
  sibling savepoint; interleaved operations are rejected.
- A caught SQL error still aborts its transaction scope. Use a savepoint for
  recoverable SQL failures. Serialization errors propagate without automatic
  retries.
- Ordinary `$createIndexes()` is transactional; `concurrently: true` is rejected
  by both types and runtime in a transaction context.

Custom drivers can implement the optional `Driver.transaction` capability and
the recursive `TransactionDriver` contract. An executor-only schema reports that
transactions require a capable driver. Transaction contexts expose no
`$close()`.

## Migrations

Start a project with `bunx --package symmetria-kit symmetria init`. It creates
modular tables, an offline schema,
`createDatabase({ schema: appSchema, driver: postgres(url) })`, migration config
and `.env.example`. Existing files are preserved. Repeating `init` on a project
with a migration config or migration history is a no-op, so it cannot add a
second template schema. Install `symmetria` and `symmetria-kit` in the
application and set `DATABASE_URL` before connecting.

Create `symmetria.config.ts` with an offline schema declaration:

```ts
import { defineMigrationConfig } from "symmetria-kit";
import { model } from "./schema";

export default defineMigrationConfig({
  schema: model,
  directory: "./migrations",
  databaseUrl: process.env.DATABASE_URL,
});
```

Kit installs the `symmetria` binary. Use
`bunx --package symmetria-kit symmetria`, or `symmetria` inside a package
script. From this repository:

```sh
# Interactive dashboard (terminal only).
bun packages/kit/src/cli.ts --config examples/symmetria.config.ts

# Offline schema inspection and code-versus-snapshot diff.
bun packages/kit/src/cli.ts inspect posts --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts inspect --relations --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts diff --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts diff --sql --config examples/symmetria.config.ts

bun packages/kit/src/cli.ts generate change_name --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts migrate --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts status --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts rollback --config examples/symmetria.config.ts
```

The dashboard stays in one terminal screen, with a softly animated logo, schema
counts, connection state and pending SQL changes. Set `DATABASE_URL` or pass
`--database-url postgres://user:password@localhost:5432/app` to connect. Use
arrow keys and Enter (or 1–7); Escape/Ctrl-C leave the menu. Action results stay
open in a scrollable view: arrows/Page Up/Page Down scroll, Enter/Escape return
to the dashboard. Exiting restores the original terminal screen. `generate` can
ask for a name and clarify possible table/column renames interactively. These
choices produce explicit rename SQL in the saved migration. `--no-interactive`
disables prompts; automated runs can provide the existing `--diff` rename-hint
file.

`diff` compares the current declaration to the latest local snapshot, not to the
live database. In a terminal, `inspect` opens a two-pane schema browser: tables
on the left and Columns / Relations / Indexes / Checks / SQL tabs on the right.
Columns have aligned types and compact PK, FK, UNIQUE, NULL, AUTO and DEFAULT
badges. Selecting a row shows its physical name, defaults and constraint
details. The SQL tab previews syntax-highlighted schema DDL, including enums and
indexes.

- ↑/↓ select; Tab switches panes; ←/→ or 1–5 switch detail tabs.
- Enter opens a table or follows a selected FK/relation; Backspace retraces the
  previous table and selection.
- `/` searches table names, fields and constraints. Enter keeps the filter;
  Escape cancels editing, clears an active filter, or returns to the dashboard.
- Page Up/Down and Home/End navigate long lists or SQL. Narrow terminals show
  one pane at a time; Tab switches between them.
- `inspect posts` starts on that table; `inspect --relations` starts on the
  Relations tab. `--no-interactive` prints the plain schema listing.

Inspection reads the schema declaration and works without a connection. `--json`
provides machine-readable output for diff, inspect, status, generate, migrate,
rollback and init. `diff --sql` emits SQL. Terminal output includes colored
diffs, migration state and loading spinners with elapsed time; piped output
stays plain. `--no-color` and `NO_COLOR` disable colors, and `--no-animation`
disables the logo shimmer and spinner animation. Failed migrations report the
failing statement and the underlying PostgreSQL error.

`generate` compares the schema with the latest local snapshot and needs no
database connection. SQL and metadata have separate directories:

```text
migrations/
├── 000001_initial/
│   ├── up.sql
│   └── down.sql
└── meta/
    ├── snapshot.json
    └── migration.json
```

There are always just two metadata files, regardless of the migration count:

- `snapshot.json` stores the latest **generated** schema, used by `generate`,
  `diff`, `lint`, `drift` and `squash`.
- `migration.json` stores a versioned journal with a `migrations` array. Each
  entry contains its ID, parent and before/after schema hashes, without a full
  snapshot.

Generation updates the shared pair and adds an SQL directory. Commit them
together. Applying or rolling back migrations updates database history, not the
local snapshot or journal; rollback executes the corresponding `down.sql` files.
Missing SQL directories, inconsistent chains and snapshot hashes are rejected.
Failed generation or squash restores the previous files. `generate --json`
reports both `directory` and `metadataDirectory`. An unchanged schema produces
no migration. `generate backfill --empty` creates an empty SQL migration and
appends a journal entry without changing the snapshot.

- DDL covers tables, enums, identities, defaults, nullability, PK/FK, CHECK,
  unique constraints and indexes, with dependency-aware creation and removal.
- Explicit rename hints and directional `USING` conversions come from
  `generate <name> --diff changes.json`; names in that file are physical SQL
  names.
- `migrate --to <id>` applies through a target; `rollback --steps 2` reverts the
  latest two applied migrations in reverse order.
- `lint` reviews the pending diff: destructive (dropped tables/columns),
  blocking (NOT NULL or UNIQUE on populated columns, removed enum labels) and
  cautionary (type rewrites, renames, index builds) findings with the safe
  sequence to use. `--strict` exits with code 1 when anything is reported.
- `drift` compares the live database with the latest snapshot: missing or extra
  tables, columns and indexes, type and nullability mismatches. `--strict` for
  CI.
- `squash <name>` replaces the chain with one baseline migration that creates
  the latest snapshot; databases that applied the old chain run `adopt`, which
  rewrites the recorded history when the database snapshot hash matches a local
  migration (`adopt --to <id>` baselines an existing database explicitly). An
  unchanged applied migration retains its exact boundary. If several replacement
  migrations have the same schema hash, use `--to` to identify the intended
  baseline; data-only migrations cannot be distinguished by their schema hash
  alone.
- Each migrate/rollback batch runs in one transaction under a PostgreSQL
  advisory lock. History defaults to `public._symmetria_migrations`. Config can
  override `metadataSchema` and `metadataTable`.
- Applied checksums cover SQL in both directions and journal entries, including
  their schema hashes. Adding a migration does not change earlier checksums.
  Missing, reordered or edited applied migrations are rejected before execution.
- Tables/types use the connection's `search_path`; metadata always uses its
  explicitly qualified schema. Config paths are relative to the config module;
  `--dir` paths are relative to the working directory.

Generated down SQL restores schema structure; it cannot recreate deleted data.
Data backfills and nontrivial conversions can be added to the SQL before
applying. Constraint violations or enum values that cannot be narrowed cause an
atomic rollback of the migration attempt. The runner manages transaction
boundaries; SQL requiring execution outside a transaction, such as
`CREATE INDEX CONCURRENTLY`, belongs outside this transactional runner.

Programmatic APIs are exported from `symmetria-kit`: `migrationSnapshot`,
`createSchemaSQL`, `diffSchemas`, `lintMigration`, `detectDrift`,
`generateMigration`, `squashMigrations`, `loadMigrations`, `loadMigrationState`
(returns `{ migrations, snapshot }`), and `migrator({ driver, directory })` with
`migrate`, `rollback`, `status` and `adopt`. `loadMigrations` returns the SQL
chain and checksums; historical migrations do not carry snapshots.
`generateMigration` and `squashMigrations` also return the new snapshot.

`symmetria-kit/testing` exports `testDatabase({ url, schema })`: it creates an
isolated PostgreSQL schema, runs the DDL, binds a pool whose `search_path`
points at it and drops everything on `close()`.

## Development

```sh
bun install
bun run build
bun run check
bun run test
SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb bun run test:integration
bun run test:packages
bun examples/queries.ts
SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb bun run test:examples
```

`tsdown` builds both workspace packages, including declarations, source maps and
package validation; `bun run build:watch` rebuilds on edits. Development
requires Node 24 LTS for the bundler and Bun 1.3+ for the runtime.

Runtime sources live in `packages/runtime/src`, grouped into `schema/`,
`query/`, `driver/` and `observability/`. CLI and migration sources live in
`packages/kit/src`. Each package builds into its own `dist` directory. See
[the source layout](publishing.md).

[Tests](../tests/README.md) are split into runtime/Kit unit tests,
CLI/filesystem, PostgreSQL, compile-only types and installed-package checks.
Integration commands require `SYMMETRIA_TEST_DATABASE_URL` and create/drop
isolated schemas.

[Runnable examples](../examples/README.md) cover modular schemas, migrations,
seeding, relations, cursor pages, nested writes, savepoints, CTEs, inspection
and profiling. They also demonstrate reusable projections, enum mappings and
relation aggregates. They use the public packages directly and close their
database pools.

Further migration work: online and non-transactional migration strategies.
Package validation and release commands: [publishing](publishing.md).

## License

MIT
