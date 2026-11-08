import { SQL } from "bun";
import { DATABASE_URL } from "../config";
import { load, type Library } from "../adapters";
import type { Statement } from "../adapters/types";
import { SCENARIOS, applicable, operation, writes } from "../harness/workload";
import { writeJson } from "../harness/artifacts";
import { assertDisposable, seed } from "../seed";

const library = process.argv[2] as Library;
const sql = new SQL(DATABASE_URL, { max: 1 });
let statements: Statement[] = [];
const bench = await load(library, (statement) => statements.push(statement));
const captures: Record<string, unknown> = {};

try {
  await assertDisposable(sql);

  for (const scenario of SCENARIOS.filter(
    (scenario) => applicable(library, scenario) && scenario !== "buildNested",
  )) {
    statements = [];
    await operation(bench, scenario)();

    if (!statements.length) {
      throw new Error(`no SQL captured for ${library}/${scenario}`);
    }

    const captured = [];

    for (const statement of statements) {
      // EXPLAIN ANALYZE is read-only here; writes retain SQL without replaying it.
      const plan =
        !writes(scenario) && /^\s*SELECT\b/i.test(statement.sql)
          ? Array.from(
              await sql.unsafe(
                `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${statement.sql}`,
                [...statement.parameters],
              ),
            )
          : null;
      captured.push({ ...statement, plan });
    }

    captures[scenario] = captured;

    if (writes(scenario)) {
      await seed(sql);
    }
  }

  await writeJson(process.argv[3]!, captures);
} finally {
  await bench.close();
  await sql.close();
}
