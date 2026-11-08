# API reference

[← Symmetria](../README.md) · [Core concepts](guide.md) ·
[Advanced recipes](advanced.md) · [Runnable examples](../examples/README.md)

Query syntax, type guarantees, PostgreSQL adapters and execution behavior. For
installation and a first query, start with the
[getting started](../README.md#get-started). For result shapes, relationships,
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
- [Arrays](#arrays) and [full-text search](#full-text-search)
- [Scoped databases](#scoped-databases) and
  [PostgreSQL adapters](#postgresql-adapters)
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
import { postgres } from "symmetria/pg";

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
  driver: postgres({ url: process.env.DATABASE_URL! }),
});
```

Names come from object keys; camelCase maps to snake_case. Columns are non-null
by default. `author: users` creates `authorId` and the `author` relationship;
`users.unique` represents 1:1. `junction({ post: posts, tag: tags })` declares a
many-to-many link table: both foreign keys form its primary key and each side
gains an M:N relation. `.inverse("edited")` resolves ambiguous reverse names.

A reference targets the primary key and creates a `<key>_id` column by default.
`users.by("email")` references a unique column instead (the foreign-key column
takes that column's type, so `authorId` is a `string`), and
`users.column("created_by")` names the SQL column while the TypeScript name
stays `ownerId`; both combine with the other modifiers:
`author: users.by("email").column("author_email").nullable.inverse("written")`.
`by()` accepts the primary key or a column marked `.unique`; a unique index
declared in `.indexes()` is not enough. Nested inserts `connect` such a
reference by the referenced value (`author: { connect: "ada@example.com" }`) or
by a key object.

### Relations without a foreign key

Legacy and analytical tables often relate through plain columns. `.relations()`
declares such a relation by its join predicate:

```ts
const posts = table({
  id: int.auto,
  title: text,
  authorName: text,
  reviewerName: text.nullable,
}).relations((post, { to }) => ({
  author: to(users).one((user) => post.authorName.is(user.name)),
  mentions: to(() => comments).many((comment) =>
    comment.postTitle.is(post.title),
  ),
  reviewer: to(users)
    .one((user) => post.reviewerName.is(user.name))
    .inverse("reviewed"),
}));
```

`post.author.name`, nested `post.mentions(...)`, aggregates such as
`post.mentions.count()`, quantifiers and `innerJoin(post.author)` work as with
foreign-key relations; the predicate becomes the `ON` clause and tenant scopes
are added to it. A `.one()` relation is always optional (LEFT JOIN, `null` when
nothing matches) because no key guarantees a match; `.inverse("reviewed")` adds
a collection on the target table. The relation adds no column, no constraint and
nothing to migrations, drift or `pull`; it cannot be written through nested
inserts. `to()` accepts a standalone table, a thunk, a plain column record or a
keyed link
(`posts: ({ users }) => table({...}).relations((post, { to }) => ({ author: to(users).one(...) }))`);
keyed links carry no column types, so their target columns are loosely typed.
The callback runs again for every JOIN with the query's own aliases, so keep it
free of side effects.

`appSchema` is an offline, reusable registry.
`createDatabase({ schema, driver })` binds it to a connection, reusing its
resolved metadata, codecs and scopes without rerunning declaration callbacks.
Pass pool options to `postgres({ url, max: 10 })`. Each returned database
retains its own executor and transaction contexts. Closing it closes that
driver's pool; handles sharing a driver also share its lifetime.

Official drivers are maintained and versioned with the `symmetria` package:
import `postgres` from `symmetria/bun` for Bun.SQL or `symmetria/pg` for
node-postgres. `symmetria/driver` aliases the `pg` adapter. Schemas and query
APIs, including `createDatabase`, come from `symmetria`.

Keyed callbacks also work:
`posts: ({ users }) => table({ author: users, ... })`. Use them for cycles or to
distinguish reference targets with identical structural types. Branded PKs also
distinguish otherwise identical table declarations. An imported table must be
included in the final registry; one declaration reused under several keys needs
a keyed reference to identify the intended target.

Schema declaration creates metadata and query builders. Apply
[migrations](#migrations) to create the database tables;
[`examples`](../examples/README.md) generates its migrations into
`.symmetria-examples/` and includes an idempotent seed. `int.auto` and
`bigint.auto` are `GENERATED ALWAYS AS IDENTITY`; generated identities are
omitted from writes. `smallint`, `real`, `doublePrecision`, `date`, `time`,
`interval`, `bytea` and `inet` are first-class builders (see
[Values and drivers](#values-and-drivers)). `numeric` and `varchar` work bare
(`price: numeric`, `code: varchar`) or with arguments (`numeric(10, 2)`,
`varchar(255)`). Passing a builder such as `jsonb` without calling it, a thunk
that returns a column, or a non-column value is reported with the table and
column name and a hint. `Infer<typeof db.users>` is the row type,
`InferInsert<typeof db.users>` the insert input, `InferUpdate<typeof db.users>`
the `update()` input and insert input and `InferShape<typeof card>` the row of a
reusable shape or a built query; all three also accept standalone `table()`
handles. `uuid.v4` works on PostgreSQL 14; `uuid.v7` needs PostgreSQL 18+.

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
const query = database.posts(
  ({ title, authorId, editorId }, { join }) => {
    const author = join(authorId);
    const editor = join(editorId);

    return { title, authorName: author.name, editorName: editor.name };
  },
  {
    where: ({ views }) => views.above(10n),
    orderBy: ({ createdAt }) => createdAt.descending,
    limit: 20,
  },
);

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

Also supported: `crossJoin`, `distinct`, `groupBy`, `having`, `offset`,
`ascending.nullsLast`, `is` / `isNot` (equality; `is(null)` compiles to
`IS NULL`), ordering comparisons, `in` / `notIn` (lists longer than 1,000 values
bind one array parameter on PostgreSQL: `= ANY($1::type[])`), `between`, `like`
/ `ilike`, `isDistinctFrom`, and `and` / `or` / `not`.

### Shape-first queries

Tables, aliases, relations, derived tables and CTEs are callable. Pass a
projection followed by an optional options object. The projection's keys
describe the result; options describe filtering, ordering and pagination:

```ts
const feed = database.users(
  ({ name, posts }) => {
    const published = posts(() => ({}), {
      where: ({ state }) => state.is.published,
    });

    return {
      name,
      publications: published.count(),
      posts: published(
        ({ title, editor, tags }) => ({
          title,
          editor: editor(({ name }) => ({ name })),
          tags: tags(({ label }) => ({ label })),
        }),
        {
          orderBy: ({ createdAt, id }) => [createdAt.descending, id.descending],
          limit: 3,
        },
      ),
    };
  },
  {
    where: ({ posts }) => posts.some(({ state }) => state.is.published),
    orderBy: ({ id }) => id.ascending,
    limit: 20,
  },
);

await feed;
```

Each nested limit applies per parent. To-many relations produce arrays
(including `[]`); to-one selections produce an object or `null`, with
conservatively nullable types even for required relations. Automatic paths such
as `post.editor.name` retain their existing JOIN behavior and scalar
nullability.

| Option                  | Value                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `where`, `having`       | Predicate or array of predicates combined with `AND`; use `or(...)` for alternatives |
| `orderBy`               | One ordering expression or a nonempty array                                          |
| `groupBy`               | Nonempty array of SQL expressions                                                    |
| `limit`, `offset`       | Nonnegative safe integer or prepared number parameter                                |
| `distinct`              | Boolean; replaces the DISTINCT flag when supplied                                    |
| `forUpdate`, `forShare` | `true` or `{ of?, noWait?, skipLocked? }`; `false`/`undefined` omit the request      |

Every option accepts the listed value or a synchronous
`(source, tools) => value` callback. Callbacks receive the projection's full
source and SQL tools, including columns that are not selected. `undefined`
values are ignored. Empty predicate arrays add no restriction; unknown option
names are rejected. The exported `QueryOptions<Source, Tools>` type can describe
shared options.

A projection holds fields only; a `$`-prefixed key in it is rejected. Option
callbacks run after the projection on the same source, so they can reach the
JOINs it made: relation paths such as `post.author.name` reuse the JOIN of
`innerJoin(post.authorId)`, and `innerJoin(source)` without an ON callback
returns the JOIN of a source the projection joined once. A source or relation
joined several times is addressed through its explicit alias, for example
`innerJoin(user.posts.as("first"))`. Filters, ordering and grouping append
across calls; LIMIT/OFFSET and DISTINCT replace previous values when supplied.

An options-only branch preserves the previous projection:

```ts
const page = feed({ limit: 10 });
```

An unselected query cannot execute until fields are selected. An empty shape
with no controls is rejected unless its callback added JOINs. Nested ordinary
objects only change the result structure; they do not imply SQL grouping.

An options-only call also starts a reusable filtered source:
`database.posts({ where: ({ state }) => state.is.published })`. Select fields
before executing it. Relations accept the same form; applying a limit or offset
removes their `some` / `none` / `every` methods, as with inline pagination.

Fixed numeric LIMIT/OFFSET counts compile as validated integer literals.
Explicit prepared count parameters remain placeholders and are validated when
bound. This lets PostgreSQL cost fixed pagination with the actual counts,
including generic plans.

For row-lock controls, PostgreSQL emits the requested lock. Choose one lock mode
and one of `noWait` / `skipLocked`. `of` names must identify sources in the
query, including aliases introduced by local JOINs.

#### Local JOINs

The second callback argument supplies `join`, `innerJoin`, `leftJoin` and
`crossJoin`. **`join(reference)` is the smart JOIN**: INNER for required forward
foreign keys, LEFT for optional/reverse/junction relations, propagating LEFT
through optional ancestors. Both SQL and handle types reflect that choice.

A relation or direct FK column supplies its ON condition from the schema.
Explicit `innerJoin` and `leftJoin` also accept a table, alias or CTE with an ON
callback receiving the joined source's columns. `crossJoin(source)` also accepts
a relationship or FK column to infer the target, but always produces a Cartesian
product without ON:

```ts
database.posts(
  (post, { join, leftJoin }) => {
    const author = join(post.authorId);
    const editor = leftJoin(database.users.as("reviewer"), (user) => [
      user.id.is(post.editorId),
      user.active.is(true),
    ]);

    return {
      title: post.title,
      author: author.name,
      editor: editor.name,
    };
  },
  { where: (post, { join, leftJoin }) => post.state.is.published },
);
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
Local helpers are valid during their own synchronous projection and option
callbacks. Their handles belong to that query; duplicate explicit aliases and
foreign bindings are rejected.

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
contains one or more ordinary fields; pass options when applying the projection.
Projections do not capture a connection. A row-local projection (columns and
scalar SQL tools only) also serves as a `returning()` selector for writes on the
same table; see [INSERT, UPDATE, DELETE](#insert-update-delete).

For example, define a projection on the offline registry, then use it on a
connected database, an alias or the corresponding relation:

```ts
const postCard = appSchema.posts.shape((post) => ({
  title: post.title,
  status: post.state.match({ draft: "Draft", published: "Published" }),
}));

database.users(({ name, posts }) => ({
  name,
  recent: posts(postCard, {
    where: ({ state }) => state.is.published,
    orderBy: ({ createdAt, id }) => [createdAt.descending, id.descending],
    limit: 3,
  }),
}));
database.posts(postCard, { where: ({ views }) => views.above(0n) });
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

All public SQL expression helpers are available in the second callback argument,
with their original types. They also remain available as named imports:

| Category                | Helpers                                                     |
| ----------------------- | ----------------------------------------------------------- |
| Predicates              | `and`, `or`, `not`, `when`, `exists`, `notExists`           |
| Aggregates and fallback | `count`, `sum`, `average`, `minimum`, `maximum`, `coalesce` |
| Windows                 | `rowNumber`, `rank`, `denseRank`, `lag`, `lead`, `over`     |
| SQL template            | `sql`                                                       |
| Local narrowing         | `whereNotNull`                                              |

```ts
database.posts(
  (post, { join, count, sum }) => {
    const author = join(post.author);
    const publications = count();

    return {
      author: author.name,
      publications,
      views: sum(post.views),
    };
  },
  {
    where: (post, { join, count, sum }) => post.state.is.published,
    groupBy: (post, { join, count, sum }) => [author.name],
    having: (post, { join, count, sum }) => publications.above(2),
    orderBy: (post, { join, count, sum }) => publications.descending,
  },
);
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
  best: ranked(
    (post) => ({
      title: post.title,
      position: post.position,
    }),
    {
      where: (post) => [post.authorId.is(user.id), post.position.atMost(3)],
      orderBy: (post) => post.position.ascending,
    },
  ),
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

Compose queries by calling them again. Options-only calls preserve the selected
fields; supplying ordinary fields replaces the projection. Filters, ordering and
grouping append, while LIMIT/OFFSET replace their previous values when supplied:

```ts
const published = database.posts({ where: (post) => post.state.is.published });
const titles = published((post) => ({ title: post.title }));
const recent = titles({ orderBy: (post) => post.id.descending, limit: 10 });
```

Each branch is immutable. Callbacks receive the root source directly (`post`);
local JOINs are accessed through their handles inside the callback.

The selected query retains `.as()`, `.cte()`, `.recursive()`, `.prepare()`,
`.inspect()`, `.first()`, `.one()`, `.maybeOne()`, `.count()`, `.exists()`,
`.page()` and `.pages()`. `count()` and `exists()` also work before a selection:
`db.posts.count()`, `db.posts({ where }).exists()` and
`db.users.byId(7).exists()`; a limited, grouped or distinct source counts its
result rows. An object selection containing exactly one scalar expression
supports `.scalar()` and column `.in(query)` / `.notIn(query)`. For example,
`database.posts((post) => ({ id: post.id }), { limit: 1 }).scalar()` is a typed
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
  posts: user.posts(
    (post) => ({
      title: post.title,
      editor: post.editor((editor) => ({ name: editor.name })),
    }),
    {
      where: (post) => post.views.above(0n),
      orderBy: (post) => post.createdAt.descending,
      limit: 3,
    },
  ),
}));
// { name: string; posts: { title: string; editor: { name: string } | null }[] }[]
```

Collections compile to correlated JSON aggregation in **one statement**, with
LIMIT/OFFSET applied per parent. They can contain further relation collections,
including many-to-many and self relations. Empty collections are `[]`; a to-one
shape returns an object or `null`. Use `orderBy` for deterministic array
ordering. Bigint, numeric, dates and custom codecs decode recursively.
Parameters in filters and LIMIT/OFFSET work with `prepare()`.

Method names (`count`, `exists`, `as`, etc.) belong to the relation API. If a
related table has a column with such a name, access it inside its shape
callback, where row fields retain their normal names.

### Filter related rows

```ts
database.users(
  (user) => ({
    name: user.name,
  }),
  { where: (user) => user.posts.some((post) => post.views.above(0n)) },
);

