# PostgreSQL benchmark · results

[Run and methodology](../README.md) · [Data and checksums](summary.json)

**5 independent passes · 8 adapters · one complete run.**
Run: `2026-11-20T17-16-49-640Z-abeb54bd`. All numbers are recomputed from this run's verified raw samples.

![Every pass: keyset latency, bulk INSERT, point throughput and client construction](../../docs/assets/benchmarks.svg)

## Common operations

Median sequential p50 across passes, **ms/op; lower is better**. INSERT 500 uses ms/batch. Includes build, bind, execute and decode.

| Adapter | Point | List + JOIN | Nested keyset | INSERT 1 | INSERT 500 | UPDATE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.011 | 0.084 | 0.985 | 0.494 | 3.848 | 0.518 |
| Bun.SQL (page first) | 0.011 | 0.084 | 0.992 | 0.486 | 3.955 | 0.513 |
| Symmetria | 0.013 | 0.098 | 0.974 | 0.519 | 4.109 | 0.541 |
| Drizzle | 0.020 | 0.138 | 1.249 | 0.532 | 7.656 | 0.516 |
| Kysely | 0.015 | 0.128 | 0.941 | 0.505 | 4.263 | 0.511 |
| Prisma (join) | 0.039 | 0.113 | 2.095 | 0.568 | 18.692 | 0.559 |
| Prisma (query) | 0.037 | 0.152 | 1.736 | 0.588 | 19.250 | 0.580 |

A warm synthetic workload, with latency, throughput, SQL-plan sensitivity and client construction reported separately.

## Reading the results

- **p50 [min–max]**: median of process p50s and their full range across passes, not a confidence interval.
- **p95 / p99**: median process percentiles, omitted below 100 / 1000 samples in any pass. Bulk INSERT has 32 sequential samples per pass, so its tails are omitted.
- **Throughput ×16**: completed application operations / actual wall time, including in-flight drain. Closed-loop load, not a fixed arrival-rate test.
- **SQL/op** is measured sequentially. Prisma supports concurrent unique-lookup batching; throughput counts application operations, not SQL statements.
- Adapter order changes between measurement passes. No passes or outliers are discarded. Identical raw operations outside nested queries provide an additional indication of noise.

## Environment

| Setting | Value |
| --- | --- |
| Runtime | Bun 1.4.4 · linux/arm64 |
| Host / VM | Apple M3 Pro / OrbStack |
| Runner cgroup | CPU quota `200000 100000`; RAM `2147483648` bytes |
| Read phase | ≥ 2000 ms and 100 samples; concurrent ≥ 2000 ms |
| Read warm-up | 8 calls on each of 16 connections, then 1000 ms of sequential calls |
| Pool / concurrency | 16 / 16 |
| Dataset | users: 2,000; posts: 40,000; tags: 100; post_tags: 109,747 |
| Dependencies | drizzle-orm 0.45.4; kysely 0.29.7; @prisma/client 7.10.1; @prisma/adapter-pg 7.10.1; pg 8.23.1 |

