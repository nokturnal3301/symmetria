import { describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  bigint,
  timestamptz,
  index,
  prepare,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!url)("ergonomic query and mutation APIs", () => {
  test("lookup writes, callable prepared mutations and reusable RETURNING execute with scopes and nested inserts", async () => {
    const users = table({
      id: int.auto,
      tenant: int,
      name: text,
      email: text.unique,
    });
    const model = schema({
      users,
      posts: table({
        id: int.auto,
        author: users,
        title: text,
        views: bigint,
        createdAt: timestamptz,
      }),
      memberships: table({ user: users, tenant: int, label: text })
        .primaryKey(({ userId, tenant }) => [userId, tenant])
        .indexes(({ tenant, label }) => ({
          tenantLabel: index(tenant, label).unique,
        })),
    });
    const fixture = await testDatabase({ url: url!, schema: model });
    const db = fixture.database;
    const card = model.users.shape(({ id, name }, { sql }) => ({
      id,
      label: sql.of(text)`upper(${name})`,
    }));

    try {
      const ada = await db.users
        .insert({
          tenant: 1,
          name: "Ada",
          email: "ada",
          posts: {
            create: [
              {
                title: "first",
                views: 9007199254740993n,
                createdAt: new Date("2026-01-01Z"),
              },
              { title: "last", views: 2n, createdAt: new Date("2026-02-01Z") },
            ],
          },
        })
        .returning(card);
      expect(ada.label).toBe("ADA");
      const hidden = await db.users
        .insert({ tenant: 2, name: "Hidden", email: "hidden" })
        .returning(card);
      const scoped = db.$scope({ users: ({ tenant }) => tenant.is(1) });
      const report = scoped.users(({ name, posts }) => ({
        name,
        total: posts.sum.views,
        last: posts.maximum.createdAt,
        recent: posts({ orderBy: ({ id }) => id.descending, limit: 1 }).sum
          .views,
      }));
      expect(await report({ limit: 1 })).toEqual([
        {
          name: "Ada",
          total: "9007199254740995",
          last: new Date("2026-02-01Z"),
          recent: "2",
        },
      ]);
      expect(
        await scoped.users
          .byId(hidden.id)
          .update({ name: "Wrong" })
          .returning(card),
      ).toEqual([]);
      expect(await scoped.users.by.email("hidden").delete()).toEqual({
        affectedRows: 0,
      });
      const rename = prepare({ email: text, name: text }, (p) =>
        scoped.users.by.email(p.email).update({ name: p.name }).returning(card),
      );
      expect(await rename({ email: "ada", name: "Grace" })).toEqual([
        { id: ada.id, label: "GRACE" },
      ]);
      await db.memberships.insert({
        userId: ada.id,
        tenant: 1,
        label: "member",
      });
      expect(
        await db.memberships
          .byId({ userId: ada.id, tenant: 1 })
          .update({ label: "admin" }),
      ).toEqual({ affectedRows: 1 });
      expect(
        await db.memberships.by
          .tenantLabel({ tenant: 1, label: "admin" })
          .delete(),
      ).toEqual({ affectedRows: 1 });
      await expect(
        scoped.$transaction(async (tx) => {
          await tx.users.byId(ada.id).update({ name: "Temporary" });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await scoped.users.byId(ada.id).one()).name).toBe("Grace");
      expect(await db.users.byId(hidden.id).delete().returning(card)).toEqual([
        { id: hidden.id, label: "HIDDEN" },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
