# Advanced recipes

[← Symmetria](../README.md) · [Core concepts](guide.md) ·
[API reference](reference.md) · [Example catalog](../examples/README.md)

Three complete programs combine query composition, exact values and transaction
boundaries. Each uses public `symmetria` / `symmetria-kit` imports. Run from the
repository root after `bun install --frozen-lockfile` and `bun run build`.

| Recipe                 | Source                                                    | Setup                                              |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Author report          | [author-report.ts](../examples/advanced/author-report.ts) | Offline SQL, or migrated + seeded example database |
| Repeatable bulk import | [bulk-import.ts](../examples/advanced/bulk-import.ts)     | PostgreSQL URL; creates and removes its own schema |
| Concurrent work queue  | [work-queue.ts](../examples/advanced/work-queue.ts)       | PostgreSQL URL; creates and removes its own schema |

## 1. Author analytics: three CTEs, windows and nested results

**Goal:** find authors with enough publications since a date, calculate totals
over all qualifying publications and include only each author's best N posts,
with optional editor and many-to-many tags.

```sh
# No DATABASE_URL: print SQL and parameters.
env -u DATABASE_URL bun examples/advanced/author-report.ts

# After migrations + seed from examples/README.md:
DATABASE_URL=postgres://user:password@localhost/symmetria_examples \
  bun examples/advanced/author-report.ts
```

### Query stages

1. `ranked_posts` filters published posts by `since`, then assigns `rowNumber()`
   partitioned by author. `views DESC, id ASC` makes ties deterministic.
2. `author_totals` applies the same filter and groups by author. Publication
   count, total views and latest date cover **all qualifying posts**, not just
   the top N.
3. `eligible_authors` filters the grouped count by `minimumPosts`.
4. The root user query joins eligible authors. Its `best` relation keeps post
   IDs from `ranked_posts` with `position <= top`, then loads editor and ordered
   tags.

The CTEs are typed query sources. Dependencies are emitted automatically into
one SQL statement; no intermediate arrays are fetched by the application.
Filtering a window rank happens in the outer query because SQL does not allow a
window result in the same SELECT's WHERE clause.

```ts
const eligible = totals((total) => ({
  authorId: total.authorId,
  publications: total.publications,
  totalViews: total.totalViews,
  latestPublication: total.latestPublication,
  $where: total.publications.atLeast(parameters.minimumPosts),
})).cte("eligible_authors");
```

The result shape remains the API shape: `author` and `stats` are objects; `best`
and `tags` are collections; an absent editor is `null`. The whole query is
wrapped in `prepare({ since: timestamptz, top: int, minimumPosts: int }, ...)`,
so changing `top` binds another parameter set to the prepared query.

### Exact output

The normal seed produces Ada with three published posts, total views
`"27021597764222979"`, and `typed-sql` / `relations` as the top two. Each post's
`views` is `9007199254740993n`, beyond JavaScript's safe integer range.
`sum(bigint)` is exact decimal text; individual bigint fields are converted to
strings only at the JSON boundary. The second execution uses `top: 1` and
returns one best post without changing the totals.

In an HTTP handler, validate `top`, `minimumPosts` and the date before binding:
column types describe SQL values, not application policy such as a maximum
top-N. For large reports, inspect the actual plan and paginate the author query.

## 2. Bulk import: resolve keys, batch, upsert, commit

Import an external feed into authors, posts, tags and a junction table.
Replaying the same feed preserves logical state without duplicating rows.

```sh
DATABASE_URL=postgres://user:password@localhost/testdb \
  bun examples/advanced/bulk-import.ts
```

`testDatabase()` creates an isolated schema from the shared model. The
connection role needs permission to create schemas. The demo drops that schema
in `finally`; it does not require the regular migration/seed sequence.

### Import phases

1. Deduplicate input posts by natural key `slug`. The last source record wins.
   PostgreSQL cannot update the same target twice in a single upsert statement.
2. Upsert unique authors by `email`, returning IDs. Upserting with
   `doUpdate("name")` returns both inserted and existing authors, which populate
   the key-to-ID map.
3. Insert missing tag labels with `doNothing()`, then select all requested tags.
   `DO NOTHING RETURNING` alone omits existing tags.
4. Upsert posts by `slug` in batches of 200, resolving `authorId` from the map.
   Convert decimal input strings directly with `BigInt`, never through `Number`.
