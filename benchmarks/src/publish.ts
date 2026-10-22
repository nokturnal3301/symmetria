import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { LIBRARIES } from "./adapters";
import { validateRun } from "./report";
import { summarize } from "./harness/summary";
import { markdown, chart } from "./render/report";
import { digest } from "./harness/measure";
import { writeJson, type Manifest } from "./harness/artifacts";

export const assertPublishable = (manifest: Manifest): void => {
  assert.deepEqual(
    [...manifest.libraries].sort(),
    [...LIBRARIES].sort(),
    "publication requires every adapter from one run",
  );
  assert.ok(
    manifest.config.passes >= 3 &&
      manifest.config.sequentialMs >= 2000 &&
      manifest.config.concurrentMs >= 2000 &&
      manifest.config.minimumSamples >= 100,
    "pipeline checks are not publishable measurements",
  );
  assert.equal(manifest.environment.platform, "linux");
  assert.equal(manifest.environment.cgroup.cpuMax, "200000 100000");
  assert.equal(manifest.environment.cgroup.memoryMax, "2147483648");
  assert.ok(
    manifest.environment.host?.images?.runner &&
      manifest.environment.host?.images?.postgres,
    "container image provenance required",
  );
  assert.equal(manifest.environment.host.databaseLimits.cpuNano, 2_000_000_000);
  assert.equal(
    manifest.environment.host.databaseLimits.memoryBytes,
    2_147_483_648,
  );

  for (const name of ["fsync", "synchronous_commit", "full_page_writes"]) {
    assert.equal(
      manifest.environment.settings.find((setting) => setting.name === name)
        ?.setting,
      "on",
      `${name} must be on`,
    );
  }
};

const command = async (args: string[]) => {
  const child = Bun.spawn(args, {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await child.exited, 0, `${args[0]} failed`);
};

const publish = async (directory: string) => {
  const root = resolve(import.meta.dir, "../..");
  const benchmark = join(root, "benchmarks");
  const { manifest, runs } = await validateRun(directory);
  assertPublishable(manifest);
  assert.equal(basename(directory), manifest.id);
  assert.match(manifest.id, /^[\w-]+$/);
  const summary = summarize(manifest, runs);
  const svg = chart(manifest, summary);
  const results = markdown(manifest, summary);
  const output = join(benchmark, "report");
  await mkdir(output, { recursive: true });
  await mkdir(join(benchmark, ".cache"), { recursive: true });
  const staging = await mkdtemp(join(benchmark, ".cache/publication-"));
  const archive = join(output, "data.tar.gz");

  try {
    // Preserve every hashed measurement/source byte; regenerate only derived documents.
    const snapshot = join(staging, manifest.id);

    for (const file of ["manifest.json", ...Object.keys(manifest.files)]) {
      await mkdir(dirname(join(snapshot, file)), { recursive: true });
      await copyFile(join(directory, file), join(snapshot, file));
    }

    await Bun.write(
      join(snapshot, "REPORT.md"),
      markdown(manifest, summary, { standalone: true }),
    );
    await Bun.write(join(snapshot, "chart.svg"), svg);
    await writeJson(join(snapshot, "summary.json"), summary);
    await command([
      "tar",
      "-czf",
      `${archive}.tmp`,
      "-C",
      staging,
      manifest.id,
    ]);
    const extracted = join(staging, "verify");
    await mkdir(extracted);
    await command(["tar", "-xzf", `${archive}.tmp`, "-C", extracted]);
    const checked = await validateRun(join(extracted, manifest.id));
    assert.deepEqual(checked.manifest, manifest);
    assert.deepEqual(summarize(checked.manifest, checked.runs), summary);
    await rename(`${archive}.tmp`, archive);
    const renderer: Record<string, string> = {};

    for (const file of [
      "src/publish.ts",
      "src/report.ts",
      "src/harness/summary.ts",
      "src/render/report.ts",
      "src/render/animate.py",
    ]) {
      renderer[file] = digest(await Bun.file(join(benchmark, file)).text());
    }

    await Bun.write(join(output, "README.md"), results);
    await Bun.write(join(root, "docs/assets/benchmarks.svg"), svg);
    const generated: Record<string, string> = {
      "report/README.md": digest(results),
      "docs/assets/benchmarks.svg": digest(svg),
    };
    const publication = {
      run: manifest.id,
      environment: {
        bun: manifest.environment.bun,
        postgres: manifest.environment.postgres,
        arch: manifest.environment.arch,
        host: manifest.environment.host.cpu,
        vm: manifest.environment.host.docker.os,
        passes: manifest.config.passes,
      },
      sourceHash: manifest.environment.sourceHash,
      manifestHash: digest(
        await Bun.file(join(directory, "manifest.json")).text(),
      ),
      archive: "data.tar.gz",
      archiveBytes: Bun.file(archive).size,
      archiveSha256: createHash("sha256")
        .update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
        .digest("hex"),
      renderer,
      generated,
      summary,
    };
    await writeJson(join(output, "summary.json"), publication);
    await command(["python3", join(benchmark, "src/render/animate.py")]);
    generated["docs/assets/benchmarks.gif"] = createHash("sha256")
      .update(
        new Uint8Array(
          await Bun.file(
            join(root, "docs/assets/benchmarks.gif"),
          ).arrayBuffer(),
        ),
      )
      .digest("hex");
    await writeJson(join(output, "summary.json"), publication);
    const readmePath = join(root, "README.md");
    const readme = await Bun.file(readmePath).text();
    const marker = /<!-- benchmark:start -->[\s\S]*?<!-- benchmark:end -->/;
    assert.ok(marker.test(readme), "README benchmark markers missing");
    const snippet = [
      "<!-- benchmark:start -->",
      '<a href="benchmarks/report/README.md">',
      "  <picture>",
      '    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/benchmarks.svg">',
      '    <img src="docs/assets/benchmarks.gif" width="1280" alt="Measured PostgreSQL benchmarks: nested reads, bulk INSERT, concurrent lookups and query construction. All adapters and per-pass ranges are shown.">',
      "  </picture>",
      "</a>",
      "",
      `Bun ${manifest.environment.bun} · PostgreSQL 16.10 · Linux/${manifest.environment.arch} · ${manifest.environment.host.cpu} / ${manifest.environment.host.docker.os}.`,
      `${manifest.config.passes} passes; 2 CPUs / 2 GiB per container; durable storage. Medians and full pass ranges.`,
      "",
      "[Results](benchmarks/report/README.md) · [Reproduce](benchmarks/README.md) · [Raw data + source](benchmarks/report/data.tar.gz) · [Static chart](docs/assets/benchmarks.svg)",
      "<!-- benchmark:end -->",
    ].join("\n");
    await Bun.write(readmePath, readme.replace(marker, snippet));
    console.log(
      `Published ${manifest.id}: ${Object.keys(manifest.files).length} verified artifacts, English report and animated results.`,
    );
  } finally {
    await rm(staging, { recursive: true });
    await rm(`${archive}.tmp`, { force: true });
  }
};

if (import.meta.main) {
  if (!process.argv[2]) {
    throw new Error("usage: bun run publish .cache/runs/<complete-run-id>");
  }

  await publish(resolve(process.argv[2]));
}
