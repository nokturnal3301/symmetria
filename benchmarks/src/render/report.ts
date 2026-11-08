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
      : "[Run and methodology](../README.md) · [Data and checksums](summary.json)",
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
    "- **p50 [min–max]**: median of process p50s and their full range across passes, not a confidence interval.",
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
  // Layout: two columns of panels; text is sized to stay legible when GitHub
  // scales the image down to its content width.
  const width = 1600;
  const margin = 40;
  const gap = 24;
  const panelWidth = (width - margin * 2 - gap) / 2;
  const rowHeight = 40;
  const rowCount = Math.max(
    2,
    ...panels.map((panel) => summary[panel.scenario].length),
  );
  const panelHeight = 118 + rowCount * rowHeight + 44;
  const height = 200 + panelHeight * 2 + gap + 120;
  const labelWidth = 230;
  const valueWidth = 110;
  const plotWidth = panelWidth - 24 * 2 - labelWidth - valueWidth - 16;
  const output = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`,
    '<title id="title">Symmetria PostgreSQL benchmark: latency, throughput and query construction</title>',
    `<desc id="description">${xml(manifest.id)}. Bars show the median of all passes and the range beneath each value shows the slowest and fastest pass, never a confidence interval. Each panel has its own zero-based linear scale. Full accessible tables are in benchmarks/report/README.md.</desc>`,
    '<defs><linearGradient id="bg"><stop stop-color="#080e1d"/><stop offset=".55" stop-color="#101027"/><stop offset="1" stop-color="#160d20"/></linearGradient></defs>',
    `<rect width="${width}" height="${height}" rx="28" fill="url(#bg)"/>`,
    '<g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif" fill="#e7edf8">',
    `<text x="${margin + 8}" y="58" font-size="17" letter-spacing="4" fill="#59bcff">SYMMETRIA / BENCHMARKS</text>`,
    `<text x="${margin + 8}" y="112" font-size="40" font-weight="650">One workload. Every pass. No overall score.</text>`,
    `<text x="${margin + 8}" y="152" font-size="20" fill="#aebad0">Bun ${xml(manifest.environment.bun)} · PostgreSQL ${xml(postgresVersion)} · ${xml(manifest.environment.platform)}/${xml(manifest.environment.arch)} · ${manifest.config.passes} independent passes · 2 CPUs / 2 GiB per container</text>`,
  ];

  for (const [panelIndex, panel] of panels.entries()) {
    const x = margin + (panelIndex % 2) * (panelWidth + gap);
    const y = 200 + Math.floor(panelIndex / 2) * (panelHeight + gap);
    const left = x + 24 + labelWidth;
    const rows = summary[panel.scenario];
    const max = Math.max(0.001, ...rows.flatMap(panel.values));
    const magnitude = 10 ** Math.floor(Math.log10(max));
    const ceiling = Math.ceil(max / magnitude) * magnitude;

    const position = (value: number) => left + (value / ceiling) * plotWidth;

    output.push(
      `<rect x="${x}" y="${y}" width="${panelWidth}" height="${panelHeight}" rx="20" fill="#ffffff" fill-opacity=".025" stroke="#b8c7e0" stroke-opacity=".13"/>`,
      `<text x="${x + 24}" y="${y + 44}" font-size="26" font-weight="600">${xml(panel.title)}</text>`,
      `<text x="${x + 24}" y="${y + 74}" font-size="16" fill="#aebad0">${xml(panel.subtitle)}</text>`,
    );
    const plotTop = y + 100;
    const plotBottom = plotTop + Math.max(rows.length, 2) * rowHeight;

    if (!rows.length) {
      output.push(
        `<text x="${x + 24}" y="${plotTop + 24}" font-size="16" fill="#aebad0">Not measured in this run</text>`,
      );
    }

    for (let tick = 0; tick <= 4; tick++) {
      const value = (ceiling * tick) / 4;
      const tickX = position(value);
      output.push(
        `<path d="M${tickX} ${plotTop - 6}V${plotBottom}" stroke="#b8c7e0" stroke-opacity=".12"/>`,
        `<text x="${tickX}" y="${plotBottom + 24}" text-anchor="middle" font-size="14" fill="#aebad0">${panel.unit === "ops/s" ? `${value / 1000}k` : Number(value.toFixed(2))}</text>`,
      );
    }

    for (const [index, row] of rows.entries()) {
      const values = panel.values(row);
      const middle =
        panel.unit === "ops/s"
          ? row.concurrentOps!
          : row.p50Ms * (panel.unit === "µs/build" ? 1000 : 1);
      const rowY = plotTop + index * rowHeight + rowHeight / 2;
      const color = colors[row.library]!;
      const barColor = `${color}`;
      output.push(
        `<text x="${x + 24}" y="${rowY + 6}" font-size="17" fill="${color}">${xml(names[row.library] ?? row.name)}</text>`,
        `<rect x="${left}" y="${rowY - 7}" width="${plotWidth}" height="14" rx="4" fill="${barColor}" fill-opacity=".06"/>`,
        `<rect x="${left}" y="${rowY - 7}" width="${Math.max(3, position(middle) - left)}" height="14" rx="4" fill="${barColor}" fill-opacity=".55"/>`,
        `<text x="${x + panelWidth - 24}" y="${rowY + 1}" text-anchor="end" font-size="17" font-weight="600" fill="${color}">${panel.unit === "ops/s" ? count(middle) : middle.toFixed(panel.unit === "µs/build" ? 1 : 3)}</text>`,
        `<text x="${x + panelWidth - 24}" y="${rowY + 16}" text-anchor="end" font-size="11" fill="#8f9bb8">${panel.unit === "ops/s" ? `${count(Math.min(...values))} – ${count(Math.max(...values))}` : `${Math.min(...values).toFixed(panel.unit === "µs/build" ? 1 : 3)} – ${Math.max(...values).toFixed(panel.unit === "µs/build" ? 1 : 3)}`}</text>`,
      );
    }

    output.push(
      `<text x="${x + panelWidth - 24}" y="${plotBottom + 24}" text-anchor="end" font-size="14" fill="#aebad0">${panel.unit}</text>`,
    );

    if (panel.scenario === "buildNested") {
      output.push(
        `<text x="${x + 24}" y="${plotBottom + 62}" font-size="15" fill="#aebad0">Raw: no query compiler. Prisma: no equivalent sync API.</text>`,
        `<text x="${x + 24}" y="${plotBottom + 86}" font-size="15" fill="#aebad0">Prepared OFFSET cases are in the full report.</text>`,
      );
    }
  }

  const footer = height - 76;
  output.push(
    `<text x="${margin + 8}" y="${footer}" font-size="16" fill="#aebad0">Bar = median of the passes · small range = slowest and fastest pass · linear axes start at zero · each panel has its own scale</text>`,
    `<text x="${margin + 8}" y="${footer + 26}" font-size="16" fill="#aebad0">Warm synthetic workload · ${count(manifest.dataset?.users?.rows ?? 0)} users / ${count(manifest.dataset?.posts?.rows ?? 0)} posts · durability ${durable ? "on" : "see manifest"} · environment and limits in the full report</text>`,
    `<text x="${margin + 8}" y="${footer + 52}" font-size="14" fill="#7e90ac">Run ${xml(manifest.id)} · source ${manifest.environment.sourceHash.slice(0, 16)} · tables + raw samples: benchmarks/</text>`,
    "</g></svg>",
    "",
  );

  return output.join("\n");
};
