# Contributing to Symmetria

Bug reports, documentation improvements and focused pull requests are welcome.
For API changes, describe the intended TypeScript result alongside the SQL
behavior.

## Setup

Use the Bun version pinned in `package.json` and Node.js from `.node-version`.
Node is used by the build tools; applications run on Bun 1.3+.

```sh
bun install --frozen-lockfile
bun run build
bun run check
bun run test
```

The source tests run without PostgreSQL, including the embedded SQLite suite.

## Repository layout

| Directory          | Purpose                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `packages/runtime` | The `symmetria` package: schemas, queries, drivers and observability  |
| `packages/kit`     | The `symmetria-kit` package: migrations and terminal tools            |
| `packages/style`   | Private lint infrastructure                                           |
| `tests`            | Runtime, CLI, type contracts, PostgreSQL and installed-package checks |
| `examples`         | Runnable applications using the public package imports                |
| `docs`             | API reference, publishing instructions and visual assets              |

## Build and test

```sh
bun run build:runtime   # Runtime only
bun run build:kit       # Runtime, then Kit
bun run build:watch     # Rebuild both packages on changes
bun run test:types      # Compile-only API contracts
bun run test:packages   # Build, pack and install into a fresh application
bun run pack            # Keep npm tarballs in .build/packages/
```

Database-backed tests use a local PostgreSQL database. Each suite creates
isolated schemas and removes them afterwards:

```sh
export SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb
bun run test:integration
bun run test:examples
bun run check:release
```

`check:release` includes all checks, a fresh package build and installed-package
verification. See [tests](tests/README.md) for each suite's scope and
[building and publishing](docs/publishing.md) for package details.

## Making a change

- Keep each pull request focused and explain the behavior it changes.
- Match surrounding code: descriptive names, arrow functions, braces around
  control flow, and blank lines between logical blocks. Run `bun run format`.
  ESLint and Biome cover JavaScript, TypeScript and JSON throughout the
  repository, including benchmarks. Prettier formats Markdown and YAML.
  `bun run format:check` verifies formatting and lint rules in CI.
- Cover behavior changes with a regression test. Update compile-only contracts
  when inferred types change; shared SQL behavior belongs in `tests/support` so
  SQLite and PostgreSQL exercise the same scenarios.
- Update the API reference, package READMEs and examples when public behavior
  changes.
- List the checks you ran in the pull request. New build outputs and local
  migration files belong in ignored directories.

## Reporting an issue

Include package versions, Bun and database versions, a minimal schema and query,
the generated SQL and parameters, and expected versus actual behavior. Replace
credentials and application data in reproductions with sample values.

Use the repository's bug report or feature request form. A small runnable
reproduction is the most useful starting point.
