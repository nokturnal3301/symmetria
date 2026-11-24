import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema, table, int, text, bool } from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const users = table({
  id: int.auto,
  name: text.unique,
  active: bool.default(true),
});
const comments = table({ id: int.auto, body: text, postTitle: text });
const posts = table({
  id: int.auto,
  title: text,
  authorName: text,
  reviewerName: text.nullable,
}).relations((post, { to }) => ({
  author: to(users).one((user) => post.authorName.is(user.name)),
  mentions: to(() => comments).many((comment) =>
    comment.postTitle.is(post.title),
  ),
  reviewer: to(users)
    .one((user) => post.reviewerName.is(user.name))
    .inverse("reviewed"),
}));
const model = schema({ users, comments, posts });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("condition relations on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_conditions",
      max: 1,
    });
    database = isolated.database;
    await database.users.insert([
      { name: "Ada" },
      { name: "Linus", active: false },
    ]);
    await database.posts.insert([
      { title: "Hello", authorName: "Ada", reviewerName: "Linus" },
      { title: "Draft", authorName: "Nobody" },
      { title: "Notes", authorName: "Linus", reviewerName: "Ada" },
    ]);
    await database.comments.insert([
      { body: "first", postTitle: "Hello" },
      { body: "second", postTitle: "Hello" },
      { body: "stray", postTitle: "Missing" },
    ]);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("paths, nested collections and aggregates follow the predicate", async () => {
    const rows = await database.posts(
      (post) => ({
        title: post.title,
        author: post.author.name,
        active: post.author.active,
        mentions: post.mentions((comment) => ({ body: comment.body }), {
          orderBy: (comment) => comment.body.ascending,
        }),
        total: post.mentions.count(),
      }),
      { orderBy: (post) => post.id.ascending },
    );

    expect(rows).toEqual([
      {
        title: "Hello",
        author: "Ada",
        active: true,
        mentions: [{ body: "first" }, { body: "second" }],
        total: 2,
      },
      { title: "Draft", author: null, active: null, mentions: [], total: 0 },
      {
        title: "Notes",
        author: "Linus",
        active: false,
        mentions: [],
        total: 0,
      },
    ]);
  });

  test("quantifiers, explicit JOINs, inverses and scopes use the same predicate", async () => {
    expect(
      await database.posts((post) => ({ title: post.title }), {
        where: (post) =>
          post.mentions.some((comment) => comment.body.is("second")),
      }),
    ).toEqual([{ title: "Hello" }]);
    expect(
      await database.posts(
        (post, { innerJoin }) => {
          const author = innerJoin(post.author.as("author"));

          return { title: post.title, author: author.name };
        },
        { orderBy: (post) => post.id.ascending },
      ),
    ).toEqual([
      { title: "Hello", author: "Ada" },
      { title: "Notes", author: "Linus" },
    ]);
    expect(
      await database.users(
        (user) => ({
          name: user.name,
          reviewed: user.reviewed((post) => ({ title: post.title })),
        }),
        { orderBy: (user) => user.id.ascending },
      ),
    ).toEqual([
      { name: "Ada", reviewed: [{ title: "Notes" }] },
      { name: "Linus", reviewed: [{ title: "Hello" }] },
    ]);
    expect(
      await database
        .$scope({ users: (user) => user.active.is(true) })
        .posts((post) => ({ title: post.title, author: post.author.name }), {
          orderBy: (post) => post.id.ascending,
        }),
    ).toEqual([
      { title: "Hello", author: "Ada" },
      { title: "Draft", author: null },
      { title: "Notes", author: null },
    ]);
  });

  test("the inverse of a one() lists a row only under its first match, in every form", async () => {
    const people = table({ id: int, name: text, active: bool.default(true) });
    const notes = table({ id: int, ownerName: text.nullable }).relations(
      (note, { to }) => ({
        owner: to(people)
          .one((person) => note.ownerName.is(person.name))
          .inverse("owned"),
      }),
    );
    const twins = await testDatabase({
      url: databaseUrl!,
      schema: schema({ people, notes }),
      prefix: "symmetria_conditions_twins",
      max: 1,
    });

    try {
      const db = twins.database;
      // Two people named Ann: a note of "Ann" resolves to person 1.
      await db.people.insert([
        { id: 1, name: "Ann", active: false },
        { id: 2, name: "Ann" },
        { id: 3, name: "Bob" },
      ]);
      await db.notes.insert([
        { id: 10, ownerName: "Ann" },
        { id: 11, ownerName: "Bob" },
      ]);
      const read = (database: typeof db) =>
        database.people(
          (person) => ({
            id: person.id,
            owned: person.owned((note) => ({ id: note.id })),
            count: person.owned.count(),
          }),
          { orderBy: (person) => person.id.ascending },
        );
      const ids = (rows: readonly { id: number }[]) =>
        rows.map((row) => row.id);

      expect(
        await db.notes((note) => ({ id: note.id, owner: note.owner.id }), {
          orderBy: (note) => note.id.ascending,
        }),
      ).toEqual([
        { id: 10, owner: 1 },
        { id: 11, owner: 3 },
      ]);
      expect(await read(db)).toEqual([
        { id: 1, owned: [{ id: 10 }], count: 1 },
        { id: 2, owned: [], count: 0 },
        { id: 3, owned: [{ id: 11 }], count: 1 },
      ]);
      expect(
        ids(await db.people({ where: (person) => person.owned.some() })),
      ).toEqual([1, 3]);
      expect(
        ids(await db.people({ where: (person) => person.owned.none() })),
      ).toEqual([2]);
      expect(
        await db.people(
          (person, { innerJoin }) => ({
            id: person.id,
            note: innerJoin(person.owned).id,
          }),
          { orderBy: (person) => person.id.ascending },
        ),
      ).toEqual([
        { id: 1, note: 10 },
        { id: 3, note: 11 },
      ]);
      // Among the people a scope admits: the note now resolves to person 2.
      expect(
        await read(db.$scope({ people: (person) => person.active.is(true) })),
      ).toEqual([
        { id: 2, owned: [{ id: 10 }], count: 1 },
        { id: 3, owned: [{ id: 11 }], count: 1 },
      ]);
      // Write filters agree: person 2 owns nothing, so it is the one written.
      expect(
        await db.people
          .update({ name: "Ann (no notes)" })
          .where((person) => person.owned.none())
          .returning("id"),
      ).toEqual([{ id: 2 }]);
    } finally {
      await twins.close();
    }
  });

  test("the generated DDL has no foreign key for condition relations", async () => {
    const rows = await isolated.driver.execute({
      sql: `SELECT COUNT(*)::int AS "count" FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_schema = $1`,
      parameters: [isolated.namespace],
    });

    expect(rows).toMatchObject({ rows: [{ count: 0 }] });
  });
});
