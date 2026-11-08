# PostgreSQL benchmark · results

[Run and methodology](../README.md) · [Data and checksums](summary.json)

**5 independent passes · 8 adapters · one complete run.**
Run: `2026-11-07T23-32-25-703Z-0ab827d4`. All numbers are recomputed from this run's verified raw samples.

![Every pass: keyset latency, bulk INSERT, point throughput and client construction](../../docs/assets/benchmarks.svg)

## Common operations

Median sequential p50 across passes, **ms/op; lower is better**. INSERT 500 uses ms/batch. Includes build, bind, execute and decode.

| Adapter | Point | List + JOIN | Nested keyset | INSERT 1 | INSERT 500 | UPDATE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.011 | 0.082 | 0.990 | 0.492 | 4.145 | 0.512 |
| Bun.SQL (page first) | 0.011 | 0.083 | 0.998 | 0.538 | 3.955 | 0.517 |
| Symmetria | 0.018 | 0.110 | 1.003 | 0.526 | 4.614 | 0.546 |
| Drizzle | 0.021 | 0.137 | 1.235 | 0.535 | 7.325 | 0.536 |
| Kysely | 0.016 | 0.128 | 0.940 | 0.509 | 4.718 | 0.533 |
| Prisma (join) | 0.041 | 0.111 | 2.113 | 0.555 | 19.542 | 0.592 |
| Prisma (query) | 0.040 | 0.129 | 1.757 | 0.550 | 19.010 | 0.574 |

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
| Pool / concurrency | 16 / 16 |
| Dataset | users: 2,000; posts: 40,000; tags: 100; post_tags: 109,747 |
| Dependencies | drizzle-orm 0.45.4; kysely 0.29.7; @prisma/client 7.10.1; @prisma/adapter-pg 7.10.1; pg 8.23.1 |

