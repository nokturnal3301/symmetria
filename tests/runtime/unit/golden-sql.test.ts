import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { collectGolden, type GoldenEntry } from "./golden/cases";

const file = new URL("./golden/golden.json", import.meta.url);

/**
 * The SQL text and parameters of a wide set of statements, as recorded in
 * golden.json. A difference is a change in generated SQL or in an error
 * message: review it, then record it with SYMMETRIA_UPDATE_GOLDEN=1.
 */
test("generated SQL matches the golden file", async () => {
  const golden = await collectGolden();

  if (process.env.SYMMETRIA_UPDATE_GOLDEN === "1") {
    writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
  }

  const recorded: Record<string, GoldenEntry> = JSON.parse(
    readFileSync(file, "utf8"),
  );

  expect(Object.keys(golden)).toEqual(Object.keys(recorded));

  for (const [name, entry] of Object.entries(golden)) {
    // The name travels with the entry, so a failure says which case changed.
    expect({ name, entry }).toEqual({ name, entry: recorded[name]! });
  }
});
