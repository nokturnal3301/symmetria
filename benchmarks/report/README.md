# PostgreSQL benchmark · results

[Run and methodology](../README.md) · [Data and checksums](summary.json) · [Download raw evidence](data.tar.gz)

**3 independent passes · 8 adapters · one complete run.**
Run: `2026-10-21T22-14-44-402Z-d39a2a12`. All numbers are recomputed from this run's verified raw samples.

![Every pass: keyset latency, bulk INSERT, point throughput and client construction](../../docs/assets/benchmarks.svg)

## Common operations

Median sequential p50 across passes, **ms/op; lower is better**. INSERT 500 uses ms/batch. Includes build, bind, execute and decode.

| Adapter | Point | List + JOIN | Nested keyset | INSERT 1 | INSERT 500 | UPDATE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.043 | 0.072 | 1.000 | 0.502 | 4.095 | 0.502 |
| Bun.SQL (page first) | 0.045 | 0.078 | 1.008 | 0.503 | 4.008 | 0.500 |
| Symmetria | 0.025 | 0.113 | 1.022 | 0.530 | 5.026 | 0.541 |
| Drizzle | 0.035 | 0.158 | 1.361 | 0.539 | 10.481 | 0.548 |
| Kysely | 0.022 | 0.133 | 0.966 | 0.528 | 4.722 | 0.536 |
| Prisma (join) | 0.093 | 0.119 | 2.164 | 0.578 | 21.799 | 0.581 |
| Prisma (query) | 0.065 | 0.216 | 1.786 | 0.575 | 20.945 | 0.566 |

A warm synthetic workload, with latency, throughput, SQL-plan sensitivity and client construction reported separately.

## Reading the results

- **p50 [min–max]**: median of process p50s and their full range. Dots show individual passes; lines show min–max, not a confidence interval.
- **p95 / p99**: median process percentiles, omitted below 100 / 1000 samples in any pass. Bulk INSERT has 32 sequential samples per pass, so its tails are omitted.
- **Throughput ×16**: completed application operations / actual wall time, including in-flight drain. Closed-loop load, not a fixed arrival-rate test.
- **SQL/op** is measured sequentially. Prisma supports concurrent unique-lookup batching; throughput counts application operations, not SQL statements.
- Adapter order changes between measurement passes. No passes or outliers are discarded. Identical raw operations outside nested queries provide an additional indication of noise.

## Environment

| Setting | Value |
| --- | --- |
| Runtime | Bun 1.3.2 · linux/arm64 |
| Host / VM | Apple M3 Pro / OrbStack |
| Runner cgroup | CPU quota `200000 100000`; RAM `2147483648` bytes |
| Read phase | ≥ 2000 ms and 100 samples; concurrent ≥ 2000 ms |
| Pool / concurrency | 16 / 16 |
| Dataset | users: 2,000; posts: 40,000; tags: 100; post_tags: 109,747 |
| Dependencies | drizzle-orm 0.45.4; kysely 0.29.7; @prisma/client 7.10.1; @prisma/adapter-pg 7.10.1; pg 8.23.1 |

