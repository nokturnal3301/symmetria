# Migration recordings

The README GIFs replay **actual CLI stdout and stderr** captured against an
isolated PostgreSQL 16.10 container. Commands, exit codes and execution
durations are retained in [`migrations.json`](migrations.json), together with
the Bun/ PostgreSQL versions and a hash of the runtime and Kit source. Command
typing and reading pauses are paced for readability; playback is not a timing
benchmark.

| Recording                    | Demonstration                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `migration-safety.gif`       | Rejected implicit rename, explicit rename with retained data, lint of a saved destructive migration        |
| `migration-verification.gif` | Disposable-database verification with data assertions, default drift, verified adoption                    |
| `migration-recovery.gif`     | Online execution plan, failed concurrent index, persistent incomplete state, reconciled and verified retry |

## Reproduce

From the repository root, with dependencies installed, Docker running and Python
with Pillow plus FFmpeg available:

```sh
bun docs/demos/record-migrations.ts
python3 docs/demos/render-migrations.py
```

The recorder creates its own local PostgreSQL container, databases and temporary
workspace. It removes the container and workspace in `finally`. It does not use
`DATABASE_URL`. The fixture in `migration-fixture.ts` is copied to each
workspace as `data.ts`; its configuration uses `DEMO_DATABASE_URL` and the
`MODEL` environment variable. The `symmetria` command is a local wrapper around
this checkout's CLI. Expected failures are asserted during recording; data
assertions verify the demonstrated outcomes.

Rendering uses Menlo/Arial on macOS or DejaVu Sans on Linux. Override the font
paths with `DEMO_FONT` and `DEMO_MONO_FONT`. GIFs and reduced-motion PNG
previews are written to `docs/assets/`; contact sheets and render statistics go
to the ignored `.build/migration-demos/` directory.
