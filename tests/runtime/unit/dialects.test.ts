import { expect, test } from "bun:test";
import { schema, table, int, text } from "../../../packages/runtime/src";
import type { Driver } from "../../../packages/runtime/src/driver";
import {
  postgresDialect,
  sqliteDialect,
  registerDialect,
  type DialectStrategy,
} from "../../../packages/runtime/src/dialect";
import { resolveDialect } from "../../../packages/runtime/src/query/dialects/registry";

const users = table({ id: int.auto, name: text, tags: text.array });

const withDialect = (dialect: DialectStrategy | string) =>
  schema(
    { users },
    {
      driver: { dialect, execute: async () => [], close: async () => {} },
    },
  );

test("a custom dialect derived from PostgreSQL changes only what it overrides", () => {
  const numbered: DialectStrategy = {
    ...postgresDialect,
    name: "numbered",
    capabilities: { ...postgresDialect.capabilities, rowLocks: false },
    placeholder: (position) => `:p${position}`,
  };
  const driver: Driver = {
    execute: async () => [],
    close: async () => {},
    dialect: numbered,
  };
  const database = schema({ users }, { driver });
  const compiled = database
    .users((user) => ({
      name: user.name,
      $where: user.id.is(7),
      $limit: 1,
    }))
    .toSQL();

  expect(compiled.sql).toBe(
    'SELECT "users"."name" AS "name"\nFROM "users" AS "users"\nWHERE "users"."id" = :p1\nLIMIT 1',
  );
  expect(compiled.parameters).toEqual([7]);
});

test("registering a different strategy under a taken name is rejected", () => {
  expect(() => registerDialect(postgresDialect)).not.toThrow();
  expect(() => registerDialect({ ...sqliteDialect, name: "postgres" })).toThrow(
    /already registered/,
  );
  expect(() => registerDialect({ ...sqliteDialect, name: "" })).toThrow(
    /nonempty name/,
  );
});

test("an unregistered dialect name fails before compiling", () => {
  const database = schema(
    { users },
    {
      driver: {
        execute: async () => [],
        close: async () => {},
        dialect: "mystery",
      },
    },
  );

  expect(() => database.users((user) => ({ id: user.id })).toSQL()).toThrow(
    /unknown dialect "mystery"/,
  );
});

test("built-in capabilities describe the dialects", () => {
  expect(postgresDialect.capabilities.lateralJoins).toBe(true);
  expect(sqliteDialect.capabilities.lateralJoins).toBe(false);
  expect(sqliteDialect.capabilities.rootPagination).toBe(false);
  expect(sqliteDialect.placeholder(3)).toBe("?3");
  expect(postgresDialect.placeholder(3)).toBe("$3");
  expect(sqliteDialect.limitOffset(undefined, "5")).toEqual([
    "LIMIT -1",
    "OFFSET 5",
  ]);
  expect(() => sqliteDialect.explain("SELECT 1", true)).toThrow(
    /PostgreSQL only/,
  );
});

test("registration snapshots strategy methods, capabilities and text casts", () => {
  const strategy = {
    ...postgresDialect,
    name: "immutable-registration",
    capabilities: { ...postgresDialect.capabilities },
    textCast: { ...postgresDialect.textCast },
  };
  const database = withDialect(strategy);

  const build = () =>
    database.users((user) => ({
      id: user.id,
      $where: user.id.is(7),
      $forUpdate: true,
    }));

  const query = build();
  const before = query.toSQL();

  strategy.placeholder = (position) => `:p${position}`;
  strategy.capabilities.rowLocks = false;
  strategy.textCast.suffix = "BROKEN";
  strategy.name = "renamed-after-registration";

  expect(query.toSQL()).toEqual(before);
  expect(build().toSQL()).toEqual(before);
  expect(
    withDialect(strategy)
      .users((user) => ({
        id: user.id,
        $where: user.id.is(7),
        $forUpdate: true,
      }))
      .toSQL(),
  ).toEqual(before);
  expect(
    withDialect("immutable-registration")
      .users((user) => ({
        id: user.id,
        $where: user.id.is(7),
        $forUpdate: true,
      }))
      .toSQL(),
  ).toEqual(before);
  const registered = resolveDialect("immutable-registration");
  expect(registered.textCast.suffix).toBe("::text");
  expect(Object.isFrozen(registered)).toBe(true);
  expect(Object.isFrozen(registered.capabilities)).toBe(true);
  expect(Object.isFrozen(registered.textCast)).toBe(true);
  expect(() => registerDialect(strategy)).not.toThrow();
  expect(() =>
    registerDialect({ ...postgresDialect, name: "immutable-registration" }),
  ).toThrow(/already registered/);

  for (const builtin of [postgresDialect, sqliteDialect]) {
    expect(Object.isFrozen(builtin)).toBe(true);
    expect(Object.isFrozen(builtin.capabilities)).toBe(true);
    expect(Object.isFrozen(builtin.textCast)).toBe(true);
  }
});

test("disabled capabilities reject inherited PostgreSQL syntax", () => {
  const database = withDialect({
    ...postgresDialect,
    name: "disabled-capabilities",
    capabilities: {
      ...postgresDialect.capabilities,
      rowLocks: false,
      containmentOperators: false,
      fullTextSearch: false,
    },
  });

  for (const locking of [{ $forUpdate: true }, { $forShare: true }]) {
    expect(() =>
      database.users((user) => ({ id: user.id, ...locking })).toSQL(),
    ).toThrow(/row locks.*disabled-capabilities/);
  }

  expect(() =>
    database
      .users((user) => ({ id: user.id, $where: user.tags.contains(["sql"]) }))
      .toSQL(),
  ).toThrow(/containment.*disabled-capabilities/);
  expect(() =>
    database
      .users((user) => ({ id: user.id, $where: user.tags.overlaps(["sql"]) }))
      .toSQL(),
  ).toThrow(/containment.*disabled-capabilities/);
  expect(() =>
    database
      .users((user) => ({ id: user.id, $where: user.name.search("sql") }))
      .toSQL(),
  ).toThrow(/search.*disabled-capabilities/);
  expect(() =>
    database.users((user) => ({ rank: user.name.searchRank("sql") })).toSQL(),
  ).toThrow(/searchRank.*disabled-capabilities/);
  // Membership has its own implementation, including SQLite's JSON emulation.
  expect(
    database
      .users((user) => ({ id: user.id, $where: user.tags.has("sql") }))
      .toSQL().sql,
  ).toContain("ANY");
});

test("a dialect cannot silently drop a requested row lock", () => {
  const database = withDialect({
    ...postgresDialect,
    name: "missing-lock-renderer",
    rowLock: (() => undefined) as unknown as DialectStrategy["rowLock"],
  });
  expect(() =>
    database.users((user) => ({ id: user.id, $forUpdate: true })).toSQL(),
  ).toThrow(/row locks.*missing-lock-renderer/);
});
