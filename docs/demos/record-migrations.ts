import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { SQL } from "bun";

const root = resolve(import.meta.dir, "../..");

const run = async (command: string[], cwd = root, env = process.env) => {
  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return {
    stdout: stdout.replaceAll("\r\n", "\n").trimEnd(),
    stderr: stderr.replaceAll("\r\n", "\n").trimEnd(),
    exitCode,
    durationMs: Math.round(performance.now() - started),
  };
};

const checked = async (command: string[]) => {
  const result = await run(command);
  assert.equal(result.exitCode, 0, result.stderr);

  return result.stdout;
};

type Capture = Awaited<ReturnType<typeof run>> & { command: string };
type Scene = {
  title: string;
  subtitle: string;
  caption: string;
  commands: Capture[];
  hold: number;
};
type Demo = {
  id: string;
  label: string;
  accent: string;
  preview: number;
  scenes: Scene[];
};
const demos: Demo[] = [];
await mkdir(join(root, ".build"), { recursive: true });
const workspace = await mkdtemp(join(root, ".build/migration-record-"));
const container = `symmetria-record-${randomUUID().slice(0, 8)}`;
let started = false;
let admin: SQL | undefined;

try {
  await checked([
    "docker",
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_USER=symmetria",
    "-e",
    "POSTGRES_PASSWORD=symmetria",
    "-e",
    "POSTGRES_DB=demos",
    "-p",
    "127.0.0.1::5432",
    "postgres:16.10-bookworm",
  ]);
  started = true;
  let ready = false;

  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await run([
          "docker",
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "symmetria",
          "-d",
          "demos",
        ])
      ).exitCode === 0
    ) {
      ready = true;
      break;
    }

    await Bun.sleep(200);
  }

  assert(ready, "PostgreSQL did not become ready");
  const binding = await checked(["docker", "port", container, "5432/tcp"]);
  const address = `postgres://symmetria:symmetria@${binding}/demos`;
  admin = new SQL(address);
  const server = await admin<{ server_version: string }[]>`SHOW server_version`;
  const bin = join(workspace, "bin");
  await mkdir(bin);

  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

  await writeFile(
    join(bin, "symmetria"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "packages/kit/src/cli.ts"))} "$@"\n`,
  );
  await chmod(join(bin, "symmetria"), 0o755);

  const project = async (name: string, verifyData = false) => {
    const database = `symmetria_${name}`;
    await admin!.unsafe(`CREATE DATABASE "${database}"`);
    const url = new URL(address);
    url.pathname = `/${database}`;
    const directory = join(workspace, name);
    await mkdir(directory);
    await copyFile(
      join(import.meta.dir, "migration-fixture.ts"),
      join(directory, "data.ts"),
    );
    await writeFile(
      join(directory, "symmetria.config.ts"),
      'export { default } from "./data";\n',
    );
    await writeFile(
      join(directory, "rename.json"),
      JSON.stringify(
        { renames: { columns: { users: { email: "mail" } } } },
        null,
        2,
      ),
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TERM: "dumb",
      NO_COLOR: "1",
      MODEL: "base",
      DEMO_DATABASE_URL: url.toString(),
      DEMO_VERIFY_DATA: verifyData ? "1" : "",
    };

    const command = async (command: string, expected = 0): Promise<Capture> => {
      const result = await run(["sh", "-c", command], directory, env);
      assert.equal(
        result.exitCode,
        expected,
        `${command}\n${result.stdout}\n${result.stderr}`,
      );
      // Captures are public: neither the ephemeral URL nor machine paths belong in them.
      assert(!`${result.stdout}${result.stderr}`.includes(workspace));
      assert(!`${result.stdout}${result.stderr}`.includes(url.toString()));

      return { command, ...result };
    };

    await command("symmetria generate initial");
    await command("symmetria migrate");

    return command;
  };

  const safety = await project("safety");
  await safety("bun data.ts seed");
  demos.push({
    id: "migration-safety",
    label: "SAFE GENERATION",
    accent: "#bca4ff",
    preview: 1,
    scenes: [
      {
        title: "A rename deserves a decision.",
        subtitle:
          "An existing nullable column disappears. Generation stops before writing SQL.",
        caption: "The existing row is still there. No implicit DROP / ADD.",
        hold: 4.5,
        commands: [
          await safety("MODEL=renamed symmetria generate rename_email", 1),
          await safety("bun data.ts users"),
        ],
      },
      {
        title: "Make the rename explicit.",
        subtitle:
          "rename.json maps users.email to users.mail using physical SQL names.",
        caption: "The migration renames the column and keeps Ada's email.",
        hold: 4.5,
        commands: [
          await safety(
            "MODEL=renamed symmetria generate rename_email --diff rename.json",
          ),
          await safety("symmetria migrate"),
          await safety("bun data.ts users"),
        ],
      },
      {
        title: "Saved SQL stays under review.",
        subtitle:
          "An intentional removal is generated. Lint still checks its up.sql afterward.",
        caption:
          "The snapshot already matches the code. Lint still exits 1 for the pending DROP.",
        hold: 6,
        commands: [
          await safety(
            "MODEL=removed symmetria generate remove_mail --allow-destructive",
          ),
          await safety("MODEL=removed symmetria lint --pending", 1),
        ],
      },
    ],
  });

  const verification = await project("verification", true);
  await verification("bun data.ts seed");
  await verification("MODEL=active symmetria generate add_active");
  await verification("symmetria migrate");
  demos.push({
    id: "migration-verification",
    label: "VERIFY + DRIFT",
    accent: "#69c4ff",
    preview: 0,
    scenes: [
      {
        title: "Exercise the SQL on PostgreSQL.",
        subtitle:
          "Verify creates disposable databases and tests installation, upgrade and rollback.",
        caption:
          "Data hooks assert that an existing user survives up, down and reapplication.",
        hold: 5,
        commands: [
          await verification("symmetria verify"),
          await verification("symmetria drift --strict"),
        ],
      },
      {
        title: "Catch the smaller differences.",
        subtitle:
          "A manual change removes a default without changing the column type.",
        caption:
          "Drift checks defaults, identity, constraints, enums and index validity.",
        hold: 5,
        commands: [
          await verification("bun data.ts drift"),
          await verification("symmetria drift --strict", 1),
        ],
      },
      {
        title: "Adopt checks the live schema.",
        subtitle:
          "History cannot be re-baselined while the database differs from the target.",
        caption:
          "The failed adoption leaves the recorded migration history intact.",
        hold: 4.5,
        commands: [await verification("symmetria adopt", 1)],
      },
      {
        title: "Reconcile, then adopt.",
        subtitle: "Restore the declared default and verify the baseline again.",
        caption:
          "The live schema matches before migration history is recorded.",
        hold: 4.5,
        commands: [
          await verification("bun data.ts restore"),
          await verification("symmetria adopt"),
          await verification("symmetria drift --strict"),
        ],
      },
    ],
  });

  const online = await project("online");
  await online("bun data.ts duplicates");
  demos.push({
    id: "migration-recovery",
    label: "ONLINE + RECOVERY",
    accent: "#76deb2",
    preview: 1,
    scenes: [
      {
        title: "See the commit boundary.",
        subtitle:
          "Online index construction runs outside a transaction under a session-wide lock.",
        caption:
          "The plan prints the exact SQL and its nontransactional execution mode.",
        hold: 4.5,
        commands: [
          await online("MODEL=indexed symmetria generate email_index --online"),
          await online("symmetria migrate --plan"),
        ],
      },
      {
        title: "A partial failure stays visible.",
        subtitle:
          "Duplicate emails prevent the concurrent unique index from completing.",
        caption:
          "SQLSTATE, statement number and durable incomplete state identify the recovery boundary.",
        hold: 6,
        commands: [
          await online("symmetria migrate", 1),
          await online("symmetria status", 1),
        ],
      },
      {
        title: "Reconcile data. Verify the boundary.",
        subtitle:
          "Keep the original user, remove the invalid index, then explicitly request a retry.",
        caption:
          "Repair replays the historical target in a disposable database to check the starting schema.",
        hold: 5,
        commands: [
          await online("bun data.ts reconcile"),
          await online("symmetria repair 000002_email_index --action retry"),
        ],
      },
      {
        title: "Retry the unchanged migration.",
        subtitle:
          "The concurrent index completes and the live catalog matches the generated schema.",
        caption:
          "One original user retained. A valid unique index. A clean migration journal.",
        hold: 4.5,
        commands: [
          await online("symmetria migrate"),
          await online("symmetria drift --strict"),
          await online("bun data.ts users"),
        ],
      },
    ],
  });

  const source = [];

  for await (const path of new Bun.Glob(
    "packages/{kit,runtime}/src/**/*.ts",
  ).scan({ cwd: root })) {
    source.push(path);
  }

  source.sort();
  const hash = createHash("sha256");

  for (const path of source) {
    hash.update(path).update(await readFile(join(root, path)));
  }

  const capture = {
    version: 1,
    recordedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      postgres: server[0]!.server_version,
      sourceHash: hash.digest("hex"),
    },
    playback:
      "Unmodified CLI stdout/stderr; commands and pauses are paced for readability.",
    demos,
  };
  await writeFile(
    join(import.meta.dir, "migrations.json"),
    `${JSON.stringify(capture, null, 2)}\n`,
  );
  console.log(
    `Recorded ${demos.length} demos, ${demos.flatMap((demo) => demo.scenes).length} scenes and ${demos.flatMap((demo) => demo.scenes.flatMap((scene) => scene.commands)).length} commands.`,
  );
} finally {
  try {
    await admin?.close();
  } finally {
    try {
      if (started) {
        await checked(["docker", "rm", "--force", container]);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