database.users(
  (user) => ({
    name: user.name,
  }),
  { where: (user) => user.posts.none((post) => post.title.is("Untitled")) },
);

database.users(
  (user) => ({
    name: user.name,
  }),
  { where: (user) => user.posts.every((post) => post.editorId.isNot(null)) },
);
```

`some` uses EXISTS; `none` and `every` use NOT EXISTS. `some()` / `none()` also
accept no predicate. For an empty relation, `some` is false and `none` / `every`
are true. `every` treats SQL NULL as a failed predicate (`IS NOT TRUE`). Filters
can nest and follow to-one paths. Quantifiers apply before LIMIT/OFFSET;
paginated collections still support shape callbacks, aggregates and `.exists()`,
with pagination included in their result.

### Conditional filters and narrowing

```ts
query({
  where: (posts) =>
    and(
      when(search, (search) => posts.title.ilike(`%${search}%`)),
      when(authorId, (authorId) => posts.authorId.is(authorId)),
    ),
});

database.posts((post, { whereNotNull }) => ({
  editorId: whereNotNull(post.editorId), // number, not number | null
}));
```

Import `and` and `when` from `symmetria`. `when` skips only null/undefined;
zero, false and empty strings are values. Empty AND is TRUE; empty OR is FALSE.
Predicate lists in `where`, `having`, JOIN conditions, `and()`, `or()` and
mutation `where()` skip `undefined`, `null` and `false` entries, so optional
filters read
`[q && title.ilike(q), minPrice !== undefined && price.atLeast(minPrice)]`
without branching; a mutation list that filters down to nothing still means
`WHERE TRUE`, and a single `false` returned from a mutation callback is an error
rather than "no filter". `whereNotNull()` adds a predicate and returns a
narrowed expression.

### Cursor pages

```ts
const pageQuery = database.posts(
  (post) => ({
    title: post.title,
  }),
  { orderBy: (post) => [post.createdAt.descending, post.id.descending] },
);

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
columns, computed fields or raw SQL over root columns, and include a full PK or
a non-null unique column. Both directions and NULLS FIRST/LAST work; ordering
keys can be omitted from the projection. Cursor values preserve PostgreSQL
timestamp microseconds and storage precision. Cursors are checked against the
query, its parameters, ordering and the value formats of the ordering columns;
expressions are treated as nullable. Use `sql.of(column)` to declare the storage
type of raw expressions. The initial API covers root-table queries without
joins, grouping, DISTINCT, LIMIT or OFFSET. Every page carries `nextCursor` and
`previousCursor`: pass `after` to move forward or `before` to move back (never
both); items always arrive in the declared order. A `null` cursor marks the last
or first page. A backward page that finds no rows cannot name a next cursor, so
keep the cursor you came from.

