import { describe, expect, test } from "bun:test";
import {
  schema,
  table,
  customType,
  int,
  text,
  bool,
  timestamptz,
  varchar,
  numeric,
  oneOf,
  index,
  sql,
  operatorClass,
} from "../../../packages/runtime/src";
import { normalizeResult } from "../../../packages/runtime/src/entries/internal";
import {
  detectDrift,
  migrationSnapshot,
  parseMigrationSnapshot,
} from "../../../packages/kit/src";
import { expressionKey } from "../../../packages/kit/src/migrations/expressions";
import { testDatabase } from "../../support/postgres";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL drift definitions", () => {
  test("char(n) and decimal columns have no drift, and a same-named type from another schema does", async () => {
    const passthrough = {
      encode: (value: string) => value,
      decode: (value: unknown) => String(value),
    };
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const [allowed, loose] = [`drift_a_${suffix}`, `drift_b_${suffix}`];
    const admin = await testDatabase({
      url: databaseUrl!,
      schema: schema({ marker: { id: int } }),
    });
    const run = (statement: string) =>
      admin.driver.execute({ sql: statement, parameters: [] });

    await run(`CREATE SCHEMA "${allowed}"`);
    await run(`CREATE SCHEMA "${loose}"`);
    await run(
      `CREATE DOMAIN "${allowed}".code AS text CHECK (VALUE ~ '^[A-Z]+$')`,
    );
    await run(`CREATE DOMAIN "${loose}".code AS text`);

    const model = schema({
      records: {
        id: int,
        short: customType<string>("char(5)", passthrough),
        price: customType<string>("decimal(8,2)", passthrough),
        code: customType<string>(`${allowed}.code`, passthrough),
        codes: customType<string>(`${allowed}.code[]`, passthrough).nullable,
      },
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });
    const drift = () =>
      detectDrift({
        execute: fixture.driver.execute,
        snapshot: model.$snapshot(),
        schemaName: fixture.namespace,
      });

    try {
      // PostgreSQL prints character(5) and numeric(8,2) for these.
      expect(await drift()).toEqual([]);

      await fixture.driver.execute({
        sql: `ALTER TABLE records ALTER COLUMN code TYPE "${loose}".code`,
        parameters: [],
      });
      expect(await drift()).toEqual([
        {
          kind: "type-mismatch",
          table: "records",
          column: "code",
          expected: `${allowed}.code`,
          actual: `${loose}.code`,
        },
      ]);
    } finally {
      await fixture.close();
      await run(`DROP SCHEMA "${allowed}" CASCADE`);
      await run(`DROP SCHEMA "${loose}" CASCADE`);
      await admin.close();
    }
  });

  test("fresh array aliases and expression, partial and covering indexes have no drift", async () => {
    const model = schema({
      records: table({
        id: int,
        email: text,
        label: varchar(40),
        active: bool,
        seen: timestamptz.array,
        state: oneOf("draft", "published"),
      }).indexes((records) => ({
        email: index(sql<string>`lower(${records.email})`).unique.where(
          records.active.is(true),
        ),
        labels: index(
          records.label.ascending.nullsFirst,
          records.id.descending,
        ).include(records.email),
        filtered: index(records.id).where(records.email.is("A  B")),
        membership: index(sql<string>`lower(${records.label})`).where(
          records.email.in(["A", "B"]),
        ),
        state: index(records.id).where(records.state.is("draft")),
      })),
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });

    try {
      expect(
        await detectDrift({
          execute: fixture.driver.execute,
          snapshot: model.$snapshot(),
          schemaName: fixture.namespace,
        }),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("same-name index changes report drift for uniqueness, keys, ordering, method, includes and predicates", async () => {
    const model = schema({
      records: table({
        id: int,
        email: text,
        label: text,
        active: bool,
      }).indexes((records) => ({ email: index(records.email).unique })),
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });

    try {
      const options = {
        execute: fixture.driver.execute,
        snapshot: model.$snapshot(),
        schemaName: fixture.namespace,
      };
      expect(await detectDrift(options)).toEqual([]);

      for (const definition of [
        "CREATE INDEX records_email_idx ON records (email)",
        "CREATE UNIQUE INDEX records_email_idx ON records (label)",
        "CREATE UNIQUE INDEX records_email_idx ON records (email DESC)",
        "CREATE INDEX records_email_idx ON records USING hash (email)",
        "CREATE UNIQUE INDEX records_email_idx ON records (email) INCLUDE (label)",
        "CREATE UNIQUE INDEX records_email_idx ON records (email) WHERE active = true",
      ]) {
        await fixture.driver.execute({
          sql: "DROP INDEX records_email_idx",
          parameters: [],
        });
        await fixture.driver.execute({ sql: definition, parameters: [] });
        expect(await detectDrift(options)).toMatchObject([
          { kind: "index-mismatch", table: "records" },
        ]);
      }
    } finally {
      await fixture.close();
    }
  });

  test("a NOT VALID NOT NULL constraint (PostgreSQL 18+) counts as nullable", async () => {
    const model = schema({ records: table({ id: int, note: text }) });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });
    const run = (sql: string) =>
      fixture.driver.execute({ sql, parameters: [] });

    try {
      const { rows } = normalizeResult(await run("SHOW server_version_num"));
      const drift = () =>
        detectDrift({
          execute: fixture.driver.execute,
          snapshot: model.$snapshot(),
          schemaName: fixture.namespace,
        });
      expect(await drift()).toEqual([]);

      // Older servers have no NOT VALID form; their NOT NULL is always enforced.
      if (Number(rows[0]!.server_version_num) < 180000) {
        return;
      }

      // attnotnull stays true, yet rows written before the constraint may hold NULL.
      await run("ALTER TABLE records ALTER COLUMN note DROP NOT NULL");
      await run("INSERT INTO records (id, note) VALUES (1, NULL)");
      await run(
        "ALTER TABLE records ADD CONSTRAINT records_note_not_null NOT NULL note NOT VALID",
      );
      expect(await drift()).toEqual([
        {
          kind: "nullability-mismatch",
          table: "records",
          column: "note",
          expected: "NOT NULL",
          actual: "NULL",
        },
      ]);

      await run("UPDATE records SET note = '' WHERE note IS NULL");
      await run(
        "ALTER TABLE records VALIDATE CONSTRAINT records_note_not_null",
      );
      expect(await drift()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("renaming an indexed column reports drift with Bun SQLSTATE errors", async () => {
    const model = schema({
      records: table({ id: int, name: text }).indexes((records) => ({
        name: index(records.name),
      })),
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });

    try {
      await fixture.driver.execute({
        sql: "ALTER TABLE records RENAME COLUMN name TO label",
        parameters: [],
      });
      const findings = await detectDrift({
        execute: fixture.driver.execute,
        snapshot: model.$snapshot(),
        schemaName: fixture.namespace,
      });
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "missing-column",
            table: "records",
            column: "name",
          }),
          expect.objectContaining({
            kind: "extra-column",
            table: "records",
            column: "label",
          }),
          expect.objectContaining({ kind: "index-mismatch", table: "records" }),
        ]),
      );
    } finally {
      await fixture.close();
    }
  });
  test("value-changing casts keep their key through PostgreSQL's own rendering", async () => {
    const conditions = {
      truncated_literal: `"code" = 'abc'::varchar(2)`,
      padded_literal: `"code" = 'abc'::char(2)`,
      rounded_literal: `"score" > 1.9::integer`,
      scaled_literal: `"ratio" > 1.25::numeric(3,1)`,
      truncated_text: `"code"::varchar(3) = 'abc'`,
      truncated_varchar: `"label"::varchar(3) = 'abc'`,
    };
    const model = schema({
      records: table({
        id: int,
        code: text,
        label: varchar(10),
        score: int,
        ratio: numeric(6, 2),
      })
        .checks(() =>
          Object.fromEntries(
            Object.entries(conditions).map(([name, condition]) => [
              name,
              sql<boolean>(
                // The tag takes template literals only; text built at run
                // time has to be made into one on purpose.
                Object.assign([condition], { raw: [condition] }),
              ),
            ]),
          ),
        )
        .indexes((records) => ({
          short: index(records.id).where(
            sql<boolean>`${records.code}::varchar(3) = 'abc'`,
          ),
        })),
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });

    try {
      const types = new Map([
        ["code", "text"],
        ["label", "varchar(10)"],
        ["score", "integer"],
        ["ratio", "numeric(6,2)"],
      ]);
      const printed = normalizeResult(
        await fixture.driver.execute({
          sql: `SELECT conname AS name, pg_get_expr(conbin, conrelid) AS expression
                FROM pg_constraint
                WHERE conrelid = 'records'::regclass AND contype = 'c'
                UNION ALL
                SELECT 'short', pg_get_expr(indpred, indrelid)
                FROM pg_index
                WHERE indrelid = 'records'::regclass AND indpred IS NOT NULL`,
          parameters: [],
        }),
      ).rows as { name: string; expression: string }[];

      expect(printed).toHaveLength(Object.keys(conditions).length + 1);

      for (const { name, expression } of printed) {
        const written =
          name === "short"
            ? conditions.truncated_text
            : Object.entries(conditions).find(([key]) =>
                name.includes(key),
              )![1];

        expect([name, expressionKey(expression, types)]).toEqual([
          name,
          expressionKey(written, types),
        ]);
        // The cast is why these are not the plain comparison.
        expect(expressionKey(expression, types)).not.toBe(
          expressionKey(
            written.replace(/::[a-z]+\([\d,]+\)|::integer/, ""),
            types,
          ),
        );
      }

      expect(
        await detectDrift({
          execute: fixture.driver.execute,
          snapshot: model.$snapshot(),
          schemaName: fixture.namespace,
        }),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a minus before a cast and the cast of the negated number compare the same exactly where PostgreSQL gives them one value", async () => {
    const fixture = await testDatabase({
      url: databaseUrl!,
      schema: schema({ marker: { id: int } }),
    });
    // What PostgreSQL makes of it, as text (a float's -0 shows), or that it refuses it.
    const value = async (expression: string) => {
      try {
        const [row] = normalizeResult(
          await fixture.driver.execute({
            sql: `SELECT (${expression})::text AS value`,
            parameters: [],
          }),
        ).rows as { value: string }[];

        return row!.value;
      } catch {
        return "refused";
      }
    };

    try {
      for (const [number, casts] of [
        ["0.5", "::integer"],
        ["0.25", "::real::float8"],
        ["5", "::real::float8"],
        ["1.5", "::smallint"],
        ["0.1", "::real::float8"],
        ["2.5", "::float8::integer"],
        ["2147483520", "::real::integer"],
        ["0.5", "::integer::float8"],
        ["0.81743454", "::text::numeric(5,2)"],
        ["32767.5", "::smallint"],
        ["2147483647", "::real::integer"],
        ["2147483647.5", "::float8::integer"],
        ["32768", "::text::smallint"],
        ["1e-7", "::integer::float8"],
        ["0.5", "::real::integer::float8"],
        ["0.04", "::numeric(2,1)::float8"],
        ["0", "::real::float8"],
      ]) {
        const minus = `-${number}${casts}`;
        const negated = `(-${number})${casts}`;

        expect([
          minus,
          expressionKey(`"f" > ${minus}`) === expressionKey(`"f" > ${negated}`),
        ]).toEqual([minus, (await value(minus)) === (await value(negated))]);
      }
    } finally {
      await fixture.close();
    }
  });

  test("a default and an index predicate saved by 3.5.0 ending in a -- comment have no drift", async () => {
    const model = schema({
      items: table({
        id: int.auto,
        n: int.default(sql`1 -- one`).nullable,
        m: int.nullable,
      }).indexes((t) => ({
        m: index(t.m).where(sql<boolean>`${t.m} > 0 -- positive`),
      })),
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });
    const current = migrationSnapshot(model.$snapshot());
    // 3.5.0 saved them without the line break after the comment.
    const saved = (text: string) =>
      parseMigrationSnapshot(
        JSON.parse(
          JSON.stringify(current)
            .replaceAll("\\n", "")
            .replace("1 -- one", text),
        ) as typeof current,
      );
    const drift = (snapshot: typeof current) =>
      detectDrift({
        execute: fixture.driver.execute,
        snapshot,
        schemaName: fixture.namespace,
      });

    try {
      expect(await drift(current)).toEqual([]);
      expect(await drift(saved("1 -- one"))).toEqual([]);
      // Another value is still drift.
      expect(await drift(saved("2 -- two"))).toEqual([
        {
          kind: "default-mismatch",
          table: "items",
          column: "n",
          expected: "2 -- two",
          actual: "1",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("spellings PostgreSQL stores in its own form have no drift after migrate", async () => {
    const model = schema({
      items: table({ id: int.auto, name: text, amount: numeric(6) }).indexes(
        (t) => ({
          // Stored as the column with a collation, not as an expression.
          byNameC: index(sql<string>`(${t.name} COLLATE "C")`),
          // The type's default operator class, written out.
          byNameText: index(operatorClass(t.name, "text_ops")),
        }),
      ),
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });

    try {
      // numeric(6) is stored as numeric(6,0).
      expect(
        await detectDrift({
          execute: fixture.driver.execute,
          snapshot: model.$snapshot(),
          schemaName: fixture.namespace,
        }),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("DEFAULT CURRENT_TIMESTAMP is .now, and another default is still drift", async () => {
    const model = schema({
      events: { id: int.auto, at: timestamptz.now, later: timestamptz.now },
    });
    const fixture = await testDatabase({ url: databaseUrl!, schema: model });
    const run = (statement: string) =>
      fixture.driver.execute({ sql: statement, parameters: [] });

    try {
      await run(
        "ALTER TABLE events ALTER COLUMN at SET DEFAULT CURRENT_TIMESTAMP",
      );
      await run(
        "ALTER TABLE events ALTER COLUMN later SET DEFAULT clock_timestamp()",
      );
      expect(
        await detectDrift({
          execute: fixture.driver.execute,
          snapshot: model.$snapshot(),
          schemaName: fixture.namespace,
        }),
      ).toEqual([
        {
          kind: "default-mismatch",
          table: "events",
          column: "later",
          expected: "now()",
          actual: "clock_timestamp()",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("expressions of a partitioned table, an inheritance parent and a partition are compared", async () => {
    // One declaration for every table: a default, a CHECK, an index and an
    // expression index, which are all compared through PostgreSQL's own text.
    const declared = () =>
      table({ id: int, at: int, v: text.nullable.default("a") })
        .primaryKey((entry) => [entry.id, entry.at])
        .indexes((entry) => ({
          v: index(entry.v),
          lower: index(sql<string>`lower(${entry.v})`),
        }))
        .checks((entry) => ({ v: entry.v.isNot("x") }));
    const model = schema({
      marker: { id: int },
      // Two partitions: PostgreSQL plans a read of the table as an Append.
      events: declared(),
      // No partition at all, and one.
      empty: declared(),
      single: declared(),
      // A parent of two INHERITS children, and a partition declared by itself.
      parent: declared(),
      part: declared(),
    });
    const fixture = await testDatabase({
      url: databaseUrl!,
      schema: schema({ marker: { id: int } }),
    });
    const run = (statement: string) =>
      fixture.driver.execute({ sql: statement, parameters: [] });
    const create = (name: string, suffix = "") => [
      `CREATE TABLE ${name} (id integer NOT NULL, at integer NOT NULL, v text DEFAULT 'a',
        CONSTRAINT ${name}_pkey PRIMARY KEY (id, at), CONSTRAINT ${name}_v_check CHECK (v <> 'x')) ${suffix}`,
      `CREATE INDEX ${name}_v_idx ON ${name} (v)`,
      `CREATE INDEX ${name}_lower_idx ON ${name} (lower(v))`,
    ];
    const drift = () =>
      detectDrift({
        execute: fixture.driver.execute,
        snapshot: model.$snapshot(),
        schemaName: fixture.namespace,
        ignoreTables: [
          "events_low",
          "events_high",
          "single_low",
          "child_a",
          "child_b",
          "whole",
        ],
      });

    try {
      for (const statement of [
        ...create("events", "PARTITION BY RANGE (at)"),
        `CREATE TABLE events_low PARTITION OF events FOR VALUES FROM (0) TO (100)`,
        `CREATE TABLE events_high PARTITION OF events FOR VALUES FROM (100) TO (200)`,
        ...create("empty", "PARTITION BY RANGE (at)"),
        ...create("single", "PARTITION BY RANGE (at)"),
        `CREATE TABLE single_low PARTITION OF single FOR VALUES FROM (0) TO (100)`,
        ...create("parent"),
        `CREATE TABLE child_a () INHERITS (parent)`,
        `CREATE TABLE child_b (extra integer) INHERITS (parent)`,
        `CREATE TABLE whole (id integer NOT NULL, at integer NOT NULL, v text DEFAULT 'a') PARTITION BY RANGE (at)`,
        `CREATE TABLE part PARTITION OF whole FOR VALUES FROM (0) TO (100)`,
        `ALTER TABLE part ADD CONSTRAINT part_pkey PRIMARY KEY (id, at), ADD CONSTRAINT part_v_check CHECK (v <> 'x')`,
        `CREATE INDEX part_v_idx ON part (v)`,
        `CREATE INDEX part_lower_idx ON part (lower(v))`,
      ]) {
        await run(statement);
      }

      expect(await drift()).toEqual([]);

      // A real difference on the table with two partitions is still found.
      await run(
        `ALTER TABLE events DROP CONSTRAINT events_v_check, ADD CONSTRAINT events_v_check CHECK (v <> 'y')`,
      );
      await run(`DROP INDEX events_lower_idx`);
      await run(`CREATE INDEX events_lower_idx ON events (upper(v))`);
      await run(`ALTER TABLE events ALTER COLUMN v SET DEFAULT 'b'`);

      expect(
        (await drift()).map(({ kind, table: name, column, expected }) => ({
          kind,
          table: name,
          ...(column === undefined ? {} : { column }),
          expected,
        })),
      ).toEqual([
        {
          kind: "default-mismatch",
          table: "events",
          column: "v",
          expected: "E'a'",
        },
        {
          kind: "constraint-mismatch",
          table: "events",
          expected: "events_v_check",
        },
        {
          kind: "index-mismatch",
          table: "events",
          expected:
            'CREATE INDEX "events_lower_idx" ON "events" USING btree ((lower("v")))',
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
