# Tests

Migration integration tests cover transaction groups, online DDL failure and
repair, advisory/DDL/statement timeouts, cancellation, expanded drift checks and
schema-verified adoption. Disposable verification tests require `CREATEDB` on
the PostgreSQL test connection and clean up their generated databases.

Run `bun run test` for the database-free suite. Test schemas live in
`fixtures/`, independently of the runnable examples.

| Command                    | Scope                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bun run test:unit`        | SQL, schema metadata, codecs, immutable queries, transactions, profiling; Kit diffs, lint and presentation      |
| `bun run test:cli`         | Project initialization and migration files in temporary directories                                             |
| `bun run test:types`       | Compile-only API contracts in `runtime/types/*.types.ts`                                                        |
| `bun run test:integration` | Real PostgreSQL reads, writes, precision, pagination, CTEs, rollback, savepoints, concurrency and migrations    |
| `bun run test:drivers`     | Shared built-package tests under native Bun and Node.js: values, cancellation, connection recovery and shutdown |
| `bun run test:packages`    | Packed npm artifacts installed into a fresh application, declarations, bundled runtime and installed CLI        |
| `bun run test:examples`    | Runnable examples, temporary generated migrations, idempotent seeding and final database state                  |

PostgreSQL commands require `SYMMETRIA_TEST_DATABASE_URL`. They create unique
schemas and clean them up; new PostgreSQL tests can use `testDatabase()` from
`symmetria-kit/testing` instead of managing the schema by hand.
`test:integration`, `test:drivers` and `test:examples` fail immediately when the
URL is absent, rather than reporting a skipped suite as a successful run. The
pgvector suites (`runtime/postgres/vector.test.ts`,
`kit/postgres/vector.test.ts`) are the exception: they skip with a log line when
the server cannot provide the `vector` extension, and CI runs
`pgvector/pgvector` images so they execute there. The optional database phase of
`test:packages` uses the same variable. `bun run check:release` combines all
release checks, including package builds, installed tarballs, compile-only type
contracts and these database-backed suites.

```sh
bun run build
bun run check
bun run test
export SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb
bun run test:integration
bun run test:packages
bun run test:examples
```

`*.types.ts` files are compiled, never executed. Negative contracts use
`@ts-expect-error`; exact inferred results use type equality assertions. Runtime
tests verify invalid-input rejection at execution time alongside SQL
compilation, execution and result decoding.

PostgreSQL fixture setup stays next to its scenarios: transaction tests need
independent observer connections, while migrations and nested writes have their
own lifecycle requirements. `support/query-composition.ts` runs the same complex
query regressions through Bun.SQL and node-postgres: three CTEs, window ranking,
prepared filters, nested collections, junctions, wide JSON and cursor ordering.
`runtime/postgres/cursor-plans.test.ts` and the shared aggregate test inspect
EXPLAIN ANALYZE row/loop counts to catch inefficient plans without timing
thresholds.

`support/shapes.ts` exercises callable queries and their complete SQL tool
context on both adapters, including FK-inferred JOINs, repeated sources,
automatic aliases and controls-only composition, plus reusable projections,
exhaustive enum mappings and relation aggregates across pagination, prepared
values, CTEs and codecs.

`support/scope-freshness.ts` changes the tenant between executions of reused
query objects, prepared reads and writes, lookups, pages, streams and nested
relations, and checks that no statement reaches another tenant's rows.
`support/query-correctness.ts` covers results that used to be silently wrong:
CTE names hiding tables, jsonb transforms, prepared LIMITs in terminals,
duplicate upsert keys across chunks, JSON-path operators and `one()` condition
relations with several matches. `support/scoped-writes.ts` checks that a scoped
database never writes a row outside its scope (inserts, chunked and nested
inserts, upserts, updates, savepoints and transactions), and
`support/error-timing.ts` that value errors reject when a query runs while shape
errors throw where it is built. `support/query-consistency.ts` checks that
results are what their static types say: `jsonb(schema)` filters on the stored
input, every arithmetic combination against hand-written SQL, MIN/MAX of JSON
values, booleans and `uuid`, and JSON null under `coalesce()` and
`whereNotNull()`.

`runtime/types/reusable-shapes.types.ts` checks projection identity, exhaustive
enum mappings, aggregate result types and direct-row mutation callbacks.
Installed-package checks exercise these APIs through the public npm exports as
well.

## PostgreSQL versions and PgBouncer

The documented floor is PostgreSQL 14; CI runs 14 and 17. Before changing
drivers, catalog queries or migrations, run the database suites on each major
version. One container per version, removed afterwards (`postgres:18` works too;
its pgvector suites skip):

```sh
for version in 14 15 16 17 18; do
  docker run -d --name "symmetria-pg$version" -e POSTGRES_PASSWORD=secret \
    -p "127.0.0.1:154$version:5432" "pgvector/pgvector:pg$version"
done

for version in 14 15 16 17 18; do
  export SYMMETRIA_TEST_DATABASE_URL="postgres://postgres:secret@127.0.0.1:154$version/postgres"
  bun run test:integration && bun run test:drivers && bun run test:examples
done

docker rm -f symmetria-pg14 symmetria-pg15 symmetria-pg16 symmetria-pg17 symmetria-pg18
```

Tests whose behavior depends on the server version read `server_version_num` and
say why, such as the PostgreSQL 18 `NOT NULL … NOT VALID` case in
`kit/postgres/drift.test.ts` and `uuid.v7` in `kit/postgres/pull.test.ts`.

`SYMMETRIA_TEST_TRANSACTION_POOLING=1` runs the suites through PgBouncer in
transaction mode, with the configuration in `support/pgbouncer/`: Bun.SQL gets
`prepare: false`, and the tests of session state (pinned sessions, session
advisory locks, nontransactional migrations, cancellation by process ID) skip.
The server must be PostgreSQL 18 or newer, because the suites isolate their
schemas with `options=-c search_path=…`, which PgBouncer keeps per client only
when the server reports `search_path`:

```sh
docker network create symmetria-pooling
docker run -d --name symmetria-pooling-postgres --network symmetria-pooling \
  -e POSTGRES_PASSWORD=secret postgres:18
docker run -d --name symmetria-pgbouncer --network symmetria-pooling \
  -p 127.0.0.1:6432:5432 -v "$PWD/tests/support/pgbouncer:/etc/pgbouncer:ro" \
  edoburu/pgbouncer
export SYMMETRIA_TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:6432/postgres
SYMMETRIA_TEST_TRANSACTION_POOLING=1 bun run test:integration
SYMMETRIA_TEST_TRANSACTION_POOLING=1 bun run test:drivers
docker rm -f symmetria-pgbouncer symmetria-pooling-postgres
docker network rm symmetria-pooling
```

`kit/postgres/migration-engine.test.ts` then also checks that `migrate` takes
transaction-level locks through the pooler and refuses a nontransactional
migration; the same file covers that behavior on every run with a simulated
pooler. `kit/cli/terminal.test.ts` drives the schema browser in a
pseudo-terminal at several sizes.
