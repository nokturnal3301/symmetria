import { expect, test } from "bun:test";
import { int, schema } from "../../../packages/runtime/src";
import { PREPARE_QUERY } from "../../../packages/runtime/src/query/select/prepared";

test("detached query construction methods retain their source", () => {
  const database = schema({ records: { id: int } });
  const query = database.records((record) => ({ id: record.id }));
  const { toSQL, as, cte, recursive, scalar, prepare } = query;
  const prepareQuery = query[PREPARE_QUERY];
  const expected = query.toSQL();

  expect(Object.isFrozen(query)).toBe(true);
  expect(toSQL).toBe(query.toSQL);
  expect(toSQL()).toEqual(expected);
  expect(prepare().toSQL()).toEqual(expected);
  expect(prepareQuery({}, []).toSQL({})).toEqual(expected);
  expect(as("derived")((row) => ({ id: row.id })).toSQL().sql).toContain(
    'AS "derived"',
  );
  expect(cte("selected")((row) => ({ id: row.id })).toSQL().sql).toStartWith(
    'WITH "selected"',
  );
  expect(
    recursive("walk", (self) => self((row) => ({ id: row.id })))((row) => ({
      id: row.id,
    })).toSQL().sql,
  ).toStartWith('WITH RECURSIVE "walk"');
  expect(database.records(() => ({ value: scalar() })).toSQL().sql).toContain(
    'AS "value"',
  );
  const { as: alias } = database.records;
  expect(alias("r")((row) => ({ id: row.id })).toSQL().sql).toContain(
    'FROM "records" AS "r"',
  );
});
