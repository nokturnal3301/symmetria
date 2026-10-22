import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const temporaryRoot =
  process.env.SYMMETRIA_TEST_TMPDIR ?? join(tmpdir(), "symmetria");
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, "symmetria-packages-"));

const run = async (command: string[], cwd = directory) => {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: "", NO_COLOR: "1" },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  assert.equal(status, 0, `${command.join(" ")}\n${stdout}\n${stderr}`);

  return stdout;
};

try {
  await run([process.execPath, "run", "build"], root);
  const tarballs: Record<string, string> = {};
  const runtimeManifest = await Bun.file(
    join(root, "packages/runtime/package.json"),
  ).json();
  const kitManifest = await Bun.file(
    join(root, "packages/kit/package.json"),
  ).json();
  assert.equal(kitManifest.version, runtimeManifest.version);
  assert.equal(kitManifest.peerDependencies.symmetria, runtimeManifest.version);

  for (const packageDirectory of ["runtime", "kit"]) {
    const packed = JSON.parse(
      await run(
        [
          "npm",
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          directory,
        ],
        join(root, "packages", packageDirectory),
      ),
    ) as { name: string; filename: string; files: { path: string }[] }[];
    const archive = packed[0]!;
    assert(
      archive.files.every(
        (file) =>
          file.path.startsWith("dist/") ||
          ["package.json", "README.md", "LICENSE"].includes(file.path),
      ),
    );
    assert(
      !archive.files.some(
        (file) => file.path.endsWith(".ts") && !file.path.endsWith(".d.ts"),
      ),
    );
    const readme = await Bun.file(
      join(root, "packages", packageDirectory, "README.md"),
    ).text();
    const links = [
      ...[...readme.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!),
      ...[...readme.matchAll(/(?:src|href|srcset)="([^"]+)"/g)].map(
        (match) => match[1]!,
      ),
    ];

    for (const link of links) {
      if (/^(?:https?:|mailto:|#)/.test(link)) {
        continue;
      }

      const path = posix.normalize(link.split("#")[0]!);
      assert(
        archive.files.some((file) => file.path === path),
        `${archive.name} README links outside its tarball: ${link}`,
      );
    }

    tarballs[archive.name] = `file:${join(directory, archive.filename)}`;
    console.log(`Packed ${archive.name}: ${archive.files.length} files`);
  }

  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { symmetria: tarballs.symmetria },
    }),
  );
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await Bun.write(
    join(directory, "runtime-only.ts"),
    `import assert from "node:assert/strict";
import { createDatabase, schema, int, text } from "symmetria";
import { sqlite } from "symmetria/driver";
const query = schema({ records: { id: int } }).records((record) => ({ id: record.id }));
assert.match((await query.inspect({ interactive: false })).sql, /SELECT/);
assert(!(await Bun.file("node_modules/symmetria-kit/package.json").exists()));
const driver = sqlite(":memory:");
const database = createDatabase({ schema: schema({ records: { id: int.auto, name: text } }), driver });
driver.createTables(database);
try {
  const record = await database.records.insert({ name: "installed" }).returning((records) => [records.id, records.name]);
  assert.equal(record.name, "installed");
  assert.deepEqual(await database.records.byId(record.id).one(), record);
  assert.deepEqual(await database.records((record) => ({ name: record.name })), [{ name: "installed" }]);
} finally {
  await database.$close();
}
`,
  );
  await run([process.execPath, "runtime-only.ts"]);
  await run([
    process.execPath,
    "build",
    "runtime-only.ts",
    "--target=bun",
    "--external=symmetria-kit/inspect",
    "--outdir=bundled",
    "--minify",
  ]);
  await run([process.execPath, "bundled/runtime-only.js"]);

  const rootPackage = await Bun.file(join(root, "package.json")).json();
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: tarballs,
      devDependencies: {
        "@types/bun": rootPackage.devDependencies["@types/bun"],
      },
    }),
  );
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await Bun.write(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "Preserve",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        types: ["bun"],
        skipLibCheck: false,
      },
      include: ["smoke.ts", "symmetria.config.ts", "src/**/*.ts"],
    }),
  );
  await Bun.write(
    join(directory, "tsconfig.node.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["smoke.ts"],
    }),
  );
  await Bun.write(
    join(directory, "smoke.ts"),
    `import assert from "node:assert/strict";
import { createDatabase, schema, table, int, text, bigint, oneOf, index, rowNumber, prepare, createProfiler, type Transaction } from "symmetria";
import { postgres, type Driver } from "symmetria/driver";
import { postgresDialect, registerDialect, type DialectStrategy } from "symmetria/dialect";
import { createSchemaSQL, migrator, generateMigration, loadMigrationState, type MigrationState } from "symmetria-kit";
import { testDatabase } from "symmetria-kit/testing";

const users = table({ id: int.auto, email: text.unique });
const posts = table({ id: int.auto, author: users, title: text, views: bigint.default(0n), state: oneOf("draft", "published").default("draft") })
  .indexes((posts) => ({ authorTitle: index(posts.authorId, posts.title).unique }));
const model = schema({ users, posts });
const userCard = model.users.shape((user) => ({ email: user.email, total: user.posts.sum((post) => post.views) }));
const reusable = model.posts((post) => ({ author: post.author(userCard), state: post.state.match({ draft: "Draft", published: "Published" }) }));
const reusableType: Promise<{ author: { email: string; total: string | null } | null; state: "Draft" | "Published" }[]> = null as unknown as ReturnType<typeof reusable.execute>;
void reusableType;
assert.match(reusable.toSQL().sql, /CASE/);
assert.match(model.posts.update((post) => ({ views: post.views.plus(1n) })).where((post) => post.id.is(1)).returning((post) => ({ views: post.views })).toSQL().sql, /RETURNING/);
const shape = model.users((user, { leftJoin }) => {
  const post = leftJoin(model.posts.as("latest"), (post) => post.authorId.is(user.id));
  return { email: user.email, title: post.title, posts: user.posts((post) => ({ views: post.views, $limit: 2 })) };
});
const shapeType: Promise<{ email: string; title: string | null; posts: { views: bigint }[] }[]> = null as unknown as ReturnType<typeof shape.execute>;
void shapeType;
assert.match(shape.toSQL().sql, /LEFT JOIN/);
const smartShape = model.posts((post, { join, count }) => {
  const author = join(post.authorId);
  return { email: author.email, total: count(), $groupBy: [author.email] };
});
const smartShapeType: Promise<{ email: string; total: number }[]> = null as unknown as ReturnType<typeof smartShape.execute>;
void smartShapeType;
const scalarShape = model.users((user) => ({ id: user.id })).scalar();
assert.match(model.posts((post) => ({ id: post.id, scalar: scalarShape })).toSQL().sql, /SELECT/);
const lookup = model.users.by.email("ada")((user) => ({ id: user.id }));
const expected: Promise<{ id: number }[]> = null as unknown as ReturnType<typeof lookup.execute>;
void expected;
model.posts.by.authorTitle({ authorId: 1, title: "First" });
const nested = model.users.insert({ email: "ada", posts: { create: [{ title: "First" }] } }).returning((users) => [users.id]);
const nestedType: Promise<{ id: number }> = null as unknown as ReturnType<typeof nested.execute>;
void nestedType;
const findUser = (transaction: Transaction<typeof model>, email: string) => transaction.users.by.email(email).one();
const verifyTypes = (transaction: Transaction<typeof model>) => {
  // @ts-expect-error a pool-bound schema is not a reserved transaction
  findUser(model, "ada");
  // @ts-expect-error an installed transaction type cannot close the pool
  transaction.$close();
  // @ts-expect-error an installed transaction type retains scalar column types
  transaction.users.update({ email: 123 });
  // @ts-expect-error missing part of a composite key
  model.posts.by.authorTitle({ authorId: 1 });
  // @ts-expect-error non-unique field
  model.posts.by.title("First");
  // @ts-expect-error required author must be supplied
  model.posts.insert({ title: "First" });
};
void verifyTypes;
const ranked = model.posts((post) => ({ id: post.id, position: rowNumber().over({ orderBy: post.id.ascending }) })).cte("ranked");
assert.match(ranked((post) => ({ id: post.id, $where: post.position.is(1) })).toSQL().sql, /^WITH/);
assert.deepEqual(prepare({ email: text }, (parameters) => model.users.by.email(parameters.email)).toSQL({ email: "ada" }).parameters, ["ada"]);
assert(createSchemaSQL(model.$snapshot()).length > 0);
const profiler = createProfiler();
const driver: Driver = { execute: async () => [{ id: 1 }], close: async () => {} };
const numbered: DialectStrategy = { ...postgresDialect, name: "installed-numbered", placeholder: (position) => ":p" + position };
registerDialect(numbered);
const custom = createDatabase({ schema: model, driver: { ...driver, dialect: numbered.name } });
assert.match(custom.users.byId(1).toSQL().sql, /:p1/);
const traced = schema({ records: { id: int } }, { driver: profiler.driver(driver) });
await profiler.trace("smoke", () => traced.records((record) => ({ id: record.id })).execute());
assert.equal(profiler.snapshot()[0]!.queries.length, 1);
const { inspectQueryScreen } = await import("symmetria-kit/inspect");
assert.equal(typeof inspectQueryScreen, "function");
assert.equal(typeof testDatabase, "function");
const migrationState: MigrationState = await loadMigrationState("migrations");
assert.equal(migrationState.migrations[0]?.id, "000001_initial");
assert.equal(migrationState.snapshot.tables[0]?.name, "users");

if (process.env.SYMMETRIA_TEST_DATABASE_URL) {
  const fixture = await testDatabase({ url: process.env.SYMMETRIA_TEST_DATABASE_URL, schema: model });
  try {
    const user = await fixture.database.users.insert({ email: "fixture" }).returning((users) => [users.id]);
    assert.equal((await fixture.database.users.byId(user.id).one()).email, "fixture");
  } finally {
    await fixture.close();
  }
  const admin = postgres(process.env.SYMMETRIA_TEST_DATABASE_URL);
  const namespace = "symmetria_package_" + crypto.randomUUID().replaceAll("-", "");
  const url = new URL(process.env.SYMMETRIA_TEST_DATABASE_URL);
  url.searchParams.set("options", "-c search_path=" + namespace);
  const connection = postgres(url.toString());

  try {
    await admin.execute({ sql: 'CREATE SCHEMA "' + namespace + '"', parameters: [] });
    await generateMigration({ directory: "package-migrations", name: "initial", snapshot: model.$snapshot() });
    const migration = migrator({ driver: connection, directory: "package-migrations", metadataSchema: namespace });
    await migration.migrate();
    const database = createDatabase({ schema: model, driver: connection });
    const user = await database.users.insert({ email: "ada", posts: { create: [{ title: "First", views: 9007199254740993n }] } }).returning((users) => [users.id]);
    assert(user);
    assert.equal((await database.users.by.email("ada").one()).id, user.id);
    assert.equal((await database.$transaction((transaction) => findUser(transaction, "ada"))).id, user.id);
    assert.equal((await database.posts((post) => ({ views: post.views })).one()).views, 9007199254740993n);
    assert.deepEqual(await database.users((user) => ({ email: user.email, posts: user.posts((post) => ({ title: post.title, views: post.views })) })), [{ email: "ada", posts: [{ title: "First", views: 9007199254740993n }] }]);
    await migration.rollback();
  } finally {
    await connection.close();
    await admin.execute({ sql: 'DROP SCHEMA "' + namespace + '" CASCADE', parameters: [] });
    await admin.close();
  }
}
console.log("Installed package runtime and declarations verified.");
`,
  );

  const binary = join(directory, "node_modules/.bin/symmetria");
  assert.match(await run([binary, "--help"]), /profile/);
  const initialized = await run([binary, "init"]);
  assert.match(
    initialized,
    /bunx --package symmetria-kit symmetria generate initial/,
  );
  assert.match(initialized, /bunx --package symmetria-kit symmetria migrate/);
  assert.match(await run([binary, "init"]), /nothing to create/);
  await run([binary, "generate", "initial", "--json"]);
  assert.match(await run([binary, "diff"]), /No schema changes/);
  await run([binary, "inspect", "users", "--json"]);
  await run([join(root, "node_modules/.bin/tsc"), "--noEmit"]);
  await run([join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.node.json"]);
  console.log(await run([process.execPath, "smoke.ts"]));
} finally {
  await rm(directory, { recursive: true, force: true });
}
