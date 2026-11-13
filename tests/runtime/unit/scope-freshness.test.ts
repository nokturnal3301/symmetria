import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  prepare,
} from "../../../packages/runtime/src";

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

  // Writes check their rows against the scope: the conflict guard of the
  // upsert and the RETURNING checks bind the tenant as well.
  expect(snapshot()).toEqual({
    select: [1],
    lookup: [1, 7],
    update: ["x", 1, 7, 1],
    remove: [1, 7],
    upsert: [1, "x", "y", 1, 1],
  });

  tenantId = 2;
  expect(snapshot()).toEqual({
    select: [2],
    lookup: [2, 7],
    update: ["x", 2, 7, 2],
    remove: [2, 7],
    upsert: [2, "x", "y", 2, 2],
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

/** A scoped schema whose executor records statements; `tenant` and `tenants` drive the scopes. */
const recordingScope = () => {
  const authors = table({ id: int.auto, tenantId: int, name: text });
  const articles = table({
    id: int.auto,
    tenantId: int,
    title: text.unique,
    author: authors,
  });
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const state = { tenant: 1, tenants: [1] };
  const database = schema(
    { authors, articles },
    {
      executor: async (query) => {
        statements.push(query);

        return query.sql.includes("COUNT(*)")
          ? [{ count: "0" }]
          : query.sql.startsWith("INSERT")
            ? { rows: [], affectedRows: 1 }
            : [];
      },
    },
  );
  const scoped = database.$scope({
    authors: (author) => author.tenantId.is(state.tenant),
    articles: (article) => article.tenantId.in(state.tenants),
  });

  return { scoped, state, statements, last: () => statements.at(-1)! };
};

test("reused and prepared queries bind the current $scope() values at every execution", async () => {
  const { scoped, state, last } = recordingScope();
  const reused = scoped.articles((article) => ({
    title: article.title,
    author: article.author((author) => ({ name: author.name })),
    count: article.author.count(),
  }));
  const prepared = prepare({ id: int }, (parameters) =>
    scoped.articles((article) => ({ title: article.title }), {
      where: (article) => article.id.is(parameters.id),
    }),
  );
  const lookup = scoped.articles.byId(3);
  const rename = scoped.articles
    .update({ title: "x" })
    .where((article) => article.id.is(3));
  const preparedRename = prepare({ id: int }, (parameters) =>
    scoped.authors.byId(parameters.id).update({ name: "x" }),
  );
  const everything = scoped.authors.delete().all();
  const upsert = scoped.articles
    .insert({ tenantId: 1, title: "t", authorId: 1 })
    .onConflict("title")
    .doUpdate("tenantId");
  const run = async () => {
    const parameters: Record<string, readonly unknown[]> = {};
    await reused;
    parameters.reused = last().parameters;
    await reused.first();
    parameters.first = last().parameters;
    await prepared({ id: 5 });
    parameters.prepared = last().parameters;
    await prepared.count({ id: 5 });
    parameters.preparedCount = last().parameters;
    await lookup.maybeOne();
    parameters.lookup = last().parameters;
    await lookup.update({ title: "y" });
    parameters.lookupUpdate = last().parameters;
    await rename;
    parameters.rename = last().parameters;
    await preparedRename({ id: 9 });
    parameters.preparedRename = last().parameters;
    await everything;
    parameters.everything = last().parameters;
    await upsert.execute().catch(() => undefined);
    parameters.upsert = last().parameters;
    parameters.toSQL = reused.toSQL().parameters;

    return parameters;
  };

  const first = await run();
  state.tenant = 2;
  state.tenants = [2];
  const second = await run();

  // The tenant comes first (parameters of nested objects and counts follow).
  expect(first).toEqual({
    reused: [1, 1, 1],
    first: [1, 1, 1],
    prepared: [1, 5],
    preparedCount: [1, 5],
    lookup: [1, 3],
    lookupUpdate: ["y", 1, 3, 1],
    rename: ["x", 1, 3, 1],
    preparedRename: ["x", 1, 9, 1],
    everything: [1],
    upsert: [1, "t", 1, 1, 1],
    toSQL: [1, 1, 1],
  });
  expect(second).toEqual({
    reused: [2, 2, 2],
    first: [2, 2, 2],
    prepared: [2, 5],
    preparedCount: [2, 5],
    lookup: [2, 3],
    lookupUpdate: ["y", 2, 3, 2],
    rename: ["x", 2, 3, 2],
    preparedRename: ["x", 2, 9, 2],
    everything: [2],
    upsert: [1, "t", 1, 2, 2],
    toSQL: [2, 2, 2],
  });
});

test("a $scope() callback whose SQL changes recompiles that execution", async () => {
  const { scoped, state, last } = recordingScope();
  const reused = scoped.articles((article) => ({ id: article.id }));
  const prepared = prepare({ id: int }, (parameters) =>
    scoped.articles((article) => ({ id: article.id }), {
      where: (article) => article.id.is(parameters.id),
    }),
  );

  await reused;
  expect(last().sql).toEndWith('WHERE "articles"."tenant_id" IN ($1)');
  state.tenants = [4, 5, 6];
  await reused;
  expect(last()).toMatchObject({ parameters: [4, 5, 6] });
  expect(last().sql).toEndWith('WHERE "articles"."tenant_id" IN ($1, $2, $3)');
  await prepared({ id: 8 });
  expect(last().parameters).toEqual([4, 5, 6, 8]);
  state.tenants = [];
  await prepared({ id: 8 });
  expect(last()).toMatchObject({ parameters: [8] });
  expect(last().sql).toContain("WHERE FALSE");
  state.tenants = [7];
  await reused;
  expect(last()).toMatchObject({ parameters: [7] });
  expect(last().sql).toEndWith('WHERE "articles"."tenant_id" IN ($1)');
});

test("$scope() filters inside subqueries and CTEs are refreshed too", async () => {
  const { scoped, state, last } = recordingScope();
  const visible = scoped.authors((author) => ({ id: author.id }), {
    where: (author) =>
      author.id.in(
        scoped.articles((article) => ({ authorId: article.authorId })),
      ),
  });
  const ranked = scoped
    .articles((article) => ({ id: article.id, title: article.title }))
    .cte("ranked");
  const fromCte = ranked((row) => ({ title: row.title }));

  await visible;
  expect(last().parameters).toEqual([1, 1]);
  await fromCte;
  expect(last().parameters).toEqual([1]);
  state.tenant = 3;
  state.tenants = [3];
  await visible;
  expect(last().parameters).toEqual([3, 3]);
  await fromCte;
  expect(last().parameters).toEqual([3]);
});
