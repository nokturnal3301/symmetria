# Changelog

## 3.3.0 — 2026-11-21

Fixes and additions from running Symmetria in production with a search by
meaning over about 150,000 messages.

### Runtime (`symmetria`)

- `search.reindex()` no longer reads rows that have nothing to embed: a row
  whose embedded columns are all empty or NULL is left out by the query itself.
  Before, every call read such rows again; 15,000 of them cost about 235 empty
  round trips per pass at a batch of 64.
- `search.reindex()` writes a batch with one `UPDATE` instead of one per row,
  and no longer stores an embedding of text that changed while the model was
  answering (the row is embedded by the next call) or overwrites an embedding
  written in the meantime.
- `search.reindex({ order: "desc" })` starts from the highest primary key, so
  with increasing keys the newest rows are embedded first.
- New `search.missing({ where })`: how many embeddings `reindex()` would compute
  now.
- Half precision for embeddings: `meaning: model(...columns).half` keeps the
  embedding as `halfvec` (pgvector 0.7+) with a `halfvec_cosine_ops` index, in
  about half the space; models of up to 4,000 dimensions can then be indexed.
  `halfvec(n)` from `symmetria/vector` declares such a column directly.
- `find()`, `get()`, `byId()`, `by.<key>()` and a nested `connect` accept a safe
  integer for a `bigint` key in their types, as writes and filters already did;
  the runtime already accepted it.
- `onConflict()` and `upsert({ by })` take the name of a unique index as
  `by.<name>` names it (`onConflict("identity")` for
  `identity: index(…).unique`).
- Queries, writes and searches are assignable to `Promise<…>` in TypeScript:
  their `then`, `catch` and `finally` are typed as a promise's, and they carry a
  `Symbol.toStringTag` (`SymmetriaQuery`, `SymmetriaWrite`). A function typed
  `(): Promise<Row[]>` can return a query without `.execute()`.

### Kit (`symmetria-kit`)

- **Changed:** a search's snapshot records the model and the columns its
  embeddings are made of. Another model of the same length, or other columns,
  makes the migration clear the stored embeddings (`UPDATE … SET about = NULL`),
  which `lint` reports as destructive, so `generate` needs `--allow-destructive`
  and `reindex()` computes them again. Before, such a change produced no
  migration and the old embeddings kept describing the old text. Snapshots from
  earlier releases lack the record, so the first such change after upgrading is
  not noticed.
- Turning a search's meaning to `.half` and back converts the stored embeddings
  in place and builds the index again with the matching operator class; `pull`
  reads `halfvec` columns back.
- New command `discard [id]`: takes back the latest migration while no database
  has applied it, restoring the snapshot and the journal, so it can be generated
  again. It asks the configured database first (`--force` without one, or for an
  edited `up.sql`). The journal now keeps the snapshot before the latest
  migration (`undo`), which older releases ignore; for migrations generated
  before, the earlier snapshot is taken from the Git history. A migration
  deleted by hand, which made `generate`, `status` and `diff` refuse with
  "snapshot checksum does not match the migration journal", is repaired by
  `discard` too, and that error now says so.
- `generate` prints the review `lint` gives the new migration, so a caution such
  as a rewritten table is seen without running `lint`. The caution for a changed
  `fullText()` says that every index of the table is built again and names the
  vector index among them.
- `testDatabase()` creates the extensions a schema needs (`vector`, `pg_search`)
  when they are missing and puts their schemas on the test schema's
  `search_path`; a manual `CREATE EXTENSION` and the `searchPath` option are no
  longer needed for them.

## 3.2.0 — 2026-11-20

### Runtime (`symmetria`)

- New entry `symmetria/opentelemetry`: `traced(driver, { tracer })` reports
  every statement as a client span (`SELECT users`, with `db.system.name`,
  `db.operation.name`, `db.collection.name`, `db.query.text`, returned rows and
  the SQLSTATE of a failure) and every transaction as a span around its
  statements. The tracer is passed in, so the package gains no dependency.
  Values are never recorded. It also wraps a driver that carries a profiler.
- ``sql<boolean>`…` `` is accepted wherever a predicate is: `where`, `having`,
  predicate lists, `and()` / `or()` / `not()`, JOIN conditions, mutation
  `where()` and scopes, and it has `.and()` / `.or()`. Before, it had to be
  written ``sql<boolean>`…`.is(true)``.
- **Changed:** `is(null)` and `isNot(null)` on a JSON path
  (`doc.meta.path("size").is(null)`) count a key that holds JSON null as null,
  like a missing key. The path already read back as `null` in both cases and
  `coalesce()` / `whereNotNull()` already treated them alike; `is(null)` used to
  match only the missing key.
- A table with an embedding no longer asks the model for rows the write then
  refuses: a missing required column, a value its column cannot hold, an unknown
  column or an impossible chained call rejects the insert or upsert first.
- A scope on a junction table (`$scope({ postsTags: … })`) is now covered by
  tests and described in the reference: reads through the relation see only the
  admitted links, and a nested `connect` is checked like any other insert.

### Benchmarks

- Reads warm up sequentially for one second (`BENCH_WARMUP_MS`) after the
  concurrent burst. With 128 warm-up calls a pass could start before the runtime
  had finished compiling the library's code, and the same scenario then differed
  by a factor of two or three between passes.

## 3.1.0 — 2026-11-17

### Runtime (`symmetria`)

- `symmetria/pg`: `postgres({ url, prepare: true })` sends reads and writes as
  named prepared statements, parsed once per connection. Measured through
  node-postgres on a local database: a point read 123 µs to 105 µs, a list with
  a JOIN 208 µs to 152 µs, a nested read 6% faster. Off unless set; the
  reference says when not to turn it on (an old connection pooler, general
  plans, a column retyped under running connections).
- `byId(key).one()` and `.maybeOne()`, and the same on a unique lookup
  (`by.email(…).one()`), use the statement `get()` and `find()` compile once per
  table and key instead of building and compiling a query on every call: 2.5 µs
  of client work became 0.9 µs, about 4 µs off an 80 µs point read on a local
  database. A shape, options, a scope or a profiler take the ordinary path, as
  with `get()`.
- A path through a to-one relation (`post.author.name`) no longer builds the
  relation's methods (`count()`, `sum`, `some()`, …) it does not use, and `sum`
  / `average` / `minimum` / `maximum` of any relation are built when first read:
  building a list query with one path takes 3.3 µs instead of 4.7 µs.
- A read with nested rows does less work per call. Measured on a page of 50
  users with three posts each and their tags, without a database: building and
  compiling the query 18 µs to 11 µs, decoding the rows 8 µs to 4 µs, the whole
  call 31 µs to 17 µs. Nested rows whose fields need no decoding are returned as
  the driver parsed them instead of being copied; a row decoder is found by its
  field names; the tools a shape callback receives (`join`, `whereNotNull`,
  `row`) and a relation's methods are made when they are read; column handles
  share one set of getters per table; the first shape of a relation reads the
  relation's own sources instead of a copy of them.
- Bulk inserts spend half the client time per row (170 µs to 81 µs for 500 rows
  of three columns): a value node is built without object spreads and a column
  is found by name in a map instead of a search per value.

## 3.0.0 — 2026-11-17

Fixes from a bug hunt over 2.5.0: complex reads, cursor pages, tenant scopes,
transactions, value round trips, search and about ninety schema migrations were
compared with hand-written SQL on PostgreSQL 16 and 18.

### Changed behaviour

