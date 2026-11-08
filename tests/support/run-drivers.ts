if (!process.env.SYMMETRIA_TEST_DATABASE_URL) {
  throw new Error(
    "Set SYMMETRIA_TEST_DATABASE_URL to run driver integration tests.",
  );
}

for (const command of [
  [
    process.execPath,
    "test",
    "--tsconfig-override",
    "tests/runtime/drivers/tsconfig.json",
    "tests/runtime/drivers",
  ],
  ["node", "--test", "tests/runtime/drivers/postgres.test.mjs"],
]) {
  const runner = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await runner.exited;

  if (status) {
    process.exit(status);
  }
}
