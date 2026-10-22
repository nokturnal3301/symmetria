/**
 * Compare two compilation logs written with SYMMETRIA_COMPILE_LOG. Lines are
 * compared in order first; when only the order differs, the multisets are
 * compared so concurrent tests do not produce false alarms.
 */
const [baselinePath, candidatePath] = process.argv.slice(2);

if (!baselinePath || !candidatePath) {
  console.error(
    "usage: bun tests/support/golden-compare.ts <baseline> <candidate>",
  );
  process.exit(2);
}

const lines = async (path: string): Promise<string[]> =>
  (await Bun.file(path).text()).split("\n").filter(Boolean);

const baseline = await lines(baselinePath);
const candidate = await lines(candidatePath);

const counts = (entries: string[]) => {
  const map = new Map<string, number>();

  for (const entry of entries) {
    map.set(entry, (map.get(entry) ?? 0) + 1);
  }

  return map;
};

const describe = (line: string) => {
  const entry = JSON.parse(line) as { sql: string; parameters: unknown[] };

  return `${entry.sql}\n  parameters: ${JSON.stringify(entry.parameters)}`;
};

let firstDifference = -1;

for (
  let index = 0;
  index < Math.max(baseline.length, candidate.length);
  index++
) {
  if (baseline[index] !== candidate[index]) {
    firstDifference = index;
    break;
  }
}

if (firstDifference === -1) {
  console.log(`identical: ${baseline.length} compilations`);
  process.exit(0);
}

const expected = counts(baseline);
const received = counts(candidate);
const missing: string[] = [];
const extra: string[] = [];

for (const [line, count] of expected) {
  if ((received.get(line) ?? 0) < count) {
    missing.push(line);
  }
}

for (const [line, count] of received) {
  if ((expected.get(line) ?? 0) < count) {
    extra.push(line);
  }
}

if (!missing.length && !extra.length) {
  console.log(
    `same multiset, different order: ${baseline.length} compilations (first reorder at line ${firstDifference + 1})`,
  );
  process.exit(0);
}

console.error(
  `DIFFERENT: ${missing.length} compilations missing, ${extra.length} unexpected (first difference at line ${firstDifference + 1})`,
);

for (const line of missing.slice(0, 3)) {
  console.error(`\n--- expected ---\n${describe(line)}`);
}

for (const line of extra.slice(0, 3)) {
  console.error(`\n+++ received +++\n${describe(line)}`);
}

process.exit(1);
