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
} from "../../../packages/runtime/src";
import { normalizeResult } from "../../../packages/runtime/src/entries/internal";
import { detectDrift } from "../../../packages/kit/src";
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
              sql<boolean>([condition] as unknown as TemplateStringsArray),
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
});
