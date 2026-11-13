# Contributing to Symmetria

Bug reports, documentation improvements and focused pull requests are welcome.
For API changes, describe the intended TypeScript result alongside the SQL
behavior.

## Setup

Use the Bun version pinned in `package.json` and Node.js from `.node-version`.
Applications run on Node.js 24.11+ or Bun 1.4.4+.

```sh
bun install --frozen-lockfile
bun run build
bun run check
bun run test
```

The unit, CLI and compile-only type tests run without PostgreSQL.

## Repository layout

| Directory          | Purpose                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `packages/runtime` | The `symmetria` package: schemas, queries, drivers and observability  |
| `packages/kit`     | The `symmetria-kit` package: migrations and terminal tools            |
| `tests`            | Runtime, CLI, type contracts, PostgreSQL and installed-package checks |
| `examples`         | Runnable applications using the public package imports                |
| `docs`             | API reference, publishing instructions and visual assets              |

## Build and test

```sh
bun run build:runtime   # Runtime only
bun run build:kit       # Runtime, then Kit
bun run build:watch     # Rebuild both packages on changes
bun run test:types      # Compile-only API contracts
# Unit tests run with SYMMETRIA_FREEZE=1, which freezes every query plan record
# so an accidental mutation fails loudly; production skips the freeze for speed.
bun run format:check    # Biome formatting and unused-code lint, Prettier for Markdown/YAML
bun run test:packages   # Build, pack and install into a fresh application
bun run pack            # Keep npm tarballs in .build/packages/
```

Database-backed tests use a local PostgreSQL database (14 or newer; CI runs 14
and 17 from the `pgvector/pgvector` images). Each suite creates isolated schemas
and removes them afterwards. The pgvector suites skip when the server cannot
provide the `vector` extension;
`docker run --rm -e POSTGRES_PASSWORD=secret -p 5433:5432 pgvector/pgvector:pg16`
provides one:

```sh
export SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb
bun run test:integration
bun run test:drivers
bun run test:examples
bun run check:release
```

`check:release` includes all checks, a fresh package build and installed-package
verification. See [tests](tests/README.md) for each suite's scope and
[building and publishing](docs/publishing.md) for package details.

Changes to drivers, catalog queries (`drift`, `pull`, `verify`) or migrations
should pass on every supported PostgreSQL major version, 14 through 18, and, for
drivers and migrations, through PgBouncer in transaction mode. The
[tests README](tests/README.md#postgresql-versions-and-pgbouncer) has the
commands.

## Making a change

- Keep each pull request focused and explain the behavior it changes.
- Match surrounding code: descriptive names, arrow functions, braces around
  control flow, and blank lines between logical blocks. Run `bun run format`.
  Biome formats and lints JavaScript, TypeScript and JSON throughout the
  repository, including benchmarks. Prettier formats Markdown and YAML.
  `bun run format:check` verifies formatting and lint rules in CI.
- Cover behavior changes with a regression test. Update compile-only contracts
  when inferred types change; shared SQL behavior belongs in `tests/support` so
  Bun.SQL and node-postgres exercise the same scenarios.
- Update the API reference, package READMEs and examples when public behavior
  changes.
- List the checks you ran in the pull request. New build outputs and local
  migration files belong in ignored directories.

## Reporting an issue

Include package versions, runtime, adapter and PostgreSQL versions, a minimal
schema and query, the generated SQL and parameters, and expected versus actual
behavior. Replace credentials and application data in reproductions with sample
values.

Use the repository's bug report or feature request form. A small runnable
reproduction is the most useful starting point.
