import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  schema,
  prepare,
  index,
  int,
  text,
  bool,
  bigint,
  jsonb,
  sql,
  IsolationLevel,
} from "../../../packages/runtime/src";
import { postgres, type Driver } from "../../../packages/runtime/src/driver";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("indexes and transactions on PostgreSQL", () => {
  const driver = postgres({
    url: databaseUrl ?? "postgres://localhost/postgres",
    max: 1,
  });
  const observerDriver = postgres({
    url: databaseUrl ?? "postgres://localhost/postgres",
    max: 1,
  });
  const namespace = `symmetria_atomic_${crypto.randomUUID().replaceAll("-", "")}`;

  const connect = (connection: Driver) =>
    schema(
      {
        accounts: {
          id: int.auto,
          owner: text,
          email: text,
          active: bool.default(true),
          balance: bigint.default(0n),
          metadata: jsonb<unknown>().nullable,
        },
        entries: ({ accounts }) => ({
          id: int.auto,
          account: accounts,
          externalId: text,
        }),
      },
      {
        driver: connection,
        indexes: ({ accounts, entries }) => ({
          activeEmail: index(accounts.email).unique.where(
            accounts.active.is(true),
          ),
          accountsByBalance: index(accounts.balance.descending).include(
            accounts.owner,
          ),
          accountsLowerOwner: index(sql<string>`lower(${accounts.owner})`),
          accountsMetadata: index(accounts.metadata).using("gin"),
          entriesExternalId: index(entries.accountId, entries.externalId)
            .unique,
        }),
      },
    );

  const model = connect(driver);
  const observer = connect(observerDriver);

  const run = (statement: string) =>
    driver.execute({ sql: statement, parameters: [] });

  const balances = () =>
    model
      .accounts((accounts) => ({
        balance: accounts.balance,
        $orderBy: accounts.id.ascending,
      }))
      .execute();

  beforeAll(async () => {
    await run(`CREATE SCHEMA "${namespace}"`);
    await run(`SET search_path TO "${namespace}"`);
    await observerDriver.execute({
      sql: `SET search_path TO "${namespace}"`,
      parameters: [],
    });
    await run(
      "CREATE TABLE accounts (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner text NOT NULL, email text NOT NULL, active boolean NOT NULL DEFAULT true, balance bigint NOT NULL DEFAULT 0, metadata jsonb)",
    );
    await run(
      "CREATE TABLE entries (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id integer NOT NULL REFERENCES accounts(id), external_id text NOT NULL)",
    );
    await model.$createIndexes().execute();
  });
  beforeEach(async () => {
    await run("TRUNCATE accounts, entries RESTART IDENTITY CASCADE");
    await model.accounts
      .insert([
        { owner: "Ada", email: "ada@example.test", balance: 100n },
        { owner: "Grace", email: "grace@example.test", balance: 50n },
      ])
      .execute();
  });
  afterAll(async () => {
    try {
      await run(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await Promise.all([model.$close(), observer.$close()]);
    }
  });

  test("PostgreSQL stores compound, covering, expression, GIN and partial unique indexes", async () => {
    const result = await driver.execute({
      sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1",
      parameters: [namespace],
    });
    const rows = Array.isArray(result) ? result : result.rows;
    expect(
      rows.find((row) => row.indexname === "accounts_by_balance")?.indexdef,
    ).toContain("INCLUDE (owner)");
    expect(
      rows.find((row) => row.indexname === "accounts_lower_owner")?.indexdef,
    ).toContain("lower(owner)");
    expect(
      rows.find((row) => row.indexname === "accounts_metadata")?.indexdef,
    ).toContain("USING gin");
    expect(
      rows.find((row) => row.indexname === "active_email")?.indexdef,
    ).toContain("WHERE (active = true)");
    await expect(
      model.accounts
        .insert({ owner: "Duplicate", email: "ada@example.test" })
        .execute(),
    ).rejects.toThrow();
    await model.accounts
      .insert({ owner: "Inactive", email: "ada@example.test", active: false })
      .execute();
    await model.entries
      .insert({ accountId: 1, externalId: "invoice" })
      .execute();
    await expect(
      model.entries.insert({ accountId: 1, externalId: "invoice" }).execute(),
    ).rejects.toThrow();
    await model.entries
      .insert({ accountId: 2, externalId: "invoice" })
      .execute();
  });

  test("CONCURRENTLY creates a real index and IF NOT EXISTS is repeatable", async () => {
    const local = schema(
      { accounts: { id: int.auto, owner: text } },
      {
        driver,
        indexes: ({ accounts }) => ({ concurrentOwner: index(accounts.owner) }),
      },
    );
    await local.$createIndexes({ concurrently: true }).execute();
    await local
      .$createIndexes({ concurrently: true, ifNotExists: true })
      .execute();
    const result = await run(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = 'concurrent_owner'::regclass",
    );
    expect(
      Array.isArray(result)
        ? result[0]?.indisvalid
        : result.rows[0]?.indisvalid,
    ).toBe(true);
    await local.$transaction(async (transaction) => {
      // @ts-expect-error concurrent indexes are unavailable in a transaction
      expect(() => transaction.$createIndexes({ concurrently: true })).toThrow(
        /inside a transaction/,
      );
    });
  });

  test("commit returns callback values and all changes become visible atomically", async () => {
    const result = await model.$transaction(async (transaction) => {
      await transaction.accounts
        .update((accounts) => ({ balance: accounts.balance.minus(25n) }))
        .where((accounts) => accounts.id.is(1))
        .execute();
      await transaction.accounts
        .update((accounts) => ({ balance: accounts.balance.plus(25n) }))
        .where((accounts) => accounts.id.is(2))
        .execute();
      expect(
        await observer
          .accounts((accounts) => ({
            balance: accounts.balance,
            $orderBy: accounts.id.ascending,
          }))
          .execute(),
      ).toEqual([{ balance: 100n }, { balance: 50n }]);

      return ["transferred", 25n] as const;
    });
    expect(result).toEqual(["transferred", 25n]);
    expect(await balances()).toEqual([{ balance: 75n }, { balance: 75n }]);
  });

  test("callback errors rollback changes and preserve the original error", async () => {
    const failure = new Error("cancel transfer");
    await expect(
      model.$transaction(async (transaction) => {
        await transaction.accounts
          .update({ balance: 0n })
          .where((accounts) => accounts.id.is(1))
          .execute();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await balances()).toEqual([{ balance: 100n }, { balance: 50n }]);
  });

  test("caught SQL failures still abort the transaction rather than reporting a false commit", async () => {
    await expect(
      model.$transaction(async (transaction) => {
        await transaction.accounts
          .update({ balance: 0n })
          .where((accounts) => accounts.id.is(1))
          .execute();

        try {
          await transaction.accounts
            .insert({ owner: "Duplicate", email: "ada@example.test" })
            .execute();
        } catch {
          /* Intentionally caught: PostgreSQL has still aborted this transaction. */
        }

        return "must not commit";
      }),
    ).rejects.toThrow();
    expect(await balances()).toEqual([{ balance: 100n }, { balance: 50n }]);
  });

  test("nested savepoints rollback independently and permit recovery from constraint errors", async () => {
    await model.$transaction(async (transaction) => {
      await transaction.accounts
        .update({ balance: 90n })
        .where((accounts) => accounts.id.is(1))
        .execute();
      await expect(
        transaction.$transaction(async (savepoint) => {
          await savepoint.accounts
            .update({ balance: 0n })
            .where((accounts) => accounts.id.is(2))
            .execute();
          await savepoint.accounts
            .insert({ owner: "Duplicate", email: "ada@example.test" })
            .execute();
        }),
      ).rejects.toThrow();
      await transaction.$transaction(async (savepoint) => {
        await savepoint.$transaction(async (nested) => {
          await nested.accounts
            .update({ balance: 60n })
            .where((accounts) => accounts.id.is(2))
            .execute();
        });
      });
    });
    expect(await balances()).toEqual([{ balance: 90n }, { balance: 60n }]);
  });

  test("outer rollback also reverts changes released by successful savepoints", async () => {
    await expect(
      model.$transaction(async (transaction) => {
        await transaction.$transaction(async (savepoint) => {
          await savepoint.accounts
            .update({ balance: 0n })
            .where((accounts) => accounts.id.is(1))
            .execute();
        });
        throw new Error("rollback outer");
      }),
    ).rejects.toThrow("rollback outer");
    expect(await balances()).toEqual([{ balance: 100n }, { balance: 50n }]);
  });

  test("transaction and savepoint query handles cannot be executed after their callback", async () => {
    // Queries are thenable: returning one directly would execute it inside the callback.
    const { query } = await model.$transaction(async (transaction) => ({
      query: transaction.accounts((accounts) => ({ id: accounts.id })),
    }));
    await expect(query.execute()).rejects.toThrow(/context is closed/);
    expect(
      await model.$transaction(async (transaction) =>
        transaction.accounts((accounts) => ({ id: accounts.id })),
      ),
    ).toHaveLength(2);
    await model.$transaction(async (transaction) => {
      const { nested } = await transaction.$transaction(async (savepoint) => ({
        nested: savepoint.accounts((accounts) => ({ id: accounts.id })),
      }));
      await expect(nested.execute()).rejects.toThrow(/context is closed/);
      expect(
        await transaction
          .accounts((accounts) => ({ id: accounts.id }))
          .execute(),
      ).toHaveLength(2);
    });
  });

  test("prepared reads bind independently and mutations preserve JSON and bigint codecs", async () => {
    const lookup = prepare(
      { id: int, pattern: text, size: int },
      (parameters) =>
        model.accounts((accounts) => ({
          id: accounts.id,
          owner: accounts.owner,
          balance: accounts.balance,
          metadata: accounts.metadata,
          $where: [
            accounts.id.is(parameters.id),
            accounts.owner.ilike(parameters.pattern),
          ],
          $limit: parameters.size,
        })),
    );
    const results = await Promise.all([
      lookup.execute({ id: 1, pattern: "a%", size: 1 }),
      lookup.execute({ id: 2, pattern: "g%", size: 1 }),
    ]);
    expect(results).toEqual([
      [{ id: 1, owner: "Ada", balance: 100n, metadata: null }],
      [{ id: 2, owner: "Grace", balance: 50n, metadata: null }],
    ]);
    const update = prepare(
      { id: int, amount: bigint, metadata: jsonb<unknown>().nullable },
      (parameters) =>
        model.accounts
          .update((accounts) => ({
            balance: accounts.balance.plus(parameters.amount),
            metadata: parameters.metadata,
          }))
          .where((accounts) => accounts.id.is(parameters.id))
          .returning((accounts) => [accounts.balance, accounts.metadata]),
    );
    expect(
      await update.execute({
        id: 1,
        amount: 9007199254740993n,
        metadata: { tags: ["prepared"] },
      }),
    ).toEqual([
      { balance: 9007199254741093n, metadata: { tags: ["prepared"] } },
    ]);
    expect(await update.execute({ id: 2, amount: 1n, metadata: null })).toEqual(
      [{ balance: 51n, metadata: null }],
    );
    expect(
      await run(
        "SELECT jsonb_typeof(metadata) AS kind FROM accounts WHERE id = 1",
      ),
    ).toMatchObject({ rows: [{ kind: "object" }] });
  });

  test("prepared queries retain transaction and savepoint lifetime checks", async () => {
    const escaped = await model.$transaction(async (transaction) => {
      const prepared = prepare({ id: int }, (parameters) =>
        transaction.accounts((accounts) => ({
          balance: accounts.balance,
          $where: accounts.id.is(parameters.id),
        })),
      );
      expect(await prepared.execute({ id: 1 })).toEqual([{ balance: 100n }]);
      const nested = await transaction.$transaction(async (savepoint) =>
        savepoint.accounts((accounts) => ({ id: accounts.id })).prepare(),
      );
      await expect(nested.execute()).rejects.toThrow(/context is closed/);

      return prepared;
    });
    await expect(escaped.execute({ id: 1 })).rejects.toThrow(
      /context is closed/,
    );
    await expect(
      model.$transaction(async (transaction) => {
        const write = prepare({ amount: bigint }, (parameters) =>
          transaction.accounts.update({ balance: parameters.amount }),
        );
        await write.execute({ amount: 0n });
        throw new Error("rollback prepared write");
      }),
    ).rejects.toThrow("rollback prepared write");
    expect(await balances()).toEqual([{ balance: 100n }, { balance: 50n }]);
  });

  test("isolation, read-only and deferrable options reach the server", async () => {
    const result = await model.$transaction(
      async (transaction) =>
        transaction
          .accounts((accounts) => ({
            isolation:
              sql<IsolationLevel>`current_setting('transaction_isolation')`.as(
                "isolation",
              ),
            readOnly: sql<string>`current_setting('transaction_read_only')`.as(
              "readOnly",
            ),
            deferrable:
              sql<string>`current_setting('transaction_deferrable')`.as(
                "deferrable",
              ),
          }))
          .first(),
      {
        isolationLevel: IsolationLevel.Serializable,
        readOnly: true,
        deferrable: true,
      },
    );
    expect(result).toEqual({
      isolation: "serializable",
      readOnly: "on",
      deferrable: "on",
    });
    await expect(
      model.$transaction(
        async (transaction) =>
          transaction.accounts.update({ balance: 0n }).execute(),
        { readOnly: true },
      ),
    ).rejects.toThrow();
  });

  test("FOR UPDATE excludes locked rows from a concurrent SKIP LOCKED query", async () => {
    await model.$transaction(async (transaction) => {
      await transaction
        .accounts((accounts) => ({
          id: accounts.id,
          $where: accounts.id.is(1),
          $forUpdate: true,
        }))
        .execute();
      const rows = await observer.$transaction(async (other) =>
        other
          .accounts((accounts) => ({
            id: accounts.id,
            $orderBy: accounts.id.ascending,
            $forUpdate: { skipLocked: true },
          }))
          .execute(),
      );
      expect(rows).toEqual([{ id: 2 }]);
      await expect(
        observer.$transaction(async (other) =>
          other
            .accounts((accounts) => ({
              id: accounts.id,
              $where: accounts.id.is(1),
              $forUpdate: { noWait: true },
            }))
            .execute(),
        ),
      ).rejects.toThrow();
    });
  });

  test("a repeatable-read transaction retains its snapshot across another connection's commit", async () => {
    await model.$transaction(
      async (transaction) => {
        const query = transaction.accounts((accounts) => ({
          balance: accounts.balance,
          $where: accounts.id.is(1),
        }));
        expect(await query.first()).toEqual({ balance: 100n });
        await observer.accounts
          .update({ balance: 200n })
          .where((accounts) => accounts.id.is(1))
          .execute();
        expect(await query.first()).toEqual({ balance: 100n });
      },
      { isolationLevel: IsolationLevel.RepeatableRead },
    );
    expect((await balances())[0]?.balance).toBe(200n);
  });

  test("transactional index DDL rolls back with its enclosing callback", async () => {
    const local = schema(
      { accounts: { id: int.auto, owner: text } },
      {
        driver,
        indexes: ({ accounts }) => ({ rolledBackIndex: index(accounts.owner) }),
      },
    );
    await expect(
      local.$transaction(async (transaction) => {
        await transaction.$createIndexes().execute();
        throw new Error("cancel DDL");
      }),
    ).rejects.toThrow("cancel DDL");
    const result = await run("SELECT to_regclass('rolled_back_index') AS name");
    expect(
      Array.isArray(result) ? result[0]?.name : result.rows[0]?.name,
    ).toBeNull();
  });

  test("unfinished operations are drained and rolled back when the callback returns early", async () => {
    let unfinished: Promise<unknown> | undefined;
    await expect(
      model.$transaction(async (transaction) => {
        unfinished = transaction.accounts
          .update({ balance: 0n })
          .where((accounts) => accounts.id.is(1))
          .execute();
      }),
    ).rejects.toThrow(/await all transaction operations/);
    await unfinished;
    expect(await balances()).toEqual([{ balance: 100n }, { balance: 50n }]);
  });

  test("a savepoint excludes concurrent parent queries and sibling savepoints", async () => {
    await model.$transaction(async (transaction) => {
      const gate = Promise.withResolvers<void>();
      const nested = transaction.$transaction(async (savepoint) => {
        await gate.promise;
        await savepoint.accounts
          .update({ balance: 80n })
          .where((accounts) => accounts.id.is(1))
          .execute();
      });

      try {
        await expect(
          transaction.accounts((accounts) => ({ id: accounts.id })).execute(),
        ).rejects.toThrow(/await the nested transaction/);
        await expect(transaction.$transaction(async () => 1)).rejects.toThrow(
          /await the nested transaction/,
        );
      } finally {
        gate.resolve();
        await nested;
      }
    });
    expect((await balances())[0]?.balance).toBe(80n);
  });

  test("savepoints require already-issued parent queries to finish", async () => {
    await model.$transaction(async (transaction) => {
      const pending = transaction.accounts
        .update({ balance: 90n })
        .where((accounts) => accounts.id.is(1))
        .execute();
      await expect(transaction.$transaction(async () => 1)).rejects.toThrow(
        /await pending queries/,
      );
      await pending;
      await transaction.$transaction(async (savepoint) => {
        expect(
          await savepoint
            .accounts((accounts) => ({
              balance: accounts.balance,
              $where: accounts.id.is(1),
            }))
            .first(),
        ).toEqual({ balance: 90n });
      });
    });
  });
});
