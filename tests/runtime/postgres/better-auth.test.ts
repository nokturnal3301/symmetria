import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { schema } from "../../../packages/runtime/src";
import {
  authSchemaSource,
  symmetriaAdapter,
} from "../../../packages/runtime/src/entries/better-auth";
import { testDatabase } from "../../../packages/kit/src/testing";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
const options = {
  secret: "symmetria-better-auth-test-secret-32-chars",
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
} as const;
const source = authSchemaSource(getAuthTables(options) as never);
// The generated module is what an application would keep; the tests run on it.
const generated = join(import.meta.dir, ".better-auth-schema.generated.ts");

await Bun.write(
  generated,
  source.replace('"symmetria"', '"../../../packages/runtime/src"'),
);

const { authTables } = (await import(generated)) as {
  authTables: Parameters<typeof schema>[0];
};
const model = schema({ ...authTables });

test("auth generate writes the tables better-auth needs", () => {
  expect(source).toContain(
    'import { bool, one, table, text, timestamptz } from "symmetria";',
  );
  expect(source).toContain("export const user = table({\n  id: text,");
  expect(source).toContain("  email: text.unique,");
  expect(source).toContain("  emailVerified: bool.default(false),");
  expect(source).toContain("  image: text.nullable,");
  expect(source).toContain("  user: one(user).cascade,");
  expect(source).toContain("  token: text.unique,");
  expect(source).toContain(
    "export const authTables = { user, session, account, verification };",
  );
  expect(
    model
      .$snapshot()
      .tables.find((table) => table.name === "session")!
      .columns.find((column) => column.name === "userId"),
  ).toMatchObject({
    sqlName: "user_id",
    notNull: true,
    references: { table: "user", column: "id", onDelete: "cascade" },
  });
});

test("a JSON field of a plugin becomes a jsonb() column the module can load", async () => {
  const tables = getAuthTables(options) as Record<
    string,
    { fields: Record<string, unknown> }
  >;
  const withPreferences = {
    ...tables,
    user: {
      ...tables.user!,
      fields: {
        ...tables.user!.fields,
        preferences: { type: "json", required: false },
      },
    },
  };
  const written = authSchemaSource(withPreferences as never);

  expect(written).toContain("  preferences: jsonb().nullable,");

  const file = join(import.meta.dir, ".better-auth-json.generated.ts");

  try {
    await Bun.write(
      file,
      written.replace('"symmetria"', '"../../../packages/runtime/src"'),
    );
    const { authTables: loaded } = (await import(file)) as {
      authTables: Parameters<typeof schema>[0];
    };

    expect(() => schema({ ...loaded })).not.toThrow();
  } finally {
    await rm(file, { force: true });
  }
});

