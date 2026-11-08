import { SQL } from "bun";
import { DATABASE_URL } from "../config";
import { verify } from "../harness/correctness";
import { load, LIBRARIES, type Library } from "../adapters";
import { assertDisposable } from "../seed";

const library = process.argv[2] as Library;

if (!LIBRARIES.includes(library)) {
  throw new Error(
    "verify.ts requires a library; use src/run.ts to create and seed a disposable database",
  );
}

const sql = new SQL(DATABASE_URL, { max: 1, bigint: true });
const bench = await load(library);

try {
  await assertDisposable(sql);
  const result = await verify(bench, sql);
  await Bun.write(process.argv[3]!, JSON.stringify({ library, ...result }));
  console.log(`correctness: ${library}: ${result.assertions} checks passed`);
} finally {
  await bench.close();
  await sql.close();
}
