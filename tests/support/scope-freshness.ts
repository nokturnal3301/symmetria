/**
 * `$scope()` callbacks read a changing tenant: reused query objects, prepared
 * queries and writes, lookups and nested relations must bind the tenant
 * current at each execution, never the one from when they were built.
 */
import { expect, test } from "bun:test";
import { schema, table, int, text, prepare } from "../../packages/runtime/src";
import { testDatabase } from "./postgres";

const members = table({ id: int, tenantId: int, name: text });
const documents = table({
  id: int,
  tenantId: int,
  title: text.unique,
  owner: members,
});
const model = schema({ members, documents });

export const scopeFreshnessTests = (): void => {
  const fixture = async () => {
    const isolated = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: model,
      prefix: "symmetria_scope_freshness",
      max: 2,
    });
    const { database } = isolated;
    await database.members.insert([
      { id: 1, tenantId: 1, name: "Ann" },
      { id: 2, tenantId: 2, name: "Bob" },
    ]);
    await database.documents.insert([
      { id: 1, tenantId: 1, title: "A1", ownerId: 1 },
      { id: 2, tenantId: 2, title: "B1", ownerId: 2 },
      { id: 3, tenantId: 2, title: "B2", ownerId: 2 },
    ]);
    const current = { tenant: 1 };
    const scoped = database.$scope({
      members: (member) => member.tenantId.is(current.tenant),
      documents: (document) => document.tenantId.is(current.tenant),
    });
    const titles = async () =>
      (
        await database.documents((document) => ({ title: document.title }), {
          orderBy: (document) => document.id.ascending,
        })
      ).map((row) => row.title);

    return { database, scoped, current, titles, close: isolated.close };
  };

  test("reused and prepared reads follow the current tenant", async () => {
    const { scoped, current, close } = await fixture();

    try {
      const listing = scoped.documents(
        (document) => ({
          title: document.title,
          owner: document.owner((owner) => ({ name: owner.name })),
        }),
        { orderBy: (document) => document.id.ascending },
      );
      const owners = scoped.members((member) => ({
        name: member.name,
        documents: member.documents.count(),
      }));
      const prepared = prepare({ id: int }, (parameters) =>
        scoped.documents((document) => ({ title: document.title }), {
          where: (document) => document.id.is(parameters.id),
        }),
      );
      const lookup = scoped.documents.byId(1);

      expect(await listing).toEqual([{ title: "A1", owner: { name: "Ann" } }]);
      expect(await owners).toEqual([{ name: "Ann", documents: 1 }]);
      expect(await prepared({ id: 1 })).toEqual([{ title: "A1" }]);
      expect(await lookup.maybeOne()).toMatchObject({ title: "A1" });

      current.tenant = 2;
      expect(await listing).toEqual([
        { title: "B1", owner: { name: "Bob" } },
        { title: "B2", owner: { name: "Bob" } },
      ]);
      expect(await owners).toEqual([{ name: "Bob", documents: 2 }]);
      expect(await prepared({ id: 1 })).toEqual([]);
      expect(await prepared.maybeOne({ id: 2 })).toEqual({ title: "B1" });
      expect(await prepared.count({ id: 3 })).toBe(1);
      expect(await lookup.maybeOne()).toBeNull();
      expect(await listing.count()).toBe(2);
      expect((await listing.page({ size: 1 })).items).toEqual([
        { title: "B1", owner: { name: "Bob" } },
      ]);

      const streamed: string[] = [];

      for await (const row of listing.stream({ size: 1 })) {
        streamed.push(row.title);
      }

      expect(streamed).toEqual(["B1", "B2"]);
    } finally {
      await close();
    }
  });

  test("reused and prepared writes never touch another tenant's rows", async () => {
    const { scoped, current, titles, close } = await fixture();

    try {
      const renameAll = scoped.documents
        .update((document) => ({ title: document.title }))
        .all();
      const preparedRename = prepare({ id: int, title: text }, (parameters) =>
        scoped.documents
          .update({ title: parameters.title })
          .where((document) => document.id.is(parameters.id)),
      );
      const lookupRename = scoped.documents.byId(1);
      const preparedDelete = prepare({ id: int }, (parameters) =>
        scoped.documents.byId(parameters.id).delete(),
      );
      const upsert = scoped.documents
        .insert({ id: 9, tenantId: 1, title: "A1", ownerId: 1 })
        .onConflict("title")
        .doUpdate("ownerId");

      expect(await renameAll).toEqual({ affectedRows: 1 });
      current.tenant = 2;
      expect(await renameAll).toEqual({ affectedRows: 2 });
      expect(await preparedRename({ id: 1, title: "stolen" })).toEqual({
        affectedRows: 0,
      });
      expect(await lookupRename.update({ title: "stolen" })).toEqual({
        affectedRows: 0,
      });
      expect(await preparedDelete({ id: 1 })).toEqual({ affectedRows: 0 });
      // Built while tenant 1 was current, the upsert now conflicts outside the scope.
      await expect(upsert.execute()).rejects.toMatchObject({
        code: "SYMMETRIA_OUT_OF_SCOPE",
      });
      expect(await titles()).toEqual(["A1", "B1", "B2"]);

      expect(await preparedRename({ id: 2, title: "B1 renamed" })).toEqual({
        affectedRows: 1,
      });
      expect(await preparedDelete({ id: 3 })).toEqual({ affectedRows: 1 });
      current.tenant = 1;
      expect(await lookupRename.update({ title: "A1 renamed" })).toEqual({
        affectedRows: 1,
      });
      expect(await titles()).toEqual(["A1 renamed", "B1 renamed"]);
    } finally {
      await close();
    }
  });

  test("scoped transactions and relation filters bind the current tenant", async () => {
    const { scoped, current, close } = await fixture();

    try {
      const withDocuments = scoped.members(
        (member) => ({ name: member.name }),
        {
          where: (member) =>
            member.documents.some((document) => document.title.like("B%")),
        },
      );
      const inTransaction = () =>
        scoped.$transaction((transaction) =>
          transaction.documents((document) => ({ title: document.title })),
        );

      expect(await withDocuments).toEqual([]);
      expect(await inTransaction()).toEqual([{ title: "A1" }]);
      current.tenant = 2;
      expect(await withDocuments).toEqual([{ name: "Bob" }]);
      expect((await inTransaction()).length).toBe(2);
    } finally {
      await close();
    }
  });
};
