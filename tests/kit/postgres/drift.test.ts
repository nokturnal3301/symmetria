import { describe, expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  bool,
  timestamptz,
  varchar,
  oneOf,
  index,
  sql,
} from "../../../packages/runtime/src";
import { detectDrift } from "../../../packages/kit/src";
import { testDatabase } from "../../../packages/kit/src/testing";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL drift definitions", () => {
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
});
