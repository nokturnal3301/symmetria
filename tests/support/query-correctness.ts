/**
 * Queries that used to return wrong data silently: CTEs hiding tables, jsonb
 * transforms applied twice, prepared LIMITs in terminals, duplicate upsert keys
 * across chunks, JSON-path operators and one() condition relations with
 * several matches.
 */
import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  jsonb,
  prepare,
  sum,
  average,
  maximum,
  sql,
} from "../../packages/runtime/src";
import { expectDataError } from "./data-errors";
import { testDatabase } from "./postgres";

/** A Standard Schema that adds one on read, the shape Zod publishes for `.transform()`. */
const incremented = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) =>
      typeof value === "number"
        ? { value: value + 1 }
        : { issues: [{ message: "expected a number" }] },
    types: undefined as unknown as { input: number; output: number },
  },
};
/** Stored as ISO text, read as a Date. */
const instant = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) =>
      typeof value === "string"
        ? { value: new Date(value) }
        : {
            issues: [
              { message: `expected a string, received ${typeof value}` },
            ],
          },
    types: undefined as unknown as { input: string; output: Date },
  },
};

const people = table({ id: int.auto, name: text });
const notes = table({
  id: int.auto,
  body: text,
  writerName: text,
}).relations((note, { to }) => ({
  writer: to(people).one((person) => note.writerName.is(person.name)),
}));
const counters = table({ id: int.auto, code: int.unique, label: text });
const documents = table({
  id: int.auto,
  counter: jsonb(incremented),
  at: jsonb(instant),
  meta: jsonb<{ theme: string; size: number }>(),
  value: jsonb<string | null>(),
  optional: jsonb<{ a: number }>().nullable,
});
const model = schema({ people, notes, counters, documents });

