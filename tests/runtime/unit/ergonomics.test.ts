import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  bigint,
  timestamptz,
  prepare,
} from "../../../packages/runtime/src";

const users = table({ id: int, name: text, email: text.unique });
const model = schema({
  users,
  posts: table({
    id: int,
    author: users,
    name: text,
    length: int,
    views: bigint,
    createdAt: timestamptz,
  }),
});

test("options-only branches preserve selections, CTEs and per-parent pagination", () => {
  const query = model.posts({ where: ({ views }) => views.above(0n) })(
    ({ name }) => ({ name }),
  );
  const before = query.toSQL();
  expect(query({ limit: 2 }).toSQL().sql).toEndWith("LIMIT 2");
  expect(query.toSQL()).toEqual(before);
  expect(
    query
      .cte("recent")({ limit: 1 })(({ name }) => ({ name }))
      .toSQL().sql,
  ).toContain("LIMIT 1");
  const modern = model.users(({ posts }) => ({
    count: posts({ limit: 2 }).count(),
    items: posts({ limit: 2 })(({ name }) => ({ name })),
  }));
  const inline = model.users(({ posts }) => ({
    count: posts({ limit: 2 }).count(),
    items: posts(({ name }) => ({ name }), { limit: 2 }),
  }));
  expect(modern.toSQL()).toEqual(inline.toSQL());
  expect(() => model.posts({ limti: 1 } as never)).toThrow(
    /unknown query option/,
  );
  expect(() => model.posts(null as never)).toThrow(/options must be an object/);
});

test("aggregate properties match callbacks including names that overlap function properties", () => {
  const modern = model.users(({ posts }) => ({
    total: posts.sum.views,
    average: posts.average.views,
    last: posts.maximum.createdAt,
    first: posts.minimum.name,
    length: posts.maximum.length,
  }));
  const existing = model.users(({ posts }) => ({
    total: posts.sum(({ views }) => views),
    average: posts.average(({ views }) => views),
    last: posts.maximum(({ createdAt }) => createdAt),
    first: posts.minimum(({ name }) => name),
    length: posts.maximum(({ length }) => length),
  }));
  expect(modern.toSQL()).toEqual(existing.toSQL());
  expect(
    model
      .users(({ posts }) => ({
        total: posts({ orderBy: ({ id }) => id.descending, limit: 2 }).sum
          .views,
      }))
      .toSQL().sql,
  ).toContain("LIMIT 2");
});

test("unique lookup mutations retain scopes and detached method ownership", () => {
  const db = model.$scope({ users: ({ id }) => id.above(10) });
  const { update, delete: remove } = db.users.by.email("ada");
  const statement = update({ name: "Ada" }).toSQL();
  expect(statement.sql).toStartWith("UPDATE");
  // The scope restricts the update and checks the updated row.
  expect(statement.parameters).toEqual(["Ada", 10, "ada", 10]);
  expect(remove().toSQL().parameters).toEqual([10, "ada"]);
  expect(model.users.byId(2).update({ name: "Ada" }).toSQL()).toEqual(
    model.users
      .update({ name: "Ada" })
      .where(({ id }) => id.is(2))
      .toSQL(),
  );
});

test("prepared queries are callable and retain detached execute and toSQL methods", async () => {
  const db = schema(
    { records: { id: int } },
    {
      driver: {
        execute: async ({ parameters }) => ({
          rows: [{ id: parameters[0] }],
          affectedRows: 1,
        }),
        close: async () => {},
      },
    },
  );
  const query = prepare({ id: int }, (p) => db.records.byId(p.id));
  const { execute, toSQL } = query;
  expect(Object.isFrozen(query)).toBe(true);
  expect(await query({ id: 7 })).toEqual([{ id: 7 }]);
  expect(await execute({ id: 8 })).toEqual([{ id: 8 }]);
  expect(toSQL({ id: 9 }).parameters).toEqual([9]);
  await expect(query({} as never)).rejects.toThrow(/exactly/);
});

test("RETURNING evaluates reusable scalar shapes with SQL tools and rejects incompatible shapes", () => {
  const card = model.users.shape(({ id, name }, { sql }) => ({
    id,
    label: sql.of(text)`upper(${name})`,
  }));
  const returning = model.users
    .insert({ id: 1, name: "Ada", email: "ada" })
    .returning(card)
    .toSQL();
  expect(returning.sql).toContain(
    'RETURNING "users"."id" AS "id", upper("users"."name") AS "label"',
  );
  expect(() => model.posts.delete().returning(card as never)).toThrow(
    /another table/,
  );
  const related = model.users.shape(({ posts }) => ({ total: posts.count() }));
  const aggregate = model.users.shape(({ id }, { sum }) => ({
    total: sum(id),
  }));
  const window = model.users.shape(({ id }, { rowNumber }) => ({
    position: rowNumber().over({ orderBy: id.ascending }),
  }));

  for (const shape of [related, aggregate, window]) {
    expect(() => model.users.delete().returning(shape as never)).toThrow(
      /RETURNING shapes/,
    );
  }
});
