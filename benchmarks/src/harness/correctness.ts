import assert from "node:assert/strict";
import type { SQL } from "bun";
import { POSTS, USERS } from "../config";
import type { Bench, InsertRow } from "../adapters/types";

type Row = Record<string, any>;

const object = (value: unknown): Row => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected a row",
  );

  return value as Row;
};

const array = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value), "expected rows");

  return Array.from(value);
};

export const exactInteger = (value: unknown): string => {
  assert.ok(
    typeof value === "bigint" ||
      (typeof value === "string" && /^-?\d+$/.test(value)) ||
      (typeof value === "number" && Number.isSafeInteger(value)),
    "unsafe integer decoding",
  );

  return BigInt(value as string | number | bigint).toString();
};

export const singleton = (value: unknown): Row => {
  if (Array.isArray(value)) {
    assert.equal(value.length, 1);

    return object(value[0]);
  }

  return object(value);
};

export const canonicalNested = (value: unknown) =>
  array(value).map((entry) => {
    const user = object(entry);

    return {
      id: user.id,
      name: user.name,
      posts: array(user.posts).map((entry) => {
        const post = object(entry);
        const tags = array(post.tags ?? post.postTags)
          .map((entry) => {
            const tag = object(entry);
            const label = (tag.tag ? object(tag.tag) : tag).label;
            assert.equal(typeof label, "string");

            return label as string;
          })
          .sort(); // No tag ordering is requested. Parent/post ordering is preserved.

        return { title: post.title, views: exactInteger(post.views), tags };
      }),
    };
  });

/** Independent oracle: flat rows assembled in JS; no adapter's relation SQL is reused. */
export const oracle = async (sql: SQL) => {
  const users = Array.from(
    await sql.unsafe("SELECT id, email, name FROM users ORDER BY id"),
  ) as Row[];
  const posts = Array.from(
    await sql.unsafe(
      "SELECT id, title, author_id, state, views::text AS views FROM posts ORDER BY created_at DESC, id DESC",
    ),
  ) as Row[];
  const links = await sql.unsafe(
    "SELECT pt.post_id, t.label FROM post_tags pt JOIN tags t ON t.id = pt.tag_id",
  );
  const tags = new Map<number, string[]>();

  for (const link of links) {
    const labels = tags.get(link.post_id) ?? [];
    labels.push(link.label);
    tags.set(link.post_id, labels);
  }

  const children = new Map<number, Row[]>();

  for (const post of posts) {
    const rows = children.get(post.author_id) ?? [];

    if (rows.length < 3) {
      rows.push({
        title: post.title,
        views: post.views,
        tags: (tags.get(post.id) ?? []).sort(),
      });
    }

    children.set(post.author_id, rows);
  }

  const nested = users.map((user) => ({
    id: user.id,
    name: user.name,
    posts: children.get(user.id) ?? [],
  }));
  assert.ok(
    nested.some((user) =>
      user.posts.some(
        (post) => BigInt(post.views) > BigInt(Number.MAX_SAFE_INTEGER),
      ),
    ),
  );
  assert.ok(
    nested.some((user) => user.posts.some((post) => post.tags.length === 0)),
  );
  assert.deepEqual(nested.at(-1)?.posts, []);

  return {
    users,
    nested,
    list: posts
      .filter((post) => post.state === "published")
      .slice(0, 20)
      .map((post) => ({
        id: post.id,
        title: post.title,
        author: users[post.author_id - 1]!.name,
      })),
  };
};

export const verify = async (
  bench: Bench,
  sql: SQL,
): Promise<{ assertions: number }> => {
  const expected = await oracle(sql);
  let assertions = 0;

  const equal = (actual: unknown, expected: unknown, message: string) => {
    assert.deepEqual(actual, expected, `${bench.name}: ${message}`);
    assertions++;
  };

  for (const id of [1, 7, USERS, 0, USERS + 1]) {
    equal(
      (await bench.pointLookup(id)) ?? null,
      expected.users.find((user) => user.id === id) ?? null,
      `lookup ${id}`,
    );
  }

  const list = array(await bench.listJoin()).map((entry) => {
    const row = object(entry);

    return {
      id: row.id,
      title: row.title,
      author:
        typeof row.author === "string" ? row.author : object(row.author).name,
    };
  });
  equal(list, expected.list, "list ordering");

  for (const offset of [0, 49, 1000, 1900, 1950, 1999, 2000]) {
    equal(
      canonicalNested(await bench.nested(offset)),
      expected.nested.slice(offset, offset + 50),
      `offset ${offset}`,
    );
    equal(
      canonicalNested(await bench.nestedKeyset(offset)),
      expected.nested.filter((user) => user.id > offset).slice(0, 50),
      `keyset ${offset}`,
    );
  }

  if (bench.buildNested) {
    const query = bench.buildNested(1900);
    const rows = await sql.unsafe(query.sql, [...query.parameters]);
    equal(
      Array.from(rows, (row) => object(row).id),
      expected.nested.slice(1900, 1950).map((user) => user.id),
      "compiled SQL parent page",
    );
  }

  const one: InsertRow = {
    slug: "verify-one",
    title: "Inserted ' λ",
    authorId: USERS,
  };
  const inserted = singleton(await bench.insertOne(one));
  equal(inserted, { id: POSTS + 1 }, "insert returning");
  const many = Array.from({ length: 500 }, (_, index) => ({
    slug: `verify-many-${index}`,
    title: `Batch ${index}`,
    authorId: (index % USERS) + 1,
  }));
  await bench.insertMany(many);
  const stored = Array.from(
    await sql.unsafe(
      'SELECT slug, title, author_id AS "authorId", state, views::text AS views FROM posts WHERE id > $1 ORDER BY id',
      [POSTS],
    ),
  );
  equal(
    stored,
    [one, ...many].map((row) => ({ ...row, state: "draft", views: "0" })),
    "all 501 persisted rows and defaults",
  );
  const initial = 9007199254740998n;
  equal(
    exactInteger(singleton(await bench.updateViews(5)).views),
    (initial + 1n).toString(),
    "bigint update returning",
  );
  const increments = await Promise.all(
    Array.from({ length: 16 }, () => bench.updateViews(5)),
  );
  equal(
    increments.map((value) => exactInteger(singleton(value).views)).sort(),
    Array.from({ length: 16 }, (_, i) =>
      (initial + BigInt(i + 2)).toString(),
    ).sort(),
    "atomic concurrent increments",
  );
  const [updated] = await sql.unsafe(
    "SELECT views::text AS views FROM posts WHERE id = 5",
  );
  equal(updated.views, (initial + 17n).toString(), "persisted bigint update");

  return { assertions };
};
