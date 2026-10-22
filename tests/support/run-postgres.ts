if (!process.env.SYMMETRIA_TEST_DATABASE_URL) {
  throw new Error(
    "Set SYMMETRIA_TEST_DATABASE_URL to run PostgreSQL integration tests.",
  );
}

const runner = Bun.spawn(
  [process.execPath, "test", "tests/runtime/postgres", "tests/kit/postgres"],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await runner.exited;
