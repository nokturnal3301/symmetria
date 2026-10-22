import { strict as assert } from "node:assert";
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { withMigrationDirectory } from "../support/directories";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Set SYMMETRIA_TEST_DATABASE_URL to verify the examples.");
}

const namespace = `symmetria_examples_${crypto.randomUUID().replaceAll("-", "")}`;
const connectionUrl = new URL(databaseUrl);
connectionUrl.searchParams.set("options", `-c search_path=${namespace}`);
const client = new SQL(connectionUrl.toString(), { max: 1, bigint: true });

const run = async (...argumentsList: string[]) => {
  const child = Bun.spawn([process.execPath, ...argumentsList], {
    env: {
      ...process.env,
      DATABASE_URL: connectionUrl.toString(),
      SYMMETRIA_EXAMPLE_SCHEMA: namespace,
      TERM: "dumb",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `${argumentsList.join(" ")}\n${stdout}\n${stderr}`);
  console.log(`Verified ${argumentsList.join(" ")}`);

  return stdout;
};

await withMigrationDirectory(async (directory) => {
  const runMigration = (...argumentsList: string[]) =>
    run(
      "packages/kit/src/cli.ts",
      ...argumentsList,
      "--config",
      "examples/symmetria.config.ts",
      "--dir",
      directory,
    );

  try {
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    await run("examples/queries.ts");
    await runMigration("generate", "initial");
    const generatedFiles = await readdir(directory);
    assert(generatedFiles.includes("meta"));
    assert.match(
      await runMigration("generate", "initial"),
      /No schema changes/,
    );
    assert.deepEqual(await readdir(directory), generatedFiles);
    await runMigration("migrate");
    await runMigration("migrate");
    await run("examples/seed.ts");
    await run("examples/seed.ts");

    for (const name of [
      "read",
      "write",
      "transactions",
      "analytics",
      "shapes",
      "inspect",
      "profile",
    ]) {
      await run(`examples/${name}.ts`);
    }

    const report = await run("examples/advanced/author-report.ts");

    const readReport = (prefix: string) => {
      const line = report.split("\n").find((line) => line.startsWith(prefix));
      assert.ok(line, `missing ${prefix}`);

      return JSON.parse(line.slice(prefix.length));
    };

    const authors = readReport("author report JSON ");
    assert.equal(authors.length, 1);
    assert.deepEqual(authors[0].author, {
      name: "Ada",
      email: "ada@example.test",
    });
    assert.equal(authors[0].stats.publications, 3);
    assert.equal(authors[0].stats.totalViews, "27021597764222979");
    assert.deepEqual(
      authors[0].best,
      ["typed-sql", "relations"].map((title) => ({
        title,
        views: "9007199254740993",
        editor: null,
        tags: [{ label: "bun" }, { label: "postgres" }],
      })),
    );
    assert.equal(readReport("author report top 1 JSON ")[0].best.length, 1);
    assert.match(
      await run("examples/advanced/bulk-import.ts"),
      /bulk import verified/,
    );
    assert.match(
      await run("examples/advanced/work-queue.ts"),
      /work queue verified/,
    );

    assert.equal(
      (await client.unsafe("SELECT count(*) AS count FROM posts"))[0].count,
      4n,
    );
    assert.equal(
      (
        await client.unsafe("SELECT title FROM posts WHERE slug = 'typed-sql'")
      )[0].title,
      "typed-sql",
    );
  } finally {
    try {
      await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await client.close();
    }
  }
});