### Streaming rows

```ts
for await (const row of database.events(exportShape).stream({ size: 1000 })) {
  writer.write(row);
}
```

`stream()` runs any SELECT through a PostgreSQL server-side cursor: it reserves
a connection, declares a `NO SCROLL` cursor, fetches `size` rows at a time
(default 1000) and closes the cursor when iteration ends, including on an early
`break` or an error. Memory stays flat regardless of the result size. Inside
`$transaction` the stream uses the transaction's connection and sees its
uncommitted writes; the transaction stays usable between rows. Unlike `pages()`,
no ordering key is required, but the reserved connection is held until the loop
finishes, so do not keep a stream open while waiting on unrelated work.

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
const profilingServer = await profiler.serve(); // 127.0.0.1:7331

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

Every request to the endpoint needs the server's token in an `X-Symmetria-Token`
header, because captured SQL and parameters are as sensitive as
`EXPLAIN ANALYZE`, which re-executes the statement. `serve()` takes the token
from its `token` option, else from `SYMMETRIA_PROFILE_TOKEN`, else generates one
and returns it as `profilingServer.token`. The simplest setup exports
`SYMMETRIA_PROFILE_TOKEN` (at least 16 printable characters) in both terminals:
`symmetria profile` reads the same variable, or takes `--profile-token`. The
server binds to `127.0.0.1` or `::1`, validates the request Host, rejects
cross-origin browser requests and answers with `Cache-Control: no-store`.

`createProfiler({ capacity, queryCapacity })` keeps the last 200 requests and
the last 1,000 queries of each request by default; older queries are dropped and
counted in `droppedQueries`.

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
    database.posts(
      (post) => ({
        id: post.id,
        title: post.title,
      }),
      {
        where: (post) => [
          post.authorId.is(parameters.authorId),
          post.title.ilike(parameters.title),
        ],
        limit: parameters.size,
      },
    ),
);

searchPosts.toSQL({ authorId: 1, title: "%SQL%", size: 20 });
const posts = await searchPosts({ authorId: 1, title: "%SQL%", size: 20 });
// { id: number; title: string }[]
```

A prepared query is callable: `await searchPosts(values)` executes it, and the
detached `searchPosts.execute(values)` and `searchPosts.toSQL(values)` methods
do the same without the object (`const { execute } = searchPosts`). Prepared
SELECTs keep the query terminals with the values as their first argument:
`one(values)`, `maybeOne(values)`, `first(values)`, `count(values)`,
`exists(values)` and `inspect(values, options?)`. Lookup writes are prepared the
same way:
`prepare({ id: int }, (p) => database.users.byId(p.id).update({ active: false }))`.

The factory runs once and SQL is compiled once. Each execution binds a fresh set
of typed values through the column codecs. SELECT, INSERT, UPDATE, DELETE,
RETURNING, subqueries, and parameterized LIMIT/OFFSET share this mechanism.
Parameter names and values are required; use `.nullable` to accept `null`. Query
structure, selected fields and the number of IN-list elements stay fixed.
Placeholders belong to their factory and cannot escape into another query.
Prepared LIMIT/OFFSET parameters accept nonnegative safe integers, including
zero. Fixed counts still compile as literals, even inside a prepared query.

A query with fixed values can use `query.prepare()` and then call the result
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

// Unique lookups write directly, in one statement.
await database.users.byId(author.id).update({ name: "Ada Lovelace" });
await database.posts.by.slug("sql-first").delete();

await database.posts.insert({ title: "SQL first", authorId: author.id });

await database.posts
  .update((posts) => ({ views: posts.views.plus(1) }))
  .where((posts) => posts.title.is("SQL first"));

await database.users
  .insert({ name: "Ada" })
  .onConflict("name")
  .doUpdate("name");

await database.posts.delete().where((posts) => posts.views.is(0));

// Whole-table writes must be spelled out; a missing where() is refused.
await database.posts.update({ published: false }).all();

// Relation paths and quantifiers work in UPDATE/DELETE predicates.
await database.posts.delete().where((posts) => posts.author.name.is("Ada"));
await database.users
  .update({ active: false })
  .where((users) => users.posts.none());
```

