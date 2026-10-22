# Runnable examples

Bun programs using the public `symmetria` and `symmetria-kit` imports, from
focused API examples to complete multi-step recipes. The shared schema is split
across `schema/users.ts`, `schema/posts.ts` and `schema/tags.ts`; it can also
compile queries without a connection. Every read uses a shape callback: field
keys describe results and `$` keys control SQL. For a guided introduction, start
with [Core concepts](../docs/guide.md). For the larger programs, read
[Advanced recipes](../docs/advanced.md).

From the repository root:

```sh
bun install --frozen-lockfile
bun run build

# Print SQL and parameters without PostgreSQL.
bun examples/queries.ts
bun examples/shapes.ts

# Generate the example migration offline into .symmetria-examples/migrations/.
bun packages/kit/src/cli.ts generate initial --config examples/symmetria.config.ts

# Use an empty example database, then apply the migration and seed.
export DATABASE_URL=postgres://user:password@localhost/symmetria_examples
bun packages/kit/src/cli.ts migrate --config examples/symmetria.config.ts
bun examples/seed.ts

bun examples/read.ts
bun examples/write.ts
bun examples/transactions.ts
bun examples/analytics.ts
bun examples/shapes.ts
bun examples/inspect.ts
bun examples/profile.ts
bun examples/advanced/author-report.ts
```

| File                        | Demonstrates                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `queries.ts`                | Automatic joins, nested collections, per-parent limits and relation filters                          |
| `read.ts`                   | Cursor pages on root columns and a prepared unique-key lookup                                        |
| `write.ts`                  | Atomic nested insert, unique-key connect, connect-or-create tags, bigint increment and deletion      |
| `transactions.ts`           | Row lock and savepoint rollback while retaining the outer transaction                                |
| `analytics.ts`              | Window ranking through a typed CTE                                                                   |
| `shapes.ts`                 | Reusable projections, enum CASE, relation aggregates, FK JOINs, CTEs and window top-N                |
| `inspect.ts`                | Query inspector with estimated EXPLAIN; interactive in a TTY                                         |
| `profile.ts`                | A named trace with SQL/build/driver/decode timings                                                   |
| `profile-live.ts`           | Live HTTP traffic, nested reads versus N+1, a slow query and an intentional error                    |
| `advanced/author-report.ts` | Three CTEs, per-author window top-N, prepared filters, exact totals, optional editor and nested tags |
| `advanced/bulk-import.ts`   | 500-post transactional import, deduplication, batched upserts, junction keys, replay and rollback    |
| `advanced/work-queue.ts`    | Concurrent SKIP LOCKED claims, leases, recovery, atomic attempts and stale-acknowledgement rejection |

Generation, migration and seeding can be repeated safely. Generated files live
in the ignored `.symmetria-examples/` directory at the repository root, keeping
`examples/` limited to runnable source and configuration. The write example
removes its newly created post; the transaction example rolls back its temporary
title change. All programs close their database pools. The live profiler runs
until stopped. Cursor pagination uses a root-table query because `page()` does
not accept joins; the joined feed is shown separately in `queries.ts`.

`shapes.ts` prints SQL offline when `DATABASE_URL` is unset; with a connection
it also executes its four queries against the seeded example schema.
`join(post.authorId)` infers the target and condition; repeated JOINs get
automatic aliases. A controls-only call such as `feed(() => ({ $limit: 5 }))`
preserves the projection. Its feed reuses a user card for author/editor, maps
enum labels with `.match()` and aggregates filtered relations with `.sum()` /
`.maximum()`. `write.ts` uses direct-row callbacks for UPDATE, WHERE and
RETURNING.

Reusable shapes contain selected fields; filtering and pagination belong in
query or relation calls. The sum returns a decimal string or `null`; the maximum
timestamp returns `Date | null`. Empty collections remain `[]`, and counts
return `0`. See the [API reference](../docs/reference.md) for the full
contracts.

## Advanced standalone demos

The author report prints SQL offline, or runs against the regular
migrated/seeded schema when `DATABASE_URL` is set. Bulk import and the queue
create their own isolated schemas and drop them when finished; neither needs the
regular seed.

```sh
env -u DATABASE_URL bun examples/advanced/author-report.ts
DATABASE_URL=postgres://user:password@localhost/testdb bun examples/advanced/bulk-import.ts
DATABASE_URL=postgres://user:password@localhost/testdb bun examples/advanced/work-queue.ts
```

These demos contain executable assertions. See
[Advanced recipes](../docs/advanced.md) for query stages, batching and
transaction choices, expected output, additive tag semantics, at-least-once
delivery and downstream idempotency.

## Live profiler demo

This standalone demo creates an isolated schema with 20 authors and 200 posts,
then sends five concurrent HTTP requests every approximately 1.3 seconds. It
removes its schema when stopped; migrations and the regular seed are not
required.

```sh
# Terminal 1: use a local PostgreSQL database.
DATABASE_URL=postgres://user:password@localhost/testdb bun examples/profile-live.ts

# Terminal 2: interactive profiler.
bun packages/kit/src/cli.ts profile
```

- `/feed`: a joined page of 20 posts.
- `/authors/nested`: five authors and their posts in one SQL statement.
- `/authors/n-plus-one`: the same root count using six statements; look for
  `↻ 4`.
- `/slow`: an intentional 80 ms PostgreSQL delay.
- `/error`: an intentional unique-constraint violation, marked `ERROR`.

Use **↑/↓** to select, **Enter** to open a request and then its SQL/parameters,
**e** for EXPLAIN, **a** for EXPLAIN ANALYZE on a SELECT, **Esc** to go back and
**q** to close the viewer. Close the demo with **Ctrl+C** in terminal 1 or
`curl -X POST http://127.0.0.1:7332/stop`. `PROFILE_PORT` and `DEMO_PORT`
override the default profiler/application ports 7331/7332.

To change the schema:

```sh
bun packages/kit/src/cli.ts inspect --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts diff --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts generate change_name --config examples/symmetria.config.ts
bun packages/kit/src/cli.ts migrate --config examples/symmetria.config.ts
```

Example SQL lives in `.symmetria-examples/migrations/<id>/`; snapshots and
manifests live in `.symmetria-examples/migrations/meta/snapshot.json` and
`.symmetria-examples/migrations/meta/migration.json`. These two files hold the
latest generated schema and the whole migration journal. `--dir` overrides this
location. `SYMMETRIA_EXAMPLE_SCHEMA` selects the migration history schema when
using a custom PostgreSQL search path. It defaults to `public`.

`SYMMETRIA_TEST_DATABASE_URL=... bun run test:examples` verifies these commands
in an isolated schema and temporary migration directory, including repeated
generation/migration/seeding and final stored data. Both are removed afterwards.
