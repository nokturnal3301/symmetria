import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bool,
  jsonb,
  createDatabase,
  prepare,
  not,
  rowNumber,
  count,
  sql,
  type SelectedColumn,
} from "../../packages/runtime/src";
import { sqlite } from "../../packages/runtime/src/driver";
import { testDatabase } from "../../packages/kit/src/testing";

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

export const queryJsonSemanticsTests = (
  dialect: "postgres" | "sqlite",
): void => {
  const fixture = async () => {
    const postgresFixture =
      dialect === "postgres"
        ? await testDatabase({
            url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
            schema: model,
          })
        : undefined;
    const local = postgresFixture ? undefined : sqlite();
    local?.createTables(model);
    const driver = postgresFixture?.driver ?? local!;
    const database =
      postgresFixture?.database ?? createDatabase({ schema: model, driver });
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
      sql: `UPDATE records SET document = 'null'${dialect === "postgres" ? "::jsonb" : ""}, copy = 'null'${dialect === "postgres" ? "::jsonb" : ""} WHERE id = 8`,
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
      close: postgresFixture ? postgresFixture.close : () => database.$close(),
    };
  };

  test("wide JSON objects preserve arbitrary keys, nulls, windows and aggregate scope", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.records((records) => ({
        payload: {
          ...wide(records.id),
          'text"key': records.value,
          'null"key': records.note,
          'document"key': records.document,
          'rank"key': rowNumber().over({ orderBy: records.id.ascending }),
        },
        $where: records.id.atMost(2),
        $orderBy: records.id.ascending,
      }));
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
        await database.records((records) => ({
          payload: wide(count()),
          $where: records.id.below(0),
        })),
      ).toEqual([{ payload: Object.fromEntries(keys.map((key) => [key, 0])) }]);
      expect(
        await database.records((records) => ({
          children: records.children((children) => ({
            ...wide(children.id),
            'null"key': children.value,
          })),
          $where: records.id.is(1),
        })),
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
        database.records.as("__symmetria_search")((__symmetria_search) => ({
          id: __symmetria_search.id,
          $where: __symmetria_search.value.search(parameters.term),
          $orderBy: __symmetria_search.id.ascending,
        })),
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
        await database.__symmetria_search((__symmetria_search) => ({
          id: __symmetria_search.id,
          matched: __symmetria_search.matched,
          $orderBy: __symmetria_search.id.ascending,
        })),
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
          database.records((records) => ({
            id: records.id,
            $where: records.documents.has(parameters.member),
            $orderBy: records.id.ascending,
          })),
      );
      const missing = prepare(
        { member: jsonb<unknown>().nullable },
        (parameters) =>
          database.records((records) => ({
            id: records.id,
            $where: not(records.documents.has(parameters.member)),
            $orderBy: records.id.ascending,
          })),
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
        await database.records.as("__symmetria_array")((__symmetria_array) => ({
          id: __symmetria_array.id,
          $where: __symmetria_array.documents.has(__symmetria_array.copy),
          $orderBy: __symmetria_array.id.ascending,
        })),
      ).toEqual([{ id: 1 }, { id: 5 }]);
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: { documents: records.documents },
        }))
        .cte("projected");
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("documents").has(reordered),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("documents").overlaps([reordered]),
        })),
      ).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("JSON equality distinguishes scalar types, SQL NULL and JSON null across preparation and projections", async () => {
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
          await database.records((records) => ({
            id: records.id,
            $where: records.document.is(value),
          })),
        ).toEqual([{ id }]);
      }

      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.isNot(reordered),
          $orderBy: records.id.ascending,
        })),
      ).toEqual([3, 4, 5, 6, 7, 8].map((id) => ({ id })));
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.isDistinctFrom(reordered),
          $orderBy: records.id.ascending,
        })),
      ).toEqual([2, 3, 4, 5, 6, 7, 8].map((id) => ({ id })));
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: not(records.document.isDistinctFrom(reordered)),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.is(records.copy),
          $orderBy: records.id.ascending,
        })),
      ).toEqual([1, 5, 7, 8].map((id) => ({ id })));
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.is(null),
        })),
      ).toEqual([{ id: 2 }]);
      const matching = prepare(
        { value: jsonb<unknown>().nullable },
        (parameters) =>
          database.records((records) => ({
            id: records.id,
            $where: records.document.is(parameters.value),
            $orderBy: records.id.ascending,
          })),
      );
      const missing = prepare(
        { value: jsonb<unknown>().nullable },
        (parameters) =>
          database.records((records) => ({
            id: records.id,
            $where: not(records.document.is(parameters.value)),
            $orderBy: records.id.ascending,
          })),
      );

      for (const value of [reordered, null]) {
        expect(await matching.execute({ value })).toEqual(
          await database.records((records) => ({
            id: records.id,
            $where: records.document.is(value),
            $orderBy: records.id.ascending,
          })),
        );
        expect(await missing.execute({ value })).toEqual(
          await database.records((records) => ({
            id: records.id,
            $where: not(records.document.is(value)),
            $orderBy: records.id.ascending,
          })),
        );
      }

      expect(
        await database.records.as("json_tree")((json_tree) => ({
          id: json_tree.id,
          $where: json_tree.document.is(reordered),
        })),
      ).toEqual([{ id: 1 }]);
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: { document: records.document },
        }))
        .cte("projected");
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("document").is(reordered),
        })),
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
        await projected((projected) => ({
          length: projected.payload.path("documents").length(),
          $orderBy: projected.id.ascending,
        })),
      ).toEqual([1, null, 2, 1, 1, 0, 1, 0].map((length) => ({ length })));
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("documents").has(true),
        })),
      ).toEqual([{ id: 3 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("documents").has(1),
        })),
      ).toEqual([{ id: 4 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("documents").has("1"),
        })),
      ).toEqual([{ id: 5 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload
            .path("documents")
            .overlaps(projected.candidates),
          $orderBy: projected.id.ascending,
        })),
      ).toEqual([1, 3, 4, 5, 7].map((id) => ({ id })));
      const overlap = prepare(
        { candidates: jsonb<unknown[]>().nullable },
        (parameters) =>
          projected((projected) => ({
            id: projected.id,
            $where: projected.payload
              .path("documents")
              .overlaps(parameters.candidates),
            $orderBy: projected.id.ascending,
          })),
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
        await arrays((arrays) => ({
          id: arrays.id,
          $where: arrays.values.overlaps([{ document: reordered }]),
        })),
      ).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("JSON IN and NOT IN preserve structural equality and NULL semantics for lists and subqueries", async () => {
    const { database, close } = await fixture();

    try {
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.in([reordered, true]),
          $orderBy: records.id.ascending,
        })),
      ).toEqual([{ id: 1 }, { id: 3 }]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.notIn([reordered, true]),
          $orderBy: records.id.ascending,
        })),
      ).toEqual([4, 5, 6, 7, 8].map((id) => ({ id })));
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.in([reordered, sql<null>`NULL`]),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.notIn([reordered, sql<null>`NULL`]),
        })),
      ).toEqual([]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.in([]),
        })),
      ).toEqual([]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.notIn([]),
        })),
      ).toHaveLength(8);
      const options = database.records.as("options")((options) => ({
        copy: options.copy,
        $where: options.id.atMost(2),
      }));
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.in(options),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.notIn(options),
        })),
      ).toEqual([]);
      expect(
        await database.records.as("__symmetria_member")(
          (__symmetria_member) => ({
            id: __symmetria_member.id,
            $where: __symmetria_member.document.in(
              database.children((children) => ({
                document: children.document,
                $where: children.recordId.is(__symmetria_member.id),
              })),
            ),
          }),
        ),
      ).toEqual([{ id: 1 }]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.in(
            database.children((children) => ({
              document: children.document,
              $where: children.id.below(0),
            })),
          ),
        })),
      ).toEqual([]);
      expect(
        await database.records((records) => ({
          id: records.id,
          $where: records.document.notIn(
            database.children((children) => ({
              document: children.document,
              $where: children.id.below(0),
            })),
          ),
        })),
      ).toHaveLength(8);
    } finally {
      await close();
    }
  });
};