Bulk INSERT accepts arrays, including rows with different omitted defaults. An
array whose parameters exceed the driver's wire-protocol limit (65,535 on
PostgreSQL) runs as several INSERT statements in one transaction, or in a
savepoint inside one, with `RETURNING` rows concatenated in order. An
`undefined` field is omitted, as with query options, so optional request fields
can be passed through; required columns still fail when `undefined`, and unknown
keys fail even when `undefined`. Nullable references accept `undefined` in the
nested form too (`editor: body.editor` with `{ connect }` or nothing).
`insert([])` executes no statement and resolves to `{ affectedRows: 0 }` or `[]`
with `returning()`; its `toSQL()` throws. `defaultValue` explicitly emits SQL
`DEFAULT`. Mutations resolve to `{ affectedRows }` without `returning()`. With
`returning()`, `insert(object)` resolves to one row (`null` when
`onConflict().doNothing()` skipped it) and `insert(array)`, UPDATE and DELETE
resolve to arrays. `bigint` columns accept safe integers on write and in
comparisons. Relation paths in `where()` compile to a primary-key subquery
(`WHERE "posts"."id" IN (SELECT ... JOIN ...)`), so they need a primary key.
UPDATE/DELETE without `where()` are refused when compiled; `.all()` spells out a
deliberate whole-table write. Scoped databases and lookups count as
restrictions. `where()` may return an array of predicates combined with `AND`,
like the `where` option; an empty array adds no restriction.
`onConflict().doNothing()` handles conflicts. `doUpdate("name", "active")`
assigns those fields from `excluded`; object and callback forms support custom
assignments. `doUpdate(values, { where: (current, incoming) => … })` updates the
conflicting row only when the condition holds, for example
`incoming.version.above(current.version)`; otherwise nothing is written,
`affectedRows` is `0` and a single-row `returning()` resolves to `null`. Scoped
databases combine their scope with the condition. Generated and computed fields
cannot be written through the shorthand. `returning()` callbacks receive the
scalar tools as a second argument (`and`, `or`, `not`, `when`, `coalesce`,
`sql`).

`returning()` also accepts a reusable projection of the same table, in flat and
nested inserts, updates and deletes. The projection must stay row-local: plain
columns and scalar SQL tools such as `sql`, `coalesce` or `when`. Relations,
aggregates, window functions, subqueries and `$` controls are rejected, and a
projection of another table is rejected as well:

```ts
const userCard = database.users.shape(({ id, name }, { sql }) => ({
  id,
  name,
  upper: sql.of(text)`upper(${name})`,
}));

const created = await database.users
  .insert({ name: "Ada" })
  .returning(userCard);
// { id: number; name: string; upper: string }
const renamed = await database.users
  .byId(created.id)
  .update({ name: "Ada Lovelace" })
  .returning(userCard);
// { id: number; name: string; upper: string }[]
```

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
  driver: postgres({ url: process.env.DATABASE_URL! }),
});

await database.users.by.email("ada@example.com").one();
await database.handles.by
  .identity({ tenant: "team", handle: "ada" })
  .maybeOne();

// Lookups also write: one UPDATE or DELETE, no preliminary SELECT.
await database.users.by.email("ada@example.com").update({ name: "Ada" });
await database.handles.by.identity({ tenant: "team", handle: "ada" }).delete();
```

`.by` is inferred from `.unique` columns and table-local named, unconditional
unique indexes over plain columns. Composite keys require all fields. Lookups
select all root columns, including computed fields, and compose with ordinary
query methods and prepared parameters. Null/undefined keys are rejected. Partial
and expression indexes are excluded; use explicit predicates for them.
Primary-key lookup remains `.byId(...)`, including non-`id` and composite keys.

`.update()` and `.delete()` on a lookup keep the source's write types, `$scope`
filters and transaction binding, accept prepared parameters in the key, and
return `{ affectedRows }` or, with `returning()`, an array of rows. The methods
can be detached: `const { update } = database.users.by.email("ada")`.

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
  target field. `undefined` fields, operations and relations are omitted. It
  chooses the first populated unique key (PK, unique columns, then indexes) and
  uses `ON CONFLICT DO UPDATE` on those key fields. Existing non-key fields are
  preserved; database UPDATE triggers can run. Supply only the intended
  identifying key when several alternatives exist.

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

await ranked(
  (post) => ({
    id: post.id,
    position: post.position,
    runningViews: post.runningViews,
  }),
  { where: (post) => post.position.atMost(3) },
).execute();
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
  .nodes(
    (node) => ({
      id: node.id,
      name: node.name,
    }),
    { where: (node) => node.id.is(rootId) },
  )
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

const totals = database.posts(
  (post, { innerJoin }) => {
    const author = innerJoin(post.authorId);

    return {
      name: author.name,
      total: count(),
      views: sum(post.views),
    };
  },
  {
    groupBy: (post) => [post.author.name],
    having: (_post, { count }) => count().above(1),
  },
);

const activeAuthors = database.users((user) => ({ name: user.name }), {
  where: (user) =>
    exists(
      database.posts((post) => ({ id: post.id }), {
        where: (post) => post.authorId.is(user.id),
      }),
    ),
});
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
  viewed: users.posts({ where: (posts) => posts.views.above(0n) }).count(),
  hasPosts: users.posts.exists(),
  totalViews: users.posts.sum.views,
  averageViews: users.posts.average.views,
  latestPost: users.posts.maximum.createdAt,
  weightedViews: users.posts.sum((post) => post.views.multiply(2n)),
}));
```

| Method                                                     | Result                                           | Empty input |
| ---------------------------------------------------------- | ------------------------------------------------ | ----------- |
| `count()`                                                  | `number`                                         | `0`         |
| `exists()`                                                 | `boolean`                                        | `false`     |
| `sum.column`, `average.column`, `sum(row => expression)`   | Decimal `string \| null`                         | `null`      |
| `minimum.column`, `maximum.column`, `maximum(row => expr)` | Column or expression type and codec, plus `null` | `null`      |

A plain column aggregates through a property (`posts.sum.views`); expressions
use the callback form. `sum` and `average` accept numeric, bigint and decimal
columns only; `minimum` and `maximum` accept any column. Both forms compile to
the same SQL. Value aggregates ignore SQL NULL; an all-NULL input also produces
`null`. Filtering applies before aggregation. LIMIT/OFFSET select the input rows
per parent:

