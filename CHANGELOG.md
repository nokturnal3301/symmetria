# Changelog

## 0.2.0 — 2026-10-27

### Runtime

- Raw `sql` fragments and computed fields are parenthesized when they are
  operands: ``sql`${a} + 1`.multiply(2)`` compiled to `a + 1 * $1` and returned
  wrong values. Comparisons, BETWEEN, IN, IS NULL and array/JSON membership are
  covered too, as are CHECK constraints and partial-index predicates; Kit
  proposes recreating those whose operands are raw SQL.
- `undefined` in write payloads means "omitted" for flat, bulk and nested
  inserts, updates and upserts, matching query controls. Insert types accept it
  under `exactOptionalPropertyTypes`.
- `$scope` predicates appear once in relation aggregates, nested collections,
  quantifiers and junction relations instead of twice.
- `self` supports the full reference chain in types:
  `self.nullable.onDelete.cascade.inverse("children")`.
- `jsonb(schema).default(value)` stores the JSON value, not a JSON string.
- `jsonb(schema)` columns accept partial values in `contains()` without schema
  validation.
- `coalesce()` accepts a non-null expression as its fallback.
- Under `exactOptionalPropertyTypes`, `jsonb()` accepts spec-conformant Standard
  Schemas such as Zod 4, and optional options (`page({ after })`,
  `postgres({ profiler })`, transaction options) accept `undefined`.
- Multi-row INSERTs above the wire-protocol parameter limit run as atomic chunks
  instead of failing. Building write values allocates less: a 500-row INSERT
  builds and compiles about 20% faster than in 0.1.0.
- `in()` / `notIn()` lists longer than 1,000 values bind a single array
  parameter on PostgreSQL (`= ANY(…)` / `<> ALL(…)`), so 70,000-value lists
  work.
- Page cursors whose values do not fit the ordering columns are rejected as
  invalid cursors instead of surfacing a database error.
- `sql.of(column)` types and decodes raw SQL like a column, so
  `` sql.of(bool)`…` `` returns booleans on SQLite too.
- Published declarations keep the SQL template type named, avoiding recursive
  expansion that could stall consumer typechecking with `skipLibCheck: false`.
- Mutation `where()` accepts an array of predicates combined with `AND`, like
  `$where`.
- Junction tables index their second key column unless a declared index already
  leads with it; an explicit `.index` on the first key, which the composite
  primary key covers, is no longer duplicated.
- Nullable references accept `undefined` in the nested-insert form
  (`parent: body.parent`), not only as `parentId`; a self relation with
  `onDelete.cascade` no longer makes the nested form require it.
- `insert([])` is a no-op resolving to `{ affectedRows: 0 }` (or `[]` with
  `returning()`) instead of throwing, so request arrays pass through unchecked.
- `page()` orders by computed fields and raw SQL over root columns, not only
  plain columns; on SQLite numeric-looking expression values bind as numbers.
  Custom dialects declare this through the `typedParameters` capability.
- SQLite sorts and compares like PostgreSQL: `numeric` columns by magnitude
  instead of as text (`'9.5' < '10.0'`), enums in declaration order instead of
  alphabetically, and `ORDER BY` places NULLs last for ascending and first for
  descending keys. Cursor pages, `BETWEEN`, window and nested orderings follow.
  Custom dialects opt in through `orderedOperand` and the `explicitNulls`
  capability.
- SQLite rounds `numeric(p, s)` values to the declared scale on read (`"0"` →
  `"0.00"`), including `sum()`, `min()`/`max()` and `sql.of(numeric(p, s))`,
  matching what PostgreSQL stores.
- SQLite `minimum()`/`maximum()` over `numeric` pick by magnitude and over enums
  by declaration order (`MAX` of `"12.50"` and `"100.00"` was `"12.50"`). Custom
  dialects opt in through `orderedAggregate`.
- SQLite `like()` is case-sensitive and `ilike()` folds case, as in PostgreSQL;
  both honour the backslash escape (`like("100\\%")`), and `search()` keeps
  matching case-insensitively. Custom dialects opt in through `patternMatch`.
- A scoped database's upsert never rewrites a conflicting row outside its scope:
  `ON CONFLICT … DO UPDATE` carries the scope as its `WHERE`, and a conflict
  that the scope filters out throws `SYMMETRIA_OUT_OF_SCOPE` instead of updating
  another tenant's row. A nested `connectOrCreate` that would link such a row
  fails the same way and rolls the insert back, like `connect`.
- Requires Bun 1.4.4+: Bun.SQL 1.3.x can leave a transaction waiting forever
  when pooled queries arrive while connections are reserved.

### Kit

- SQL lint no longer reports blocking or cautionary findings for tables created
  earlier in the same migration, so a fresh initial migration passes
  `lint --strict`.
- Array defaults (`text.array.default([])`, `bigint[]`, `timestamptz[]`, …)
  generate typed array literals; unsupported defaults name their column.
- Refused `repair` and `adopt` list the unexpected and missing catalog objects,
  with advice for invalid indexes left by a failed `CONCURRENTLY` build.
- Diffs rebuild only the indexes, checks and foreign keys that depend on a
  retyped or dropped column or a changed key: column renames keep unrelated and
  renamed-column indexes, and enum rebuilds no longer recreate every index of
  the table or the foreign keys that reference it.
- Adding enum labels uses `ALTER TYPE … ADD VALUE` in transactional migrations
  too (PostgreSQL 12+), instead of replacing the type and rewriting every
  dependent column; the rewrite remains for labels a default or CHECK in the
  same migration already uses.
