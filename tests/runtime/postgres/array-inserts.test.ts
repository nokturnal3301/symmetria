import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  smallint,
  bigint,
  text,
  bool,
  numeric,
  jsonb,
  timestamptz,
  timestamp,
  date,
  uuid,
  real,
  doublePrecision,
  varchar,
  oneOf,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const samples = table({
  id: int.auto,
  batch: text,
  position: int,
  small: smallint,
  big: bigint,
  label: text.nullable,
  flag: bool,
  amount: numeric(12, 2),
  data: jsonb<unknown>().nullable,
  at: timestamptz,
  local: timestamp,
  day: date,
  key: uuid,
  ratio: real,
  precise: doublePrecision,
  code: varchar(5),
});
const tagged = table({
  id: int.auto,
  slug: text.unique,
  hits: int.default(0),
  kind: oneOf("a", "b").default("a"),
  tenant: int.default(1),
});
const model = schema({ samples, tagged });

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

const labels = [
  "plain",
  "",
  "NULL",
  "null",
  'quote " inside',
  "back\\slash",
  "comma, brace {} [] and 'single'",
  "new\nline\ttab",
  "юникод 🎈 文字",
  null,
];
const documents: unknown[] = [
  { a: 1, nested: { quote: '"', slash: "\\", text: "x,y{z}" } },
  [1, "two", null, { three: 3 }],
  "a string",
  42,
  true,
  null,
  { unicode: "юникод 🎈", big: 9007199254740993 },
];

