import { expect } from "bun:test";
import { test, isolatedDriver } from "../../support/isolated-driver";
import {
  schema,
  int,
  text,
  type QueryColumn,
  createProfiler,
  createDatabase,
  self,
  sql,
} from "../../../packages/runtime/src";

test("nested scopes see an outer JOIN added after an earlier relation resolved bindings", async () => {
  const driver = isolatedDriver();
  const database = createDatabase({
    schema: schema({
      users: { id: int, name: text },
      posts: ({ users }) => ({ id: int, title: text, author: users }),
    }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.users.insert([
      { id: 1, name: "Ada" },
      { id: 2, name: "Lin" },
    ]);
    await database.posts.insert([
      { id: 1, title: "First", authorId: 1 },
      { id: 2, title: "Second", authorId: 2 },
    ]);
    const query = database.users(
      (user, { leftJoin }) => {
        const early = user.posts((post) => ({ title: post.title }));
        const peer = leftJoin(database.users.as("peer"), (peer) =>
          peer.id.is(user.id),
        );
        const late = user.posts(
          (post) => ({
            title: post.title,
            peer: peer.name,
          }),
          { where: (post) => post.authorId.is(peer.id) },
        );

        return { id: user.id, early, late };
      },
      { orderBy: (user, { leftJoin }) => user.id.ascending },
    );
    expect(await query).toEqual([
      {
        id: 1,
        early: [{ title: "First" }],
        late: [{ title: "First", peer: "Ada" }],
      },
      {
        id: 2,
        early: [{ title: "Second" }],
        late: [{ title: "Second", peer: "Lin" }],
      },
    ]);
  } finally {
    await database.$close();
  }
});

test("query options preserve cached branches when locking comes first or later validation fails", () => {
  const database = schema({ users: { id: int, name: text } });
  const base = database.users((user) => ({ id: user.id, name: user.name }));
  const original = base.toSQL();
  const branch = base({
    forUpdate: true,
    where: (user) => user.id.above(3),
    orderBy: (user) => user.id.descending,
    offset: 2,
    limit: 4,
  });
  const compiled = branch.toSQL();
  expect(compiled.sql).toContain('ORDER BY "users"."id" DESC');
  expect(compiled.sql).toContain("LIMIT 4\nOFFSET 2\nFOR UPDATE");
  expect(compiled.parameters).toEqual([3]);
  expect(() =>
    branch({
      where: (user) => user.id.below(10),
      orderBy: (user) => user.id.ascending,
      limit: -1,
    }),
  ).toThrow(/nonnegative/);
  expect(base.toSQL()).toEqual(original);
  expect(branch.toSQL()).toEqual(compiled);
  expect(base((user) => ({ renamed: user.name })).toSQL().sql).toContain(
    '"users"."name" AS "renamed"',
  );
  expect(base.toSQL()).toEqual(original);
});

test("shapes reject malformed clauses, asynchronous callbacks and escaped JOIN helpers", () => {
  const database = schema({
    users: { id: int, name: text },
    posts: ({ users }) => ({ id: int, author: users }),
  });
  const invoke = database.users as (
    callback: (user: { name: QueryColumn<string, "name"> }) => unknown,
    options?: object,
  ) => unknown;

  expect(() => invoke((user) => ({ name: user.name, $where: true }))).toThrow(
    /not a field/,
  );

  for (const options of [
    { typo: 1 },
    { where: true },
    { having: 5 },
    { orderBy: [] },
    { groupBy: [] },
    { limit: -1 },
    { offset: 1.5 },
  ]) {
    expect(() => invoke((user) => ({ name: user.name }), options)).toThrow();
  }

  expect(() => invoke(async (user) => ({ name: user.name }))).toThrow(
    /synchronously/,
  );
  expect(() => invoke(() => ({}))).toThrow(/at least one/);
  expect(() =>
    invoke((user) => ({ name: user.name, posts: database.posts })),
  ).toThrow(/selected fields/);

  let escaped = () => {};

  database.posts((post, { innerJoin }) => {
    escaped = () => {
      innerJoin(post.author);
    };

    return { id: post.id };
  });
  expect(escaped).toThrow(/inside their shape callback/);
  expect(() =>
    database.posts((post, { innerJoin }) => {
      innerJoin(post.author.as("author"));
      innerJoin(database.users.as("author"), (author) =>
        author.id.is(post.authorId),
      );

      return { id: post.id };
    }),
  ).toThrow(/duplicate query alias/);
  expect(database.users((user) => ({ name: user.name })).toSQL().sql).toContain(
    'FROM "users"',
  );
});

test("shape handles retain binding ownership and failed construction restores the parent scope", () => {
  const database = schema({ users: { id: int, name: text } });
  let escaped: QueryColumn<string, "name">;
  database.users.as("other")((user) => {
    escaped = user.name;

    return { name: user.name };
  });
  expect(() => database.users(() => ({ name: escaped }))).toThrow(
    /another query scope/,
  );
  expect(
    database
      .users((user) => ({
        peers: database.users(
          (peer) => ({
            name: peer.name,
          }),
          { where: (peer) => peer.id.isNot(user.id) },
        ),
      }))
      .toSQL().sql,
  ).toContain('"users_2"."id" <> "users"."id"');
  expect(
    database
      .users((user) => ({
        peers: database.users(
          (users) => ({
            name: users.name,
          }),
          { where: (users) => users.id.isNot(user.id) },
        ),
      }))
      .toSQL().sql,
  ).toContain('"users_2"."id" <> "users"."id"');
  expect(
    database
      .users((user, { leftJoin }) => {
        const peer = leftJoin(database.users.as("peer"), (peer) =>
          peer.id.is(user.id),
        );

        return {
          peers: database.users.as("peer")(() => ({ name: peer.name })),
        };
      })
      .toSQL().sql,
  ).toContain('FROM "users" AS "peer_2"');
  const query = database.users((user) => {
    expect(() =>
      database.users.as("broken")(() => {
        throw new Error("broken shape");
      }),
    ).toThrow("broken shape");

    return {
      name: user.name,
      peers: database.users.as("peer")((peer) => ({
        name: peer.name,
        owner: user.name,
      })),
    };
  });
  expect(query.toSQL().sql).toContain('"users"."name"');
});

test("profiling preserves callable sources and measures shape construction without executing it", async () => {
  const profiler = createProfiler();
  let executions = 0;
  const database = schema(
    { users: { id: int, name: text } },
    {
      driver: profiler.driver({
        execute: async () => {
          executions += 1;

          return [{ name: "Ada" }];
        },
        close: async () => {},
      }),
    },
  );
  await profiler.trace("shape", async () => {
    const query = database.users((user, { leftJoin }) => {
      leftJoin(database.users.as("peer"), (peer) => peer.id.is(user.id));

      return { name: user.name };
    });
    expect(executions).toBe(0);
    expect(await query).toEqual([{ name: "Ada" }]);
  });
  expect(executions).toBe(1);
  expect(profiler.snapshot()[0]!.buildMs).toBeGreaterThan(0);
  expect(profiler.snapshot()[0]!.queries).toHaveLength(1);
});

test("inferred JOINs reject foreign scopes, non-FK expressions and filtered relations", () => {
  const database = schema({
    users: { id: int, name: text, manager: self.nullable },
  });
  let escaped: QueryColumn<number | null, "managerId">;
  // Plain queries of one table share its root binding; a differently aliased
  // source is a foreign scope.
  database.users.as("people")((user) => {
    escaped = user.managerId;

    return { id: user.id };
  });
  expect(() =>
    database.users((user, { join }) => ({
      id: join(escaped as never).id,
      name: user.name,
    })),
  ).toThrow(/another query scope/);
  expect(() => database.users(() => ({ id: escaped }))).toThrow(
    /another query scope/,
  );

  for (const kind of ["join", "innerJoin", "leftJoin", "crossJoin"] as const) {
    for (const invalid of [
      "scalar",
      "arithmetic",
      "raw",
      "filtered",
      "outer",
    ] as const) {
      expect(() =>
        database.users((user, tools) => {
          const input =
            invalid === "scalar"
              ? user.id
              : invalid === "arithmetic"
                ? user.managerId.plus(1)
                : invalid === "raw"
                  ? sql<number>`1`
                  : invalid === "filtered"
                    ? user.manager({ where: (manager) => manager.id.is(1) })
                    : escaped;
          (tools[kind] as (input: unknown) => unknown)(input);

          return { id: user.id };
        }),
      ).toThrow(/foreign-key|unfiltered relation|query scope/);
    }
  }

  expect(() =>
    database.users((user) => ({
      nested: database.users((peer, { join }) => ({
        id: join(user.managerId).id,
        peer: peer.id,
      })),
    })),
  ).toThrow(/another query scope/);
  expect(() =>
    database.users((user, { leftJoin }) => {
      leftJoin(database.users.as("person"), (peer) => peer.id.is(user.id));
      leftJoin(database.users.as("person"), (peer) => peer.id.is(user.id));

      return { id: user.id };
    }),
  ).toThrow(/duplicate query alias/);
});

test("automatic aliases are deterministic, UTF-8 bounded and preserve explicit names", () => {
  const name = "界".repeat(21);
  const database = schema({ users: { id: int, manager: self.nullable } });
  const people = database.users((user) => ({ id: user.id })).cte(name);

  const build = () =>
    people((person, { leftJoin }) => {
      const other = leftJoin(people, (other) => other.id.is(person.id));

      return {
        id: person.id,
        other: other.id,
        nested: people(
          (nested) => ({
            id: nested.id,
          }),
          { where: (nested) => nested.id.is(person.id) },
        ),
      };
    });

  expect(build().toSQL()).toEqual(build().toSQL());
  expect(build().toSQL().sql).toContain(`AS "${"界".repeat(20)}_2"`);
  const query = database.users((user, { leftJoin }) => {
    const reserved = leftJoin(database.users.as("users_2"), (other) =>
      other.id.is(user.id),
    );
    const generated = leftJoin(database.users, (other) => other.id.is(user.id));

    return { id: user.id, first: reserved.id, second: generated.id };
  });
  expect(query.toSQL().sql).toContain('AS "users_3"');
});

test("callable relations preserve function-metadata column names and nested output named then", async () => {
  const driver = isolatedDriver();
  const database = createDatabase({
    schema: schema({
      users: { id: int, name: text, length: int },
      posts: ({ users }) => ({ id: int, author: users }),
    }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.users.insert({ id: 1, name: "Ada", length: 3 });
    await database.posts.insert({ id: 1, authorId: 1 });
    expect(
      await database.posts((post) => ({
        name: post.author.name,
        length: post.author.length,
        then: database.users(
          (user) => ({
            name: user.name,
          }),
          { where: (user) => user.id.is(post.authorId) },
        ),
      })),
    ).toEqual([{ name: "Ada", length: 3, then: [{ name: "Ada" }] }]);
  } finally {
    await database.$close();
  }
});