- **An UPDATE or DELETE whose filter holds for every row is refused.** A list
  that filtered down to nothing
  (`where: (post) => [userId && post.authorId.is(userId)]` without a user),
  `where: []`, `and()`, `not(or())` and `notIn([])` used to write the whole
  table; they now throw "where() leaves no condition", as `where: {}` already
  did. `.all()` remains the way to write every row. A filter no row passes
  (`in([])`, `or()`) still writes nothing.
- **A `$scope()` no longer stands in for a filter.** `tenant.posts.delete()`
  deleted every post of the tenant; it is refused like an unscoped
  `posts.delete()`, and `tenant.posts.delete().all()` says it.
- **Under `$scope()`, a path to a scoped table keeps the row.** A required
  relation was an INNER JOIN with the scope in its `ON`, so a comment whose
  author the scope hides vanished from any query that read, filtered or ordered
  by `comment.author.name`, and `post.comments.every(…)` did not count it. The
  path is now a LEFT JOIN when its target has a scope: the row stays and the
  field is `null` (its type still says `string`). The smart `join()` follows;
  `innerJoin()` keeps the old result.

### Runtime (`symmetria`)

- 2.5.0 regression: code started inside a `$transaction()` and still running
  after it (a timer, a background loop, a promise nobody awaited) was refused
  with "would wait forever" on every later query through the database, although
  the connection was free again; with `max: 1` one `setTimeout` was enough. Only
  transactions that are still open count now.
- `forUpdate` / `forShare` failed with "FOR UPDATE cannot be applied to the
  nullable side of an outer join" when the query followed an optional relation
  (`post.editor.name`). Without `of`, such a query locks its root table and the
  tables joined with INNER JOIN.
- `symmetria/pg` asks every new connection for PostgreSQL's default output of
  intervals, `bytea` and doubles, as it did for dates: with
  `bytea_output = escape` every `bytea` read threw, `IntervalStyle` changed the
  text of an interval, and `extra_float_digits = 0` read `0.30000000000000004`
  as `0.3`. `bytea` is read in the `escape` form on both adapters.
- `sql` is a template tag only: `sql(["now()"])`, called as a function, ran its
  argument as SQL.
- Refused by name instead of by PostgreSQL or not at all: an array as a key of
  `get()` / `find()` / `byId()`, `limit: "5"`, and an object or array written to
  a `text` or `varchar` column (it was stored as its JSON text).
- `symmetria/better-auth`: `incrementOne` without a filter says `.all()`.

### Kit (`symmetria-kit`)

- Dropping a column that a full-text search read failed with "cannot drop column
  … because other objects depend on it": the generated document column is now
  dropped first.
- Replacing an embedding model by one of another length failed on the first
  stored embedding ("expected 1536 dimensions, not 1024"). The migration empties
  the column (`USING NULL`) and `lint` reports it as destructive; run
  `search.reindex()` afterwards.
- A type change PostgreSQL has no cast for (`integer` to `uuid`, a value to an
  array of it) produced SQL that failed even on an empty table; `generate`
  refuses it and asks for the conversion under `using` in the `--diff` file.

## 2.5.0 — 2026-11-17

Fixes from a bug hunt over 2.4.0: five areas (reads, bulk writes, key lookups
and windows, search, concurrency and migrations) were run against databases of
300 thousand to 10 million rows on both drivers.

### Runtime (`symmetria`)

- **Nearest-neighbour queries no longer lose rows.** pgvector's HNSW index picks
  40 candidates and applies the other filters afterwards, so `orderBy` a
  distance with `limit: 100` returned 40 rows, and with a `where` that the
  neighbours failed it returned none. A query ordered by an ascending distance
  with a `limit` now widens the index scan for its own statement
  (`hnsw.ef_search`, and `hnsw.iterative_scan` from pgvector 0.8). `page()`
  ordered by a distance compares rows exactly. See "pgvector" in the reference.
- **`search()` by meaning with `where` or `$scope()` returned nothing** when the
  nearest rows failed the filter, and a hybrid search silently became a search
  by words. Up to 10,000 rows that pass the filter are now ranked exactly (a
  search within one tenant of 300 thousand documents: 4 ms, with the 10 right
  rows instead of none); more are ranked through the index, which keeps
  scanning. `limit` above 40 returns `limit` rows.
- **`stream()` returns the rows `await` returns.** PostgreSQL planned the cursor
  to start fast and could pick an approximate vector index: a query that
  returned 7,143 rows streamed one. The cursor is now planned to be read to the
  end (`SET LOCAL cursor_tuple_fraction = 1`).
- **`connectOrCreate` no longer deadlocks.** Its upsert locked every existing
  row it met until the transaction ended, so two inserts naming the same tags in
  opposite orders aborted each other (39 of 64 concurrent inserts). An existing
  row is now only read, and rows that have to be created are created in key
  order. Existing rows are no longer rewritten, and no longer use up an identity
  value.
- 2.4.0 regression, node-postgres: a query ordered by a selected expression
  failed with `inconsistent types deduced for parameter $1` when the same bare
  `sql` value stood in the select list and in `where`. A bare parameter is no
  longer shared between clauses.
- 2.4.0 regression: `page()` cursors issued by 2.3.0 were refused for queries
  whose SQL 2.4.0 had made faster. The cursor's fingerprint is now taken from
  the plain form of the query, so it survives such changes; cursors issued by
  2.3.0 work again. Cursors issued by 2.4.0 itself for those queries (two
  aggregates of one relation, an ordering by a selected expression) are refused
  once.
- 2.4.0 regression: a bulk insert whose values in one column exceeded 1 GB
  closed the connection, since one array is one protocol message. Above 128
  million characters the insert goes row by row in pieces, as before 2.4.0.
- 2.4.0 regression: a custom type that encodes to a `Date` failed for years
  before 1 and after 9999 in bulk inserts of 100 rows or more; on Bun it failed
  below 100 rows as well. Both forms now send the text PostgreSQL reads.
- A chunked `upsert()` let the later of two duplicate keys win silently when the
  keys only met after the column rounded them (two instants of one second in a
  `timestamptz(0)` key). Timestamp keys are compared at the column's precision,
  and `…+00:00` equals `…Z`.
- A JavaScript number in a `numeric` column lost digits on Bun in inserts below
  100 rows (`0.1 + 0.2` was stored as `0.3`). Numbers are sent as their exact
  text.
- Full-text `search()` returned rows of equal rank in a different order on every
  call; ties are now broken by the primary key. Each list also sends its
  question once instead of three times, which halves the slowdown Bun's prepared
  statements show on a frequent word (a generic plan computed the rank twice).
- `forUpdate` / `forShare` on a read from a CTE locked nothing, as PostgreSQL
  defines it, without a word; it is now an error.
- **Full-text `search()` keeps its document in a stored generated column**
  (`<search>Words`, hidden like the embedding) instead of an expression index.
  Ranking parsed the text of every matching row again: a search for a common
  word that matched 115 thousand of 300 thousand documents took 0.5 s, and on
  Bun 2.4 s after the fifth call, when PostgreSQL stops spreading the work over
  several cores. It now takes 40 ms, and 0.2 s on Bun after the fifth call.
  **This needs a migration**: `symmetria-kit generate` adds the column and moves
  the GIN index to it; adding the column rewrites the table once.
- `$close()` ends open streams instead of waiting for their loops: a loop that
  called `$close()` waited for itself forever. A loop that stops there ends
  quietly; one that reads on fails with "the database was closed while this
  stream was open". A stream read by other code while the database is being
  closed now fails the same way instead of holding the close back.
- An IVFFlat index declared in the schema no longer comes up short of rows under
  a filter either: it reads on past its nearest lists (pgvector 0.8), and the
  statement sorts the rows once more, since that mode returns them only roughly
  in order.
