import { POSTS, USERS } from "../config";
import type { Library } from "../adapters";
import type { Bench, InsertRow } from "../adapters/types";

/** Each worker owns a reproducible input stream, independent of scheduling. */
export const random = (seed: number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

export const SCENARIOS = [
  "pointLookup",
  "listJoin",
  "nestedFirst",
  "nestedMiddle",
  "nestedDeep",
  "nestedKeyset",
  "insertOne",
  "insertMany500",
  "updateViews",
  "buildNested",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const writes = (scenario: Scenario): boolean =>
  ["insertOne", "insertMany500", "updateViews"].includes(scenario);

export const applicable = (library: Library, scenario: Scenario): boolean =>
  library === "symmetria-prepared"
    ? ["nestedFirst", "nestedMiddle", "nestedDeep"].includes(scenario)
    : scenario !== "buildNested" ||
      ["symmetria", "drizzle", "kysely"].includes(library);

/** Fixed write budgets give every adapter the same table growth and input volume. */
export const writeBudget = (
  scenario: Scenario,
  concurrent: boolean,
): number => {
  if (scenario === "insertMany500") {
    return concurrent ? 4 : 32;
  }

  if (scenario === "insertOne") {
    return concurrent ? 64 : 256;
  }

  return concurrent ? 128 : 512;
};

export const operation = (
  bench: Bench,
  scenario: Scenario,
  worker = 0,
  count = 1,
): (() => unknown) => {
  const rng = random(1000 + SCENARIOS.indexOf(scenario) * 100 + worker);
  // Build inputs outside timing; adapters still build, bind, execute and decode queries.
  const ids = Array.from(
    { length: 256 },
    () => 1 + Math.floor(rng() * (scenario === "pointLookup" ? USERS : POSTS)),
  );
  const batches: InsertRow[][] =
    writes(scenario) && scenario !== "updateViews"
      ? Array.from({ length: count }, (_, batch) =>
          Array.from(
            { length: scenario === "insertMany500" ? 500 : 1 },
            (_, row) => ({
              slug: `bench-${worker}-${batch}-${row}`,
              title: "Benchmark post",
              authorId: 1 + Math.floor(rng() * USERS),
            }),
          ),
        )
      : [];
  let position = 0;

  switch (scenario) {
    case "pointLookup":
      return () => bench.pointLookup(ids[position++ % ids.length]!);
    case "listJoin":
      return () => bench.listJoin();
    case "nestedFirst":
      return () => bench.nested(0);
    case "nestedMiddle":
      return () => bench.nested(1000);
    case "nestedDeep":
      return () => bench.nested(1900);
    case "nestedKeyset":
      return () => bench.nestedKeyset(1900);
    case "insertOne":
      return () => bench.insertOne(batches[position++]![0]!);
    case "insertMany500":
      return () => bench.insertMany(batches[position++]!);
    case "updateViews":
      return () => bench.updateViews(ids[position++ % ids.length]!);
    case "buildNested":
      return () => bench.buildNested!(1900);
  }
};

export const libraryOrder = (
  libraries: readonly Library[],
  pass: number,
  seed: number,
): Library[] => {
  const shuffled = [...libraries];
  const rng = random(seed);

  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }

  const offset = (pass * 3) % shuffled.length;

  return [...shuffled.slice(offset), ...shuffled.slice(0, offset)];
};
