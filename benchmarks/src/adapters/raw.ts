import { SQL } from "bun";
import { DATABASE_URL, POOL_SIZE } from "../config";
import type { Bench, Observer, Statement } from "./types";

const nestedSql = (pageFirst: boolean, keyset = false): string => {
  const page = `${keyset ? "WHERE id > $1" : ""} ORDER BY id LIMIT 50${keyset ? "" : " OFFSET $1"}`;

  return `SELECT u.id, u.name, COALESCE(p.posts, '[]'::json) AS posts
    FROM ${pageFirst ? `(SELECT id, name FROM users ${page})` : "users"} u
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('title', p.title, 'views', p.views::text, 'tags', COALESCE((
        SELECT json_agg(json_build_object('label', t.label))
        FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id
      ), '[]'::json)) ORDER BY p.created_at DESC, p.id DESC) AS posts
      FROM (SELECT id, title, views, created_at FROM posts WHERE author_id = u.id ORDER BY created_at DESC, id DESC LIMIT 3) p
    ) p ON TRUE
    ${!pageFirst && keyset ? "WHERE u.id > $1" : ""}
    ORDER BY u.id${pageFirst ? "" : ` LIMIT 50${keyset ? "" : " OFFSET $1"}`}`;
};

export const create = (pageFirst = false, observe?: Observer): Bench => {
  const client = new SQL(DATABASE_URL, { max: POOL_SIZE, bigint: true });

  const execute = (sql: string, parameters: unknown[] = []) => {
    observe?.({ sql, parameters });

    return client.unsafe(sql, parameters);
  };

  const compiled = (offset: number): Statement => ({
    sql: nestedSql(pageFirst),
    parameters: [offset],
  });

  return {
    name: pageFirst ? "Bun.SQL (page first)" : "Bun.SQL (direct LATERAL)",
    pointLookup: async (id) =>
      (
        await execute("SELECT id, email, name FROM users WHERE id = $1", [id])
      )[0],
    listJoin: () =>
      execute(
        "SELECT p.id, p.title, u.name AS author FROM posts p JOIN users u ON u.id = p.author_id WHERE p.state = $1 ORDER BY p.created_at DESC, p.id DESC LIMIT 20",
        ["published"],
      ),
    nested: (offset) => execute(nestedSql(pageFirst), [offset]),
    nestedKeyset: (afterId) => execute(nestedSql(pageFirst, true), [afterId]),
    insertOne: async (row) =>
      (
        await execute(
          "INSERT INTO posts (slug, title, author_id) VALUES ($1, $2, $3) RETURNING id",
          [row.slug, row.title, row.authorId],
        )
      )[0],
    insertMany: (rows) => {
      const values: unknown[] = [];
      const tuples = rows.map((row, index) => {
        values.push(row.slug, row.title, row.authorId);

        return `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`;
      });

      return execute(
        `INSERT INTO posts (slug, title, author_id) VALUES ${tuples.join(", ")}`,
        values,
      );
    },
    updateViews: async (id) =>
      (
        await execute(
          "UPDATE posts SET views = views + 1 WHERE id = $1 RETURNING views",
          [id],
        )
      )[0],
    buildNested: compiled,
    close: () => client.close(),
  };
};
