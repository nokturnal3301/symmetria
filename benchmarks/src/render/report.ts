import type { Manifest } from "../harness/artifacts";
import type { Summary, SummaryRow } from "../harness/summary";
import type { Scenario } from "../harness/workload";

const titles: Record<Scenario, string> = {
  pointLookup: "Point lookup",
  listJoin: "List + author JOIN",
  nestedFirst: "Nested · first page",
  nestedMiddle: "Nested · OFFSET 1000",
  nestedDeep: "Nested · OFFSET 1900",
  nestedKeyset: "Nested · keyset",
  insertOne: "INSERT · one row",
  insertMany500: "INSERT · 500 rows",
  updateViews: "UPDATE · bigint increment",
  buildNested: "Build + compile · nested query",
};
const descriptions: Record<Scenario, string> = {
  pointLookup: "One user by primary key; deterministic ID stream.",
  listJoin: "20 published posts with their author; created_at DESC, id DESC.",
  nestedFirst: "50 users × up to 3 posts × tags; OFFSET 0.",
  nestedMiddle:
    "Same shape, OFFSET 1000. Tests SQL-plan sensitivity to page depth.",
  nestedDeep:
    "Same shape, OFFSET 1900. Compare with page-first raw and keyset to distinguish plan cost from client overhead.",
  nestedKeyset:
    "50 users × up to 3 posts × tags; users.id > 1900. No 1900-parent OFFSET discard.",
  insertOne:
    "One row with RETURNING id; 256 sequential operations and 64 per concurrent worker.",
  insertMany500:
    "500 rows without RETURNING; 32 sequential batches and 4 per worker. One operation is one 500-row batch.",
  updateViews:
    "Atomic views = views + 1 with RETURNING views; 512 sequential operations and 128 per worker.",
  buildNested:
    "Fresh builder and SQL per operation, without database I/O or await. Each sample averages 100 builds; includes construction, not just compilation.",
};

const fixed = (value: number) => value.toFixed(3);

const count = (value: number) => Math.round(value).toLocaleString("en-US");

const range = (middle: number, low: number, high: number, format = fixed) =>
  `${format(middle)} [${format(low)}–${format(high)}]`;

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");

export const overviewTable = (summary: Summary): string => {
  const columns = [
    "pointLookup",
    "listJoin",
    "nestedKeyset",
    "insertOne",
    "insertMany500",
    "updateViews",
  ] as const;

  return [
    "| Adapter | Point | List + JOIN | Nested keyset | INSERT 1 | INSERT 500 | UPDATE |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.pointLookup.map(
      (row) =>
        `| ${row.name} | ${columns
          .map((scenario) => {
            const value = summary[scenario].find(
              (candidate) => candidate.library === row.library,
            );

            return value ? fixed(value.p50Ms) : "—";
          })
          .join(" | ")} |`,
    ),
  ].join("\n");
};