- A unique index declared in the schema options (`schema(defs, { indexes })`) is
  a key in the types: `find({ tenant, cover })` and `by.<index>` compile.
- `$close()` called inside a `$transaction()` of the same database waited
  forever; it is now an error.
- `column.asc.desc` (outside the types) silently dropped the ordering; it is now
  an error. `over()` refuses unknown options (`partition` for `partitionBy`)
  instead of ignoring them, and a `partitionBy` that is not a list.
- `get()` and `find()` types: an object with a column beside the key, or with
  two keys at once, is a type error (it was refused only at run time), and so is
  a `prepare()` parameter, which a lookup that runs at once cannot wait for. A
  unique index on a descending column is a key for lookups and
  `connectOrCreate`, in the types as well; a unique index with an expression
  among its keys no longer makes its other columns a key in the types. The
  errors about a missing or composite primary key no longer name `byId()` when
  `get()` or `find()` was called.
- A query through the database itself from inside transactions that hold every
  connection of the pool (with `max: 1`, any `db.…` call inside
  `db.$transaction()`) waited forever for a connection its own caller held. It
  is now refused with an error that says to use the transaction's database or
  raise `max`. Such a call that was not awaited used to run after the
  transaction; it is refused as well.
- PostgreSQL 18 reports a `RESTRICT` foreign key with SQLSTATE 23001 instead of
  23503; it is a `ForeignKeyViolation` (`kind: "foreign-key"`) there too.
- Values of the wrong JavaScript type, which only code outside the types can
  send, are refused the same way on both drivers and in both insert forms
  instead of depending on them: a number or string in a `boolean` column, a
  boolean in an `integer` column, a number in a `date`, `timestamp` or
  `timestamptz` column.
