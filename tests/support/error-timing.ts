/**
 * One rule for when errors surface. Errors about a query's shape (unknown
 * columns, invalid options) throw where it is built; errors about data values
 * reject the promise of the operation that runs it, so `.catch()` and
 * `.then(ok, fail)` see them on reads and writes alike, while `toSQL()` throws
 * them.
 */
import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  smallint,
  bigint,
  text,
  timestamptz,
  oneOf,
  jsonb,
  customType,
  prepare,
} from "../../packages/runtime/src";
import { testDatabase } from "./postgres";

/** A Standard Schema accepting `{ theme: string }`. */
const settingsSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) =>
      typeof (value as { theme?: unknown })?.theme === "string"
        ? { value: value as { theme: string } }
        : { issues: [{ message: "theme must be a string" }] },
    types: undefined as unknown as {
      input: { theme: string };
      output: { theme: string };
    },
  },
};
/** Positive amounts only, as a custom codec that rejects values. */
const cents = customType<number>("integer", {
  encode: (value) => {
    if (value < 0) {
      throw new Error("cents must not be negative");
    }

    return value;
  },
  decode: (value) => Number(value),
});

const items = table({
  id: int.auto,
  name: text,
  count: int.nullable,
  small: smallint.nullable,
  big: bigint.nullable,
  at: timestamptz.nullable,
  tags: text.array.nullable,
  state: oneOf("draft", "live").nullable,
  settings: jsonb(settingsSchema).nullable,
  price: cents.nullable,
  code: int.unique.nullable,
});
const parts = table({ id: int.auto, item: items, size: int });
const model = schema({ items, parts });

/** The error a promise rejected with, or a marker when it resolved. */
const rejection = (operation: PromiseLike<unknown>): Promise<unknown> =>
  Promise.resolve(operation).then(
    () => "resolved",
    (error: unknown) => error,
  );

