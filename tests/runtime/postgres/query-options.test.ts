import { describe, expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bool,
  bigint,
  prepare,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!url)("separate query options on PostgreSQL", () => {
  test("nested options keep per-parent limits, scopes and prepared bindings", async () => {
    const fixture = await testDatabase({
      url: url!,
      schema: schema({
        users: { id: int, tenant: int, name: text },
        posts: ({ users }) => ({
          id: int,
          author: users,
          title: text,
          views: bigint,
          published: bool,
        }),
      }),
    });
    const db = fixture.database;

    try {
      await db.users.insert([
        { id: 1, tenant: 1, name: "Ada" },
        { id: 2, tenant: 1, name: "Lin" },
        { id: 3, tenant: 2, name: "Hidden" },
      ]);
      await db.posts.insert([
        { id: 1, authorId: 1, title: "old", views: 1n, published: true },
        {
          id: 2,
          authorId: 1,
          title: "latest",
          views: 9007199254740993n,
          published: true,
        },
        { id: 3, authorId: 1, title: "draft", views: 2n, published: false },
        { id: 4, authorId: 2, title: "other", views: 3n, published: true },
      ]);
      const scoped = db.$scope({ users: ({ tenant }) => tenant.is(1) });
      const query = prepare({ size: int, minimum: bigint }, (p) =>
        scoped.users(
          ({ name, posts }) => ({
            name,
            posts: posts(({ title, views }) => ({ title, views }), {
              where: ({ views, published }, { and }) =>
                and(views.above(p.minimum), published.is(true)),
              orderBy: ({ id }) => id.descending,
              limit: 1,
            }),
          }),
          { orderBy: ({ id }) => id.ascending, limit: p.size },
        ),
      );
      expect(await query.execute({ size: 2, minimum: 0n })).toEqual([
        { name: "Ada", posts: [{ title: "latest", views: 9007199254740993n }] },
        { name: "Lin", posts: [{ title: "other", views: 3n }] },
      ]);
      expect(
        await query.execute({ size: 1, minimum: 9007199254740993n }),
      ).toEqual([{ name: "Ada", posts: [] }]);
      const card = scoped.users.shape(({ name }) => ({ name }));
      expect(
        await scoped.users(card, {
          orderBy: ({ id }) => id.descending,
          limit: 1,
        }),
      ).toEqual([{ name: "Lin" }]);
      expect(
        await scoped.$transaction(async (tx) =>
          tx.posts(({ title }) => ({ title }), {
            where: ({ author }) => author.name.is("Ada"),
            orderBy: ({ id }) => id.descending,
            limit: 1,
          }),
        ),
      ).toEqual([{ title: "draft" }]);
    } finally {
      await fixture.close();
    }
  });
});
