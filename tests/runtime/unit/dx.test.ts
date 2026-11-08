import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  bool,
  numeric,
  varchar,
  jsonb,
  oneOf,
  customType,
  isColumn,
  and,
  or,
  when,
  sql,
} from "../../../packages/runtime/src";
import { vector } from "../../../packages/runtime/src/entries/vector";

const model = schema({
  users: { id: int.auto, name: text, active: bool },
  posts: ({ users }) => ({
    id: int.auto,
    title: text,
    author: users,
    editor: users.nullable.inverse("edited"),
    price: numeric,
    code: varchar,
  }),
});

test("numeric and varchar work bare and called", () => {
  expect(isColumn(numeric)).toBe(true);
  expect(isColumn(varchar)).toBe(true);
  expect(numeric.definition.sqlType).toBe("numeric");
  expect(numeric(10, 2).definition.sqlType).toBe("numeric(10,2)");
  expect(numeric.nullable.definition.notNull).toBe(false);
  expect(numeric.array.definition.sqlType).toBe("numeric[]");
  expect(varchar.definition.sqlType).toBe("varchar");
  expect(varchar(40).definition.sqlType).toBe("varchar(40)");
  expect(() => varchar(0)).toThrow(/positive integer/);
  expect(() => numeric(0)).toThrow(/between 1 and 1000/);
  expect(
    model
      .$snapshot()
      .tables.find((entry) => entry.sqlName === "posts")!
      .columns.map((column) => column.sqlType),
  ).toContain("numeric");
  expect(
    model.posts
      .insert({ title: "x", authorId: 1, price: "1.50", code: "a" })
      .toSQL().parameters,
  ).toEqual(["x", 1, "1.50", "a"]);
});

test("a column builder passed without a call is explained", () => {
  expect(() => schema({ docs: { id: int, body: jsonb as never } })).toThrow(
    /"docs\.body" is the jsonb\(\) builder itself; call it: body: jsonb<Value>\(\)/,
  );
  expect(() => schema({ docs: { id: int, state: oneOf as never } })).toThrow(
    /oneOf\(\) builder itself; call it: state: oneOf\("draft", "published"\)/,
  );
  expect(() => schema({ docs: { id: int, raw: customType as never } })).toThrow(
    /customType\(\) builder itself/,
  );
  expect(() =>
    schema({ docs: { id: int, embedding: vector as never } }),
  ).toThrow(/vector\(\) builder itself; call it: embedding: vector\(1536\)/);
  expect(() =>
    schema({ docs: { id: int, title: (() => text) as never } }),
  ).toThrow(
    /"docs\.title": a thunk must return a table; declare the column directly \(title: a text column\)/,
  );
  expect(() =>
    schema({ docs: { id: int, when: new Date() as never } }),
  ).toThrow(
    /"docs\.when" is not a column, table or reference \(got an instance of Date\)/,
  );
  expect(() => schema({ docs: { id: int, label: "text" as never } })).toThrow(
    /"docs\.label" is not a column, table or reference \(got string\)/,
  );
  // A table that exists but is not part of the schema keeps its own message.
  const outside = table({ id: int });
  expect(() => schema({ docs: { id: int, other: outside as never } })).toThrow(
    /points to a table outside this schema/,
  );
});

test("unknown columns and relations in shapes suggest the closest name", () => {
  const loose = <Value>(value: Value) => value as Record<string, any>;
  expect(() => model.users((user) => ({ name: loose(user).nmae }))).toThrow(
    /"users\.nmae" is not a column or relation of "users" \(did you mean "name"\?\)\. Available columns: id, name, active; relations: (edited, posts|posts, edited)/,
  );
  expect(() => model.posts((post) => ({ items: loose(post).items }))).toThrow(
    /"posts\.items" is not a column or relation of "posts"\. Available columns/,
  );
  expect(() =>
    model.posts((post) => ({ author: loose(post).Author.name })),
  ).toThrow(/did you mean "author"/);
  // To-one relation handles check membership before adding a JOIN.
  expect(() =>
    model.posts((post) => ({ name: loose(post.author).nmae })),
  ).toThrow(
    /"users\.nmae" is not a column or relation of "users" \(did you mean "name"\?\)/,
  );
  expect(
    model.posts((post) => ({ name: post.author.name })).toSQL().sql,
  ).toContain("INNER JOIN");
  // Generic probes stay silent so views can be returned or awaited.
  const identity = model.users as unknown as (
    callback: (user: unknown) => unknown,
  ) => { toSQL: () => { sql: string } };
  expect(identity((user) => user).toSQL().sql).toContain('"users"."name"');
});

test("predicate lists skip undefined, null and false", () => {
  const search: string | undefined = undefined;
  const minimum: number | null = null;
  const onlyActive = false;
  const query = model.users((user) => ({ id: user.id }), {
    where: (user) => [
      when(search, (value) => user.name.ilike(`%${value}%`)),
      minimum !== null && user.id.atLeast(minimum),
      onlyActive && user.active.is(true),
      null,
      user.id.above(0),
    ],
  });

  expect(query.toSQL().sql).toEndWith('WHERE "users"."id" > $1');
  expect(
    model
      .users((user) => ({ id: user.id }), { where: (() => false) as never })
      .toSQL().sql,
  ).not.toContain("WHERE");
  expect(
    model
      .users((user) => ({ id: user.id }), {
        where: (user) => and(null, false, undefined, user.id.is(1)),
      })
      .toSQL().sql,
  ).toContain('WHERE ("users"."id" = $1)');
  expect(
    model
      .users((user) => ({ id: user.id }), {
        where: (user) => or(false, user.id.is(1), null),
      })
      .toSQL().sql,
  ).toContain('WHERE ("users"."id" = $1)');
  expect(
    model
      .posts((post, { innerJoin }) => {
        const author = innerJoin(model.users.as("writer"), (writer) => [
          writer.id.is(post.authorId),
          false,
          undefined,
        ]);

        return { name: author.name };
      })
      .toSQL().sql,
  ).toContain('ON ("writer"."id" = "posts"."author_id")');
  expect(
    model.users
      .update({ active: false })
      .where((user) => [user.id.is(1), null, false])
      .toSQL().sql,
  ).toContain('WHERE ("users"."id" = $2)');
  // A single false from a mutation callback is still a mistake, not "no filter".
  expect(() =>
    model.users.update({ active: false }).where((() => false) as never),
  ).toThrow(/expected a SQL predicate/);
  expect(
    model
      .users((user) => ({ id: user.id }), {
        where: (user) => [sql<boolean>`${user.id} > 0`.is(true)],
      })
      .toSQL().sql,
  ).toContain("WHERE");
});