- `QueryError.column` on Bun was a number (the engine's source position) when
  PostgreSQL named no column; it is `undefined`.
- `search()`: an empty question finds nothing without asking the model, a vector
  of the wrong size is refused with the expected size, and a zero byte in the
  question no longer fails the BM25 search.
- `where: { embedding: [...] }` compares a vector column with the vector.
- An invalid `Date` in a `date` column is refused instead of being sent as
  `0NaN-NaN-NaN`. In array literals a boolean is `true` / `false`, as in a plain
  parameter.
- A bulk insert keeps the array form when a `jsonb`, `real` or `vector` column
  is NULL in every row.

### Kit (`symmetria-kit`)

- A migration that only widens a column (`numeric(14,2)` to `numeric(16,2)`, a
  longer `varchar`, `varchar` to `text`) no longer drops and recreates the
  indexes and checks on it. PostgreSQL changes such a column in place, so the
  migration of a large table no longer rebuilds its indexes under a lock.
- Stored generated columns (those of full-text searches) are created, compared
  by `drift`, and dropped and added again around a change of the columns they
  are computed from, which PostgreSQL does not allow in place. `lint` reports
  the table rewrite as a caution and never counts such a column as lost data.
- `lint` said an enum "is rebuilt" when the migration only adds labels with
  `ALTER TYPE … ADD VALUE`; it now says which of the two happens.

## 2.4.0 — 2026-11-16

### Runtime (`symmetria`)

- An ordering by a selected field repeats the field with the same SQL text and
  the same parameters, as grouped queries already did. PostgreSQL then
  recognises one expression and computes it once per row: a list sorted by a
  relation aggregate without `limit` ran about a fifth faster on a 3-million-row
  table (37 ms to 30 ms). A filter that repeats a selected expression shares its
  parameters too, so a pgvector query that selects, filters and orders by one
  distance sends the vector once instead of three times.
- Aggregates over one relation with one filter are computed by one subquery:
  `user.orders.count()`, `user.orders.sum.total`, `user.orders.average.total`
  and `user.orders.maximum.createdAt` in one shape read a user's orders once
  instead of four times. A table of 8,925 customers with these four totals over
  3 million orders went from 276 ms to 150 ms, and a page of 50 from 19 ms to 12
  ms, the time of the hand-written `LATERAL` join. The subquery is joined only
  where it cannot cost more: when every row is returned, or after a page has
  been cut; a query limited and sorted by a total keeps per-row subqueries.
- `get()` and `find()` without a shape compile their statement once per table
  and key and only bind the key afterwards, in transactions too: the client cost
  of such a read went from 3.4 µs to 0.3 µs, that of a prepared query. Scoped
  tables, tables with computed fields, `$batch` and profiled drivers take the
  ordinary path.
- A bulk `insert()` or `upsert()` of 100 rows or more whose rows carry the same
  columns as plain values is sent as one array per column
  (`INSERT … SELECT * FROM unnest(…)`). 20,000 rows with a `jsonb` column went
  from about 260 ms to about 210 ms, the time of the same statement written by
  hand, and are one statement instead of two, since the parameter count no
  longer grows with the rows. Inserts with defaults per row, SQL expressions,
  enums or array columns keep `VALUES`.
- `some()`, `none()` and `every()` take a list of predicates joined by `AND`,
  like `where`: `user.orders.some((order) => [order.status.is.paid, …])`. Falsy
  entries are skipped.
- `count()`, `sum()` and the other aggregates no longer allocate a wrapper for
  `.over()` on every call (2.3.0 added about 1 µs to every query that counts a
  relation).

## 2.3.0 — 2026-11-16

### Runtime (`symmetria`)

- `get()` and `find()` read a row by a unique key given as an object of its
  columns, `db.users.get({ email })` or
  `db.handles.find({ tenant: "team", handle: "ada" })` for a unique index over
  two columns, next to the primary key's value. A table without a primary key
  but with a unique key has both methods now. An object that is not a key of the
  table rejects with a message that lists the table's keys; for a composite
  primary key given incompletely this message replaces the former
  `byId() requires exactly these key fields`.
- A CTE or a derived table given options and no fields reads all its fields, as
  a table does: `await ranked({ where: (post) => post.position.atMost(3) })`.
  The types already allowed this call, and it threw
  `select fields in a shape before compiling or executing a query` when it ran.
- Aggregates have `.over()`, like the ranking functions:
  `sum(post.views).over({ partitionBy, orderBy })`, also on `count`, `average`,
  `minimum` and `maximum`. `over(sum(post.views), options)` is unchanged.
- `column.asc` and `column.desc` are short for `ascending` and `descending`, and
  an `orderBy` object accepts `"ascending"` and `"descending"` next to `"asc"`
  and `"desc"`.

### Documentation

- The reference, guide, READMEs and examples use one spelling throughout: `db`
  for the database, a singular row name in callbacks, `await` without
  `.execute()`, slots (`one`, `maybe`, `many`) for relations, `get()` / `find()`
  for reads by key, the `where` option for UPDATE and DELETE, column names in
  `returning()`, and `{ selected }` for selected fields. The earlier relation
  spelling has its own section in the reference.

## 2.2.0 — 2026-11-16

### Runtime (`symmetria`)

- `table(...).search((row) => ({ about: { words, meaning } }))` declares what a
  table is searched by, and
  `db.table.search(shape?, { about: "question", where, limit })` ranks its rows
  by words, by meaning, or by both merged by reciprocal rank fusion, in one
  statement. `words` is `fullText()` (PostgreSQL's own) or `bm25()` (the
  `pg_search` extension); `meaning` is an embedding model: `voyage4` and others
  from `symmetria/voyage`, `ollama("bge-m3")` from `symmetria/ollama`, or
  `embedder(size, fn)` from `symmetria/search`.
- A search by meaning keeps its embedding in a hidden column: `insert()`,
  `upsert()` and nested inserts compute it before the statement is sent, an
  `UPDATE` of the embedded text clears it, and `db.table.search.reindex()`
  computes the missing ones.
- Ready embedding models, each calling its service's HTTP API without a
  dependency: `symmetria/voyage`, `symmetria/openai`, `symmetria/cohere`,
  `symmetria/google`, `symmetria/mistral`, `symmetria/jina` and, for local
  models, `symmetria/ollama`.
- `symmetria/better-auth`: a better-auth database adapter,
  `betterAuth({ database: symmetriaAdapter(db) })`. `npx auth generate` writes
  the auth tables as Symmetria `table()` declarations, plugin tables included.
- The extensions a search needs (`vector`, `pg_search`) are recorded without
  `extensions: [...]` in the schema options.
- `index(...).using("bm25")` for `pg_search` indexes.

### Kit (`symmetria-kit`)

- Migrations, `drift` and `pull` handle `bm25` indexes and the column and
  indexes a `.search()` declaration creates.

## 2.1.0 — 2026-11-16

### Runtime (`symmetria`)

- `in()` / `notIn()` with more than 1,000 values on a `varchar(n)` or
  `numeric(p,s)` column no longer cut or round the listed values to the column's
  length or scale before comparing. Before, `code.in([...])` on `varchar(5)`
  matched `'abcde'` for a listed `'abcdefgh'`, and a `delete().where(...)` with
  such a list could remove rows that were not listed. Bound values are now cast
  to the base type (`varchar[]`, `numeric[]`).
- `match()` returns literal branches whole when another branch is a `varchar(n)`
  or `numeric(p,s)` column (`"Draft (unpublished)"` came back as `"Draft"`), and
  so does a prepared parameter selected as a field.
- An array element longer than a `varchar(n).array` column allows is refused by
  PostgreSQL on write instead of being cut silently.
- A value cast to a `char(n)` column's type keeps its characters: the cast is to
  `bpchar`, since plain `char` means `char(1)`.
- An upsert recognises two spellings of one key: `"1"` and `"1.0"` on a
  `numeric` key (also values that round to the same number at the column's
  scale), a UUID in either letter case, a `char(n)` value with or without
  padding. Before, such rows failed inside PostgreSQL in one statement, and in a
  large insert split into several statements the later row silently replaced the
  earlier one.
- `in()` and `notIn()` reject a `null` in the list where the query is built:
  `NOT IN (…, NULL)` matches no row. Combine the list with `is(null)` or
  `isNot(null)`.
- The `symmetria/pg` adapter sets `DateStyle` to ISO on every new connection.
  With another style set for the database or role (`SQL, DMY`), timestamps read
  as `null` or with day and month swapped, and page cursors were refused.
- Relations are declared on both sides: a slot on the referenced table
  (`posts: many`, `profile: one`, `comments: many.cascade`) and a key that
  claims it (`author: one(users.posts)`, `editor: maybe(users.edited)`,
  `parent: maybe(self.children)`). The slot is a typed property of its table, so
  a wrong name is an error on that line. `one()` and `maybe()` index the key
  (`.noIndex` opts out) and take `.cascade`, `.restrict`, `.setNull`, `.unique`,
  `.by()` and `.column()`. The earlier spellings (`author: users`,
  `users.index`, `.inverse()`, `self`, `junction()`) are unchanged, declare the
  same tables and can be mixed with slots.
- `tags: many(tags.posts)` declares a many-to-many relation and creates its
  junction table (`posts_tags`, `db.postsTags`), with `.with({ … })` for its own
  columns, `.named()` and `.restrict`. `link(posts.tags, tags.posts, { … })`
  declares that junction by itself, and `link({ a: users, b: teams })` is
  `junction()` whose rows go with either side.
- `db.users.get(id)` and `db.users.find(id)` read one row by primary key, whole
  or through a shape; `find()` returns `null` when there is none.
- A query given options and no fields reads the whole row:
  `await db.users({ where: { active: true } })`. A bare table still does not
  execute. In a shape, `(post, { row }) => ({ ...row, author: … })` spreads the
  source's columns.
- `where` takes an object of equalities
  (`{ state: "published", editorId: null }`) and `orderBy` an object of
  directions (`{ spent: "desc" }`) over selected fields and columns. The
  selected fields are also among the tools of `orderBy`, `groupBy` and `having`
  callbacks: `(user, { selected }) => …`.
- Predicates chain:
  `views.above(10).and(state.is.published.or(pinned.is(true)))`.
- `db.orders.aggregate((order, { sum }) => ({ total: sum(order.amount) }))`
  returns one object.
- Nested inserts read the rows they `connect` together and write rows that only
  connect in one multi-row INSERT: twenty posts connecting twenty authors are 2
  statements instead of 40 (about three times faster), and an order whose items
  each connect a product costs about what the same statements written by hand
  do.
- `db.$batch((db) => [db.users.get(id), db.posts({ … }), db.posts.count()])`
  sends several reads as one statement: one round trip and one snapshot of the
  data, on both drivers, inside transactions and under `$scope()`. `$batch` is
  now a reserved table name.
- `update(values, { where })` and `delete({ where })` take the filter as an
  option; an object that names no column is refused instead of writing every
  row.
- `upsert(row, { by: "sku" })` inserts or overwrites the row with that key, with
  `update: [...]` to choose the columns.
- `returning("id", "name")` and `returning()` (the whole row).
- Queries and writes have `catch()` and `finally()` next to `then()`.
- Errors are classes: `NotFoundError`, `TooManyRowsError`, `OutOfScopeError` and
  `DuplicateConflictKeyError` extend `SymmetriaError` (same `code` and message
  as before), and database failures from the built-in adapters are
  `UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`,
  `CheckViolation`, `ExclusionViolation`, `SerializationFailure`,
  `DeadlockDetected`, `ConnectionError` or `QueryError`, with `kind`,
  `sqlState`, `table`, `column`, `constraint` and `detail`.
- A keyed link keeps its `by()` column type after `.nullable`, `.unique` and
  `.index`.

### Changes to note when upgrading

- A database error from `symmetria/pg` or `symmetria/bun` is now a `QueryError`
  that wraps the driver's error (`error.cause`) and copies its fields. Code that
  compared it with the driver's error object by identity, or read `error.name`
  or `error.constructor`, sees the new class; `sqlState()`, `databaseError()`,
  `error.code` and the message are unchanged.
- `symmetria pull` writes foreign keys as `one(users)` / `maybe(users)` with
  slots on the referenced tables, and a junction whose keys both cascade as
  `link({ … })`. Schemas pulled earlier keep working as they are.

### Kit (`symmetria-kit`)

- `pull` writes the relation syntax above: `author: one(users).cascade`,
  `editor: maybe(users.inverse("postsByEditor")).noIndex.setNull`, and
  `posts: many` on the referenced table.
- `generate` and `diff` see a changed CHECK or index expression when only a
  literal's kind or type changed: a number against the same digits as a string
  (`doc -> 0` and `doc -> '0'`), or the same text as `timestamptz` and
  `timestamp`, or as `jsonb` and `json`.
- A column changed between `timestamptz` and `timestamp` converts with
  `USING "column" AT TIME ZONE 'UTC'` in both directions. The plain cast used
  the time zone of the session that ran the migration. An array column
  (`timestamptz[]` ↔ `timestamp[]`) is converted with the session's zone set to
  UTC around the statement (`SET TIME ZONE 'UTC'` … `RESET TIME ZONE`).
- `rollback` in a terminal reverts exactly the migrations its confirmation
  showed: if another process changed the journal in between, it stops before
  running any SQL. `runner.rollback({ expected: [...] })` does the same from
  code.
- A driver whose pool has one connection can no longer be mistaken for a pinned
  session behind a transaction-mode pooler: without a second connection to
  check, the runner locks per transaction and refuses `transaction: "none"`
  migrations, naming `max: 2` as the fix.
- `drift` no longer reports `char(n)` and `decimal(p,s)` columns as changed
  (PostgreSQL prints `character(n)` and `numeric(p,s)`), and it reports a column
  whose type was replaced by a type of the same name from another schema.
- `repair --snapshot <file>` verifies a boundary against the snapshot of that
  point (`meta/snapshot.json` from version control), so a failed `--online`
  migration can be retried without a `--verify-url` server; the error for a
  missing one names both options.
- `rollback` asks for the database name before `TRUNCATE`, `DROP SCHEMA` and
  `DROP OWNED` as well, and no longer misses a `DROP TABLE` that follows a
  comment.

## 2.0.0 — 2026-11-15

### Changes to note when upgrading

- `symmetria rollback` no longer runs unasked. In a terminal it lists the
  statements of `down.sql` that remove data or database objects and waits for a
  yes; a rollback that drops tables needs the database name typed out. Without a
  terminal (scripts, CI) it exits with code 1 unless `--yes` is passed.
- In the dashboard and in questions, a digit only moves the selection; Enter
  runs the selected action.
- `generate` asks for `--allow-destructive` when a column changes from an
  integer type to `boolean` (every non-zero value becomes `true`) or to a
  narrower integer type (`bigint` → `integer`, `bigint` / `integer` →
  `smallint`), where values that no longer fit make the migration fail.
- The default 10-minute statement timeout no longer applies to
  `transaction: "none"` migrations, so it cannot cancel a long
  `CREATE INDEX CONCURRENTLY` and leave an invalid index. A timeout set with
  `--statement-timeout` or `statementTimeoutMs` still applies.
- A plain object is no longer accepted as a raw SQL default: write
  ``.default(sql`now()`)``. `.default({ kind: "sql", sql: "…" })` on a `jsonb`
  column now stores that object as the JSON value it is.
- A transaction no longer runs the `$scope()` callbacks of tables it does not
  touch; `$scope()` itself still runs the callbacks it is given once, so a
  callback that cannot be a filter fails there.
- Tables named `$scope` or `then` are rejected as reserved names.

### Runtime (`symmetria`)

- Order, group and filter by a selected field without writing its expression
  again: `orderBy`, `groupBy` and `having` callbacks receive the projection's
  fields as a third argument
  (`orderBy: (user, tools, selected) => selected.spent.descending`).
- Nested inserts write sibling children in one statement: an order with three
  items is 2 INSERTs instead of 4, and 22,000 children are 3 statements instead
  of 22,001. Many-to-many link rows are batched as well.
- `dateTrunc(unit, value, { timeZone })` buckets timestamps and dates by day,
  week, month and the other PostgreSQL units.
- `column.set(key, value)` on `jsonb` columns changes one key (or a nested path)
  and keeps the rest of the document.
- Text that is not a number (`"abc"`) for a `numeric` column is rejected before
  the statement is sent, in writes, filters, lists, prepared parameters and
  arithmetic, with a message that shows the value.
- A scoped query built once and then used inside another `$scope()` callback
  (`documents: (d) => d.organizationId.in(allowed)`) reads the current values of
  its own scope on every execution. Before, it kept the values from the moment
  it was built, so reads, updates and deletes could run for the previous tenant.
- Starting a transaction or calling `$scope()` on a large schema is far cheaper:
  about 50 times on 100 tables (an empty transaction went from 0.4 ms to under
  0.01 ms of CPU). Table handles are created on first use.
- A JSON default shaped like `{ kind: "sql", sql }` is stored as a value; only a
  `sql` template is a raw SQL default.
- `column.is` and `column.isNot` behave like ordinary functions (`.call`,
  `.bind`, `.name`); on enum columns only the declared labels are predicates.
- A page cursor is accepted or refused the same way whether the query object is
  reused or built again; it no longer depends on the current `$scope()` values.
- A CTE used only in `doUpdate(…, { where })` no longer fails with an internal
  error.
- A column of another query inside `lag()` / `lead()` is rejected when the query
  is built.
- A projection field left as an uncalled relation, tool or callback gets an
  error that names the field and says to call it or select one of its fields.
- `page()` notices a window function wrapped in `searchRank()`,
  `searchHeadline()` or `searchDocument()`, so later pages no longer compute the
  window only over the rows after the cursor.
- On tables whose primary key is declared in a different order than its columns,
  updates and deletes through a relation path, nested `connect` and
  `connectOrCreate` list the key columns in the declared key order. The
  statements are equivalent; only the column order in the SQL text changes.
- A CHECK or index expression with an unsupported part names that part in its
  error ("cannot contain length()") instead of always blaming aggregates,
  subqueries or placeholders.
- Schema error messages no longer say "experiment".
- `@types/bun` is declared as an optional peer dependency for `symmetria/bun`.

### Kit (`symmetria-kit`)

- `rollback` asks before it runs (see above); `--yes` skips the question.
- The dashboard's "Rollback latest migration" goes through the same question, so
  one mistyped key can no longer drop a column or, after `squash`, every table.
- A migration that failed outside a transaction can be fixed in its own files:
  `status`, `migrate` and `repair` no longer answer "checksum mismatch" for an
  incomplete migration whose `up.sql` or `down.sql` was edited. `migrate` still
  refuses and names the incomplete migration, `repair` verifies the schema as
  before, and the journal takes the checksum of the files that finally ran.
  Applied migrations stay protected against edits.
- Editing a CHECK or a partial-index condition by adding a cast that changes the
  value (`::varchar(3)`, `1.9::integer`) is detected as a schema change instead
  of "No schema changes".
- SQL lint no longer skips statements that mention a table or column named
  `rename`, and schema lint no longer reports the indexes and checks of a
  renamed table or column as new.
- A column, table or index named `concurrently` no longer forces
  `transaction: "none"`; `REFRESH MATERIALIZED VIEW CONCURRENTLY` may run in a
  transaction; `CREATE` / `DROP DATABASE`, `CREATE` / `DROP TABLESPACE` and
  `ALTER SYSTEM` now require `transaction: "none"`.
- `pull` reports what it cannot declare instead of leaving it out silently:
  table inheritance, row-level security, functions and procedures, free-standing
  or shared sequences, and tables in other schemas (codes `inheritance`,
  `row-security`, `function`, `sequence`, `other-schema`). A sequence shared by
  several columns no longer gets the identity fix that would drop it.
- `drift` on a database that is behind the local chain (after `rollback`, or
  before `migrate`) says so instead of listing the pending changes as drift, and
  checks the applied state when `--verify-url` is set; JSON output gains
  `behind`.
- The live profiler shows the error message of a failed request.
- "Created" shows the migrations directory relative to the working directory,
  and long lines wrap after a space or `/` instead of in the middle of a word.

## 1.2.0 — 2026-11-14

### Runtime (`symmetria`)

- `$scope()` values are no longer frozen into reused or prepared queries: every
  execution (reads, `update()` / `delete()`, upserts, lookups, nested relations)
  binds the scope's current values, so a prepared query never reads or writes
  another tenant's rows.
- Scoped databases check every row they write, like row-level security's
  `WITH CHECK`: flat, bulk, chunked and nested inserts, both upsert paths,
  `update()` and lookup updates that would leave a row outside the scope fail
  with `SYMMETRIA_OUT_OF_SCOPE` (naming the table) and write nothing. The check
  runs in the same statement, and unscoped SQL is unchanged. A scoped
  `doUpdate(values, { where })` that conflicts with a row outside the scope
  throws too, while a false condition inside the scope still skips the row; a
  violation caught inside `$transaction` is reported as `SYMMETRIA_OUT_OF_SCOPE`
  by later operations and by the transaction.
- One rule for when errors surface: mistakes in a query's shape throw where the
  query is built, problems with the values it carries (NULL for NOT NULL,
  invalid `jsonb(schema)` input, out-of-range numbers, invalid `Date`s,
  duplicate upsert keys, …) reject its promise when it runs, for reads and
  writes alike. `toSQL()` throws both kinds; prepared queries check values on
  every execution.
- A CTE can no longer take a table's SQL name (`.cte("posts")` throws), so it
  can no longer silently replace that table in the statement.
- `jsonb(schema)` stores the schema's input and runs transforms once, on read;
  inserts and updates are typed with the schema's input type. JS `null` on a
  non-nullable `jsonb` column is stored as JSON `null`.
- `driver.session()` closes its connection afterwards, so its settings, advisory
  locks, temporary tables and any transaction left open never reach other
  queries.
- Operations on a transaction or session run one at a time in call order:
  `Promise.all` of queries, chunked bulk inserts and nested inserts work, and
  node-postgres no longer warns about overlapping queries. An operation still
  pending when a `$transaction` callback returns rejects ("…it was rolled back")
  instead of resolving; a `stream()` left open counts as unfinished work.
- node-postgres: a connection lost in the middle of a query is discarded instead
  of failing the next query; `databaseError()` reports lost connections as
  `kind: "connection"` on both drivers.
- Both drivers read and write values alike: `int[]` / `real[]` from Bun.SQL,
  `real` as PostgreSQL prints it (`0.1`), `-0`, PostgreSQL's `date` forms (years
  before 1000, BC, `infinity`), BC timestamps, and `timestamptz` instants that
  no longer shift by seconds in a non-UTC process time zone. `real` parameters
  compare correctly on Bun.SQL.
