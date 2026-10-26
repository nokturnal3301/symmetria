# Building and publishing

The repository is a private Bun workspace with **two public npm packages**:

| Package         | Source                  | Build output             |
| --------------- | ----------------------- | ------------------------ |
| `symmetria`     | `packages/runtime/src/` | `packages/runtime/dist/` |
| `symmetria-kit` | `packages/kit/src/`     | `packages/kit/dist/`     |

`@symmetria/style` is private lint infrastructure. TypeScript 7 checks the
project; the lint parser uses the TypeScript 6 AST API supported by
typescript-eslint. There are no runtime dependencies. Kit declares an exact peer
on the runtime version. `symmetria/internal` is their internal bridge, not an
application API. Interactive inspection dynamically loads Kit.

The runtime exposes `symmetria` for schemas, queries and `createDatabase`,
`symmetria/driver` for official PostgreSQL/SQLite drivers, and
`symmetria/dialect` for SQL dialect strategies. Drivers ship in the same package
and release.

Bun workspaces manage the packages. `tsdown.config.ts` defines both build
targets: Rolldown bundles ESM, the declaration plugin emits `.d.ts`, and
`publint` validates the package exports. Each public package owns a
self-contained npm README; the repository README is the visual project overview.
The build copies LICENSE, emits source maps and preserves the CLI shebang and
executable bit. `bun run build:watch` rebuilds on edits.

```sh
bun run build           # Both packages
bun run build:runtime   # Runtime only
bun run build:kit       # Runtime, then Kit
bun run pack            # Build once and write both npm tarballs to .build/packages/
```

Each package also exposes `bun run build` from its own directory. Package-local
`prepack` runs that build; the root `pack` command builds both together and
skips duplicate lifecycle builds while packing. Dependencies and Bun built-ins
remain external, and the runtime declares `sideEffects: false` for application
bundlers.

Runtime modules are grouped by responsibility:

```text
packages/runtime/src/
├── schema/         # Columns, tables, inference, graph assembly, constraints
├── query/          # SELECT/mutations, expressions, codecs, pagination
│   ├── compile/    # SQL compiler: state, values, predicates, select, mutations
│   └── dialects/   # DialectStrategy, postgres and sqlite strategies, registry
├── driver/         # PostgreSQL/SQLite execution, DDL and transaction lifecycle
├── observability/  # Profiling and query inspection
├── index.ts        # Public symmetria API
├── driver.ts       # Official symmetria/driver entry
├── dialect.ts      # Public symmetria/dialect entry
└── internal.ts     # Private symmetria/internal bridge for Kit
```

`schema/model.ts` composes the declarations and query APIs. `query/state.ts`
holds the driver-neutral plan/executor contracts; the concrete PostgreSQL driver
consumes those contracts alongside the embedded SQLite driver. Kit uses the
public package entries rather than source paths.

## Local validation

Development pins Bun in the root `packageManager` field and Node in
`.node-version`. CI reads these same files. Applications require Bun 1.4.4+; the
development toolchain requires Node 24.11 or newer. See
[contributing](../CONTRIBUTING.md) for setup.

```sh
bun install --frozen-lockfile
export SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb
bun run check:release
```

`check:release` runs lint, formatting, typechecking, unit/CLI/type contracts,
PostgreSQL integration, installed-package checks (including a fresh build), and
the runnable examples. It requires a PostgreSQL test URL.

The build emits ESM `.js` modules with explicit extensions and matching `.d.ts`
files. Source tests do not substitute for tarball validation. `test:packages`
packs both packages, installs them in an isolated temporary application, checks
runtime and declaration exports (including `symmetria/driver`,
`symmetria/dialect` and `symmetria-kit/testing`), exercises reusable
projections, enum CASE, relation aggregates and direct-row writes, checks
version/peer alignment and package-local README links, bundles and executes a
runtime-only application, and runs the installed CLI's init/diff/generate
workflow. Temporary application files are removed afterwards. Set
`SYMMETRIA_TEST_DATABASE_URL` to also exercise installed migrations on
PostgreSQL.

Run examples independently:

```sh
bun examples/queries.ts
bun examples/shapes.ts
# Database-backed commands: examples/README.md
```

Examples generate migrations into the ignored `.symmetria-examples/migrations/`
directory. Their verification uses a separate temporary directory and cleans it
up, so running checks does not generate files under `examples/`.

GitHub Actions runs two independent jobs: lint/types/unit and CLI tests, plus
package builds/installation, PostgreSQL integration and runnable examples. Both
use the frozen lockfile. A newer push cancels the superseded workflow run.

## Release

1. Set the same version in the root `package.json`,
   `packages/runtime/package.json`, `packages/kit/package.json`, and Kit's exact
   runtime peer dependency.
2. Update `CHANGELOG.md` and run `bun run check:release` with the test database
   URL.
3. Run `bun run pack` and inspect the tarballs in `.build/packages/`. Only
   `dist`, README, LICENSE and package metadata ship. The visual README assets,
   examples and tests stay in the repository.
4. Authenticate with the npm account that will own both names (`npm whoami`).
5. Publish the runtime first, then Kit, from their respective directories:

```sh
cd packages/runtime
npm publish --access public
cd ../kit
npm publish --access public
```

Package `prepack` scripts build the package and its workspace dependency. For a
prerelease, use matching prerelease versions and
`npm publish --tag next --access public`. Publishing is a separate manual step;
local validation does not publish packages. The root and style workspace are
marked `private`.

## Formatting

`packages/runtime/src/driver/transactions.ts` is the style reference:
descriptive identifiers, arrow implementations, braces around every if/else
body, and blank lines between control flow and logical blocks. Function
implementations are visually separated; consecutive ordinary variable
declarations stay together.

`bun run format` applies ESLint's style rules and Biome to JavaScript,
TypeScript and JSON across the repository, including benchmarks. Prettier
formats Markdown and YAML. `bun run format:check` checks the same rules without
changing files and runs as part of `bun run check` in CI. The Python GIF
renderer uses Black with `--line-length 80` and four-space indentation.
