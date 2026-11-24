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
- [Query inspector](#query-inspector), [live profiler](#live-request-profiler)
  and [OpenTelemetry](#opentelemetry)
- [Prepared queries](#prepared-queries)
- [Writes](#insert-update-delete), [unique lookups](#unique-key-lookups) and
  [nested inserts](#atomic-nested-inserts)
- [CTEs and windows](#ctes-and-window-functions),
  [aggregates and subqueries](#aggregates-and-subqueries)
- [Nested relations](#nested-relations) and [value codecs](#values-and-drivers)
- [Relation aggregates](#relation-aggregates) and [cursor pages](#cursor-pages)
- [Arrays](#arrays) and [full-text search](#full-text-search)
- [Vectors](#vectors-pgvector) and
  [search by words and meaning](#search-by-words-and-meaning)
- [better-auth](#better-auth)
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
  one,
  maybe,
  many,
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
  posts: many,
  edited: many,
});
const tags = table({ id: int.auto, label: text.unique, posts: many });

const posts = table({
  id: int.auto,
  title: text,
  author: one(users.posts),
  editor: maybe(users.edited),
  tags: many(tags.posts),
  views: bigint.default(0n),
  state: oneOf("draft", "published").default("draft"),
  createdAt: timestamptz.now,
});

export const appSchema = schema({ users, posts, tags });
export const db = createDatabase({
  schema: appSchema,
  driver: postgres({ url: process.env.DATABASE_URL! }),
});
```

Names come from object keys; camelCase maps to snake_case. Columns are non-null
by default. `author: one(users.posts)` creates the `authorId` column, the
`author` relationship of a post and the `posts` of a user; `tags: many(…)` is a
many-to-many relation with its own junction table. The next section describes
these declarations, and
[the one after it](#reference-modifiers-and-the-earlier-spelling) the modifiers
of a reference and the spelling without slots.

### Relations: one, maybe, many

Both sides of a relation can be written where they live. The table that is
referenced declares a _slot_, a name for the rows that point at it, and the
table that holds the foreign key claims it:

```ts
import { table, one, maybe, many, self, int, text } from "symmetria";

const users = table({
  id: int.auto,
  name: text,
  posts: many, // user.posts
  edited: many, // user.edited
  profile: one, // user.profile, at most one row
  comments: many.cascade, // deleting a user deletes their comments
});
const tags = table({ id: int.auto, label: text.unique, posts: many });
const posts = table({
  id: int.auto,
  title: text,
  author: one(users.posts), // author_id NOT NULL, indexed; post.author
  editor: maybe(users.edited), // editor_id, nullable
  tags: many(tags.posts), // many-to-many: post.tags and tag.posts
});
const profiles = table({ id: int.auto, user: one(users.profile) }); // unique
const comments = table({
  id: int.auto,
  post: one(posts), // no slot named: posts.comments
  author: one(users.comments),
  parent: maybe(self.children), // a tree
  children: many,
});

export const appSchema = schema({ users, tags, posts, profiles, comments });
```

`one(users.posts)` is a required foreign key to `users`, `maybe(…)` an optional
one; both create an index on the key, which `.noIndex` leaves out. `users.posts`
is a property of the table, so the editor completes it, a mistyped slot is a
type error on that line, and "go to definition" jumps to the other side. A slot
is a name, not a column: the row of `users` has no `posts` field.

- A slot claimed by a key is the reverse relation under that name. `one` as a
  slot (`profile: one`) makes the key unique: a one-to-one.
- A slot may say what deleting the parent does to the rows that claim it:
  `many.cascade` deletes them, `many.setNull` clears the reference (the other
  side must be `maybe()`), `many.restrict` refuses the delete, which is also the
  default. The key can say it instead (`one(users.posts).cascade`), but not both
  with different answers.
- `one(users)` without a slot names the reverse side after the table that holds
  the key, as `author: users` does; if `users` has a slot of that name
  (`comments: many`), the two are the same relation.
- After `one()` / `maybe()`: `.cascade`, `.restrict`, `.setNull` (optional keys
  only), `.unique`, `.noIndex`, `.by("email")`, `.column("author_email")` and
  `.onUpdate.cascade`.
- `maybe(self.children)` claims a slot of the table being declared. TypeScript
  cannot read a property name off `self`, so the types pair the key with the
  table's one slot nothing else claims; a table with two relations to itself
  names them with `self.nullable.inverse("…")`, the
  [earlier spelling](#reference-modifiers-and-the-earlier-spelling).
- A slot nothing claims, a slot claimed twice and a slot named like a table
  method (`index`, `named`, …) are errors, in the types and when `schema()`
  runs.

`tags: many(tags.posts)` declares a many-to-many relation and creates its
junction table: `posts_tags` with `posts_id` and `tags_id` (the two relation
names), both keys as the primary key, an index on the second, and rows that go
when either side is deleted. It is a table of the schema, `db.postsTags`.
`.with({ addedAt: timestamptz.now })` adds columns to it, `.named("post_tags")`
sets its SQL name and `.restrict` makes a linked row undeletable instead. When
the junction should be declared by itself, both tables carry a bare slot and
`link()` joins them:

```ts
const tags = table({ id: int.auto, label: text.unique, posts: many });
const posts = table({ id: int.auto, title: text, tags: many });
const postTags = link(posts.tags, tags.posts, { addedAt: timestamptz.now });

// Named references instead of slots, as junction() takes them:
const members = link({ person: people, team: teams });
```

`link()` is `junction()` whose references cascade unless they say otherwise;
`junction()` keeps PostgreSQL's stricter default. Inside a `schema()` callback a
table is a keyed link and has no slots to name, so a key is written `one(users)`
or `maybe(users.inverse("edited"))` there; `symmetria pull` writes this form.

### Reference modifiers and the earlier spelling

A relation can also be written without slots, as a reference to the table
itself. This spelling is still accepted and can be mixed with slots in one
schema: `one(users.posts)` is `users.index.inverse("posts")`, and both produce
the same tables, constraints and migrations.

```ts
const posts = table({
  id: int.auto,
  title: text,
  author: users.index,
  editor: users.nullable.inverse("edited"),
});
const postTags = junction({ post: posts, tag: tags });
```

`author: users` creates `authorId` and the `author` relationship; `users.unique`
represents 1:1. `junction({ post: posts, tag: tags })` declares a many-to-many
link table: both foreign keys form its primary key and each side gains an M:N
relation. The primary key already serves lookups by its first key (`post_id`),
so `junction()` also creates an index on the second one (`post_tags_tag_id_idx`)
for the other direction. `.inverse("edited")` resolves ambiguous reverse names.

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

`self` refers to the table being declared, with the same modifiers as any other
reference: `parent: self.nullable.onDelete.cascade.inverse("children")` adds a
`parentId` column, a `parent` relation and, through `.inverse()`, a `children`
collection. A self-reference has no automatic reverse relation; name it with
`.inverse()` when you need one. `.onUpdate.cascade`, `.onUpdate.restrict` and
`.onUpdate.noAction` set the foreign key's `ON UPDATE` action (the default is
PostgreSQL's `NO ACTION`); databases created by Prisma use `.onUpdate.cascade`.

Every foreign key, a junction's included, is created `ON DELETE RESTRICT` unless
the reference says otherwise: deleting a row that other rows still point to
fails, and nothing is deleted or set to NULL on its own. `.onDelete.cascade`
deletes the referencing rows with it, `.onDelete.setNull` (the column becomes
nullable) clears the reference, and `.onDelete.noAction` is PostgreSQL's own
default, which checks at the end of the statement instead of immediately.

### SQL names

Keys decide SQL names: by default `createdAt` becomes `created_at` and a
reference `author` becomes `author_id`. Two tools cover databases that use other
names, such as the PascalCase tables and camelCase columns Prisma creates:

```ts
const user = table({
  id: int.auto,
  email: text.unique,
  createdAt: timestamp(3).default(sql`CURRENT_TIMESTAMP`),
}).named("User");
const post = table({
  id: int.auto,
  title: text,
  author: user.index.onUpdate.cascade, // "authorId"
  legacyCode: text.named("LEGACY_CODE").nullable,
}).named("Post");

export const appSchema = schema({ user, post }, { casing: "preserve" });
await db.post((post) => ({
  title: post.title,
  author: post.author.email,
}));
// FROM "Post" AS "post" INNER JOIN "User" … ON "post"."authorId" = …
```

`schema(definitions, { casing: "preserve" })` keeps keys as written: `createdAt`
stays `createdAt` and `author` becomes `authorId`. `.named("User")` on a table
and `.named("LEGACY_CODE")` on a column set any SQL name, under either casing;
`users.column("ownerID")` does the same for a foreign-key column. Constraint and
index names follow the SQL names (`User_pkey`, `User_email_key`,
`Post_authorId_fkey`, `Post_authorId_idx`), which are also Prisma's. Queries,
writes and migrations use the SQL names; shapes and results keep the keys. Two
tables or two columns that end up with the same SQL name are rejected when the
schema is built.

Derived names longer than PostgreSQL's 63-byte limit keep their first 50 bytes
and end in a 12-character hash of the full name, for constraints, indexes
(including `.indexes()` keys and automatic `.index` names) and checks alike, so
long table and column names never need shortening. A name written out in full,
such as a schema-level index name or `.named()`, is used as it is and must fit.
A result key is a JavaScript name, not an SQL one: a key longer than 63 bytes
(22 Japanese characters, for example) is selected under an alias made of its
first bytes and a hash of the whole key, and comes back under the key itself, at
the top level, in nested objects and relations, in `$batch`, `returning()`,
`page()`, `stream()`, derived tables (`.as()`) and CTEs. Keys that fit are their
own alias.

### Collations

`.collate("C")` sets a text column's collation, which decides how values compare
and sort: `"C"` compares bytes, so `'B' < 'a'` and `LIKE 'abc%'` can use a plain
index; a language collation such as `"en-x-icu"` sorts as people expect.

```ts
const products = table({
  id: int.auto,
  sku: text.collate("C").unique, // "sku" text COLLATE "C" NOT NULL
  name: varchar(200).collate("en-x-icu"),
}).indexes((product) => ({
  // An index key can use another collation than its column.
  byName: index(sql<string>`${product.name} COLLATE "C"`),
}));
```

`text`, `varchar` and text-like custom types accept it, before or after
`.array`; other types throw. Indexes on the column use its collation, and a
reference to the column creates its foreign-key column with the same one.
Migrations create the column with it, and a changed collation becomes
`ALTER COLUMN … TYPE text COLLATE "C"`, which rebuilds the indexes on the
column. `drift` reports a column whose collation differs (`collation-mismatch`)
and an index key whose collation differs (`index-mismatch`).

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
a collection on the target table.

Nothing guarantees a single match either: two users may share a name. A `.one()`
relation therefore resolves to the first matching row ordered by the target's
primary key, among the rows the target's `$scope()` admits, in every form: paths
(`post.author.name`), nested objects, join helpers, `count()` and quantifiers. A
post is never repeated and a nested `post.author(...)` never fails with "more
than one row". The JOIN compares the key with a subquery
(`ON "author"."id" = (SELECT … ORDER BY "id" LIMIT 1)`), which PostgreSQL runs
once per source row; an index on the compared column (`users.name`) keeps it
fast. The inverse agrees with it: `user.reviewed` lists a post only under the
user the post resolves to, in the same forms and in write filters
(`users.delete({ where: (user) => user.reviewed.some() })`), so a post is never
counted under two users. A `.one()` relation to a table without a primary key
throws when a query uses it or its inverse, because there is no stable "first";
declare a primary key or use `.many()`. The relation adds no column, no
constraint and nothing to migrations, drift or `pull`; it cannot be written
through nested inserts. `to()` accepts a standalone table, a thunk, a plain
column record or a keyed link
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
omitted from writes. `int.auto.byDefault` is `GENERATED BY DEFAULT AS IDENTITY`:
the database still numbers new rows, but an insert may also give its own id, as
with `serial` (useful while another application, such as a Prisma client, still
writes explicit ids). `smallint`, `real`, `doublePrecision`, `date`, `time`,
`interval`, `bytea` and `inet` are first-class builders (see
[Values and drivers](#values-and-drivers)). `numeric` and `varchar` work bare
(`price: numeric`, `code: varchar`) or with arguments (`numeric(10, 2)`,
`varchar(255)`). Passing a builder such as `jsonb` without calling it, a thunk
that returns a column, or a non-column value is reported with the table and
column name and a hint. `Infer<typeof db.users>` is the row type,
`InferInsert<typeof db.users>` the insert input, `InferUpdate<typeof db.users>`
the `update()` input and `InferShape<typeof card>` the row of a reusable shape
or a built query; all four also accept standalone `table()` handles. `uuid.v4`
works on PostgreSQL 14; `uuid.v7` needs PostgreSQL 18+.

## SELECT

Callable tables autocomplete columns and infer the exact result:

```ts
await db.users((user) => ({ id: user.id, name: user.name }));
await db.users.get(42); // the row; rejects when there is none
await db.users.find(42, (user) => ({ name: user.name })); // or null
await db.users.find({ email: "ada@example.com" }); // by a unique key
```

`get()` reads one row by its key and rejects with `NotFoundError` when there is
none; `find()` resolves to `null` instead. The key is the primary key's value,
or an object naming the columns of the primary key or of one unique key:
`get({ email })`, `find({ tenant: "team", handle: "ada" })` for a unique index
over two columns. Both take a shape as a second argument and reject (rather than
throw) for a malformed key or an object that is not a key of the table.

`get(42)` is `byId(42).one()` and `find(42)` is `byId(42).maybeOne()`; the
longer form is a query like any other, for a lock, a write or another terminal.
`one()` throws when there is no row or more than one, `maybeOne()` when there is
more than one. The error names the source and carries `code`:
`SYMMETRIA_RECORD_NOT_FOUND` for no row, `SYMMETRIA_TOO_MANY_ROWS` for several.

`byId()` starts a query on a table's primary key and selects all its columns,
including computed fields. It accepts the key's value type, including branded
values and prepared parameters. A key named `code` works the same way as `id`;
composite keys take an object with all key fields, for example
`memberships.byId({ tenantId: 1, userId: 42 })`. Keyless tables have no typed
`byId()`. It composes with shape callbacks and terminal query methods.

Every SELECT uses a shape callback. Local JOINs return typed source handles:

```ts
const query = db.posts(
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
const rows = await query;
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
db.posts((post, { innerJoin, join }) => {
  const reviewer = innerJoin(db.users.as("reviewer"), (user) =>
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
bind one array parameter on PostgreSQL: `= ANY($1::type[])`, or an untyped
`= ANY($1)` that PostgreSQL types from the column, as an enum needs; a list of
expressions binds one value each, and a statement over 65,535 values is refused
with a `QueryError` before it is sent; a `null` in the list is rejected where
the query is built, because SQL's `NOT IN (…, NULL)` matches no row: combine the
list with `is(null)` or `isNot(null)`), `between`, `like` / `ilike`,
`isDistinctFrom`, and `and` / `or` / `not`. On an enum, uuid, date, time,
interval or inet column, `like`, `ilike` and full-text search read the value as
text, as PostgreSQL prints it (`day.like("2024-%")`), and a comparison with a
text column compares it as text.

### Shape-first queries

Tables, aliases, relations, derived tables and CTEs are callable. Pass a
projection followed by an optional options object. The projection's keys
describe the result; options describe filtering, ordering and pagination:

```ts
const feed = db.users(
  ({ name, posts }) => {
    const published = posts({ where: { state: "published" } });

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

`where` also takes an object of equalities, and `orderBy` an object of
directions, `"asc"` or `"desc"` (`"ascending"` and `"descending"` mean the same,
as `id.asc` and `id.desc` are short for `id.ascending` and `id.descending`):

```ts
await db.posts({ where: { state: "published", editorId: null } });
db.users((user) => ({ name: user.name, written: user.posts.count() }), {
  orderBy: [{ written: "desc" }, { id: "asc" }],
});
```

Every key of a `where` object is a column of the source and must equal its
value; `null` is `IS NULL` and an `undefined` value leaves the key out, so
optional request fields can be passed through. It is the same SQL as
`[state.is("published"), editorId.is(null)]`; lists, ranges and relation paths
stay in the callback form. An `orderBy` key is a selected field or, failing
that, a column of the source. Column names are completed and checked by the
types; a selected field's name is checked when the query is built.

A query that is given options and no fields reads the source's own columns,
computed fields included: `await db.users({ where: { active: true } })`. A CTE
or a derived table reads the fields it was built with the same way,
`await ranked({ where: (post) => post.position.atMost(3) })`. A bare table is
not such a query (`await db.users` reads nothing and is refused when awaited),
and neither is a grouped source. Inside a shape, the tools carry the same
columns as `row`, for "everything plus":

```ts
db.posts((post, { row }) => ({ ...row, author: post.author.name }));
```

Every option accepts the listed value or a synchronous
`(source, tools) => value` callback. Callbacks receive the projection's full
source and SQL tools, including columns that are not selected. `undefined`
values are ignored. Empty predicate arrays add no restriction; unknown option
names are rejected. The exported `QueryOptions<Source, Tools, Selected>` type
can describe shared options.

The tools of `orderBy`, `groupBy` and `having` callbacks carry `selected`: the
fields the projection returned, under their names, so a computed field is
written once and then ordered, grouped or filtered by name. The same fields are
also the callbacks' third argument, `(user, tools, selected) => …`.

```ts
db.users(
  (user) => ({
    name: user.name,
    spent: user.orders.sum((order) => order.quantity.multiply(order.price)),
  }),
  { orderBy: (user, { selected }) => selected.spent.descending.nullsLast },
);

db.posts(
  (post, { sql, count }) => ({
    month: sql<string>`to_char(${post.createdAt}, 'YYYY-MM')`,
    posts: count(),
  }),
  {
    groupBy: (post, { selected }) => [selected.month],
    orderBy: { month: "asc" },
  },
);
```

A selected field is the same expression as in the projection, not a reference to
its alias: the SQL repeats the expression as the same text with the same
parameters, which PostgreSQL requires in a grouped or `distinct` query and which
lets it compute an expression that is selected and ordered by once. Only fields
that are one value are offered: a nested object, a nested collection or a
relation selected with a shape is a type error, and an error when the query is
built for untyped code. `where` receives no selected fields, because a WHERE
runs before aggregates and window functions exist; filter on source columns
there and on aggregates in `having`. The fields also reach a relation's own
options (`user.posts(shape, { orderBy })`), reusable shapes, prepared queries,
and options added later to a selected query
(`feed({ orderBy: (post, { selected }) => … })`), where they are the selection
the query already has. `page()` accepts a selected field in `orderBy` under its
usual rule: an expression over the root table's columns, next to the primary
key; an aggregate over a relation is not one.

A projection holds fields only; a `$`-prefixed key in it is rejected. Option
callbacks run after the projection on the same source, so they can reach the
JOINs it made: relation paths such as `post.author.name` reuse the JOIN of
`innerJoin(post.authorId)`, `innerJoin(source)` without an ON callback returns
the JOIN of a source the projection joined once, and `join`, `innerJoin` or
`leftJoin` of a relation returns the JOIN of that relation and kind the
projection made (in the projection itself, each call is a JOIN of its own). A
source or relation joined several times is addressed through its explicit alias,
for example `innerJoin(user.posts.as("first"))`; without one, such a call is
refused. A `crossJoin` of a relation is a JOIN of its own: a path through the
relation still reads the row's own related row. Filters, ordering and grouping
append across calls; LIMIT/OFFSET and DISTINCT replace previous values when
supplied.

An options-only branch preserves the previous projection:

```ts
const page = feed({ limit: 10 });
```

An empty shape with no options is rejected unless its callback added JOINs; with
them it reads the source's own columns. Nested ordinary objects only change the
result structure; they do not imply SQL grouping.

An options-only call also starts a reusable filtered source:
`db.posts({ where: ({ state }) => state.is.published })` reads every column of
the published posts when awaited, and calling it with a shape selects fields
from them. Relations accept the same form; applying a limit or offset removes
their `some` / `none` / `every` methods, as with inline pagination.

Fixed numeric LIMIT/OFFSET counts compile as validated integer literals.
Explicit prepared count parameters remain placeholders and are validated when
bound. This lets PostgreSQL cost fixed pagination with the actual counts,
including generic plans.

For row-lock controls, PostgreSQL emits the requested lock. Choose one lock mode
and one of `noWait` / `skipLocked`. `of` names must identify sources in the
query, including aliases introduced by local JOINs. PostgreSQL cannot lock the
rows of the optional side of a LEFT JOIN, which a path such as
`post.editor.name` adds by itself. Without `of`, a query that has a LEFT JOIN
therefore locks what can be locked, its root table and the tables joined with
INNER JOIN (`FOR UPDATE OF "posts"`); a query without one locks every table.

#### Local JOINs

The second callback argument supplies `join`, `innerJoin`, `leftJoin` and
`crossJoin`. **`join(reference)` is the smart JOIN**: INNER for required forward
foreign keys, LEFT for optional/reverse/junction relations, propagating LEFT
through optional ancestors. Both SQL and handle types reflect that choice.

A relation or direct FK column supplies its ON condition from the schema.
Explicit `innerJoin` and `leftJoin` also accept a table, alias, CTE or derived
table with an ON callback receiving the joined source's columns. A query with
its own fields or options is refused as a join source (`db.users({ where })`,
`db.users.byId(1)`), since its filter, limit and fields would be lost in a JOIN
of its table; select its fields and name it with `.as("active_users")` to join
it as a derived table. `crossJoin(source)` also accepts a relationship or FK
column to infer the target, but always produces a Cartesian product without ON:

```ts
db.posts(
  (post, { join, leftJoin }) => {
    const author = join(post.authorId);
    const editor = leftJoin(db.users.as("reviewer"), (user) => [
      user.id.is(post.editorId),
      user.active.is(true),
    ]);

    return {
      title: post.title,
      author: author.name,
      editor: editor.name,
    };
  },
  { where: { state: "published" } },
);
```

Here `active` stays in `ON`, so a post without an active editor remains in the
result with `editor: null`. LEFT JOIN handles make every joined column nullable;
INNER JOIN preserves column nullability. Handles can be captured by later JOIN
callbacks. Repeated sources and self-JOINs get deterministic automatic aliases:

```ts
db.users((user, { join }) => {
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
const userCard = db.users.shape((user) => ({
  name: user.name,
  posts: user.posts.count(),
}));

db.posts((post) => ({
  title: post.title,
  author: post.author(userCard),
  editor: post.editor(userCard),
}));
db.users.as("member")(userCard);
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

db.users(({ name, posts }) => ({
  name,
  recent: posts(postCard, {
    where: ({ state }) => state.is.published,
    orderBy: ({ createdAt, id }) => [createdAt.descending, id.descending],
    limit: 3,
  }),
}));
db.posts(postCard, { where: ({ views }) => views.above(0n) });
```

Keep reusable callbacks synchronous and derive expressions from their row and
local tools. The application supplies the current executor, transaction and
scopes.

#### Enum mappings

For a column declared with `oneOf("draft", "published")`:

```ts
db.posts((post) => ({
  status: post.state.match({ draft: "Draft", published: "Published" }),
  visibleViews: post.state.match({ draft: 0n, published: post.views }),
}));
```

`match` emits SQL CASE. Every enum member is required and extra keys are
rejected. Branches accept scalar literals or compatible SQL expressions;
expression branches must share a SQL storage type, and literal branches take it:
next to `post.views` (a `bigint`) the literal `0` reads as `0n`, and the result
is typed `bigint`. Literals alone must share one type (`"Draft"` and `1` are a
type error). Bigint, Date and expression codecs survive aliases, CTEs and nested
JSON. NULL inputs produce NULL; nullable branch values also remain nullable.
Literal values remain bound parameters. Only finite enum columns expose
`.match()`; ordinary `text` columns do not.

#### SQL expression helpers

All public SQL expression helpers are available in the second callback argument,
with their original types. They also remain available as named imports:

| Category                | Helpers                                                     |
| ----------------------- | ----------------------------------------------------------- |
| Predicates              | `and`, `or`, `not`, `when`, `exists`, `notExists`           |
| Aggregates and fallback | `count`, `sum`, `average`, `minimum`, `maximum`, `coalesce` |
| Dates                   | `dateTrunc`                                                 |
| Windows                 | `rowNumber`, `rank`, `denseRank`, `lag`, `lead`, `over`     |
| SQL template            | `sql`                                                       |
| Local narrowing         | `whereNotNull`                                              |

```ts
db.posts(
  (post, { join, count, sum }) => ({
    author: join(post.author).name,
    publications: count(),
    views: sum(post.views),
  }),
  {
    where: (post) => post.state.is.published,
    groupBy: (post, { selected }) => [selected.author],
    having: (post, { selected }) => selected.publications.above(2),
    orderBy: { publications: "desc" },
  },
);
```

Variables of the projection callback are out of scope in the option callbacks;
`selected` carries the returned fields instead (see
[query options](#shape-first-queries)).

`whereNotNull(column)` adds `IS NOT NULL` to the current query and returns a
non-null typed expression; on a JSON value it also leaves out JSON `null`, which
reads as `null` too. Select or reuse that returned expression:

```ts
db.posts((post, { whereNotNull }) => ({
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
const ranked = db
  .posts((post, { rowNumber }) => ({
    authorId: post.authorId,
    title: post.title,
    position: rowNumber().over({
      partitionBy: [post.authorId],
      orderBy: [post.views.descending, post.id.ascending],
    }),
  }))
  .cte("ranked_posts");

db.users((user) => ({
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
const published = db.posts({ where: (post) => post.state.is.published });
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
result rows, and one with `forUpdate`/`forShare` locks every row it selects (see
[transactions](#transactions)). An object selection containing exactly one
scalar expression supports `.scalar()` and column `.in(query)` /
`.notIn(query)`. For example,
`db.posts((post) => ({ id: post.id }), { limit: 1 }).scalar()` is a typed
nullable scalar subquery. `.in(query)` accepts a subquery over a nullable column
of the same type; its NULLs never match, and, as in SQL, `.notIn(query)` matches
no row when the subquery returns a NULL. Pagination and recursive CTEs keep
their existing SQL restrictions. Write/transaction APIs remain methods on the
callable table and database; SELECT controls describe the read plan.

See [`examples/shapes.ts`](../examples/shapes.ts) for reusable projections, enum
mappings, relation aggregates, explicit JOINs and multi-CTE analytics.

Read callbacks receive the root row first and SQL/JOIN tools second. Write
callbacks receive the row directly; upserts receive `(row, excluded)`. Schema
declaration callbacks such as `posts: ({ users }) => ...` receive table
references rather than query rows.

### Shape the result directly

```ts
db.posts((post, { join }) => {
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
db.posts((post) => ({
  title: post.title,
  author: post.author.name,
  editor: post.editor.name, // string | null
}));

// With users.country declared, paths can continue through multiple tables:
db.posts((post) => ({
  country: post.author.country.name,
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
db.users((user) => ({
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
db.users(
  (user) => ({
    name: user.name,
  }),
  { where: (user) => user.posts.some((post) => post.views.above(0n)) },
);

db.users(
  (user) => ({
    name: user.name,
  }),
  { where: (user) => user.posts.none((post) => post.title.is("Untitled")) },
);

db.users(
  (user) => ({
    name: user.name,
  }),
  { where: (user) => user.posts.every((post) => post.editorId.isNot(null)) },
);
```

`some` uses EXISTS; `none` and `every` use NOT EXISTS. `some()` / `none()` also
accept no predicate, and all three take a list of predicates joined by `AND`, as
`where` does. For an empty relation, `some` is false and `none` / `every` are
true. `every` treats SQL NULL as a failed predicate (`IS NOT TRUE`). Filters can
nest and follow to-one paths. Quantifiers apply before LIMIT/OFFSET; paginated
collections still support shape callbacks, aggregates and `.exists()`, with
pagination included in their result.

### Conditional filters and narrowing

```ts
query({
  where: (post) =>
    and(
      when(search, (search) => post.title.ilike(`%${search}%`)),
      when(authorId, (authorId) => post.authorId.is(authorId)),
    ),
});

db.posts((post, { whereNotNull }) => ({
  editorId: whereNotNull(post.editorId), // number, not number | null
}));
```

A predicate also chains: `views.above(10).and(state.is.published)` and `.or(…)`
are `and(a, b)` and `or(a, b)`, a chain of the same kind stays one flat group,
and falsy arguments are skipped the same way.

Import `and` and `when` from `symmetria`. `when` skips only null/undefined;
zero, false and empty strings are values. Empty AND is TRUE; empty OR is FALSE.
Predicate lists in `where`, `having`, JOIN conditions, `and()`, `or()` and
mutation `where()` skip falsy entries (`undefined`, `null`, `false`, `""`, `0`),
which is every value `condition && predicate` can produce, so optional filters
read `[q && title.ilike(q), minPrice !== undefined && price.atLeast(minPrice)]`
without branching and type-check for `q: string | undefined`. An empty search
string adds no filter; use `when()` or an explicit comparison when `0` or `""`
is a real value. A read whose list filters down to nothing reads every row; an
UPDATE or DELETE whose list does is refused, because `[userId && …]` without a
user would otherwise write the whole table (see
[INSERT, UPDATE, DELETE](#insert-update-delete)). A single `false` returned from
a mutation callback is an error rather than "no filter". `whereNotNull()` adds a
predicate and returns a narrowed expression.

A condition Symmetria has no method for is written as SQL:
``sql<boolean>`${post.title} ~* ${pattern}` `` is accepted wherever a predicate
is (`where`, `having`, a predicate list, `and()`, `or()`, `not()`, a JOIN's
condition, a mutation's `where()`, a scope) and has `.and()` and `.or()` itself.
It compiles to `(…) = (TRUE)`, which PostgreSQL folds away while planning. The
template must be typed as boolean; an untyped `` sql`…` `` is not a condition
for the compiler.

### Several reads in one statement

```ts
const [user, posts, unread] = await db.$batch((db) => [
  db.users.get(id),
  db.posts({ where: { authorId: id }, orderBy: { id: "desc" }, limit: 10 }),
  db.notifications({ where: { userId: id, read: false } }).count(),
]);

const page = await db.$batch((db) => ({
  items: db.posts(postCard, { limit: 20 }),
  total: db.posts.count(),
}));
```

`$batch()` sends the reads its callback starts as one SQL statement: each read
is a JSON subquery of a single `SELECT`, the way a nested query in a projection
is rendered. That is one round trip on either driver and one snapshot of the
data, so a list and its total cannot disagree. It also works inside
`$transaction`, where separate reads would otherwise run one after another, and
under `$scope()`. Every read keeps its own type and result: queries, `get()`,
`find()`, `one()`, `first()`, `count()`, `exists()`, `aggregate()` and `page()`.

The callback is synchronous and returns the reads at once, as an array or an
object; other values pass through. Like the reads, the batch starts when it is
awaited, and the callback runs then; the reads the callback makes join it when
they are made, also when the callback wraps them in `Promise.all()` or an async
helper. A read that cannot run by itself (a malformed key, no row for `get()`)
fails alone. A statement PostgreSQL rejects fails every read in it. Writes, row
locks (also `count()`, `exists()` and `aggregate()` of a source with
`forUpdate`/`forShare`), streams and transactions are not reads and are refused
on the batch's handle. Its types leave out a table's `insert`, `upsert`,
`update`, `delete` and `search` and the database's `$transaction`; a lookup's
`update()` and `delete()`, row locks and streams are refused when they run. A
table search is not part of the one statement either. Reads that each define a
CTE of the same name, as a helper called once per read does, stay in the one
statement: an identical CTE is defined once and shared, a different one gets its
own name in the statement (`ranked_2`), while each read still names it as it
did. Beyond 1,000 reads or 65,535 bound values the batch becomes several
statements, sent in order. Each of them then reads its own snapshot outside a
transaction, and in one at read committed, so a list and its total can disagree;
when they must agree, run such a batch in
`$transaction(…, { isolationLevel: IsolationLevel.RepeatableRead })`.

Outside a transaction the gain over `Promise.all` is the single connection and
the single snapshot rather than time: both drivers already run independent
queries in parallel.

### Cursor pages

```ts
const pageQuery = db.posts(
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
type of raw expressions. Pages cover root-table queries without joins, grouping,
DISTINCT, LIMIT or OFFSET. Every page carries `nextCursor` and `previousCursor`:
pass `after` to move forward or `before` to move back (never both); items always
arrive in the declared order. A `null` cursor marks the last or first page. A
backward page that finds no rows cannot name a next cursor, so keep the cursor
you came from.

### Streaming rows

```ts
for await (const row of db.events(exportShape).stream({ size: 1000 })) {
  writer.write(row);
}
```

`stream()` runs any SELECT through a PostgreSQL server-side cursor: it reserves
a connection, declares a `NO SCROLL` cursor, fetches `size` rows at a time
(default 1000) and closes the cursor when iteration ends, including on an early
`break` or an error. Memory stays flat regardless of the result size. Inside
`$transaction` the stream uses the transaction's connection and sees its
uncommitted writes; the transaction stays usable between rows, and a stream
still open when the callback returns rolls the transaction back. Such a stream
then stops: reading on fails with "the transaction of this stream ended while
the stream was open and was rolled back", also for rows it had fetched before,
and a `break` there just ends the loop. Inside one of the transaction's
savepoints, reading on a stream of the transaction itself is refused like any
query through the parent ("await the nested transaction before using its parent
context"); breaking out of it there ends the loop, and its cursor is closed when
the savepoint ends. `$close()` and `driver.close()` do not wait for a stream:
they refuse new work at once (also a stream started after the call), end the
open streams' transactions, and a loop that reads on fails with "the database
was closed while this stream was open". Unlike `pages()`, no ordering key is
required, but the reserved connection is held until the loop finishes, so do not
keep a stream open while waiting on unrelated work.

Outside a transaction the loop holds one of the pool's connections. A query the
loop body sends through the database asks the pool for another, and when the
loop and the transactions or loops around it hold all of them (with `max: 1`,
the loop alone), it is refused at once ("…from inside a stream() loop that holds
the only one, and would wait forever"). That holds whether the loop awaits the
query or only starts it, to await after the loop: when the query is called, the
library cannot tell the two apart, and one the loop waits for would never get a
connection. Start such queries after the loop, raise `max`, or stream inside a
`$transaction` and query through the transaction, whose statements run on the
stream's connection between fetches.

Only a `for await` loop's body is known to read the stream. Rows can also be
read where the library cannot see it: through `ReadableStream.from()`, Node's
`Readable.from()`, an async generator that maps them, or `next()` by hand. So
the code where the stream's iterator is made (where `for await`,
`ReadableStream.from()` or `[Symbol.asyncIterator]()` is called) counts as
having started the stream. When streams started in the querying code's async
context (by it, or by the code that called it) hold all of the pool's
connections, a query is not sent at once: it waits while one of those streams is
still being read, is sent once one gives its connection back, and is refused
with the same "would wait forever" error once all of them have waited a second
for their readers to ask for the next row. A stream that is fetching rows, or
handing out a row its reader asked for, counts as being read, however long the
fetch takes. A query that would wait for a stream its own code reads, outside a
`for await` body, thus fails after a second instead of waiting. An async helper
with a `for await` loop, called without `await`, leaves its caller's queries to
wait their turn, unless the loop's body spends longer than a second on a row
(awaiting other work before it asks for the next one): the caller's query is
then refused too. Await the helper, raise `max`, or start the helper outside the
caller's async context, as in `setImmediate(() => exportAll())`.

While the loop body runs, the stream waits for its reader to ask for the next
row. When the reader has asked for none for `idleTimeoutMs` (default 60000, one
minute) while other queries wait for one of the pool's connections, the stream
ends its transaction and gives the connection back; reading on fails with "this
stream was ended because its reader asked for no row for 60000 ms while other
queries waited for a connection". This frees the pool, within about a minute,
from an iterator read partly and dropped without `return()`, which Bun gives
back once it is garbage-collected but Node.js may not collect for a long time,
and from loops whose bodies each wait for a connection another loop holds. While
no query waits, a reader may pause as long as it likes, and a body that calls a
slow model or service per row keeps its stream under load as long as each row
takes less than the minute. Pass a shorter time to free a stalled pool sooner,
`stream({ idleTimeoutMs: 5000 })`, a longer one for bodies that pause longer, or
`Infinity` to keep the connection. Inside `$transaction` the transaction holds
the connection, and the option has no effect.

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
const db = createDatabase({
  schema: appSchema,
  driver: postgres({ url: process.env.DATABASE_URL!, profiler }),
});
const profilingServer = await profiler.serve(); // 127.0.0.1:7331

Bun.serve({
  fetch: profiler.fetch(async (request) => {
    const users = await db.users((user) => ({ id: user.id, name: user.name }));
    return Response.json(users);
  }),
});
```

Open `bunx --package symmetria-kit symmetria profile`. Select a request, then a
SQL statement with Enter. `e` requests an estimated plan; `a` explicitly runs
`EXPLAIN ANALYZE`; both show the plan tree of the query inspector. Escape goes
back; `q` exits. Narrow terminals shorten request labels and list only the
database time and rows of each statement. Repeated SQL shapes are marked `↻`.
`--profile-url` selects another endpoint, path included (a profiler behind a
proxy at `http://host/prefix/` is read at `http://host/prefix/requests`; an
address ending in `/requests` names that endpoint); `--json` returns the
retained requests. Request labels, SQL, parameters and errors are shown without
control characters or escape sequences, and `bytea` parameters as `\x…` hex.

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

## OpenTelemetry

`symmetria/opentelemetry` reports every statement and transaction as a span to a
tracer the application passes in. Symmetria itself does not depend on
`@opentelemetry/api`; setting up the SDK and its exporter stays with the
application.

```ts
import { trace } from "@opentelemetry/api";
import { postgres } from "symmetria/pg";
import { traced } from "symmetria/opentelemetry";

const db = createDatabase({
  schema,
  driver: traced(postgres({ url }), {
    tracer: trace.getTracer("my-service"),
    attributes: { "server.address": "db.internal", "db.namespace": "app" },
  }),
});
```

A statement is a client span named after its operation and table
(`SELECT users`) and is a child of the span active when it runs, such as the
HTTP request's. A read of a CTE is named after the table the CTE reads, and a
`$batch()` statement, whose reads are subqueries, after the table of its first
subquery (`count()`, `exists()` and `aggregate()` reads come before other
reads). `$transaction` is a `transaction` span with its statements as children;
a nested transaction is a `savepoint` span. Following a transaction's statements
needs a context manager, which the OpenTelemetry Node SDK registers.

| Attribute                   | Value                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `db.system.name`            | `postgresql`                                                              |
| `db.operation.name`         | First keyword of the statement after its `WITH` list: `SELECT`, `INSERT`… |
| `db.collection.name`        | The first table the statement names, not a CTE                            |
| `db.query.summary`          | The span's name                                                           |
| `db.query.text`             | The SQL with placeholders; `text: false` leaves it out                    |
| `db.response.returned_rows` | Rows the statement returned                                               |
| `db.response.status_code`   | SQLSTATE of a failed statement (`23505`)                                  |
| `error.type`                | SQLSTATE, or the error's class name without one                           |

Values are never recorded: they travel as parameters, and the text holds `$1` in
their place. A failed statement records the exception and sets the span's status
to error, as does the transaction it aborts. Both name the error by its class,
SQLSTATE and constraint (`QueryError (23505) on constraint "users_email_key"`)
and leave out its message and stack, where PostgreSQL may quote a value.
`traced()` wraps any driver, including one that already carries a profiler.

## Prepared queries

```ts
import { prepare, int, text } from "symmetria";

const searchPosts = prepare(
  { authorId: int, title: text, size: int },
  (parameters) =>
    db.posts(
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
`prepare({ id: int }, (p) => db.users.byId(p.id).update({ active: false }))`.

The factory runs once and SQL is compiled once. Each execution binds a fresh set
of typed values through the column codecs, typed like writes: a `jsonb(schema)`
parameter takes the schema's input. SELECT, INSERT, UPDATE, DELETE, RETURNING,
subqueries, and parameterized LIMIT/OFFSET share this mechanism. Parameter names
and values are required; use `.nullable` to accept `null`. Query structure,
selected fields and the number of IN-list elements stay fixed. Placeholders
belong to their factory and cannot escape into another query. Prepared
LIMIT/OFFSET parameters accept nonnegative safe integers, including zero. Fixed
counts still compile as literals, even inside a prepared query. With a
parameterized root LIMIT, `first(values)` binds the smaller of the limit and 1,
and `one()` / `maybeOne()` the smaller of the limit and 2 to detect a second
row: a limit of 1 therefore reads at most one row and never reports two, and a
limit of 0 finds none. `$scope()` values are not frozen into a prepared query:
each execution binds the current ones (see
[scoped databases](#scoped-databases)).

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
const author = await db.users.insert({ name: "Ada" }).returning("id", "name");
// { id: number; name: string }

// Unique lookups write directly, in one statement.
await db.users.byId(author.id).update({ name: "Ada Lovelace" });
await db.posts.by.slug("sql-first").delete();

await db.posts.insert({ title: "SQL first", authorId: author.id });

await db.posts.update((post) => ({ views: post.views.plus(1) }), {
  where: { title: "SQL first" },
});

await db.users.upsert({ name: "Ada" }, { by: "name" });

await db.posts.delete({ where: { views: 0 } });

// Whole-table writes must be spelled out; a missing filter is refused.
await db.posts.update({ published: false }).all();

// Relation paths and quantifiers work in UPDATE/DELETE predicates.
await db.posts.delete({ where: (post) => post.author.name.is("Ada") });
await db.users.update(
  { active: false },
  { where: (user) => user.posts.none() },
);
```

The filter of an UPDATE or DELETE is the `where` option: a callback, a list of
predicates or an object of equalities. An object that names no column (`{}`, or
every value `undefined`) throws rather than write every row; `.all()` remains
the only way to say that. The chained form is the same statement:
`db.posts.update(values).where((post) => …)` and
`db.posts.delete().where((post) => …)`.

`upsert()` inserts a row or overwrites the one with the same key:

```ts
await db.products.upsert(product, { by: "sku" });
await db.products
  .upsert(rows, { by: "sku", update: ["title", "price"] })
  .returning("id", "sku");
```

`by` is the primary key or a unique key: a column, an array of the columns of a
composite key, or the name of a unique index as `by.<name>` takes it
(`upsert(row, { by: "identity" })` for `identity: index(…).unique`). The same
name works as the target of `onConflict("identity")`. An existing row takes the
columns in `update`, by default every column the rows carry except the key; rows
of a bulk upsert must then carry the same columns, because a column some rows
leave out would be overwritten with its default. It is
`insert(…).onConflict(…).doUpdate(…)`, with the same scope checks and the same
refusal of two rows with one key.

`returning("id", "name")` returns those columns and `returning()` the whole row,
next to the callback and reusable-shape forms.

Bulk INSERT accepts arrays, including rows with different omitted defaults. From
100 rows on, rows that all carry the same columns as plain values are sent as
one array per column (`INSERT … SELECT * FROM unnest($1::integer[], …)`): the
statement has as many parameters as columns, whatever the number of rows. A row
with a `defaultValue`, an SQL expression, a prepared parameter, an enum or an
array column keeps the whole insert in the `VALUES` form, and so does a row that
leaves out a column the others carry. A `VALUES` insert whose parameters exceed
the driver's wire-protocol limit (65,535 on PostgreSQL) runs as several INSERT
statements in one transaction, or in a savepoint inside one, with `RETURNING`
rows concatenated in order. An `undefined` field is omitted, as with query
options, so optional request fields can be passed through; required columns
still fail when `undefined`, and unknown keys fail even when `undefined`.
Nullable references accept `undefined` in the nested form too
(`editor: body.editor` with `{ connect }` or nothing). `insert([])` executes no
statement and resolves to `{ affectedRows: 0 }` or `[]` with `returning()`; its
`toSQL()` throws. `defaultValue` explicitly emits SQL `DEFAULT`. Mutations
resolve to `{ affectedRows }` without `returning()`. With `returning()`,
`insert(object)` resolves to one row (`null` when `onConflict().doNothing()`
skipped it) and `insert(array)`, UPDATE and DELETE resolve to arrays. `bigint`
columns accept safe integers on write and in comparisons. Relation paths in
`where()` compile to a primary-key subquery
(`WHERE "posts"."id" IN (SELECT ... JOIN ...)`), so they need a primary key.
UPDATE/DELETE without `where()` are refused when compiled; `.all()` spells out a
deliberate whole-table write. A lookup (`byId()`, `by.email()`) counts as a
filter; a `$scope()` does not: it bounds the write, and every row inside it
still takes `.all()`. `where()` may return an array of predicates combined with
`AND`, like the `where` option.

A filter that holds for every row is refused like a missing one, with "where()
leaves no condition". The check looks for these forms:

- Nothing left: an empty array, a list whose entries were all skipped
  (`[userId && post.authorId.is(userId)]` without a user), `and()`, `not(or())`.
- An emptied list or a query that finds nothing: `notIn([])`,
  `not(overlaps([]))`, and `notIn()`, `not(in())` or `notExists()` of a query
  that finds nothing (an emptied `in([])`, `limit: 0`); an aggregate of such a
  relation compared so that it holds for every row
  (`user.posts({ where: (post) => post.id.in([]) }).count().is(0)`).
- An empty value that every stored value matches: `contains()` of an empty list
  or object (`tags.contains([])`, `meta.contains({})`, a JSON path's
  `contains([])`) matches every row that holds a value (an array, or for `[]`
  and `{}` a JSON array or object), and `like()` or `ilike()` of a pattern of
  only `%` (`like(prefix + "%")` with an empty prefix) every row that holds a
  text. A request list or prefix that came empty would write all of them, so the
  message says so and names `isNot(null)` and `.all()` instead.
- A test every row passes: `exists()` of an aggregate without `groupBy` (one row
  even over no rows), a count compared with what every count passes
  (`count().atLeast(0)`), `length()` of an array compared with what every length
  passes (`tags.length().atLeast(0)`), `isNot(null)` of a NOT NULL column or of
  a `coalesce()` with a value that is never NULL
  (`coalesce(score, 0).isNot(null)`), `not(between(5, 1))` of a NOT NULL number
  column.
- A condition together with its opposite, in an `or()` (or an `and()` below a
  `not()`): the condition and its `not()`, or the pair of methods that say the
  opposite of each other (`is` and `isNot`, `in` and `notIn`, `atLeast` and
  `below`, `atMost` and `above`, `some()` and `none()`, `exists()` and
  `notExists()`), comparing the same thing. It counts only where neither side
  can be NULL, since a row where it is NULL passes neither: a NOT NULL column, a
  never-NULL `coalesce()`, a relation quantifier or `exists()`, a NULL check.
  Examples on NOT NULL columns: `or(active.is(true), active.is(false))`,
  `or(id.notIn([2]), id.is(2))`, `or(not(id.in([1, 2])), id.in([2, 1]))`,
  `or(id.in([1, 1]), id.notIn([1]))`, `or(name.atLeast("m"), name.below("m"))`
  and a column compared with another (`or(id.is(visits), id.isNot(visits))`). On
  any column: `or(score.is(null), score.isNot(null))`,
  `or(score.is(null), score.above(0), score.atMost(0))` (the NULL check takes
  the rows where `score` is NULL), `or(user.posts.some(), user.posts.none())`,
  and pairs with `isDistinctFrom()` (`or(score.isDistinctFrom(2), score.is(2))`,
  `or(meta.isDistinctFrom(null), meta.is(null))`, also on an expression such as
  `id.plus(1)`), which also hold where the value is NULL or JSON null.
- Comparisons of one NOT NULL number column with numbers that together admit
  every value: `or(id.atLeast(5), id.below(6))`,
  `or(id.below(5), id.is(5), id.above(5))`, `or(id.isNot(5), id.atLeast(5))`,
  `or(id.isNot(1), id.isNot(2))`, `between()` as one piece,
  `or(id.below(5), and(id.atLeast(5), id.atLeast(4)))`, and a group below a
  `not()` read by De Morgan (`not(and(a, b))` as `or(not(a), not(b))`:
  `or(id.below(5), not(or(id.below(5), id.below(4))))`).
- Any of these interpolated alone into a template, also in parentheses or
  followed by `= true` or `IS TRUE` (``sql<boolean>`(${id.notIn([])})` ``;
  `IS TRUE` is read as the condition with NULL as FALSE, so below a `not()` it
  holds where the condition is NULL).

The check is not a proof. Other filters that hold for every row are written as
given: a part it cannot tell is never NULL (arithmetic such as
`or(id.plus(1).atLeast(5), id.plus(1).below(5))`, a relation path such as
`post.author.name`, other SQL in a template), numbers written as different text
(`or(balance.is("5"), balance.isNot("5.0"))` of a numeric column), and ranges of
text or dates with different bounds (`or(name.atLeast("m"), name.below("n"))`).
In an `or()` (or `and()`) of more than 1,024 conditions, a group of the same
operator inside it is not searched for opposites or ranges either.

A prepared write is checked again with the values of each execution and refuses
those that make its filter hold for every row, as the same filter written with
them is refused: `isNot(p)` or `isDistinctFrom(p)` of a NOT NULL column with `p`
bound to null, `count().atLeast(p)` with 0, `contains(p)` with `[]`, `like(p)`
with `%`, `limit: p` with 0 in a `notIn()` subquery, and two parameters bound so
that the two halves are opposites (`or(status.is(a), status.isNot(b))` with `a`
equal to `b`). A column compared with a parameter that no other part of the
filter compares (`or(name.is("x"), id.is(p))`) is a condition whatever it binds,
and is not checked again.

Several `where()` calls make one filter: it is refused only when every part
holds for every row, and `.all()`, before or after them, accepts it as a write
to every row. A filter no row passes, such as `in([])`, `overlaps([])` or
`or()`, is a filter and writes nothing.

`onConflict().doNothing()` handles conflicts. `doUpdate("name", "active")`
assigns those fields from `excluded`; object and callback forms support custom
assignments. `doUpdate(values, { where: (current, incoming) => … })` updates the
conflicting row only when the condition holds, for example
`incoming.version.above(current.version)`; otherwise nothing is written,
`affectedRows` is `0` and a single-row `returning()` resolves to `null`. In a
scoped database, a conflicting row outside the scope throws
`SYMMETRIA_OUT_OF_SCOPE` instead (see [scoped databases](#scoped-databases)).
Generated and computed fields cannot be written through the shorthand.
PostgreSQL refuses to `DO UPDATE` the same row twice in one statement, and a
large insert split into several statements would otherwise let the later
duplicate win silently, so two rows with the same conflict key reject with code
`SYMMETRIA_DUPLICATE_CONFLICT_KEY` before anything is sent, whatever the size;
merge or remove the duplicates first. Keys are compared as their column's type
and collation compare them: `"1"`, `"1.0"` and `"1e0"` are one `numeric` key, as
are two values that round to the same number at the column's scale, a UUID in
either letter case, a `char(n)` value with or without its padding, and `"Alpha"`
and `"ALPHA"` in a column declared `text.collate(…)` with a case-insensitive
(nondeterministic) collation. An array column (`text.array.unique`) can be the
key of an upsert of any size. Keys that are NULL or SQL expressions are left to
PostgreSQL. `doNothing()` accepts duplicates: the first row is inserted and the
rest are skipped, in one statement or several. `returning()` callbacks receive
the scalar tools as a second argument (`and`, `or`, `not`, `when`, `coalesce`,
`sql`).

`returning()` also accepts a reusable projection of the same table, in flat and
nested inserts, updates and deletes. The projection must stay row-local: plain
columns and scalar SQL tools such as `sql`, `coalesce` or `when`. Relations,
aggregates, window functions, subqueries and `$` controls are rejected, and a
projection of another table is rejected as well:

```ts
const userCard = db.users.shape(({ id, name }, { sql }) => ({
  id,
  name,
  upper: sql.of(text)`upper(${name})`,
}));

const created = await db.users.insert({ name: "Ada" }).returning(userCard);
// { id: number; name: string; upper: string }
const renamed = await db.users
  .byId(created.id)
  .update({ name: "Ada Lovelace" })
  .returning(userCard);
// { id: number; name: string; upper: string }[]
```

UPDATE assignments, WHERE and RETURNING callbacks receive the row directly,
including nested-insert RETURNING. The upsert callback receives the current row
first and the proposed `excluded` row second:

```ts
await db.users
  .insert({ name: "Ada", active: true })
  .onConflict("name")
  .doUpdate((user, excluded) => ({ name: user.name, active: excluded.active }))
  .returning((user) => ({ id: user.id, active: user.active }));
```

## Unique-key lookups

```ts
const users = table({ id: int.auto, email: text.unique, name: text });
const handles = table({ id: int.auto, tenant: text, handle: text }).indexes(
  (handle) => ({ identity: index(handle.tenant, handle.handle).unique }),
);
const db = createDatabase({
  schema: schema({ users, handles }),
  driver: postgres({ url: process.env.DATABASE_URL! }),
});

await db.users.get({ email: "ada@example.com" });
await db.handles.find({ tenant: "team", handle: "ada" });

// A lookup is a query: it takes options, shapes and terminals.
await db.users.by.email("ada@example.com")({ forUpdate: true }).one();

// Lookups also write: one UPDATE or DELETE, no preliminary SELECT.
await db.users.by.email("ada@example.com").update({ name: "Ada" });
await db.handles.by.identity({ tenant: "team", handle: "ada" }).delete();
```

`.by` is inferred from `.unique` columns and table-local named, unconditional
unique indexes over plain columns; `get()` and `find()` accept the same keys as
an object of their columns and read the one row at once. Composite keys require
all fields. Lookups select all root columns, including computed fields, and
compose with ordinary query methods and prepared parameters. A key takes what a
filter on its column takes, so a `bigint` key accepts a safe integer
(`db.events.find(42)`, `byId(42)`, `connect: 42`) as well as `42n`. A null or
undefined key rejects when the lookup runs. Partial and expression indexes are
excluded; use explicit predicates for them. Primary-key lookup remains
`.byId(...)`, including non-`id` and composite keys.

`.update()` and `.delete()` on a lookup keep the source's write types, `$scope`
filters and transaction binding, accept prepared parameters in the key, and
return `{ affectedRows }` or, with `returning()`, an array of rows. The methods
can be detached: `const { update } = db.users.by.email("ada")`.

## Atomic nested inserts

```ts
await db.posts
  .insert({
    title: "Relations in SQL",
    author: { connect: 1 },
    tags: { connectOrCreate: [{ label: "bun" }, { label: "postgres" }] },
  })
  .returning("id", "title");
```

- To-one relations accept exactly one of `connect`, `create`, `connectOrCreate`.
- Collections accept arrays under those keys; operations can be combined.
- `connect` accepts a primary-key value or a complete unique-key object. A key
  value can be an object in JavaScript: a `Date` for a `timestamptz` key, a
  `Uint8Array` or `Buffer` for a `bytea` key, a `customType()` value. An object
  whose fields are a unique key of the target is read as a key object. A missing
  row throws with code `SYMMETRIA_RECORD_NOT_FOUND`.
- `create` recursively inserts the target. Reverse child inserts infer the
  parent's foreign key; junction relations insert both target and linking rows.
- `connectOrCreate` takes a **flat insert payload**, including every required
  target field. `undefined` fields, operations and relations are omitted: a
  relation field in the payload is left out, whether the row is found or
  created. It chooses the first populated unique key (PK, unique columns, then
  indexes) and first reads the row by those key fields; under a reverse
  relation, a key that holds the new parent's foreign key comes last, since no
  row has it yet. Only when there is none does it insert, with
  `ON CONFLICT DO UPDATE` on the key in case another transaction created the row
  meanwhile. An existing row is therefore not locked or rewritten, and its
  non-key fields are preserved. Several `connectOrCreate` entries of one
  relation are resolved, and rows that are missing created, in key order, not
  input order, so two inserts that create the same rows cannot deadlock; the
  links keep the input order. The key order compares the values as they are
  sent: numbers, bigints and decimal text by value, Dates by time, other text by
  character codes, never by locale, and a composite key column by column. Two
  spellings PostgreSQL takes for one value (a `citext` key in another case) are
  not ordered as one, so two inserts that create the same new rows spelled
  differently can still deadlock. Supply only the intended identifying key when
  several alternatives exist.

Reverse `connect` reparents the existing child; junction `connect` adds a link.
The children a one-to-many relation's `connect` and `connectOrCreate` entries
name are all found (or created) first, then moved to the parent together, in
primary-key order, so two inserts that move the same rows cannot deadlock,
whatever order, key or operation names them. They are moved where the relation's
last `connect` or `connectOrCreate` stands: a `create` given after it is written
after them. Supply a forward relation or its scalar FK, never both. Relation
targets require a single-column PK; `byId` and ordinary writes still support
composite keys. Junction writes require its normal inferred two-FK unique key
and no additional required payload. Self-relations need explicitly named
inverses.

The whole insert, including an array of root inputs, executes in one
transaction. A nested insert inside `$transaction` uses a savepoint and inherits
its isolation. `returning` projects the inserted root; it does not load the
newly created graph. A single input resolves to one row, an array to an array;
without `returning` the result is `{ affectedRows }` counting root rows. Nested
inserts are multi-statement operations with `.returning()`/`.execute()`; they do
not expose `.toSQL()`, `.prepare()` or root `.onConflict()`. Ordinary flat
inserts keep the full SQL builder.

Children created under a one-to-many relation are written together: an order
with three `items: { create: [...] }` is two INSERTs, one for the order and one
multi-row INSERT for its items, split into several only above PostgreSQL's limit
of 65,535 parameters. Rows are inserted in the order given, so generated
identities follow the input. A child that has nested relations of its own is
written by itself, between the groups of plain children before and after it.

Rows connected by the same column are read together, once, before the first
write: twenty posts that each `connect` an author are one SELECT of the authors
and one INSERT of the posts. A row or child whose only nested operations connect
what it references (an order item and its product) therefore joins the multi-row
INSERT of its neighbours. Rows read together are matched to the values as
PostgreSQL compares them: a `Date` of `12:00:00.123` connects the row whose
`timestamptz` key is stored as `.123`, never one stored as `.123456`, which
reads as the same `Date`. A row this insert creates itself is still found by a
later `connect`, with a statement of its own; when it waits in the multi-row
INSERT the connecting row would join (a reply to the comment before it), that
INSERT is written first. Foreign keys take the key as PostgreSQL stores it: a
`timestamptz` key keeps its microseconds, a `customType()` key is not decoded
and encoded again. Dates and timestamps are copied in ISO form and doubles with
all their digits, whatever the session's `DateStyle`, time zone and
`extra_float_digits`; a `customType()` over one of them does so when it declares
its `base`. `connectOrCreate` and targets created through a junction resolve one
by one (a row a `connect` of the same insert has read already is not read
again); the junction rows of one operation are then one multi-row INSERT.

## CTEs and window functions

```ts
import { rowNumber, sum } from "symmetria";

const ranked = db
  .posts((post) => ({
    id: post.id,
    position: rowNumber().over({
      partitionBy: [post.authorId],
      orderBy: [post.createdAt.descending, post.id.descending],
    }),
    runningViews: sum(post.views).over({
      partitionBy: [post.authorId],
      orderBy: post.id.ascending,
      rows: ["unbounded preceding", "current row"],
    }),
  }))
  .cte("ranked", { materialized: false });

await ranked({ where: (post) => post.position.atMost(3) });
```

Call `.cte(name)` after selecting fields. The result is a typed table source:
select from it, join it, or alias it; given options and no fields, it reads all
its fields. Dependencies are emitted once in a single `WITH` statement;
conflicting names throw. A CTE cannot take the SQL name of a table
(`.cte("posts")` throws): in PostgreSQL a `WITH` name hides the table of that
name everywhere in the statement, so `FROM "posts"` would silently read the CTE.
`materialized: true | false` emits the PostgreSQL hint; omission uses the
database default. CTEs support SELECT bodies.

`rowNumber()`, `rank()` and `denseRank()` return number after `.over(...)`.
`lag(column, offset?, fallback?)` and `lead(...)` retain the column codec and a
nullable result. An aggregate becomes a window the same way,
`sum(post.views).over(options)`, for `count`, `sum`, `average`, `minimum` and
`maximum`; `over(expression, options)` is the same as a function. Sums and
averages retain numeric precision. `partitionBy` takes columns, `orderBy` takes
one or multiple orderings. `rows: [start, end]` accepts `"unbounded preceding"`,
`"current row"`, `"unbounded following"`, `{ preceding: number }` and
`{ following: number }`. Offsets must be nonnegative safe integers. PostgreSQL
validates expression legality and frame ordering. Use a CTE to filter a window
result because windows cannot appear directly in WHERE.

Recursive example for a table with `id`, nullable `parentId`, and `name`:

```ts
const tree = db
  .nodes(
    (node) => ({
      id: node.id,
      name: node.name,
    }),
    { where: (node) => node.id.is(rootId) },
  )
  .recursive("tree", (tree) =>
    db.nodes((node, { innerJoin }) => {
      innerJoin(tree, (parent) => node.parentId.is(parent.id));

      return { id: node.id, name: node.name };
    }),
  );

await tree((node) => ({ id: node.id, name: node.name }));
```

The recursive term must return the anchor's fields in the same order and with
compatible types. `UNION ALL` is the default; `{ unionAll: false }` deduplicates
whole rows using `UNION`. Bound the traversal when the data can contain cycles.
The callback's self-reference is scoped to that CTE. Prepared anchors, nullable
columns and codecs are preserved through the resulting table source.

## Aggregates and subqueries

```ts
import { count, sum, exists } from "symmetria";

const totals = db.posts(
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
    having: (post, { selected }) => selected.total.above(1),
  },
);

const activeAuthors = db.users((user) => ({ name: user.name }), {
  where: (user) =>
    exists(
      db.posts((post) => ({ id: post.id }), {
        where: (post) => post.authorId.is(user.id),
      }),
    ),
});
```

`aggregate()` returns one object instead of an array of one row, on a table or a
filtered source:

```ts
const { orders, total } = await db
  .orders({ where: { status: "paid" } })
  .aggregate((order, { count, sum }) => ({
    orders: count(),
    total: sum(order.amount),
  }));
```

The aggregates read the rows the source selects: with `limit` or `offset`, the
rows its ordering puts first (`db.orders({ orderBy, limit: 10 })` aggregates
those ten); with `distinct`, its distinct rows; with `forUpdate`/`forShare`, the
rows it locks, in the order its ordering gives. Otherwise an ordering alone
changes nothing. Relation paths (`order.customer.name`) and relation aggregates
(`sum(customer.orders.count())`) work on all of them. A grouped source keeps its
groups, with its `limit` and `offset` applying to them, so a shape that yields
several rows (a `groupBy`) rejects with `TooManyRowsError`. A query with
`distinct` and selected fields returns distinct values of those fields rather
than rows of its table, so `aggregate()` on it is refused: `count()` counts its
rows, and `query.as("name").aggregate(…)` aggregates its fields.

`count()` returns `number`. `sum()` and `average()` take numbers, bigints and
decimals (not text) and return lossless decimal strings or `null`. `minimum()`
and `maximum()` retain the value type and codec and add `null` (no rows, or only
NULLs). `coalesce()` supplies a non-null fallback, written like the column (a
`jsonb(schema)` fallback in its input form); JSON `null` falls back as SQL NULL
does, since both read as `null`. A selected query's `.as("recent")` creates a
typed derived table; single-column queries support `in()` and `.scalar()`.
Automatic aliases distinguish repeated sources when correlating a table with
itself.

`minimum()` and `maximum()` use PostgreSQL's ordering of the value's type, also
where PostgreSQL has no `MIN` / `MAX` of its own: booleans compile to `bool_and`
/ `bool_or` (`false` is the smaller), and JSON values, `uuid`, `bytea`,
`tsvector`, `vector` and ranges to the first element of
`MIN(ARRAY[value]) FILTER (WHERE value IS NOT NULL)`. This also holds for a
`customType()` that spells the type another way (`customType("BOOLEAN")`,
`customType("UUID")`) or declares it as its `base`. JSON values order as jsonb
does: numbers numerically (`10` above `9`), strings by their text, and between
types objects above arrays above booleans above numbers above strings; JSON
`null` and missing paths are skipped like NULL. This holds for plain aggregates,
grouped queries, relation aggregates and windows
(`over(maximum(post.metadata.path("views")), { … })`).

### Relation aggregates

Relationships expose correlated aggregates directly. These scalar subqueries
support forward, reverse, self and junction relations without multiplying root
rows:

```ts
db.users((user) => ({
  name: user.name,
  posts: user.posts.count(),
  viewed: user.posts({ where: (post) => post.views.above(0n) }).count(),
  hasPosts: user.posts.exists(),
  totalViews: user.posts.sum.views,
  averageViews: user.posts.average.views,
  latestPost: user.posts.maximum.createdAt,
  weightedViews: user.posts.sum((post) => post.views.multiply(2n)),
}));
```

| Method                                                     | Result                                           | Empty input |
| ---------------------------------------------------------- | ------------------------------------------------ | ----------- |
| `count()`                                                  | `number`                                         | `0`         |
| `exists()`                                                 | `boolean`                                        | `false`     |
| `sum.column`, `average.column`, `sum(row => expression)`   | Decimal `string \| null`                         | `null`      |
| `minimum.column`, `maximum.column`, `maximum(row => expr)` | Column or expression type and codec, plus `null` | `null`      |

Aggregates over the same relation with the same filter share one subquery:
`posts.count()`, `posts.sum.views` and `posts.maximum.createdAt` in one shape
read a user's posts once. The shared subquery is a `LEFT JOIN LATERAL`, joined
where it cannot cost more than separate subqueries: when every row is returned,
or after the page of a limited query has been cut.

A plain column aggregates through a property (`posts.sum.views`); expressions
use the callback form. `sum` and `average` accept numeric, bigint and decimal
columns only; `minimum` and `maximum` accept any column and order it as
described [above](#aggregates-and-subqueries), JSON paths included
(`posts.maximum((post) => post.metadata.path("views"))`). Both forms compile to
the same SQL. Value aggregates ignore SQL NULL; an all-NULL input also produces
`null`. Filtering applies before aggregation. LIMIT/OFFSET select the input rows
per parent:

```ts
db.users((user) => {
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

### Arithmetic

```ts
const totals = db.orderItems((item) => ({
  total: item.quantity.multiply(item.unitPrice), // Decimal
  withTax: item.unitPrice.multiply("1.2"), // Decimal
  perKg: item.unitPrice.divide(item.weight), // Decimal
  half: item.quantity.divide(2), // Decimal: "3.5000000000000000" for 7
  boxes: item.quantity.quotient(12), // number: whole boxes, truncated
  next: item.position.plus(1), // number
  density: item.weight.divide(item.volume), // number: real stays a float
}));
```

`plus`, `minus`, `multiply`, `divide` and `quotient` take a number, a bigint,
decimal text or another numeric column or expression. The SQL spells out
PostgreSQL's promotion with casts, and the result type is what that SQL returns:

| Operands                                                   | `plus`, `minus`, `multiply` | `divide`  | `quotient`         |
| ---------------------------------------------------------- | --------------------------- | --------- | ------------------ |
| `int` / `smallint` with each other or a number             | `number`                    | `Decimal` | `number`           |
| `bigint` with integers                                     | `bigint`                    | `Decimal` | `bigint`           |
| any decimal: a `numeric` column or decimal text            | `Decimal`                   | `Decimal` | `Decimal` (`div`)  |
| any float, without a decimal: `real`, `doublePrecision`, … | `number`                    | `number`  | `number` (`trunc`) |

A nullable operand makes the result nullable, and `sum()` / `average()` of any
of them is `Decimal | null`. Results keep computing as their type:
`quantity.divide(2).plus(1)` is a `Decimal`, `weight.multiply(2).divide(2)` a
`number`.

`divide()` never truncates. Integers and bigints divide as exact `numeric`,
which PostgreSQL gives at least 16 significant digits (`7 / 2` is
`"3.5000000000000000"`). `quotient()` is integer division, truncated toward zero
(`-7` by `2` is `-3`), in the integer type; a decimal quotient is `div()` and a
float's is `trunc(a / b)`. Dividing by zero, either way, fails the query with
PostgreSQL's `division by zero`.

A JavaScript number takes the type of the side it is combined with. Next to an
`int`, `smallint` or `bigint` column it must be an integer in range, as in
writes and filters: `quantity.multiply(1.5)` fails the query when it runs, with
the same error on both drivers. Write a fraction as decimal text,
`quantity.multiply("1.5")`, for an exact `Decimal`. Next to a `smallint` a
number is an `integer`, as a SQL literal is, so `small.plus(1000)` does not
overflow at 32767. Floats compute in double precision: `real` columns and
integer operands are cast to it, so both drivers return the same `number`.
`count()`, the ranking functions and `length()` compute as integers and read as
numbers; JSON values compute as described in
[JSON paths](#computed-fields-enums-and-json).

On a text, enum or date column these methods do not exist, also for enum labels
or `match()` literals that look like numbers (`"1"` is text, not a `Decimal`);
the type error names the method and what it needs, and such an operand throws
where the query is built. A `sql<Value>` template has no SQL type Symmetria
knows, so arithmetic on it, or with it as the operand, is a type error and
throws where the query is built; type the template with `sql.of(int)` (or
another column) instead.

### Raw SQL expressions

`sql<Value>` is a typed template escape hatch: interpolated values become
parameters and column expressions remain identifiers. It is a template tag only:
`sql(text)` called as a function would run its argument as SQL and throws. The
caller supplies the result type and any PostgreSQL casts needed by raw SQL, for
example:
``sql<string>`concat(${"Hello "}::text, ${users.name})`.as("greeting")``.

`sql.of(column)` types and decodes the fragment like that column type, on every
driver and inside nested JSON: ``sql.of(bool)`${posts.views} > 0` `` returns
booleans, ``sql.of(timestamptz)`…` `` Dates and ``sql.of(bigint)`…` `` bigints.
It also computes and compares as that column: ``sql.of(int)`…`.divide(2)`` is a
`Decimal`, ``sql.of(real)`…`.divide(2)`` a `number`. Raw fragments are
parenthesized wherever they are operands.

A fragment without `.of` comes back as the driver parses it. The two drivers
mostly agree, but not everywhere: Bun can return an `int4[]` as an `Int32Array`
and a `real[]` as a `Float32Array` where node-postgres returns arrays.
``sql.of(int.array)`…` `` returns an array on both.

An interpolated column, expression or `sql` fragment becomes its SQL, a
condition becomes its SQL in parentheses
(``sql<boolean>`${post.title.is("a")} OR ${post.views} > 10` ``) and an ordering
its SQL with the direction
(``sql`row_number() OVER (ORDER BY ${post.views.descending})` ``). Every other
value is bound as a parameter: strings, numbers, bigints, booleans, `null`,
Dates, Buffers, plain JSON objects and arrays of these. A query, a function, a
`Map` or `Set`, a class instance or an array that holds a column is refused when
the template is built, rather than bound as `{}`; interpolate `query.scalar()`
for a subquery's value.

Symmetria writes SQL after a fragment (` AS "key"`, ` DESC`, the next `SET`
assignment, the `$scope()` check of a write), so a fragment must not reach into
it. A fragment that ends in a `--` comment gets a line break after it. One that
leaves a `/*` comment, a `'…'` string, a `"…"` quoted name or a dollar-quoted
string open is refused when the template is built. A value interpolated inside a
comment or quoted text is refused when the query compiles, because PostgreSQL
does not read a parameter there: write
``sql`${post.title} LIKE '%' || ${term} || '%'` ``, not
``sql`${post.title} LIKE '%${term}%'` ``. Fragments are read the way PostgreSQL
reads them with `standard_conforming_strings` on, its default: a backslash is an
escape only inside `E'…'`.

The template's text is read with JavaScript's escapes, so a backslash in the SQL
is written `\\`: ``sql`replace(${file.path}, '\\', '/')` ``. An escape that
JavaScript cannot read (`\u` without hex digits, `\x`, `\1`) is refused with the
escape named.

Pass JSON to a raw fragment as text and cast it `::text::jsonb`, not `::jsonb`:
``sql`${JSON.stringify(value)}::text::jsonb` ``. With Bun's native driver a JSON
string bound to a bare `$1::jsonb` is stored as a JSON _string_ that contains
the JSON text (`"{\"theme\":\"dark\"}"`, whose `jsonb_typeof` is `string`),
while node-postgres stores the object; with `::text::jsonb` both drivers store
the object. Symmetria casts its own JSON parameters this way.

### Date buckets

```ts
import { dateTrunc } from "symmetria";

db.orders(
  (order, { dateTrunc, count }) => ({
    month: dateTrunc("month", order.createdAt, { timeZone: "Europe/Berlin" }),
    orders: count(),
  }),
  {
    groupBy: (order, { selected }) => [selected.month],
    orderBy: { month: "asc" },
  },
);
// date_trunc('month', "orders"."created_at", $1::text)
```

`dateTrunc(unit, value, options?)` is PostgreSQL's `date_trunc`: the start of
the hour, day, week, month or other unit a value falls in. It works in
projections, `where`, `groupBy` and `orderBy`, on `timestamptz`, `timestamp` and
`date` columns and expressions (raw SQL as ``sql.of(timestamptz)`…` ``). The
unit is one of `microseconds`, `milliseconds`, `second`, `minute`, `hour`,
`day`, `week`, `month`, `quarter`, `year`, `decade`, `century` and `millennium`;
it is checked when the query is built and written into the SQL, never taken from
a parameter.

The result is a `Date`, `null` where the input is NULL. A `timestamptz` stays a
`timestamptz` and a `timestamp` a `timestamp` (read as UTC, like its column). A
`date` becomes a `timestamptz`, as in PostgreSQL: the midnight that starts the
unit in the session's time zone. Where a day or month begins depends on the time
zone: for a `timestamptz` it is the session's zone unless
`{ timeZone: "Europe/Berlin" }` names one, which compiles to the three-argument
`date_trunc(unit, value, zone)` with the zone as a bound parameter (a string or
a prepared parameter). `timeZone` applies to `timestamptz` values only; with a
`timestamp` or `date` it is rejected when the query is built. Text and other
types are rejected there as well; the types cannot tell a `date` from `text`,
both being strings.

## Nested relations

```ts
const authors = await db.users(
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

- `bigint` → JavaScript `bigint`, `numeric(precision, scale)` → `Decimal`, exact
  decimal text such as `"202.10"` (the type is `` `${number}` ``, so it is a
  `string` everywhere one is expected). Writes, filters and prepared parameters
  accept any string for decimal columns and safe integers for `bigint` columns;
  an enum whose labels look like numbers (`oneOf("1", "2")`) stays text and
  accepts only its labels. `sum()` and `average()` return `Decimal | null`. The
  type is `string` because decimals usually arrive as text from a request; the
  text itself is checked when the query runs, before anything is sent: digits
  with an optional sign, fraction and exponent (`"12.50"`, `"-.5"`, `"1e3"`),
  `NaN`, `Infinity` and `-Infinity` (`inf` too, in any letter case), with spaces
  around it allowed, as PostgreSQL reads them. Anything else, such as `"abc"`,
  `""` or `"1,5"`, rejects the query with
  `numeric values are decimal text such as "12.50", received "abc"` (see
  [when errors surface](#when-errors-surface)), in writes, filters, arithmetic
  operands and prepared parameters alike. PostgreSQL 16's `0x1F` and `1_000`
  forms are refused too, since versions 14 and 15 do not read them. A JavaScript
  `number` is a type error on purpose: it is a binary float, so `0.1 + 0.2` is
  `0.30000000000000004` and integers above 2^53 lose digits before they would
  reach the column. Write money and other exact values as text
  (`price: "19.99"`, or `amount.toFixed(2)` when a number is all there is).
- `jsonb<Value>()` → `Value`, `timestamptz` → `Date`. JSON `null` follows the
  column: on a non-nullable jsonb column (`jsonb<string | null>()`) a JS `null`
  is written as the JSON value `null` (`'null'::jsonb`), reads back as `null`
  and is found by `is(null)`; on a `.nullable` column `null` is SQL NULL. A JSON
  `null` can still reach a nullable column (copied from a JSON path, or written
  with SQL) and also reads back as `null`, so there `is(null)` and `isNot(null)`
  count it as null too. In both columns the other comparisons count it as null
  as well, as they do for a [JSON path](#computed-fields-enums-and-json):
  `isNot(3)`, `notIn([3])` and `not(is(3))` leave it out, and
  `isDistinctFrom(null)` does not hold for it. JSON has no `NaN` or `±Infinity`,
  which `JSON.stringify` writes as `null`: a value bound for a json or jsonb
  column, path or parameter that holds one at any depth fails the query before
  it is sent, instead of writing or comparing JSON `null`.
- `timestamp` (without time zone) → `Date`, read and written as UTC: the
  convention of Prisma, Drizzle and Rails, independent of the server's and the
  process's time zone, on both drivers. `timestamp(3)` and `timestamptz(3)` set
  the fractional-second precision. Both types send a `Date` as UTC ISO text, so
  historic instants whose local offset has seconds (Kyiv before 1924) are stored
  exactly whatever the process time zone; BC years and years past 9999 read and
  write as Dates on both drivers. An invalid `Date` (`new Date("x")`) fails the
  query before it is sent, and PostgreSQL's `infinity` throws on read: it has no
  `Date` form.
- `int` and `smallint` → `number`; writes, comparisons and arithmetic accept
  only integers in the column's range (arithmetic: `integer`'s range), so
  `count.above(6.5)`, `small.is(70000)` or `quantity.multiply(1.5)` fails the
  query with the same Symmetria error on both drivers before it is sent
  (`smallint.auto` is an identity column). `real` and `doublePrecision` →
  `number` (`NaN`, `±Infinity` and `-0` round-trip, except that `-0` reads as
  `0` inside a nested object of a CTE, derived table, `distinct` or grouped
  read, which PostgreSQL builds as `jsonb`, whose numbers have no `-0`). `real`
  reads as the shortest decimal that is the same single-precision value, as
  PostgreSQL prints it: `0.1`, not `0.10000000149011612`; `searchRank()` (a
  `real`) reads the same way.
- `date` → `"YYYY-MM-DD"` text with no time-zone shift, in PostgreSQL's form on
  both drivers (`"0999-05-05"`, `"0044-03-15 BC"`, `"infinity"`), `time` →
  `"HH:MM:SS"` text, `interval` → PostgreSQL's text form such as
  `"1 day 02:00:00"`, `inet` → text, `bytea` → `Uint8Array`. The `symmetria/pg`
  adapter reads `date` and `interval` as text so both drivers agree. Bun.SQL
  makes a `date` a JavaScript `Date`, which ends at 275760-09-13: a later date
  fails to read with an error saying so, and reads through `symmetria/pg` or as
  text.
- `jsonb(schema)` takes any [Standard Schema](https://standardschema.dev) object
  (Zod, Valibot, ArkType, …) and validates every written and read value
  synchronously; invalid input fails the query with the issue paths, and an
  invalid stored value fails the read. The database stores the schema's
  **input** form: a write is validated but stored exactly as given, and a read
  validates the stored JSON and returns the schema's **output**, so transforms
  run once, on read. Inserts, updates and upserts are typed with the schema's
  input type, results with its output type. With
  `jsonb(z.object({ at: z.string().transform((text) => new Date(text)) }))`,
  write `{ at: "2026-11-09T10:00:00Z" }` and read `{ at: Date }`; writing back
  what was read fails validation (a `Date` is not a string) instead of drifting.
  The input form must be plain JSON. Filters compare the stored JSON, so they
  take the input form and type it with the input type: `is()`, `isNot()`,
  `in()`, `notIn()`, the comparisons, `contains()`, `coalesce()` fallbacks and
  prepared parameters, through joins and CTEs as well. A value given to them is
  validated as input. `path()` follows the stored keys and returns stored
  values: `event.payload.path("at")` is the ISO `string`, not a `Date`. A nested
  result (a relation, a selected query, a nested object in a CTE) holds the
  field in its stored form too: a path to the field reads it like the column
  (the output, compared as input), and a path inside it reads the stored JSON,
  so `audit.path("entry", "at")` is the `string`.
- `text.array`, `int.array`, `uuid.array`, `timestamptz.array`, … → `string[]`,
  `number[]`, … stored as PostgreSQL arrays. See [Arrays](#arrays) and
  [full-text search](#full-text-search).
- `customType<Value>(sqlType, { encode, decode })` defines application codecs.
  The runtime knows the type by any name PostgreSQL gives it (`int8`, `BIGINT`,
  `decimal(30,10)`, `dec(30,10)`, `bool`, `_int8` for `int8[]`): such values
  nest, batch and aggregate like the builder's, so a 64-bit or decimal value
  reaches `decode` as exact text inside nested results and `$batch()`. A
  domain's name does not tell its base type, so it is stated:
  `customType<Decimal>("amount", { base: "numeric(30,10)" })` reads and writes
  values as `numeric(30, 10)` does (decimal text everywhere, also nested and in
  `$batch()`), and `{ base: "timestamptz" }` reads `Date`s. With `encode` and
  `decode` as well, `decode` receives the value as the base type reads it and
  `encode`'s result is written as the base type. The base is not part of the
  DDL: the column keeps its declared type. A value compared with a domain column
  takes the domain's base type, as PostgreSQL compares it, not the domain, so it
  is not rounded to the domain's precision or checked against its constraints
  first. The declared `base` does not change how a value compares: a `citext`
  column declared with `base: "text"` still compares without letter case, and an
  enum declared with one compares as the enum. A value searched in an array of a
  domain (`contains()`, `overlaps()`) is an element of that domain, since
  PostgreSQL compares a domain's array only with another.
- `uuid.v4.brand("UserId")` adds a TypeScript brand inherited by FK fields. Use
  `Branded<string, "UserId">` to name the value type; SQL remains ordinary UUID.
- `schema(definitions, { executor })` accepts a custom execution function
  returning `{ rows, affectedRows }`. A node-postgres result (`rowCount`) and an
  array of rows that carries `count` (Bun.SQL, postgres.js) work as they are. A
  plain array of rows is counted, which a write without `returning()` cannot be:
  it returns no rows, so such a write is refused after it ran, with an error
  that asks for `{ rows, affectedRows }`. JSON parameters use serialized text
  with explicit SQL casts. Selected aliases identify result keys.
- `await db.$close()` closes the configured driver's pool.

### When errors surface

Mistakes in the shape of a query throw where it is built: an unknown column or
relation, a CTE named like a table, invalid options or conflict columns,
arithmetic on an untyped `sql<Value>` template, `match()` literals of different
types. `update()` and `delete()` without `where()` or `.all()` are refused once
the statement is complete, when it is compiled, and so are those whose filter
leaves no condition, such as a list emptied by request values (`[userId && …]`)
or `where: { authorId: undefined }`, or holds for every row (see
[INSERT, UPDATE, DELETE](#insert-update-delete); a prepared write is checked
again at each execution). Problems with the values a query carries reject its
promise when it runs (`await`, `.execute()`, `.then()`, `.one()` and the other
terminals), for reads and writes alike, before anything is sent: `null` for a
NOT NULL column, a missing required value, an `update()` with no values, input a
`jsonb(schema)` rejects, fractional or out-of-range `int` / `smallint` numbers
(also as arithmetic operands), unsafe `bigint` numbers, text that is not a
number for a `numeric` column, invalid `Date`s, NULL array elements, a null
lookup key, duplicate upsert conflict keys and values a custom codec rejects.
PostgreSQL itself rejects unknown enum labels when the statement runs. So
`insert(body).catch(handle)` and `try { await … } catch` see every value error
the same way, and building a query never throws because of its values. `toSQL()`
returns SQL rather than a promise, so it throws value errors directly, as does
`prepare()` for values fixed in the query; parameters of a prepared query and
`$scope()` values are checked at every execution. Messages and codes are the
same in every case.

Queries and writes are thenable with `catch()` and `finally()` as well, so they
read like promises and their types fit where a `Promise` is expected
(`const load = (): Promise<Row[]> => db.users(shape)`, `Promise.all`). They are
not `Promise` objects: `instanceof Promise` is false,
`Object.prototype.toString` names them `SymmetriaQuery` or `SymmetriaWrite`, and
they run each time one of `then()`, `catch()` and `finally()` is called.

The reads that resolve to one value, `get()`, `find()`, `one()`, `maybeOne()`,
`first()`, `count()`, `exists()`, `aggregate()`, `page()` and `$batch()`, return
real promises that also start when they are awaited: the first `then()` (through
`await`, `catch()`, `finally()` or `Promise.all()`) runs the read, and later
calls share its result. So in `Promise.all([…])` every query, write and read
starts in the array's order. `execute()`, `inspect()` and prepared queries start
when they are called; a read that is never awaited never runs. A read runs in
the async context where it was made, so a `$scope()` callback that reads an
`AsyncLocalStorage`, a profiler's request and a tracer's span see that context
wherever the read is awaited. What the awaiting code holds counts where it
awaits: a read of a transaction awaited inside one of its savepoints is refused
like any query through the parent, and one through the database awaited where
transactions hold every connection is refused as well, instead of waiting
forever. Inside a `$batch()` callback a read joins the batch when it is made,
also when the callback wraps it (`Promise.all`, an async helper).

### Error classes

```ts
import { NotFoundError, UniqueViolation, QueryError } from "symmetria";

try {
  await db.users.insert({ email });
} catch (error) {
  if (error instanceof UniqueViolation) {
    return conflict(error.constraint); // "users_email_key"
  }

  throw error;
}
```

Symmetria's own failures extend `SymmetriaError` and carry the `code` they
always had: `NotFoundError` (`SYMMETRIA_RECORD_NOT_FOUND`, from `one()`, `get()`
and a nested `connect`), `TooManyRowsError`, `OutOfScopeError` and
`DuplicateConflictKeyError`, each with the `table`.

A statement PostgreSQL rejects is a `QueryError` when it comes from the built-in
adapters: `UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`,
`CheckViolation`, `ExclusionViolation`, `SerializationFailure`,
`DeadlockDetected` and `ConnectionError`, or `QueryError` itself for any other
SQLSTATE. `ConnectionError` (`kind: "connection"`) covers PostgreSQL's class 08
(connection exception), which includes 08P01 `protocol_violation`: a message the
server could not use, such as values bound to a statement that takes another
number of them. It also covers a server that ends or refuses the session
(57P01–57P05, such as an administrator's `pg_terminate_backend()` or a
shutdown), the session timeouts 25P03 and 25P04, 53300 `too_many_connections`
(the server had no free slot; a later attempt may get one), and a lost socket
(`ECONNRESET`, `EPIPE`, …), which has no SQLSTATE of its own and reports 08006,
or 08001 when the connection could not be opened. It has `kind`, `sqlState`, and
`table`, `column`, `constraint` and `detail` where PostgreSQL reports them, the
same on both drivers. The driver's own error is its `cause`, and that error's
fields (`code`, `errno`, `hint`, …) are copied onto it, so `sqlState(error)` and
`databaseError(error)` read it as before. A custom driver or executor throws
whatever it throws; `databaseError()` describes those too.

### PostgreSQL adapters

```ts
import { postgres } from "symmetria/pg"; // Node.js or Bun; install pg (no @types/pg needed)
// import { postgres } from "symmetria/bun"; // Bun's built-in SQL pool

const driver = postgres({ url: process.env.DATABASE_URL!, max: 10 });
const db = createDatabase({ schema: appSchema, driver });
```

`symmetria/driver` re-exports `symmetria/pg`. Both adapters compile the same
PostgreSQL SQL and normalize execution results to `{ rows, affectedRows }`. The
`pg` adapter accepts `pg.PoolConfig` options plus `url` and `profiler`; its type
declarations describe those options themselves, so TypeScript projects need no
`@types/pg`. The Bun adapter accepts Bun SQL PostgreSQL options plus `profiler`.
Both preserve bigint and numeric values. The `pg` adapter installs parsers per
pool, leaving global node-postgres configuration untouched, and sets the output
settings its parsers rely on for every new connection (`DateStyle` ISO,
`IntervalStyle` postgres, `bytea_output` hex, `extra_float_digits` 1), so a
database or role that prints dates, intervals, binary values or doubles another
way still reads correctly. `bytea` inside nested results is also read in the
`escape` form on either adapter.

`postgres({ url, prepare: true })` on the `pg` adapter sends every read and
write that has values as a named prepared statement, which PostgreSQL parses
once per connection instead of on every call: on a local database a point read
took 15% less time and a list with a JOIN 27% less, a nested read 6%. It is off
unless set, for three reasons that are PostgreSQL's own. A connection pooler in
transaction mode must support prepared statements (PgBouncer 1.21+ with
`max_prepared_statements`). After several executions PostgreSQL may switch a
prepared statement to one general plan for all values, which is usually as good
and occasionally much worse than a plan made for each value
(`plan_cache_mode = force_custom_plan` keeps the latter). And when a migration
changes the type of a column a prepared statement reads, PostgreSQL refuses the
statement with "cached plan must not change result type": outside a transaction
the adapter prepares it again under a new name and runs it, so the call
succeeds; inside one the error has already aborted the transaction, so that one
transaction fails and the next one prepares the statement again. At most 500
statement texts get a name; texts beyond that (IN lists and literal limits of
every length) are sent unnamed. Bun's pool prepares statements by default and
turns it off with `prepare: false`. Bun's pool has no place to run the output
settings' `SET` statements on a new connection, and it sends most values in
binary, which these settings do not touch; where a database or role changes
`IntervalStyle`, `extra_float_digits` or `bytea_output`, give the defaults to
the Bun adapter yourself:
`postgres({ url, connection: { IntervalStyle: "postgres", extra_float_digits: 1, bytea_output: "hex" } })`
(a connection pooler must allow these start-up parameters, which is why the
adapter does not send them unasked). Bun.SQL cannot read a `bytea` column in the
`escape` form; the query fails with an error that names this option.

Transactions and nested savepoints reserve a single connection, and its
operations run one at a time in the order they start on both drivers. Use
`driver.session(async session => { ... })` for connection-local settings,
temporary tables and advisory locks across statements. A session provides
`execute`, `transaction` and `cancel`; cancellation uses a separate connection
and works with a one-connection application pool. A session's connection is
closed afterwards, so its settings, locks and temporary tables never reach other
queries; a transaction it left open is discarded with it. Settings every
connection needs belong in the connection options, such as
`?options=-c search_path=app` in the URL, not in a `SET` on the pool. Await
every operation before returning from transaction/session callbacks. Their
handles expire afterwards.

`driver.close()` rejects new work, ends the transactions of open `stream()`
loops (see [Streaming rows](#streaming-rows)), drains already accepted queries,
transactions and sessions, then closes the pools. Repeated close calls share the
same promise. Ordinary SQL errors preserve healthy connections; a connection
that was lost or ended by the server, even in the middle of a query, is
discarded so the next query gets a fresh one. All schema and query APIs also
support custom PostgreSQL executors.

#### Transaction pooling (PgBouncer)

Behind a pooler in transaction mode (PgBouncer `pool_mode = transaction`, and
the transaction-mode ports of hosted poolers), each transaction and each
statement outside one may run on a different server connection, and other
clients use the same server connections in between. Queries, `prepare()`d
queries, `$transaction` (with savepoints, isolation levels and `retries`),
`stream()` (it reads inside a transaction), scoped databases and nested writes
work there on both adapters, with these settings:

- Bun.SQL: pass `prepare: false`, as in `postgres({ url, prepare: false })`.
  Bun.SQL otherwise names its prepared statements per connection, and through
  such a pooler one client's statement can reach a server that already has
  another statement under that name: the query then fails ("prepared statement …
  already exists") or binds its parameters to the other statement. PgBouncer
  1.21+ with `max_prepared_statements` above 0 (200 by default since 1.22)
  tracks named statements itself, and then the default works too. The `pg`
  adapter needs nothing: it sends unnamed statements, unless `prepare: true`
  names them, which needs that PgBouncer setting as well.
- Settings for every connection: PgBouncer passes `options=-c search_path=…`
  from the URL only for parameters it tracks. `search_path` needs
  `track_extra_parameters = search_path` and PostgreSQL 18, the first version
  that reports it to the pooler; before that a pooled server connection keeps
  whatever `search_path` its previous client had. Set it for the role instead
  (`ALTER ROLE app SET search_path = app`) and leave it out of the URL. Other
  `-c` options are refused at connect time.
- A `SET` outside a transaction changes whichever server connection ran it and
  stays there for other clients; use `SET LOCAL` inside `$transaction`.

`driver.session()` cannot pin a server connection there: each of its statements
may run on a different one, so session settings, temporary tables and session
advisory locks (`pg_advisory_lock`) do not carry over to the next statement and
can be left behind for other clients. `session.cancel()` cancels by process ID
and may stop another client's statement. Use `$transaction` with
`pg_advisory_xact_lock` and `SET LOCAL` instead, or connect directly for work
that needs a session. Kit migrations detect such a connection (see
[execution modes](#execution-modes-timeouts-and-plans)).

## Arrays

```ts
const posts = table({
  id: int.auto,
  title: text,
  tags: text.array,
  scores: bigint.array.nullable,
});
const db = createDatabase({
  schema: schema({ posts }),
  driver: postgres({ url: process.env.DATABASE_URL! }),
});

db.posts(
  (post) => ({
    id: post.id,
    tagCount: post.tags.length(), // cardinality("tags")
  }),
  { where: (post) => post.tags.has("sql") }, // $1 = ANY("tags")
);
db.posts(
  (post) => ({
    id: post.id,
  }),
  { where: (post) => post.tags.contains(["bun", "sql"]) },
); // @>
db.posts(
  (post) => ({
    id: post.id,
  }),
  { where: (post) => post.tags.overlaps(["bun", "deno"]) },
); // &&
```

Array parameters are sent as PostgreSQL array literals with an explicit cast;
elements use the column's codec, so `bigint[]` and `timestamptz[]` round-trip
exactly.

Array elements are non-null: `int.array` is `number[]`, and `.nullable` makes
the whole array nullable, not its elements. PostgreSQL arrays can still hold
NULL elements written outside Symmetria; reading one throws
(`integer[] value from the database contains a NULL element`) rather than
returning a value its type does not allow, and writing one fails the write too.
Drop them in SQL where such data exists, for example
``sql.of(bigint.array)`array_remove(${post.scores}, NULL)` ``. `jsonb` arrays
are the exception: JSON `null` is one of their values.

## Full-text search

```ts
import { tsvector, searchDocument, sql } from "symmetria";

const posts = table({
  id: int.auto,
  title: text,
  body: text.nullable,
  document: tsvector.nullable, // optional stored vector
}).indexes((post) => ({
  // The index expression is the query expression, so the planner uses it.
  search: index(
    searchDocument({ A: post.title, B: post.body }, { language: "english" }),
  ).using("gin"),
}));

db.posts(
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
`coalesce(…, '')` (`coalesce(…, '{}')` for a JSON part, and a part of a type
known not to be text, such as an enum, `uuid`, `numeric`, a date or an array,
reads as its text, `(part)::text`) and weighted with `setweight()`, and queries
against the document use its configuration unless they name another. A
`customType()` is read as its `base`; without one it is read as it is, since a
domain may be text or JSON. The same holds for `search()`, `searchRank()` and
`searchHeadline()`. `schema()` cannot check a custom type without `base`: one
over a domain of a date or over an extension's type (`ltree`, `hstore`) fails
only when the index is migrated or the query runs, and so does one over a jsonb
domain in `searchDocument()` (`search()`, `searchRank()` and `searchHeadline()`
read a jsonb domain by its string values). Declare `base` for a domain
(`base: "jsonb"` reads it as JSON), an enum type with `oneOf(…).typeName(…)`,
and keep the text of an extension's type in a text column to search it.
Declaring the same expression with `index(...).using("gin")` in `.indexes()`
makes the GIN index usable by the query: the index reads every part as the query
does. Such an index cannot hold an enum, a `date`, an `interval`, `money`, a
timestamp, a range, a multirange or an array (or a `customType()` whose `base`
is one of them), whose text PostgreSQL does not count as fixed (a renamed enum
value, the session's `DateStyle`): `schema()` refuses it, and queries still
search those columns.
`searchRank(query, { weights, normalization, coverDensity })` passes
PostgreSQL's weight array (in D, C, B, A order), the normalization bitmask and
switches to `ts_rank_cd()`; it is a `number`, or `null` where the text or the
query column is NULL. `searchHeadline(query, options)` renders `ts_headline()`
over the column's text (not on a `tsvector` column, which keeps no text);
`startSel`, `stopSel`, `maxWords`, `minWords`, `shortWord`, `highlightAll`,
`maxFragments` and `fragmentDelimiter` map to PostgreSQL's options. Query
strings bind as parameters and work with `prepare()`.

Stored vectors are written by the application:
``insert({ title, document: sql.of(tsvector)`to_tsvector('english', ${title})` })``
(a plain string is rejected by the types). A `GENERATED ALWAYS … STORED` column
cannot be declared, so a trigger or the write path keeps the column current; or
index `searchDocument()` directly and skip the column.

## Vectors (pgvector)

```ts
import { schema, table, index, int, text, operatorClass } from "symmetria";
import { vector } from "symmetria/vector";

const documents = table({
  id: int.auto,
  content: text,
  embedding: vector(1536),
}).indexes((document) => ({
  embedding: index(operatorClass(document.embedding, "vector_cosine_ops"))
    .using("hnsw")
    .with({ m: 16, ef_construction: 64 }),
}));

export const appSchema = schema({ documents }, { extensions: ["vector"] });

await db.documents.insert({ content, embedding: await embed(content) });

const matches = await db.documents(
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
accepts any length, but indexes need a fixed one. `halfvec(n)` is the same in
half precision (pgvector 0.7+): half the space for the column and its index,
HNSW indexes of up to 4,000 dimensions instead of 2,000, and the
`halfvec_l2_ops` / `halfvec_cosine_ops` / `halfvec_ip_ops` operator classes.
Values, distances and parameters work the same on both. Embeddings are written
and read as plain `number[]`; the row type is the branded `Vector`, which has no
array or JSON methods. Distances return `number` (`number | null` when either
side can be NULL) and work in projections, `where` and `orderBy`: `l2Distance`
(`<->`), `cosineDistance` (`<=>`, 0 for the same direction, 2 for opposite),
`innerProduct` (`<#>`, PostgreSQL's negative inner product, so smaller is more
similar) and `l1Distance` (`<+>`, pgvector 0.7+). The argument is a `number[]`,
another vector column or expression, or a `prepare()` parameter declared with
`vector(n)`; it binds as `(SELECT $1::text::vector)`, so the statement reads it
once. Written as a bare cast, it would be read again for every row compared
whenever PostgreSQL plans the statement once for all values, which it may do
from the sixth run of a statement a connection keeps prepared (Bun's default):
for a vector of 1024 numbers that made a filtered search 15 to 30 times slower.
Such a plan for all values still sorts every row a `where` leaves rather than
following the vector index, about 3 µs a row; where filtered searches over many
rows matter, `postgres({ url, prepare: false })` plans each statement for its
values. Nearest-neighbour queries are `orderBy` a distance plus `limit`, which
lets HNSW and IVFFlat indexes serve them.

An HNSW index is approximate in a way that can silently lose rows: it picks
`hnsw.ef_search` candidates (40 unless set) and applies the query's other
filters afterwards, so `limit: 100`, or a `where` that most neighbours fail,
would return fewer rows than exist. Every query ordered by an ascending distance
with a `limit` therefore widens the index scan for its own statement: the index
returns as many rows as `limit` and `offset` ask for (1000 is pgvector's
ceiling) and, from pgvector 0.8, keeps scanning in exact order until enough rows
pass the filters (`hnsw.iterative_scan = strict_order`). The settings are made
with `set_config(…, true)`, which lasts for the transaction; outside
`$transaction()` that is the one statement. A filter that keeps very few rows
makes the index look far, so index the filter column as well: PostgreSQL then
sorts those few rows exactly instead. An IVFFlat index the schema declares on
the column reads on past its nearest lists in the same way
(`ivfflat.iterative_scan = relaxed_order`); it then returns rows only roughly in
order, so the statement sorts the rows it got once more, exactly. How many lists
it starts with is still `ivfflat.probes`, yours to set. `page()` ordered by a
distance compares rows exactly, without the vector index, since pages must cover
every row once; `stream()` plans its cursor to read every row
(`cursor_tuple_fraction = 1`), so it returns what `await` returns. Inside
`$transaction()` the setting is back to its earlier value once the cursor is
declared.

`schema(defs, { extensions: ["vector"] })` records the extension in the
snapshot: generated migrations start with `CREATE EXTENSION IF NOT EXISTS`,
`drift` reports `missing-extension`, and removing it from the schema leaves a
comment in the migration instead of dropping the extension, since other schemas
may depend on it.

## Search by words and meaning

A table says once what it is searched by, and `search()` ranks its rows by that:
by words, by meaning (embeddings), or by both in one statement.

```ts
import { schema, table, one, many, uuid, text } from "symmetria";
import { bm25 } from "symmetria/search";
import { voyage4 } from "symmetria/voyage";

const chunks = table({
  id: uuid.v4,
  note: one(notes.chunks),
  owner: text,
  title: text,
  content: text,
}).search((chunk) => ({
  about: {
    words: bm25({ A: chunk.title, B: chunk.content }),
    meaning: voyage4(chunk.title, chunk.content),
  },
}));

export const appSchema = schema({ notes, chunks });

// The embedding is computed with the row.
await db.chunks.insert({ noteId, owner, title, content });

const found = await db.chunks.search(
  (chunk) => ({ content: chunk.content, note: chunk.note.title }),
  { where: { owner }, about: "where are the garage keys?", limit: 6 },
);
```

`about` is a name of your choosing; a table may declare several searches, in one
`.search()` call or in several. Each has `words`, `meaning` or both:

- `words: fullText(parts, { language })` uses PostgreSQL's own full-text search,
  which every server has. The document is kept in a hidden generated column
  (`aboutWords`, `tsvector GENERATED ALWAYS AS (…) STORED`) with a GIN index:
  PostgreSQL computes it on every write, also for rows written outside
  Symmetria, and ranking reads it instead of parsing the text of every matching
  row again. Adding the search to a table with rows computes the column for all
  of them, which rewrites the table once. `words: bm25(parts)` ranks with BM25,
  which weighs rare words more than common ones and long texts more fairly; it
  needs the `pg_search` extension (ParadeDB, for example the `paradedb/paradedb`
  image) and creates its `bm25` index. The server must load the library
  (`shared_preload_libraries = 'pg_search'`); the image sets that when it
  creates a data directory, so a database first created by another image needs
  the setting and a restart. `parts` is a column, an array of columns, or a
  weight map `{ A, B, C, D }` in which `A` counts most. `language` is a text
  search configuration; the default `"simple"` does no stemming and works for
  any language. The columns are the table's text columns (`text`, `varchar`,
  `char`, `citext`; `bm25()` takes all of them but `char(n)`). `fullText()` also
  reads `uuid`, `numeric`, `inet` and `time` columns as their text, and refuses
  an enum, a `date`, an `interval`, `money`, a timestamp, a range, a multirange
  or an array of any type: their text can change (a renamed enum value, the
  session's `DateStyle`) or PostgreSQL does not count it as fixed, which the
  generated column cannot follow. `bm25()` takes the types pg_search matches
  words in: `text`, `varchar`, `citext`, `json` and `jsonb`, and arrays of
  `text` or `varchar` (`text.array`, `varchar(40).array`). It refuses every
  other type of PostgreSQL's own (`char(n)`, `name`, a `tsvector`, numbers,
  booleans, `bytea`, `uuid`, a date, a range, any other array), and a
  `customType()` declared with a `base` whose own type is not one of those (a
  domain, `ltree`): pg_search fails on them when it creates the index or in
  every search. A `customType()` without `base` is taken as it is. A meaning
  reads any column (see **Writing** for the text it embeds).
- `meaning: model(...columns)` keeps an embedding of those columns' text and
  creates an HNSW cosine index. It needs pgvector. The embedding lives in a
  column named after the search (`about`, `vector(1024)` for `voyage4`,
  nullable) that is hidden: it is not a field of the row, whole-row reads and
  `returning()` leave it out, and it can still be named in a query
  (`chunk.about`, untyped). `model(...columns).half` keeps it in half precision
  instead (`halfvec`, pgvector 0.7+): each number takes 2 bytes rather than 4,
  so the column and its index take about half the space, and the order of search
  results hardly changes. It also lets a model of up to 4,000 numbers be
  indexed, where `vector` stops at 2,000.

The extensions are recorded by the declaration itself: migrations start with
`CREATE EXTENSION IF NOT EXISTS` for `vector` and `pg_search` as needed, without
`extensions: [...]` in the schema options. Everything else is an ordinary column
and ordinary indexes in the snapshot, so `generate`, `drift` and `rollback`
treat a search like any other change; `pull` reads a full-text search back as
its declaration (`words: fullText(…)`, without the column and index it creates)
and a meaning search as its vector column and index.

**Models.** Each service has a module of its own; all of them call the service's
HTTP API directly and add no dependency.

| Module              | Ready models                                         | Any other model           | Key                                |
| ------------------- | ---------------------------------------------------- | ------------------------- | ---------------------------------- |
| `symmetria/voyage`  | `voyage4`, `voyage4Lite`, `voyage4Large` (1,024)     | `voyage(model, options)`  | `VOYAGE_API_KEY`                   |
| `symmetria/openai`  | `textEmbedding3Small`, `textEmbedding3Large` (1,536) | `openai(model, options)`  | `OPENAI_API_KEY`                   |
| `symmetria/cohere`  | `embedV4` (1,536), `embedMultilingualV3` (1,024)     | `cohere(model, options)`  | `COHERE_API_KEY`                   |
| `symmetria/google`  | `geminiEmbedding` (1,536)                            | `google(model, options)`  | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| `symmetria/mistral` | `mistralEmbed` (1,024)                               | `mistral(model, options)` | `MISTRAL_API_KEY`                  |
| `symmetria/jina`    | `jinaV3` (1,024)                                     | `jina(model, options)`    | `JINA_API_KEY`                     |
| `symmetria/ollama`  | `ollama("bge-m3")` and other local models            | `ollama(model, { size })` | none: runs on your machine         |

`options` are `{ apiKey, size, baseUrl, timeoutMs, signal }`. `size` is the
embedding's length, which becomes the column's type; models that can shorten
their output are asked for that length, and those whose own output is longer
than the 2,000 numbers pgvector indexes (`text-embedding-3-large`,
`gemini-embedding-001`) default to 1,536. In half precision they can keep more:
`meaning: openai("text-embedding-3-large", { size: 3072 })(chunk.content).half`.
`openai(model, { baseUrl })` also reaches any server that speaks OpenAI's
embeddings API. `ollama()` reads `OLLAMA_HOST` as the `ollama` command does: an
address without a scheme gets port 11434 (`127.0.0.1`, `localhost:11434`), a URL
is used as it is (its port, credentials and path, as in `baseUrl`), and
`0.0.0.0` (a server listening everywhere) is reached at `127.0.0.1`. Each
request may take `timeoutMs` milliseconds, its answer included (60,000 unless
given); a service that does not answer by then fails the write or search with an
error that names it, instead of holding it, and the transaction it runs in,
forever. Aborting `signal` (an `AbortSignal`, such as one an application aborts
at shutdown) fails the requests under way. A source without a module is one
function, `embedder(size, async (texts, kind) => vectors)` from
`symmetria/search`, where `kind` is `"document"` for rows and `"query"` for
questions. A model is asked only when a row is written or a question is
searched, so building the schema, generating migrations and tests with another
model need no network. The request each module sends is tested against a
stand-in; only Voyage's and Ollama's shapes were also exercised through a
running application.

**Writing.** `insert()` and `upsert()` ask the model once for all the rows that
need an embedding, before the statement is sent. Rows created by a nested insert
get theirs as well, with one request per `INSERT` the nested write sends (rows
written alongside children are inserted one at a time); for many rows a bulk
`insert()` per table asks fewer times. A row that brings its own
(`{ ...row, about: vector }`) is written as it is. The text embedded is the
values of the embedded columns as the application writes them, one paragraph
each, in the order the search names them: a string as it is, a number, a bigint
or a boolean as JavaScript writes it (`1.5`, `false`), a number in a `real`
column as the column keeps it (`1 / 3` as `0.33333334`), a `Date` as its ISO
text (`2026-11-23T10:00:00.000Z`), bytes as PostgreSQL writes them (`\x0102`),
an array or an object as JSON, with its keys sorted (`{"a":1,"b":2}`) and the
elements of a `bytea` or `real` array written so (`["\\x0102"]`), also in a
`json` or `jsonb` column, where a JSON string is the string itself (`hello`). A
row whose text is empty or only spaces (as JavaScript's `\s` counts them,
no-break spaces and byte order marks included), or not known before PostgreSQL
writes it, is written without an embedding (`NULL`) for `reindex()` to compute:
a column given as a SQL expression, a column left out that has a default, and a
column an upsert leaves out, which the existing row keeps. An upsert's update
list (`update: [...]`, `doUpdate(...)`) that names every embedded column updates
the embedding with them; one that names only some of them clears it, since the
stored text is partly unknown. If the model fails, the write is rejected and
nothing is sent. A write the rows already fail (a missing required column, a
value its column cannot hold, an unknown column, a chained call that cannot be
made) is rejected before the model is asked: the write is built once to check
it, so the callbacks of its chained calls (`where`, `doUpdate`, `returning`) run
twice. A nested insert checks each level's rows when that level is written, so a
mistake in a child row is found after the model answered for the rows above it.
The write is still chained as usual (`returning()`, `onConflict()`); only
`toSQL()` and `prepare()` on such a write throw, because the statement does not
exist until the embedding does. That is any `insert()` or `upsert()` of a row
whose embedded columns have text, whatever their type (a number or a date as
well as a string); a row that brings its embedding, or whose text is empty or
not known, has a `toSQL()`. Like any write it runs each time it is awaited,
asking the model again. Inside `$transaction` it keeps the place in the
transaction's order it took when it started: the model is asked at once, and the
write runs in a savepoint that holds the connection until the model has
answered, so operations started after it wait for it (embed beforehand and pass
the vectors when that matters). As with chunked and nested inserts, a failure
caught from such a write leaves the transaction usable.

An `UPDATE` that changes one of the embedded columns sets the embedding to
`NULL` in the same statement, because it would describe the old text; an
`UPDATE` that sets the embedding itself keeps what it sets. The row is found by
its words meanwhile. `await db.chunks.search.reindex()` computes every missing
embedding and resolves to the number of rows it embedded; it is also how rows
written before the search was declared get theirs. Options:

- `where` narrows the work, as in any query.
- `batch` is how many rows go to the model at once and are written by one
  `UPDATE` (100 unless given).
- `order: "desc"` starts from the highest primary key instead of the lowest:
  with increasing keys (`int.auto`, `uuid.v7`) the newest rows come first.

`reindex()` reads each row's values through their codecs, as a query reads them,
and builds the text as an insert does. So a row gets the text an insert of the
values read gets; where PostgreSQL stores a value in its own form (a uuid's
letter case, a `numeric`'s scale, an inet's `/32`, a `Date` in a `date` column),
an insert embeds the value as written and `reindex()` the value as stored. A row
whose embedded columns are all empty, spaces, NULL or JSON `null` has nothing to
embed, so `reindex()` does not read it, and `missing()` does not count it. That
is decided in SQL from the stored value; for a column whose codec changes the
text (an encrypted or encoded column) the stored text decides, so a row whose
stored text decodes to only spaces gets no embedding, yet stays counted and is
read again by each call. A row whose embedded columns change while the model is
answering keeps no embedding of the old values: it is skipped and embedded by
the next call. A row that got an embedding in the meantime keeps it. Rows are
found and paged by their primary key as stored, so a key that reads in another
form (a `timestamptz` with microseconds, which a `Date` does not hold, a
`numeric` read as a number, a `customType()` that decodes) is embedded once like
any other. `await db.chunks.search.missing({ where })` counts the embeddings
`reindex()` would compute now, which makes progress visible without SQL.

**Searching.** `search(shape?, options)` takes the shape of any query, or none
for whole rows, and resolves to rows ordered best first:

| Option                    | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| a search's name (`about`) | A question as a string, an embedding, or `{ text, vector }`               |
| `where`                   | As in any query; applied inside each way of searching                     |
| `limit`                   | Rows to return, 10 unless given                                           |
| `candidates`              | Rows each way of searching contributes, `max(40, 4 × limit)` unless given |

A string is matched by words where the search declares them and embedded by the
model where it declares a meaning. An array is an embedding you computed
yourself, and `{ text, vector }` gives both without a call to the model. Any
word of the question may match: a question shares few words with its answer.
PostgreSQL's parser makes the words of a full-text question as it made the
document's. Each word is asked bare and, where characters surround it that the
parser keeps with it (a path's slash, a number's sign, a URL's query), also with
them, so `İstanbul`, `/etc/hosts` and `-5` find the rows that contain them.
Punctuation the parser drops (`keys?`, `(account,`) asks nothing more, and
punctuation around a word never loses a row the bare word finds. The first 64
distinct words of a question count. However long or repetitive a question is,
the query it sends stays bounded: a word of more than 16 runs of letters and
digits is asked by its first run, and the other spellings fit in 128 operands
and 256 runs of letters and digits.

A search runs each time it is awaited (or `execute()` is called), as a query
does: a search object kept and awaited again finds rows written since and uses
the current `$scope()` tenant. Its question is embedded once per search object
and asked of the model again only after a failure. Inside `$transaction` a
search that waits for the model keeps its place in the transaction's order, as a
write that waits for an embedding does.

With `where`, or under `$scope()`, a search by meaning first counts the rows
that pass the filter, up to 10,001. Up to 10,000 of them are ranked exactly, one
by one, which a filter on an indexed column (a tenant, an owner, a note) makes a
matter of milliseconds; more than that are ranked through the vector index,
which then keeps scanning until `candidates` rows have passed the filter. An
empty question finds nothing and asks no model.

Each way of searching is a ranked list of primary keys in a CTE, limited to
`candidates`; several lists are merged by reciprocal rank fusion, where a row
scores `1 / (60 + its place)` in every list that has it, and the table is joined
to the result. It is one statement, it runs under `$scope()` and inside
`$transaction` like any query, and `await search.toSQL()` shows it. The table
needs a single-column primary key.

If the model fails at search time and the search also declares words, the rows
are found by words alone and the result says so: `rows.partial` is
`{ search: "about", error }`. A search that has only a meaning rejects instead.

**Changing a search.** Stored embeddings describe the text of the declared
columns as the declared model reads it, so migrations follow both:

- A model replaced by one of another length changes the column's type
  (`vector(1024)` to `vector(1536)`). No stored embedding can be converted, so
  the migration empties the column (`USING NULL`).
- Another model of the same length (by its name, the `name` of `embedder()`), or
  other columns (`voyage4(chunk.content)` becoming
  `voyage4(chunk.title, chunk.content)`), keeps the type, and the migration
  empties the column with `UPDATE … SET about = NULL`. A renamed column is the
  same text and changes nothing.
- `.half` added or removed converts the stored embeddings in place
  (`USING about::halfvec(1024)`) and builds the index again with
  `halfvec_cosine_ops` or `vector_cosine_ops`; nothing has to be embedded again.

Emptying a column is reported as destructive: `generate` refuses it without
`--allow-destructive`, and `reindex()` computes the embeddings again after the
migration. Snapshots written by earlier releases did not record the model and
the columns, so the first such change after an upgrade is not noticed; clear the
column by hand once.

Changing the parts of `words: fullText(...)` changes the expression of its
stored column, which PostgreSQL can only compute again: the migration drops and
adds the column, which rewrites the table and builds every index on it again,
the vector index included. `generate` and `lint` say so; on a large table run
such a migration in a quiet hour.

Not included: a search inside a nested relation (`note.chunks.search(...)`) and
inside `$batch()`.

## better-auth

```ts
import { betterAuth } from "better-auth";
import { symmetriaAdapter } from "symmetria/better-auth";

export const auth = betterAuth({
  database: symmetriaAdapter(db),
  emailAndPassword: { enabled: true },
});
```

`symmetria/better-auth` is a [better-auth](https://better-auth.com) database
adapter; `better-auth` is an optional peer dependency. The auth tables are
tables of your schema, keyed and named as better-auth names its models and
fields (`user`, `session.userId`, `account`, `verification`, and whatever its
plugins add), so they are migrated by `symmetria generate`, related to your own
tables (`author: one(user)`) and queried like any other.

`npx auth generate` writes them through the adapter: a module of `table()`
declarations and `authTables`, to spread into the schema.

```ts
import { authTables, user } from "./auth-schema";

const posts = table({ id: int.auto, title: text, author: one(user).cascade });
export const appSchema = schema({ ...authTables, posts });
```

Dates are `timestamptz`, ids are `text` (better-auth generates them, also as
`generateId: "uuid"`; `generateId: "serial"` is refused when better-auth
starts), a reference is `one(target)` or `maybe(target)` with better-auth's
delete action (cascade unless it names another; `"no action"` is
`.onDelete.noAction`, and `"set default"`, which sets NULL because the key has
no default, is `.setNull` on an optional key and NO ACTION on a required one),
and plugin tables come with the rest, with the indexes they declare (a
single-field one becomes the column's `.unique` or `.index`). A reference whose
key does not end in `Id` keeps its SQL name and gets a `…Id` key
(`requestedBy: maybe(user).cascade.column("requested_by")` holds
`requestedById`), one to another field names it (`.by("email")`). Field names
you give better-auth (`user: { fields: { name: "full_name" } }`) become the SQL
names under either casing (`name: text.named("full_name")`,
`user: one(user).column("owner")`) while the keys stay better-auth's field
names; the adapter translates between the two. A model name that is not a
JavaScript name keeps its key and gets an export name (`"auth-user": authUser`).
Run it again after adding a plugin and generate a migration from the difference.

`symmetriaAdapter(db, { usePlural, debugLogs })`: `usePlural` when the tables
are keyed `users`, `sessions`; `npx auth generate` then writes them so. `db` may
be a `$scope()` of the database. better-auth's transactions run inside
`db.$transaction`, a single-use row (a verification token) is taken by a
`DELETE … RETURNING` that only one of two concurrent callers wins, a counter
(`incrementOne`) changes one row while its filter still holds and counts a NULL
from 0, and a table the schema lacks is named in the error. Where values are
compared as better-auth's SQL adapters compare them: a number for a string field
as text, a missing (`undefined`) value and an ordering against `null` match no
row, `null` in an `in` list matches nothing and makes a `not_in` list match no
row. An update or delete whose filter holds for every row (`not_in` an empty
list) is refused; better-auth sends no where to mean every row. Numbers of a
`bigint` field come back as numbers while they are safe integers. Joins are left
to better-auth, which reads related rows with separate queries.

## Scoped databases

For a schema whose `posts` and `comments` tables each declare `tenantId`:

```ts
const tenant = db.$scope({
  posts: (post) => post.tenantId.is(tenantId),
  comments: (comment) => comment.tenantId.is(tenantId),
});

await tenant.posts((post) => ({ id: post.id })); // WHERE "posts"."tenant_id" = $1
await tenant.users((user) => ({ posts: user.posts.count() }));
await tenant.posts.delete().where((post) => post.id.is(7));
// Rejects with SYMMETRIA_OUT_OF_SCOPE: the row would leave the scope.
await tenant.posts.byId(7).update({ tenantId: otherTenantId });
```

Scope callbacks, UPDATE values and RETURNING callbacks see the table's columns
only; a relation path there is reported as such. Filter through relations in
`where()`, which compiles to a primary-key subquery.

`$scope()` returns a database with the same type whose reads, updates and
deletes of the scoped tables carry the predicate: root queries, `byId()`, unique
lookups, shape projections, relation paths, explicit joins (in `ON`), nested
collections and quantifiers. A scoped table keeps its scope when it is joined
into a query of another database:
`db.posts((post, { innerJoin }) => … innerJoin(tenant.users, …))` reads only the
tenant's users, and a narrower `tenant.$scope({ users: … }).users` joined into a
`tenant` query adds its own condition. A join source is a table, its alias or a
derived table (`query.as("name")`); a query with its own fields or options
(`where`, `limit`) is refused there, since a JOIN of its table would drop them.

`$scope()` takes an object whose properties are the callbacks: a plain object,
or a class instance whose methods are named after the tables (called with the
instance as `this`); inherited and non-enumerable properties count. A `Map`, a
`Set`, an array, a function, a promise or no argument at all is refused, as is a
key that names no table (a class instance's own fields other than functions may
hold data for its methods).

A scope must restrict rows: a callback whose result holds for every row is
refused, whether `$scope()` runs it or a later execution does. The
optional-filter idiom of `where` lists,
`(post) => and(tenant && post.tenantId.is(tenant))`, renders `TRUE` without a
tenant, so the reads and writes of such a database reject with
`the $scope() filter of "posts" holds for every row` instead of reaching every
tenant's rows. The analysis is the one that refuses a `where()` holding for
every row in an `UPDATE` or `DELETE` (see
[INSERT, UPDATE, DELETE](#insert-update-delete)): `and()`, `isNot(null)` of a
`NOT NULL` column, a condition together with its opposite, `like("%")` of a
`NOT NULL` column (a uuid, date, timestamp or enum column too), the same
interpolated alone into ``sql<boolean>`${…}` `` and the like. It looks for these
forms and is no proof: a column inside arithmetic (`post.views.plus(1)`) or
inside other SQL of a template (``sql`lower(${post.slug})` ``) is not caught. It
catches a scope whose conditions were all skipped, or one written in such a form
that holds for every row by itself; it does not catch a missing tenant beside
another real condition:
`(post) => and(tenant && post.tenantId.is(tenant), post.deleted.is(false))`
without a tenant reads every tenant's rows that are not deleted. Refuse a
missing tenant before the query runs (throw where the request carries none),
rather than skipping its condition. An emptied list is a condition in a scope,
as it is not in a write: a denylist `(user) => user.id.notIn(blocked)` with
nobody blocked admits every row, and `contains(required)` with nothing required,
or `not(overlaps(excluded))` with nothing excluded, admits every row that holds
a value. A narrower scope that adds nothing to the scope it narrows is allowed.
To read every tenant on purpose, use the unscoped database.

Writes are checked too, like a row-level security `WITH CHECK` policy: every row
a scoped database inserts or updates must satisfy its table's scope as stored,
after defaults and triggers. That covers flat, bulk and chunked inserts, the
rows `onConflict().doNothing()` inserts, both paths of an upsert, `update()`
with `where()` or `.all()`, lookup updates and every table a nested `create` or
`connectOrCreate` writes. A row that would end up outside the scope, such as an
insert for another tenant or `tenant.posts.update({ tenantId: otherTenant })`,
fails the whole operation with code `SYMMETRIA_OUT_OF_SCOPE` and the table's
name in `table`, and nothing is written, also when a chunked or nested insert
has already run some of its statements. A scope that is NULL for a row counts as
outside. The check runs in the same statement (its `RETURNING` clause evaluates
the scope for every written row), so it costs no extra round trip, and unscoped
databases add nothing to their SQL. Deletes remove only rows the scope admits.
An UPDATE or DELETE of every row of the scope takes `.all()`, as in an unscoped
database: `tenant.posts.delete()` is refused. To write a row that deliberately
belongs elsewhere, use the unscoped database.

An upsert never rewrites a row outside the scope either:
`ON CONFLICT … DO UPDATE` checks the conflicting row first, and a row the scope
filters out throws `SYMMETRIA_OUT_OF_SCOPE`
(`upsert on "posts" conflicted with a row outside the database scope`). With
`doUpdate(values, { where })`, a conflicting row inside the scope whose
condition is false is skipped as without a scope (`affectedRows: 0`, a single
`returning()` resolves to `null`), while a row outside the scope throws.
`doNothing()` writes nothing for a conflicting row, wherever it lies. Nested
`connect` only finds rows inside the scope, and `connectOrCreate` throws
`SYMMETRIA_OUT_OF_SCOPE` for an existing row outside it.

Inside `$transaction`, a violation aborts the transaction like any failed SQL
statement: the operations after it and the transaction itself reject with the
same `SYMMETRIA_OUT_OF_SCOPE` error. Chunked and nested inserts, and writes that
wait for an embedding, run in a savepoint there, as does
`transaction.$transaction()`, so a violation caught from one of them leaves the
transaction usable.

A scope can hide the row a required key points at: a comment of this tenant
written by a user of another, or by a user a "not deleted" scope leaves out. The
comment stays in the result. A path through the relation (`comment.author.name`,
also in `where`, `orderBy` and the smart `join()`) is a LEFT JOIN whenever its
target table has a scope, so the field reads as `null` there, although its type
still says `string`: the types do not know which tables a database scopes.
`every()` counts such a comment as failing its condition. The nested form
`comment.author(shape)` is typed as nullable and returns `null` in the same
case; `innerJoin(comment.author)` keeps only the comments whose author the scope
admits.

A junction table is a table like any other and takes a scope under its own name
(`db.$scope({ postsTags: (link) => link.tenantId.is(tenantId) })`). Every read
through the relation then sees only the links the scope admits: nested
collections, `count()`, `some()` / `none()` / `every()` and `join(post.tags)`. A
nested `connect` writes a link of two keys, so a column the scope reads must
have a default that lands inside the scope; otherwise the insert fails with
`SYMMETRIA_OUT_OF_SCOPE` and nothing is written. Insert such links through the
junction itself (`tenant.postsTags.insert({ postsId, tagsId, tenantId })`).

Scopes compose: a scoped database can be scoped again and the predicates are
ANDed. Transactions inherit the scope, and `transaction.$scope()` narrows it
further inside the callback.

Scope callbacks see the table's own columns, so they may read a value that
changes, such as the current tenant from `AsyncLocalStorage`. They run when a
query or write is built, which fixes the SQL, and again every time it executes,
which binds the values current at that moment. A query object kept and awaited
again, a `prepare()`d query or write, a lookup's `update()` and nested relations
therefore always use the current tenant, never the one from when they were
built. When a callback's SQL itself changes, such as an `in([...])` list of a
different length, the statement is compiled again for that execution. A value
the column's codec rejects, such as a fractional tenant id for an `int` column,
fails each execution that uses it rather than the build.

## Computed fields, enums and JSON

```ts
const users = table({ id: int.auto, firstName: text, lastName: text }).computed(
  (user) => ({
    fullName: sql<string>`concat_ws(' ', ${user.firstName}, ${user.lastName})`,
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

### Enum types

Each `oneOf()` column gets its own PostgreSQL type, named
`<table>_<column>_enum` (`posts_state_enum`). `.typeName()` chooses the name
instead, and columns that name the same type share it:

```ts
const role = oneOf("USER", "ADMIN").typeName("Role");

schema({
  users: { id: int.auto, role: role.default("USER") },
  invites: { id: int.auto, role, previousRole: role.nullable },
});
// CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN'), once, used by all three columns
```

Call `.typeName()` before `.nullable` or `.default()`. Columns sharing a type
must list the same labels in the same order; anything else is rejected when the
schema is built, naming both columns. Queries pass enum values as untyped
parameters, so the type's name never appears in query SQL.

Migrations treat a named type like a derived one: a new label that nothing in
the same migration uses is added with `ALTER TYPE … ADD VALUE`; removing or
reordering labels rebuilds the type and converts every column that uses it. A
type that keeps its labels and its columns under a new name, from a changed
`.typeName()` or a renamed table or column behind a derived name, is renamed in
place with `ALTER TYPE … RENAME TO`. `drift` compares the type of each column,
the labels and their order.

```ts
// metadata: jsonb<{ settings?: { theme: string }; tags: string[] }>()
posts.metadata.path("settings", "theme").is("dark");
posts.metadata.path("tags").contains(["sql"]);
posts.metadata.path("tags", 0).as("firstTag");
```

JSON paths check keys and numeric array positions, compile to `#>` with bound
path components, and retain JSON value types. On a `jsonb(schema)` column, and
inside such a field of a nested result, they follow the stored (input) shape,
since that is what the database holds. Missing paths and JSON null decode to
null, and `is(null)`, `isNot(null)`, `coalesce()` and `whereNotNull()` agree
with that: a missing path and a present JSON null both count as null. So do the
other comparisons: `isNot(3)`, `notIn([3])`, `notIn()` of a subquery, `above()`
and `below()` leave both out, as do `between()`, `not(is(3))`, `not(in([3]))`,
`not(between(…))` and `not(contains(…))`, and `isDistinctFrom(null)` holds for
neither. `has()` and `overlaps()` are NULL for both, as `= ANY()` of a NULL
native array is, and for a JSON object or scalar, which has no elements (so is
`length()`), so `not(has(1))` leaves them out too. Ordering is PostgreSQL's
`jsonb` order, where JSON null is a value that sorts before every other value
but an empty top-level array (`between([], [5])` still leaves JSON null out) and
SQL NULL follows `nullsFirst`/`nullsLast`. To tell the two apart, compare in SQL
(``sql<boolean>`${doc.meta} ? 'size'` ``). `contains()` uses `@>` and accepts
partial objects/subarrays. A NOT NULL jsonb column stays bare in its
comparisons, and so does a jsonb column or path in `is()`, `in([…])`,
`between()` and `contains()`, beside a constant NULL that makes JSON null answer
NULL wherever the comparison stands, also inside a `sql` template, below a NOT
written in it, or in a selected `sql<boolean>`
(`("meta" > $1 OR ("meta" = 'null'::jsonb AND NULL))`,
`("meta" < $1 AND ("meta" <> 'null'::jsonb OR NULL))`,
`("meta" = $1 OR ("meta" = 'null'::jsonb AND NULL))`). `is()` with a prepared
parameter bound to JSON null still finds JSON null. In a filter PostgreSQL drops
the constant NULL, so a btree or GIN index on the column, and a partial index
declared with the same condition, serve the query. `in()` of a subquery compares
as written. `isDistinctFrom()` of two JSON values reads JSON null as null on
both sides: two JSON nulls are not distinct, and a prepared parameter bound to
JSON null is `isDistinctFrom(null)`.

`set(key, value)` changes one key of a jsonb value and keeps the rest, where
assigning the column would replace the whole document:

```ts
// settings: jsonb<{ theme: "dark" | "light"; notifications: { email: boolean } }>()
await db.users
  .update(({ settings }) => ({
    settings: settings
      .set("theme", "dark")
      .set(["notifications", "email"], true),
  }))
  .where((user) => user.id.is(1));
// SET "settings" = jsonb_set(jsonb_set("users"."settings", ARRAY[$1::text],
//   $2::text::jsonb, true), ARRAY[$3::text, $4::text], $5::text::jsonb, true)
```

The first argument is a key or, as an array, a path of keys and array positions;
both are checked against the column's JSON type, as for `path()`, and the value
must be what that type holds there (`null` only where the type allows it, stored
as JSON `null`). The value is bound as JSON text, the keys as text parameters. A
column or expression is accepted as the value too and stored in its JSON form
(`to_jsonb`), SQL NULL as JSON `null`. Calls chain, and the result is a jsonb
expression like the column: it can be assigned in `update()` or selected.

`set()` compiles to `jsonb_set(…, true)` and behaves like it:

- The last key of the path is added when it is missing; a missing parent is not
  created, and the JSON is then left unchanged
  (`set(["notifications", "email"], true)` does nothing in a row that has no
  `notifications` object).
- A NULL column stays NULL: there is no JSON to set a key in. When the column is
  nullable, start from a value: `coalesce(draft, { step: 0 }).set("step", 1)`.
- A `jsonb(schema)` column's schema validates whole values, so it does not run
  for the value of a single key.

A path into a jsonb column is a jsonb value, and PostgreSQL has no LIKE,
arithmetic, SUM or MAX for jsonb. Symmetria converts where the meaning is clear:
`is()`, `in()`, `above()`, `between()` and the other comparisons compare JSON
values; `like()` / `ilike()` match the text of a JSON string (`#>> '{}'`);
`plus()`, `minus()`, `multiply()`, `divide()` and `quotient()` compute any JSON
value as `double precision`, the type of a JavaScript number (`numeric` next to
decimal text or a decimal column); `sum()` and `average()` add JSON numbers
exactly as `numeric`; `search()`, `searchRank()` and `searchHeadline()` read the
string values of a JSON value as PostgreSQL's full-text functions do (its keys,
numbers and booleans are no words), in `searchDocument()` too; and `minimum()`
and `maximum()` order JSON values as jsonb does, numbers numerically (see
[aggregates](#aggregates-and-subqueries)). A number reached with a path into a
typed nested result (a CTE's `payload: { views: post.views }`) or an array
computes as `double precision` too; its `bigint` and decimal fields keep their
SQL type, so `payload.path("views").plus(1n)` is a `bigint`.

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
`.index` does not create a redundant one. The index is named after the SQL
column, like the foreign key: `name: text.named("Name").index` creates
`users_Name_idx`.

A unique rule over several columns is declared as a unique index,
`index(posts.tenant, posts.slug).unique` in `.indexes()`, and is created with
`CREATE UNIQUE INDEX`, not as a table `UNIQUE` constraint. It enforces the same
rule, and `by` lookups, `onConflict()` and nested `connect` accept it as a key.

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

const db = createDatabase({
  schema: schema({
    users: table({ id: int.auto, name: text }).indexes((user) => ({
      lowerName: index(sql<string>`lower(${user.name})`).unique,
    })),
    posts: ({ users }) =>
      table({
        id: int.auto,
        title: text,
        author: users,
        views: bigint.default(0n),
        createdAt: timestamptz.now,
      }).indexes((post) => ({
        byAuthorDate: index(post.authorId, post.createdAt.descending).include(
          post.title,
        ),
        viewed: index(post.views).where(post.views.above(0n)),
        untitled: index(post.createdAt).where(sql<boolean>`${post.title} = ''`),
      })),
  }),
  driver: postgres({ url: process.env.DATABASE_URL! }),
});

db.$createIndexes().toSQL(); // CREATE INDEX statements
await db.$createIndexes({ ifNotExists: true }).execute();
```

Supported: compound, unique, partial, expression and covering indexes; `btree`
(default), `hash`, `gin`, `gist`, `spgist`, `brin` via `.using(method)`. Ordered
keys support `.ascending`/`.descending` and `.nullsFirst`/`.nullsLast`.
Method-specific combinations are validated during schema assembly. PostgreSQL
checks operator support and expression immutability. `.where()` takes a
predicate or a boolean expression: ``sql<boolean>`…` `` is written into the
`WHERE` clause as it is, while ``sql<boolean>`…`.is(true)`` would add `= true`.
An expression key ending in `COLLATE "C"` sets that key's collation.

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
      (user) => ({ byTeam: index(user.teamId) }),
    ), // number | null
  teams: ({ users }) => ({ id: int.auto, owner: users.inverse("ownedTeams") }),
});
```

Anchors must match the actual scalar PK's SQL type, enum values and custom
codec. Without anchors, callback-dependent FK values can remain `unknown`
locally; query, row and insert types are still fully resolved.

Schema-level `schema(definitions, { indexes: ({ posts }) => ({ ... }) })` is
also supported, with fully resolved FK value types. Its keys are schema-wide SQL
names (snake_case, without the table prefix or `_idx` suffix). A unique index
declared there is a key of its table like one declared with `.indexes()`:
`find({ tenant, cover })` and `by.<index name>` accept it, in the types too.

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
  tenants: table({ code: text, name: text }).primaryKey((tenant) => [
    tenant.code,
  ]),
  products: ({ tenants }) =>
    table({
      tenant: tenants.index,
      sku: text,
      price: numeric(12, 2),
      stock: int.default(0),
    })
      .primaryKey((product) => [product.tenantId, product.sku])
      .checks((product) => ({
        positivePrice: product.price.above("0"),
        availableStock: product.stock.atLeast(0),
      })),
});
```

`.primaryKey(callback)` preserves the selected column order, including generated
FK columns. Keys require non-null plain columns. A single column can also use
`code: text.primaryKey`; otherwise a scalar `id` is the conventional PK.
Shorthand references accept one scalar PK with any name: `tenantId` above is a
string referencing `tenants.code`; `tenants.by("slug")` references a unique
column instead. Composite foreign-key targets are not supported.

`.checks(callback)` receives typed columns and returns named predicates or
boolean expressions (``positive: sql`${products.stock} >= 0` ``, written as it
is, without a `= true` comparison). Calls append immutably; names become
`<table>_<key>_check` in snake_case. CHECK expressions use the same codecs and
literal escaping as indexes. Aggregates, subqueries and foreign callback scopes
are rejected. PostgreSQL CHECK semantics apply: both TRUE and NULL pass; use
non-null columns to reject NULL values.

Keys and checks appear in snapshots, generated DDL and reversible migration
diffs. Checks and indexes that use a retyped or dropped column are rebuilt;
table and column renames keep them, renaming the constraints and indexes whose
names derive from the table or column (`RENAME CONSTRAINT`,
`ALTER INDEX … RENAME`) instead of rebuilding them.

## Transactions

```ts
import { IsolationLevel } from "symmetria";

const article = await db.$transaction(
  async (transaction) => {
    const author = await transaction.users
      .insert({ name: "Grace" })
      .returning("id");

    return transaction.posts
      .insert({ title: "Atomic writes", authorId: author.id })
      .returning("id", "title");
  },
  { isolationLevel: IsolationLevel.Serializable },
);
```

The callback receives the same typed tables bound to one reserved connection.
Its result is returned after COMMIT; a thrown error rolls back and is rethrown.
Use this callback context for every operation in the transaction.

Use `Transaction<typeof db>` for services that receive a transaction:

```ts
import type { Transaction } from "symmetria";

type AppTransaction = Transaction<typeof db>;

const findAuthor = (transaction: AppTransaction, authorId: number) =>
  transaction.users.get(authorId);

await db.$transaction((transaction) => findAuthor(transaction, 1));
```

It infers the exact tables and relations from either the connected database or
`typeof appSchema`. Nested savepoints have the same type. Pool shutdown and
transaction-incompatible index options remain unavailable on this context. The
type distinguishes a transaction from the pool-bound database, so passing `db`
to a transaction-only helper is a compile-time error.

- Isolation: `IsolationLevel.ReadCommitted`, `IsolationLevel.RepeatableRead`,
  `IsolationLevel.Serializable`. The corresponding strings (`"read committed"`,
  `"repeatable read"`, `"serializable"`) are also accepted. `IsolationLevel` is
  a frozen constant object and an exported union type.
- `readOnly: true`; `deferrable: true` with serializable read-only transactions.
- The callback can be async or return a query directly, since a query is
  awaitable: `db.$transaction((transaction) => transaction.posts(…))`.
- `transaction.$transaction(async (savepoint) => …)` creates a nested savepoint.
  Catch its failure in the outer callback to recover and continue; successful
  nested writes still roll back if the outer transaction fails.
- `forUpdate` / `forShare` acquire row locks. Options: `of: [alias]`,
  `noWait: true`, or `skipLocked: true`. Locks last until the transaction ends.
  Every read of such a source locks the rows it selects: the query, `first()`
  and `one()` the rows they return, `count()`, `exists()` and `aggregate()`
  every row of the source (with `skipLocked`, `count()` is the number of rows it
  could lock), in the source's order. `$batch()` refuses all of these reads of a
  locking source, as it refuses the locking query itself.
- Operations on one transaction run one at a time, in the order they start:
  `Promise.all([...])` of queries, writes, reads such as `count()` or `get()`,
  chunked bulk inserts, nested inserts, searches and writes that wait for an
  embedding works, and each waits for the previous one. All of these start when
  they are awaited, so
  `Promise.all([transaction.logs.insert(row), transaction.logs.count()])` counts
  the new row; `execute()` starts when it is called, so put it where it should
  run. A savepoint holds the connection until it ends, so parent operations
  issued meanwhile wait for it. Inside a savepoint's callback use its own
  context: calling the parent there would wait for the savepoint that is waiting
  for it, so it is rejected ("await the nested transaction before using its
  parent context"). That includes a read made through the parent before the
  savepoint and first awaited inside its callback: await it before the
  savepoint, or make it through the savepoint's context.
- Await all operations. An operation still running or queued when the callback
  returns makes the transaction roll back, and that operation then rejects ("the
  transaction ended before this operation was awaited; it was rolled back")
  instead of resolving as if its write had happened. Nothing awaits such an
  operation, so like any rejected promise without a handler it is reported as an
  unhandled rejection (Node.js ends the process by default); the transaction's
  own rejection already names the mistake. A `stream()` that is still open when
  the callback returns counts as unfinished too: finish the loop or `break` out
  of it first; reading on after that fails, also for rows it had fetched. Query
  handles from a finished transaction/savepoint reject execution. A read that is
  never awaited never starts, so it holds up nothing.
- A caught SQL error still aborts its transaction scope. Use a savepoint for
  recoverable SQL failures. `retries` (a whole number from 0 to 20; other values
  are rejected) re-runs the whole callback after a serialization failure or
  deadlock (SQLSTATE 40001 / 40P01). Between attempts it waits a random time up
  to `retryDelayMs` (default 10 ms), a limit that doubles after each attempt but
  stops at one second (or at `retryDelayMs`, when that is longer), so even 20
  retries wait seconds, not hours. Each attempt gets a fresh connection, so the
  callback must be safe to repeat. `sqlState(error)` reads the SQLSTATE of a
  driver error, and `databaseError(error)` describes it the same way on both
  drivers: `{ kind, sqlState, message, table?, column?, constraint?, detail? }`,
  where `kind` is `unique`, `foreign-key`, `not-null`, `check`, `exclusion`,
  `serialization`, `deadlock`, `connection` or `other`:
  `if (databaseError(error)?.kind === "unique") …`. `connection` means the
  connection was lost or could not be opened (the server ended the session,
  SQLSTATE class 08, 57P01–57P05, or 25P03/25P04 for a transaction that went
  over its idle or total time limit, 53300 when the server, role or database has
  no connection slot left, or a socket error); such errors without a server
  SQLSTATE report `08006` for a lost connection and `08001` for one that could
  not be opened, so a retry is worth trying. `undefined` means the failure did
  not come from the database at all, such as a Symmetria validation error.
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
config and `.env.example`. Existing files are preserved. When
`src/database/schema.ts` already exists, the connection module and config import
from it: its `appSchema` export, else the one `schema(…)` value the module
exports, by name (as `{ name as appSchema }`) or as its default (also
`const db = schema(…); export default db`). The module is read, not run, and
only these plain top-level forms count; when it offers no such value, more than
one, or something init cannot read with certainty (`export *`, a re-export, a
schema inside an object or a wrapper call, several declarators in one
statement), `init` creates nothing, says what to add and exits with 1. Repeating
`init` on a project with a migration config or migration history is a no-op, so
it cannot add a second template schema. Install `symmetria` and `symmetria-kit`
in the application and set `DATABASE_URL` before connecting.

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
# Take back the latest migration while no database has applied it.
bun packages/kit/src/cli/index.ts discard --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts migrate --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts status --config examples/symmetria.config.ts
bun packages/kit/src/cli/index.ts rollback --config examples/symmetria.config.ts
```

`symmetria --help` prints the same list. A flag of particular commands, such as
`--sql`, `--plan`, `--to` or `--ignore-table`, is refused by the others; the
connection, directory, verification-server, timeout and display flags are
accepted everywhere and used where they apply. A flag that takes a value refuses
an empty one (`--to ""` is not "no `--to`"). The names in parentheses are the
matching config and API options.

| Flag                           | Commands                                     | Purpose                                                                                                                                          |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--config <file>`              | all                                          | Config module (default `symmetria.config.ts`)                                                                                                    |
| `--dir <directory>`            | all with a project                           | Migrations directory, relative to the working directory                                                                                          |
| `--database-url <url>`         | database commands, `pull`, `lint`            | Connection; overrides `databaseUrl` and `DATABASE_URL`                                                                                           |
| `--json`                       | all                                          | One JSON object on stdout, `{"error": …}` on failure                                                                                             |
| `--sql`                        | `diff`                                       | Print executable SQL                                                                                                                             |
| `--diff <file.json>`           | `generate`, `diff`, `lint`                   | Rename hints and `USING` conversions                                                                                                             |
| `--empty`                      | `generate`                                   | An empty, editable SQL migration                                                                                                                 |
| `--allow-destructive`          | `generate`                                   | Permit drops and narrowing type changes (`allowDestructive`)                                                                                     |
| `--transaction <mode>`         | `generate`                                   | `batch` (default), `each` or `none` (`transaction`)                                                                                              |
| `--online`                     | `generate`, `diff`, `lint`                   | Concurrent indexes and phased validation (`online`)                                                                                              |
| `--allow-custom-sql`           | `squash`                                     | Drop SQL that generate did not write (`allowCustomSQL`)                                                                                          |
| `--pending`                    | `lint`                                       | Only migrations pending in the database                                                                                                          |
| `--strict`                     | `lint`, `drift`                              | Exit with code 1 for any finding                                                                                                                 |
| `--to <id>`                    | `migrate`, `adopt`                           | Apply up to, or adopt through, a migration (`to`)                                                                                                |
| `--steps <n>`                  | `rollback`                                   | Number of migrations to revert (`steps`)                                                                                                         |
| `--yes`                        | `rollback`                                   | Run `down.sql` without asking; required without a terminal                                                                                       |
| `--plan`                       | `migrate`, `rollback`                        | Show SQL and transaction groups without running them                                                                                             |
| `--action <action>`            | `repair`                                     | `retry` or `complete` (`action`)                                                                                                                 |
| `--verify-url <url>`           | `verify`, `adopt`, `repair`, `drift`         | Server for disposable databases (`verificationDatabaseUrl`)                                                                                      |
| `--snapshot <file>`            | `repair`                                     | Snapshot file of the boundary to verify, instead of `--verify-url`                                                                               |
| `--ignore-table <name>`        | `pull`, `drift`, `adopt`, `repair`, `verify` | Leave an undeclared table out, repeatable (`ignoreTables`)                                                                                       |
| `--advisory-lock-timeout <ms>` | commands that run migrations                 | Migration lock wait (`advisoryLockTimeoutMs`, default 10000)                                                                                     |
| `--lock-timeout <ms>`          | commands that run migrations                 | DDL lock wait (`lockTimeoutMs`, default 5000; 0 disables; in `none`, no default for concurrent index builds, drops and reindexes and `VALIDATE`) |
| `--statement-timeout <ms>`     | commands that run migrations                 | Statement duration (`statementTimeoutMs`, default 600000; no default limit in `transaction: "none"` migrations)                                  |
| `--force`                      | `pull`, `graph`, `discard`                   | Overwrite the written file; `discard`: no database to ask, or an `up.sql` edited after generation                                                |
| `--compact`                    | `graph`                                      | Entities and relations without column lists                                                                                                      |
| `--relations`                  | `inspect`                                    | Start on, or list, the relations                                                                                                                 |
| `--profile-url <url>`          | `profile`                                    | Profiler endpoint (default `http://127.0.0.1:7331`)                                                                                              |
| `--profile-token <token>`      | `profile`                                    | Profiler token (default `SYMMETRIA_PROFILE_TOKEN`)                                                                                               |
| `--no-interactive`             | all                                          | No dashboard, schema browser or rename questions                                                                                                 |
| `--no-color`, `--no-animation` | all                                          | Plain output; no logo or spinner animation                                                                                                       |
| `--help`, `-h`                 | all                                          | Show the commands and flags                                                                                                                      |

The dashboard stays in one terminal screen, with a softly animated logo, schema
counts, connection state and pending SQL changes. Set `DATABASE_URL` or pass
`--database-url postgres://user:password@localhost:5432/app` to connect. Use
arrow keys and Enter (or 1–7); Escape leaves the menu, Ctrl-C exits with 130.
Action results stay open in a scrollable view: arrows/Page Up/Page Down scroll,
Enter/Escape return to the dashboard. Exiting restores the original terminal
screen. `generate` can ask for a name and clarify possible table/column renames
interactively. These choices produce explicit rename SQL in the saved migration.
`--no-interactive` disables prompts; automated runs can provide the existing
`--diff` rename-hint file.

Generation rejects dropped tables or columns, removed enum labels, cleared
search embeddings and type changes that narrow existing values unless
`--allow-destructive` is explicitly supplied; the refusal lists each destructive
operation. A generated migration is printed with the same review `lint` gives
it, so cautions such as a rewritten table are seen before it runs, and what
`lint` of the saved file fails on (destructive or blocking) `generate` reports
too. A narrowing type change, cleared embeddings and removed enum labels are
written with a comment above them (`-- symmetria: destructive: …`), since the
SQL alone does not show what they lose; `lint` of the saved file reads it and
rates them as destructive, as `generate` did. The other way round, a drop of an
index, constraint or enum type that is no longer declared, a primary key rebuilt
over columns that contain the previous key and a foreign key rebuilt to change
only its actions are written with `-- symmetria: caution: …`: they lose no data
and cannot fail, and `lint` rates them as cautions, where the same SQL written
by hand stays destructive or blocking. `discard` takes the latest migration back
while no database has applied it (see the Kit README). Narrowing means a value
can change or stop fitting: a shorter `varchar`/`char` or `bit` length, fewer
`numeric` decimal places (values are rounded), `numeric` or floating point to an
integer type, a smaller integer type (`bigint` to `integer`, either to
`smallint`: the migration fails while a value is out of range), fewer digits
before the decimal point (`numeric(20)` to `integer`, `numeric(10,2)` to
`numeric(8,2)`: likewise), an integer type to `boolean` (every value other than
0 becomes true), fewer fractional-second digits on
`timestamp`/`time`/`interval`, a timestamp to `date` or `time`, or a number into
a floating-point type that keeps fewer digits. A change to a length-limited
string type is generated without a `USING` cast: an explicit `::varchar(5)`
would silently cut `Alexandria` to `Alexa`, while PostgreSQL's own assignment
cast refuses the long value, so the migration fails and rolls back with the data
intact. The same holds for the `down.sql` of a widening change: a rollback to
the shorter type fails on values that no longer fit instead of cutting them. A
type change PostgreSQL has no cast for, in either direction (a number to `uuid`,
a value to an array of it, `integer` to `date`, `boolean` to `numeric`, `jsonb`
to `integer`, whose `down.sql` would need `integer` to `jsonb`), is refused when
the migration is generated, since its SQL could not run even on an empty table;
give the conversion for both directions under `using` in the `--diff` file.
`integer` to `bytea` counts as castless, as it is before PostgreSQL 18. A change
whose plain cast would read the time zone of the session that runs the migration
(`timestamp`, `date` or text to `timestamptz`, `timestamptz` to `timestamp`,
`date` or text, a value to `timetz`) converts at UTC instead, in `up.sql` and
`down.sql`: with `AT TIME ZONE 'UTC'`, or with the session's zone set to UTC
around the statement, so the stored values do not depend on who migrates. A
rename needs a `--diff` hint; it is never guessed from similar names. The API
uses `allowDestructive: true` for intentional removals. Column declarations keep
their order in `CREATE TABLE`; snapshot hashes ignore column order so reordering
source declarations does not create a migration.

`diff` compares the current declaration to the latest local snapshot, not to the
live database. CHECK expressions, partial-index predicates and index key
expressions are compared in a normalized form, so writing the same condition
another way is no change: `users.small.above(-100)` and
``sql<boolean>`(${users.small} > '-100'::integer)` ``, `between()` and its two
comparisons, `in([…])` and `= ANY (ARRAY[…])`, `x = true` and `x`, outer
parentheses, quoting and literal casts. A different operator, column, value or
function is still a change. In a terminal, `inspect` opens a two-pane schema
browser: tables on the left and Columns / Relations / Indexes / Checks / SQL
tabs on the right. Columns have aligned types (a named enum as `enum "Role"`, a
collation as `text collate "C"`) and compact PK, FK, UNIQUE, NULL, AUTO and
DEFAULT badges. Selecting a row shows its physical name, defaults (including
`GENERATED BY DEFAULT AS IDENTITY`) and constraint details. The SQL tab previews
syntax-highlighted schema DDL, including enums and indexes; its line numbers
count SQL lines, so a wrapped line keeps one number. `diff` lists the collation,
identity generation or enum type that changed on a modified column, and an enum
type rename as one change.

- ↑/↓ select; Tab switches panes; ←/→ or 1–5 switch detail tabs.
- Enter opens a table or follows a selected FK/relation; Backspace retraces the
  previous table and selection.
- `/` searches table names, fields and constraints. Enter keeps the filter;
  Escape cancels editing, clears an active filter, or returns to the dashboard.
  `q` closes the browser, as in the query inspector and the profiler.
- Page Up/Down and Home/End navigate long lists or SQL. Narrow terminals show
  one pane at a time; Tab switches between them.
- `inspect posts` starts on that table; `inspect --relations` starts on the
  Relations tab. `--no-interactive` prints the plain schema listing, with each
  index's operator classes, `INCLUDE` columns, storage parameters and `WHERE`
  predicate.

Inspection reads the schema declaration and works without a connection. Every
command accepts `--json` and then prints one JSON object on stdout: the result
on success (lists sit under a key: `findings` for `drift` and `lint`,
`migrations` for `status`, `steps` for `--plan`, `tables` for `inspect`,
`requests` for `profile`), and `{"error": {"message": …}}` on failure; a failed
migration adds `migration`, `direction`, `statement`, `sql`, `sqlState` and
`detail`. The exit code is 0 on success, 1 on failure (and for `lint` / `drift`
findings as described below), 130 after Ctrl-C and 143 after SIGTERM. Ctrl-C or
SIGTERM during `migrate`, `rollback` or another database command first cancels
the running statement and waits up to five seconds for its rollback, so no lock
outlives the process; a second Ctrl-C exits at once. When the server does not
answer in that time, the CLI exits anyway and says whether a statement may still
be running (on stdout as the JSON error with `--json`). Ctrl-C at a question
(the rollback confirmation, a rename, the dashboard menu) exits with 130 too;
Escape closes the question without it. `diff --sql` emits SQL. Terminal output
includes colored diffs, migration state and loading spinners with elapsed time;
piped output stays plain. `--no-color` and `NO_COLOR` disable colors, and
`--no-animation` disables the logo shimmer and spinner animation. Failed
migrations report the failing statement and the underlying PostgreSQL error with
its `DETAIL` (for example which key value is duplicated) and `HINT`. Text from
the database (errors, names, stored values) reaches a terminal without escape
sequences, control characters or bidirectional overrides; only the CLI's own
colours are written, and piped output keeps every byte.

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
  `generate <name> --diff changes.json` (also read by `diff` and `lint`). Names
  in that file are SQL names; columns and conversions are keyed by the new table
  name:

  ```json
  {
    "renames": {
      "tables": { "people": "users" },
      "columns": { "users": { "full_name": "name" } }
    },
    "using": {
      "users": {
        "age": { "up": "\"age\"::integer", "down": "\"age\"::text" }
      }
    }
  }
  ```

  A table rename keeps its constraints and indexes, renamed to the new
  conventional names; a column rename does the same for the constraints on that
  column. `using` supplies the `USING` expression for a type change in each
  direction, so `rollback` can restore the previous type. Both expressions name
  columns by their new names: `up` runs after the rename, and `down` runs before
  it is reverted, because down SQL retypes a renamed column first and renames it
  back afterwards.

- `migrate --to <id>` applies through a target; `rollback --steps 2` reverts the
  latest two applied migrations in reverse order. A target that is already
  applied changes nothing, and the output says where the database stands.
- `rollback` runs `down.sql`, which usually removes columns or tables, so it
  asks first: it lists the statements that remove data or database objects and
  waits for a yes, and a rollback that drops or empties whole tables
  (`DROP TABLE` in the first migration or a squashed baseline, `TRUNCATE`,
  `DROP SCHEMA`) needs the database name typed out. Without a terminal it
  refuses unless `--yes` is passed; `rollback --plan` prints the SQL without
  running it. In menus a digit only moves the selection; Enter runs the action.
- `lint` inspects saved `up.sql` files and any ungenerated schema diff. It exits
  with code 1 for destructive or blocking findings by default; `--strict` also
  fails on cautionary findings. `--pending` uses database history to select only
  pending SQL files; while another process still runs a migration, it stops and
  says to lint when that migration finishes. Offline lint checks the entire
  saved chain, including previously applied migrations. Comments and quoted
  strings never affect a finding, and each action of a multi-action
  `ALTER TABLE` is reviewed on its own; function bodies, `DO`, `CALL` and other
  executable SQL require review. Static lint is conservative and does not prove
  a migration safe for every row. Adding a nullable column, or a `NOT NULL`
  column with a constant default, and renames (pending in the schema diff or
  already generated) pass without findings; a `NOT NULL` column without a
  default is generated as `ADD COLUMN` plus a `-- Backfill …` marker and
  `SET NOT NULL`, so the backfill can be written into the SQL before it is
  applied. Blocking, in saved SQL and in the pending schema diff, because they
  check every existing row: `SET NOT NULL` (unless a valid
  `CHECK (column IS NOT NULL)` added earlier in the migration proves it, as
  `--online` writes it), new `UNIQUE`/`PRIMARY KEY` constraints and unique
  indexes, and `CHECK` or `FOREIGN KEY` constraints added without `NOT VALID`
  (add them `NOT VALID`, then `VALIDATE CONSTRAINT` separately), and the same
  written into `ADD COLUMN` (`REFERENCES`, `CHECK`, `UNIQUE` or `PRIMARY KEY` on
  a column whose existing rows get a value; a `PRIMARY KEY` column without one
  fails on NULL). A column added earlier in the same migration without a default
  holds only NULLs, which a foreign key and a `UNIQUE` key accept, and one added
  with an identity, a sequence or a uuid generator (`gen_random_uuid()`,
  `uuidv7()`) as its default gives every row its own value, so a key on it is
  not blocking (a `clock_timestamp()` or `random()` default can repeat, so a key
  on it is), unless a statement in between may have written the column (an
  `UPDATE` backfill, a `USING`, a `DO` block); a key or check dropped and added
  again after its columns change type (an `integer` to `bigint` primary key) is
  a rebuild caution. Adding an identity column is a caution: it rewrites the
  table. Volatile column defaults (`gen_random_uuid()`, `uuidv4()`, `uuidv7()`,
  `uuid_generate_v1()`, `uuid_generate_v1mc()`, `uuid_generate_v4()`,
  `random()`, `clock_timestamp()`, `nextval()`) are cautions because they
  rewrite the table. A `USING` clause that casts to `varchar(n)` or `char(n)` is
  destructive, however the type is spelled (`pg_catalog.varchar(2)`,
  `"varchar"(2)`): the explicit cast cuts long values; so is a `USING` whose
  whole expression is `NULL` or another constant (`USING 0`,
  `USING '{}'::jsonb`), which gives every row the same value.
- `drift` compares the live database with the latest snapshot: missing or extra
  tables, columns and indexes; types, collations, nullability, defaults and
  identity (`ALWAYS` or `BY DEFAULT`); primary, unique, foreign-key and check
  constraints; FK actions; enum labels and their order; invalid indexes and
  unvalidated constraints; index operator classes, key collations and storage
  parameters; declared extensions that are not installed. Use `--strict` for CI.
  When the database is some migrations behind the local chain (after a
  `rollback`, or before a deploy), the pending changes are not drift and are not
  listed: `drift` says how many migrations the database is behind and which one
  was applied last. `drift` compares with the latest snapshot only, so the older
  state is checked only with `--verify-url` (or `verificationDatabaseUrl`): the
  applied migrations are replayed in a disposable database and the two catalogs
  are compared. `--json` then carries `behind` (`migrations`, `lastApplied`,
  `pending`, `verified`: `true`, `false` or `null` when nothing was checked, and
  `differences`) next to an empty `findings`; `--strict` exits with 1 only when
  that check finds a difference. When the last migration is incomplete, the
  schema is between two migrations: `drift` names the migration, the error it
  stopped with and the `repair` it needs (or says that another process is still
  running it) instead of comparing; `--json` carries `incomplete` (`id`,
  `direction`, `statement`, `running`, `error`), and `--strict` exits with 1
  unless the migration is running. It inspects the connection's
  `current_schema()`, independently of `metadataSchema`, and excludes the
  journal in its configured schema and the undeclared tables listed in
  `ignoreTables` (config) or `--ignore-table <name>` (repeatable): tables of
  another tool or service, or PostGIS `spatial_ref_sys`. `adopt`, `repair` and
  `verify` leave the same tables out of every comparison, including replayed
  historical boundaries, and the CLI always adds Prisma's `_prisma_migrations`.
  A table the schema declares is compared even when the list names it. `pull`
  takes the same list (without the automatic `_prisma_migrations`, which it
  reports). `detectDrift`, `migrator`, `verifyMigrations` and `pullSchema` take
  the same `ignoreTables` option, with nothing ignored by default.
- `squash <name>` replaces the chain with one baseline migration that creates
  the latest snapshot; databases that applied the old chain run `adopt`, which
  verifies the live schema before rewriting recorded history (`adopt --to <id>`
  chooses a baseline explicitly). Because the baseline is generated from the
  snapshot, squash refuses while the chain holds SQL that generate did not
  write, and lists those migrations: SQL written into an `--empty` migration
  (seeds, views, functions) and `up.sql` files edited after generation (generate
  records a checksum of the SQL it wrote; for migrations generated before that
  checksum existed, only `--empty` migrations are detected). Copy that SQL into
  a migration after the baseline, or pass `--allow-custom-sql`
  (`allowCustomSQL: true`) to drop it. An unchanged applied migration retains
  its exact boundary. If several replacement migrations have the same schema
  hash, use `--to` to identify the intended baseline; data-only migrations
  cannot be distinguished by their schema hash alone, so `adopt` refuses and
  names them, also on a database without history, rather than record a seed that
  never ran. Historical targets are reconstructed by replaying SQL into a
  disposable database using `verificationDatabaseUrl` / `--verify-url`. The API
  can instead accept `adopt({ to, snapshot })` when the supplied snapshot hash
  matches that target. The latest target uses the shared snapshot directly.
- Default migrate/rollback batches run in one transaction, with one exception: a
  migration that adds enum labels (`ALTER TYPE … ADD VALUE`) ends its group, so
  it commits before the next migration of the run starts. PostgreSQL refuses to
  use a new label in the transaction that added it (SQLSTATE 55P04), and the
  next migration may set it as a default or use it in a check. If a later group
  fails, the earlier groups stay committed; `migrate --plan` shows the groups.
  The groups are the same with every driver. On a driver with sessions (both
  official drivers), a session-wide advisory lock covers all of them. A custom
  driver that only runs whole transactions (`transaction` without `session`)
  runs each group in its own transaction, which takes a transaction-level
  advisory lock and reads the journal again before it starts: a second runner
  that gets the lock between two groups continues from where the first one
  stopped, and a rollback that finds a different latest migration stops instead
  of reverting one it did not choose. History defaults to
  `public._symmetria_migrations`. Config can override `metadataSchema` and
  `metadataTable`. `migrate` and `adopt` create a missing journal schema inside
  that transaction; `status` and `rollback` do not create it. A running
  migration never alters an up-to-date journal, so it does not lock `status`
  out.
- Applied checksums cover SQL in both directions and journal entries, including
  their schema hashes. Adding a migration does not change earlier checksums.
  Missing, reordered or edited applied migrations are rejected before execution.
  CRLF line endings count as LF, so an editor or Git `autocrlf` setting does not
  invalidate applied migrations; checksums recorded from CRLF files by earlier
  releases still match.
- Tables/types use the connection's `search_path`; metadata always uses its
  explicitly qualified schema. Config paths are relative to the config module;
  `--dir` paths are relative to the working directory.

Generated down SQL restores schema structure; it cannot recreate deleted data.
Data backfills and nontrivial conversions can be added to the SQL before
applying. Constraint violations or enum values that cannot be narrowed cause an
atomic rollback of the current transactional group. The runner manages
transaction boundaries; explicit `BEGIN`, `COMMIT` and savepoints in migration
files are rejected. Statements split the way psql splits them: SQL-standard
function bodies (`CREATE FUNCTION … BEGIN ATOMIC … END`, including `CASE … END`
inside) and parenthesized `CREATE RULE … DO ALSO (…; …)` action lists stay one
statement, for execution, `--plan` and lint alike.

### Schema diagrams

`symmetria graph [file]` renders the declared schema, or the latest migration
snapshot when the config declares none, as a Mermaid `erDiagram`. Without a file
it prints the diagram; a `.md` target gets a `mermaid` fence, any other file
receives the bare diagram, and existing files need `--force`. Entities list each
column with its SQL type (enum columns show the enum type), `PK`, `FK` and `UK`
markers and `nullable` / `identity` notes. A column name Mermaid cannot take as
an attribute (a space, a quote, a leading digit) is written with `_` in their
place (`First Name` as `First_Name`, `2fa` as `_2fa`) and its real name in the
note; a relation label with such characters is quoted. `--compact` prints
entities and relations only. Edges read parent to child: `||` exactly one
parent, `|o` optional parent (nullable foreign key), `o{` many children, `o|` at
most one child (unique foreign key); `--` marks identifying relations whose
foreign key is part of the child's primary key (junctions, one-to-one detail
tables) and `..` the others. `--json` returns `{ tables, edges }`;
`schemaGraph(snapshot)` and `renderMermaid(graph, { fenced, compact })` do the
same in code.

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
  tags: table({ id: int.auto, name: text.unique }),
  postTags: ({ posts, tags }) =>
    junction({ post: posts.onDelete.cascade, tag: tags.onDelete.cascade }),
});
```

What maps directly: table and column names of any form (`pull` picks the
`casing` that fits most names and adds `.named()` for the rest), `integer` /
`bigint` / `smallint` identities (`int.auto`, or `int.auto.byDefault` for
`GENERATED BY DEFAULT`), `now()`, `gen_random_uuid()` and `uuidv7()` defaults,
literal defaults, `text`, `boolean`, `uuid`, `jsonb`, `timestamptz` and
`timestamp` with their precision, `varchar(n)`, `numeric`, `smallint`, `real`,
`double precision`, `date`, `time`, `interval`, `bytea`, `inet`, arrays of
those, column collations (`.collate("C")`), enums of the schema (`oneOf()`; a
type that is not named `<table>_<column>_enum` or that several columns share
keeps its name through `.typeName("Role")` on each column), single-column
foreign keys that reference a single-column primary key or `UNIQUE` constraint,
with `ON UPDATE CASCADE` or `RESTRICT` (columns that do not follow the relation
naming are declared with `.column("<name>")`, unique targets with
`.by("<column>")`), junction tables whose primary key is exactly two such
foreign keys, composite primary keys, single-column unique constraints, indexes
with their ordering, operator classes, key collations, `INCLUDE` columns,
predicates and storage parameters (a plain single-column btree index named
`<table>_<column>_idx` becomes `.index`; derived names over 63 bytes are
recognized by their hash, and other names are kept exactly), and CHECK
constraints. CHECK and `WHERE` conditions, and index keys computed from columns,
are declared as predicates whenever the DSL writes them the way PostgreSQL
stored them: comparisons with literals and other columns, `IS [NOT] NULL`, `IN`,
`BETWEEN`, `AND` / `OR` / `NOT`, `LIKE` / `ILIKE`, enum labels,
`IS DISTINCT FROM`, boolean columns, timestamps and arithmetic
(`users.score.plus(1).above(users.lower.multiply(2))`,
`and(t.status.is("active"), t.deletedAt.is(null))`). The rest stays a boolean
expression, ``sql<boolean>`(length(${t.name}) > 0)` ``: function calls, casts
the DSL would not write, and literals of another type than the column (a
`bigint` compared with an integer literal uses another operator than
`big.below(10n)`). One stored as `((…) = true)`, as older pulls declared it,
loses the comparison. A schema written with the DSL, migrated and pulled back
needs no migration, and pulling a database built from a pulled schema gives back
the same schema. Tables named like a builder or a reserved word (`date`, `text`,
`sql`, `delete`) are bound under another name in callbacks,
`({ date: dateTable }) =>`, so they never hide the import.

Everything else is approximated and listed, with a `// pull:` comment on the
affected line and an entry in the command's review list (`warnings` in `--json`,
each with a `code` and often a `fix`):

- Constraints whose names differ from the derived `<table>_pkey`,
  `<table>_<column>_key`, `<table>_<column>_fkey` and `<table>_<key>_check` are
  declared with their meaning; the fix is the `RENAME CONSTRAINT`. This includes
  junction keys such as Prisma's `_CategoryToPost_AB_pkey`.
- Serial columns keep their `nextval()` default; a migration from the pulled
  schema will not create the sequence. The fix turns an integer serial column
  into `GENERATED BY DEFAULT AS IDENTITY` (`int.auto.byDefault`): it drops the
  default, detaches and drops the old sequence, and starts the identity after
  both the highest id in the table and the old sequence's last value, so no id
  is handed out twice on a table that already has rows. `BY DEFAULT` rather than
  `ALWAYS` keeps inserts that give their own id working, as they did with
  `serial`; switch to `int.auto` later with a migration (`SET GENERATED ALWAYS`)
  once nothing writes ids. The fix is offered only when the column owns the
  sequence and no other column takes its default from it. A column whose default
  comes from a sequence it shares with other columns, or from one created on its
  own with `CREATE SEQUENCE`, keeps the `nextval()` default and is listed under
  `sequence` without a fix, because dropping that sequence would break the other
  users.
- Types without a builder (`money`, ranges, …), enums of other schemas and
  arrays of enums go through `customType()` with a passthrough codec, which
  hands over driver-native values.
- A column of a domain type is declared with the domain's base type,
  `customType<Decimal>("amount", { base: "numeric(30,10)" })`, so its values
  read as that type's builder reads them (a domain over `bigint` gives `bigint`,
  over `numeric` a decimal string, over `timestamptz` a `Date`), nested and in
  `$batch` too. A domain over a domain takes the innermost base type; a domain
  over a type without a builder (`json`, `oid`, `money`) is declared like a
  column of that type, with driver-native values. The domain's own `CHECK` and
  `NOT NULL` stay in the database, and migrations do not create the domain; each
  one is listed under `custom-type`.
- A foreign-key column takes the referenced key's type and collation; one whose
  collation differs from its key's is listed.
- A column made unique by a unique index named like the constraint
  (`User_email_key`, as Prisma does) is declared `.unique`; the fix
  `ADD CONSTRAINT … UNIQUE USING INDEX …` turns the index into that constraint
  in place, without rebuilding it.
- Composite, deferrable or cross-schema foreign keys, `ON UPDATE SET NULL` /
  `SET DEFAULT`, and foreign keys to columns without a primary-key or `UNIQUE`
  constraint stay plain columns.
- Multi-column unique constraints are declared as unique indexes of the same
  name; exclusion constraints, `NULLS NOT DISTINCT` indexes, generated-column
  expressions and partitions are reported but not declared. A full-text search's
  stored column (`aboutWords`, nullable, computed as `fullText()` computes it,
  with its GIN index and no other index or constraint on it) is declared as the
  search, `.search((t) => ({ about: { words: fullText(…) } }))`; any other
  generated column stays a column with its warning.
- Views, materialized views and triggers are listed: the schema neither declares
  nor manages them, so migrations leave them alone.
- More that exists only in the database is listed, each under its own code, so
  nothing disappears without a word:
  - `inheritance`: a table created with `INHERITS`. Parent and child are
    declared as two separate plain tables, so a database built from the schema
    does not show the child's rows in the parent.
  - `row-security`: a table with row-level security switched on, or with
    policies. The schema declares neither, so a database built from it leaves
    every row visible and writable.
  - `function`: functions and procedures of the schema that no extension owns,
    in one entry that names them (the first ten when there are more).
  - `sequence`: sequences no column owns, in one entry, each column whose
    default draws from a shared or free-standing sequence, and each identity
    column whose sequence has options (`START WITH 1000`, `INCREMENT BY 10`):
    `.auto` numbers from 1 by 1.
  - `unlogged`: an `UNLOGGED` table, which the schema declares as an ordinary
    one; the fix is `ALTER TABLE … SET LOGGED`.
  - `other-schema`: how many tables live in other schemas, per schema. `pull`
    reads one schema (the connection's current one), so those tables are not in
    the generated module. System schemas and tables owned by extensions are not
    counted.
- Prisma's `_prisma_migrations` history table is skipped and listed.
- Tables named in `ignoreTables` (config) or `--ignore-table <name>` are left
  out with their indexes, triggers and the enum types only they use, without a
  review entry; a foreign key pointing to one stays a plain column and is
  listed.

#### Moving from Prisma

Point `pull` at the database Prisma manages. The result declares
`casing: "preserve"`, every table with `.named("User")`, `timestamp(3)` dates,
`numeric(12, 2)` decimals, `bigint`, `jsonb` and `text.array` columns,
`.onUpdate.cascade` relations, `.unique` columns, Prisma's enums under their own
names (`oneOf("USER", "ADMIN").typeName("Role")`), implicit many-to-many tables
as junctions (`_CategoryToPost` with its `A` and `B` columns) and the `@@index`
indexes with their exact names, so queries run against the existing tables right
away. `drift` then lists only what the warnings announced: each
`User_email_key`-style unique index (fixed by the suggested
`ADD CONSTRAINT … USING INDEX`), the junction keys Prisma names
`_CategoryToPost_AB_pkey` (fixed by `RENAME CONSTRAINT`) and `SERIAL` ids (the
fix makes them `BY DEFAULT` identities that continue after the existing rows).
The CLI leaves Prisma's `_prisma_migrations` out of `drift`, `adopt`, `repair`
and `verify` (the `detectDrift` API reports it unless `ignoreTables` names it),
so the table can stay while Prisma still deploys. The move order:

1. `pull`, apply the fixes you accept, `pull` again.
2. Point the config at the module and run `drift` until only intended findings
   remain.
3. `generate initial`, then `adopt` on each existing database, so Symmetria owns
   the migrations from there.
4. Once no deployment runs `prisma migrate` any more, drop `_prisma_migrations`
   (by hand or in a `generate <name> --empty` migration).

**Moving gradually: Prisma and Symmetria side by side.** Nothing has to switch
at once. Right after `pull`, Symmetria reads and writes the tables Prisma
created, while the Prisma client keeps running against the same database; none
of the suggested fixes is needed for that. The fixes are what `drift` and
`adopt` need, and each one leaves the Prisma client working: enum types keep the
names the client uses (`"Role"`), renamed constraints are not used by the
client, unique indexes become constraints in place, and the serial fix keeps
`BY DEFAULT` identities, so ids the client or a seed script supplies are still
accepted while new rows continue after the existing ones. `@updatedAt` is set by
the Prisma client, not by the database: rows Symmetria writes need an explicit
`updatedAt`. Once Symmetria owns the migrations, stop running `prisma migrate`,
which would see Symmetria's changes as drift; parts of the application that
still use the Prisma client can regenerate it from `prisma db pull`.

After pulling, point the config at the module, run `drift` until only intended
findings remain, then `generate initial` and `adopt`. Programmatically,
`pullSchema({ execute, schemaName?, metadataSchema?, metadataTable?, ignoreTables? })`
returns `{ source, schemaName, tables, enumerations, extensions, warnings }`.

### Execution modes, timeouts and plans

`generate <name> --transaction batch|each|none` records the execution mode in
the shared journal. The API accepts the same `transaction` option:

- `batch` (default): adjacent batch migrations commit atomically as one group; a
  migration that adds enum labels ends its group, because the next migration may
  use the new label.
- `each`: commit this migration separately; earlier groups remain committed if
  it fails.
- `none`: each SQL statement commits independently. Use for
  `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY` or `VACUUM`.

Both directions use the recorded mode. `batch` and `each` work with every
driver. `none` runs statements outside a transaction and needs a driver with
pinned sessions, as both official drivers have; with a custom driver that only
runs whole transactions, `migrate` refuses such a migration before anything is
applied.

Run migrations over a direct connection or a session-pooled one, not through a
pooler in transaction mode (see
[transaction pooling](#transaction-pooling-pgbouncer)): there a session's
statements can reach different server connections, so a session advisory lock
would not keep two deploys apart. The runner checks before taking its lock: when
a second connection from the driver's pool answers from the same PostgreSQL
process as the migration session, or the session's own statements come from two
processes, the connection pools transactions. `migrate`, `rollback`, `adopt`,
`repair` and `--plan` then run as with a transaction-only driver: every group in
its own transaction under `pg_advisory_xact_lock`, with `SET LOCAL` timeouts,
re-reading the journal. A `none` migration is refused before anything runs
("…this connection pools transactions (such as PgBouncer with
pool_mode=transaction)…"). The second connection gets up to ten seconds to open,
which covers a slow connection to a distant server (TLS and a password exchange
over a long round trip). A pool of one connection (`max: 1`), or one whose other
connections are all in use, cannot answer, nor can a connection that takes
longer to open, and a session alone cannot tell, because a pooler hands a lone
client the same server every time. Such a driver is treated like a pooled one,
which is safe on a direct connection too, and a `none` migration is refused with
the reason ("…the pool gave it no connection: its pool has a single connection,
or other work holds the others…" or "…it did not answer within 10000ms…"), so
give the driver a connection to spare for `none` migrations. If the check was
misled (a busy pooler handed the server to another client) and a migration
transaction later lands on another server process, the run stops with "the
migration session moved from PostgreSQL process …" before that transaction
changes anything. With hosted poolers, point `databaseUrl` (or `DATABASE_URL`
for the CLI) at the direct or session-mode address for migrations.

```sh
symmetria migrate --plan --json
symmetria rollback --steps 2 --plan
symmetria migrate --advisory-lock-timeout 10000 --lock-timeout 5000 --statement-timeout 600000
```

Plans include SQL, migration IDs, execution modes and transaction group numbers;
they do not execute migrations. Config/API settings `advisoryLockTimeoutMs`,
`lockTimeoutMs` and `statementTimeoutMs` use milliseconds and default to 10,000,
5,000 and 600,000 respectively. A zero advisory timeout tries the lock once;
zero disables the PostgreSQL DDL or statement timeout. The default statement
timeout does not apply to the statements of a `transaction: "none"` migration:
it would cancel a long `CREATE INDEX CONCURRENTLY` after ten minutes and leave
an invalid index and an incomplete migration behind. Nor does the default lock
timeout apply to the statements of such a migration whose waits block no reads
or writes: `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`,
`REINDEX … CONCURRENTLY` and an `ALTER TABLE … VALIDATE CONSTRAINT` with no
other action. A concurrent build waits for every older transaction in the
database, so a five-second timeout would cancel it whenever any report or job
runs longer; these statements wait under a SHARE UPDATE EXCLUSIVE lock, behind
which no query queues. The other statements of the migration
(`ADD CONSTRAINT … NOT VALID`, `SET NOT NULL`, `DROP CONSTRAINT`) take locks
that reads and writes would queue behind, and keep the default. So does
`DETACH PARTITION … CONCURRENTLY`: its last step takes an ACCESS EXCLUSIVE lock
on the partition, and every query of the partition would wait behind it. A
`statementTimeoutMs`, `lockTimeoutMs`, `--statement-timeout` or `--lock-timeout`
you set yourself applies to every statement. Session settings are restored when
the operation finishes. The CLI cancels work on SIGINT/SIGTERM; the API accepts
an `AbortSignal`.

`status` reads the journal without taking the migration lock, so it reports
while another process is migrating. A `none` migration is recorded as
`incomplete` before its first statement runs; while another session holds the
migration lock, `status` reports it as running in another process
(`running: true` in `--json` and the API) and exits with code 0. Without a lock
holder it was interrupted or failed: `status` says "repair required" and exits
with code 1, as for a failure. When a `migrate` gives up waiting for the lock,
its timeout error names the PostgreSQL process that holds it: a migration still
running there, or the server process of one whose client went away while
PostgreSQL still runs its statement. A running migration only adds rows to the
journal, which never blocks the read. The journal is locked only while a
migration creates it or adds the columns an older journal lacks; `status` (and
`lint --pending`, which reads it the same way) waits at most two seconds for
that lock and then fails with a message saying the journal is locked, instead of
hanging.

`onEvent(event)` is a synchronous observer for `statement-start`,
`statement-end` and `statement-error`. Events include migration ID, direction,
one-based statement number, SQL and, after execution, duration. Errors expose
`MigrationExecutionError` with `migration`, `direction`, `statement`, `sql`,
`sqlState`, PostgreSQL's `detail` and the underlying `cause`. That stays the
error when the connection is lost during the statement (its server process
terminated, a failover): cleanup that fails on the lost session afterwards adds
a line to the message ("Afterwards, restoring the session settings and releasing
the migration lock failed too: …") instead of replacing it, and a `none`
migration's error is written to the journal over a fresh connection. That write
is tried again for up to ten seconds while the pool hands out connections lost
with the session; a new connection the server refuses, or an abort (Ctrl-C),
ends it at once, and the message says the journal does not record the error. An
attempt still waiting for its connection then writes nothing when it gets one,
and the CLI prints the error and exits without waiting for it. An abort cancels
the session's statement only while one runs. `driver.close()` waits for such an
attempt until its connection opens or fails: Bun.SQL gives up after its
`connectionTimeout` (30 seconds by default), while node-postgres waits for good
on a server that accepts connections but never answers, unless
`connectionTimeoutMillis` is set.

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
columns. A changed default is replaced by a single `SET DEFAULT`, so no commit
boundary leaves the column without one.

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
# Without a verification server: the snapshot from before the migration was generated.
git show HEAD~1:migrations/meta/snapshot.json > before.json
symmetria repair 000003_email_index --action retry --snapshot before.json
```

`retry` verifies the schema at the starting boundary and resets the journal so
the unchanged SQL can run again. `complete` verifies the destination boundary
and records completion. `meta/snapshot.json` holds the latest snapshot, and
`meta/migration.json` the one from before the latest migration (`undo`, written
by `generate`; a `squash` baseline and migrations generated before 3.3.0 have
none). So `complete` on the latest migration needs nothing more, and neither
does `retry` of it when `undo` is there and no verification server is
configured. Other boundaries are verified either by replaying the chain on the
`--verify-url` server or against the snapshot of that point passed with
`--snapshot <file>`: `meta/snapshot.json` as version control has it from before
the migration was generated. Its hash must match the journal's, so another
snapshot is refused. The API is `runner.repair({ id, action, snapshot? })`. A
crash may occur after PostgreSQL commits but before the statement count is
saved; that count is not an exactly-once guarantee. Reconcile data changes as
well as schema before repair. Schema verification cannot establish whether a
backfill, external function or other data-only operation has already run.

Generation and squash use a durable filesystem publication journal. After a
process crash, `symmetria recover` restores the previous files or finishes
cleanup of a committed publication. It refuses a lock owned by a live process or
another host. With no lock left behind it prints `Nothing to recover`
(`recoverMigrationFiles` resolves `false`, and `true` after a recovery). Keep
the SQL directories and both shared metadata files on the same filesystem. A
lock without readable ownership metadata requires manual inspection; the error
names the lock directory.

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
points at it and drops everything on `close()`. Extensions the schema needs
(`vector` for a search by meaning or a vector column, `pg_search` for `bm25()`)
are created in the database's default schema when they are missing, which needs
a role allowed to create them, and their schemas follow the test schema on the
`search_path`, so their types and operators resolve without a `searchPath`
option. The extension stays installed for later tests.

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
`query/`, `driver/`, `observability/`, `embedders/` (the embedding services'
HTTP client) and `entries/` (one module per package entry point, such as
`symmetria/pg`). CLI and migration sources live in `packages/kit/src`. Each
package builds into its own `dist` directory. See
[building and publishing](publishing.md).

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