export const markdown = (
  manifest: Manifest,
  summary: Summary,
  options: { standalone?: boolean } = {},
): string => {
  const env = manifest.environment;
  const lines = [
    "# PostgreSQL benchmark · results",
    "",
    options.standalone
      ? "Evidence: manifest.json · source/ · pass-*.json · plans-*.json"
      : "[Run and methodology](../README.md) · [Data and checksums](summary.json) · [Download raw evidence](data.tar.gz)",
    "",
    `**${manifest.config.passes} independent passes · ${manifest.libraries.length} adapters · one complete run.**`,
    `Run: \`${manifest.id}\`. All numbers are recomputed from this run's verified raw samples.`,
    "",
    `![Every pass: keyset latency, bulk INSERT, point throughput and client construction](${options.standalone ? "chart.svg" : "../../docs/assets/benchmarks.svg"})`,
    "",
    "## Common operations",
    "",
    "Median sequential p50 across passes, **ms/op; lower is better**. INSERT 500 uses ms/batch. Includes build, bind, execute and decode.",
    "",
    overviewTable(summary),
    "",
    "A warm synthetic workload, with latency, throughput, SQL-plan sensitivity and client construction reported separately.",
    "",
    "## Reading the results",
    "",
    "- **p50 [min–max]**: median of process p50s and their full range. Dots show individual passes; lines show min–max, not a confidence interval.",
    "- **p95 / p99**: median process percentiles, omitted below 100 / 1000 samples in any pass. Bulk INSERT has 32 sequential samples per pass, so its tails are omitted.",
    `- **Throughput ×${manifest.config.concurrency}**: completed application operations / actual wall time, including in-flight drain. Closed-loop load, not a fixed arrival-rate test.`,
    "- **SQL/op** is measured sequentially. Prisma supports concurrent unique-lookup batching; throughput counts application operations, not SQL statements.",
    "- Adapter order changes between measurement passes. No passes or outliers are discarded. Identical raw operations outside nested queries provide an additional indication of noise.",
    "",
    "## Environment",
    "",
    "| Setting | Value |",
    "| --- | --- |",
    `| Runtime | Bun ${env.bun} · ${env.platform}/${env.arch} |`,
    `| Host / VM | ${env.host?.cpu ?? env.cpu ?? "unknown"} / ${env.host?.docker?.os ?? "unspecified"} |`,
    `| Runner cgroup | CPU quota \`${env.cgroup.cpuMax}\`; RAM \`${env.cgroup.memoryMax}\` bytes |`,
    `| Read phase | ≥ ${manifest.config.sequentialMs} ms and ${manifest.config.minimumSamples} samples; concurrent ≥ ${manifest.config.concurrentMs} ms |`,
    `| Pool / concurrency | 16 / ${manifest.config.concurrency} |`,
    `| Dataset | ${Object.entries(manifest.dataset ?? {})
      .map(([name, data]) => `${name}: ${count(data.rows)}`)
      .join("; ")} |`,
    `| Dependencies | ${Object.entries(env.versions)
      .map(([name, version]) => `${name} ${version}`)
      .join("; ")} |`,
    "",
    `PostgreSQL: ${env.postgres}. Full settings, durability, image IDs and hashes are in \`manifest.json\`. Source SHA-256: \`${env.sourceHash}\`.`,
    "",
    "Prisma uses its official adapter-pg/node-postgres; other adapters use Bun.SQL (Kysely through this suite's dialect). This compares those stacks, including their driver costs. SQL and EXPLAIN ANALYZE are captured outside timing.",
    "",
  ];

  for (const [heading, scenarios] of [
    ["Reads", ["pointLookup", "listJoin", "nestedFirst", "nestedKeyset"]],
    ["Writes", ["insertOne", "insertMany500", "updateViews"]],
    ["Plan experiment: OFFSET depth", ["nestedMiddle", "nestedDeep"]],
    ["Client only", ["buildNested"]],
  ] as const) {
    lines.push(`## ${heading}`, "");

    if (scenarios[0] === "nestedMiddle") {
      lines.push(
        "Direct LATERAL and page-first raw return the same data but limit parents at different stages. Kysely can also express page-first SQL. The OFFSET gap belongs to these specific query plans, not an intrinsic ORM or compiler speed ratio.",
        "",
      );
    }

    for (const scenario of scenarios) {
      const compiler = scenario === "buildNested";
      const scale = compiler ? 1000 : 1;
      const unit = compiler
        ? "µs/build"
        : scenario === "insertMany500"
          ? "ms/batch"
          : "ms/op";
      lines.push(
        `<details>`,
        `<summary><strong>${titles[scenario]}</strong> · ${unit}</summary>`,
        "",
        descriptions[scenario],
        "",
        `| Adapter | p50 [min–max], ${unit} | p95 | p99 | samples/pass |`,
        "| --- | ---: | ---: | ---: | ---: |",
        ...summary[scenario].map(
          (row) =>
            `| ${row.name} | ${range(row.p50Ms * scale, row.p50MinMs * scale, row.p50MaxMs * scale)} | ${row.p95Ms === null ? "—" : fixed(row.p95Ms * scale)} | ${row.p99Ms === null ? "—" : fixed(row.p99Ms * scale)} | ${count(row.samplesMin)}–${count(row.samplesMax)} |`,
        ),
        "",
      );

      if (!compiler) {
        lines.push(
          `| Adapter | Sequential ${scenario === "insertMany500" ? "batches" : "ops"}/s | Concurrent ×${manifest.config.concurrency} [min–max] | SQL/op (seq) |`,
          "| --- | ---: | ---: | ---: |",
          ...summary[scenario].map(
            (row) =>
              `| ${row.name} | ${count(row.sequentialOps)} | ${range(row.concurrentOps!, row.concurrentMin!, row.concurrentMax!, count)} | ${row.statements!.toFixed(2)} |`,
          ),
          "",
        );
      } else {
        lines.push(
          "This scenario measures fresh query construction and synchronous SQL compilation for Symmetria, Drizzle and Kysely. Raw has no ORM compiler; Prisma has no equivalent public synchronous API. Prepared/cache-hit timings are excluded.",
          "",
        );
      }

      lines.push("</details>", "");
    }
  }

  lines.push(
    "## Scope",
    "",
    "One dataset size, mostly uniform relation density, warm cache and concurrency 1/16. Cold starts, WAN, HTTP serialization, sustained writes, transactions, skew and saturation curves are outside this run. Short fixed write budgets measure bursts, not steady-state ingestion capacity.",
    "",
    "CPU quotas cap usage without reserving cores. Containers on macOS share the VM and host. Prepared Symmetria has three OFFSET cases only. Prisma query can fetch additional intermediate rows; normalization is only used by the correctness oracle, outside timing.",
    "",
  );

  return lines.join("\n");
};