- Prepared `first()`, `one()` and `maybeOne()` work with a parameterized
  `limit`.
- A `.one()` relation without a foreign key resolves to the first match by
  primary key in every form, instead of repeating rows or failing with "more
  than one row".
- Upserts with duplicate conflict keys reject with
  `SYMMETRIA_DUPLICATE_CONFLICT_KEY` at any size, instead of silently keeping
  the last duplicate in large inserts.
- JSON paths support `like()` / `ilike()`, arithmetic and `sum()` / `average()`.
  `minimum()` / `maximum()` work on JSON values (ordered as jsonb: numbers
  numerically, strings as text, JSON null skipped), booleans, `uuid`, `bytea`,
  `tsvector` and `vector`, in plain, grouped, relation and window aggregates.
- `jsonb(schema)` filters, `contains()`, paths, `coalesce()` fallbacks and
  prepared parameters are typed with the schema's input, which is what
  PostgreSQL stores and compares; reads still return the output. Results take
  the schema's declared output type, and a hand-written schema whose `validate`
  returns plain object literals is no longer read as `| undefined`.
- `divide()` never truncates: integers and bigints divide as an exact `Decimal`;
  the new `quotient()` divides toward zero in the integer type (`div()` for
  decimals, `trunc()` for floats). Every arithmetic result is typed as
  PostgreSQL returns it, and floats compute in double precision on both drivers.