PostgreSQL: PostgreSQL 16.10 (Debian 16.10-1.pgdg12+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit. Full settings, durability, image IDs and hashes are in `manifest.json`. Source SHA-256: `f90296f7f4022a5e3de8fa815fd307354c983ec857cc070535c4bc2ba87510c1`.

Prisma uses its official adapter-pg/node-postgres; other adapters use Bun.SQL (Kysely through this suite's dialect). This compares those stacks, including their driver costs. SQL and EXPLAIN ANALYZE are captured outside timing.

## Reads

<details>
<summary><strong>Point lookup</strong> · ms/op</summary>

One user by primary key; deterministic ID stream.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.011 [0.011–0.012] | 0.045 | 0.049 | 112,758–159,256 |
| Bun.SQL (page first) | 0.011 [0.011–0.012] | 0.025 | 0.048 | 116,501–149,528 |
| Symmetria | 0.018 [0.016–0.052] | 0.061 | 0.070 | 50,229–111,082 |
| Drizzle | 0.021 [0.020–0.054] | 0.062 | 0.071 | 48,492–94,002 |
| Kysely | 0.016 [0.015–0.017] | 0.052 | 0.063 | 72,358–120,736 |
| Prisma (join) | 0.041 [0.039–0.085] | 0.094 | 0.109 | 27,704–41,889 |
| Prisma (query) | 0.040 [0.037–0.085] | 0.092 | 0.106 | 26,954–48,165 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 63,531 | 87,423 [82,608–88,763] | 1.00 |
| Bun.SQL (page first) | 73,793 | 86,785 [47,662–87,985] | 1.00 |
| Symmetria | 37,183 | 43,193 [33,051–44,623] | 1.00 |
| Drizzle | 36,473 | 36,510 [35,169–37,508] | 1.00 |
| Kysely | 46,063 | 50,639 [48,412–51,735] | 1.00 |
| Prisma (join) | 18,838 | 92,563 [84,251–109,763] | 1.00 |
| Prisma (query) | 19,550 | 98,738 [77,959–101,363] | 1.00 |

</details>

<details>
<summary><strong>List + author JOIN</strong> · ms/op</summary>

20 published posts with their author; created_at DESC, id DESC.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.082 [0.037–0.086] | 0.092 | 0.101 | 23,639–40,708 |
| Bun.SQL (page first) | 0.083 [0.038–0.085] | 0.094 | 0.104 | 14,394–36,370 |
| Symmetria | 0.110 [0.102–0.112] | 0.128 | 0.165 | 16,822–20,952 |
| Drizzle | 0.137 [0.103–0.144] | 0.153 | 0.318 | 13,842–17,059 |
| Kysely | 0.128 [0.122–0.131] | 0.167 | 0.390 | 14,281–16,721 |
| Prisma (join) | 0.111 [0.108–0.153] | 0.178 | 0.219 | 13,650–16,369 |
| Prisma (query) | 0.129 [0.123–0.216] | 0.234 | 0.318 | 10,044–15,019 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 12,906 | 30,665 [25,485–34,025] | 1.00 |
| Bun.SQL (page first) | 13,549 | 28,010 [25,963–32,150] | 1.00 |
| Symmetria | 9,528 | 20,632 [18,801–20,864] | 1.00 |
| Drizzle | 7,139 | 20,549 [17,839–21,038] | 1.00 |
| Kysely | 7,513 | 16,176 [13,125–20,160] | 1.00 |
| Prisma (join) | 7,823 | 19,404 [18,652–19,679] | 1.00 |
| Prisma (query) | 6,530 | 9,595 [8,880–9,806] | 2.00 |

</details>

<details>
<summary><strong>Nested · first page</strong> · ms/op</summary>

50 users × up to 3 posts × tags; OFFSET 0.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1.060 [1.057–1.136] | 1.176 | 1.374 | 1,357–1,865 |
| Bun.SQL (page first) | 1.011 [1.000–1.040] | 1.122 | 1.258 | 1,794–1,981 |
| Symmetria | 1.091 [1.084–1.176] | 1.310 | 1.591 | 1,645–1,796 |
| Symmetria (prepared) | 0.943 [0.930–1.033] | 1.022 | 1.181 | 1,567–2,118 |
| Drizzle | 1.272 [1.262–1.433] | 1.594 | 1.937 | 1,322–1,525 |
| Kysely | 1.019 [1.008–1.226] | 1.145 | 1.352 | 1,190–1,944 |
| Prisma (join) | 2.119 [2.113–2.238] | 2.460 | — | 864–934 |
| Prisma (query) | 1.816 [1.704–2.236] | 2.832 | — | 768–1,084 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 930 | 824 [767–986] | 1.00 |
| Bun.SQL (page first) | 972 | 993 [902–1,147] | 1.00 |
| Symmetria | 889 | 1,291 [1,222–1,311] | 1.00 |
| Symmetria (prepared) | 1,046 | 1,236 [1,198–1,433] | 1.00 |
| Drizzle | 753 | 1,388 [1,153–1,572] | 1.00 |
| Kysely | 948 | 1,091 [986–1,163] | 1.00 |
| Prisma (join) | 461 | 578 [540–605] | 1.00 |
| Prisma (query) | 517 | 597 [478–610] | 4.00 |

</details>

<details>
<summary><strong>Nested · keyset</strong> · ms/op</summary>

50 users × up to 3 posts × tags; users.id > 1900. No 1900-parent OFFSET discard.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.990 [0.976–1.021] | 1.114 | 1.308 | 1,849–2,019 |
| Bun.SQL (page first) | 0.998 [0.991–1.060] | 1.123 | 1.383 | 1,626–1,976 |
| Symmetria | 1.003 [0.992–1.052] | 1.196 | 1.497 | 1,821–1,975 |
| Drizzle | 1.235 [1.220–1.349] | 1.540 | 1.942 | 1,408–1,585 |
| Kysely | 0.940 [0.934–1.014] | 1.060 | 1.242 | 1,745–2,106 |
| Prisma (join) | 2.113 [2.087–2.145] | 2.527 | — | 884–927 |
| Prisma (query) | 1.757 [1.744–1.985] | 2.767 | — | 912–1,068 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 975 | 995 [975–1,257] | 1.00 |
| Bun.SQL (page first) | 982 | 1,011 [946–1,113] | 1.00 |
| Symmetria | 960 | 1,562 [1,469–1,612] | 1.00 |
| Drizzle | 774 | 1,495 [1,411–1,678] | 1.00 |
| Kysely | 1,042 | 1,268 [1,240–1,472] | 1.00 |
| Prisma (join) | 462 | 644 [603–660] | 1.00 |
| Prisma (query) | 532 | 596 [576–632] | 4.00 |

</details>

## Writes

<details>
<summary><strong>INSERT · one row</strong> · ms/op</summary>

One row with RETURNING id; 256 sequential operations and 64 per concurrent worker.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.492 [0.485–0.598] | 0.600 | — | 256–256 |
| Bun.SQL (page first) | 0.538 [0.495–0.686] | 0.630 | — | 256–256 |
| Symmetria | 0.526 [0.524–0.577] | 0.671 | — | 256–256 |
| Drizzle | 0.535 [0.532–0.885] | 0.675 | — | 256–256 |
| Kysely | 0.509 [0.500–0.531] | 0.632 | — | 256–256 |
| Prisma (join) | 0.555 [0.543–0.706] | 0.734 | — | 256–256 |
| Prisma (query) | 0.550 [0.540–0.722] | 0.681 | — | 256–256 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1,987 | 15,473 [9,468–15,601] | 1.00 |
| Bun.SQL (page first) | 1,826 | 14,948 [11,645–15,969] | 1.00 |
| Symmetria | 1,835 | 13,785 [10,478–15,220] | 1.00 |
| Drizzle | 1,802 | 10,949 [6,878–14,534] | 1.00 |
| Kysely | 1,894 | 14,199 [12,726–15,338] | 1.00 |
| Prisma (join) | 1,727 | 12,148 [6,566–12,628] | 1.00 |
| Prisma (query) | 1,750 | 12,507 [11,945–13,603] | 1.00 |

</details>

<details>
<summary><strong>INSERT · 500 rows</strong> · ms/batch</summary>

500 rows without RETURNING; 32 sequential batches and 4 per worker. One operation is one 500-row batch.

| Adapter | p50 [min–max], ms/batch | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 4.145 [3.812–5.171] | — | — | 32–32 |
| Bun.SQL (page first) | 3.955 [3.800–4.209] | — | — | 32–32 |
| Symmetria | 4.614 [4.548–4.911] | — | — | 32–32 |
| Drizzle | 7.325 [7.281–8.445] | — | — | 32–32 |
| Kysely | 4.718 [4.150–5.140] | — | — | 32–32 |
| Prisma (join) | 19.542 [18.522–20.598] | — | — | 32–32 |
| Prisma (query) | 19.010 [18.847–20.590] | — | — | 32–32 |

| Adapter | Sequential batches/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 239 | 441 [376–543] | 1.00 |
| Bun.SQL (page first) | 246 | 484 [423–509] | 1.00 |
| Symmetria | 214 | 436 [258–504] | 1.00 |
| Drizzle | 131 | 262 [230–263] | 1.00 |
| Kysely | 209 | 483 [319–496] | 1.00 |
| Prisma (join) | 49 | 62 [59–62] | 1.00 |
| Prisma (query) | 51 | 60 [54–63] | 1.00 |

</details>

<details>
<summary><strong>UPDATE · bigint increment</strong> · ms/op</summary>

Atomic views = views + 1 with RETURNING views; 512 sequential operations and 128 per worker.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 0.512 [0.488–0.652] | 0.696 | — | 512–512 |
| Bun.SQL (page first) | 0.517 [0.468–0.563] | 0.640 | — | 512–512 |
| Symmetria | 0.546 [0.535–0.579] | 0.687 | — | 512–512 |
| Drizzle | 0.536 [0.525–0.547] | 0.692 | — | 512–512 |
| Kysely | 0.533 [0.491–0.553] | 0.697 | — | 512–512 |
| Prisma (join) | 0.592 [0.549–0.741] | 0.828 | — | 512–512 |
| Prisma (query) | 0.574 [0.557–0.589] | 0.736 | — | 512–512 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 1,747 | 14,414 [14,256–15,398] | 1.00 |
| Bun.SQL (page first) | 1,874 | 14,984 [14,691–15,606] | 1.00 |
| Symmetria | 1,779 | 14,161 [13,533–14,491] | 1.00 |
| Drizzle | 1,751 | 13,748 [12,883–14,596] | 1.00 |
| Kysely | 1,789 | 14,560 [10,791–14,922] | 1.00 |
| Prisma (join) | 1,578 | 12,044 [9,576–12,136] | 1.00 |
| Prisma (query) | 1,667 | 12,378 [10,003–12,917] | 1.00 |

</details>

## Plan experiment: OFFSET depth

Direct LATERAL and page-first raw return the same data but limit parents at different stages. Kysely can also express page-first SQL. The OFFSET gap belongs to these specific query plans, not an intrinsic ORM or compiler speed ratio.

<details>
<summary><strong>Nested · OFFSET 1000</strong> · ms/op</summary>

Same shape, OFFSET 1000. Tests SQL-plan sensitivity to page depth.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 19.148 [18.619–20.543] | 21.271 | — | 100–106 |
| Bun.SQL (page first) | 1.056 [1.040–1.098] | 1.174 | 1.495 | 1,637–1,880 |
| Symmetria | 1.139 [1.121–1.206] | 1.400 | 1.748 | 1,586–1,729 |
| Symmetria (prepared) | 1.003 [1.002–1.046] | 1.096 | 1.247 | 1,824–1,974 |
| Drizzle | 21.452 [19.788–21.967] | 22.795 | — | 100–100 |
| Kysely | 17.624 [17.397–20.507] | 19.066 | — | 100–114 |
| Prisma (join) | 35.379 [35.072–37.077] | 38.911 | — | 100–100 |
| Prisma (query) | 1.956 [1.818–2.336] | 3.065 | — | 804–1,031 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 50 | 43 [37–48] | 1.00 |
| Bun.SQL (page first) | 927 | 943 [817–1,046] | 1.00 |
| Symmetria | 848 | 1,150 [1,066–1,270] | 1.00 |
| Symmetria (prepared) | 986 | 1,137 [1,071–1,142] | 1.00 |
| Drizzle | 46 | 35 [32–51] | 1.00 |
| Kysely | 56 | 42 [38–48] | 1.00 |
| Prisma (join) | 28 | 21 [20–22] | 1.00 |
| Prisma (query) | 467 | 573 [489–613] | 4.00 |

</details>

<details>
<summary><strong>Nested · OFFSET 1900</strong> · ms/op</summary>

Same shape, OFFSET 1900. Compare with page-first raw and keyset to distinguish plan cost from client overhead.

| Adapter | p50 [min–max], ms/op | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 35.494 [34.478–39.657] | 38.796 | — | 100–100 |
| Bun.SQL (page first) | 1.106 [1.101–1.171] | 1.373 | 1.807 | 1,637–1,779 |
| Symmetria | 1.191 [1.173–1.255] | 1.567 | 1.889 | 1,268–1,674 |
| Symmetria (prepared) | 1.044 [1.028–1.070] | 1.174 | 1.349 | 1,825–1,916 |
| Drizzle | 36.869 [36.667–39.336] | 40.927 | — | 100–100 |
| Kysely | 34.252 [31.940–35.979] | 37.789 | — | 100–100 |
| Prisma (join) | 64.915 [64.863–67.302] | 68.138 | — | 100–100 |
| Prisma (query) | 1.935 [1.841–2.160] | 2.963 | — | 865–1,016 |

| Adapter | Sequential ops/s | Concurrent ×16 [min–max] | SQL/op (seq) |
| --- | ---: | ---: | ---: |
| Bun.SQL (direct LATERAL) | 28 | 22 [20–26] | 1.00 |
| Bun.SQL (page first) | 851 | 846 [759–961] | 1.00 |
| Symmetria | 767 | 1,119 [1,087–1,210] | 1.00 |
| Symmetria (prepared) | 944 | 1,081 [1,063–1,110] | 1.00 |
| Drizzle | 26 | 20 [17–25] | 1.00 |
| Kysely | 29 | 25 [21–27] | 1.00 |
| Prisma (join) | 15 | 11 [10–11] | 1.00 |
| Prisma (query) | 481 | 592 [521–606] | 4.00 |

</details>

## Client only

<details>
<summary><strong>Build + compile · nested query</strong> · µs/build</summary>

Fresh builder and SQL per operation, without database I/O or await. Each sample averages 100 builds; includes construction, not just compilation.

| Adapter | p50 [min–max], µs/build | p95 | p99 | samples/pass |
| --- | ---: | ---: | ---: | ---: |
| Symmetria | 29.790 [28.492–37.285] | 36.416 | — | 453–702 |
| Drizzle | 85.130 [83.761–94.839] | 105.138 | — | 205–230 |
| Kysely | 15.412 [15.276–15.549] | 20.395 | 23.824 | 1,221–1,254 |

This scenario measures fresh query construction and synchronous SQL compilation for Symmetria, Drizzle and Kysely. Raw has no ORM compiler; Prisma has no equivalent public synchronous API. Prepared/cache-hit timings are excluded.

</details>

## Scope

One dataset size, mostly uniform relation density, warm cache and concurrency 1/16. Cold starts, WAN, HTTP serialization, sustained writes, transactions, skew and saturation curves are outside this run. Short fixed write budgets measure bursts, not steady-state ingestion capacity.

CPU quotas cap usage without reserving cores. Containers on macOS share the VM and host. Prepared Symmetria has three OFFSET cases only. Prisma query can fetch additional intermediate rows; normalization is only used by the correctness oracle, outside timing.
