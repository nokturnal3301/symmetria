if (!process.env.SYMMETRIA_TEST_DATABASE_URL) {
  throw new Error(
    "Set SYMMETRIA_TEST_DATABASE_URL to run PostgreSQL integration tests.",
  );
}

for (const driver of ["bun", "pg"]) {
  console.log(`PostgreSQL adapter: ${driver}`);
  const runner = Bun.spawn(
    [process.execPath, "test", "tests/runtime/postgres", "tests/kit/postgres"],
    {
      env: { ...process.env, SYMMETRIA_TEST_DRIVER: driver },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const status = await runner.exited;

  if (status) {
    process.exit(status);
  }
}
