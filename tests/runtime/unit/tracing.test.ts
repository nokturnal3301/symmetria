import { beforeEach, expect, test } from "bun:test";
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  createDatabase,
  createProfiler,
  schema,
  table,
  int,
  text,
  many,
  one,
} from "../../../packages/runtime/src";
import { createPostgresDriver } from "../../../packages/runtime/src/driver/pool";
import type {
  Driver,
  TransactionDriver,
} from "../../../packages/runtime/src/query/plan/types";
import { traced } from "../../../packages/runtime/src/entries/opentelemetry";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("symmetria-test");

const declared = schema({
  users: table({ id: int.auto, name: text }),
  "audit.events": table({ id: int.auto, note: text }),
});

/** A driver that answers every statement with one row, or fails on demand. */
const stub = (fail?: (sql: string) => unknown): Driver => {
  const execute: Driver["execute"] = async ({ sql }) => {
    const error = fail?.(sql);

    if (error) {
      throw error;
    }

    return { rows: [{ id: 1, name: "Ada" }], affectedRows: 1 };
  };
  const scoped: TransactionDriver = {
    execute,
    transaction: (callback) => callback(scoped),
  };

  return {
    execute,
    close: async () => {},
    transaction: (callback) => callback(scoped),
  };
};

const spans = () =>
  exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    parent: exporter
      .getFinishedSpans()
      .find(
        (other) =>
          other.spanContext().spanId === span.parentSpanContext?.spanId,
      )?.name,
    attributes: span.attributes,
    status: span.status.code,
  }));

beforeEach(() => exporter.reset());

test("every statement is a client span named after its operation and table", async () => {
  const database = createDatabase({
    schema: declared,
    driver: traced(stub(), { tracer, attributes: { "db.namespace": "app" } }),
  });

  await tracer.startActiveSpan("GET /users", async (request) => {
    await database.users((user) => ({ name: user.name }), {
      where: (user) => user.name.is("Ada"),
    });
    await database.users.insert({ name: "secret value" });
    request.end();
  });

  const [select, insert] = exporter.getFinishedSpans();

  expect(select!.kind).toBe(SpanKind.CLIENT);
  expect(spans().slice(0, 2)).toEqual([
    {
      name: "SELECT users",
      parent: "GET /users",
      attributes: {
        "db.system.name": "postgresql",
        "db.namespace": "app",
        "db.operation.name": "SELECT",
        "db.query.summary": "SELECT users",
        "db.collection.name": "users",
        "db.query.text":
          'SELECT "users"."name" AS "name"\nFROM "users" AS "users"\nWHERE "users"."name" = $1',
        "db.response.returned_rows": 1,
      },
      status: SpanStatusCode.UNSET,
    },
    expect.objectContaining({ name: "INSERT users", parent: "GET /users" }),
  ]);
  // Values travel as parameters and never reach a span.
  expect(JSON.stringify(insert!.attributes)).not.toContain("secret value");
});

test("statements of a transaction are children of its span", async () => {
  const database = createDatabase({
    schema: declared,
    driver: traced(stub(), { tracer, text: false }),
  });

  await database.$transaction(async (transaction) => {
    await transaction.users.insert({ name: "Ada" });
    await transaction.$transaction(async (nested) => {
      await nested.users.byId(1).delete();
    });
  });

  expect(
    spans().map(({ name, parent, attributes }) => ({
      name,
      parent,
      text: "db.query.text" in attributes,
    })),
  ).toEqual([
    { name: "INSERT users", parent: "transaction", text: false },
    { name: "DELETE users", parent: "savepoint", text: false },
    { name: "savepoint", parent: "transaction", text: false },
    { name: "transaction", parent: undefined, text: false },
  ]);
});

test("a failed statement marks its span and the transaction around it", async () => {
  const refused = Object.assign(
    new Error('invalid input value for enum: "ada@example.test"'),
    { code: "23505", constraint: "users_email_key" },
  );
  const database = createDatabase({
    schema: declared,
    driver: traced(
      stub((sql) => (sql.startsWith("INSERT") ? refused : undefined)),
      { tracer },
    ),
  });

  await expect(
    database.$transaction((transaction) =>
      transaction.users.insert({ name: "Ada" }),
    ),
  ).rejects.toThrow("ada@example.test");

  const [statement, transaction] = exporter.getFinishedSpans();

  expect(statement!.status.code).toBe(SpanStatusCode.ERROR);
  expect(statement!.attributes).toMatchObject({
    "db.response.status_code": "23505",
    "error.type": "23505",
  });
  expect(statement!.events.map((event) => event.name)).toEqual(["exception"]);
  expect(transaction!.name).toBe("transaction");
  expect(transaction!.status.code).toBe(SpanStatusCode.ERROR);
  // PostgreSQL's message may quote a value; the spans name the error only.
  expect(statement!.status.message).toBe(
    'Error (23505) on constraint "users_email_key"',
  );
  expect(
    JSON.stringify(
      exporter.getFinishedSpans().map((span) => [span.status, span.events]),
    ),
  ).not.toContain("ada@example.test");
});

