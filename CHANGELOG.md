# Changelog

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