export const errorTimingTests = (): void => {
  const fixture = async () => {
    const isolated = await testDatabase({
      url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
      schema: model,
      prefix: "symmetria_error_timing",
      max: 2,
    });
    await isolated.database.items.insert({ name: "first", count: 1 });

    return isolated;
  };

  test("insert(bad).catch() catches every kind of data error", async () => {
    const { database, close } = await fixture();

    try {
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ name: null }, /"items.name" cannot be null/],
        [{}, /missing required column "items.name"/],
        [{ name: "x", count: 1.5 }, /integer values are integers/],
        [{ name: "x", small: 70_000 }, /smallint values are integers/],
        [{ name: "x", big: 2 ** 60 }, /bigint values or safe integers/],
        [{ name: "x", at: new Date("not a date") }, /valid Dates/],
        [{ name: "x", tags: ["a", null] }, /cannot store NULL elements/],
        [{ name: "x", settings: { theme: 1 } }, /theme must be a string/],
        [{ name: "x", price: -1 }, /cents must not be negative/],
        // PostgreSQL rejects an unknown enum label when the insert runs.
        [{ name: "x", state: "archived" }, /invalid input value for enum/],
      ];

      for (const [values, message] of cases) {
        let query: PromiseLike<unknown> | undefined;

        // Building the insert never throws for bad values...
        expect(() => {
          query = database.items.insert(values as never);
        }).not.toThrow();
        // ...and every way of running it rejects with the error.
        const caught = await Promise.resolve(query!).catch(
          (error: unknown) => error,
        );
        expect(String((caught as Error).message)).toMatch(message);
        await new Promise<void>((resolve) => {
          query!.then(
            () => {
              throw new Error("the insert should have failed");
            },
            (error: unknown) => {
              expect(String((error as Error).message)).toMatch(message);
              resolve();
            },
          );
        });
      }

      expect(
        await rejection(
          database.items
            .insert([
              { name: "a", code: 1 },
              { name: "b", code: 1 },
            ])
            .onConflict("code")
            .doUpdate("name"),
        ),
      ).toMatchObject({ code: "SYMMETRIA_DUPLICATE_CONFLICT_KEY" });
      expect(await database.items.count()).toBe(1);
    } finally {
      await close();
    }
  });

  test("reads, lookups, updates and nested writes reject with data errors", async () => {
    const { database, close } = await fixture();

    try {
      const integer = /(integer|smallint) values are integers/;
      const operations: [string, () => PromiseLike<unknown>][] = [
        [
          "read",
          () =>
            database.items((item) => ({ id: item.id }), {
              where: (item) => item.count.above(1.5),
            }),
        ],
        [
          "first",
          () =>
            database
              .items((item) => ({ id: item.id }), {
                where: (item) => item.count.in([1, 2 ** 40]),
              })
              .first(),
        ],
        ["byId", () => database.items.byId(1.5).one()],
        ["lookup update", () => database.items.byId(1.5).update({ count: 2 })],
        [
          "update value",
          () => database.items.update({ count: 0.5 }).all().execute(),
        ],
        [
          "update where",
          () =>
            database.items
              .update({ count: 2 })
              .where((item) => item.id.is(0.5))
              .execute(),
        ],
        [
          "delete where",
          () =>
            database.items
              .delete()
              .where((item) => item.small.is(1e6))
              .execute(),
        ],
        [
          "upsert values",
          () =>
            database.items
              .insert({ name: "x", code: 1 })
              .onConflict("code")
              .doUpdate({ count: 2.5 }),
        ],
        [
          "nested insert",
          () =>
            database.items.insert({
              name: "x",
              parts: { create: [{ size: 1 }, { size: 2.5 }] },
            }),
        ],
        [
          "subquery",
          () =>
            database.items((item) => ({ id: item.id }), {
              where: (item) =>
                item.id.in(
                  database.items((other) => ({ id: other.id }), {
                    where: (other) => other.count.is(1.25),
                  }),
                ),
            }),
        ],
        [
          "count",
          () => database.items({ where: (item) => item.count.is(0.5) }).count(),
        ],
        [
          "exists",
          () =>
            database.items({ where: (item) => item.small.is(1e6) }).exists(),
        ],
        ["unique lookup", () => database.items.by.code(2.5).maybeOne()],
        [
          "page",
          () =>
            database
              .items((item) => ({ id: item.id }), {
                where: (item) => item.count.is(0.5),
                orderBy: (item) => item.id.ascending,
              })
              .page({ size: 10 }),
        ],
      ];

      for (const [label, operation] of operations) {
        expect([
          label,
          String(((await rejection(operation())) as Error).message),
        ]).toEqual([label, expect.stringMatching(integer)]);
      }

      expect(
        String(
          (
            (await rejection(
              database.items.byId(undefined as never).maybeOne(),
            )) as Error
          ).message,
        ),
      ).toMatch(/primary key "id" cannot be null or undefined/);
      // An unsafe integer in bigint arithmetic, in a projection and an update.
      for (const operation of [
        () => database.items((item) => ({ next: item.big.plus(2 ** 60) })),
        () =>
          database.items
            .update((item) => ({ big: item.big.plus(2 ** 60) }))
            .all()
            .execute(),
      ]) {
        expect(
          String(((await rejection(operation())) as Error).message),
        ).toMatch(/bigint values or safe integers/);
      }
      expect(await database.items.count()).toBe(1);
      expect(await database.parts.count()).toBe(0);
    } finally {
      await close();
    }
  });

  test("a $scope() value the codecs reject fails each execution until it is valid", async () => {
    const { database, close } = await fixture();

    try {
      const current = { count: 1.5 };
      const scoped = database.$scope({
        items: (item) => item.count.is(current.count),
      });
      // Building never throws; the scope is evaluated again at every execution.
      const names = scoped.items((item) => ({ name: item.name }));
      const rename = scoped.items.update({ name: "renamed" }).all();

      expect(String(((await rejection(names)) as Error).message)).toMatch(
        /integer values/,
      );
      expect(String(((await rejection(rename)) as Error).message)).toMatch(
        /integer values/,
      );
      expect(() => names.toSQL()).toThrow(/integer values/);

      current.count = 1;
      expect(await names).toEqual([{ name: "first" }]);
      expect(await rename).toEqual({ affectedRows: 1 });
    } finally {
      await close();
    }
  });

  test("shape errors still throw where the query is built", async () => {
    const { database, close } = await fixture();

    try {
      expect(() =>
        database.items.insert({ name: "x", missing: 1 } as never),
      ).toThrow(/unknown column "items.missing"/);
      // Even after a data error in the same values.
      expect(() =>
        database.items.insert({ name: null, missing: 1 } as never),
      ).toThrow(/unknown column "items.missing"/);
      expect(() =>
        database.items((item) => ({ id: (item as never as { x: never }).x })),
      ).toThrow(/is not a column or relation/);
      expect(() =>
        database.items.insert({ name: "x" }).onConflict("missing" as never),
      ).toThrow(/unknown conflict column/);
      expect(() =>
        database.items((item) => ({ id: item.id })).cte("items"),
      ).toThrow(/would hide it/);
    } finally {
      await close();
    }
  });

  test("toSQL() and prepare() throw data errors; prepared values reject per execution", async () => {
    const { database, close } = await fixture();

    try {
      const bad = database.items.insert({ name: "x", count: 1.5 });

      expect(() => bad.toSQL()).toThrow(/integer values/);
      expect(() => prepare({}, () => bad)).toThrow(/integer values/);

      const byCount = prepare({ count: int }, (parameters) =>
        database.items((item) => ({ name: item.name }), {
          where: (item) => item.count.is(parameters.count),
        }),
      );

      expect(
        String(((await rejection(byCount({ count: 1.5 }))) as Error).message),
      ).toMatch(/integer values/);
      expect(await byCount({ count: 1 })).toEqual([{ name: "first" }]);
    } finally {
      await close();
    }
  });
};