test("a table in another schema keeps its qualified name", async () => {
  const database = createDatabase({
    schema: declared,
    driver: traced(stub(), { tracer }),
  });

  await database["audit.events"]((event) => ({ note: event.note }));

  expect(spans()[0]!.attributes["db.collection.name"]).toBe("audit.events");
});

test("the profiler still sees queries through a traced driver", async () => {
  const profiler = createProfiler();
  const database = createDatabase({
    schema: declared,
    driver: traced(profiler.driver(stub()), { tracer }),
  });

  await profiler.trace("job", () =>
    database.users((user) => ({ name: user.name })),
  );

  const [request] = profiler.snapshot();

  expect(request!.queries).toHaveLength(1);
  expect(request!.queries[0]!.kind).toBe("select");
  expect(spans().map((span) => span.name)).toEqual(["SELECT users"]);
  exporter.reset();

  // A cursor's name is new for every stream; its spans carry the table.
  for await (const _ of database
    .users((user) => ({ name: user.name }))
    .stream({ size: 2 })) {
    // one row
  }

  expect(
    spans()
      .map((span) => span.name)
      .filter((name) => name !== "transaction" && !name.startsWith("SET")),
  ).toEqual(["DECLARE users", "FETCH users", "CLOSE users"]);
});

test("a span is named after the statement's own table, and a cursor after its stream", async () => {
  const writers = table({ id: int.auto, name: text, posts: many });
  const relations = schema({
    users: writers,
    posts: table({ id: int.auto, title: text, author: one(writers.posts) }),
  });
  const database = createDatabase({
    schema: relations,
    driver: traced(stub(), { tracer }),
  });

  // The nested read and the count are subqueries inside the users statement.
  await database.users((user) => ({
    name: user.name,
    posts: user.posts((post) => ({ title: post.title })),
    total: user.posts.count(),
  }));
  expect(spans().map((span) => span.name)).toEqual(["SELECT users"]);
});

