import { expect, test } from "bun:test";
import {
  createDatabase,
  schema,
  int,
  text,
} from "../../../packages/runtime/src";
import { sqlite } from "../../../packages/runtime/src/driver";

test("createDatabase reuses declarations and scopes across independent drivers", async () => {
  let declarations = 0;
  const model = schema({
    records: { id: int, tenantId: int, name: text },
    notes: ({ records }) => {
      declarations++;

      return { id: int, record: records, body: text };
    },
  }).$scope({ records: (record) => record.tenantId.is(1) });
  const first = sqlite();
  const second = sqlite();
  first.createTables(model);
  second.createTables(model);
  const database = createDatabase({ schema: model, driver: first });
  const other = createDatabase({ schema: model, driver: second });

  try {
    await database.records.insert([
      { id: 1, tenantId: 1, name: "first" },
      { id: 2, tenantId: 2, name: "hidden" },
    ]);
    await database.notes.insert({ id: 1, recordId: 1, body: "related" });
    await other.records.insert({ id: 1, tenantId: 1, name: "second" });

    expect(
      await database.records((record) => ({
        name: record.name,
        notes: record.notes((note) => ({ body: note.body })),
      })),
    ).toEqual([{ name: "first", notes: [{ body: "related" }] }]);
    expect(await other.records((record) => ({ name: record.name }))).toEqual([
      { name: "second" },
    ]);
    expect(declarations).toBe(1);
    expect(() => model.records.byId(1).toSQL()).not.toThrow();
  } finally {
    await database.$close();
    await other.$close();
  }
});
