import { expect } from "bun:test";
import { test, isolatedDriver } from "../../support/isolated-driver";
import {
  schema,
  createDatabase,
  int,
  text,
  bool,
  bigint,
  numeric,
  oneOf,
  jsonb,
  sql,
  prepare,
  coalesce,
  maximum,
  minimum,
  sum,
  over,
  customType,
} from "../../../packages/runtime/src";

test("prepared scoped upserts roll back admitted rows when another conflict is outside scope", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({ rows: { id: int, tenant: int, value: text } }),
    driver,
  });
  driver.createTables(db);

  try {
    await db.rows.insert({ id: 1, tenant: 2, value: "original" });
    const scoped = db.$scope({ rows: (r) => r.tenant.is(1) });
    const query = prepare({ value: text }, (p) =>
      scoped.rows
        .insert([
          { id: 2, tenant: 1, value: p.value },
          { id: 1, tenant: 1, value: p.value },
        ])
        .onConflict("id")
        .doUpdate("value"),
    );
    await expect(query.execute({ value: "changed" })).rejects.toMatchObject({
      code: "SYMMETRIA_OUT_OF_SCOPE",
    });
    expect(await db.rows((r) => r)).toEqual([
      { id: 1, tenant: 2, value: "original" },
    ]);
    expect(await db.rows.insert([]).prepare().execute()).toEqual({
      affectedRows: 0,
    });
    expect(
      await db.rows
        .insert([])
        .returning((r) => ({ id: r.id }))
        .prepare()
        .execute(),
    ).toEqual([]);
  } finally {
    await db.$close();
  }
});

test("scoped chunked inserts use one transaction and roll back every chunk", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({ rows: { id: int, tenant: int } }),
    driver,
  });
  driver.createTables(db);

  try {
    await db.rows.insert({ id: 34000, tenant: 2 });
    const scoped = db.$scope({ rows: (r) => r.tenant.is(1) });
    const rows = Array.from({ length: 34000 }, (_, i) => ({
      id: i + 1,
      tenant: 1,
    }));

    for (const prepared of [false, true]) {
      const query = scoped.rows
        .insert(rows)
        .onConflict("id")
        .doUpdate("tenant");
      await expect(
        (prepared ? query.prepare() : query).execute(),
      ).rejects.toMatchObject({ code: "SYMMETRIA_OUT_OF_SCOPE" });
      expect(await db.rows((r) => r)).toEqual([{ id: 34000, tenant: 2 }]);
    }
  } finally {
    await db.$close();
  }
}, 10000);

test("prepared chunk templates rebind parameters on every execution", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({ rows: { id: int, value: text } }),
    driver,
  });
  driver.createTables(db);

  try {
    const query = prepare({ value: text }, (p) =>
      db.rows
        .insert(
          Array.from({ length: 34000 }, (_, id) => ({ id, value: p.value })),
        )
        .onConflict("id")
        .doUpdate("value")
        .returning((r) => ({ id: r.id, value: r.value })),
    );

    for (const value of ["first", "second"]) {
      const rows = await query.execute({ value });
      expect(rows).toHaveLength(34000);
      expect(new Set(rows.map((r) => r.id)).size).toBe(34000);
      expect(new Set(rows.map((r) => r.value))).toEqual(new Set([value]));
      expect(await db.rows.byId(33999).one()).toEqual({ id: 33999, value });
    }
  } finally {
    await db.$close();
  }
}, 10000);

test("typed raw and prepared values retain bool/JSON types through nested paths", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({
      rows: { id: int, flag: bool, document: jsonb<{ ok: boolean }>() },
    }),
    driver,
  });
  driver.createTables(db);

  try {
    await db.rows.insert({ id: 1, flag: true, document: { ok: true } });
    expect(
      await db.rows((r) => ({
        doc: sql.of(jsonb<{ ok: boolean }>())`${r.document}`,
      })),
    ).toEqual([{ doc: { ok: true } }]);
    const source = db
      .rows((r) => ({ payload: { flag: sql.of(bool)`${r.flag}` } }))
      .cte("projected");
    expect(
      await source(
        (r) => ({
          flag: r.payload.path("flag"),
        }),
        { where: (r) => r.payload.path("flag").is(true) },
      ),
    ).toEqual([{ flag: true }]);
    const query = prepare({ flag: bool, doc: jsonb<{ ok: boolean }>() }, (p) =>
      db.rows(() => ({
        flag: p.flag,
        doc: p.doc,
        payload: { flag: p.flag, doc: p.doc },
      })),
    );
    expect(await query.execute({ flag: true, doc: { ok: true } })).toEqual([
      {
        flag: true,
        doc: { ok: true },
        payload: { flag: true, doc: { ok: true } },
      },
    ]);
  } finally {
    await db.$close();
  }
});

test("prototype-named columns insert, update and decode as ordinary data properties", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({
      rows: {
        id: int,
        constructor: text,
        toString: text,
        hasOwnProperty: text,
        ["__proto__"]: text,
      },
    }),
    driver,
  });
  driver.createTables(db);
  const row = {
    id: 1,
    constructor: "a",
    toString: "b",
    hasOwnProperty: "c",
    ["__proto__"]: "d",
  };

  try {
    await db.rows.insert(row);
    expect(await db.rows((r) => r)).toEqual([row]);
    await db.rows.update({ ...row, ["__proto__"]: "changed" }).all();
    expect(await db.rows((r) => r)).toEqual([
      { ...row, ["__proto__"]: "changed" },
    ]);
  } finally {
    await db.$close();
  }
});

