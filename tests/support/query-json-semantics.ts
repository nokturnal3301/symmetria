import { expect, test } from "bun:test";
import {
  schema,
  table,
  index,
  int,
  text,
  bool,
  jsonb,
  prepare,
  not,
  rowNumber,
  count,
  sql,
  and,
  or,
  type SelectedColumn,
} from "../../packages/runtime/src";
import { testDatabase } from "./postgres";

const original = { first: 1, last: [2, false] };
const reordered = { last: [2, false], first: 1 };
const model = schema({
  records: {
    id: int,
    value: text,
    note: text.nullable,
    active: bool,
    document: jsonb<unknown>().nullable,
    copy: jsonb<unknown>().nullable,
    documents: jsonb<unknown>().array.nullable,
  },
  children: ({ records }) => ({
    id: int,
    record: records,
    value: text.nullable,
    document: jsonb<unknown>().nullable,
  }),
  __symmetria_search: { id: int, value: text, matched: bool.default(false) },
});
const keys = Array.from(
  { length: 120 },
  (_unused, position) => `field_${position}".\\'🦊`,
);

const wide = (value: SelectedColumn<number>) =>
  Object.fromEntries(keys.map((key) => [key, value]));

export const queryJsonSemanticsTests = (): void => {
  const fixture = async () => {
    const postgresFixture = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: model,
    });
    const { driver, database } = postgresFixture;
    await database.records.insert(
      [
        {
          id: 1,
          value: "alpha beta",
          document: original,
          copy: reordered,
          documents: [original],
        },
        { id: 2, value: "other", document: null, copy: null, documents: null },
        {
          id: 3,
          value: "alpha",
          document: true,
          copy: 1,
          documents: [true, null],
        },
        { id: 4, value: "beta", document: 1, copy: true, documents: [1] },
        { id: 5, value: "other", document: "1", copy: "1", documents: ["1"] },
        {
          id: 6,
          value: "other",
          document: [1, 2],
          copy: [2, 1],
          documents: [],
        },
        {
          id: 7,
          value: "other",
          document: { first: 1 },
          copy: { first: 1 },
          documents: [null],
        },
        {
          id: 8,
          value: "other",
          document: "null",
          copy: "null",
          documents: [],
        },
      ].map((row) => ({ ...row, note: null, active: true })),
    );
    await driver.execute({
      sql: `UPDATE records SET document = 'null'::jsonb, copy = 'null'::jsonb WHERE id = 8`,
      parameters: [],
    });
    await database.children.insert([
      { id: 1, recordId: 1, value: null, document: reordered },
      { id: 2, recordId: 2, value: null, document: null },
    ]);
    await database.__symmetria_search.insert([
      { id: 1, value: "alpha beta" },
      { id: 2, value: "other" },
    ]);

    return {
      database,
      driver,
      close: postgresFixture.close,
    };
  };

  test("wide JSON objects preserve arbitrary keys, nulls, windows and aggregate scope", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.records(
        (records) => ({
          payload: {
            ...wide(records.id),
            'text"key': records.value,
            'null"key': records.note,
            'document"key': records.document,
            'rank"key': rowNumber().over({ orderBy: records.id.ascending }),
          },
        }),
        {
          where: (records) => records.id.atMost(2),
          orderBy: (records) => records.id.ascending,
        },
      );
      const expected = [1, 2].map((id) => ({
        payload: {
          ...Object.fromEntries(keys.map((key) => [key, id])),
          'text"key': id === 1 ? "alpha beta" : "other",
          'null"key': null,
          'document"key': id === 1 ? original : null,
          'rank"key': id,
        },
      }));
      expect(await query).toEqual(expected);
      expect(
        await query.cte("projected")((projected) => ({
          payload: projected.payload,
        })),
      ).toEqual(expected);
      expect(
        await query.as("projected")((projected) => ({
          nested: { payload: projected.payload },
        })),
      ).toEqual(expected.map((row) => ({ nested: row })));
      expect(
        await database.records((records) => ({ payload: wide(count()) })),
      ).toEqual([{ payload: Object.fromEntries(keys.map((key) => [key, 8])) }]);
      expect(
        await database.records(
          (records) => ({
            payload: wide(count()),
          }),
          { where: (records) => records.id.below(0) },
        ),
      ).toEqual([{ payload: Object.fromEntries(keys.map((key) => [key, 0])) }]);
      expect(
        await database.records(
          (records) => ({
            children: records.children((children) => ({
              ...wide(children.id),
              'null"key': children.value,
            })),
          }),
          { where: (records) => records.id.is(1) },
        ),
      ).toEqual([
        {
          children: [
            {
              ...Object.fromEntries(keys.map((key) => [key, 1])),
              'null"key': null,
            },
          ],
        },
      ]);
    } finally {
      await close();
    }
  });

  test("prepared search avoids user aliases and physical mutation table names", async () => {
    const { database, close } = await fixture();

    try {
      const query = prepare({ term: text }, (parameters) =>
        database.records.as("__symmetria_search")(
          (__symmetria_search) => ({
            id: __symmetria_search.id,
          }),
          {
            where: (__symmetria_search) =>
              __symmetria_search.value.search(parameters.term),
            orderBy: (__symmetria_search) => __symmetria_search.id.ascending,
          },
        ),
      );
      expect(await query.execute({ term: "alpha beta" })).toEqual([{ id: 1 }]);
      expect(await query.execute({ term: "beta" })).toEqual([
        { id: 1 },
        { id: 4 },
      ]);
      expect(await query.execute({ term: "missing" })).toEqual([]);
      expect(await query.execute({ term: "" })).toEqual([]);
      const update = prepare({ term: text }, (parameters) =>
        database.__symmetria_search
          .update({ matched: true })
          .where((__symmetria_search) =>
            __symmetria_search.value.search(parameters.term),
          )
          .returning((__symmetria_search) => [__symmetria_search.id]),
      );
      expect(await update.execute({ term: "alpha beta" })).toEqual([{ id: 1 }]);
      expect(
        await database.__symmetria_search(
          (__symmetria_search) => ({
            id: __symmetria_search.id,
            matched: __symmetria_search.matched,
          }),
          { orderBy: (__symmetria_search) => __symmetria_search.id.ascending },
        ),
      ).toEqual([
        { id: 1, matched: true },
        { id: 2, matched: false },
      ]);
    } finally {
      await close();
    }
  });

  test("native JSONB-array membership uses structural equality and preserves SQL unknown", async () => {
    const { database, close } = await fixture();

    try {
      const matching = prepare(
        { member: jsonb<unknown>().nullable },
        (parameters) =>
          database.records(
            (records) => ({
              id: records.id,
            }),
            {
              where: (records) => records.documents.has(parameters.member),
              orderBy: (records) => records.id.ascending,
            },
          ),
      );
      const missing = prepare(
        { member: jsonb<unknown>().nullable },
        (parameters) =>
          database.records(
            (records) => ({
              id: records.id,
            }),
            {
              where: (records) => not(records.documents.has(parameters.member)),
              orderBy: (records) => records.id.ascending,
            },
          ),
      );
      expect(await matching.execute({ member: reordered })).toEqual([
        { id: 1 },
      ]);
      expect(await missing.execute({ member: reordered })).toEqual([
        { id: 4 },
        { id: 5 },
        { id: 6 },
        { id: 8 },
      ]);
      expect(await matching.execute({ member: true })).toEqual([{ id: 3 }]);
      expect(await matching.execute({ member: 1 })).toEqual([{ id: 4 }]);
      expect(await matching.execute({ member: "1" })).toEqual([{ id: 5 }]);
      expect(await matching.execute({ member: null })).toEqual([]);
      expect(await missing.execute({ member: null })).toEqual([
        { id: 6 },
        { id: 8 },
      ]);
      expect(
        await database.records.as("__symmetria_array")(
          (__symmetria_array) => ({
            id: __symmetria_array.id,
          }),
          {
            where: (__symmetria_array) =>
              __symmetria_array.documents.has(__symmetria_array.copy),
            orderBy: (__symmetria_array) => __symmetria_array.id.ascending,
          },
        ),
      ).toEqual([{ id: 1 }, { id: 5 }]);
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: { documents: records.documents },
        }))
        .cte("projected");
      expect(
        await projected(
          (projected) => ({
            id: projected.id,
          }),
          {
            where: (projected) =>
              projected.payload.path("documents").has(reordered),
          },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await projected(
          (projected) => ({
            id: projected.id,
          }),
          {
            where: (projected) =>
              projected.payload.path("documents").overlaps([reordered]),
          },
        ),
      ).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("JSON equality distinguishes scalar types, and is(null) counts SQL NULL and JSON null, across preparation and projections", async () => {
    const { database, close } = await fixture();

    try {
      for (const [value, id] of [
        [reordered, 1],
        [true, 3],
        [1, 4],
        ["1", 5],
        [[1, 2], 6],
        [{ first: 1 }, 7],
      ] as const) {
        expect(
          await database.records(
            (records) => ({
              id: records.id,
            }),
            { where: (records) => records.document.is(value) },
          ),
        ).toEqual([{ id }]);
      }

      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) => records.document.isNot(reordered),
            orderBy: (records) => records.id.ascending,
          },
        ),
        // Row 8's JSON null is null, as for is(null): no value to compare.
      ).toEqual([3, 4, 5, 6, 7].map((id) => ({ id })));
      // not() leaves out what the negated operator leaves out.
      expect(
        await database.records((records) => ({ id: records.id }), {
          where: (records) => not(records.document.is(reordered)),
          orderBy: (records) => records.id.ascending,
        }),
      ).toEqual([3, 4, 5, 6, 7].map((id) => ({ id })));
      expect(
        await database.records((records) => ({ id: records.id }), {
          where: (records) =>
            not(records.document.in([reordered, true]).or(records.id.is(9))),
          orderBy: (records) => records.id.ascending,
        }),
      ).toEqual([4, 5, 6, 7].map((id) => ({ id })));
      expect(
        await database.records((records) => ({ id: records.id }), {
          where: (records) => not(records.document.contains(reordered)),
          orderBy: (records) => records.id.ascending,
        }),
      ).toEqual([3, 4, 5, 6, 7].map((id) => ({ id })));
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) => records.document.isDistinctFrom(reordered),
            orderBy: (records) => records.id.ascending,
          },
        ),
      ).toEqual([2, 3, 4, 5, 6, 7, 8].map((id) => ({ id })));
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) => not(records.document.isDistinctFrom(reordered)),
          },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) => records.document.is(records.copy),
            orderBy: (records) => records.id.ascending,
          },
        ),
      ).toEqual([1, 5, 7, 8].map((id) => ({ id })));
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) => records.document.is(null),
            orderBy: (records) => records.id.ascending,
          },
        ),
        // SQL NULL and the JSON null of row 8 both read back as null.
      ).toEqual([{ id: 2 }, { id: 8 }]);
      const matching = prepare(
        { value: jsonb<unknown>().nullable },
        (parameters) =>
          database.records(
            (records) => ({
              id: records.id,
            }),
            {
              where: (records) => records.document.is(parameters.value),
              orderBy: (records) => records.id.ascending,
            },
          ),
      );
      const missing = prepare(
        { value: jsonb<unknown>().nullable },
        (parameters) =>
          database.records(
            (records) => ({
              id: records.id,
            }),
            {
              where: (records) => not(records.document.is(parameters.value)),
              orderBy: (records) => records.id.ascending,
            },
          ),
      );

      for (const value of [reordered, null]) {
        expect(await matching.execute({ value })).toEqual(
          await database.records(
            (records) => ({
              id: records.id,
            }),
            {
              where: (records) => records.document.is(value),
              orderBy: (records) => records.id.ascending,
            },
          ),
        );
        expect(await missing.execute({ value })).toEqual(
          await database.records(
            (records) => ({
              id: records.id,
            }),
            {
              where: (records) => not(records.document.is(value)),
              orderBy: (records) => records.id.ascending,
            },
          ),
        );
      }

      expect(
        await database.records.as("json_tree")(
          (json_tree) => ({
            id: json_tree.id,
          }),
          { where: (json_tree) => json_tree.document.is(reordered) },
        ),
      ).toEqual([{ id: 1 }]);
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: { document: records.document },
        }))
        .cte("projected");
      expect(
        await projected(
          (projected) => ({
            id: projected.id,
          }),
          {
            where: (projected) =>
              projected.payload.path("document").is(reordered),
          },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records
          .update({ note: "matched" })
          .where((records) => records.document.is(reordered))
          .returning((records) => [records.id]),
      ).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("nullable array projections retain JSON-element encoding for membership, overlap and length", async () => {
    const { database, close } = await fixture();

    try {
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: { documents: records.documents },
          candidates: records.documents,
        }))
        .cte("projected");
      expect(
        await projected(
          (projected) => ({
            length: projected.payload.path("documents").length(),
          }),
          { orderBy: (projected) => projected.id.ascending },
        ),
      ).toEqual([1, null, 2, 1, 1, 0, 1, 0].map((length) => ({ length })));
      expect(
        await projected(
          (projected) => ({
            id: projected.id,
          }),
          {
            where: (projected) => projected.payload.path("documents").has(true),
          },
        ),
      ).toEqual([{ id: 3 }]);
      expect(
        await projected(
          (projected) => ({
            id: projected.id,
          }),
          { where: (projected) => projected.payload.path("documents").has(1) },
        ),
      ).toEqual([{ id: 4 }]);
      expect(
        await projected(
          (projected) => ({
            id: projected.id,
          }),
          {
            where: (projected) => projected.payload.path("documents").has("1"),
          },
        ),
      ).toEqual([{ id: 5 }]);
      expect(
        await projected(
          (projected) => ({
            id: projected.id,
          }),
          {
            where: (projected) =>
              projected.payload
                .path("documents")
                .overlaps(projected.candidates),
            orderBy: (projected) => projected.id.ascending,
          },
        ),
      ).toEqual([1, 3, 4, 5, 7].map((id) => ({ id })));
      const overlap = prepare(
        { candidates: jsonb<unknown[]>().nullable },
        (parameters) =>
          projected(
            (projected) => ({
              id: projected.id,
            }),
            {
              where: (projected) =>
                projected.payload
                  .path("documents")
                  .overlaps(parameters.candidates),
              orderBy: (projected) => projected.id.ascending,
            },
          ),
      );
      expect(await overlap.execute({ candidates: [reordered] })).toEqual([
        { id: 1 },
      ]);
      expect(await overlap.execute({ candidates: [true] })).toEqual([
        { id: 3 },
      ]);
      expect(await overlap.execute({ candidates: null })).toEqual([]);
      const arrays = database
        .records((records) => ({
          id: records.id,
          values: records.children((children) => ({
            document: children.document,
          })),
        }))
        .cte("arrays");
      expect(
        await arrays(
          (arrays) => ({
            id: arrays.id,
          }),
          {
            where: (arrays) =>
              arrays.values.overlaps([{ document: reordered }]),
          },
        ),
      ).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("JSON IN and NOT IN preserve structural equality and NULL semantics for lists and subqueries", async () => {
    const { database, close } = await fixture();

    try {
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) => records.document.in([reordered, true]),
            orderBy: (records) => records.id.ascending,
          },
        ),
      ).toEqual([{ id: 1 }, { id: 3 }]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) => records.document.notIn([reordered, true]),
            orderBy: (records) => records.id.ascending,
          },
        ),
        // Row 8's JSON null is null, as for is(null).
      ).toEqual([4, 5, 6, 7].map((id) => ({ id })));
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) =>
              records.document.in([reordered, sql<null>`NULL`]),
          },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) =>
              records.document.notIn([reordered, sql<null>`NULL`]),
          },
        ),
      ).toEqual([]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          { where: (records) => records.document.in([]) },
        ),
      ).toEqual([]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          { where: (records) => records.document.notIn([]) },
        ),
      ).toHaveLength(8);
      const options = database.records.as("options")(
        (options) => ({
          copy: options.copy,
        }),
        { where: (options) => options.id.atMost(2) },
      );
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          { where: (records) => records.document.in(options) },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          { where: (records) => records.document.notIn(options) },
        ),
      ).toEqual([]);
      expect(
        await database.records.as("__symmetria_member")(
          (__symmetria_member) => ({
            id: __symmetria_member.id,
          }),
          {
            where: (__symmetria_member) =>
              __symmetria_member.document.in(
                database.children(
                  (children) => ({
                    document: children.document,
                  }),
                  {
                    where: (children) =>
                      children.recordId.is(__symmetria_member.id),
                  },
                ),
              ),
          },
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) =>
              records.document.in(
                database.children(
                  (children) => ({
                    document: children.document,
                  }),
                  { where: (children) => children.id.below(0) },
                ),
              ),
          },
        ),
      ).toEqual([]);
      expect(
        await database.records(
          (records) => ({
            id: records.id,
          }),
          {
            where: (records) =>
              records.document.notIn(
                database.children(
                  (children) => ({
                    document: children.document,
                  }),
                  { where: (children) => children.id.below(0) },
                ),
              ),
          },
        ),
      ).toHaveLength(8);
    } finally {
      await close();
    }
  });

  test("JSON null is null in a NOT NULL jsonb column too, and between() from an empty array leaves it out", async () => {
    const local = schema({
      notes: {
        id: int,
        body: jsonb<unknown>(),
        list: jsonb<unknown>().nullable,
        extra: jsonb<{ a?: unknown }>().nullable,
      },
    });
    const { database, driver, close } = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: local,
    });

    try {
      // JS null is JSON null in the NOT NULL column and SQL NULL in the others.
      await database.notes.insert({
        id: 1,
        body: null,
        list: null,
        extra: null,
      });
      await driver.execute({
        sql: `INSERT INTO notes (id, body, list, extra) VALUES
          (2, '0', '[1]', '[1]'),
          (3, '[]', '{"a":null}', '{"a":null}'),
          (4, '{"a":[1]}', '{"a":[1]}', '{"a":[1]}'),
          (5, '1', 'null', 'null')`,
        parameters: [],
      });
      type Options = Parameters<typeof database.notes>[1];
      const ids = async (options: Options) =>
        (await database.notes((note) => ({ id: note.id }), options))
          .map((row) => row.id)
          .sort((first, second) => first - second);

      expect(await ids({ where: (note) => note.body.is(null) })).toEqual([1]);
      // is(null) and isDistinctFrom(null) are complements, as on a nullable column.
      expect(
        await ids({ where: (note) => note.body.isDistinctFrom(null) }),
      ).toEqual([2, 3, 4, 5]);
      expect(
        await ids({ where: (note) => not(note.body.isDistinctFrom(null)) }),
      ).toEqual([1]);
      // JSON null has no value to compare: left out, as SQL NULL is.
      const leftOut: Options[] = [
        { where: (note) => note.body.isNot(0) },
        { where: (note) => note.body.notIn([0]) },
        { where: (note) => not(note.body.is(0)) },
        { where: (note) => not(note.body.in([0, "x"])) },
        { where: (note) => not(or(note.body.is(0), note.id.is(9))) },
      ];

      for (const options of leftOut) {
        expect(await ids(options)).toEqual([3, 4, 5]);
      }
      // jsonb sorts [] below null and null below numbers.
      expect(await ids({ where: (note) => note.body.below(1) })).toEqual([
        2, 3,
      ]);
      expect(await ids({ where: (note) => note.body.atLeast([]) })).toEqual([
        2, 3, 4, 5,
      ]);
      expect(
        await ids({ where: (note) => note.body.between([], [1]) }),
      ).toEqual([2, 3, 5]);
      expect(
        await ids({ where: (note) => note.list.between([], [9]) }),
      ).toEqual([2]);
      expect(
        await ids({ where: (note) => note.extra.path("a").between([], [9]) }),
      ).toEqual([4]);
      expect(
        await ids({ where: (note) => not(note.list.between([], [9])) }),
      ).toEqual([3, 4]);

      const isNot = prepare({ value: jsonb<unknown>().nullable }, (p) =>
        database.notes((note) => ({ id: note.id }), {
          where: (note) => note.body.isNot(p.value),
          orderBy: (note) => note.id.asc,
        }),
      );
      expect((await isNot.execute({ value: 0 })).map((row) => row.id)).toEqual([
        3, 4, 5,
      ]);
      expect(
        (await isNot.execute({ value: null })).map((row) => row.id),
      ).toEqual([2, 3, 4, 5]);
      const between = prepare(
        { low: jsonb<unknown>(), high: jsonb<unknown>() },
        (p) =>
          database.notes((note) => ({ id: note.id }), {
            where: (note) => note.extra.path("a").between(p.low, p.high),
          }),
      );
      expect(
        (await between.execute({ low: [], high: [9] })).map((row) => row.id),
      ).toEqual([4]);

      // Writes agree with the reads; isDistinctFrom(null) is not every row.
      await database
        .$transaction(async (tx) => {
          expect(
            (
              await tx.notes
                .delete()
                .where((note) => note.body.isNot(0))
                .returning((note) => [note.id])
            ).map((row) => row.id),
          ).toEqual([3, 4, 5]);
          expect(
            (
              await tx.notes
                .update({ extra: { a: 2 } })
                .where((note) => note.body.isDistinctFrom(null))
                .returning((note) => [note.id])
            ).map((row) => row.id),
          ).toEqual([2]);
          throw new Error("rollback");
        })
        .catch((error: Error) => {
          if (error.message !== "rollback") {
            throw error;
          }
        });
    } finally {
      await close();
    }
  });

  test("a NOT NULL jsonb column is compared bare, so its index and a partial index declared with the condition serve the query, and JSON null stays out", async () => {
    const local = schema({
      docs: table({
        id: int,
        meta: jsonb<unknown>(),
        info: jsonb<{ k?: unknown }>(),
      }).indexes((doc) => ({
        byMeta: index(doc.meta),
        byKey: index(doc.info.path("k")),
        recent: index(doc.id).where(doc.meta.above(19990)),
        negative: index(doc.id).where(doc.meta.below(-95)),
      })),
    });
    const { database, driver, close } = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: local,
    });
    const rows = async (sql: string, parameters: unknown[] = []) => {
      const result = await driver.execute({ sql, parameters });

      return (Array.isArray(result) ? result : result.rows) as Record<
        string,
        unknown
      >[];
    };

    try {
      await rows(
        `INSERT INTO docs SELECT g, value, value FROM (SELECT g, CASE WHEN g % 97 = 0 THEN 'null'::jsonb WHEN g % 89 = 0 THEN '[]'::jsonb WHEN g % 5 = 0 THEN jsonb_build_object('k', CASE WHEN g % 3 = 0 THEN 'null'::jsonb ELSE to_jsonb(g) END) ELSE to_jsonb(g - 100) END AS value FROM generate_series(1, 20000) g) source`,
      );
      await rows("ANALYZE docs");
      type Options = Parameters<typeof database.docs>[1];
      const ids = async (options: Options) =>
        (await database.docs((doc) => ({ id: doc.id }), options))
          .map((row) => row.id)
          .sort((first, second) => first - second);
      const hand = async (condition: string) =>
        (await rows(`SELECT id FROM docs WHERE ${condition} ORDER BY id`)).map(
          (row) => row.id as number,
        );
      const plan = async (options: Options) => {
        const { sql, parameters } = database
          .docs((doc) => ({ id: doc.id }), options)
          .toSQL();

        return (await rows(`EXPLAIN ${sql}`, parameters))
          .map((row) => row["QUERY PLAN"])
          .join("\n");
      };
      const meta = "NULLIF(meta, 'null'::jsonb)";
      const key = "NULLIF(info #> '{k}', 'null'::jsonb)";

      // The same rows as JSON null read as SQL NULL, under not() too.
      for (const [options, condition] of [
        [{ where: (doc) => doc.meta.above(19990) }, `${meta} > '19990'`],
        [{ where: (doc) => doc.meta.atLeast(19990) }, `${meta} >= '19990'`],
        [{ where: (doc) => doc.meta.below(-95) }, `${meta} < '-95'`],
        [{ where: (doc) => doc.meta.atMost(-95) }, `${meta} <= '-95'`],
        [{ where: (doc) => doc.meta.above([]) }, `${meta} > '[]'`],
        [{ where: (doc) => doc.meta.below([]) }, `${meta} < '[]'`],
        [{ where: (doc) => doc.meta.isNot(5) }, `${meta} <> '5'`],
        [
          { where: (doc) => doc.meta.isDistinctFrom(5) },
          `${meta} IS DISTINCT FROM '5'`,
        ],
        [
          { where: (doc) => not(doc.meta.above(19990)) },
          `NOT (${meta} > '19990')`,
        ],
        [{ where: (doc) => not(doc.meta.below(-95)) }, `NOT (${meta} < '-95')`],
        [{ where: (doc) => not(doc.meta.isNot(5)) }, `NOT (${meta} <> '5')`],
        [
          { where: (doc) => doc.info.path("k").between([], 50) },
          `${key} BETWEEN '[]' AND '50'`,
        ],
        [
          { where: (doc) => not(doc.info.path("k").between([], 50)) },
          `NOT (${key} BETWEEN '[]' AND '50')`,
        ],
        // Inside sql``, below a NOT the library does not write, as well.
        [
          { where: (doc) => not(sql<boolean>`${doc.meta.below(-95)}`) },
          `NOT (${meta} < '-95')`,
        ],
        [
          { where: (doc) => sql<boolean>`NOT ${doc.meta.above(19990)}` },
          `NOT (${meta} > '19990')`,
        ],
        [
          { where: (doc) => sql<boolean>`NOT ${doc.meta.atLeast([])}` },
          `NOT (${meta} >= '[]')`,
        ],
        [
          { where: (doc) => sql<boolean>`NOT ${doc.meta.above(doc.info)}` },
          `NOT (${meta} > NULLIF(info, 'null'::jsonb))`,
        ],
        // Two JSON nulls are not distinct.
        [
          { where: (doc) => doc.meta.isDistinctFrom(doc.info) },
          `${meta} IS DISTINCT FROM NULLIF(info, 'null'::jsonb)`,
        ],
      ] as [Options, string][]) {
        expect(await ids(options)).toEqual(await hand(condition));
      }

      // A selected comparison reads NULL for JSON null.
      const selected = await database.docs(
        (doc) => ({ id: doc.id, low: sql<boolean>`${doc.meta.below(-95)}` }),
        { where: (doc) => doc.id.below(200), orderBy: (doc) => doc.id.asc },
      );
      expect(selected).toEqual(
        (
          await rows(
            `SELECT id, ${meta} < '-95' AS low FROM docs WHERE id < 200 ORDER BY id`,
          )
        ).map((row) => ({ id: row.id as number, low: row.low as boolean })),
      );

      // A parameter bound to JSON null is isDistinctFrom(null).
      const distinct = prepare({ value: jsonb<unknown>() }, (p) =>
        database.docs((doc) => ({ id: doc.id }), {
          where: (doc) => doc.meta.isDistinctFrom(p.value),
          orderBy: (doc) => doc.id.asc,
        }),
      );
      expect((await distinct({ value: null })).map((row) => row.id)).toEqual(
        await ids({ where: (doc) => doc.meta.isDistinctFrom(null) }),
      );

      const above = prepare({ value: jsonb<unknown>() }, (p) =>
        database.docs((doc) => ({ id: doc.id }), {
          where: (doc) => doc.meta.above(p.value),
          orderBy: (doc) => doc.id.asc,
        }),
      );
      const between = prepare(
        { low: jsonb<unknown>(), high: jsonb<unknown>() },
        (p) =>
          database.docs((doc) => ({ id: doc.id }), {
            where: (doc) => doc.info.path("k").between(p.low, p.high),
            orderBy: (doc) => doc.id.asc,
          }),
      );

      for (const value of [19990, []]) {
        expect((await above({ value })).map((row) => row.id)).toEqual(
          await hand(`${meta} > '${JSON.stringify(value)}'`),
        );
      }
      for (const low of [10, []]) {
        expect((await between({ low, high: 50 })).map((row) => row.id)).toEqual(
          await hand(`${key} BETWEEN '${JSON.stringify(low)}' AND '50'`),
        );
      }

      // The partial indexes declared with the same conditions serve them.
      expect(await plan({ where: (doc) => doc.meta.above(19990) })).toContain(
        "docs_recent_idx",
      );
      expect(await plan({ where: (doc) => doc.meta.below(-95) })).toContain(
        "docs_negative_idx",
      );
      const compiled = above.toSQL({ value: 19990 });
      expect(
        (await rows(`EXPLAIN ${compiled.sql}`, compiled.parameters))
          .map((row) => row["QUERY PLAN"])
          .join("\n"),
      ).not.toContain("Seq Scan");
    } finally {
      await close();
    }
  });

  test("is(), in(), between() and contains() of a jsonb column or path read JSON null as null wherever they stand, and the indexes still serve them", async () => {
    const local = schema({
      docs: table({
        id: int,
        meta: jsonb<unknown>(),
        data: jsonb<unknown>().nullable,
        info: jsonb<{ k?: unknown; b?: unknown }>(),
      }).indexes((doc) => ({
        byMeta: index(doc.meta),
        byInfo: index(doc.info).using("gin"),
        three: index(doc.id).where(doc.meta.is(3)),
        holds: index(doc.id).where(doc.info.contains({ k: 1 })),
      })),
    });
    const { database, driver, close } = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: local,
    });
    const rows = async (sql: string, parameters: unknown[] = []) => {
      const result = await driver.execute({ sql, parameters });

      return (Array.isArray(result) ? result : result.rows) as Record<
        string,
        unknown
      >[];
    };

    try {
      await rows(
        `INSERT INTO docs SELECT g, CASE WHEN g % 97 = 0 THEN 'null'::jsonb ELSE to_jsonb(g % 1000) END, CASE WHEN g % 89 = 0 THEN NULL WHEN g % 83 = 0 THEN 'null'::jsonb ELSE to_jsonb(g % 1000) END, CASE WHEN g % 101 = 0 THEN 'null'::jsonb WHEN g % 7 = 0 THEN '{"k":null}'::jsonb ELSE jsonb_build_object('k', g % 2000, 'b', g) END FROM generate_series(1, 20000) g`,
      );
      await rows("ANALYZE docs");
      type Options = Parameters<typeof database.docs>[1];
      // The columns of a written row, which a read row's columns also are.
      type Doc = Pick<
        Parameters<
          Extract<
            Parameters<ReturnType<typeof database.docs.update>["where"]>[0],
            (...args: never[]) => unknown
          >
        >[0],
        "meta" | "data" | "info"
      >;
      const ids = async (options: Options) =>
        (await database.docs((doc) => ({ id: doc.id }), options))
          .map((row) => row.id)
          .sort((first, second) => first - second);
      const hand = async (condition: string) =>
        (await rows(`SELECT id FROM docs WHERE ${condition} ORDER BY id`)).map(
          (row) => row.id as number,
        );
      const meta = "NULLIF(meta, 'null'::jsonb)";
      const data = "NULLIF(data, 'null'::jsonb)";
      const info = "NULLIF(info, 'null'::jsonb)";
      const key = "NULLIF(info #> '{k}', 'null'::jsonb)";
      const many = Array.from({ length: 1001 }, (_unused, value) => value);

      // The reference reads JSON null as SQL NULL, as is(null) counts it.
      for (const [condition, reference] of [
        [(doc) => doc.meta.is(3), `${meta} = '3'`],
        [(doc) => doc.meta.in([3, 7]), `${meta} IN ('3', '7')`],
        [
          (doc) => doc.meta.in(many),
          `${meta} = ANY('{${many.join(",")}}'::jsonb[])`,
        ],
        [(doc) => doc.meta.between(1, 5), `${meta} BETWEEN '1' AND '5'`],
        [(doc) => doc.info.contains({ k: 1 }), `${info} @> '{"k":1}'`],
        [(doc) => doc.data.is(3), `${data} = '3'`],
        [(doc) => doc.data.in([3, 7]), `${data} IN ('3', '7')`],
        [(doc) => doc.info.path("k").is(1), `${key} = '1'`],
        [(doc) => doc.info.path("k").in([1, 2]), `${key} IN ('1', '2')`],
        [
          (doc) => doc.info.path("k").between(1, 5),
          `${key} BETWEEN '1' AND '5'`,
        ],
      ] as [(doc: Doc) => ReturnType<typeof not>, string][]) {
        expect(await ids({ where: condition })).toEqual(await hand(reference));
        expect(await ids({ where: (doc) => not(condition(doc)) })).toEqual(
          await hand(`NOT (${reference})`),
        );
        // Inside sql``, below a NOT the library does not write, too.
        expect(
          await ids({ where: (doc) => sql<boolean>`NOT ${condition(doc)}` }),
        ).toEqual(await hand(`NOT (${reference})`));
        // A selected condition reads NULL for JSON null.
        expect(
          await database.docs(
            (doc) => ({
              id: doc.id,
              value: sql<boolean | null>`${condition(doc)}`,
            }),
            { where: (doc) => doc.id.below(400), orderBy: (doc) => doc.id.asc },
          ),
        ).toEqual(
          (
            await rows(
              `SELECT id, ${reference} AS value FROM docs WHERE id < 400 ORDER BY id`,
            )
          ).map((row) => ({
            id: row.id as number,
            value: row.value as boolean | null,
          })),
        );
        // A write filtered by the condition or its negation in sql`` writes
        // what it selects, not every row.
        await database
          .$transaction(async (tx) => {
            expect(
              (
                await tx.docs
                  .update({ data: 1 })
                  .where((doc) =>
                    or(condition(doc), not(sql<boolean>`${condition(doc)}`)),
                  )
                  .returning((doc) => [doc.id])
              )
                .map((row) => row.id)
                .sort((first, second) => first - second),
            ).toEqual(await hand(`(${reference}) OR NOT (${reference})`));
            throw new Error("rollback");
          })
          .catch((error: Error) => {
            if (error.message !== "rollback") {
              throw error;
            }
          });
      }

      // A prepared parameter bound to JSON null still matches JSON null.
      const equal = prepare({ value: jsonb<unknown>() }, (p) =>
        database.docs((doc) => ({ id: doc.id }), {
          where: (doc) => doc.meta.is(p.value),
          orderBy: (doc) => doc.id.asc,
        }),
      );
      expect((await equal({ value: null })).map((row) => row.id)).toEqual(
        await hand(`meta = 'null'::jsonb`),
      );
      expect((await equal({ value: 3 })).map((row) => row.id)).toEqual(
        await hand(`meta = '3'`),
      );

      // A filter drops the constant-NULL part, so the btree and GIN indexes
      // and the partial indexes declared with the same conditions serve them.
      const plan = async ({ sql, parameters }: CompiledShape) =>
        (await rows(`EXPLAIN ${sql}`, parameters))
          .map((row) => row["QUERY PLAN"])
          .join("\n");
      const query = (where: (doc: Doc) => ReturnType<typeof not>) =>
        database.docs((doc) => ({ id: doc.id }), { where }).toSQL();
      type CompiledShape = { sql: string; parameters: unknown[] };

      expect(await plan(query((doc) => doc.meta.is(500)))).toContain(
        "docs_by_meta_idx",
      );
      expect(await plan(query((doc) => doc.meta.in([500, 501])))).toContain(
        "docs_by_meta_idx",
      );
      expect(await plan(query((doc) => doc.meta.between(500, 502)))).toContain(
        "docs_by_meta_idx",
      );
      expect(await plan(query((doc) => doc.meta.is(3)))).toContain(
        "docs_three_idx",
      );
      expect(await plan(query((doc) => doc.info.contains({ k: 1 })))).toContain(
        "docs_holds_idx",
      );
      expect(await plan(query((doc) => doc.info.contains({ b: 5 })))).toContain(
        "docs_by_info_idx",
      );
      expect(await plan(equal.toSQL({ value: 500 }))).toContain(
        "docs_by_meta_idx",
      );
    } finally {
      await close();
    }
  });

  test("NaN and Infinity inside a JSON value are refused, never written or compared as JSON null", async () => {
    const local = schema({
      notes: {
        id: int,
        body: jsonb<unknown>().nullable,
        doc: jsonb<{ a?: number }>().nullable,
        list: jsonb<unknown>().array.nullable,
      },
    });
    const { database, driver, close } = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: local,
    });
    const refused = /json or jsonb value cannot hold NaN or Infinity/;

    try {
      await database.notes.insert({ id: 1, body: { a: 1 } });
      await driver.execute({
        sql: `INSERT INTO notes (id, body) VALUES (2, 'null'), (3, NULL)`,
        parameters: [],
      });

      for (const bad of [Number.NaN, Infinity, -Infinity]) {
        // Before, NaN bound JSON null: is() found the JSON-null row.
        await expect(
          database
            .notes((note) => ({ id: note.id }), {
              where: (note) => note.body.is(bad),
            })
            .execute(),
        ).rejects.toThrow(refused);
        await expect(
          database
            .notes((note) => ({ id: note.id }), {
              where: (note) => note.doc.path("a").in([1, bad]),
            })
            .execute(),
        ).rejects.toThrow(refused);
        await expect(
          database.notes
            .insert({ id: 4, body: { a: [1, { b: bad }] } })
            .execute(),
        ).rejects.toThrow('(at "b")');
        await expect(
          database.notes.insert({ id: 4, list: [{ a: bad }] }).execute(),
        ).rejects.toThrow(refused);
        await expect(
          database.notes
            .update({ body: [bad] })
            .where((note) => note.id.is(1))
            .execute(),
        ).rejects.toThrow(refused);
        const prepared = prepare({ value: jsonb<unknown>() }, (p) =>
          database.notes((note) => ({ id: note.id }), {
            where: (note) => note.body.contains(p.value),
          }),
        );
        await expect(prepared.execute({ value: { a: bad } })).rejects.toThrow(
          refused,
        );
      }

      expect(
        await database.notes((note) => ({ id: note.id, body: note.body }), {
          orderBy: (note) => note.id.asc,
        }),
      ).toEqual([
        { id: 1, body: { a: 1 } },
        { id: 2, body: null },
        { id: 3, body: null },
      ]);
      // Nulls, and strings that spell them, are still values.
      await database.notes.insert({
        id: 5,
        body: { a: null, b: "NaN", c: "null", d: new Date(0) },
      });
      expect(
        await database.notes((note) => ({ id: note.id }), {
          where: (note) => note.body.contains({ a: null, b: "NaN" }),
        }),
      ).toEqual([{ id: 5 }]);
    } finally {
      await close();
    }
  });

  test("JSON has() and overlaps() are NULL for a document that is SQL NULL or JSON null, as for a native array", async () => {
    const local = schema({
      notes: {
        id: int,
        doc: jsonb<number[]>().nullable,
        meta: jsonb<{ list?: number[] }>(),
      },
    });
    const { database, driver, close } = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: local,
    });

    try {
      await driver.execute({
        sql: `INSERT INTO notes (id, doc, meta) VALUES
          (1, '[1, 2]', '{"list": [1, 2]}'),
          (2, '[3]', '{"list": [3]}'),
          (3, '[]', '{"list": []}'),
          (4, 'null', '{"list": null}'),
          (5, NULL, '{}')`,
        parameters: [],
      });
      type Options = Parameters<typeof database.notes>[1];
      const ids = async (options: Options) =>
        (await database.notes((note) => ({ id: note.id }), options))
          .map((row) => row.id)
          .sort((first, second) => first - second);

      expect(await ids({ where: (note) => note.doc.has(1) })).toEqual([1]);
      expect(
        await ids({ where: (note) => note.meta.path("list").has(1) }),
      ).toEqual([1]);
      expect(await ids({ where: (note) => note.doc.overlaps([1, 3]) })).toEqual(
        [1, 2],
      );
      // Before, not() of them held for the documents that are NULL.
      for (const options of [
        { where: (note) => not(note.doc.has(1)) },
        { where: (note) => not(note.meta.path("list").has(1)) },
        { where: (note) => not(note.doc.overlaps([1])) },
        { where: (note) => not(note.meta.path("list").overlaps([1])) },
      ] satisfies Options[]) {
        expect(await ids(options)).toEqual([2, 3]);
      }

      // A write filters the same rows; prepared, the same again.
      await database
        .$transaction(async (tx) => {
          expect(
            (
              await tx.notes
                .delete()
                .where((note) => not(note.doc.has(1)))
                .returning((note) => [note.id])
            ).map((row) => row.id),
          ).toEqual([2, 3]);
          throw new Error("rollback");
        })
        .catch((error: Error) => {
          if (error.message !== "rollback") {
            throw error;
          }
        });
      const prepared = prepare({ value: int }, (p) =>
        database.notes((note) => ({ id: note.id }), {
          where: (note) => not(note.doc.has(p.value)),
          orderBy: (note) => note.id.asc,
        }),
      );
      expect(
        (await prepared.execute({ value: 3 })).map((row) => row.id),
      ).toEqual([1, 3]);
    } finally {
      await close();
    }
  });

  test("JSON has(), overlaps() and length() of an object or a scalar are unknown, so a condition beside them still decides the row", async () => {
    const local = schema({
      items: {
        id: int,
        tags: jsonb<string[]>().nullable,
        labels: jsonb<string[]>(),
      },
    });
    const { database, driver, close } = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: local,
    });

    try {
      await driver.execute({
        sql: `INSERT INTO items (id, tags, labels) VALUES
          (1, NULL, '"solo"'), (2, '["x"]', '["y"]'), (3, NULL, '{"a": 1}')`,
        parameters: [],
      });
      type Options = Parameters<typeof database.items>[1];
      const ids = async (options: Options) =>
        (await database.items((item) => ({ id: item.id }), options))
          .map((row) => row.id)
          .sort((first, second) => first - second);

      // PostgreSQL may evaluate either side first; neither side fails.
      for (const options of [
        {
          where: (item) =>
            or(and(item.tags.has("x"), item.labels.has("y")), item.id.is(0)),
        },
        {
          where: (item) =>
            or(
              and(item.tags.has("x"), item.labels.length().above(0)),
              item.id.is(0),
            ),
        },
        { where: (item) => or(item.labels.overlaps(["y"]), item.id.is(2)) },
        { where: (item) => item.labels.has("y") },
      ] satisfies Options[]) {
        expect(await ids(options)).toEqual([2]);
      }
      expect(await ids({ where: (item) => not(item.labels.has("y")) })).toEqual(
        [],
      );
      // The stored values contradict the declared array type: no length.
      const sizes: unknown = await database.items(
        (item) => ({ id: item.id, size: item.labels.length() }),
        { orderBy: (item) => item.id.asc },
      );
      expect(sizes).toEqual([
        { id: 1, size: null },
        { id: 2, size: 1 },
        { id: 3, size: null },
      ]);
    } finally {
      await close();
    }
  });
};