export const queryCorrectnessTests = (): void => {
  const fixture = async () => {
    const isolated = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: model,
      prefix: "symmetria_correctness",
      max: 2,
    });
    const { database } = isolated;
    // Two people share a name, so "Ann" matches twice.
    await database.people.insert([
      { name: "Ann" },
      { name: "Bob" },
      { name: "Ann" },
    ]);
    await database.notes.insert([
      { body: "n1", writerName: "Ann" },
      { body: "n2", writerName: "Bob" },
      { body: "n3", writerName: "Zed" },
    ]);

    return { database, close: isolated.close };
  };

  test("a CTE cannot take the name of a table and hide it", async () => {
    const { database, close } = await fixture();

    try {
      const named = database.people((person) => ({ id: person.id }), {
        where: (person) => person.id.above(100),
      });

      expect(() => named.cte("people")).toThrow(
        /CTE "people" has the SQL name of table "people"/,
      );
      expect(() => named.cte("notes")).toThrow(/would hide it/);
      expect(() =>
        named.recursive("people", (self) => self((row) => ({ id: row.id }))),
      ).toThrow(/would hide it/);

      // A CTE from another schema is checked against this statement's tables.
      const other = schema({ archive: table({ id: int.auto, name: text }) });
      const archived = other.archive((row) => ({ id: row.id })).cte("people");
      expect(() =>
        database
          .people((person) => ({ id: person.id }), {
            where: (person) =>
              person.id.in(archived((row) => ({ id: row.id }))),
          })
          .toSQL(),
      ).toThrow(/would hide it/);

      // Any other name still works, including inside relation aggregates.
      const high = named.cte("high_people");
      expect(
        await database.people((person) => ({ id: person.id }), {
          where: (person) => person.id.notIn(high((row) => ({ id: row.id }))),
          orderBy: (person) => person.id.ascending,
        }),
      ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } finally {
      await close();
    }
  });

  test("jsonb(schema) stores the input and transforms once, on read", async () => {
    const { database, close } = await fixture();

    try {
      const created = await database.documents
        .insert({
          counter: 1,
          at: "2026-11-09T10:00:00.000Z",
          meta: { theme: "dark", size: 2 },
          value: "x",
        })
        .returning((document) => ({
          id: document.id,
          counter: document.counter,
          at: document.at,
        }));
      expect(created.counter).toBe(2);
      expect(created.at).toEqual(new Date("2026-11-09T10:00:00.000Z"));

      const stored = await database
        .documents(
          (document) => ({
            counter: sql<string>`${document.counter}::text`,
            at: sql<string>`${document.at}::text`,
          }),
          { where: (document) => document.id.is(created.id) },
        )
        .one();
      expect(stored).toEqual({
        counter: "1",
        at: '"2026-11-09T10:00:00.000Z"',
      });

      // Reading again does not drift: the stored input is transformed once.
      const read = await database.documents.byId(created.id).one();
      expect(read.counter).toBe(2);
      expect(await database.documents.byId(created.id).one()).toMatchObject({
        counter: 2,
      });

      // The output form is not a valid input: writing it back fails clearly.
      await expectDataError(
        () =>
          database.documents
            .byId(created.id)
            .update({ at: read.at as unknown as string }),
        /invalid jsonb value: expected a string, received object/,
      );
    } finally {
      await close();
    }
  });

  test("JS null on a non-nullable jsonb column is the JSON value null", async () => {
    const { database, close } = await fixture();

    try {
      const [stored] = await database.documents
        .insert([
          {
            counter: 1,
            at: "2026-01-01T00:00:00.000Z",
            meta: { theme: "a", size: 1 },
            value: null,
            optional: null,
          },
          {
            counter: 1,
            at: "2026-01-01T00:00:00.000Z",
            meta: { theme: "b", size: 1 },
            value: "text",
          },
        ])
        .returning((document) => ({
          id: document.id,
          value: document.value,
          kind: sql<string>`jsonb_typeof(${document.value})`,
          optional: sql<boolean>`${document.optional} IS NULL`,
        }));
      expect(stored).toEqual({
        id: stored!.id,
        value: null,
        kind: "null",
        optional: true,
      });
      expect(
        await database.documents((document) => ({ id: document.id }), {
          where: (document) => document.value.is(null),
        }),
      ).toEqual([{ id: stored!.id }]);
      expect(
        (
          await database.documents((document) => ({ id: document.id }), {
            where: (document) => document.value.isNot(null),
          })
        ).length,
      ).toBe(1);
      expect(
        await database.documents
          .byId(stored!.id)
          .update({ value: "set" })
          .returning((document) => ({ value: document.value })),
      ).toEqual([{ value: "set" }]);
    } finally {
      await close();
    }
  });

  test("prepared terminals respect a parameterized root LIMIT", async () => {
    const { database, close } = await fixture();

    try {
      const page = prepare({ size: int }, (parameters) =>
        database.people((person) => ({ id: person.id }), {
          orderBy: (person) => person.id.ascending,
          limit: parameters.size,
        }),
      );

      expect(await page({ size: 2 })).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await page.first({ size: 2 })).toEqual({ id: 1 });
      expect(await page.first({ size: 0 })).toBeNull();
      // A LIMIT of 1 reads one row, so one() sees exactly one.
      expect(await page.one({ size: 1 })).toEqual({ id: 1 });
      expect(await page.maybeOne({ size: 1 })).toEqual({ id: 1 });
      expect(await page.maybeOne({ size: 0 })).toBeNull();
      await expect(page.one({ size: 3 })).rejects.toMatchObject({
        code: "SYMMETRIA_TOO_MANY_ROWS",
      });
      await expect(page.one({ size: 0 })).rejects.toMatchObject({
        code: "SYMMETRIA_RECORD_NOT_FOUND",
      });
      expect(await page.count({ size: 2 })).toBe(2);
      expect(await page.exists({ size: 0 })).toBe(false);
    } finally {
      await close();
    }
  });

  test("duplicate upsert keys throw the same error at every size", async () => {
    const { database, close } = await fixture();

    try {
      // 40,000 rows bind 80,000 parameters: more than one INSERT statement.
      const rows = Array.from({ length: 40_000 }, (_, position) => ({
        code: position,
        label: `row ${position}`,
      }));
      const duplicated = [...rows, { code: 7, label: "again" }];

      for (const values of [
        [
          { code: 7, label: "a" },
          { code: 7, label: "b" },
        ],
        duplicated,
      ]) {
        await expectDataError(
          () =>
            database.counters
              .insert(values)
              .onConflict("code")
              .doUpdate("label"),
          /share a conflict key/,
          "SYMMETRIA_DUPLICATE_CONFLICT_KEY",
        );
      }

      expect(await database.counters.count()).toBe(0);

      // DO NOTHING keeps the first row of a duplicate key, at every size.
      const inserted = await database.counters
        .insert(duplicated)
        .onConflict("code")
        .doNothing()
        .returning((counter) => ({ code: counter.code }));
      expect(inserted).toHaveLength(40_000);
      expect(
        await database
          .counters((counter) => ({ label: counter.label }), {
            where: (counter) => counter.code.is(7),
          })
          .one(),
      ).toEqual({ label: "row 7" });

      // Distinct keys still upsert across chunks.
      expect(
        await database.counters
          .insert(rows.map((row) => ({ ...row, label: "updated" })))
          .onConflict("code")
          .doUpdate("label"),
      ).toEqual({ affectedRows: 40_000 });
    } finally {
      await close();
    }
  });

  test("JSON paths match text, compute numbers and order for MIN/MAX", async () => {
    const { database, close } = await fixture();

    try {
      await database.documents.insert([
        {
          counter: 0,
          at: "2026-01-01T00:00:00.000Z",
          meta: { theme: "dark", size: 2 },
          value: "Dark mode",
        },
        {
          counter: 0,
          at: "2026-01-01T00:00:00.000Z",
          meta: { theme: "light", size: 5 },
          value: "light",
        },
      ]);

      expect(
        await database.documents((document) => ({ id: document.id }), {
          where: (document) => document.meta.path("theme").like("d%"),
        }),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.documents((document) => ({ id: document.id }), {
          where: (document) => document.value.ilike("dark%"),
        }),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.documents(
          (document) => ({
            plus: document.meta.path("size").plus(1),
            half: document.meta.path("size").divide(2),
            times: document.meta
              .path("size")
              .multiply(document.meta.path("size")),
          }),
          { orderBy: (row) => row.id.ascending },
        ),
      ).toEqual([
        { plus: 3, half: 1, times: 4 },
        { plus: 6, half: 2.5, times: 25 },
      ]);
      expect(
        await database
          .documents((document) => ({
            total: sum(document.meta.path("size")),
            mean: average(document.meta.path("size")),
          }))
          .one(),
      ).toEqual({ total: "7", mean: "3.5000000000000000" });
      // JSON numbers order numerically, as jsonb does.
      expect(
        await database
          .documents((document) => ({
            largest: maximum(document.meta.path("size")),
          }))
          .one(),
      ).toEqual({ largest: 5 });
      // Comparisons and search keep working on JSON values.
      expect(
        await database.documents((document) => ({ id: document.id }), {
          where: (document) => [
            document.meta.path("size").above(3),
            document.meta.path("theme").in(["light", "dim"]),
            document.value.search("light"),
          ],
        }),
      ).toEqual([{ id: 2 }]);
    } finally {
      await close();
    }
  });

  test("a one() condition relation resolves to its first match by primary key", async () => {
    const { database, close } = await fixture();

    try {
      expect(
        await database.notes(
          (note) => ({
            body: note.body,
            writer: note.writer((person) => ({ id: person.id })),
          }),
          { orderBy: (row) => row.id.ascending },
        ),
      ).toEqual([
        { body: "n1", writer: { id: 1 } },
        { body: "n2", writer: { id: 2 } },
        { body: "n3", writer: null },
      ]);
      expect(
        await database.notes(
          (note) => ({ body: note.body, writer: note.writer.id }),
          { orderBy: (row) => row.id.ascending },
        ),
      ).toEqual([
        { body: "n1", writer: 1 },
        { body: "n2", writer: 2 },
        { body: "n3", writer: null },
      ]);
      expect(
        await database.notes(
          (note, { leftJoin }) => {
            const writer = leftJoin(note.writer);

            return { body: note.body, writer: writer.id };
          },
          { orderBy: (row) => row.id.ascending },
        ),
      ).toHaveLength(3);
      expect(
        await database.notes(
          (note, { innerJoin }) => {
            const writer = innerJoin(note.writer);

            return { body: note.body, writer: writer.id };
          },
          { orderBy: (row) => row.id.ascending },
        ),
      ).toEqual([
        { body: "n1", writer: 1 },
        { body: "n2", writer: 2 },
      ]);
      expect(
        await database.notes(
          (note) => ({ body: note.body, writers: note.writer.count() }),
          { orderBy: (row) => row.id.ascending },
        ),
      ).toEqual([
        { body: "n1", writers: 1 },
        { body: "n2", writers: 1 },
        { body: "n3", writers: 0 },
      ]);
      // A quantifier sees the first match only: person 3 is never the writer.
      expect(
        await database.notes((note) => ({ body: note.body }), {
          where: (note) => note.writer.some((person) => person.id.is(3)),
        }),
      ).toEqual([]);
      expect(
        await database.notes
          .update({ body: "by Ann" })
          .where((note) => note.writer.id.is(1)),
      ).toEqual({ affectedRows: 1 });
      expect(await database.notes.count()).toBe(3);
    } finally {
      await close();
    }
  });
};