PostgreSQL: PostgreSQL 16.10 (Debian 16.10-1.pgdg12+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit. Full settings, durability, image IDs and hashes are in `manifest.json`. Source SHA-256: `ace26c7e695eb7c69cbae68346bde31cfadf5baa12be88d0b39c326da2a3d6cf`.

Prisma uses its official adapter-pg/node-postgres; other adapters use Bun.SQL (Kysely through this suite's dialect). This compares those stacks, including their driver costs. SQL and EXPLAIN ANALYZE are captured outside timing.

## Reads

<details>
<summary><strong>Point lookup</strong> · ms/op</summary>

One user by primary key; deterministic ID stream.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.011 [0.011–0.011] | 0.017 | 0.047 | 147,018–180,397 |
| Bun.SQL (page first) | 0.011 [0.011–0.014] | 0.026 | 0.047 | 81,179–174,589 |
| Symmetria | 0.013 [0.013–0.014] | 0.051 | 0.055 | 71,291–138,288 |
| Drizzle | 0.020 [0.019–0.023] | 0.062 | 0.068 | 52,300–92,376 |
| Kysely | 0.015 [0.015–0.015] | 0.053 | 0.059 | 89,915–121,779 |
| Prisma (join) | 0.039 [0.037–0.085] | 0.091 | 0.099 | 25,738–49,589 |
| Prisma (query) | 0.037 [0.037–0.046] | 0.057 | 0.095 | 31,882–50,238 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 81,088 | 86,716 [85,651–88,235] | 1.00 |
| Bun.SQL (page first) | 79,140 | 86,709 [83,542–87,007] | 1.00 |
| Symmetria | 55,823 | 60,374 [56,407–62,507] | 1.00 |
| Drizzle | 38,515 | 37,953 [35,181–38,318] | 1.00 |
| Kysely | 47,158 | 51,412 [48,966–52,070] | 1.00 |
| Prisma (join) | 21,080 | 88,580 [81,213–94,153] | 1.00 |
| Prisma (query) | 23,848 | 82,503 [82,235–91,487] | 1.00 |

</details>

<details>
<summary><strong>List + author JOIN</strong> · ms/op</summary>

20 published posts with their author; created_at DESC, id DESC.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.084 [0.084–0.086] | 0.093 | 0.102 | 23,096–27,302 |
| Bun.SQL (page first) | 0.084 [0.079–0.085] | 0.096 | 0.106 | 19,814–30,629 |
| Symmetria | 0.098 [0.098–0.099] | 0.113 | 0.137 | 19,275–21,051 |
| Drizzle | 0.138 [0.117–0.139] | 0.155 | 0.342 | 13,787–16,526 |
| Kysely | 0.128 [0.078–0.132] | 0.142 | 0.153 | 14,907–22,218 |
| Prisma (join) | 0.113 [0.106–0.156] | 0.177 | 0.204 | 12,717–16,154 |
| Prisma (query) | 0.152 [0.127–0.214] | 0.239 | 0.272 | 10,180–12,238 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 11,799 | 32,628 [28,760–33,513] | 1.00 |
| Bun.SQL (page first) | 11,895 | 32,783 [29,511–33,367] | 1.00 |
| Symmetria | 9,956 | 29,899 [28,213–32,258] | 1.00 |
| Drizzle | 7,077 | 21,134 [19,304–21,475] | 1.00 |
| Kysely | 7,708 | 23,250 [20,409–24,510] | 1.00 |
| Prisma (join) | 7,418 | 19,266 [19,181–20,094] | 1.00 |
| Prisma (query) | 5,502 | 9,983 [7,902–10,679] | 2.00 |

</details>

<details>
<summary><strong>Nested · first page</strong> · ms/op</summary>

50 users × up to 3 posts × tags; OFFSET 0.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1.068 [1.046–1.100] | 1.207 | 1.323 | 1,784–1,902 |
| Bun.SQL (page first) | 1.001 [0.995–1.033] | 1.112 | 1.211 | 1,906–1,990 |
| Symmetria | 1.088 [1.053–1.213] | 1.254 | 1.609 | 1,545–1,827 |
| Symmetria (prepared) | 0.940 [0.928–0.994] | 1.032 | 1.168 | 1,951–2,141 |
| Drizzle | 1.266 [1.264–1.306] | 1.524 | 1.741 | 1,468–1,541 |
| Kysely | 1.023 [1.005–1.054] | 1.137 | 1.264 | 1,831–1,973 |
| Prisma (join) | 2.143 [2.102–2.228] | 2.509 | — | 874–948 |
| Prisma (query) | 1.770 [1.704–1.877] | 2.792 | 3.455 | 1,003–1,114 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 910 | 872 [785–926] | 1.00 |
| Bun.SQL (page first) | 983 | 907 [807–1,066] | 1.00 |
| Symmetria | 898 | 1,357 [1,192–1,388] | 1.00 |
| Symmetria (prepared) | 1,049 | 1,409 [1,011–1,591] | 1.00 |
| Drizzle | 763 | 1,591 [1,516–1,675] | 1.00 |
| Kysely | 961 | 1,291 [1,224–1,451] | 1.00 |
| Prisma (join) | 453 | 658 [642–681] | 1.00 |
| Prisma (query) | 527 | 636 [618–662] | 4.00 |

</details>

<details>
<summary><strong>Nested · keyset</strong> · ms/op</summary>

50 users × up to 3 posts × tags; users.id > 1900. No 1900-parent OFFSET discard.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.985 [0.975–0.999] | 1.093 | 1.189 | 1,973–2,040 |
| Bun.SQL (page first) | 0.992 [0.973–1.000] | 1.034 | 1.157 | 1,973–2,042 |
| Symmetria | 0.974 [0.952–0.991] | 1.100 | 1.302 | 1,982–2,040 |
| Drizzle | 1.249 [1.222–1.262] | 1.558 | 1.767 | 1,522–1,590 |
| Kysely | 0.941 [0.929–0.988] | 1.009 | 1.160 | 1,936–2,132 |
| Prisma (join) | 2.095 [2.088–2.260] | 2.331 | — | 859–948 |
| Prisma (query) | 1.736 [1.728–1.899] | 2.758 | — | 948–1,092 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 997 | 1,158 [1,001–1,352] | 1.00 |
| Bun.SQL (page first) | 1,003 | 1,171 [1,003–1,269] | 1.00 |
| Symmetria | 1,006 | 1,587 [1,523–1,616] | 1.00 |
| Drizzle | 768 | 1,600 [1,480–1,683] | 1.00 |
| Kysely | 1,052 | 1,583 [1,437–1,652] | 1.00 |
| Prisma (join) | 470 | 712 [649–780] | 1.00 |
| Prisma (query) | 533 | 655 [617–674] | 4.00 |

</details>

## Writes

<details>
<summary><strong>INSERT · one row</strong> · ms/op</summary>

One row with RETURNING id; 256 sequential operations and 64 per concurrent worker.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.494 [0.473–0.513] | 0.630 | — | 256–256 |
| Bun.SQL (page first) | 0.486 [0.471–0.523] | 0.606 | — | 256–256 |
| Symmetria | 0.519 [0.459–0.550] | 0.636 | — | 256–256 |
| Drizzle | 0.532 [0.517–0.545] | 0.660 | — | 256–256 |
| Kysely | 0.505 [0.472–0.534] | 0.668 | — | 256–256 |
| Prisma (join) | 0.568 [0.526–0.600] | 0.795 | — | 256–256 |
| Prisma (query) | 0.588 [0.545–0.590] | 0.703 | — | 256–256 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1,956 | 15,177 [12,617–15,540] | 1.00 |
| Bun.SQL (page first) | 1,943 | 13,888 [2,864–16,185] | 1.00 |
| Symmetria | 1,869 | 14,384 [13,941–15,083] | 1.00 |
| Drizzle | 1,815 | 14,462 [11,338–15,120] | 1.00 |
| Kysely | 1,870 | 14,812 [13,871–15,564] | 1.00 |
| Prisma (join) | 1,662 | 12,341 [10,884–13,362] | 1.00 |
| Prisma (query) | 1,668 | 12,720 [12,092–14,216] | 1.00 |

</details>

<details>
<summary><strong>INSERT · 500 rows</strong> · ms/batch</summary>

500 rows without RETURNING; 32 sequential batches and 4 per worker. One operation is one 500-row batch.

| Adapter | p50 [min–max], ms/batch | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 3.848 [3.773–3.945] | — | — | 32–32 |
| Bun.SQL (page first) | 3.955 [3.908–4.091] | — | — | 32–32 |
| Symmetria | 4.109 [4.004–4.273] | — | — | 32–32 |
| Drizzle | 7.656 [7.001–7.914] | — | — | 32–32 |
| Kysely | 4.263 [3.966–4.435] | — | — | 32–32 |
| Prisma (join) | 18.692 [18.026–19.904] | — | — | 32–32 |
| Prisma (query) | 19.250 [18.211–19.861] | — | — | 32–32 |

| Adapter | Sequential batches/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 251 | 435 [404–538] | 1.00 |
| Bun.SQL (page first) | 248 | 451 [421–541] | 1.00 |
| Symmetria | 240 | 453 [393–529] | 1.00 |
| Drizzle | 127 | 262 [237–280] | 1.00 |
| Kysely | 228 | 441 [390–511] | 1.00 |
| Prisma (join) | 52 | 61 [59–63] | 1.00 |
| Prisma (query) | 50 | 61 [57–64] | 1.00 |

</details>

<details>
<summary><strong>UPDATE · bigint increment</strong> · ms/op</summary>

Atomic views = views + 1 with RETURNING views; 512 sequential operations and 128 per worker.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.518 [0.491–0.530] | 0.633 | — | 512–512 |
| Bun.SQL (page first) | 0.513 [0.488–0.539] | 0.622 | — | 512–512 |
| Symmetria | 0.541 [0.491–0.550] | 0.679 | — | 512–512 |
| Drizzle | 0.516 [0.458–0.548] | 0.641 | — | 512–512 |
| Kysely | 0.511 [0.465–0.570] | 0.665 | — | 512–512 |
| Prisma (join) | 0.559 [0.490–0.577] | 0.696 | — | 512–512 |
| Prisma (query) | 0.580 [0.549–0.602] | 0.718 | — | 512–512 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1,834 | 14,795 [14,217–15,467] | 1.00 |
| Bun.SQL (page first) | 1,857 | 15,147 [11,274–15,648] | 1.00 |
| Symmetria | 1,761 | 14,452 [13,306–15,018] | 1.00 |
| Drizzle | 1,816 | 14,734 [13,293–16,104] | 1.00 |
| Kysely | 1,834 | 14,709 [11,514–16,431] | 1.00 |
| Prisma (join) | 1,706 | 12,640 [11,288–13,381] | 1.00 |
| Prisma (query) | 1,665 | 12,473 [11,178–14,170] | 1.00 |

</details>

## Plan experiment: OFFSET depth

Direct LATERAL and page-first raw return the same data but limit parents at different stages. Kysely can also express page-first SQL. The OFFSET gap belongs to these specific query plans, not an intrinsic ORM or compiler speed ratio.

<details>
<summary><strong>Nested · OFFSET 1000</strong> · ms/op</summary>

Same shape, OFFSET 1000. Tests SQL-plan sensitivity to page depth.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 19.073 [18.588–19.587] | 20.095 | — | 102–108 |
| Bun.SQL (page first) | 1.054 [1.040–1.069] | 1.146 | 1.244 | 1,845–1,912 |
| Symmetria | 1.110 [1.101–1.128] | 1.276 | 1.433 | 1,741–1,788 |
| Symmetria (prepared) | 1.021 [0.998–1.032] | 1.132 | 1.264 | 1,878–1,991 |
| Drizzle | 19.918 [19.708–20.557] | 20.820 | — | 100–102 |
| Kysely | 17.530 [17.308–18.919] | 18.549 | — | 106–116 |
| Prisma (join) | 36.958 [34.566–37.685] | 38.759 | — | 100–100 |
| Prisma (query) | 1.890 [1.762–1.906] | 2.873 | — | 981–1,075 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 52 | 39 [37–44] | 1.00 |
| Bun.SQL (page first) | 944 | 867 [803–915] | 1.00 |
| Symmetria | 872 | 1,293 [1,196–1,385] | 1.00 |
| Symmetria (prepared) | 966 | 1,243 [1,210–1,388] | 1.00 |
| Drizzle | 50 | 35 [32–35] | 1.00 |
| Kysely | 56 | 44 [42–45] | 1.00 |
| Prisma (join) | 27 | 20 [20–22] | 1.00 |
| Prisma (query) | 494 | 645 [590–681] | 4.00 |

</details>

<details>
<summary><strong>Nested · OFFSET 1900</strong> · ms/op</summary>

Same shape, OFFSET 1900. Compare with page-first raw and keyset to distinguish plan cost from client overhead.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 35.634 [34.351–36.049] | 36.457 | — | 100–100 |
| Bun.SQL (page first) | 1.096 [1.082–1.105] | 1.214 | 1.346 | 1,770–1,841 |
| Symmetria | 1.151 [1.137–1.176] | 1.307 | 1.467 | 1,665–1,736 |
| Symmetria (prepared) | 1.064 [1.031–1.068] | 1.176 | 1.316 | 1,780–1,929 |
| Drizzle | 36.885 [36.392–37.769] | 38.401 | — | 100–100 |
| Kysely | 32.681 [31.994–35.015] | 33.726 | — | 100–100 |
| Prisma (join) | 66.256 [63.901–70.173] | 67.558 | — | 100–100 |
| Prisma (query) | 1.902 [1.742–1.957] | 2.904 | — | 959–1,063 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 28 | 21 [20–23] | 1.00 |
| Bun.SQL (page first) | 892 | 904 [837–1,124] | 1.00 |
| Symmetria | 854 | 1,246 [1,197–1,339] | 1.00 |
| Symmetria (prepared) | 926 | 1,240 [1,137–1,317] | 1.00 |
| Drizzle | 27 | 18 [17–18] | 1.00 |
| Kysely | 30 | 22 [22–26] | 1.00 |
| Prisma (join) | 15 | 12 [11–12] | 1.00 |
| Prisma (query) | 484 | 631 [614–661] | 4.00 |

</details>

## Client only

<details>
<summary><strong>Build + compile · nested query</strong> · µs/build</summary>

Fresh builder and SQL per operation, without database I/O or await. Each sample averages 100 builds; includes construction, not just compilation.

| Adapter | p50 [min–max], µs/build | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Symmetria | 12.911 [11.960–14.274] | 18.275 | 21.292 | 1,406–1,508 |
| Drizzle | 87.746 [84.027–90.071] | 102.556 | — | 214–232 |
| Kysely | 14.801 [14.624–17.040] | 18.532 | 21.017 | 1,168–1,309 |

This scenario measures fresh query construction and synchronous SQL compilation for Symmetria, Drizzle and Kysely. Raw has no ORM compiler; Prisma has no equivalent public synchronous API. Prepared/cache-hit timings are excluded.

</details>

## Scope

One dataset size, mostly uniform relation density, warm cache and concurrency 1/16. Cold starts, WAN, HTTP serialization, sustained writes, transactions, skew and saturation curves are outside this run. Short fixed write budgets measure bursts, not steady-state ingestion capacity.

CPU quotas cap usage without reserving cores. Containers on macOS share the VM and host. Prepared Symmetria has three OFFSET cases only. Prisma query can fetch additional intermediate rows; normalization is only used by the correctness oracle, outside timing.