```ts
database.users((user) => {
  const recent = user.posts({
    where: (post) => post.state.is.published,
    orderBy: (post) => [post.createdAt.descending, post.id.descending],
    limit: 3,
  });

  return {
    name: user.name,
    recentCount: recent.count(),
    recentViews: recent.sum.views,
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

`sql.of(column)` types and decodes the fragment like that column type, on every
driver and inside nested JSON: ``sql.of(bool)`${posts.views} > 0` `` returns
booleans, ``sql.of(timestamptz)`…` `` Dates and ``sql.of(bigint)`…` `` bigints.
Raw fragments are parenthesized wherever they are operands.

## Nested relations

```ts
const authors = await database.users(
  (user) => ({
    name: user.name,
    posts: user.posts(
      (post) => ({
        title: post.title,
        editor: post.editor((editor) => ({ name: editor.name })),
      }),
      { orderBy: (post) => post.id.ascending },
    ),
  }),
  {
    where: (user) => user.name.ilike("A%"),
    orderBy: (user) => user.name.ascending,
    limit: 20,
  },
);
```

Nested 1:1, 1:M and M:N loads use one statement with correlated subqueries and
JSON aggregation. Missing collections are `[]`; missing optional single
relations are `null`. Root pagination applies to parents. Ordinary JOINs retain
SQL row multiplication. Specify `orderBy` for deterministic nested collection
order.

When a paginated query projects nested collections, relation aggregates or
`exists()`, Symmetria restricts the root rows first in a derived table that
keeps the root alias, and evaluates the subqueries only for the resulting page;
the outer `ORDER BY` is repeated. The rewrite applies at every nesting level and
is skipped for `distinct`, `groupBy`, `having`, row locks, local JOINs, window
functions, bare aggregates, raw SQL in projections or orderings, orderings by a
correlated subquery and shared aggregates. Raw SQL is opaque: it may hide a
window, aggregate or volatile expression, so it keeps its original evaluation
scope. Raw expressions inside a nested query block only that query's rewrite.

## Values and drivers

- `bigint` → JavaScript `bigint`, `numeric(precision, scale)` → decimal
  `string`. Writes and comparisons also accept safe integers for `bigint`
  columns.
- `jsonb<Value>()` → `Value`, `timestamptz` → `Date`.
- `smallint`, `real` and `doublePrecision` → `number` (`NaN` and `±Infinity`
  round-trip; `smallint.auto` is an identity column). `date` → `"YYYY-MM-DD"`
  text with no time-zone shift, `time` → `"HH:MM:SS"` text, `interval` →
  PostgreSQL's text form such as `"1 day 02:00:00"`, `inet` → text, `bytea` →
  `Uint8Array`. The `symmetria/pg` adapter reads `date` and `interval` as text
  so both drivers agree.
- `jsonb(schema)` takes any [Standard Schema](https://standardschema.dev) object
  (Zod, Valibot, ArkType, …), infers the value type from it and validates every
  written and read value synchronously; invalid data throws with the issue
  paths.
- `text.array`, `int.array`, `uuid.array`, `timestamptz.array`, … → `string[]`,
  `number[]`, … stored as PostgreSQL arrays. See [Arrays](#arrays) and
  [full-text search](#full-text-search).
- `customType<Value>(sqlType, { encode, decode })` defines application codecs.
- `uuid.v4.brand("UserId")` adds a TypeScript brand inherited by FK fields. Use
  `Branded<string, "UserId">` to name the value type; SQL remains ordinary UUID.
- `schema(definitions, { executor })` accepts a custom execution function
  returning `{ rows, affectedRows }` (or an array of rows). JSON parameters use
  serialized text with explicit SQL casts. Selected aliases identify result
  keys.
- `await database.$close()` closes the configured driver's pool.

### PostgreSQL adapters

```ts
import { postgres } from "symmetria/pg"; // Node.js or Bun; install pg
// import { postgres } from "symmetria/bun"; // Bun's built-in SQL pool

const driver = postgres({ url: process.env.DATABASE_URL!, max: 10 });
const database = createDatabase({ schema: appSchema, driver });
```

`symmetria/driver` re-exports `symmetria/pg`. Both adapters compile the same
PostgreSQL SQL and normalize execution results to `{ rows, affectedRows }`. The
`pg` adapter accepts `pg.PoolConfig` options plus `url` and `profiler`; the Bun
adapter accepts Bun SQL PostgreSQL options plus `profiler`. Both preserve bigint
and numeric values. The `pg` adapter installs parsers per pool, leaving global
node-postgres configuration untouched.

Transactions and nested savepoints reserve a single connection. Use
`driver.session(async session => { ... })` for connection-local settings,
temporary tables and advisory locks across statements. A session provides
`execute`, `transaction` and `cancel`; cancellation uses a separate connection
and works with a one-connection application pool. Await every operation before
returning from transaction/session callbacks. Their handles expire afterwards.

`driver.close()` rejects new work, drains already accepted queries, transactions
and sessions, then closes the pools. Repeated close calls share the same
promise. Ordinary SQL errors preserve healthy connections; disconnected clients
are discarded. All schema and query APIs also support custom PostgreSQL
executors.

## Arrays

```ts
const posts = table({
  id: int.auto,
  title: text,
  tags: text.array,
  scores: bigint.array.nullable,
});
const database = createDatabase({
  schema: schema({ posts }),
  driver: postgres({ url: process.env.DATABASE_URL! }),
});

database.posts(
  (post) => ({
    id: post.id,
    tagCount: post.tags.length(), // cardinality("tags")
  }),
  { where: (post) => post.tags.has("sql") }, // $1 = ANY("tags")
);
database.posts(
  (post) => ({
    id: post.id,
  }),
  { where: (post) => post.tags.contains(["bun", "sql"]) },
); // @>
database.posts(
  (post) => ({
    id: post.id,
  }),
  { where: (post) => post.tags.overlaps(["bun", "deno"]) },
); // &&
```

Array parameters are sent as PostgreSQL array literals with an explicit cast;
elements use the column's codec, so `bigint[]` and `timestamptz[]` round-trip
exactly.

## Full-text search

```ts
import { tsvector, searchDocument, sql } from "symmetria";

const posts = table({
  id: int.auto,
  title: text,
  body: text.nullable,
  document: tsvector.nullable, // optional stored vector
}).indexes((posts) => ({
  // The index expression is the query expression, so the planner uses it.
  search: index(
    searchDocument({ A: posts.title, B: posts.body }, { language: "english" }),
  ).using("gin"),
}));

