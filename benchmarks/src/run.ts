import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { SQL } from "bun";
import { defaultConfig, integer } from "./config";
import { LIBRARIES, type Library } from "./adapters";
import { libraryOrder } from "./harness/workload";
import {
  createRun,
  hashFiles,
  provenance,
  saveSource,
  writeJson,
  type Manifest,
} from "./harness/artifacts";
import { database } from "./harness/database";
import { report } from "./report";

const config = defaultConfig();

if (process.argv[2]) {
  config.passes = integer("passes", process.argv[2]);
}

const libraries = (process.env.BENCH_LIBRARIES?.split(",") as
  | Library[]
  | undefined) ?? [...LIBRARIES];

if (
  !libraries.length ||
  new Set(libraries).size !== libraries.length ||
  libraries.some((library) => !LIBRARIES.includes(library))
) {
  throw new Error("invalid BENCH_LIBRARIES");
}

const adminUrl =
  process.env.BENCH_ADMIN_URL ??
  "postgres://bench:bench@127.0.0.1:55992/postgres";
const admin = new SQL(adminUrl, { max: 1 });
const { id, directory } = await createRun(
  resolve(process.env.BENCH_RESULTS ?? ".cache/runs"),
);
let manifest: Manifest | undefined;
let active: ReturnType<typeof Bun.spawn> | undefined;
const controller = new AbortController();

const stop = () => {
  controller.abort();
  active?.kill("SIGTERM");
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const worker = async (
  script: string,
  library: Library,
  args: string[],
  output: string,
): Promise<void> => {
  if (controller.signal.aborted) {
    throw new Error("run interrupted");
  }

  await database(adminUrl, async (url, dataset) => {
    if (manifest?.dataset) {
      assert.deepEqual(
        dataset,
        manifest.dataset,
        "seed differs between workers",
      );
    } else if (manifest) {
      manifest.dataset = dataset;
      await writeJson(join(directory, "manifest.json"), manifest);
    }

    const child = Bun.spawn(
      [process.execPath, script, library, ...args, join(directory, output)],
      {
        env: {
          ...process.env,
          BENCH_DATABASE_URL: url,
          BENCH_CONFIG: JSON.stringify(config),
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    active = child;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30 * 60 * 1000);

    try {
      const code = await child.exited;

      if (code !== 0 || controller.signal.aborted) {
        throw new Error(`${script}/${library} failed (${code})`);
      }

      if (!(await Bun.file(join(directory, output)).exists())) {
        throw new Error(`worker omitted ${output}`);
      }
    } finally {
      clearTimeout(timeout);
      active = undefined;
    }
  });
};

try {
  await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  // Fail before any timing if the server isn't configured for statement tracking.
  await admin.unsafe("SELECT count(*) FROM pg_stat_statements");
  manifest = {
    version: 1,
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    config,
    libraries,
    orders: Array.from({ length: config.passes }, (_, pass) =>
      libraryOrder(libraries, pass, config.orderSeed),
    ),
    environment: await provenance(admin),
    files: {},
  };
  await writeJson(join(directory, "manifest.json"), manifest);
  await saveSource(directory, manifest.environment.sourceFiles);
  console.log(`Run ${id}; all correctness gates precede timing`);

  for (const library of libraries) {
    await worker(
      "src/workers/verify.ts",
      library,
      [],
      `correctness-${library}.json`,
    );
  }

  for (const library of libraries) {
    await worker(
      "src/workers/explain.ts",
      library,
      [],
      `plans-${library}.json`,
    );
  }

  for (let pass = 0; pass < config.passes; pass++) {
    for (const library of manifest.orders[pass]!) {
      await worker(
        "src/workers/measure.ts",
        library,
        [String(pass)],
        `pass-${pass}-${library}.json`,
      );
    }
  }

  manifest.files = await hashFiles(directory);
  delete manifest.files["manifest.json"];
  manifest.status = "complete";
  manifest.finishedAt = new Date().toISOString();
  await writeJson(join(directory, "manifest.json"), manifest);
  await report(directory);
  console.log(`Complete: ${directory}/REPORT.md`);
} catch (error) {
  if (manifest) {
    manifest.status = "failed";
    manifest.error = String(error);
    manifest.finishedAt = new Date().toISOString();
    await writeJson(join(directory, "manifest.json"), manifest);
  } else {
    await writeJson(join(directory, "failure.json"), {
      id,
      status: "failed",
      config,
      error: String(error),
    });
  }

  throw error;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await admin.close();
}