5. Insert unique `(postId, tagId)` links with `doNothing()` on the compound key.

Authors, tags, posts and links use bounded statements. All operations run
through the supplied `Transaction<typeof appSchema>` context on the same
transaction.

```ts
const result = await database.$transaction((transaction) =>
  importPosts(transaction, feed),
);
```

This boundary matters: batches limit SQL/parameter size, but they are **not
separate commits**. An error in a later batch rolls back earlier batches,
authors and links. The import keeps its normalized feed and maps in memory;
batching SQL does not make the input a streaming pipeline. For much larger
imports, choose bounded transaction units and durable checkpoints based on the
application's atomicity requirements.

### What replay means here

The demo feeds 501 records that resolve to 500 posts and 1,000 junction rows:

```text
first:    { posts: 500, linksAdded: 1000 }
repeated: { posts: 500, linksAdded: 0 }
```

`posts` counts resolved keys, not newly created rows. The second upsert can
still issue UPDATEs, produce WAL and fire triggers; idempotency here means the
same logical state, not zero database work. Tag synchronization is **additive**:
removing a tag from the source does not delete an existing link. To replace a
post's tags, delete its previous links inside the same transaction before
inserting the new set.

The program also deliberately throws after an import, checks that `rolled-back`
does not exist, and verifies the last-record-wins title, exact bigint and nested
tags.

## 3. Work queue: concurrent claims and expiring leases

**Goal:** let workers claim disjoint jobs without holding database locks while
performing external work; recover a job abandoned by a crashed worker.

```sh
DATABASE_URL=postgres://user:password@localhost/testdb \
  bun examples/advanced/work-queue.ts
```

The isolated `jobs` schema contains a unique event key, typed JSON payload,
state, attempt count and lease token/deadline. Indexes support the ready-job and
expired-lease filters. PostgreSQL's clock supplies availability and lease
comparisons, avoiding clock skew between worker machines.

### Claim transaction

1. Select queued jobs or running jobs whose lease expired, ordered by
   availability and ID, limited to the batch size.
2. Use `$forUpdate: { skipLocked: true }`. Another worker skips locked
   candidates instead of waiting on them.
3. On those rows, atomically increment attempts and write `running`, worker
   name, a new token and a 30-second lease deadline.
4. Commit, return the claimed payloads, then perform delivery outside the
   transaction.

```ts
const candidates = await transaction.jobs((job) => ({
  id: job.id,
  $where: [
    job.availableAt.atMost(now),
    or(
      job.state.is.queued,
      and(job.state.is.running, job.leaseUntil.atMost(now)),
    ),
  ],
  $orderBy: [job.availableAt.ascending, job.id.ascending],
  $limit: size,
  $forUpdate: { skipLocked: true },
}));
```

The row locks protect the SELECT→UPDATE gap. The lease token protects the later
acknowledgement: completion must match ID, `running`, the current token and an
unexpired deadline. A worker with an old token cannot acknowledge a reassigned
job. `SKIP LOCKED` improves concurrency but does not guarantee strict global
FIFO order.

### Delivery semantics

This is **at-least-once processing**, not exactly-once delivery. A worker can
deliver successfully and crash before acknowledging; a replacement worker then
repeats the delivery. Send the stable event `key` as the downstream idempotency
key. A lease token cannot prevent a stale worker from contacting an external
system; the downstream service must enforce its own deduplication or fencing
contract.

The example logs delivery instead of sending notifications. A long-running
handler needs token-guarded lease renewal; a failed handler needs retry delay,
an attempt limit and a failed/dead-letter state appropriate to the application.
Keep those operations short and use the same guarded-update pattern.

### Executable checks

The demo creates six jobs, claims one as a crashed worker and expires its lease.
Two concurrent claimers then obtain four distinct IDs, including the abandoned
job. The old acknowledgement is rejected. All six jobs finish as `done`, and the
recovered job has two attempts. The schema and pool are removed in `finally`.

## Run the example verification

```sh
SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb \
  bun run test:examples
```

This runs migration generation/application twice, seeds twice, executes the
basic and advanced programs, and asserts the report values, repeatable import
and queue recovery. It uses an isolated schema and temporary migration
directory. The report's offline mode also works with `DATABASE_URL` unset.