- Types match results throughout: `count()` and ranking functions in arithmetic
  are `bigint`, `sum()` / `average()` reject text, `coalesce()` and
  `whereNotNull()` treat JSON null as null, `searchRank()`, `searchHeadline()`
  and vector distances are nullable when their input is, and `match()` literals
  take the column branch's type.
- Paths into a relation's, a selected query's or a CTE's nested result read a
  `jsonb(schema)` field like the column itself: the field returns its output and
  compares its input, and paths inside it follow the stored (input) keys and
  values.
- Enum labels and `match()` literals that look like numbers (`oneOf("1", "2")`)
  stay text: no arithmetic or `sum()`, and filters and writes accept only the
  labels. Only `numeric` values and decimal-text operands are `Decimal`;
  arithmetic on text, enum, date or uuid expressions throws where the query is
  built.
- Schema: `oneOf(...).typeName("Role")` names an enum type, shared by every
  column that names it; `text.collate("C")` sets a column's collation;
  `int.auto.byDefault` declares `GENERATED BY DEFAULT AS IDENTITY`; checks and
  partial indexes accept boolean expressions such as ``sql`${t.price} > 0` ``.
  Derived index and check names over 63 bytes are shortened with a hash instead
  of throwing.
- `in()` / `notIn()` accept subqueries over nullable columns, `$transaction`
  accepts a callback that returns a query, and `symmetria/pg` type declarations
  no longer need `@types/pg`.
- The profiler endpoint answers paths that start with `//` with 404 instead
  of 500.
- `$transaction` retries wait at most one second between attempts (or
  `retryDelayMs` when that is longer); the wait used to double without limit, so
  20 retries under contention could take hours.
- Transaction poolers such as PgBouncer are documented: queries, transactions,
  streams and prepared queries work on both drivers. Bun.SQL needs
  `prepare: false` unless the pooler tracks named statements, and before
  PostgreSQL 18 `search_path` belongs on the role, not in the URL.

### Kit (`symmetria-kit`)

- `generate` treats type changes that cut or round existing values (a shorter
  `varchar`, fewer decimal places, a lower timestamp precision) as destructive,
  and alters string lengths without a truncating cast, so PostgreSQL refuses
  values that do not fit instead of silently shortening them.
- An enum label added by one migration can be used by the next one in the same
  `migrate`, on a fresh database and in `verify`: the migration that adds it
  commits first, on every driver. Custom drivers that only run whole
  transactions run each group in its own transaction under
  `pg_advisory_xact_lock`, re-reading the journal, and support `each` mode.
- `squash` refuses to drop SQL that generate did not write (seeds, views, edited
  `up.sql`) and lists it; `--allow-custom-sql` confirms. `adopt` on a database
  without history asks for `--to` instead of recording data-only migrations that
  never ran.
- `status` and `lint --pending` no longer wait for a running `migrate`, and fail
  after 2 seconds with a clear message if the journal is locked.
- Migration SQL keeps `BEGIN ATOMIC … END` function bodies and
  `CREATE RULE … DO ALSO (…; …)` together; rollback of a rename with a `using`
  hint works; checksums ignore CRLF line endings.
- `lint` ignores comments and strings, checks every action of an `ALTER TABLE`,
  blocks `CHECK` / foreign keys added without `NOT VALID`, knows more volatile
  defaults, and no longer flags renames, enum type renames, new enum labels,
  column default changes or key rebuilds after a type change.
- New `ignoreTables` config option and `--ignore-table` flag for `drift`,
  `adopt`, `repair`, `verify` and `pull`; the CLI always leaves out
  `_prisma_migrations` (pull still lists it). A table the schema declares is
  always compared.
- `pull` declares CHECK constraints, partial-index predicates and computed index
  keys as predicates (`users.score.between(1, 10)`,
  `and(t.status.is("active"), t.deletedAt.is(null))`) whenever PostgreSQL stored
  the form the DSL writes, and keeps `sql` for the rest. `diff` and `generate`
  compare conditions and index expressions by meaning, so a DSL schema migrated
  and pulled back needs no migration (`above(-100)` and `> '-100'::integer` are
  the same check).
