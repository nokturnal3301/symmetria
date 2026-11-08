import { expect, test } from "bun:test";
import {
  schema,
  table,
  int,
  text,
  jsonb,
  oneOf,
  index,
  sql,
} from "../../../packages/runtime/src";
import { createSchemaSQL, diffSchemas } from "../../../packages/kit/src";
import {
  renameExpressionIdentifiers,
  expressionUsesLiteral,
} from "../../../packages/kit/src/migrations/expression-tokens";

test("renames never rewrite quoted identifier text inside SQL literals or comments", () => {
  const before = schema({
    rows: table({ id: int, old: text }).checks((r) => ({
      matches: r.old.is('"old"'),
    })),
  });
  const after = schema({
    rows: table({ id: int, newer: text }).checks((r) => ({
      matches: r.newer.is('"newer"'),
    })),
  });
  const plan = diffSchemas(before.$snapshot(), after.$snapshot(), {
    renames: { columns: { rows: { old: "newer" } } },
  });
  expect(plan.up.join("\n")).toContain('DROP CONSTRAINT "rows_matches_check"');
  expect(plan.up.join("\n")).toContain('ADD CONSTRAINT "rows_matches_check"');
  const unchangedLiteral = schema({
    rows: table({ id: int, newer: text }).checks((r) => ({
      matches: r.newer.is('"old"'),
    })),
  });
  expect(
    diffSchemas(before.$snapshot(), unchangedLiteral.$snapshot(), {
      renames: { columns: { rows: { old: "newer" } } },
    }).up,
  ).toEqual(['ALTER TABLE "rows" RENAME COLUMN "old" TO "newer"']);
  const names = new Map([['"old"', '"newer"']]);

  for (const literal of [
    `'"old"'`,
    `E'\\\\"old"'`,
    `$$"old"$$`,
    `$tag$"old"$tag$`,
    `/* "old" /* nested */ */`,
    `-- "old"\n`,
  ]) {
    expect(renameExpressionIdentifiers(`"old" || ${literal}`, names)).toBe(
      `"newer" || ${literal}`,
    );
  }
});

test("new enum labels used by SQL defaults or indexes force transactional replacement", () => {
  const before = schema({ jobs: { id: int, state: oneOf("ready", "done") } });
  const variants = [
    schema({
      jobs: {
        id: int,
        state: oneOf("ready", "done", "error").default(sql`'error'`),
      },
    }),
    schema({
      jobs: table({ id: int, state: oneOf("ready", "done", "error") }).indexes(
        (r) => ({ errors: index(r.id).where(r.state.is.error) }),
      ),
    }),
  ];

  for (const after of variants) {
    const plan = diffSchemas(before.$snapshot(), after.$snapshot());
    expect(plan.up.some((statement) => statement.includes("ADD VALUE"))).toBe(
      false,
    );
    expect(
      plan.up.some((statement) =>
        statement.startsWith('ALTER TYPE "jobs_state_enum" RENAME'),
      ),
    ).toBe(true);
  }

  for (const literal of [
    "'error'",
    "E'error'",
    "$$error$$",
    "$tag$error$tag$",
  ]) {
    expect(expressionUsesLiteral(literal, "error")).toBe(true);
  }
});

test("nullable JSON value defaults represent SQL NULL consistently with writes", () => {
  const model = schema({
    rows: { id: int, doc: jsonb<unknown>().nullable.default(null) },
  });
  expect(createSchemaSQL(model.$snapshot())[0]!.sql).toContain(
    '"doc" jsonb DEFAULT NULL',
  );
});
