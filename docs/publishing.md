# Building and publishing

The repository is a private Bun workspace with **two public npm packages**:

| Package         | Source                  | Build output             |
| --------------- | ----------------------- | ------------------------ |
| `symmetria`     | `packages/runtime/src/` | `packages/runtime/dist/` |
| `symmetria-kit` | `packages/kit/src/`     | `packages/kit/dist/`     |

The core has no runtime dependencies. Its optional peers are `pg` for the
portable adapter, `better-auth` for `symmetria/better-auth` and `@types/bun` for
the Bun adapter's types. Kit depends on `pg` and `string-width`, and declares an
exact peer on the runtime version. `symmetria/internal` is their internal
bridge, not an application API. Interactive inspection dynamically loads Kit.

The runtime exposes `symmetria` for schemas, queries and `createDatabase`,
`symmetria/bun` for Bun.SQL and `symmetria/pg` for node-postgres.
`symmetria/driver` aliases the portable `pg` entry. Drivers ship in the same
package and release.

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
├── schema/         # Columns, tables, slots, links, relation graph, lowering, assembly, constraints
├── query/
│   ├── plan/       # Driver-neutral plan types, occurrences, equivalence, metadata
│   ├── expressions/ # Nodes, column handles, arithmetic, search, windows, functions, sql tag, aggregates, JSON paths
│   ├── codecs/     # Value and JSON codecs
│   ├── select/     # SELECT construction: types, scope, joins, shape, pagination, prepared
│   ├── write/      # INSERT/UPDATE/DELETE builders, their types, conflict keys, nested inserts
│   └── compile/    # SQL compiler (state, values, predicates, select, mutations)
│       └── postgres/ # PostgreSQL renderer, rendering types and value encoding
├── driver/         # Bun.SQL/pg adapters and shared pool/transaction/session lifecycle
├── embedders/      # HTTP requests shared by the ready-made embedding models
├── observability/  # Profiling, query inspection and OpenTelemetry spans
├── entries/        # One module per package entry: symmetria/bun, /pg, /vector, /search, /voyage, …
├── errors.ts       # Error classes
└── index.ts        # Public symmetria API
```

`schema/model.ts` holds `schema()` and binds a database to it. Its parts live
beside it: `table.ts` and `slots.ts` (declarations and `one`/`maybe`/`many`/
`link`), `links.ts` (keyed links inside a `schema()` callback), `lowering.ts`
(declarations turned into foreign keys and junction tables), `graph.ts` (the
type-level relation graph, `Row` and `Insert`) and `database.ts` (the types of a
bound database and its transactions). `query/expressions/index.ts` only
re-exports its neighbours. `query/plan/types.ts` holds the driver-neutral
plan/executor contracts; both PostgreSQL adapters consume those contracts. Kit
uses the public package entries rather than source paths.

An import that names only types is written `import type { … }`, not
`import { type … }`: the bundler keeps the second form as a real import, which
can order modules wrongly in the built package. `test:drivers` runs the built
package and catches it; the source tests do not.

## Local validation

Development pins Bun in the root `packageManager` field and Node in
`.node-version`. CI reads these same files. Applications require Bun 1.4.4+ or
Node.js 24.11+. See [contributing](../CONTRIBUTING.md) for setup.

```sh
bun install --frozen-lockfile
export SYMMETRIA_TEST_DATABASE_URL=postgres://user:password@localhost/testdb
bun run check:release
```

`check:release` runs lint, formatting, typechecking, unit/CLI/type contracts,
PostgreSQL integration through both adapters, native Node/Bun driver tests,
installed-package checks (including a fresh build), and the runnable examples.
It requires a PostgreSQL test URL.

The build emits ESM `.js` modules with explicit extensions and matching `.d.ts`
files. Source tests do not substitute for tarball validation. `test:packages`
packs both packages, installs them in an isolated temporary application, checks
runtime and declaration exports (including `symmetria/driver`, `symmetria/bun`,
`symmetria/pg` and `symmetria-kit/testing`), exercises reusable projections,
enum CASE, relation aggregates and direct-row writes, checks version/peer
alignment and package-local README links, bundles and executes a runtime-only
application, and runs the installed CLI's init/diff/generate workflow. Temporary
application files are removed afterwards. Set `SYMMETRIA_TEST_DATABASE_URL` to
also exercise installed migrations on PostgreSQL.

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

`bun run format` applies Biome to JavaScript, TypeScript and JSON across the
repository, including benchmarks, and Prettier to Markdown and YAML.
`bun run format:check` checks the same rules plus Biome's unused-code lint
without changing files and runs as part of `bun run check` in CI.
