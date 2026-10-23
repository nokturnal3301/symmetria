# Changelog

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
