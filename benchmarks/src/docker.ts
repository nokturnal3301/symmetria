import { cpus, platform, release, totalmem } from "node:os";
import { mkdir } from "node:fs/promises";
import { digest } from "./harness/measure";

// Unique project names isolate parallel invocations, including their disk volumes.
const project = `symmetria-bench-${crypto.randomUUID().slice(0, 8)}`;
const env = { ...process.env };

const capture = async (args: string[]) => {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();

  if (await child.exited) {
    throw new Error(`${args.join(" ")}: ${error}`);
  }

  return text.trim();
};

let active: ReturnType<typeof Bun.spawn> | undefined;

const stop = () => active?.kill("SIGTERM");

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const compose = async (...args: string[]) => {
  active = Bun.spawn(
    ["docker", "compose", "-p", project, "-f", "docker/compose.yaml", ...args],
    { env, stdout: "inherit", stderr: "inherit" },
  );
  const code = await active.exited;
  active = undefined;

  if (code) {
    throw new Error(`docker compose ${args.join(" ")} exited ${code}`);
  }
};

try {
  await mkdir(".cache/runs", { recursive: true });
  await compose("build", "runner");
  await compose("up", "-d", "--wait", "postgres");
  const revision = await capture(["git", "rev-parse", "HEAD"]);
  const diff = await capture([
    "git",
    "-C",
    "..",
    "diff",
    "HEAD",
    "--",
    "packages/runtime",
    "benchmarks",
    "tsconfig.json",
  ]);
  const status = await capture(["git", "status", "--porcelain"]);
  const postgresId = await capture([
    "docker",
    "compose",
    "-p",
    project,
    "-f",
    "docker/compose.yaml",
    "ps",
    "-q",
    "postgres",
  ]);
  const [database] = JSON.parse(
    await capture(["docker", "inspect", postgresId]),
  );
  const [runner] = JSON.parse(
    await capture(["docker", "image", "inspect", `${project}-runner`]),
  );
  const info = JSON.parse(
    await capture(["docker", "info", "--format", "{{json .}}"]),
  );
  env.BENCH_HOST_PROVENANCE = JSON.stringify({
    revision,
    dirty: status.length > 0,
    diffHash: digest(diff),
    os: platform(),
    kernel: release(),
    cpu: cpus()[0]?.model,
    cpus: cpus().length,
    memoryBytes: totalmem(),
    docker: {
      version: info.ServerVersion,
      kernel: info.KernelVersion,
      os: info.OperatingSystem,
      arch: info.Architecture,
      cpus: info.NCPU,
      memoryBytes: info.MemTotal,
      storageDriver: info.Driver,
      cgroupVersion: info.CgroupVersion,
    },
    images: { runner: runner.Id, postgres: database.Image },
    databaseLimits: {
      cpuNano: database.HostConfig.NanoCpus,
      memoryBytes: database.HostConfig.Memory,
    },
    composeHash: digest(await Bun.file("docker/compose.yaml").text()),
  });
  await compose("run", "--rm", "-T", "runner");
} finally {
  await compose("down", "--volumes", "--remove-orphans");
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