describe.skipIf(!databaseUrl)("better-auth on a Symmetria database", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let auth: any;
  let adapter: any;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_better_auth",
      max: 4,
    });
    auth = betterAuth({
      ...options,
      database: symmetriaAdapter(isolated.database),
    });
    adapter = (await auth.$context).adapter;
  });

  afterAll(async () => {
    await isolated?.close();
    await rm(generated, { force: true });
  });

  test("sign up, sign in, read the session, sign out", async () => {
    const created = await auth.api.signUpEmail({
      body: {
        name: "Ada",
        email: "ada@example.test",
        password: "correct horse",
      },
    });

    expect(created.user).toMatchObject({
      email: "ada@example.test",
      emailVerified: false,
    });
    expect(created.user.createdAt).toBeInstanceOf(Date);

    await expect(
      auth.api.signUpEmail({
        body: {
          name: "Ada",
          email: "ada@example.test",
          password: "correct horse",
        },
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.signInEmail({
        body: { email: "ada@example.test", password: "wrong password" },
      }),
    ).rejects.toThrow();

    const signedIn = await auth.api.signInEmail({
      body: { email: "ada@example.test", password: "correct horse" },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")!;
    const headers = new Headers({ cookie: cookie.split(";")[0]! });
    const session = await auth.api.getSession({ headers });

    expect(session?.user.email).toBe("ada@example.test");
    expect(session?.session.expiresAt).toBeInstanceOf(Date);
    await auth.api.updateUser({ headers, body: { name: "Ada Lovelace" } });
    expect((await auth.api.getSession({ headers }))?.user.name).toBe(
      "Ada Lovelace",
    );
    await auth.api.signOut({ headers });
    expect(await auth.api.getSession({ headers })).toBeNull();
  });

  test("every operator better-auth filters with", async () => {
    for (const [position, name] of ["Bob", "Carol", "dave"].entries()) {
      await adapter.create({
        model: "user",
        data: {
          name,
          email: `${name.toLowerCase()}@example.test`,
          emailVerified: position === 0,
        },
      });
    }

    const names = async (where: unknown[], extra: object = {}) =>
      (
        await adapter.findMany({
          model: "user",
          where,
          sortBy: { field: "name", direction: "asc" },
          ...extra,
        })
      ).map((user: { name: string }) => user.name);

    expect(await names([{ field: "name", value: "Bob" }])).toEqual(["Bob"]);
    expect(
      await names([{ field: "name", value: "Bob", operator: "ne" }]),
    ).toEqual(["Ada Lovelace", "Carol", "dave"]);
    expect(
      await names([{ field: "name", value: ["Bob", "Carol"], operator: "in" }]),
    ).toEqual(["Bob", "Carol"]);
    expect(
      await names([
        { field: "name", value: ["Bob", "Carol"], operator: "not_in" },
      ]),
    ).toEqual(["Ada Lovelace", "dave"]);
    expect(
      await names([{ field: "name", value: "a", operator: "contains" }]),
    ).toEqual(["Ada Lovelace", "Carol", "dave"]);
    expect(
      await names([{ field: "name", value: "da", operator: "starts_with" }]),
    ).toEqual(["dave"]);
    expect(
      await names([
        {
          field: "name",
          value: "DA",
          operator: "starts_with",
          mode: "insensitive",
        },
      ]),
    ).toEqual(["dave"]);
    expect(
      await names([{ field: "name", value: "ol", operator: "ends_with" }]),
    ).toEqual(["Carol"]);
    expect(
      await names([{ field: "name", value: "BOB", mode: "insensitive" }]),
    ).toEqual(["Bob"]);
    // A list compared without case, as a single value is.
    expect(
      await names([
        {
          field: "name",
          value: ["BOB", "DAVE"],
          operator: "in",
          mode: "insensitive",
        },
      ]),
    ).toEqual(["Bob", "dave"]);
    expect(
      await names([
        {
          field: "name",
          value: ["BOB", "DAVE"],
          operator: "not_in",
          mode: "insensitive",
        },
      ]),
    ).toEqual(["Ada Lovelace", "Carol"]);
    expect(
      await names([
        { field: "name", value: [], operator: "in", mode: "insensitive" },
      ]),
    ).toEqual([]);
    // A pattern character in the value is matched as itself.
    expect(
      await names([{ field: "name", value: "%", operator: "contains" }]),
    ).toEqual([]);
    expect(
      await names([
        { field: "emailVerified", value: false },
        { field: "name", value: "Bob", connector: "OR" },
        { field: "name", value: "Carol", connector: "OR" },
      ]),
    ).toEqual(["Carol"]);
    expect(await names([], { limit: 2, offset: 1 })).toEqual(["Bob", "Carol"]);
    expect(
      await names([{ field: "createdAt", value: new Date(0), operator: "gt" }]),
    ).toHaveLength(4);
    expect(
      await names([
        { field: "createdAt", value: new Date(0), operator: "lte" },
      ]),
    ).toEqual([]);
    expect(await adapter.count({ model: "user" })).toBe(4);
    expect(
      await adapter.count({
        model: "user",
        where: [{ field: "emailVerified", value: true }],
      }),
    ).toBe(1);
  });

  test("updates, deletes and single-use rows", async () => {
    const bob = await adapter.findOne({
      model: "user",
      where: [{ field: "name", value: "Bob" }],
    });

    expect(
      await adapter.update({
        model: "user",
        where: [{ field: "id", value: bob.id }],
        update: { image: "bob.png" },
      }),
    ).toMatchObject({ id: bob.id, image: "bob.png" });
    expect(
      await adapter.update({
        model: "user",
        where: [{ field: "id", value: "nobody" }],
        update: { image: "x" },
      }),
    ).toBeNull();
    expect(
      await adapter.updateMany({
        model: "user",
        where: [{ field: "emailVerified", value: false }],
        update: { emailVerified: true },
      }),
    ).toBe(3);

    for (const value of ["one", "two"]) {
      await adapter.create({
        model: "verification",
        data: {
          identifier: "reset",
          value,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
    }

    // Two rows match; each call takes exactly one of them.
    const taken = [
      await adapter.consumeOne({
        model: "verification",
        where: [{ field: "identifier", value: "reset" }],
      }),
      await adapter.consumeOne({
        model: "verification",
        where: [{ field: "identifier", value: "reset" }],
      }),
      await adapter.consumeOne({
        model: "verification",
        where: [{ field: "identifier", value: "reset" }],
      }),
    ];

    expect(taken.map((row) => row?.value).sort()).toEqual([
      "one",
      "two",
      undefined,
    ]);
    await adapter.delete({
      model: "user",
      where: [{ field: "id", value: bob.id }],
    });
    expect(
      await adapter.deleteMany({
        model: "user",
        where: [{ field: "name", value: ["Carol", "dave"], operator: "in" }],
      }),
    ).toBe(2);
    expect(await adapter.count({ model: "user" })).toBe(1);
  });

  test("a failed transaction leaves nothing behind", async () => {
    await expect(
      adapter.transaction(async (transaction: typeof adapter) => {
        await transaction.create({
          model: "user",
          data: { name: "Ghost", email: "ghost@example.test" },
        });

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await adapter.findOne({
        model: "user",
        where: [{ field: "email", value: "ghost@example.test" }],
      }),
    ).toBeNull();
  });

  test("a table the schema lacks is named in the error", async () => {
    await expect(adapter.findMany({ model: "passkey" })).rejects.toThrow();
  });
});

test("numeric ids are refused when better-auth starts", async () => {
  const auth = betterAuth({
    ...options,
    advanced: { database: { generateId: "serial" } },
    database: symmetriaAdapter({}),
  });

  await expect(auth.$context).rejects.toThrow("does not support numeric ids");
});

describe.skipIf(!databaseUrl)(
  "better-auth with its own field names and plural tables",
  () => {
    // What `npx auth generate` writes for this configuration, through the adapter.
    const renamed = {
      ...options,
      user: { fields: { name: "full_name", emailVerified: "email_verified" } },
      session: { fields: { userId: "owner", token: "session_token" } },
    } as const;
    const file = join(import.meta.dir, ".better-auth-renamed.generated.ts");
    let isolated: Awaited<ReturnType<typeof testDatabase>> | undefined;
    let written = "";
    let auth: any;

    beforeAll(async () => {
      const probe: any = betterAuth({
        ...renamed,
        database: symmetriaAdapter({}, { usePlural: true }),
      });
      const context = await probe.$context;

      written = (await context.adapter.createSchema(context.options)).code;
      // Application columns of its own, as one adds to the generated module;
      // one is keyed like better-auth's stored name of a field (`full_name`).
      await Bun.write(
        file,
        written
          .replace('"symmetria"', '"../../../packages/runtime/src"')
          .replace(
            "export const users = table({\n  id: text,",
            'export const users = table({\n  id: text,\n  plan: text.default("free"),\n  full_name: text.named("app_full_name").nullable,',
          ),
      );

      const { authTables: loaded } = (await import(file)) as {
        authTables: Parameters<typeof schema>[0];
      };

      isolated = await testDatabase({
        url: databaseUrl!,
        schema: schema({ ...loaded }),
        prefix: "symmetria_better_auth_renamed",
        max: 4,
      });
      auth = betterAuth({
        ...renamed,
        database: symmetriaAdapter(isolated.database as object, {
          usePlural: true,
        }),
      });
    });

    afterAll(async () => {
      await isolated?.close();
      await rm(file, { force: true });
    });

    test("the module keys plural tables and keeps the SQL names", () => {
      expect(written).toContain("export const users = table({");
      expect(written).toContain('  name: text.named("full_name"),');
      expect(written).toContain('  user: one(users).cascade.column("owner"),');
      expect(written).toContain(
        "export const authTables = { users, sessions, accounts, verifications };",
      );
    });

    test("sign up, sign in and read the session", async () => {
      const created = await auth.api.signUpEmail({
        body: {
          name: "Ada",
          email: "ada@example.test",
          password: "correct-horse-battery",
        },
      });

      expect(created.user).toMatchObject({ name: "Ada", emailVerified: false });

      const signedIn = await auth.api.signInEmail({
        body: { email: "ada@example.test", password: "correct-horse-battery" },
        asResponse: true,
      });
      const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
      const session = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });

      expect(session.user).toMatchObject({ name: "Ada", emailVerified: false });

      const rows = (await isolated!.driver.execute({
        sql: "SELECT u.full_name, u.email_verified, u.plan, s.owner = u.id AS owned FROM users u JOIN sessions s ON s.owner = u.id",
        parameters: [],
      })) as { rows: Record<string, unknown>[] };

      expect(rows.rows[0]).toMatchObject({
        full_name: "Ada",
        email_verified: false,
        plan: "free",
        owned: true,
      });
    });
  },
);