test("a CTE read is named after the table the CTE reads, and a $batch() after its first read", async () => {
  const relations = schema({
    posts: table({ id: int.auto, title: text }),
    nodes: table({ id: int.auto, parentId: int.nullable, name: text }),
  });
  const execute: Driver["execute"] = async ({ sql }) =>
    sql.startsWith("SELECT (SELECT")
      ? { rows: [{ q0: [{ count: "1" }], q1: [] }], affectedRows: 1 }
      : { rows: [], affectedRows: 0 };
  const database = createDatabase({
    schema: relations,
    driver: traced({ execute, close: async () => {} }, { tracer }),
  });

  await database
    .posts((post) => ({ id: post.id, title: post.title }))
    .cte("ranked_posts")((ranked) => ({ title: ranked.title }));
  await database
    .nodes((node) => ({ id: node.id, name: node.name }), {
      where: (node) => node.id.is(1),
    })
    .recursive("tree", (tree) =>
      database.nodes((node, { innerJoin }) => {
        innerJoin(tree, (parent) => node.parentId.is(parent.id));

        return { id: node.id, name: node.name };
      }),
    )((node) => ({ id: node.id }));
  await database.$batch((batch) => [
    batch.posts.count(),
    batch.nodes((node) => ({ id: node.id })),
  ]);

  expect(
    spans().map((span) => [
      span.name,
      span.attributes["db.operation.name"],
      span.attributes["db.collection.name"],
    ]),
  ).toEqual([
    ["SELECT posts", "SELECT", "posts"],
    ["SELECT nodes", "SELECT", "nodes"],
    ["SELECT posts", "SELECT", "posts"],
  ]);

  // Raw statements without a table of their own name none, as before.
  exporter.reset();
  const raw = traced({ execute, close: async () => {} }, { tracer });

  for (const sql of [
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM "users")`,
    `SELECT coalesce((SELECT "name" FROM "users" LIMIT 1), 'x')`,
    `(SELECT 1 FROM "users") UNION (SELECT 2 FROM "posts")`,
  ]) {
    await raw.execute({ sql, parameters: [] });
  }

  expect(
    spans().map((span) => [span.name, span.attributes["db.collection.name"]]),
  ).toEqual([
    ["SELECT", undefined],
    ["SELECT", undefined],
    ["QUERY", undefined],
  ]);
});

/** The span name and table of each raw statement, through a traced driver. */
const named = async (statements: readonly string[]) => {
  exporter.reset();
  const driver = traced(stub(), { tracer });

  for (const sql of statements) {
    await driver.execute({ sql, parameters: [] });
  }

  return spans().map((span) => [
    span.name,
    span.attributes["db.collection.name"],
  ]);
};

test("a CTE name is resolved as PostgreSQL resolves it, never reported as the table", async () => {
  const chain = Array.from(
    { length: 1500 },
    (_, index) => `c${index + 1} AS (SELECT * FROM c${index})`,
  ).join(", ");

  expect(
    await named([
      // Unquoted names are folded to lower case; a quoted one keeps its case.
      'WITH Ranked AS (SELECT * FROM "posts") SELECT * FROM ranked',
      'WITH ranked AS (SELECT * FROM "posts") SELECT * FROM RANKED',
      'WITH "Ranked" AS (SELECT * FROM "posts") SELECT * FROM ranked',
      // A recursive CTE's own name in its body is the CTE, which reads no table.
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT * FROM t",
      'WITH RECURSIVE tree AS (SELECT id FROM "nodes" UNION ALL SELECT n.id FROM "nodes" n JOIN tree ON true) SELECT * FROM tree',
      "WITH RECURSIVE t AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM t WHERE n < 3) SEARCH DEPTH FIRST BY n SET ord SELECT * FROM t",
      // A CTE of a subquery, and a table-less CTE read twice.
      'SELECT (WITH z AS (SELECT * FROM "posts") SELECT count(*) FROM z) AS "q0"',
      'WITH b AS (SELECT 1 AS n) SELECT (SELECT n FROM b) AS "p", (SELECT n FROM b) AS "q"',
      // A plain WITH list: a body sees only the CTEs before it.
      'WITH a AS (SELECT * FROM b), b AS (SELECT * FROM "posts") SELECT * FROM a',
      'WITH a AS (SELECT * FROM "a") SELECT * FROM a',
      // An inner WITH list hides an outer name.
      'WITH x AS (SELECT * FROM "posts") SELECT * FROM (WITH x AS (SELECT * FROM "users") SELECT * FROM x) AS s',
      `WITH c0 AS (SELECT * FROM "posts"), ${chain} SELECT * FROM c1500`,
      'EXPLAIN (FORMAT JSON) WITH x AS (SELECT * FROM "posts") SELECT * FROM x',
    ]),
  ).toEqual([
    ["SELECT posts", "posts"],
    ["SELECT posts", "posts"],
    ["SELECT ranked", "ranked"],
    ["SELECT", undefined],
    ["SELECT nodes", "nodes"],
    ["SELECT", undefined],
    ["SELECT posts", "posts"],
    ["SELECT", undefined],
    ["SELECT b", "b"],
    ["SELECT a", "a"],
    ["SELECT users", "users"],
    ["SELECT posts", "posts"],
    ["EXPLAIN posts", "posts"],
  ]);
});

test("a statement made only of subqueries is named after its first read, whatever its aliases", async () => {
  const relations = schema({
    users: table({ id: int.auto, name: text }),
    posts: table({ id: int.auto, title: text }),
  });
  const database = createDatabase({
    schema: relations,
    driver: traced(
      {
        execute: async () => ({ rows: [{ q0: [], q1: [] }], affectedRows: 1 }),
        close: async () => {},
      },
      { tracer },
    ),
  });

  await database.$batch((batch) => [
    batch.users((user) => ({ id: user.id })),
    batch.posts((post) => ({ id: post.id })),
  ]);
  expect(spans().map((span) => span.name)).toEqual(["SELECT users"]);

  expect(
    await named([
      'SELECT (SELECT count(*) FROM "users") AS m',
      "select (select count(*) from users) as m",
      'SELECT (SELECT count(*) FROM "users") AS total, (SELECT count(*) FROM "posts") AS posts',
      'SELECT (SELECT count(*) FROM "users") m',
      'SELECT ((SELECT count(*) FROM "users")) AS m;',
      'DECLARE "c" CURSOR FOR SELECT (SELECT count(*) FROM "users") AS m',
      // More than subqueries: no table, as before.
      'SELECT (SELECT count(*) FROM "users") + 1 AS m',
      'SELECT (SELECT count(*) FROM "users") AS m FOR UPDATE',
    ]),
  ).toEqual([
    ["SELECT users", "users"],
    ["SELECT users", "users"],
    ["SELECT users", "users"],
    ["SELECT users", "users"],
    ["SELECT users", "users"],
    ["DECLARE users", "users"],
    ["SELECT", undefined],
    ["SELECT", undefined],
  ]);
});

test("the operation after a WITH list is the statement's own, and comments and strings are never read as SQL", async () => {
  expect(
    await named([
      'WITH x AS (SELECT * FROM "posts") (SELECT * FROM x) UNION (SELECT * FROM "users")',
      'WITH x AS (SELECT * FROM "posts" -- step 2) of the plan\n) SELECT * FROM x',
      `WITH x AS (SELECT ')' AS "a)" FROM "posts") SELECT * FROM x`,
      "WITH x AS (SELECT 1)",
      'SELECT * -- FROM "secret"\nFROM "users"',
      'SELECT * /* nested /* FROM "secret" */ FROM "secret" */ FROM "users"',
      `SELECT E'it\\'s FROM secret' AS a FROM "users"`,
      'SELECT $q$ ) FROM secret ( $q$ AS a FROM "users"',
      '/* request 42 */ SELECT * FROM "users"',
    ]),
  ).toEqual([
    ["SELECT", undefined],
    ["SELECT posts", "posts"],
    ["SELECT posts", "posts"],
    ["WITH", undefined],
    ["SELECT users", "users"],
    ["SELECT users", "users"],
    ["SELECT users", "users"],
    ["SELECT users", "users"],
    ["SELECT users", "users"],
  ]);
});