const colors: Record<string, string> = {
  symmetria: "#59bcff",
  "symmetria-prepared": "#90d3ff",
  kysely: "#aca0ff",
  drizzle: "#b9cf8b",
  "prisma-join": "#f68bda",
  "prisma-query": "#d6a3c9",
  raw: "#94a5b8",
  "raw-page-first": "#b7c6d6",
};
const names: Record<string, string> = {
  raw: "Bun.SQL · direct",
  "raw-page-first": "Bun.SQL · page first",
  symmetria: "Symmetria",
  drizzle: "Drizzle",
  kysely: "Kysely",
  "prisma-join": "Prisma · join",
  "prisma-query": "Prisma · query",
};

/** Fixed-order small multiples, linear zero-based axes and every pass visible. */
export const chart = (manifest: Manifest, summary: Summary): string => {
  const postgresVersion =
    /PostgreSQL ([\d.]+)/.exec(manifest.environment.postgres)?.[1] ?? "unknown";
  const settings = new Map(
    manifest.environment.settings.map(
      (setting: { name: string; setting: string }) => [
        setting.name,
        setting.setting,
      ],
    ),
  );
  const durable = ["fsync", "synchronous_commit", "full_page_writes"].every(
    (name) => settings.get(name) === "on",
  );
  const panels: {
    scenario: Scenario;
    title: string;
    subtitle: string;
    unit: string;
    values: (row: SummaryRow) => number[];
  }[] = [
    {
      scenario: "nestedKeyset",
      title: "Nested read · keyset",
      subtitle: "50 users × up to 3 posts × tags · lower is better",
      unit: "ms/op",
      values: (row) => row.p50PassesMs,
    },
    {
      scenario: "insertMany500",
      title: "Bulk INSERT · 500 rows",
      subtitle: "Durable writes · no RETURNING · lower is better",
      unit: "ms/batch",
      values: (row) => row.p50PassesMs,
    },
    {
      scenario: "pointLookup",
      title: `Point lookup · concurrency ${manifest.config.concurrency}`,
      subtitle: "Application operations, not SQL statements · higher is better",
      unit: "ops/s",
      values: (row) => row.concurrentPasses,
    },
    {
      scenario: "buildNested",
      title: "Build + compile · no database",
      subtitle: "Fresh query each time · 100 builds/sample · lower is better",
      unit: "µs/build",
      values: (row) => row.p50PassesMs.map((value) => value * 1000),
    },
  ];
  const output = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1000" viewBox="0 0 1280 1000" role="img" aria-labelledby="title description">',
    '<title id="title">Symmetria PostgreSQL benchmark: latency, throughput and query construction</title>',
    `<desc id="description">${xml(manifest.id)}. Dots show every pass; lines show min to max, never a confidence interval. Each panel has its own zero-based linear scale. Full accessible tables are in benchmarks/report/README.md.</desc>`,
    '<defs><linearGradient id="bg"><stop stop-color="#080e1d"/><stop offset=".55" stop-color="#101027"/><stop offset="1" stop-color="#160d20"/></linearGradient></defs>',
    '<rect width="1280" height="1000" rx="24" fill="url(#bg)"/>',
    '<g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif" fill="#e7edf8">',
    '<text x="38" y="49" font-size="14" letter-spacing="3" fill="#59bcff">SYMMETRIA / BENCHMARKS</text>',
    '<text x="38" y="91" font-size="30" font-weight="650">One workload. Every pass. No overall score.</text>',
    `<text x="38" y="123" font-size="16" fill="#aebad0">Bun ${xml(manifest.environment.bun)} · PostgreSQL ${xml(postgresVersion)} · ${xml(manifest.environment.platform)}/${xml(manifest.environment.arch)} · ${manifest.config.passes} independent passes</text>`,
  ];

  for (const [panelIndex, panel] of panels.entries()) {
    const x = 24 + (panelIndex % 2) * 624;
    const y = 150 + Math.floor(panelIndex / 2) * 374;
    const left = x + 170;
    const plotWidth = 278;
    const rows = summary[panel.scenario];
    const max = Math.max(0.001, ...rows.flatMap(panel.values));
    const magnitude = 10 ** Math.floor(Math.log10(max));
    const ceiling = Math.ceil(max / magnitude) * magnitude;

    const position = (value: number) => left + (value / ceiling) * plotWidth;

    output.push(
      `<rect x="${x}" y="${y}" width="608" height="358" rx="16" fill="#ffffff" fill-opacity=".025" stroke="#b8c7e0" stroke-opacity=".13"/>`,
      `<text x="${x + 18}" y="${y + 34}" font-size="21" font-weight="600">${xml(panel.title)}</text>`,
      `<text x="${x + 18}" y="${y + 60}" font-size="13" fill="#aebad0">${xml(panel.subtitle)}</text>`,
    );
    const plotBottom = y + 88 + Math.max(rows.length - 1, 2) * 31 + 18;

    if (!rows.length) {
      output.push(
        `<text x="${x + 18}" y="${y + 110}" font-size="14" fill="#aebad0">Not measured in this run</text>`,
      );
    }

    for (let tick = 0; tick <= 4; tick++) {
      const value = (ceiling * tick) / 4;
      const tickX = position(value);
      output.push(
        `<path d="M${tickX} ${y + 78}V${plotBottom}" stroke="#b8c7e0" stroke-opacity=".12"/>`,
        `<text x="${tickX}" y="${plotBottom + 20}" text-anchor="middle" font-size="11" fill="#aebad0">${panel.unit === "ops/s" ? `${value / 1000}k` : Number(value.toFixed(2))}</text>`,
      );
    }

    for (const [index, row] of rows.entries()) {
      const values = panel.values(row);
      const middle =
        panel.unit === "ops/s"
          ? row.concurrentOps!
          : row.p50Ms * (panel.unit === "µs/build" ? 1000 : 1);
      const rowY = y + 88 + index * 31;
      const color = colors[row.library]!;
      output.push(
        `<text x="${x + 18}" y="${rowY + 5}" font-size="13" fill="${color}">${xml(names[row.library] ?? row.name)}</text>`,
        `<path d="M${position(Math.min(...values))} ${rowY}H${position(Math.max(...values))}" stroke="${color}" stroke-width="2"/>`,
        ...values.map(
          (value, pass) =>
            `<circle cx="${position(value)}" cy="${rowY + (pass - (values.length - 1) / 2) * 3}" r="3" fill="${color}" fill-opacity=".65"><title>Pass ${pass + 1}: ${value.toFixed(3)} ${panel.unit}</title></circle>`,
        ),
        `<path d="M${position(middle)} ${rowY - 7}v14" stroke="${color}" stroke-width="2"/>`,
        `<text x="${x + 588}" y="${rowY + 5}" text-anchor="end" font-size="13" fill="${color}">${panel.unit === "ops/s" ? count(middle) : middle.toFixed(panel.unit === "µs/build" ? 1 : 3)}</text>`,
      );
    }

    output.push(
      `<text x="${x + 588}" y="${plotBottom + 20}" text-anchor="end" font-size="11" fill="#aebad0">${panel.unit}</text>`,
    );

    if (panel.scenario === "buildNested") {
      output.push(
        `<text x="${x + 18}" y="${y + 248}" font-size="13" fill="#aebad0">Raw: no query compiler. Prisma: no equivalent sync API.</text>`,
        `<text x="${x + 18}" y="${y + 272}" font-size="13" fill="#aebad0">Prepared OFFSET cases are in the full report.</text>`,
      );
    }
  }

  output.push(
    '<text x="38" y="927" font-size="13" fill="#aebad0">Dots = individual passes · tick = median · line = min–max · linear axes start at zero · each panel has its own scale</text>',
    `<text x="38" y="950" font-size="13" fill="#aebad0">Warm synthetic workload · ${count(manifest.dataset?.users?.rows ?? 0)} users / ${count(manifest.dataset?.posts?.rows ?? 0)} posts · durability ${durable ? "on" : "see manifest"} · environment + limits in full report</text>`,
    `<text x="38" y="975" font-size="12" fill="#7e90ac">Run ${xml(manifest.id)} · source ${manifest.environment.sourceHash.slice(0, 16)} · tables + raw samples: benchmarks/</text>`,
    "</g></svg>",
    "",
  );

  return output.join("\n");
};
