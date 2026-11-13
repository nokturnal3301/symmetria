# Changelog

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
