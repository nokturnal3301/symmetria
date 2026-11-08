import { SQL } from "bun";
import { seed } from "../seed";

export const fingerprint = async (
  sql: SQL,
): Promise<Record<string, { rows: number; hash: string }>> => {
  const result: Record<string, { rows: number; hash: string }> = {};

  for (const table of ["users", "posts", "tags", "post_tags"]) {
    const order = table === "post_tags" ? "post_id, tag_id" : "id";
    const [row] = await sql.unsafe(
      `SELECT count(*)::int AS rows, md5(string_agg(row_to_json(t)::text, E'\\n' ORDER BY ${order})) AS hash FROM ${table} t`,
    );
    result[table] = row;
  }

  return result;
};

export const database = async <T>(
  adminUrl: string,
  invoke: (
    url: string,
    dataset: Awaited<ReturnType<typeof fingerprint>>,
  ) => Promise<T>,
): Promise<T> => {
  const admin = new SQL(adminUrl, { max: 1 });
  const name = `symmetria_bench_${crypto.randomUUID().replaceAll("-", "")}`;
  let created = false;

  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const sql = new SQL(url.href, { max: 1 });
    let dataset: Awaited<ReturnType<typeof fingerprint>>;

    try {
      await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
      await seed(sql, true);
      dataset = await fingerprint(sql);
    } finally {
      await sql.close();
    }

    return await invoke(url.href, dataset);
  } finally {
    try {
      if (created) {
        await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    } finally {
      await admin.close();
    }
  }
};

export const statementCount = async (
  admin: SQL,
  databaseName: string,
): Promise<number> => {
  const [row] = await admin.unsafe(
    "SELECT COALESCE(sum(calls), 0)::text AS calls FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = $1) AND toplevel",
    [databaseName],
  );

  return Number(row.calls);
};
