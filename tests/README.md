# Tests

Run `bun run test` for the database-free suite. Test schemas live in
`fixtures/`, independently of the runnable examples.

| Command                    | Scope                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test:unit`        | SQL, schema metadata, codecs, immutable queries, transactions, profiling; the SQLite dialect on `bun:sqlite`; Kit diffs, lint and presentation |
| `bun run test:cli`         | Project initialization and migration files in temporary directories                                                                            |
| `bun run test:types`       | Compile-only API contracts in `runtime/types/*.types.ts`                                                                                       |
| `bun run test:integration` | Real PostgreSQL reads, writes, precision, pagination, CTEs, rollback, savepoints, concurrency and migrations                                   |
| `bun run test:packages`    | Packed npm artifacts installed into a fresh application, declarations, bundled runtime and installed CLI                                       |
| `bun run test:examples`    | Runnable examples, temporary generated migrations, idempotent seeding and final database state                                                 |

PostgreSQL commands require `SYMMETRIA_TEST_DATABASE_URL`. They create unique
schemas and clean them up; new PostgreSQL tests can use `testDatabase()` from
`symmetria-kit/testing` instead of managing the schema by hand.
`test:integration` and `test:examples` fail immediately when the URL is absent,
rather than reporting a skipped suite as a successful run. The optional database
phase of `test:packages` uses the same variable. `bun run check:release`
combines all release checks, including package builds, installed tarballs,
compile-only type contracts and these database-backed suites.

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
query regressions on SQLite and PostgreSQL: three CTEs, window ranking, prepared
filters, nested collections, junctions, wide JSON and cursor ordering.
`runtime/postgres/cursor-plans.test.ts` and the shared aggregate test inspect
EXPLAIN ANALYZE row/loop counts to catch inefficient plans without timing
thresholds.

`support/shapes.ts` exercises callable queries and their complete SQL tool
context on both dialects, including FK-inferred JOINs, repeated sources,
automatic aliases and controls-only composition, plus reusable projections,
exhaustive enum mappings and relation aggregates across pagination, prepared
values, CTEs and codecs.

`runtime/types/reusable-shapes.types.ts` checks projection identity, exhaustive
enum mappings, aggregate result types and direct-row mutation callbacks.
Installed-package checks exercise these APIs through the public npm exports as
well.

## Golden compilation corpus

`SYMMETRIA_COMPILE_LOG=<file>` makes the compiler append every compiled
statement as a JSON line. Record a baseline before refactoring the compiler,
record again afterwards and compare with
`bun tests/support/golden-compare.ts <baseline> <candidate>`: lines are compared
in order, then as multisets, so concurrent tests do not raise false alarms. Use
absolute paths; the Postgres suite needs the database URL.
