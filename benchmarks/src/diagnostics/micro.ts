/**
 * Client-side cost of Symmetria without a database: a stub driver returns canned
 * rows, so the numbers cover query building, compilation and result decoding only.
 * Run before and after a change: `bun run --cwd benchmarks micro`.
 */
import {
  schema,
  table,
  junction,
  int,
  text,
  bigint,
  timestamptz,
  prepare,
} from "../../../packages/runtime/src/index";

const users = table({ id: int.auto, email: text.unique, name: text });
const posts = table({
  id: int.auto,
  slug: text.unique,
  title: text,
  author: users.index,
  state: text.default("draft"),
  views: bigint.default(0n),
  createdAt: timestamptz.now,
});
const tags = table({ id: int.auto, label: text.unique });
const postTags = junction({
  post: posts.onDelete.cascade,
  tag: tags.onDelete.cascade,
});

const nestedRows = Array.from({ length: 50 }, (_, i) => ({
  id: i + 101,
  name: `User ${i + 101}`,
  posts: Array.from({ length: 3 }, (_, j) => ({
    title: `Post ${j}`,
    views: String(1000 + j),
    tags: [{ label: "a" }, { label: "b" }, { label: "c" }],
  })),
}));
const pointRows = [{ id: 7, email: "user7@example.test", name: "User 7" }];
const listRows = Array.from({ length: 20 }, (_, i) => ({
  id: i,
  title: `Post ${i}`,
  author: `User ${i}`,
}));
let canned: Record<string, unknown>[] = nestedRows;
const driver = {
  execute: async () => ({ rows: canned, affectedRows: canned.length }),
  close: async () => {},
};
const db = schema({ users, posts, tags, postTags }, { driver });

const nested = (after: number) =>
  db.users((user) => ({
    id: user.id,
    name: user.name,
    posts: user.posts((post) => ({
      title: post.title,
      views: post.views,
      tags: post.tags((tag) => ({ label: tag.label })),
      $orderBy: [post.createdAt.descending, post.id.descending],
      $limit: 3,
    })),
    $where: user.id.above(after),
    $orderBy: user.id.ascending,
    $limit: 50,
  }));

const list = () =>
  db.posts((post) => ({
    id: post.id,
    title: post.title,
    author: post.author.name,
    $where: post.state.is("published"),
    $orderBy: [post.createdAt.descending, post.id.descending],
    $limit: 20,
  }));

const nestedPrepared = prepare({ after: int }, (p) => nested(p.after));
const pointPrepared = prepare({ id: int }, (p) =>
  db.users((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    $where: u.id.is(p.id),
  })),
);

const rows: string[] = [];

const report = (label: string, samples: number[]) => {
  samples.sort((a, b) => a - b);
  const p50 = samples[samples.length >> 1]! * 1000;
  const p90 = samples[Math.floor(samples.length * 0.9)]! * 1000;
  rows.push(`| ${label} | ${p50.toFixed(1)} | ${p90.toFixed(1)} |`);
};

const timeAsync = async (
  label: string,
  fn: () => Promise<unknown>,
  n = 4000,
) => {
  for (let i = 0; i < 1000; i++) {
    await fn();
  }

  const samples: number[] = [];

  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }

  report(label, samples);
};

const timeSync = (label: string, fn: () => unknown, n = 4000) => {
  for (let i = 0; i < 1000; i++) {
    fn();
  }

  const samples: number[] = [];

  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }

  report(label, samples);
};

const reusable = nested(100);
timeSync("nested: build", () => nested(100));
timeSync("nested: build + toSQL", () => nested(100).toSQL());
timeSync("nested: toSQL on existing query", () => reusable.toSQL());
await timeAsync("nested: build + execute + decode", () => nested(100));
await timeAsync("nested: execute reused query", () => reusable.execute());
await timeAsync("nested: prepared execute", () =>
  nestedPrepared.execute({ after: 100 }),
);
canned = listRows;
timeSync("list join: build", () => list());
await timeAsync("list join: build + execute", () => list());
canned = pointRows;
await timeAsync("point: byId(7).one()", () => db.users.byId(7).one());
await timeAsync("point: byId(7) await", () => db.users.byId(7));
await timeAsync("point: shape $where", () =>
  db.users((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    $where: u.id.is(7),
  })),
);
await timeAsync("point: prepared execute", () =>
  pointPrepared.execute({ id: 7 }),
);
await timeAsync("stub driver alone", () => driver.execute());

console.log(
  "| Scenario | p50 µs | p90 µs |\n| --- | ---: | ---: |\n" + rows.join("\n"),
);