- `pull` keeps Prisma's enum names (`.typeName()`), reports `_AB_pkey` junction
  keys, declares collations, index ordering and storage options, binds tables
  named like builders (`date`, `text`) under another name, and gives back the
  same schema when run on a database built from its own output. Its serial fix
  continues after the existing rows and the old sequence, keeps explicit ids
  working (`BY DEFAULT`) and drops the old sequence. Migrations, `drift` and
  `pull` handle collations and named enums (created once, labels added in place,
  renamed with `ALTER TYPE … RENAME TO`).
- CLI: every command prints one JSON object with `--json`, `diff` / `lint`
  accept `--online`, Ctrl-C and SIGTERM exit with 130 / 143, and `--help`, the
  README and the reference list the same flags. `--json` failures print JSON,
  migration errors include PostgreSQL's DETAIL, `recover` reports when there is
  nothing to recover, `migrate --to` an applied migration says where the
  database stands, `inspect` shows index predicates, `INCLUDE` and operator
  classes, and the schema browser marks `BY DEFAULT` identities.
- `migrate`, `rollback`, `adopt`, `repair` and `--plan` detect a connection that
  pools transactions (PgBouncer in transaction mode) and then lock each
  transaction with `pg_advisory_xact_lock`; `transaction: "none"` migrations are
  refused there before anything runs. If the session still moves between server
  connections mid-run, the run stops with a clear message.
- `drift`, `pull` and `verify` treat a PostgreSQL 18 `NOT NULL … NOT VALID`
  column as nullable, since old rows may still hold NULL.
- Terminal screens: `inspect` shows named enum types, collations and
  `identity by default`; `diff` names the collation, identity generation or enum
  type that changed and shows an enum rename as one change; SQL tabs number
  source lines; the profiler shows plan trees and fits narrow terminals; `q`
  closes the schema browser.

### Changes to note when upgrading

- Scoped writes that put a row outside the scope (an insert for another tenant,
  an `update()` that changes the tenant column) now fail with
  `SYMMETRIA_OUT_OF_SCOPE`; write such rows through the unscoped database.
  `toSQL()` of scoped inserts and updates ends with a
  `RETURNING … AS "__symmetria_scope"` check and binds the scope values again.
- Builder calls no longer throw for bad values: `insert(bad)`, `update(bad)` and
  filters with invalid values return a query whose promise rejects. Code or
  tests that expected a synchronous throw must `await` / `.catch()` the query,
  or call `toSQL()`.
- Arrays with NULL elements, fractional or out-of-range numbers for `int` /
  `smallint` and invalid `Date`s now fail with the same Symmetria error on both
  drivers instead of passing through or failing differently.
- `toSQL().parameters` shows `timestamptz` values as ISO strings.
- Automatic indexes of `.named()` columns and of `.column()` references with
  uppercase names are named after the SQL column, so the next `generate` renames
  them once (`ALTER INDEX … RENAME`).
- `jsonb(schema)` writes, filters, paths and prepared parameters expect the
  schema's input type; code that used the transformed output type needs the
  input form (the `as never` cast is no longer needed).
- `quantity.divide(2)` returns a `Decimal` such as `"3.5000000000000000"`
  instead of `3`; use `quotient()` for integer division. A JS number next to an
  `int` / `smallint` / `bigint` operand must be an integer in range (write
  fractions as decimal text, `"1.5"`), and arithmetic on a plain `sql<T>`
  template needs `sql.of(column)`.
- `QueryColumn` takes a third type parameter for column traits; annotations such
  as `QueryColumn<number, "x">` no longer accept `real`, double or JSON columns.
  Search ranks and vector distances on nullable inputs are typed `| null`.
- `CHECK` and foreign keys added without `NOT VALID` are blocking `lint`
  findings, so `lint` exits with code 1 for them.
- `--json` output of `drift`, `lint`, `status`, `--plan`, `inspect --relations`
  and `profile` is an object (`findings`, `migrations`, `steps`, `tables`,
  `requests`) instead of a bare array; Ctrl-C and SIGTERM exit with 130 / 143
  instead of 1.
- On a transaction-only custom driver, a failed later group leaves earlier
  groups committed, as on the official drivers.
- `verify` no longer skips a table the schema declares when `ignoreTables` lists
  it.
- Through a transaction-mode pooler, migrations no longer take a session lock,
  and `--online` / `transaction: "none"` migrations must run over a direct or
  session-pooled connection. A migrator driver limited to one connection waits
  up to one second per run for the pooling check; give it two connections.
- On PostgreSQL 18, `drift` reports `nullability-mismatch` for columns whose NOT
  NULL constraint is NOT VALID, and `pull` declares them `.nullable`.

## 1.1.0 — 2026-11-09

### Runtime (`symmetria`)

- Any SQL names: `schema(…, { casing: "preserve" })` keeps keys as SQL names
  (`createdAt`, `authorId`), `.named("User")` sets a table's name and
  `.named("LEGACY_CODE")` a column's, and `.column()` accepts any identifier.
  Constraint and index names follow the SQL names, which matches the names
  Prisma creates. Tables or columns that would share a SQL name are rejected.
- Columns are created in declaration order, foreign keys included, as the
  documentation promised; snapshot hashes ignore column order, so no migration
  results.
- Foreign keys declare `ON UPDATE` with `.onUpdate.cascade`, `.restrict` or
  `.noAction`.
- `timestamp` (without time zone) with UTC semantics on both drivers, and a
  precision for both timestamp builders: `timestamp(3)`, `timestamptz(3)`.
- Exact arithmetic: `plus`, `minus`, `multiply` and the new `divide` accept
  numbers, bigints, decimal text and other numeric columns and follow
  PostgreSQL's promotion, with the casts in the SQL: `quantity.multiply(price)`
  is a decimal, fractional numbers do not truncate. `numeric` values, `sum()`
  and `average()` are typed `Decimal` (decimal text); writes, filters and
  prepared parameters accept any string. On non-numeric columns the type error
  names the method and what it needs.
- Predicate lists skip every falsy entry, so `[q && title.ilike(q)]` type-checks
  for `q: string | undefined` and an empty `q` adds no filter.
- `databaseError(error)` describes server errors the same way on node-postgres
  and Bun.SQL (`kind`, `sqlState`, `table`, `column`, `constraint`, `detail`).
  `one()` and `maybeOne()` errors name the source and carry
  `SYMMETRIA_RECORD_NOT_FOUND` or `SYMMETRIA_TOO_MANY_ROWS`.
- Editors show the resolved value type of nullable columns and columns with
  defaults (`"cart" | "paid"`) instead of `ColumnValue<Column<…>>`.

### Kit (`symmetria-kit`)

- `pull` declares tables and columns under any names, choosing the `casing` that
  fits most of them and adding `.named()` for the rest, so PascalCase and
  camelCase databases such as Prisma's no longer lose tables or columns.
- `pull` declares `ON UPDATE CASCADE` / `RESTRICT` foreign keys, `timestamp(n)`
  columns, and unique indexes named like constraints as `.unique` with an
  `ADD CONSTRAINT … USING INDEX` fix; it lists views, materialized views and
  triggers, and skips Prisma's `_prisma_migrations` with a warning.
- DDL, diff and drift handle `ON UPDATE`.
- The reference documents the `--diff` file format, `self`, SQL names and the
  move from Prisma.

## 1.0.2 — 2026-11-08

### Runtime (`symmetria`)

- `count()` and `exists()` called directly on a scoped table or a bare alias
  (`scoped.posts.count()`, `scoped.posts.as("p").exists()`) evaluate the
  `$scope()` callbacks again, like every other query; they used the values
  captured when the database was scoped, so a changed tenant id counted and
  checked the previous tenant's rows.

