/**
 * A scoped database never leaves a row outside its scope, like a row-level
 * security `WITH CHECK` policy: flat, bulk and chunked inserts, nested creates,
 * both paths of an upsert, updates and lookup updates fail with
 * `SYMMETRIA_OUT_OF_SCOPE` and write nothing, inside `$transaction` too.
 */
import { expect, test } from "bun:test";
import {
  schema,
  table,
  junction,
  int,
  text,
  sql,
  prepare,
} from "../../packages/runtime/src";
import { testDatabase } from "./postgres";

const members = table({ id: int, tenantId: int, name: text });
const notes = table({
  id: int.auto,
  // Omitted, the default puts the row outside every tenant.
  tenantId: int.default(0),
  title: text.unique,
  version: int.default(1),
  author: members,
});
const labels = table({ id: int.auto, tenantId: int, label: text.unique });
const noteLabels = junction({ note: notes, label: labels });
const model = schema({ members, notes, labels, noteLabels });

const outOfScope = (table: string, message = "would write a row outside") =>
  expect.objectContaining({
    code: "SYMMETRIA_OUT_OF_SCOPE",
    table,
    message: expect.stringContaining(message),
  });

export const scopedWriteTests = (): void => {
  const fixture = async () => {
    const isolated = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: model,
      prefix: "symmetria_scoped_writes",
      max: 2,
    });
    const { database } = isolated;
    await database.members.insert([
      { id: 1, tenantId: 1, name: "Ann" },
      { id: 2, tenantId: 2, name: "Bob" },
    ]);
    await database.notes.insert([
      { tenantId: 1, title: "A", authorId: 1 },
      { tenantId: 2, title: "B", authorId: 2 },
    ]);
    const current = { tenant: 1 };
    const scoped = database.$scope({
      members: (member) => member.tenantId.is(current.tenant),
      notes: (note) => note.tenantId.is(current.tenant),
      labels: (label) => label.tenantId.is(current.tenant),
    });
    const rows = async () =>
      database.notes(
        (note) => ({
          tenantId: note.tenantId,
          title: note.title,
          version: note.version,
        }),
        { orderBy: (note) => note.title.ascending },
      );

    return { database, scoped, current, rows, close: isolated.close };
  };

  test("inserts, bulk and chunked inserts write rows inside the scope only", async () => {
    const { database, scoped, rows, close } = await fixture();

    try {
      const before = await rows();

      await expect(
        scoped.notes
          .insert({ tenantId: 2, title: "stolen", authorId: 1 })
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      // The default value lands outside the scope: the check sees the row as stored.
      await expect(
        scoped.notes.insert({ title: "defaulted", authorId: 1 }).execute(),
      ).rejects.toEqual(outOfScope("notes"));
      await expect(
        scoped.notes
          .insert([
            { tenantId: 1, title: "kept?", authorId: 1 },
            { tenantId: 2, title: "stolen", authorId: 1 },
          ])
          .returning((note) => ({ id: note.id }))
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      // 30,001 rows of three parameters run as two statements in one
      // transaction; the last row fails the second one and undoes the first.
      const many = Array.from({ length: 30_001 }, (_, position) => ({
        tenantId: position === 30_000 ? 2 : 1,
        title: `bulk ${position}`,
        authorId: 1,
      }));
      await expect(scoped.notes.insert(many).execute()).rejects.toEqual(
        outOfScope("notes"),
      );
      expect(await rows()).toEqual(before);

      expect(
        await scoped.notes
          .insert({ tenantId: 1, title: "own", authorId: 1 })
          .returning((note) => ({ title: note.title })),
      ).toEqual({ title: "own" });
      expect(
        await scoped.notes.insert(many.map((row) => ({ ...row, tenantId: 1 }))),
      ).toEqual({ affectedRows: 30_001 });
      // An unscoped database writes any row.
      expect(
        await database.notes.insert({ title: "anywhere", authorId: 2 }),
      ).toEqual({ affectedRows: 1 });
    } finally {
      await close();
    }
  }, 20_000);

  test("updates and lookup updates cannot move a row out of the scope", async () => {
    const { scoped, rows, close } = await fixture();

    try {
      const before = await rows();

      await expect(
        scoped.notes
          .update({ tenantId: 2 })
          .where((note) => note.title.is("A"))
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      await expect(
        scoped.notes.update({ tenantId: 2 }).all().execute(),
      ).rejects.toEqual(outOfScope("notes"));
      await expect(
        scoped.notes.by.title("A").update({ tenantId: 3 }).execute(),
      ).rejects.toEqual(outOfScope("notes"));
      await expect(
        scoped.notes
          .update((note) => ({ tenantId: note.tenantId.plus(1) }))
          .all()
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      expect(await rows()).toEqual(before);

      // Rows that stay inside the scope update as before; others are not reached.
      expect(
        await scoped.notes
          .update({ version: 2 })
          .all()
          .returning((note) => ({
            title: note.title,
          })),
      ).toEqual([{ title: "A" }]);
      expect(await scoped.notes.by.title("B").update({ tenantId: 2 })).toEqual({
        affectedRows: 0,
      });
      expect(await scoped.notes.by.title("A").update({ tenantId: 1 })).toEqual({
        affectedRows: 1,
      });
    } finally {
      await close();
    }
  });

  test("upserts check the conflicting row, the inserted row and the updated row", async () => {
    const { scoped, rows, close } = await fixture();

    try {
      const before = await rows();

      // Insert path: a new row outside the scope.
      await expect(
        scoped.notes
          .insert({ tenantId: 2, title: "new", authorId: 1 })
          .onConflict("title")
          .doUpdate("version")
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      // Conflict with another tenant's row.
      await expect(
        scoped.notes
          .insert({ tenantId: 1, title: "B", authorId: 1, version: 5 })
          .onConflict("title")
          .doUpdate("version")
          .execute(),
      ).rejects.toEqual(outOfScope("notes", "conflicted with a row outside"));
      // Update path: the row inside the scope would leave it.
      await expect(
        scoped.notes
          .insert({ tenantId: 2, title: "A", authorId: 1 })
          .onConflict("title")
          .doUpdate("tenantId")
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      // DO NOTHING checks the rows it inserts.
      await expect(
        scoped.notes
          .insert({ tenantId: 2, title: "other", authorId: 1 })
          .onConflict("title")
          .doNothing()
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      expect(await rows()).toEqual(before);

      expect(
        await scoped.notes
          .insert({ tenantId: 1, title: "A", authorId: 1, version: 3 })
          .onConflict("title")
          .doUpdate("version")
          .returning((note) => ({ version: note.version })),
      ).toEqual({ version: 3 });
    } finally {
      await close();
    }
  });

  test("a conditional upsert tells a row outside the scope from a false condition", async () => {
    const { scoped, rows, close } = await fixture();

    try {
      const newer = (title: string, version: number) =>
        scoped.notes
          .insert({ tenantId: 1, title, authorId: 1, version })
          .onConflict("title")
          .doUpdate(
            { version },
            {
              where: (current, incoming) =>
                incoming.version.above(current.version),
            },
          )
          .returning((note) => ({ version: note.version }));

      // Another tenant's row: an error, not a silently skipped row.
      await expect(newer("B", 9).execute()).rejects.toEqual(
        outOfScope("notes", "conflicted with a row outside"),
      );
      // Inside the scope, a false condition still skips the row.
      expect(await newer("A", 1)).toBeNull();
      expect(
        await scoped.notes
          .insert({ tenantId: 1, title: "A", authorId: 1, version: 1 })
          .onConflict("title")
          .doUpdate(
            { version: 1 },
            {
              where: (current, incoming) =>
                incoming.version.above(current.version),
            },
          ),
      ).toEqual({ affectedRows: 0 });
      expect(await newer("A", 4)).toEqual({ version: 4 });
      expect(await rows()).toEqual([
        { tenantId: 1, title: "A", version: 4 },
        { tenantId: 2, title: "B", version: 1 },
      ]);
    } finally {
      await close();
    }
  });

  test("nested creates check every table they write and roll back as a whole", async () => {
    const { database, scoped, rows, close } = await fixture();

    try {
      const before = await rows();

      await expect(
        scoped.notes
          .insert({
            tenantId: 1,
            title: "nested",
            author: { create: { id: 3, tenantId: 2, name: "Eve" } },
          })
          .execute(),
      ).rejects.toEqual(outOfScope("members"));
      await expect(
        scoped.members
          .insert({
            id: 4,
            tenantId: 1,
            name: "Dan",
            notes: {
              create: [{ tenantId: 1, title: "first" }, { title: "x" }],
            },
          })
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      await expect(
        scoped.notes
          .insert({
            tenantId: 1,
            title: "labelled",
            authorId: 1,
            labels: { connectOrCreate: [{ tenantId: 2, label: "red" }] },
          })
          .execute(),
      ).rejects.toEqual(outOfScope("labels"));
      expect(await rows()).toEqual(before);
      expect(await database.members.count()).toBe(2);
      expect(await database.labels.count()).toBe(0);

      expect(
        await scoped.notes
          .insert({
            tenantId: 1,
            title: "labelled",
            author: { create: { id: 5, tenantId: 1, name: "Fay" } },
            labels: { connectOrCreate: [{ tenantId: 1, label: "red" }] },
          })
          .returning((note) => ({ title: note.title })),
      ).toEqual({ title: "labelled" });
    } finally {
      await close();
    }
  });

  test("a violation inside $transaction rejects and rolls the transaction back", async () => {
    const { scoped, rows, close } = await fixture();

    try {
      const before = await rows();

      await expect(
        scoped.$transaction(async (transaction) => {
          await transaction.notes.insert({
            tenantId: 1,
            title: "first",
            authorId: 1,
          });
          await transaction.notes
            .update({ tenantId: 2 })
            .where((note) => note.title.is("first"));
        }),
      ).rejects.toEqual(outOfScope("notes"));
      // A nested insert inside the transaction runs in a savepoint.
      await expect(
        scoped.$transaction(async (transaction) => {
          await transaction.notes.insert({
            tenantId: 1,
            title: "second",
            author: { create: { id: 6, tenantId: 2, name: "Gus" } },
          });
        }),
      ).rejects.toEqual(outOfScope("members"));
      // A caught violation of one statement still aborts the transaction, like
      // any SQL error, and what runs after it reports the same violation.
      let next: unknown;
      await expect(
        scoped.$transaction(async (transaction) => {
          await transaction.notes
            .insert({ tenantId: 2, title: "caught", authorId: 1 })
            .execute()
            .catch(() => undefined);
          next = await transaction.notes
            .insert({ tenantId: 1, title: "next", authorId: 1 })
            .execute()
            .catch((error: unknown) => error);
        }),
      ).rejects.toEqual(outOfScope("notes"));
      expect(next).toEqual(outOfScope("notes"));
      expect(await rows()).toEqual(before);
    } finally {
      await close();
    }
  });

  test("a violation in a savepoint, nested or chunked insert leaves the transaction usable", async () => {
    const { database, scoped, rows, close } = await fixture();

    try {
      const many = Array.from({ length: 30_001 }, (_, position) => ({
        tenantId: position === 30_000 ? 2 : 1,
        title: `bulk ${position}`,
        authorId: 1,
      }));

      const failures = await scoped.$transaction(async (transaction) => {
        await transaction.notes.insert({
          tenantId: 1,
          title: "kept",
          authorId: 1,
        });

        const caught = (operation: PromiseLike<unknown>) =>
          Promise.resolve(operation).then(
            () => "written",
            (error: { code?: string; table?: string }) =>
              `${error.code} ${error.table}`,
          );
        const result = [
          await caught(
            transaction.notes.insert({
              tenantId: 1,
              title: "nested",
              author: { create: { id: 7, tenantId: 2, name: "Hal" } },
            }),
          ),
          await caught(transaction.notes.insert(many)),
          await caught(
            transaction.$transaction((savepoint) =>
              savepoint.notes
                .update({ tenantId: 2 })
                .where((note) => note.title.is("A")),
            ),
          ),
        ];

        await transaction.notes.insert({
          tenantId: 1,
          title: "after",
          authorId: 1,
        });

        return result;
      });

      expect(failures).toEqual([
        "SYMMETRIA_OUT_OF_SCOPE members",
        "SYMMETRIA_OUT_OF_SCOPE notes",
        "SYMMETRIA_OUT_OF_SCOPE notes",
      ]);
      expect((await rows()).map((row) => row.title).sort()).toEqual([
        "A",
        "B",
        "after",
        "kept",
      ]);
      expect(await database.members.count()).toBe(2);
    } finally {
      await close();
    }
  }, 20_000);

  test("scopes with subqueries, NULL results and several conflicting rows", async () => {
    const { database, scoped, rows, close } = await fixture();

    try {
      const before = await rows();
      // The scope follows the author's tenant through a subquery.
      const byAuthor = database.$scope({
        notes: (note) =>
          note.authorId.in(
            database.members((member) => ({ id: member.id }), {
              where: (member) => member.tenantId.is(1),
            }),
          ),
      });

      await expect(
        byAuthor.notes
          .insert({ tenantId: 1, title: "Bob's", authorId: 2 })
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      await expect(
        byAuthor.notes
          .insert({ tenantId: 1, title: "B", authorId: 1 })
          .onConflict("title")
          .doUpdate("authorId")
          .execute(),
      ).rejects.toEqual(outOfScope("notes", "conflicted with a row outside"));
      await expect(
        byAuthor.notes
          .insert({ tenantId: 1, title: "A", authorId: 2 })
          .onConflict("title")
          .doUpdate("authorId")
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      // A scope that is NULL for the written row counts as outside it.
      await expect(
        database
          .$scope({
            notes: (note) =>
              sql<boolean>`NULLIF(${note.version}, 9) > 0`.is(true),
          })
          .notes.update({ version: 9 })
          .where((note) => note.title.is("A"))
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      // One conflicting row outside the scope fails the whole statement.
      await expect(
        scoped.notes
          .insert([
            { tenantId: 1, title: "fresh", authorId: 1 },
            { tenantId: 1, title: "A", authorId: 1, version: 2 },
            { tenantId: 1, title: "B", authorId: 1, version: 2 },
          ])
          .onConflict("title")
          .doUpdate("version")
          .execute(),
      ).rejects.toEqual(outOfScope("notes", "conflicted with a row outside"));
      // A true condition still checks where the updated row ends up.
      await expect(
        scoped.notes
          .insert({ tenantId: 1, title: "A", authorId: 1, version: 5 })
          .onConflict("title")
          .doUpdate(
            { tenantId: 2 },
            {
              where: (current, incoming) =>
                incoming.version.above(current.version),
            },
          )
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      // Relation paths in where() restrict the update; the check still applies.
      await expect(
        scoped.notes
          .update({ tenantId: 2 })
          .where((note) => note.author.name.is("Ann"))
          .execute(),
      ).rejects.toEqual(outOfScope("notes"));
      expect(await rows()).toEqual(before);

      expect(
        await byAuthor.notes
          .insert({ tenantId: 2, title: "Ann's", authorId: 1 })
          .returning((note) => ({ title: note.title })),
      ).toEqual({ title: "Ann's" });
      expect(
        await scoped.notes
          .update({ version: 3 })
          .where((note) => note.author.name.is("Ann")),
      ).toEqual({ affectedRows: 1 });
    } finally {
      await close();
    }
  });

  test("prepared and reused writes check the scope current at each execution", async () => {
    const { scoped, current, rows, close } = await fixture();

    try {
      const add = prepare({ title: text }, (parameters) =>
        scoped.notes.insert({
          tenantId: 1,
          title: parameters.title,
          authorId: 1,
        }),
      );
      const reused = scoped.notes.insert({
        tenantId: 1,
        title: "reused",
        authorId: 1,
      });

      expect(await add({ title: "prepared" })).toEqual({ affectedRows: 1 });
      current.tenant = 2;
      await expect(add({ title: "later" })).rejects.toEqual(
        outOfScope("notes"),
      );
      await expect(reused.execute()).rejects.toEqual(outOfScope("notes"));
      current.tenant = 1;
      expect(await reused).toEqual({ affectedRows: 1 });
      expect((await rows()).map((row) => row.title)).toEqual([
        "A",
        "B",
        "prepared",
        "reused",
      ]);
    } finally {
      await close();
    }
  });
};
