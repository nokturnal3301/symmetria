import { expect } from "bun:test";
import { test, isolatedDriver } from "../../support/isolated-driver";
import {
  createDatabase,
  schema,
  int,
  text,
} from "../../../packages/runtime/src";

test("createDatabase reuses declarations and scopes across independent drivers", async () => {
  let declarations = 0;
  const unscoped = schema({
    records: { id: int, tenantId: int, name: text },
    notes: ({ records }) => {
      declarations++;

      return { id: int, record: records, body: text };
    },
  });
  const model = unscoped.$scope({
    records: (record) => record.tenantId.is(1),
  });
  const first = isolatedDriver();
  const second = isolatedDriver();
  first.createTables(model);
  second.createTables(model);
  const database = createDatabase({ schema: model, driver: first });
  const other = createDatabase({ schema: model, driver: second });

  try {
    // The scoped database writes rows inside its scope only.
    await expect(
      database.records.insert({ id: 2, tenantId: 2, name: "hidden" }).execute(),
    ).rejects.toMatchObject({ code: "SYMMETRIA_OUT_OF_SCOPE" });
    await createDatabase({ schema: unscoped, driver: first }).records.insert({
      id: 2,
      tenantId: 2,
      name: "hidden",
    });
    await database.records.insert({ id: 1, tenantId: 1, name: "first" });
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