### Kit (`symmetria-kit`)

- The `bin` entry is written in the form npm publishes, so publishing no longer
  warns about it.

## 1.0.1 — 2026-11-08

### Runtime (`symmetria`)

- Query building is about 40% cheaper and point lookups twice as cheap: plan
  records are frozen only under `SYMMETRIA_FREEZE=1` (the unit suite runs with
  it), top-level queries reuse their table's root binding and column handles,
  and quoted identifiers are cached. Shared objects that reach application code
  (column handles, query and aggregate prototypes, shape tools) stay frozen. A
  column handle taken from one plain query of a table is now accepted in another
  plain query of the same table; other aliases, transactions and scoped
  databases still reject it.
- `$scope()` callbacks run each time a query or write is built: `update()`,
  `delete()` and upserts of a scoped database read the scope's current values
  instead of the ones captured when `$scope()` was called.
- Streaming closes its cursor and ends the transaction without hiding the
  original error: a failing `CLOSE` or `COMMIT`, a failed rollback and a
  connection that cannot be acquired are reported as such.
- Nested JSON results prepare their row decoder once per result instead of
  checking it for every row.
- Relation names that a column would shadow: explicitly chosen names
  (`.inverse()`, overrides, `relations()`) are rejected when the schema is
  built; automatic reverse and many-to-many names are left out instead of being
  silently unreachable.
- `relations()` predicates, UPDATE values, RETURNING and `$scope()` callbacks
  see columns only and report unknown columns and relation paths with the table,
  the member and a suggestion instead of failing on `undefined`; a predicate
  that compares a third table names the relation and both tables; `to()`
  explains that it expects a table rather than a reference chain; selecting a
  predicate explains that predicates are not values.
- Automatic indexes on `.column()` keys are named after the SQL column, like the
  foreign-key constraint (`posts_author_email_idx`).

## 1.0.0 — 2026-11-08

First stable release of `symmetria` and `symmetria-kit`.

### Runtime (`symmetria`)

- Schema declaration in TypeScript: tables, columns, defaults, enums, JSONB with
  Standard Schema validation, computed fields, indexes, primary keys, CHECK
  constraints and foreign keys that declare both relation directions.
- `count()` and `exists()` on tables, filtered sources and lookups; prepared
  SELECTs keep `one` / `maybeOne` / `first` / `count` / `exists` / `inspect`;
  keyset pages move backward with `page({ before })` and carry `previousCursor`;
  conditional upserts with `doUpdate(values, { where })`; `InferUpdate`;
  `returning()` callbacks receive the scalar tools.
- First-class `smallint`, `real`, `doublePrecision`, `date`, `time`, `interval`,
  `bytea` and `inet` columns with codecs that agree across both drivers; `pull`
  declares them instead of `customType()`.
- References to unique columns and custom key columns:
  `author: users.by("email").column("author_email")` stores the referenced
  column's value under its type, joins and nested `connect` use that column, and
  `pull` declares such foreign keys instead of demoting them.
- Condition relations:
  `table({...}).relations((post, { to }) => ({ author: to(users).one((user) => post.authorName.is(user.name)) }))`
  joins tables by a predicate instead of a foreign key, with paths, nested
  collections, aggregates, quantifiers, explicit JOINs and `.inverse()`; nothing
  is added to DDL, migrations, drift or `pull`.
- Shape-first queries: destructured projections plus a separate options object
  (`where`, `orderBy`, `limit`, `offset`, `groupBy`, `having`, `distinct`,
  `forUpdate`, `forShare`), options-only calls, nested collections with
  per-parent filters, ordering and limits, relation paths that infer their
  JOINs, explicit JOIN helpers whose aliases option callbacks can refer back to,
  tenant scopes, aliases, derived tables, CTEs and recursive CTEs.
- Developer experience: `numeric` and `varchar` usable bare or called; schema
  errors name the table and column and explain builders passed without a call;
  unknown columns or relations in shapes suggest the closest name; predicate
  lists skip `undefined`, `null` and `false`; `Infer`, `InferInsert` and
  `InferShape` type aliases; `$transaction` retries serialization failures with
  `retries` / `retryDelayMs`; `stream()` iterates any query through a
  server-side cursor.
- pgvector through `symmetria/vector`: `vector(n)` columns written as plain
  number arrays, `l2Distance` / `cosineDistance` / `innerProduct` /
  `l1Distance`, operator classes and storage parameters on indexes
  (`operatorClass()`, `.with()`, `hnsw` / `ivfflat`) and schema-level
  `extensions` that migrations create first.
- Relation aggregates as properties (`posts.sum.views`) or callbacks, `count`,
  `exists`, `some` / `none` / `every` quantifiers, window functions, subqueries,
  full-text search (stored `tsvector` columns, weighted `searchDocument()` with
  a matching GIN index, websearch / plain / phrase / raw parsers, `ts_rank`
  options and `ts_headline`), arrays and typed JSON paths.
- Result types inferred all the way down, including nullable JOINs, reusable
  projections and enum mappings. `bigint`, `numeric`, timestamps and custom
  codecs keep their precision inside nested JSON.
- Writes: typed `RETURNING` with reusable projections, upserts, atomic nested
  inserts, bulk INSERTs split under the wire-protocol parameter limit, and
  direct UPDATE / DELETE through `byId()` and unique-key lookups. Whole-table
  writes require an explicit `.all()`.
- Callable prepared queries, keyset pagination with verified cursors and
  `pages()` iteration, transactions with savepoints, isolation options, row
  locks, sessions with cancellation and graceful shutdown.
- PostgreSQL adapters for Bun (`symmetria/bun`) and node-postgres
  (`symmetria/pg`, aliased as `symmetria/driver`) sharing one compiler, codecs
  and transaction lifecycle. Node.js 24.11+ and Bun 1.4.4+; PostgreSQL 14+.
- Query inspector (`query.inspect()`), request profiler with a token-protected
  loopback endpoint, and SQL plus parameters on every query via `toSQL()`.

### Kit (`symmetria-kit`)

- Migration generation from schema snapshots into reviewable `up.sql` /
  `down.sql`, explicit rename hints, destructive-change gating, SQL and schema
  lint for blocking or rewriting statements.
- Journaled execution with advisory locks, lock and statement timeouts,
  cancellation, `batch` / `each` / `none` transaction modes, online DDL,
  `incomplete` state with verified `repair`, `recover` for crashed file
  publication, squash and adopt.
- Drift detection against the live catalog and `verify`, which replays install,
  upgrade, rollback and reapply in disposable databases.
- `symmetria pull` introspects an existing PostgreSQL schema into a Symmetria
  schema module, with a review list (and SQL fixes) for everything the DSL
  cannot express; `pullSchema()` exposes the same programmatically.
- `symmetria.config.ts` may import the schema without a file extension on Node;
  the CLI resolves `./src/schema` to `.ts`, `.js` or an index file.
- `symmetria graph` renders the schema as a Mermaid entity-relationship diagram
  for READMEs and pull requests (`schemaGraph()` / `renderMermaid()`).
- Interactive terminal tools: schema browser, migration dashboard, query
  inspector and live profiler; `symmetria init` scaffolding; a `testDatabase()`
  helper for isolated test schemas.

### Project

- Reproducible PostgreSQL benchmarks against Drizzle, Kysely, Prisma and raw SQL
  (five independent passes, hashed raw evidence kept with the run), a README
  hero and Kit recordings captured from real runs, CI on PostgreSQL 14 and 17,
  `SECURITY.md` and Dependabot.