/** Rows with every awkward value; `size` decides which INSERT form is used. */
const rows = (batch: string, size: number) =>
  Array.from({ length: size }, (_, position) => ({
    batch,
    position,
    small: (position % 2 ? -1 : 1) * (32767 - position),
    big: 9007199254740993n + BigInt(position),
    label: labels[position % labels.length]!,
    flag: position % 3 === 0,
    amount: position % 4 ? `${position}.129` : "-99999999.995",
    // SQL NULL for one row in eight, JSON null among the documents.
    data: position % 8 === 7 ? null : documents[position % documents.length],
    at: new Date(Date.UTC(1890 + position, 5, 15, 12, 30, 45, 123)),
    local: new Date(Date.UTC(2020, 0, 1 + position, 1, 2, 3, 456)),
    day: `20${String(10 + (position % 20)).padStart(2, "0")}-02-28`,
    key: `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
    ratio: [1.5, -0, Number.NaN, Number.POSITIVE_INFINITY, 0.1][position % 5]!,
    precise: [0.1 + 0.2, -0, 1e308, 5e-324, -123.456][position % 5]!,
    code: ["abcde", "", "a b", "é"][position % 4]!,
  }));

describe.skipIf(!databaseUrl)(
  "bulk inserts sent as one array per column",
  () => {
    let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
    let database: typeof isolated.database;

    beforeAll(async () => {
      isolated = await testDatabase({
        url: databaseUrl!,
        schema: model,
        prefix: "symmetria_array_inserts",
        max: 2,
      });
      database = isolated.database;
    });

    afterAll(async () => {
      await isolated?.close();
    });

    test("the array form stores exactly what the VALUES form stores", async () => {
      const few = database.samples.insert(rows("values", 99));
      const many = database.samples.insert(rows("arrays", 150));

      expect(few.toSQL().sql).toContain(") VALUES (");
      expect(many.toSQL().sql).toContain("SELECT * FROM unnest($1::text[], ");
      expect(many.toSQL().parameters).toHaveLength(15);
      expect(await few).toEqual({ affectedRows: 99 });
      expect(await many).toEqual({ affectedRows: 150 });

      const stored = (batch: string) =>
        database.samples(({ id: _id, batch: _batch, ...row }) => row as never, {
          where: { batch },
          orderBy: { position: "asc" },
          limit: 99,
        }) as Promise<Record<string, unknown>[]>;
      const [fromValues, fromArrays] = await Promise.all([
        stored("values"),
        stored("arrays"),
      ]);

      expect(fromArrays).toHaveLength(99);
      expect(fromArrays).toEqual(fromValues);
      // Spot checks against the input, not only against the other form.
      expect(fromArrays[4]).toMatchObject({
        label: 'quote " inside',
        big: 9007199254740997n,
        amount: "-100000000.00",
        code: "abcde",
      });
      expect(fromArrays[5]).toMatchObject({
        label: "back\\slash",
        amount: "5.13",
        code: "",
      });
      expect(fromArrays[9]!.label).toBeNull();
      expect(fromArrays[2]!.label).toBe("NULL");
      expect(fromArrays[0]!.data).toEqual(documents[0]);
      // JSON null and SQL NULL both read as null; the database tells them apart.
      const sqlNulls = (batch: string) =>
        database
          .samples({
            where: (row, { sql }) => [
              row.batch.is(batch),
              row.position.below(99),
              sql<boolean>`${row.data} IS NULL`.is(true),
            ],
          })
          .count();

      expect(await sqlNulls("arrays")).toBe(await sqlNulls("values"));
      expect(await sqlNulls("values")).toBe(25);
      expect(Object.is(fromArrays[1]!.precise, -0)).toBe(true);
      expect(fromArrays[2]!.ratio).toBeNaN();
    });

    test("generated ids follow the input order and returning() matches it", async () => {
      const created = await database.samples
        .insert(rows("ordered", 300))
        .returning("id", "position");

      expect(created.map((row) => row.position)).toEqual(
        Array.from({ length: 300 }, (_, position) => position),
      );
      expect(created.every((row, i) => !i || row.id > created[i - 1]!.id)).toBe(
        true,
      );
    });

    test("a value the column rejects fails the statement in both forms", async () => {
      const long = (size: number) =>
        database.samples.insert(
          rows("long", size).map((row, i) =>
            i === size - 1 ? { ...row, code: "too long" } : row,
          ),
        );

      await expect(long(5).execute()).rejects.toThrow();
      await expect(long(120).execute()).rejects.toThrow();
      expect(await database.samples({ where: { batch: "long" } }).count()).toBe(
        0,
      );
    });

    test("conflicts, upserts, defaults and scopes keep working past the threshold", async () => {
      const slugs = (size: number) =>
        Array.from({ length: size }, (_, i) => ({ slug: `s${i}`, hits: i }));

      await database.tagged.insert(slugs(200));
      // Rows that leave a column to its default are sent as arrays as well.
      expect(
        await database.tagged({ where: { kind: "a", tenant: 1 } }).count(),
      ).toBe(200);
      expect(
        await database.tagged
          .insert(slugs(250))
          .onConflict("slug")
          .doNothing()
          .returning("slug"),
      ).toHaveLength(50);
      await database.tagged.upsert(
        slugs(250).map((row) => ({ ...row, hits: row.hits + 1000 })),
        { by: "slug" },
      );
      expect(await database.tagged.get({ slug: "s249" })).toMatchObject({
        hits: 1249,
      });
      // An enum has no array form here; such an insert keeps VALUES and works.
      const kinds = database.tagged.insert(
        Array.from({ length: 120 }, (_, i) => ({
          slug: `k${i}`,
          kind: "b" as const,
        })),
      );

      expect(kinds.toSQL().sql).toContain(") VALUES (");
      expect(await kinds).toEqual({ affectedRows: 120 });

      const scoped = database.$scope({ tagged: (row) => row.tenant.is(1) });

      await expect(
        scoped.tagged
          .insert(
            Array.from({ length: 130 }, (_, i) => ({
              slug: `x${i}`,
              tenant: i === 129 ? 2 : 1,
            })),
          )
          .execute(),
      ).rejects.toMatchObject({ code: "SYMMETRIA_OUT_OF_SCOPE" });
      expect(
        await database.tagged({ where: (row) => row.slug.like("x%") }).count(),
      ).toBe(0);
    });
  },
);
