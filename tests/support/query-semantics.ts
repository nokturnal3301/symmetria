import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bool,
  bigint,
  jsonb,
  createDatabase,
  prepare,
  not,
  sql,
} from "../../packages/runtime/src";
import { sqlite } from "../../packages/runtime/src/driver";
import { testDatabase } from "../../packages/kit/src/testing";

const model = schema({
  defaults: { id: int.auto, token: text.unique.default("fixed") },
  naturalDefaults: {
    token: text.unique.default("fixed"),
    value: int.default(7),
  },
  records: {
    id: int,
    label: text.nullable,
    active: bool,
    flags: bool.array,
    metadata: jsonb<{ active: boolean }>(),
    labels: jsonb<string[]>(),
    alternatives: jsonb<string[]>(),
    values: jsonb<unknown[]>(),
    counter: bigint.default(0n),
  },
  children: ({ records }) => ({ id: int, record: records, active: bool }),
});

export const querySemanticsTests = (dialect: "postgres" | "sqlite"): void => {
  const fixture = async () => {
    const postgresFixture =
      dialect === "postgres"
        ? await testDatabase({
            url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
            schema: model,
            max: 4,
          })
        : undefined;
    const local = postgresFixture ? undefined : sqlite();
    local?.createTables(model);
    const driver = postgresFixture?.driver ?? local!;
    const database =
      postgresFixture?.database ?? createDatabase({ schema: model, driver });
    const first = {
      id: 1,
      label: null,
      active: true,
      flags: [true],
      metadata: { active: true },
      labels: ["hello"],
      alternatives: ["hello", "absent"],
      values: [true, null, { first: 1, last: [2, false] }],
    };
    await database.records.insert([
      first,
      {
        id: 2,
        label: "set",
        active: false,
        flags: [false],
        metadata: { active: false },
        labels: ["other"],
        alternatives: [],
        values: [false, 1, "null"],
      },
    ]);
    await database.children.insert([
      { id: 1, recordId: 1, active: true },
      { id: 2, recordId: 2, active: false },
    ]);

    return {
      database,
      first,
      close: postgresFixture ? postgresFixture.close : () => database.$close(),
    };
  };

  test("all-default inserts compose with conflict handling, RETURNING and preparation", async () => {
    const { database, close } = await fixture();

    try {
      const insert = database.defaults
        .insert({})
        .onConflict("token")
        .doNothing()
        .returning((defaults) => [defaults.token])
        .prepare();
      expect(await insert.execute()).toEqual({ token: "fixed" });
      expect(await insert.execute()).toBeNull();
      expect(
        await database.defaults
          .insert({})
          .onConflict("token")
          .doUpdate("token")
          .returning((defaults) => [defaults.token]),
      ).toEqual({ token: "fixed" });
      expect(
        await database.defaults((defaults) => ({ token: defaults.token })),
      ).toEqual([{ token: "fixed" }]);
      expect(
        await database.naturalDefaults
          .insert({})
          .onConflict("token")
          .doNothing()
          .returning((naturalDefaults) => [
            naturalDefaults.token,
            naturalDefaults.value,
          ]),
      ).toEqual({ token: "fixed", value: 7 });
      expect(
        await database.naturalDefaults
          .insert([{}, {}])
          .onConflict("token")
          .doNothing(),
      ).toEqual({ affectedRows: 0 });
      expect(
        await database.naturalDefaults
          .insert({})
          .onConflict("token")
          .doUpdate((naturalDefaults) => ({
            value: naturalDefaults.value.plus(1),
          }))
          .returning((naturalDefaults) => [naturalDefaults.value]),
      ).toEqual({ value: 8 });
    } finally {
      await close();
    }
  });

  test("nullable prepared equality and inequality match literals including SQL unknown under NOT", async () => {
    const { database, close } = await fixture();

    try {
      const equal = prepare({ label: text.nullable }, (parameters) =>
        database.records((records) => ({
          id: records.id,
          $where: records.label.is(parameters.label),
          $orderBy: records.id.ascending,
        })),
      );
      const unequal = prepare({ label: text.nullable }, (parameters) =>
        database.records((records) => ({
          id: records.id,
          $where: records.label.isNot(parameters.label),
          $orderBy: records.id.ascending,
        })),
      );
      const negated = prepare({ label: text.nullable }, (parameters) =>
        database.records((records) => ({
          id: records.id,
          $where: not(records.label.is(parameters.label)),
          $orderBy: records.id.ascending,
        })),
      );
      const negatedUnequal = prepare({ label: text.nullable }, (parameters) =>
        database.records((records) => ({
          id: records.id,
          $where: not(records.label.isNot(parameters.label)),
          $orderBy: records.id.ascending,
        })),
      );

      for (const label of [null, "set", "absent"]) {
        expect(await equal.execute({ label })).toEqual(
          await database.records((records) => ({
            id: records.id,
            $where: records.label.is(label),
            $orderBy: records.id.ascending,
          })),
        );
        expect(await unequal.execute({ label })).toEqual(
          await database.records((records) => ({
            id: records.id,
            $where: records.label.isNot(label),
            $orderBy: records.id.ascending,
          })),
        );
        expect(await negated.execute({ label })).toEqual(
          await database.records((records) => ({
            id: records.id,
            $where: not(records.label.is(label)),
            $orderBy: records.id.ascending,
          })),
        );
        expect(await negatedUnequal.execute({ label })).toEqual(
          await database.records((records) => ({
            id: records.id,
            $where: not(records.label.isNot(label)),
            $orderBy: records.id.ascending,
          })),
        );
      }

      const raw = prepare({ label: text.nullable }, (parameters) =>
        database.records((records) => ({
          id: records.id,
          $where: sql<string | null>`${records.label}`.is(parameters.label),
        })),
      );
      expect(await raw.execute({ label: null })).toEqual([{ id: 1 }]);
      expect(await raw.execute({ label: "set" })).toEqual([{ id: 2 }]);
      const rawUnequal = prepare({ label: text.nullable }, (parameters) =>
        database.records((records) => ({
          id: records.id,
          $where: sql<string | null>`${records.label}`.isNot(parameters.label),
        })),
      );
      expect(await rawUnequal.execute({ label: null })).toEqual([{ id: 2 }]);
      expect(await rawUnequal.execute({ label: "set" })).toEqual([]);
      expect(equal.toSQL({ label: null }).sql).toBe(
        equal.toSQL({ label: "set" }).sql,
      );
    } finally {
      await close();
    }
  });

  test("nullable prepared predicates retain their semantics in mutations", async () => {
    const { database, close } = await fixture();

    try {
      const update = prepare({ label: text.nullable }, (parameters) =>
        database.records
          .update((records) => ({ counter: records.counter.plus(1n) }))
          .where((records) => records.label.is(parameters.label))
          .returning((records) => [records.id, records.counter]),
      );
      expect(await update.execute({ label: null })).toEqual([
        { id: 1, counter: 1n },
      ]);
      expect(await update.execute({ label: "set" })).toEqual([
        { id: 2, counter: 1n },
      ]);
      const remove = prepare({ label: text.nullable }, (parameters) =>
        database.records
          .delete()
          .where((records) => records.label.isNot(parameters.label))
          .returning((records) => [records.id]),
      );
      await database.children.delete();
      expect(await remove.execute({ label: null })).toEqual([{ id: 2 }]);
      expect(await database.records((records) => ({ id: records.id }))).toEqual(
        [{ id: 1 }],
      );
    } finally {
      await close();
    }
  });

  test("projected boolean arrays and relation collections encode membership values consistently", async () => {
    const { database, close } = await fixture();

    try {
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: { flags: records.flags },
          children: records.children((children) => ({
            active: children.active,
          })),
        }))
        .cte("projected");
      const query = prepare({ active: bool }, (parameters) =>
        projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("flags").has(parameters.active),
        })),
      );
      expect(await query.execute({ active: true })).toEqual([{ id: 1 }]);
      expect(await query.execute({ active: false })).toEqual([{ id: 2 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.children.has({ active: true }),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.children.has({ active: false }),
        })),
      ).toEqual([{ id: 2 }]);
    } finally {
      await close();
    }
  });

  test("composite equality distinguishes SQL booleans from native JSON booleans", async () => {
    const { database, close } = await fixture();

    try {
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: {
            active: records.active,
            nested: { active: records.active },
            metadata: records.metadata,
            present: records.children.exists(),
          },
        }))
        .cte("projected");
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.is({
            metadata: { active: true },
            active: true,
            nested: { active: true },
            present: true,
          }),
        })),
      ).toEqual([{ id: 1 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.is({
            active: false,
            nested: { active: false },
            metadata: { active: false },
            present: true,
          }),
        })),
      ).toEqual([{ id: 2 }]);
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("metadata", "active").is(true),
        })),
      ).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("JSON-array overlap compares complete elements, preserves scalar types and handles column operands", async () => {
    const { database, close } = await fixture();

    try {
      const query = prepare({ values: jsonb<unknown[]>() }, (parameters) =>
        database.records((records) => ({
          id: records.id,
          $where: records.values.overlaps(parameters.values),
          $orderBy: records.id.ascending,
        })),
      );

      for (const values of [[true], [null], [{ last: [2, false], first: 1 }]]) {
        expect(await query.execute({ values })).toEqual([{ id: 1 }]);
      }

      for (const values of [[false], [1], ["null"]]) {
        expect(await query.execute({ values })).toEqual([{ id: 2 }]);
      }

      for (const values of [
        [],
        ["1"],
        [{ first: 1 }],
        [{ first: 1, last: [false, 2] }],
      ]) {
        expect(await query.execute({ values })).toEqual([]);
      }

      expect(await query.execute({ values: [true, false] })).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      expect(
        await database.records.as("__symmetria_element_other")(
          (__symmetria_element_other) => ({
            id: __symmetria_element_other.id,
            $where: __symmetria_element_other.labels.overlaps(
              __symmetria_element_other.alternatives,
            ),
          }),
        ),
      ).toEqual([{ id: 1 }]);
      const projected = database
        .records((records) => ({
          id: records.id,
          payload: { flags: records.flags },
        }))
        .cte("projected");
      expect(
        await projected((projected) => ({
          id: projected.id,
          $where: projected.payload.path("flags").overlaps([true]),
        })),
      ).toEqual([{ id: 1 }]);
    } finally {
      await close();
    }
  });

  test("parallel prepared upserts apply every increment and decode computed RETURNING", async () => {
    const { database, first, close } = await fixture();

    try {
      const increment = prepare({ id: int, counter: bigint }, (parameters) =>
        database.records
          .insert({ ...first, id: parameters.id, counter: parameters.counter })
          .onConflict("id")
          .doUpdate((records, excluded) => ({
            counter: records.counter.plus(excluded.counter),
          }))
          .returning((records) => ({
            counter: records.counter,
            nested: { active: records.active },
            flag: records.flags.path(0),
            total: records.labels.length(),
          })),
      );
      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          increment.execute({ id: 1, counter: 1n }),
        ),
      );
      expect(
        results
          .map(({ counter }) => Number(counter))
          .sort((left, right) => left - right),
      ).toEqual(
        Array.from({ length: 30 }, (_unused, position) => position + 1),
      );
      expect(
        results.every(
          ({ nested, flag, total }) => nested.active && flag && total === 1,
        ),
      ).toBe(true);
      expect(
        await database.records((records) => ({
          counter: records.counter,
          $where: records.id.is(1),
        })),
      ).toEqual([{ counter: 30n }]);
    } finally {
      await close();
    }
  });
};
