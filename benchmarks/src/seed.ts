import { SQL } from "bun";
import { DATABASE_URL, USERS, POSTS, TAGS } from "./config";

export const assertDisposable = async (sql: SQL): Promise<void> => {
  const [row] = await sql.unsafe("SELECT current_database() AS name");

  if (!/^symmetria_bench_[a-z0-9_]+$/.test(row.name)) {
    throw new Error(
      "benchmark setup only operates on a disposable symmetria_bench_* database created by run.ts",
    );
  }
};

/** Reuse table identities so cached query plans remain valid between write phases. */
export const seed = async (sql: SQL, create = false): Promise<void> => {
  await assertDisposable(sql);

  if (create) {
    const ddl = await Bun.file(
      new URL("../fixtures/postgres.sql", import.meta.url),
    ).text();

    for (const statement of ddl
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await sql.unsafe(statement);
    }
  } else {
    await sql.unsafe(
      "TRUNCATE post_tags, posts, tags, users RESTART IDENTITY CASCADE",
    );
  }

  await sql.unsafe("SELECT setseed(0.42)");
  await sql.unsafe(
    `INSERT INTO users (email, name) SELECT 'user' || g || '@example.test', 'User ' || g FROM generate_series(1, ${USERS}) g`,
  );
  await sql.unsafe(
    `INSERT INTO tags (label) SELECT 'tag-' || g FROM generate_series(1, ${TAGS}) g`,
  );
  await sql.unsafe(`INSERT INTO posts (slug, title, author_id, editor_id, state, views, created_at)
    SELECT 'post-' || g, 'Post ' || g,
      1 + (g::bigint * 7919) % ${USERS - 1},
      CASE WHEN g % 3 = 0 THEN 1 + (g::bigint * 104729) % ${USERS} END,
      CASE WHEN random() < 0.7 THEN 'published' ELSE 'draft' END,
      CASE WHEN g % 97 = 0 OR g = 5 THEN 9007199254740993::bigint + g ELSE floor(random() * 100000)::bigint END,
      TIMESTAMPTZ '2026-01-01 00:00:00+00' - (g % 365) * INTERVAL '1 day'
    FROM generate_series(1, ${POSTS}) g`);
  await sql.unsafe(`INSERT INTO post_tags (post_id, tag_id)
    SELECT DISTINCT p.id, 1 + floor(random() * ${TAGS})::int
    FROM posts p, generate_series(1, 3) WHERE p.id % 13 <> 0
    ON CONFLICT DO NOTHING`);
  await sql.unsafe("VACUUM ANALYZE");
};

if (import.meta.main) {
  const sql = new SQL(DATABASE_URL, { max: 1 });

  try {
    await seed(sql, true);
  } finally {
    await sql.close();
  }
}
