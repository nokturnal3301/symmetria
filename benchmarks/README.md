# Benchmarks

[Results](report/README.md) · [Raw data + measured source](report/data.tar.gz) ·
[Machine-readable summary](report/summary.json)

Symmetria, Drizzle, Kysely, Prisma and Bun.SQL on the same PostgreSQL workload.
The main README contains an animated overview; the report includes every
scenario, pass range, sample count and environment detail.

## Run

Requires Bun, Git and Docker Compose v2. From the repository root:

```sh
bun run --cwd benchmarks docker
```

The launcher builds the pinned runner, checks all adapters against an
independent oracle, captures SQL/plans and measures three passes. Containers and
the dedicated disk volume are removed on exit. Output: `.cache/runs/<run-id>/`
inside this folder.

## Workload

| Area        | Scenarios                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| Reads       | Primary-key lookup; 20 posts + author JOIN; nested first page; nested keyset |
| Writes      | Single INSERT + RETURNING; INSERT 500 rows; atomic bigint UPDATE             |
| Query plans | Nested OFFSET 0 / 1000 / 1900; direct and page-first raw controls            |
| Client      | Fresh nested query construction + SQL, without database I/O                  |

Fixture: 2,000 users, 40,000 posts, 100 tags and 109,747 deterministic links.
Includes empty relations, timestamp ties and bigint values above 2^53.

## Method

- **Environment:** Bun 1.3.2 / PostgreSQL 16.10 images pinned by digest; frozen
  dependencies; 2 CPUs and 2 GiB per container; disk volume; fsync, synchronous
  commit and full-page writes on. Pool size 16. Native architecture.
- **Correctness first:** separate validation processes check ordered reads,
  seven pagination positions, missing/empty results, all 501 inserted rows and
  concurrent increments. The oracle assembles flat database rows independently
  of the adapters.
- **Independent passes:** fresh process/database per adapter/pass, deterministic
  inputs, changing adapter order, full-pool warmup and identical seed checksums.
- **Read timing:** at least 2 seconds and 100 sequential operations; at least 2
  seconds at concurrency 16. Actual wall time includes in-flight drain.
- **Write timing:** fixed budgets equalize table growth; reset between phases.
  INSERT 1: 256 sequential / 64 per concurrent worker; INSERT 500: 32 / 4;
  UPDATE: 512 / 128. These are short bursts, not sustained ingestion tests.
- **Statistics:** median of independent process percentiles, all passes
  retained. Min–max is a range, not a confidence interval. p95/p99 require
  100/1000 samples in every pass. SQL/op is measured in the sequential phase.
- **Evidence:** source snapshots, manifests, SQL/plans and raw samples are
  hashed. Reporting validates completeness, budgets, durations and recomputes
  statistics.

Prisma uses node-postgres; other adapters use Bun.SQL, including this suite's
Kysely dialect. Prisma supports concurrent unique-lookup batching. Deep OFFSET
compares specific SQL plans; Kysely can also express page-first SQL. Prepared
Symmetria is labelled separately and only measured for three OFFSET scenarios.

This is one warm, synthetic dataset at concurrency 1/16. It does not measure
HTTP serialization, WAN, cold starts, transactions, skew or saturation curves.
CPU quotas do not reserve cores; macOS containers share the Docker VM and host.

## Develop and publish

From this directory:

```sh
bun install --frozen-lockfile
bun run generate
bun run check
bun run report .cache/runs/<run-id>
bun run publish .cache/runs/<run-id>
```

Publishing requires Python with **Pillow 12.2.0** and **FFmpeg** for the GIF. It
packages and verifies the raw evidence, generates the English report/summary and
renders the README animation. `bun run animate` rerenders from
`report/summary.json`. For a pipeline check only:

```sh
BENCH_PASSES=1 BENCH_SEQ_MS=50 BENCH_CONC_MS=50 BENCH_MIN_SAMPLES=5 bun run docker
```

To verify the downloadable snapshot without PostgreSQL:

```sh
mkdir -p .cache/runs
tar -xzf report/data.tar.gz -C .cache/runs
bun run report .cache/runs/<run-id>
```

The archive's manifest and source identify the **measured** code. For an exact
replay, overlay its `source/` on a checkout and use that snapshot's launcher;
the current launcher measures the current checkout. The raw evidence is
unchanged; derived report/chart files are rendered with the current presentation
code.

## Layout

```text
benchmarks/
├── src/        # adapters, workers, harness, rendering and local diagnostics
├── docker/     # pinned runner and PostgreSQL environment
├── fixtures/   # SQL and Prisma schemas
├── report/     # one current report, summary and evidence archive
└── .cache/     # ignored runs, generated client and profiling output
```

`bun run micro` measures client-side query construction, compilation and
decoding with a stub driver. It prints a local diagnostic table without database
I/O.

Public precedents:
[Drizzle's benchmark dashboard and source](https://orm.drizzle.team/benchmarks),
[Prisma's open comparison suite](https://github.com/prisma/prisma-orm-benchmarks)
and
[Drizzle's Northwind sample results](https://github.com/drizzle-team/drizzle-northwind-benchmarks-pg).
Those workloads and numbers are independent of this suite.