PostgreSQL: PostgreSQL 16.10 (Debian 16.10-1.pgdg12+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit. Full settings, durability, image IDs and hashes are in `manifest.json`. Source SHA-256: `0f1b78cf491d252395f8be4af9481c4c78dda3c7a361c21955da88fad8ce564d`.

Prisma uses its official adapter-pg/node-postgres; other adapters use Bun.SQL (Kysely through this suite's dialect). This compares those stacks, including their driver costs. SQL and EXPLAIN ANALYZE are captured outside timing.

## Reads

<details>
<summary><strong>Point lookup</strong> · ms/op</summary>

One user by primary key; deterministic ID stream.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.043 [0.017–0.043] | 0.055 | 0.060 | 55,332–64,789 |
| Bun.SQL (page first) | 0.045 [0.044–0.051] | 0.055 | 0.061 | 42,392–49,502 |
| Symmetria | 0.025 [0.025–0.055] | 0.071 | 0.079 | 38,268–55,756 |
| Drizzle | 0.035 [0.033–0.073] | 0.075 | 0.097 | 28,380–49,625 |
| Kysely | 0.022 [0.021–0.024] | 0.030 | 0.048 | 52,573–85,908 |
| Prisma (join) | 0.093 [0.078–0.102] | 0.106 | 0.180 | 13,872–25,703 |
| Prisma (query) | 0.065 [0.045–0.092] | 0.108 | 0.191 | 21,758–37,320 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 28,764 | 58,367 [56,926–58,398] | 1.00 |
| Bun.SQL (page first) | 23,312 | 57,259 [55,635–58,108] | 1.00 |
| Symmetria | 27,151 | 31,838 [29,193–32,632] | 1.00 |
| Drizzle | 21,586 | 25,463 [25,394–26,418] | 1.00 |
| Kysely | 40,639 | 36,450 [24,395–36,467] | 1.00 |
| Prisma (join) | 11,051 | 69,169 [67,829–72,716] | 1.00 |
| Prisma (query) | 12,552 | 69,699 [66,045–73,783] | 1.00 |

</details>

<details>
<summary><strong>List + author JOIN</strong> · ms/op</summary>

20 published posts with their author; created_at DESC, id DESC.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.072 [0.047–0.084] | 0.091 | 0.112 | 26,722–33,119 |
| Bun.SQL (page first) | 0.078 [0.049–0.084] | 0.092 | 0.109 | 24,107–31,801 |
| Symmetria | 0.113 [0.112–0.114] | 0.133 | 0.372 | 15,010–17,324 |
| Drizzle | 0.158 [0.116–0.160] | 0.175 | 0.251 | 12,215–15,920 |
| Kysely | 0.133 [0.090–0.137] | 0.157 | 0.389 | 10,795–18,089 |
| Prisma (join) | 0.119 [0.116–0.148] | 0.175 | 0.429 | 13,179–15,803 |
| Prisma (query) | 0.216 [0.145–0.236] | 0.264 | 0.745 | 8,534–12,469 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 14,901 | 36,195 [31,932–36,318] | 1.00 |
| Bun.SQL (page first) | 12,589 | 32,248 [30,535–33,275] | 1.00 |
| Symmetria | 8,423 | 17,799 [17,227–17,824] | 1.00 |
| Drizzle | 6,779 | 11,361 [11,318–11,379] | 1.00 |
| Kysely | 7,777 | 23,392 [13,873–23,951] | 1.00 |
| Prisma (join) | 7,275 | 14,036 [14,030–14,533] | 1.00 |
| Prisma (query) | 4,428 | 7,034 [6,667–7,137] | 2.00 |

</details>

<details>
<summary><strong>Nested · first page</strong> · ms/op</summary>

50 users × up to 3 posts × tags; OFFSET 0.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1.073 [1.067–1.083] | 1.213 | 1.412 | 1,783–1,817 |
| Bun.SQL (page first) | 1.013 [1.005–1.017] | 1.085 | 1.226 | 1,854–1,976 |
| Symmetria | 1.145 [1.141–1.149] | 1.338 | 1.619 | 1,673–1,716 |
| Symmetria (prepared) | 0.967 [0.966–0.971] | 1.035 | 1.249 | 2,017–2,043 |
| Drizzle | 1.387 [1.385–1.413] | 1.578 | 1.792 | 1,368–1,422 |
| Kysely | 1.058 [1.027–1.066] | 1.411 | 2.370 | 1,751–1,873 |
| Prisma (join) | 2.154 [2.145–2.208] | 2.598 | — | 885–912 |
| Prisma (query) | 1.786 [1.780–1.921] | 2.618 | — | 973–1,049 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 892 | 887 [850–1,096] | 1.00 |
| Bun.SQL (page first) | 973 | 942 [914–1,056] | 1.00 |
| Symmetria | 849 | 1,393 [1,285–1,436] | 1.00 |
| Symmetria (prepared) | 1,014 | 1,362 [1,344–1,571] | 1.00 |
| Drizzle | 709 | 1,417 [1,415–1,426] | 1.00 |
| Kysely | 883 | 1,312 [1,260–1,356] | 1.00 |
| Prisma (join) | 443 | 750 [749–768] | 1.00 |
| Prisma (query) | 523 | 549 [544–563] | 4.00 |

</details>

<details>
<summary><strong>Nested · keyset</strong> · ms/op</summary>

50 users × up to 3 posts × tags; users.id > 1900. No 1900-parent OFFSET discard.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1.000 [0.994–1.009] | 1.106 | 1.329 | 1,952–1,981 |
| Bun.SQL (page first) | 1.008 [1.006–1.014] | 1.085 | 1.248 | 1,921–1,948 |
| Symmetria | 1.022 [1.012–1.023] | 1.147 | 1.425 | 1,893–1,915 |
| Drizzle | 1.361 [1.336–1.400] | 1.478 | 1.656 | 1,403–1,476 |
| Kysely | 0.966 [0.963–0.989] | 1.085 | 1.339 | 1,950–2,042 |
| Prisma (join) | 2.164 [2.138–2.186] | 2.474 | — | 898–921 |
| Prisma (query) | 1.786 [1.782–1.805] | 2.612 | 3.789 | 1,037–1,062 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 987 | 1,226 [1,054–1,250] | 1.00 |
| Bun.SQL (page first) | 973 | 1,122 [952–1,190] | 1.00 |
| Symmetria | 951 | 1,693 [1,311–1,719] | 1.00 |
| Drizzle | 727 | 1,416 [1,381–1,429] | 1.00 |
| Kysely | 1,017 | 1,580 [1,549–1,611] | 1.00 |
| Prisma (join) | 450 | 751 [738–787] | 1.00 |
| Prisma (query) | 521 | 560 [542–591] | 4.00 |

</details>

## Writes

<details>
<summary><strong>INSERT · one row</strong> · ms/op</summary>

One row with RETURNING id; 256 sequential operations and 64 per concurrent worker.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.502 [0.497–0.508] | 0.638 | — | 256–256 |
| Bun.SQL (page first) | 0.503 [0.483–0.509] | 0.635 | — | 256–256 |
| Symmetria | 0.530 [0.529–0.531] | 0.679 | — | 256–256 |
| Drizzle | 0.539 [0.527–0.542] | 0.682 | — | 256–256 |
| Kysely | 0.528 [0.516–0.551] | 0.667 | — | 256–256 |
| Prisma (join) | 0.578 [0.572–0.607] | 0.742 | — | 256–256 |
| Prisma (query) | 0.575 [0.556–0.595] | 0.701 | — | 256–256 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1,904 | 15,826 [15,032–16,079] | 1.00 |
| Bun.SQL (page first) | 1,928 | 15,214 [15,127–16,224] | 1.00 |
| Symmetria | 1,824 | 14,342 [14,251–14,565] | 1.00 |
| Drizzle | 1,786 | 13,239 [11,723–13,441] | 1.00 |
| Kysely | 1,829 | 13,311 [13,032–13,383] | 1.00 |
| Prisma (join) | 1,628 | 12,186 [11,647–12,680] | 1.00 |
| Prisma (query) | 1,652 | 11,794 [11,793–12,829] | 1.00 |

</details>

<details>
<summary><strong>INSERT · 500 rows</strong> · ms/batch</summary>

500 rows without RETURNING; 32 sequential batches and 4 per worker. One operation is one 500-row batch.

| Adapter | p50 [min–max], ms/batch | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 4.095 [4.074–4.133] | — | — | 32–32 |
| Bun.SQL (page first) | 4.008 [3.889–4.196] | — | — | 32–32 |
| Symmetria | 5.026 [4.987–5.137] | — | — | 32–32 |
| Drizzle | 10.481 [10.439–10.788] | — | — | 32–32 |
| Kysely | 4.722 [4.667–4.728] | — | — | 32–32 |
| Prisma (join) | 21.799 [20.866–21.934] | — | — | 32–32 |
| Prisma (query) | 20.945 [20.374–22.004] | — | — | 32–32 |

| Adapter | Sequential batches/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 239 | 452 [421–518] | 1.00 |
| Bun.SQL (page first) | 242 | 524 [431–561] | 1.00 |
| Symmetria | 199 | 412 [410–443] | 1.00 |
| Drizzle | 93 | 144 [139–147] | 1.00 |
| Kysely | 212 | 397 [396–417] | 1.00 |
| Prisma (join) | 46 | 61 [60–62] | 1.00 |
| Prisma (query) | 47 | 62 [60–65] | 1.00 |

</details>

<details>
<summary><strong>UPDATE · bigint increment</strong> · ms/op</summary>

Atomic views = views + 1 with RETURNING views; 512 sequential operations and 128 per worker.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.502 [0.501–0.525] | 0.637 | — | 512–512 |
| Bun.SQL (page first) | 0.500 [0.497–0.513] | 0.651 | — | 512–512 |
| Symmetria | 0.541 [0.536–0.554] | 0.762 | — | 512–512 |
| Drizzle | 0.548 [0.535–0.551] | 0.744 | — | 512–512 |
| Kysely | 0.536 [0.526–0.584] | 0.729 | — | 512–512 |
| Prisma (join) | 0.581 [0.572–0.600] | 1.161 | — | 512–512 |
| Prisma (query) | 0.566 [0.554–0.581] | 0.742 | — | 512–512 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1,894 | 15,206 [14,070–15,515] | 1.00 |
| Bun.SQL (page first) | 1,881 | 13,865 [12,808–15,041] | 1.00 |
| Symmetria | 1,725 | 13,351 [13,253–14,254] | 1.00 |
| Drizzle | 1,655 | 12,515 [9,320–13,942] | 1.00 |
| Kysely | 1,773 | 14,119 [13,475–14,204] | 1.00 |
| Prisma (join) | 1,464 | 10,021 [8,559–11,782] | 1.00 |
| Prisma (query) | 1,674 | 9,501 [4,235–10,933] | 1.00 |

</details>

## Plan experiment: OFFSET depth

Direct LATERAL and page-first raw return the same data but limit parents at different stages. Kysely can also express page-first SQL. The OFFSET gap belongs to these specific query plans, not an intrinsic ORM or compiler speed ratio.

<details>
<summary><strong>Nested · OFFSET 1000</strong> · ms/op</summary>

Same shape, OFFSET 1000. Tests SQL-plan sensitivity to page depth.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 18.879 [18.769–19.266] | 20.457 | — | 102–103 |
| Bun.SQL (page first) | 1.075 [1.061–1.077] | 1.188 | 1.708 | 1,639–1,857 |
| Symmetria | 1.190 [1.161–1.195] | 1.351 | 1.649 | 1,564–1,682 |
| Symmetria (prepared) | 1.027 [1.016–1.029] | 1.120 | 1.319 | 1,908–1,940 |
| Drizzle | 19.958 [19.889–20.548] | 21.287 | — | 100–100 |
| Kysely | 17.414 [17.404–18.260] | 19.610 | — | 109–111 |
| Prisma (join) | 35.004 [34.934–35.300] | 36.888 | — | 100–100 |
| Prisma (query) | 1.900 [1.873–1.903] | 2.646 | — | 973–1,003 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 51 | 40 [38–41] | 1.00 |
| Bun.SQL (page first) | 875 | 971 [880–1,063] | 1.00 |
| Symmetria | 821 | 1,339 [1,232–1,345] | 1.00 |
| Symmetria (prepared) | 961 | 1,286 [1,131–1,383] | 1.00 |
| Drizzle | 49 | 34 [34–35] | 1.00 |
| Kysely | 55 | 42 [41–43] | 1.00 |
| Prisma (join) | 28 | 21 [21–22] | 1.00 |
| Prisma (query) | 495 | 544 [526–558] | 4.00 |

</details>

<details>
<summary><strong>Nested · OFFSET 1900</strong> · ms/op</summary>

Same shape, OFFSET 1900. Compare with page-first raw and keyset to distinguish plan cost from client overhead.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 34.807 [34.774–35.519] | 36.718 | — | 100–100 |
| Bun.SQL (page first) | 1.112 [1.107–1.116] | 1.209 | 1.358 | 1,745–1,773 |
| Symmetria | 1.241 [1.211–1.244] | 1.477 | 1.927 | 1,553–1,568 |
| Symmetria (prepared) | 1.070 [1.063–1.107] | 1.267 | 1.441 | 1,653–1,849 |
| Drizzle | 36.680 [36.464–37.796] | 39.277 | — | 100–100 |
| Kysely | 32.066 [31.981–33.177] | 33.931 | — | 100–100 |
| Prisma (join) | 64.870 [64.044–65.946] | 68.448 | — | 100–100 |
| Prisma (query) | 1.914 [1.888–2.001] | 2.731 | — | 919–1,004 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 28 | 22 [20–22] | 1.00 |
| Bun.SQL (page first) | 884 | 957 [929–984] | 1.00 |
| Symmetria | 783 | 1,283 [1,244–1,349] | 1.00 |
| Symmetria (prepared) | 920 | 1,240 [1,207–1,357] | 1.00 |
| Drizzle | 27 | 18 [18–19] | 1.00 |
| Kysely | 31 | 22 [21–23] | 1.00 |
| Prisma (join) | 15 | 11 [11–11] | 1.00 |
| Prisma (query) | 486 | 558 [491–572] | 4.00 |

</details>

## Client only

<details>
<summary><strong>Build + compile · nested query</strong> · µs/build</summary>

Fresh builder and SQL per operation, without database I/O or await. Each sample averages 100 builds; includes construction, not just compilation.

| Adapter | p50 [min–max], µs/build | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Symmetria | 35.441 [35.039–37.069] | 43.823 | — | 515–537 |
| Drizzle | 157.481 [156.859–157.600] | 182.498 | — | 121–125 |
| Kysely | 21.024 [20.840–21.545] | 26.906 | — | 883–920 |

This scenario measures fresh query construction and synchronous SQL compilation for Symmetria, Drizzle and Kysely. Raw has no ORM compiler; Prisma has no equivalent public synchronous API. Prepared/cache-hit timings are excluded.

</details>

## Scope

One dataset size, mostly uniform relation density, warm cache and concurrency 1/16. Cold starts, WAN, HTTP serialization, sustained writes, transactions, skew and saturation curves are outside this run. Short fixed write budgets measure bursts, not steady-state ingestion capacity.

CPU quotas cap usage without reserving cores. Containers on macOS share the VM and host. Prepared Symmetria has three OFFSET cases only. Prisma query can fetch additional intermediate rows; normalization is only used by the correctness oracle, outside timing.