test("naming a statement takes time in proportion to its length", async () => {
  const nest = (depth: number, wrap: (inner: string) => string) => {
    let sql = "SELECT 1";

    for (let level = 0; level < depth; level += 1) {
      sql = wrap(sql);
    }

    return sql;
  };
  const coalesce = (inner: string) => `SELECT coalesce((${inner}), 0)`;
  const reads = Array.from(
    { length: 10000 },
    (_, index) =>
      `(SELECT COALESCE(json_agg("r"), '[]'::json) FROM (SELECT "id" FROM "posts" WHERE "v" = $${index + 1}) AS "r") AS "q${index}"`,
  ).join(", ");
  const statements = [
    // Exponential before: 2 seconds at 22 levels.
    `WITH "params" AS (${nest(22, coalesce)}) SELECT * FROM "params"`,
    `WITH "params" AS (${nest(2000, coalesce)}) SELECT * FROM "params"`,
    // About a megabyte each.
    `WITH "params" AS (${nest(40000, coalesce)}) SELECT * FROM "params"`,
    `SELECT ${reads}`,
    nest(40000, (inner) => `WITH a AS (${inner}) SELECT * FROM a`),
    `SELECT * FROM ${"(SELECT * FROM ".repeat(60000)}"posts"${") AS s".repeat(60000)}`,
  ];
  const started = performance.now();
  const names = await named(statements);

  expect(performance.now() - started).toBeLessThan(2000);
  expect(names.map(([name]) => name)).toEqual([
    "SELECT",
    "SELECT",
    "SELECT",
    "SELECT posts",
    "SELECT",
    "SELECT posts",
  ]);
});

/** A pool whose transactions queue statements, as PostgreSQL connections do. */
const queueing = (fail: (sql: string) => unknown): Driver => {
  const answer = async (query: { sql: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const error = fail(query.sql);

    if (error) {
      throw error;
    }

    return { rows: [{ id: 1, name: "Ada", count: 1 }], affectedRows: 1 };
  };

  return createPostgresDriver({
    execute: answer,
    connect: async () => ({
      execute: answer,
      release: () => {},
      discard: async () => {},
    }),
    cancel: async () => {},
    close: async () => {},
    max: 4,
  });
};

test("statements a failed transaction never sent are marked, not failed again", async () => {
  const refused = Object.assign(new Error("duplicate key"), { code: "23505" });
  const database = createDatabase({
    schema: declared,
    driver: traced(
      queueing((sql) => (sql.startsWith("INSERT") ? refused : undefined)),
      { tracer },
    ),
  });

  await database
    .$transaction(async (transaction) => {
      const first = transaction.users.insert({ name: "Ada" }).execute();
      const second = transaction.users.count();

      await Promise.allSettled([first, second]);
    })
    .catch(() => {});

  const statements = exporter
    .getFinishedSpans()
    .filter((span) => span.name !== "transaction");

  expect(statements.map((span) => span.attributes["error.type"])).toEqual([
    "23505",
    "not_sent",
  ]);
});
