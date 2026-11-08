import { expect, test } from "bun:test";
import { schema, table, int, text } from "../../../packages/runtime/src";

const posts = table({ id: int.auto, tenantId: int, title: text.unique });

test("$scope() callbacks run every time a query or write is built", () => {
  let tenantId = 1;
  const database = schema({ posts }, { executor: async () => [] });
  const scoped = database.$scope({
    posts: (post) => post.tenantId.is(tenantId),
  });
  const snapshot = () => ({
    select: scoped.posts((post) => ({ id: post.id })).toSQL().parameters,
    lookup: scoped.posts.byId(7).toSQL().parameters,
    update: scoped.posts
      .update({ title: "x" })
      .where((post) => post.id.is(7))
      .toSQL().parameters,
    remove: scoped.posts
      .delete()
      .where((post) => post.id.is(7))
      .toSQL().parameters,
    upsert: scoped.posts
      .insert({ tenantId, title: "x" })
      .onConflict("title")
      .doUpdate({ title: "y" })
      .toSQL().parameters,
  });

  expect(snapshot()).toEqual({
    select: [1],
    lookup: [1, 7],
    update: ["x", 1, 7],
    remove: [1, 7],
    upsert: [1, "x", "y", 1],
  });

  tenantId = 2;
  expect(snapshot()).toEqual({
    select: [2],
    lookup: [2, 7],
    update: ["x", 2, 7],
    remove: [2, 7],
    upsert: [2, "x", "y", 2],
  });
});

test("cached column handles are frozen even without SYMMETRIA_FREEZE", () => {
  // The unit suite runs with SYMMETRIA_FREEZE=1; production does not.
  const script = `
    import { schema, table, int, text } from ${JSON.stringify(`${import.meta.dir}/../../../packages/runtime/src`)};
    const database = schema({ posts: table({ id: int.auto, title: text }) }, { executor: async () => [] });
    let captured;
    database.posts((post) => { captured = post.id; return { id: post.id }; });
    let shared = false;
    database.posts((post) => { shared = post.id === captured; return { id: post.id }; });
    const tools = [];
    database.posts((post, helpers) => { tools.push(Object.getPrototypeOf(helpers)); return { id: post.id }; });
    console.log(JSON.stringify({
      shared,
      handle: Object.isFrozen(captured),
      tools: Object.isFrozen(tools[0]),
      prototype: Object.isFrozen(Object.getPrototypeOf(database.posts)),
    }));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, SYMMETRIA_FREEZE: "" },
  });

  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual({
    shared: true,
    handle: true,
    tools: true,
    prototype: true,
  });
});

test("count() and exists() on a bare scoped table or alias read the current scope", async () => {
  let tenantId = 1;
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const database = schema(
    { posts },
    {
      executor: async (query) => {
        statements.push(query);

        return query.sql.includes("COUNT(*)") ? [{ count: "0" }] : [];
      },
    },
  );
  const scoped = database.$scope({
    posts: (post) => post.tenantId.is(tenantId),
  });
  const alias = scoped.posts.as("p");
  const run = async () => {
    statements.length = 0;
    await scoped.posts.count();
    await scoped.posts.exists();
    await alias.count();
    await alias.exists();
    await scoped.posts({ where: (post) => post.id.above(0) }).count();

    return statements.map((statement) => statement.parameters[0]);
  };

  expect(await run()).toEqual([1, 1, 1, 1, 1]);
  tenantId = 2;
  expect(await run()).toEqual([2, 2, 2, 2, 2]);
  expect(statements[2]!.sql).toContain('FROM "posts" AS "p"');
});