test("enum aggregates remain valid window functions", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({ rows: { id: int, state: oneOf("z", "a") } }),
    driver,
  });
  driver.createTables(db);

  try {
    await db.rows.insert([
      { id: 1, state: "z" },
      { id: 2, state: "a" },
    ]);
    expect(
      await db.rows(
        (r) => ({
          state: over(maximum(r.state), { orderBy: r.id.ascending }),
        }),
        { orderBy: (r) => r.id.ascending },
      ),
    ).toEqual([{ state: "z" }, { state: "a" }]);
  } finally {
    await db.$close();
  }
});

test("numeric comparisons, membership, extrema and writes are decimal-exact", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({
      rows: { id: int, n: numeric(30, 2).unique, flag: bool.default(false) },
    }),
    driver,
  });
  driver.createTables(db);

  try {
    await db.rows.insert([
      { id: 1, n: "9007199254740992" },
      { id: 2, n: "9007199254740993" },
      { id: 3, n: "9" },
      { id: 4, n: "10" },
    ]);
    expect(
      await db.rows
        .update({ flag: true })
        .where((r) => r.n.is("9007199254740992")),
    ).toEqual({ affectedRows: 1 });
    expect(
      await db.rows((r) => ({ id: r.id }), { where: (r) => r.n.in(["9.0"]) }),
    ).toEqual([{ id: 3 }]);
    expect(
      await db.rows((r) => ({ min: minimum(r.n), max: maximum(r.n) })),
    ).toEqual([{ min: "9.00", max: "9007199254740993.00" }]);
    await expect(
      db.rows.insert({ id: 5, n: "9.000" }).execute(),
    ).rejects.toThrow();
    await db.rows.delete().all();
    await db.rows.insert([
      { id: 1, n: "0.005" },
      { id: 2, n: "0.016" },
    ]);
    expect(await db.rows((r) => ({ total: sum(r.n) }))).toEqual([
      { total: "0.03" },
    ]);
  } finally {
    await db.$close();
  }
});

test("decimal sums retain low digits across large additions, rescaling and cancellation", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({ rows: { id: int, n: numeric() } }),
    driver,
  });
  driver.createTables(db);

  try {
    for (const middle of ["2", "0.01"] as const) {
      await db.rows.delete().all();
      await db.rows.insert(
        ["9007199254740991", middle, "-9007199254740991"].map((n, id) => ({
          id,
          n,
        })),
      );
      expect(await db.rows((r) => ({ total: sum(r.n) }))).toEqual([
        { total: middle },
      ]);
    }
  } finally {
    await db.$close();
  }
});

test("bigint expression parameters retain integer affinity and precision", async () => {
  const driver = isolatedDriver();
  const db = createDatabase({
    schema: schema({ rows: { id: int, n: bigint.nullable } }),
    driver,
  });
  driver.createTables(db);

  try {
    await db.rows.insert([
      { id: 1, n: 1n },
      { id: 2, n: 2n },
      { id: 3, n: 3n },
      { id: 4, n: null },
    ]);
    expect(
      await db.rows((r) => ({ id: r.id }), {
        where: (r) => r.n.plus(0n).is(2n),
      }),
    ).toEqual([{ id: 2 }]);
    expect(
      await db.rows((r) => ({ id: r.id }), {
        where: (r) => r.n.plus(0n).below(2n),
      }),
    ).toEqual([{ id: 1 }]);
    expect(
      await db.rows(
        (r) => ({
          n: coalesce(r.n, 0n),
        }),
        { orderBy: (r) => coalesce(r.n, 0n).ascending },
      ),
    ).toEqual([{ n: 0n }, { n: 1n }, { n: 2n }, { n: 3n }]);
  } finally {
    await db.$close();
  }
});

test("keyset pages agree with full execution for typed expressions and boolean keys", async () => {
  const driver = isolatedDriver();
  const real = customType<number>("double precision", {
    encode: (value) => value,
    decode: (value) => Number(value),
  });
  const db = createDatabase({
    schema: schema({
      rows: { id: int, code: text, n: bigint, f: real, active: bool },
    }),
    driver,
  });
  driver.createTables(db);

  try {
    await db.rows.insert(
      ["1", "10", "2", "20"].map((code, i) => ({
        id: i,
        code,
        n: 9007199254740992n + BigInt(i),
        f: (i - 2) * 1e20,
        active: i % 2 === 0,
      })),
    );

    for (const descending of [false, true]) {
      for (const size of [1, 2, 3]) {
        for (const kind of ["text", "coalesce", "bigint", "real", "bool"]) {
          const query = db.rows(
            (r) => {
              const key =
                kind === "text"
                  ? sql.of(text)`upper(${r.code})`
                  : kind === "coalesce"
                    ? coalesce(r.code, "")
                    : kind === "bigint"
                      ? r.n.plus(0n)
                      : kind === "real"
                        ? sql.of(real)`${r.f} + 0`
                        : r.active;

              return {
                id: r.id,
              };
            },
            {
              orderBy: (r) => {
                const key =
                  kind === "text"
                    ? sql.of(text)`upper(${r.code})`
                    : kind === "coalesce"
                      ? coalesce(r.code, "")
                      : kind === "bigint"
                        ? r.n.plus(0n)
                        : kind === "real"
                          ? sql.of(real)`${r.f} + 0`
                          : r.active;

                return [
                  descending ? key.descending : key.ascending,
                  r.id.ascending,
                ];
              },
            },
          );
          const expected = await query;
          const rows: { id: number }[] = [];
          let after: Awaited<ReturnType<typeof query.page>>["nextCursor"] =
            null;

          for (let step = 0; step < 6; step++) {
            const page = await query.page({ size, after });
            rows.push(...page.items);
            after = page.nextCursor;

            if (!after) {
              break;
            }
          }

          expect(rows).toEqual(expected);
          expect(after).toBeNull();
        }
      }
    }
  } finally {
    await db.$close();
  }
});
