import { test } from "node:test";
import assert from "node:assert/strict";
import { types } from "pg";
import {
  schema,
  table,
  int,
  text,
  bool,
  bigint,
  numeric,
  oneOf,
  jsonb,
  timestamptz,
  prepare,
  createProfiler,
  databaseError,
} from "../../../packages/runtime/dist/index.js";
import { postgres as pg } from "../../../packages/runtime/dist/pg.js";
import { testDatabase } from "../../../packages/kit/dist/testing.js";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
// Through a transaction-pooling PgBouncer, Bun.SQL needs unnamed statements
// and tests of session state (pids, SET, temporary tables, locks) do not apply.
const pooled = process.env.SYMMETRIA_TEST_TRANSACTION_POOLING === "1";
const adapters = [["pg", pg]];

if (typeof Bun !== "undefined") {
  const { postgres } = await import("../../../packages/runtime/dist/bun.js");
  adapters.push([
    "Bun.SQL",
    pooled ? (options) => postgres({ ...options, prepare: false }) : postgres,
  ]);
}

for (const [name, driver] of adapters) {
  test(`${name}: lossless values, prepared queries, nested results and transactions`, {
    skip: !url,
  }, async () => {
    const users = table({
      id: int,
      name: text,
    });

    const model = schema({
      users,
      posts: table({
        id: int,
        author: users,
        value: bigint,
        amounts: numeric(30, 2).array,
        active: bool,
        doc: jsonb(),
        created: timestamptz,
      }),
    });
    const fixture = await testDatabase({
      url,
      schema: model,
      driver,
      max: 1,
    });
    const db = fixture.database;
    const created = new Date("2026-01-01T12:00:00.000Z");

    try {
      await db.users.insert({ id: 1, name: "Ada" });
      await db.posts.insert({
        id: 1,
        authorId: 1,
        value: 9007199254740993n,
        amounts: ["9007199254740993.01", "-0.01"],
        active: true,
        doc: { nested: [true, null] },
        created,
      });
      const lookup = prepare({ id: int }, (p) =>
        db.users(
          (user) => ({
            name: user.name,
            posts: user.posts((post) => ({
              value: post.value,
              amounts: post.amounts,
              active: post.active,
              doc: post.doc,
              created: post.created,
            })),
          }),
          { where: (user) => user.id.is(p.id) },
        ),
      );
      const expected = [
        {
          name: "Ada",
          posts: [
            {
              value: 9007199254740993n,
              amounts: ["9007199254740993.01", "-0.01"],
              active: true,
              doc: { nested: [true, null] },
              created,
            },
          ],
        },
      ];
      assert.deepEqual(await lookup.execute({ id: 1 }), expected);
      assert.deepEqual(await lookup({ id: 1 }), expected);
      assert.deepEqual(await lookup.execute({ id: 2 }), []);
      const modern = db.users(
        ({ name, posts }) => ({
          name,
          posts: posts(
            ({ value, amounts, active, doc, created }) => ({
              value,
              amounts,
              active,
              doc,
              created,
            }),
            { orderBy: ({ id }) => id.descending, limit: 3 },
          ),
        }),
        { where: ({ id }) => id.is(1), limit: 20 },
      );
      assert.deepEqual(await modern, expected);
      assert.deepEqual(await modern({ limit: 1 }), expected);
      const totals = await db.users(({ posts }) => ({
        total: posts.sum.value,
        last: posts.maximum.created,
      }));
      assert.deepEqual(totals, [{ total: "9007199254740993", last: created }]);
      const literals = prepare(
        { active: bool, count: int, label: oneOf("typed", "other") },
        (p) =>
          db.users(() => ({
            active: p.active,
            count: p.count,
            label: p.label,
            nested: { active: p.active, count: p.count, label: p.label },
          })),
      );
      assert.deepEqual(
        await literals.execute({ active: true, count: 2, label: "typed" }),
        [
          {
            active: true,
            count: 2,
            label: "typed",
            nested: { active: true, count: 2, label: "typed" },
          },
        ],
      );
      const update = prepare({ name: text }, (p) =>
        db.users.byId(1).update({ name: p.name }),
      );
      assert.deepEqual(await update({ name: "Grace" }), {
        affectedRows: 1,
      });
      let leaked;
      await assert.rejects(
        db.$transaction(async (tx) => {
          leaked = tx;
          await tx.users.update({ name: "temporary" }).all();
          await tx.$transaction(async (nested) => {
            await nested.users.insert({ id: 2, name: "nested" });
          });
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.deepEqual(await db.users((user) => user), [
        { id: 1, name: "Grace" },
      ]);
      await assert.rejects(leaked.users((user) => user).execute(), /closed/);
      await db.$transaction(
        async (tx) => {
          await assert.rejects(
            tx.$transaction(async (nested) => {
              await nested.users.insert({ id: 1, name: "duplicate" });
            }),
          );
          await tx.users.update({ name: "recovered" }).all();
        },
        { isolationLevel: "serializable" },
      );
      assert.equal((await db.users.byId(1).one()).name, "recovered");
      const card = db.users.shape(({ name }) => ({ name }));
      assert.deepEqual(
        await db.users.byId(1).update({ name: "recovered" }).returning(card),
        [{ name: "recovered" }],
      );
      assert.deepEqual(await db.users.insert([]).prepare().execute(), {
        affectedRows: 0,
      });
    } finally {
      await fixture.close();
    }
  });

  test(`${name}: pinned sessions and cancellation retain connection ownership`, {
    skip: !url || pooled,
  }, async () => {
    const pool = driver({ url, max: 1 });

    try {
      await pool.session(async (session) => {
        await session.execute({
          sql: "CREATE TEMP TABLE session_values (id integer)",
          parameters: [],
        });
        await session.transaction((tx) =>
          tx.execute({
            sql: "INSERT INTO session_values VALUES ($1)",
            parameters: [1],
          }),
        );
        await assert.rejects(
          session.transaction(async (tx) => {
            await tx.execute({
              sql: "INSERT INTO session_values VALUES (2)",
              parameters: [],
            });
            throw new Error("rollback");
          }),
          /rollback/,
        );
        assert.deepEqual(
          (
            await session.execute({
              sql: "SELECT id FROM session_values",
              parameters: [],
            })
          ).rows,
          [{ id: 1 }],
        );
        const query = session.execute({
          sql: "SELECT pg_sleep(10)",
          parameters: [],
        });
        const cancelled = assert.rejects(
          query,
          (error) => error.code === "57014" || error.errno === "57014",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await session.cancel();
        await cancelled;
        assert.deepEqual(
          (
            await session.execute({
              sql: "SELECT 1 AS value",
              parameters: [],
            })
          ).rows,
          [{ value: 1 }],
        );
      });
    } finally {
      await pool.close();
    }
  });

  test(`${name}: close drains accepted work and rejects new operations`, {
    skip: !url,
  }, async () => {
    const pool = driver({ url, max: 1 });
    let started;
    let resume;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    const transaction = pool.transaction(async (tx) => {
      started();
      await gate;

      return tx.execute({ sql: "SELECT 1 AS value", parameters: [] });
    });
    await ready;
    const queued = pool.execute({ sql: "SELECT 2 AS value", parameters: [] });
    const closing = pool.close();
    assert.equal(pool.close(), closing);

    try {
      await assert.rejects(
        pool.execute({ sql: "SELECT 3", parameters: [] }),
        /closed/,
      );
      await assert.rejects(
        pool.transaction(async () => {}),
        /closed/,
      );
      await assert.rejects(
        pool.session(async () => {}),
        /closed/,
      );
    } finally {
      resume();
      await closing;
    }

    assert.deepEqual((await transaction).rows, [{ value: 1 }]);
    assert.deepEqual((await queued).rows, [{ value: 2 }]);
  });

  test(`${name}: statement errors preserve sessions and disconnected clients recover`, {
    skip: !url || pooled,
  }, async () => {
    const pool = driver({ url, max: 1 });
    const admin = pg(url);

    try {
      await pool.execute({
        sql: "SET application_name = 'symmetria_driver_test'",
        parameters: [],
      });
      await assert.rejects(
        pool.execute({ sql: "SELECT 1 / 0", parameters: [] }),
      );
      assert.equal(
        (await pool.execute({ sql: "SHOW application_name", parameters: [] }))
          .rows[0].application_name,
        "symmetria_driver_test",
      );
      const { pid } = (
        await pool.execute({
          sql: "SELECT pg_backend_pid() AS pid",
          parameters: [],
        })
      ).rows[0];
      await admin.execute({
        sql: "SELECT pg_terminate_backend($1)",
        parameters: [pid],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(
        (await pool.execute({ sql: "SELECT 1 AS value", parameters: [] })).rows,
        [{ value: 1 }],
      );
      await assert.rejects(
        pool.transaction((tx) =>
          tx.execute({
            sql: "SELECT pg_terminate_backend(pg_backend_pid())",
            parameters: [],
          }),
        ),
      );
      assert.deepEqual(
        (await pool.execute({ sql: "SELECT 2 AS value", parameters: [] })).rows,
        [{ value: 2 }],
      );
    } finally {
      await pool.close();
      await admin.close();
    }
  });

  test(`${name}: a connection killed mid-query is discarded and reported as a connection error`, {
    skip: !url,
  }, async () => {
    const pool = driver({ url, max: 1 });
    const admin = pg(url);

    try {
      const { pid } = (
        await pool.execute({
          sql: "SELECT pg_backend_pid() AS pid",
          parameters: [],
        })
      ).rows[0];
      const running = pool
        .execute({ sql: "SELECT pg_sleep(5)", parameters: [] })
        .then(
          () => undefined,
          (error) => error,
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await admin.execute({
        sql: "SELECT pg_terminate_backend($1)",
        parameters: [pid],
      });
      assert.equal(databaseError(await running)?.kind, "connection");

      for (const value of [1, 2, 3]) {
        assert.deepEqual(
          (
            await pool.execute({
              sql: "SELECT $1::integer AS value",
              parameters: [value],
            })
          ).rows,
          [{ value }],
        );
      }
    } finally {
      await pool.close();
      await admin.close();
    }
  });

  test(`${name}: a session's connection is closed afterwards, with its settings, locks and transaction`, {
    skip: !url || pooled,
  }, async () => {
    const pool = driver({ url, max: 1 });
    const admin = pg(url);
    const lock = 1937339000 + Math.floor(Math.random() * 1000);
    const gone = async (pid) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const { rows } = await admin.execute({
          sql: "SELECT count(*)::integer AS backends, (SELECT count(*)::integer FROM pg_locks WHERE locktype = 'advisory' AND objid = $2) AS locks FROM pg_stat_activity WHERE pid = $1",
          parameters: [pid, lock],
        });

        if (rows[0].backends === 0 && rows[0].locks === 0) {
          return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      return false;
    };

    try {
      const pid = await pool.session(async (session) => {
        await session.execute({
          sql: "SET search_path TO nowhere",
          parameters: [],
        });
        await session.execute({
          sql: "SELECT pg_advisory_lock($1)",
          parameters: [lock],
        });
        await session.execute({
          sql: "CREATE TEMP TABLE session_state (id integer)",
          parameters: [],
        });
        await session.execute({ sql: "BEGIN", parameters: [] });

        return (
          await session.execute({
            sql: "SELECT pg_backend_pid() AS pid",
            parameters: [],
          })
        ).rows[0].pid;
      });
      assert.equal(await gone(pid), true);
      const { rows } = await pool.execute({
        sql: "SELECT current_setting('search_path') AS path, to_regclass('session_state') AS temporary, now() = statement_timestamp() AS autocommit",
        parameters: [],
      });
      assert.deepEqual(rows, [
        { path: '"$user", public', temporary: null, autocommit: true },
      ]);

      let failed;
      await assert.rejects(
        pool.session(async (session) => {
          failed = (
            await session.execute({
              sql: "SELECT pg_backend_pid() AS pid",
              parameters: [],
            })
          ).rows[0].pid;
          await session.execute({ sql: "BEGIN", parameters: [] });
          throw new Error("failed session");
        }),
        /failed session/,
      );
      assert.equal(await gone(failed), true);
    } finally {
      await pool.close();
      await admin.close();
    }
  });

  test(`${name}: concurrent transaction statements run one at a time`, {
    skip: !url,
  }, async () => {
    const pool = driver({ url, max: 1 });
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning.message);
    process.on("warning", onWarning);

    try {
      const values = await pool.transaction((tx) =>
        Promise.all(
          [1, 2, 3, 4].map((value) =>
            tx.execute({
              sql: "SELECT $1::integer AS value, pg_sleep(0.01)::text AS slept",
              parameters: [value],
            }),
          ),
        ),
      );
      assert.deepEqual(
        values.map(({ rows }) => rows[0].value),
        [1, 2, 3, 4],
      );
      const select = (driver, value) =>
        driver.execute({
          sql: "SELECT $1::integer AS value",
          parameters: [value],
        });
      // Parent statements wait for a concurrent savepoint; inside its callback
      // the parent is rejected, since it would wait for the savepoint itself.
      const nested = await pool.transaction(async (tx) => {
        const [inner, outer] = await Promise.all([
          tx.transaction(async (savepoint) => {
            await assert.rejects(
              async () => select(tx, 0),
              /await the nested transaction/,
            );

            return (await select(savepoint, 5)).rows[0].value;
          }),
          select(tx, 6),
        ]);

        return [inner, outer.rows[0].value];
      });
      assert.deepEqual(nested, [5, 6]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(
        warnings.filter((message) => message.includes("client.query()")),
        [],
      );
    } finally {
      process.off("warning", onWarning);
      await pool.close();
    }
  });
}

test("pg parsers preserve numeric arrays and leave global parsers unchanged", {
  skip: !url,
}, async () => {
  const original = types.getTypeParser(20);
  const pool = pg(url);

  try {
    const result = await pool.execute({
      sql: "SELECT 9007199254740993::bigint AS value, ARRAY[9007199254740993.01::numeric, NULL] AS amounts, ARRAY['name'::name] AS names",
      parameters: [],
    });
    assert.deepEqual(result.rows, [
      {
        value: 9007199254740993n,
        amounts: ["9007199254740993.01", null],
        names: ["name"],
      },
    ]);
    assert.equal(types.getTypeParser(20), original);
  } finally {
    await pool.close();
  }
});

test("profiler HTTP listener runs in both runtimes", async () => {
  const profiler = createProfiler();
  const server = await profiler.serve({ port: 0 });

  try {
    const anonymous = await fetch(new URL("/requests", server.url));
    assert.equal(anonymous.status, 403);
    await anonymous.text();
    const response = await fetch(new URL("/requests", server.url), {
      headers: { "x-symmetria-token": server.token },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  } finally {
    await server.stop(true);
  }
});