database.posts(
  (post) => {
    const document = searchDocument(
      { A: post.title, B: post.body },
      { language: "english" },
    );

    return {
      title: post.title,
      relevance: document.searchRank("bun sql", {
        weights: [0.1, 0.2, 0.4, 1],
        normalization: 32,
      }),
      snippet: post.body.searchHeadline("bun sql", {
        language: "english",
        startSel: "<b>",
        stopSel: "</b>",
        maxWords: 20,
      }),
    };
  },
  {
    where: (post) =>
      searchDocument(
        { A: post.title, B: post.body },
        { language: "english" },
      ).search("bun sql"),
    orderBy: (post) =>
      searchDocument(
        { A: post.title, B: post.body },
        { language: "english" },
      ).searchRank("bun sql").descending,
  },
);
```

`text.search(query, options)` compiles to
`to_tsvector(language, column) @@ <parser>(language, query)` and `searchRank()`
to `ts_rank(...)`; the configuration defaults to `"simple"`. A `tsvector` column
is matched and ranked as it is, without `to_tsvector()`. `options.mode` picks
the parser: `websearch` (default; quoted phrases, `or`, `-excluded`), `plain`
(all words), `phrase` (the words in order) or `raw` (`to_tsquery` syntax such as
`post:*`, which raises on malformed input, so do not pass user text unchecked).

`searchDocument(parts, { language })` builds one document from a column, an
array of columns, or a weight map `{ A, B, C, D }`; each part is wrapped in
`coalesce(…, '')` and weighted with `setweight()`, and queries against the
document use its configuration unless they name another. Declaring the same
expression with `index(...).using("gin")` in `.indexes()` makes the GIN index
usable by the query.
`searchRank(query, { weights, normalization, coverDensity })` passes
PostgreSQL's weight array (in D, C, B, A order), the normalization bitmask and
switches to `ts_rank_cd()`. `searchHeadline(query, options)` renders
`ts_headline()` on text columns; `startSel`, `stopSel`, `maxWords`, `minWords`,
`shortWord`, `highlightAll`, `maxFragments` and `fragmentDelimiter` map to
PostgreSQL's options. Query strings bind as parameters and work with
`prepare()`.

Stored vectors are written by the application:
`insert({ title, document: sql.of(tsvector)\`to_tsvector('english', ${title})\`
})`(a plain string is rejected by the types). A`GENERATED ALWAYS …
STORED`column is not declarable yet; a trigger or the write path keeps the column current, or index`searchDocument()`
directly and skip the column.

## Vectors (pgvector)

```ts
import { schema, table, index, int, text, operatorClass } from "symmetria";
import { vector } from "symmetria/vector";

const documents = table({
  id: int.auto,
  content: text,
  embedding: vector(1536),
}).indexes((documents) => ({
  embedding: index(operatorClass(documents.embedding, "vector_cosine_ops"))
    .using("hnsw")
    .with({ m: 16, ef_construction: 64 }),
}));

export const appSchema = schema({ documents }, { extensions: ["vector"] });

await database.documents.insert({ content, embedding: await embed(content) });

const matches = await database.documents(
  (doc) => ({
    content: doc.content,
    distance: doc.embedding.cosineDistance(query),
  }),
  {
    orderBy: (doc) => doc.embedding.cosineDistance(query).ascending,
    limit: 5,
  },
);
```

`vector(n)` from `symmetria/vector` declares a pgvector column; `vector()`
accepts any length, but indexes need a fixed one. Embeddings are written and
read as plain `number[]`; the row type is the branded `Vector`, which has no
array or JSON methods. Distances return `number` and work in projections,
`where` and `orderBy`: `l2Distance` (`<->`), `cosineDistance` (`<=>`, 0 for the
same direction, 2 for opposite), `innerProduct` (`<#>`, PostgreSQL's negative
inner product, so smaller is more similar) and `l1Distance` (`<+>`, pgvector
0.7+). The argument is a `number[]`, another vector column or expression, or a
`prepare()` parameter declared with `vector(n)`; it binds as `$1::text::vector`.
Nearest-neighbour queries are `orderBy` a distance plus `limit`, which lets HNSW
and IVFFlat indexes serve them.

`schema(defs, { extensions: ["vector"] })` records the extension in the
snapshot: generated migrations start with `CREATE EXTENSION IF NOT EXISTS`,
`drift` reports `missing-extension`, and removing it from the schema leaves a
comment in the migration instead of dropping the extension, since other schemas
may depend on it.

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

Scope callbacks, UPDATE values and RETURNING callbacks see the table's columns
only; a relation path there is reported as such. Filter through relations in
`where()`, which compiles to a primary-key subquery.

`$scope()` returns a database with the same type whose reads, updates and
deletes of the scoped tables carry the predicate: root queries, `byId()`, unique
lookups, shape projections, relation paths, explicit joins (in `ON`), nested
collections and quantifiers. Inserts are not filtered: a scoped database writes
whatever row it is given. An upsert, however, never rewrites a row outside the
scope: `ON CONFLICT … DO UPDATE` carries the scope as its `WHERE`, and a
conflict the scope filters out throws with code `SYMMETRIA_OUT_OF_SCOPE` instead
of updating it. Nested `connect` only finds rows inside the scope and
`connectOrCreate` fails the same way for an existing row outside it. Scopes
compose: a scoped database can be scoped again and the predicates are ANDed.
Transactions inherit the scope, and `transaction.$scope()` narrows it further
inside the callback. Scope callbacks see the table's own columns and run each
time a query or write is built, so they may read a value that changes, such as
the current tenant.

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

const database = createDatabase({
  schema: schema({
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
  }),
  driver: postgres({ url: process.env.DATABASE_URL! }),
});

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

### Operator classes, storage parameters and vector indexes

`operatorClass(key, name)` wraps an index key with a PostgreSQL operator class,
for example `operatorClass(posts.title, "text_pattern_ops")` or
`operatorClass(docs.embedding, "vector_cosine_ops")`; the key may carry an
ordering. `.with({ m: 16, ef_construction: 64 })` adds storage parameters, and
`.using("hnsw")` / `.using("ivfflat")` select pgvector's access methods, which
take exactly one key without ordering or `INCLUDE`. Both appear in the snapshot
(`opclasses`, `with`), in generated DDL, in `drift` comparisons and in `pull`
output.

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
string referencing `tenants.code`; `tenants.by("slug")` references a unique
column instead. Composite foreign-key targets are not supported.

`.checks(callback)` receives typed columns and returns named predicates. Calls
append immutably; names become `<table>_<key>_check` in snake_case. CHECK
expressions use the same codecs and literal escaping as indexes. Aggregates,
subqueries and foreign callback scopes are rejected. PostgreSQL CHECK semantics
apply: both TRUE and NULL pass; use non-null columns to reject NULL values.

Keys and checks appear in snapshots, generated DDL and reversible migration
diffs. Checks and indexes that use a retyped or dropped column are rebuilt;
table and column renames keep them, renaming the constraints and indexes whose
names derive from the table or column (`RENAME CONSTRAINT`,
`ALTER INDEX … RENAME`) instead of rebuilding them.

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
- `forUpdate` / `forShare` acquire row locks. Options: `of: [alias]`,
  `noWait: true`, or `skipLocked: true`. Locks last until the transaction ends.
- Await all operations. An unfinished operation at callback exit causes
  rollback; query handles from a finished transaction/savepoint reject
  execution. Await an active savepoint before using its parent or starting a
  sibling savepoint; interleaved operations are rejected.
- A caught SQL error still aborts its transaction scope. Use a savepoint for
  recoverable SQL failures. `retries` re-runs the whole callback after a
  serialization failure or deadlock (SQLSTATE 40001 / 40P01), waiting
  `retryDelayMs` with exponential growth and jitter between attempts (default 10
  ms); each attempt gets a fresh connection, so the callback must be safe to
  repeat. `sqlState(error)` reads the SQLSTATE of a driver error.
- Ordinary `$createIndexes()` is transactional; `concurrently: true` is rejected
  by both types and runtime in a transaction context.

Custom drivers can implement the optional `Driver.transaction` capability and
the recursive `TransactionDriver` contract. An executor-only schema reports that
transactions require a capable driver. Transaction contexts expose no
`$close()`.

## Migrations

Start a project with `bunx --package symmetria-kit symmetria init`. It creates
modular tables, an offline schema,
`createDatabase({ schema: appSchema, driver: postgres({ url }) })`, migration
config and `.env.example`. Existing files are preserved. Repeating `init` on a
project with a migration config or migration history is a no-op, so it cannot
add a second template schema. Install `symmetria` and `symmetria-kit` in the
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
bun packages/kit/src/cli/index.ts --config examples/symmetria.config.ts

# Offline schema inspection and code-versus-snapshot diff.
bun packages/kit/src/cli/index.ts inspect posts --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts inspect --relations --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts diff --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts diff --sql --config examples/symmetria.config.ts

bun packages/kit/src/cli/index.ts generate change_name --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts migrate --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts status --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts rollback --config examples/symmetria.config.ts
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

Generation rejects dropped tables or columns and removed enum labels unless
`--allow-destructive` is explicitly supplied; the refusal lists each destructive
operation. A rename needs a `--diff` hint; it is never guessed from similar
names. The API uses `allowDestructive: true` for intentional removals. Column
declarations keep their order in `CREATE TABLE`; snapshot hashes ignore column
order so reordering source declarations does not create a migration.

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
rollback, init, pull and graph. `diff --sql` emits SQL. Terminal output includes
colored diffs, migration state and loading spinners with elapsed time; piped
output stays plain. `--no-color` and `NO_COLOR` disable colors, and
`--no-animation` disables the logo shimmer and spinner animation. Failed
migrations report the failing statement and the underlying PostgreSQL error.

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

- DDL covers extensions, tables, enums, identities, defaults, nullability,
  PK/FK, CHECK, unique constraints and indexes (operator classes, storage
  parameters and access methods included), with dependency-aware creation and
  removal.
- Explicit rename hints and directional `USING` conversions come from
  `generate <name> --diff changes.json`; names in that file are physical SQL
  names.
- `migrate --to <id>` applies through a target; `rollback --steps 2` reverts the
  latest two applied migrations in reverse order.
- `lint` inspects saved `up.sql` files and any ungenerated schema diff. It exits
  with code 1 for destructive or blocking findings by default; `--strict` also
  fails on cautionary findings. `--pending` uses database history to select only
  pending SQL files. Offline lint checks the entire saved chain, including
  previously applied migrations. Comments and quoted strings are not treated as
  SQL; function bodies, `DO`, `CALL` and other executable SQL require review.
  Static lint is conservative and does not prove a migration safe for every row.
  Adding a nullable column, or a `NOT NULL` column with a constant default, and
  renames pass without findings; a `NOT NULL` column without a default is
  generated as `ADD COLUMN` plus a `-- Backfill …` marker and `SET NOT NULL`, so
  the backfill can be written into the SQL before it is applied.
- `drift` compares the live database with the latest snapshot: missing or extra
  tables, columns and indexes; types, nullability, defaults and identity;
  primary, unique, foreign-key and check constraints; FK actions; enum labels
  and their order; invalid indexes and unvalidated constraints; index operator
  classes and storage parameters; declared extensions that are not installed.
  Use `--strict` for CI. It inspects the connection's `current_schema()`,
  independently of `metadataSchema`, and excludes only the journal in its
  configured schema.
- `squash <name>` replaces the chain with one baseline migration that creates
  the latest snapshot; databases that applied the old chain run `adopt`, which
  verifies the live schema before rewriting recorded history (`adopt --to <id>`
  chooses a baseline explicitly). An unchanged applied migration retains its
  exact boundary. If several replacement migrations have the same schema hash,
  use `--to` to identify the intended baseline; data-only migrations cannot be
  distinguished by their schema hash alone. Historical targets are reconstructed
  by replaying SQL into a disposable database using `verificationDatabaseUrl` /
  `--verify-url`. The API can instead accept `adopt({ to, snapshot })` when the
  supplied snapshot hash matches that target. The latest target uses the shared
  snapshot directly.
- Default migrate/rollback batches run in one transaction. A session-wide
  advisory lock covers all transaction boundaries. History defaults to
  `public._symmetria_migrations`. Config can override `metadataSchema` and
  `metadataTable`. `migrate` and `adopt` create a missing journal schema inside
  that transaction; `status` and `rollback` do not create it.
- Applied checksums cover SQL in both directions and journal entries, including
  their schema hashes. Adding a migration does not change earlier checksums.
  Missing, reordered or edited applied migrations are rejected before execution.
- Tables/types use the connection's `search_path`; metadata always uses its
  explicitly qualified schema. Config paths are relative to the config module;
  `--dir` paths are relative to the working directory.

Generated down SQL restores schema structure; it cannot recreate deleted data.
Data backfills and nontrivial conversions can be added to the SQL before
applying. Constraint violations or enum values that cannot be narrowed cause an
atomic rollback of the current transactional group. The runner manages
transaction boundaries; explicit `BEGIN`, `COMMIT` and savepoints in migration
files are rejected.

### Schema diagrams

`symmetria graph [file]` renders the declared schema, or the latest migration
snapshot when the config declares none, as a Mermaid `erDiagram`. Without a file
it prints the diagram; a `.md` target gets a `mermaid` fence, any other file
receives the bare diagram, and existing files need `--force`. Entities list each
column with its SQL type (enum columns show the enum type), `PK`, `FK` and `UK`
markers and `nullable` / `identity` notes; `--compact` prints entities and
relations only. Edges read parent to child: `||` exactly one parent, `|o`
optional parent (nullable foreign key), `o{` many children, `o|` at most one
child (unique foreign key); `--` marks identifying relations whose foreign key
is part of the child's primary key (junctions, one-to-one detail tables) and
`..` the others. `--json` returns `{ tables, edges }`; `schemaGraph(snapshot)`
and `renderMermaid(graph, { fenced, compact })` do the same in code.

### Adopting an existing database

`symmetria pull [file]` introspects the connection's `current_schema()` and
writes a schema module (default `schema.ts`; `--force` overwrites). The
connection comes from `--database-url`, the config when it loads, or
`DATABASE_URL`, so the command also works before any config exists. Tables are
declared in the keyed-callback form so declaration order and cycles do not
matter:

```ts
export const appSchema = schema({
  users: table({ id: int.auto, email: text.unique }),
  posts: ({ users }) =>
    table({
      id: int.auto,
      author: users.index.onDelete.cascade,
      editor: users.nullable.onDelete.setNull.inverse("postsByEditor"),
      title: text,
    }),
  postTags: ({ posts, tags }) =>
    junction({ post: posts.onDelete.cascade, tag: tags.onDelete.cascade }),
});
```

What maps directly: `integer` / `bigint` / `smallint` identities (`int.auto`,
`bigint.auto`, `smallint.auto`), `now()`, `gen_random_uuid()` and `uuidv7()`
defaults, literal defaults, `text`, `boolean`, `uuid`, `jsonb`, `timestamptz`,
`varchar(n)`, `numeric`, `smallint`, `real`, `double precision`, `date`, `time`,
`interval`, `bytea`, `inet`, arrays of those, enums owned by one column and
named `<table>_<column>_enum`, single-column foreign keys that reference a
single-column primary key or `UNIQUE` constraint (columns not named
`<relation>_id` are declared with `.column("<name>")`, unique targets with
`.by("<column>")`), junction tables whose primary key is exactly two such
foreign keys, composite primary keys, single-column unique constraints,
single-column btree indexes named `<table>_<column>_idx` and CHECK constraints.

Everything else is approximated and listed, with a `// pull:` comment on the
affected line and an entry in the command's review list (`warnings` in `--json`,
each with a `code` and often a `fix`):

- Constraints whose names differ from the derived `<table>_pkey`,
  `<table>_<column>_key`, `<table>_<column>_fkey` and `<table>_<key>_check` are
  declared with their meaning; the fix is the `RENAME CONSTRAINT`.
- Serial columns keep their `nextval()` default; a migration from the pulled
  schema will not create the sequence, so the fix converts them to identity.
- `GENERATED BY DEFAULT` identities are declared as `GENERATED ALWAYS`.
- Types without a builder (`money`, `timestamp without time zone`, ranges, …)
  and enums that are shared or named differently go through `customType()` with
  a passthrough codec, which hands over driver-native values.
- Composite, deferrable, cross-schema or `ON UPDATE` foreign keys and foreign
  keys to columns without a primary-key or `UNIQUE` constraint stay plain
  columns.
- Multi-column unique constraints, exclusion constraints, expression and partial
  indexes, generated columns and partitions are reported but not declared.
- Names that cannot be produced from a camelCase key (uppercase letters, double
  or leading underscores) are left out as comments.

After pulling, point the config at the module, run `drift` until only intended
findings remain, then `generate initial` and `adopt`. Programmatically,
`pullSchema({ execute, schemaName?, metadataSchema?, metadataTable? })` returns
`{ source, schemaName, tables, enumerations, warnings }`.

### Execution modes, timeouts and plans

`generate <name> --transaction batch|each|none` records the execution mode in
the shared journal. The API accepts the same `transaction` option:

- `batch` (default): adjacent batch migrations commit atomically as one group.
- `each`: commit this migration separately; earlier groups remain committed if
  it fails.
- `none`: each SQL statement commits independently. Use for
  `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY` or `VACUUM`.

Both directions use the recorded mode. Nontransactional work requires a driver
with pinned-session support, supplied by the official PostgreSQL driver.
Transaction-only custom drivers support the default atomic batch mode.

```sh
symmetria migrate --plan --json
symmetria rollback --steps 2 --plan
symmetria migrate --advisory-lock-timeout 10000 --lock-timeout 5000 --statement-timeout 600000
```

Plans include SQL, migration IDs, execution modes and transaction group numbers;
they do not execute migrations. Config/API settings `advisoryLockTimeoutMs`,
`lockTimeoutMs` and `statementTimeoutMs` use milliseconds and default to 10,000,
5,000 and 600,000 respectively. A zero advisory timeout tries the lock once;
zero disables the PostgreSQL DDL or statement timeout. Session settings are
restored when the operation finishes. The CLI cancels work on SIGINT/SIGTERM;
the API accepts an `AbortSignal`.

`status` reads the journal without taking the migration lock, so it reports
while another process is migrating; it exits with code 1 when an incomplete
migration needs repair.

`onEvent(event)` is a synchronous observer for `statement-start`,
`statement-end` and `statement-error`. Events include migration ID, direction,
one-based statement number, SQL and, after execution, duration. Errors expose
`MigrationExecutionError` with `migration`, `direction`, `statement`, `sql`,
`sqlState` and the underlying `cause`.

### Online DDL and recovery

`generate <name> --online` sets `transaction: "none"` and generates concurrent
indexes, `NOT VALID` / `VALIDATE CONSTRAINT` phases for checks and foreign keys,
and validated checks before setting existing columns to `NOT NULL`. New unique
constraints on existing columns use a concurrent unique index followed by
`UNIQUE USING INDEX`. Additive enum changes use `ALTER TYPE ... ADD VALUE` in
both modes (PostgreSQL 12+), preserving the type OID and dependent columns
without a table rewrite. Inside a transaction a new label cannot be used before
commit, so a transactional migration whose defaults or CHECKs already need the
new label rebuilds the type instead; `--online` commits each statement and keeps
`ADD VALUE`. Enum removals and reordering rebuild the type and rewrite dependent
columns.

For populated tables, introduce nullable columns first, deploy compatible code,
backfill in bounded batches, then generate a separate validation migration.
Online execution does not eliminate every lock: constraint attachment and
metadata changes still acquire short-lived locks. Review both SQL directions.

Before nontransactional SQL starts, the journal stores `incomplete`, direction
and a confirmed-statement count. Success changes it to `applied` (or removes it
after rollback). Failure or disconnect leaves a durable recovery boundary;
subsequent migrate, rollback and adopt refuse to proceed.

```sh
symmetria status --json
# Inspect and reconcile the affected objects and data, then choose a boundary:
symmetria repair 000003_email_index --action retry --verify-url "$VERIFY_DATABASE_URL"
# Or finish the migration manually and confirm its final schema:
symmetria repair 000003_email_index --action complete --verify-url "$VERIFY_DATABASE_URL"
```

`retry` verifies the schema at the starting boundary and resets the journal so
the unchanged SQL can run again. `complete` verifies the destination boundary
and records completion. The API is `runner.repair({ id, action, snapshot? })`. A
crash may occur after PostgreSQL commits but before the statement count is
saved; that count is not an exactly-once guarantee. Reconcile data changes as
well as schema before repair. Schema verification cannot establish whether a
backfill, external function or other data-only operation has already run.

Generation and squash use a durable filesystem publication journal. After a
process crash, `symmetria recover` restores the previous files or finishes
cleanup of a committed publication. It refuses a lock owned by a live process or
another host. Keep the SQL directories and both shared metadata files on the
same filesystem. A lock without readable ownership metadata requires manual
inspection.

### Disposable-database verification

```sh
symmetria verify --verify-url "$VERIFY_DATABASE_URL" --json
```

`verify` requires `--verify-url` or `verificationDatabaseUrl` in the config; it
never falls back to the application `DATABASE_URL`, because it creates and drops
databases on the server it is pointed at. The connection needs `CREATEDB`
permission. Kit creates uniquely named databases from `template0`, executes
migration SQL there, and drops them in `finally`. It checks a fresh installation
against the latest snapshot, then upgrades each boundary, rolls it back,
compares catalogs and reapplies it. A hard process or server crash can leave a
`symmetria_verify_*` database for manual cleanup. Use a PostgreSQL instance
matching the deployment version and required extensions.

For representative-data tests, use config `verify.beforeMigration` /
`verify.afterMigration`, or the equivalent `verifyMigrations` API hooks:

```ts
import { verifyMigrations } from "symmetria-kit";

await verifyMigrations({
  directory: "./migrations",
  url: process.env.VERIFY_DATABASE_URL!,
  beforeMigration: async ({ driver, migration, phase }) => {
    if (migration === "000002_add_note" && phase === "up") {
      await driver.execute({
        sql: "INSERT INTO users (name) VALUES ($1)",
        parameters: ["existing user"],
      });
    }
  },
  afterMigration: async ({ driver, migration, phase }) => {
    // Assert application-specific data invariants using this disposable driver.
  },
});
```

Hooks run during the upgrade/rollback/reapplication pass; `phase` is `up`,
`down` or `reapply`. Configure `verify.schemaName` for a non-public application
schema. Managed catalog checks cover tables, columns, constraints, indexes and
enums; use hooks for data preservation and custom SQL objects such as functions
and views. Historical snapshots remain unnecessary.

Programmatic APIs are exported from `symmetria-kit`: `migrationSnapshot`,
`createSchemaSQL`, `diffSchemas`, `lintMigration`, `lintMigrationSQL`,
`detectDrift`, `generateMigration`, `squashMigrations`, `loadMigrations`,
`loadMigrationState` (returns `{ migrations, snapshot }`), and
`migrator({ driver, directory })` with `migrate`, `rollback`, `status`, `plan`,
`repair` and `adopt`; plus `verifyMigrations` and `recoverMigrationFiles`.
`loadMigrations` returns the SQL chain and checksums; historical migrations do
not carry snapshots. `generateMigration` and `squashMigrations` also return the
new snapshot.

`detectDrift({ execute, snapshot, schemaName, metadataSchema, metadataTable })`
accepts an explicit application `schemaName`; omitting it uses
`current_schema()`. The journal defaults to `public._symmetria_migrations`,
matching `migrator`.

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
requires Node 24 LTS for the bundler and Bun 1.4.4+ for the runtime.

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

Package validation and release commands: [publishing](publishing.md).

## License

MIT