- SQL lint reports a column type change as a table-rewrite caution.
- Refused destructive generation lists the dropped tables, columns and enum
  labels instead of a bare message.
- Identifier-length errors name the offending identifier and its byte count.
- Renaming a table or column renames its primary key, unique constraints,
  foreign keys, checks and indexes (`RENAME CONSTRAINT`, `ALTER INDEX … RENAME`)
  instead of dropping and rebuilding them, which scanned the table and blocked
  writes; foreign keys that reference a renamed table are left in place.
- A new `NOT NULL` column without a default is added nullable, followed by a
  `-- Backfill …` marker and `SET NOT NULL`, so the backfill has a place in
  `up.sql` and in the `down.sql` that restores a dropped column.
- SQL lint no longer flags adding a nullable column, or a `NOT NULL` column with
  a constant default, and treats renames as safe; a volatile default is a
  table-rewrite caution, and dropping a constraint or index that the same
  migration creates again is a rebuild caution rather than destructive.
- `status` reads the journal without taking the migration advisory lock, so it
  reports while a deploy is migrating instead of failing with a lock timeout.
- Drift compares type modifiers without whitespace, so
  `customType("numeric(12, 2)")` matches the catalog's `numeric(12,2)`.

## 0.1.0 — 2026-10-23

### Migrations

- Explicit destructive-generation opt-in, SQL-file linting with failure exit
  codes, declaration-order DDL and canonical order-independent hashes.
- Pinned PostgreSQL sessions, batch/each/none execution, bounded lock and
  statement timeouts, cancellation, SQL execution plans and structured events.
- Durable incomplete-migration state and verified repair; crash-recoverable
  filesystem publication and live-owner generation-lock checks.
- Defaults, identity, constraints, FK actions, enum ordering and invalid-index
  drift checks; schema-verified adoption, including historical SQL replay.
- Disposable-database installation, upgrade, rollback and reapplication checks,
  with hooks for representative data and application invariants.
- Online concurrent indexes, phased constraint validation and additive enum DDL.
- Transactional creation of custom migration-journal schemas; drift inspects the
  application schema independently of the journal location.

### Runtime and tooling

- Reserved PostgreSQL sessions and cancellation support for migration execution.
- Loopback profiler Host/origin validation and per-server tokens for HTTP
  EXPLAIN.
- Expanded migration documentation and three reproducible CLI recordings with
  reduced-motion previews: safe generation, verification and online recovery.

## 0.0.1

Initial release of `symmetria` and `symmetria-kit` for Bun 1.3+.

### Runtime

- Modular TypeScript schemas with inferred foreign keys, relationships, indexes,
  constraints, enums, custom codecs and Standard Schema JSON validation.
- Shape-first, immutable SELECT queries with inferred result types, automatic
  JOINs and aliases, nested collections, reusable `.shape()` projections and
  exhaustive enum `.match()` expressions.
- Relation aggregates, CTEs, recursive queries, window functions, scoped
  databases, prepared queries and keyset pagination.
- Direct-row mutations, conflict handling, unique-key lookups and atomic nested
  inserts with connect/create/upsert.
- PostgreSQL and embedded SQLite drivers, transactions and savepoints, with
  precision-preserving bigint, decimal and nested JSON results.
- Official drivers ship through `symmetria/driver`;
  `createDatabase({ schema, driver })` binds a reusable schema. SQL dialect
  strategies use `symmetria/dialect`.
- Opt-in query inspection and request profiling.
- Performance: compiled SQL is cached per query object, `one()`/`first()` reuse
  their derived plans, key lookups skip column scopes, column handles and
  queries share prototypes instead of per-instance closures, row decoders are
  generated per selection, and paginated queries with nested collections or
  relation aggregates restrict their root rows before the correlated subqueries
  run when the rewrite preserves evaluation scope. Raw projections and orderings
  keep the original layout. Handles lazily bind methods for detached calls;
  methods are not own enumerable properties. Decoder factories use a bounded
  cache.
- Modular SQL compiler with explicit compilation state and SQL dialect
  strategies: `DialectStrategy`, `postgresDialect`, `sqliteDialect`,
  `registerDialect`; `Driver.dialect` accepts a strategy, registered as an
  immutable snapshot. Unsupported capabilities fail compilation, including row
  locks on SQLite. The profiler's EXPLAIN follows the dialect (it works on
  SQLite and rejects `analyze` there).
- Compiler fast paths skip alias bookkeeping for standalone SELECTs and CTE
  scans over atomic INSERT values. SQL expressions, conflict updates and
  RETURNING retain dependency discovery.

### Kit

- Project scaffolding, schema browser, interactive query inspector and live
  profiler.
- Scaffolding uses `createDatabase` and portable CLI commands. Kit's private
  runtime bridge is `symmetria/internal`.
- Transactional migrations with reviewable `up.sql` / `down.sql`, checksums and
  advisory locking.
- Shared `meta/snapshot.json` and `meta/migration.json`, updated in place by
  generation and squash; rollback executes SQL without historical snapshots.
- Migration linting, live schema drift detection, squash and baseline adoption.
  Adoption preserves data-only migration boundaries and requires an explicit
  target for ambiguous replacement chains.
- Isolated PostgreSQL test databases through `symmetria-kit/testing`.

### Documentation and benchmarks

- Advanced runnable recipes for multi-CTE author analytics, transactional
  batched upserts and concurrent PostgreSQL work claiming with expiring leases.
- Container comparison with independent correctness checks, frozen dependencies,
  measured source snapshots, raw samples and SQL plans. Public tables and SVG
  charts are generated from verified archives, with all passes and sample counts
  retained and sparse tail percentiles suppressed.
