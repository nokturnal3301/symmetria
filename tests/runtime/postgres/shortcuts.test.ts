import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  bool,
  numeric,
  customType,
  databaseError,
  sqlState,
  CheckViolation,
  ForeignKeyViolation,
  NotFoundError,
  NotNullViolation,
  OutOfScopeError,
  QueryError,
  SymmetriaError,
  TooManyRowsError,
  UniqueViolation,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const users = table({
  id: int.auto,
  email: text.unique,
  name: text,
  active: bool.default(true),
  tenant: int.default(1),
});
const posts = table({
  id: int.auto,
  slug: text.unique,
  title: text,
  author: users.index,
  price: numeric(10, 2).default("0"),
}).checks((post) => ({ positive: post.price.atLeast("0") }));
// A range read and written as [from, to]: one value that is an array.
const span = customType<[number, number]>("int4range", {
  encode: ([from, to]) => `[${from},${to})`,
  decode: (value) =>
    String(value).slice(1, -1).split(",").map(Number) as [number, number],
});
const bookings = table({
  id: int.auto,
  period: span.unique,
  tags: text.array.unique,
  label: text,
});
const model = schema({ users, posts, bookings });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("query and write shortcuts on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_shortcuts",
      max: 2,
    });
    database = isolated.database;
    await database.users.insert([
      { email: "ada@x.test", name: "Ada" },
      { email: "bob@x.test", name: "Bob", active: false },
      { email: "cy@x.test", name: "Cy", tenant: 2 },
    ]);
    await database.posts.insert([
      { slug: "a", title: "A", authorId: 1, price: "10.50" },
      { slug: "b", title: "B", authorId: 1, price: "1.25" },
      { slug: "c", title: "C", authorId: 2 },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("get, find, whole rows, object filters and ordering", async () => {
    expect(await database.users.get(1)).toEqual({
      id: 1,
      email: "ada@x.test",
      name: "Ada",
      active: true,
      tenant: 1,
    });
    expect(await database.users.find(99)).toBeNull();
    // A unique key as an object of its columns.
    expect(await database.users.get({ email: "bob@x.test" })).toMatchObject({
      id: 2,
      name: "Bob",
    });
    expect(
      await database.posts.find({ slug: "b" }, (post) => ({
        author: post.author.name,
      })),
    ).toEqual({ author: "Ada" });
    expect(await database.users.find({ email: "nobody@x.test" })).toBeNull();
    await expect(
      database.users.get({ email: "nobody@x.test" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // An aggregate over a window, by its method, ordered with the short words.
    expect(
      await database.posts(
        (post, { sum, count }) => ({
          slug: post.slug,
          running: sum(post.price).over({
            partitionBy: [post.authorId],
            orderBy: post.id.asc,
          }),
          byAuthor: count().over({ partitionBy: [post.authorId] }),
        }),
        { orderBy: { slug: "descending" } },
      ),
    ).toEqual([
      { slug: "c", running: "0.00", byAuthor: 1 },
      { slug: "b", running: "11.75", byAuthor: 2 },
      { slug: "a", running: "10.50", byAuthor: 2 },
    ]);
    expect(
      await database.posts.get(1, (post) => ({ author: post.author.name })),
    ).toEqual({ author: "Ada" });

    expect(
      await database.users({ where: { active: true, tenant: 1 } }),
    ).toEqual([
      { id: 1, email: "ada@x.test", name: "Ada", active: true, tenant: 1 },
    ]);
    expect(
      await database.users(
        (user) => ({ name: user.name, written: user.posts.count() }),
        { orderBy: [{ written: "desc" }, { name: "desc" }] },
      ),
    ).toEqual([
      { name: "Ada", written: 2 },
      { name: "Bob", written: 1 },
      { name: "Cy", written: 0 },
    ]);
    expect(
      await database.posts(
        (post, { row }) => ({ ...row, author: post.author.name }),
        { where: (post) => post.slug.is("a").or(post.price.above("100")) },
      ),
    ).toEqual([
      {
        id: 1,
        slug: "a",
        title: "A",
        authorId: 1,
        price: "10.50",
        author: "Ada",
      },
    ]);
    expect(
      await database.posts.aggregate((post, { count, sum }) => ({
        posts: count(),
        total: sum(post.price),
      })),
    ).toEqual({ posts: 3, total: "11.75" });
    // A CTE given options and no fields reads its fields, codecs included.
    const priced = database
      .posts((post) => ({
        slug: post.slug,
        price: post.price,
        author: { name: post.author.name },
      }))
      .cte("priced");

    expect(
      await priced({
        where: (post) => post.price.above("1"),
        orderBy: { slug: "asc" },
      }),
    ).toEqual([
      { slug: "a", price: "10.50", author: { name: "Ada" } },
      { slug: "b", price: "1.25", author: { name: "Ada" } },
    ]);
    // Several totals of one relation come from one shared subquery.
    const totals = database.users(
      (user) => ({
        name: user.name,
        posts: user.posts.count(),
        total: user.posts.sum.price,
        top: user.posts.maximum.price,
      }),
      { orderBy: { id: "asc" } },
    );
    const expected: Awaited<typeof totals> = [
      { name: "Ada", posts: 2, total: "11.75", top: "10.50" },
      { name: "Bob", posts: 1, total: "0.00", top: "0.00" },
      { name: "Cy", posts: 0, total: null, top: null },
    ];

    expect(totals.toSQL().sql).toContain("LEFT JOIN LATERAL");
    expect(await totals).toEqual(expected);
    expect(await totals({ limit: 2 })).toEqual(expected.slice(0, 2));
    expect(await totals({ limit: 2, offset: 1 })).toEqual(expected.slice(1));
    // Pages and streams of a whole-row query.
    const page = await database
      .users({ orderBy: { id: "asc" } })
      .page({ size: 2 });

    expect(page.items.map((user) => user.id)).toEqual([1, 2]);
  });

  test("get(), find() and by.<key>() take a key whose value is an array", async () => {
    await database.bookings.insert([
      { period: [1, 5], tags: ["a", "b"], label: "first" },
      { period: [5, 9], tags: ["c"], label: "second" },
    ]);
    const second = {
      id: 2,
      period: [5, 9] as [number, number],
      tags: ["c"],
      label: "second",
    };

    // The key takes what a filter on its column takes.
    expect(
      await database.bookings((booking) => booking, {
        where: (booking) => booking.period.is([5, 9]),
      }),
    ).toEqual([second]);
    expect(await database.bookings.find({ period: [5, 9] })).toEqual(second);
    expect(await database.bookings.get({ period: [5, 9] })).toEqual(second);
    expect(await database.bookings.by.period([5, 9]).one()).toEqual(second);
    expect(await database.bookings.by.tags(["c"]).one()).toEqual(second);
    expect(await database.bookings.find({ period: [9, 12] })).toBeNull();
    expect(
      await database.bookings.by.period([1, 5]).update({ label: "moved" }),
    ).toEqual({ affectedRows: 1 });
    expect((await database.bookings.get({ tags: ["a", "b"] })).label).toBe(
      "moved",
    );
    // A list for a scalar key is still refused before anything is sent.
    await expect(database.bookings.find([1, 2] as never)).rejects.toThrow(
      'symmetria: primary key "id" takes one value, received an array',
    );
    await expect(
      database.users.find({ email: ["ada@x.test"] } as never),
    ).rejects.toThrow(
      'symmetria: unique key "email" takes one value, received an array',
    );
  });

  test("write options, upsert and returning forms", async () => {
    expect(
      await database.posts
        .update({ title: "A2" }, { where: { slug: "a" } })
        .returning("id", "title"),
    ).toEqual([{ id: 1, title: "A2" }]);

    const created = await database.posts
      .upsert({ slug: "d", title: "D", authorId: 3 }, { by: "slug" })
      .returning();

    expect(created).toEqual({
      id: 4,
      slug: "d",
      title: "D",
      authorId: 3,
      price: "0.00",
    });
    // The same key again overwrites the row instead of adding one.
    expect(
      await database.posts
        .upsert({ slug: "d", title: "D2", authorId: 2 }, { by: "slug" })
        .returning("id", "title", "authorId"),
    ).toEqual({ id: 4, title: "D2", authorId: 2 });
    // Only the listed columns change.
    expect(
      await database.posts
        .upsert([{ slug: "d", title: "D3", authorId: 1 }], {
          by: "slug",
          update: ["title"],
        })
        .returning("title", "authorId"),
    ).toEqual([{ title: "D3", authorId: 2 }]);
    expect(await database.posts.delete({ where: { slug: "d" } })).toEqual({
      affectedRows: 1,
    });
    expect(await database.posts.count()).toBe(3);
  });

  test("errors are classes with the fields PostgreSQL reported", async () => {
    const duplicate = await database.users
      .insert({ email: "ada@x.test", name: "Again" })
      .catch((error: unknown) => error);

    expect(duplicate).toBeInstanceOf(UniqueViolation);
    expect(duplicate).toBeInstanceOf(QueryError);
    expect(duplicate).toMatchObject({
      name: "UniqueViolation",
      kind: "unique",
      sqlState: "23505",
      constraint: "users_email_key",
      table: "users",
    });
    // The helpers that read driver errors read the class the same way.
    expect(sqlState(duplicate)).toBe("23505");
    expect(databaseError(duplicate)).toMatchObject({
      kind: "unique",
      constraint: "users_email_key",
    });
    expect((duplicate as Error).cause).toBeInstanceOf(Error);
    expect((duplicate as Error).cause).not.toBeInstanceOf(QueryError);

    await expect(
      database.posts.insert({ slug: "x", title: "X", authorId: 999 }).execute(),
    ).rejects.toBeInstanceOf(ForeignKeyViolation);
    await expect(
      database.posts.byId(1).update({ price: "-1" }).execute(),
    ).rejects.toBeInstanceOf(CheckViolation);
    const missing = await isolated.driver
      .execute({
        sql: "INSERT INTO users (email) VALUES ('n@x.test')",
        parameters: [],
      })
      .catch((error: unknown) => error);

    expect(missing).toBeInstanceOf(NotNullViolation);
    expect(missing).toMatchObject({ column: "name" });
    // Every other SQLSTATE is the base class.
    const other = await isolated.driver
      .execute({ sql: "SELECT 1 / 0", parameters: [] })
      .catch((error: unknown) => error);

    expect(other).toMatchObject({ name: "QueryError", kind: "other" });
    expect(sqlState(other)).toBe("22012");

    // Inside a transaction too, and the transaction rejects with the class.
    await expect(
      database.$transaction(async (transaction) => {
        await transaction.users.insert({ email: "ada@x.test", name: "T" });
      }),
    ).rejects.toBeInstanceOf(UniqueViolation);

    await expect(database.users.get(99)).rejects.toBeInstanceOf(NotFoundError);
    const many = await database
      .users((user) => ({ id: user.id }))
      .one()
      .catch((error: unknown) => error);

    expect(many).toBeInstanceOf(TooManyRowsError);
    expect(many).toBeInstanceOf(SymmetriaError);
    expect(many).toMatchObject({
      code: "SYMMETRIA_TOO_MANY_ROWS",
      table: "users",
    });
    expect(databaseError(many)).toBeUndefined();

    const tenant = database.$scope({ users: (user) => user.tenant.is(1) });
    const outside = await tenant.users
      .insert({ email: "o@x.test", name: "O", tenant: 2 })
      .catch((error: unknown) => error);

    expect(outside).toBeInstanceOf(OutOfScopeError);
    expect(outside).toMatchObject({
      code: "SYMMETRIA_OUT_OF_SCOPE",
      table: "users",
    });
    await expect(
      database.posts
        .insert({ slug: "n", title: "N", author: { connect: 12345 } })
        .execute(),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
