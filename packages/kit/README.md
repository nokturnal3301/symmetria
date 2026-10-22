# symmetria-kit

Migration and development tools for the
[Symmetria](https://www.npmjs.com/package/symmetria) PostgreSQL query builder on
Bun 1.3+.

```sh
bun add symmetria
bun add -d symmetria-kit
bunx --package symmetria-kit symmetria init
```

The package installs the **`symmetria`** command. Run it without arguments in a
terminal to open the dashboard. Use matching runtime and Kit versions.

```ts
// symmetria.config.ts
import { defineMigrationConfig } from "symmetria-kit";
import { appSchema } from "./src/database/schema";

export default defineMigrationConfig({
  schema: appSchema,
  directory: "./migrations",
  databaseUrl: process.env.DATABASE_URL,
});
```

## Commands

| Command            | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `init [directory]` | Create missing scaffold files; preserve existing projects   |
| `inspect [table]`  | Browse columns, relations, indexes, checks and SQL          |
| `diff`             | Compare source schema to the latest local snapshot          |
| `lint`             | Review destructive and blocking changes in the pending diff |
| `generate <name>`  | Generate migration SQL and metadata                         |
| `migrate`          | Apply pending migrations atomically                         |
| `status`           | Show applied/pending migrations                             |
| `rollback`         | Revert the latest migration                                 |
| `drift`            | Compare the live database with the latest local snapshot    |
| `squash <name>`    | Collapse local migration history into a baseline            |
| `adopt`            | Adopt a matching baseline without replaying its SQL         |
| `profile`          | Browse live request traces and query timings                |

Use `--help` for options. `--json` produces machine-readable output;
`--no-interactive` disables prompts. `diff --sql` prints SQL. Config paths
resolve relative to the config file. SQL lives in `migrations/<id>/`; metadata
lives in `migrations/meta/snapshot.json` and `migrations/meta/migration.json`.
Commit SQL and both JSON files together. `diff` compares snapshots, not live DB
drift.

The snapshot holds the latest generated schema. The journal holds IDs, parents
and schema hashes for the whole chain, without historical snapshot copies.
Generation updates the same two files; migrate/rollback only change database
history and use `up.sql`/`down.sql`. `generate --json` reports the SQL and
metadata directories.

## Profiling and inspection

Enable `createProfiler()` in the application, pass it to
`postgres({ url, profiler })`, wrap the request handler with
`profiler.fetch(handler)`, and call `profiler.serve()`. `symmetria profile`
connects to `http://127.0.0.1:7331`; `--profile-url` overrides it. Enter opens a
request/query, `e` estimates a plan, `a` explicitly runs ANALYZE, Escape goes
back and `q` exits.

The runtime's `query.inspect()` loads this package for its interactive SQL,
Parameters, Results and Explain tabs. Neither inspector analyzes a query unless
requested. Offline SQL inspection works without a database.

## Programmatic migrations

Exports: `defineMigrationConfig`, `migrationSnapshot`, `parseMigrationSnapshot`,
`snapshotHash`, `emptySnapshot`, `createSchemaSQL`, `diffSchemas`,
`generateMigration`, `loadMigrations`, `loadMigrationState`, `squashMigrations`,
`lintMigration`, `detectDrift`, their formatting helpers, and `migrator` with
their associated types. `loadMigrationState` returns `{ migrations, snapshot }`;
only the current schema snapshot is stored. Generated and squashed migrations
include their new snapshot.

```ts
import { postgres } from "symmetria/driver";
import { migrator } from "symmetria-kit";

const driver = postgres(process.env.DATABASE_URL!);

try {
  await migrator({ driver, directory: "./migrations" }).migrate();
} finally {
  await driver.close();
}
```

## Isolated test databases

`symmetria-kit/testing` creates a unique PostgreSQL schema, creates the declared
tables and returns a typed database. Closing it drops that schema and its data.

```ts
import { testDatabase } from "symmetria-kit/testing";
import { appSchema } from "./src/database/schema";

const fixture = await testDatabase({
  url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
  schema: appSchema,
});

try {
  await fixture.database.users((user) => ({ id: user.id }));
} finally {
  await fixture.close();
}
```

[MIT](https://opensource.org/license/mit).
